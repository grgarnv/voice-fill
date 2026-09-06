// Phase 3 core: the parts of barge-in that must be RIGHT and can be tested
// without a browser. No DOM, no chrome.*, no Web Audio - pure functions and
// small classes over plain data, loaded as a classic script into a global so
// the offscreen document and the Node test harness run one implementation.
//
//   DialogMachine   explicit states + allowed transitions; violations counted
//   PlaybackClock   context time -> audio position, exact across inserted gaps
//   heardWords      word timestamps x playback position -> what was audible
//   Ledger          bounded record of every utterance and how it ended
//   frameFilter     stale / null / late frame decisions, by contextId
//   TranscriptOrder in-order processing of out-of-order STT results
//   resumePolicy    interrupted-turn kind + transcript -> what to do next
globalThis.VFSessionCore = (() => {
  'use strict';

  /* ------------------------------------------------------ dialog machine --- */

  // The PRD's machine, made explicit:
  //   IDLE -> CONNECTING -> READY -> PROMPTING(turn) -> LISTENING -> TRANSCRIBING
  //        -> FILLING -> CONFIRMING(turn) -> [next] PROMPTING ...
  // LISTENING is "the user has the floor": the prompt finished, or they took
  // it by interrupting. CONFIRMING is "a read-back is playing or awaiting a
  // yes/no". TRANSCRIBING is "a transcript is being turned into an action".
  //
  // With an open microphone a capture can START in any state; the mic has its
  // own small machine below. The dialog machine only says what the turn is.
  const STATES = ['IDLE', 'CONNECTING', 'READY', 'PROMPTING', 'LISTENING', 'TRANSCRIBING', 'FILLING', 'CONFIRMING'];
  const ALLOWED = {
    IDLE:         ['IDLE', 'CONNECTING', 'READY'],
    CONNECTING:   ['READY', 'LISTENING', 'CONFIRMING', 'IDLE'],   // LISTENING/CONFIRMING: reconnect inside a live session
    READY:        ['READY', 'PROMPTING', 'CONNECTING', 'IDLE'],
    // CONFIRMING is reachable from PROMPTING because a CLARIFYING QUESTION is
    // spoken as a prompt, and one can be asked while a read-back is still
    // outstanding ("make that all caps" on a digit field). When that question
    // ends, the pending confirmation is still there and the dialog is back in
    // CONFIRMING - which is the truth about where it is, not a violation.
    PROMPTING:    ['PROMPTING', 'LISTENING', 'CONFIRMING', 'READY', 'IDLE'],
    LISTENING:    ['LISTENING', 'TRANSCRIBING', 'PROMPTING', 'CONFIRMING', 'READY', 'IDLE'],
    TRANSCRIBING: ['TRANSCRIBING', 'FILLING', 'PROMPTING', 'CONFIRMING', 'LISTENING', 'READY', 'IDLE'],
    FILLING:      ['CONFIRMING', 'PROMPTING', 'LISTENING', 'READY', 'IDLE'],
    CONFIRMING:   ['CONFIRMING', 'LISTENING', 'TRANSCRIBING', 'PROMPTING', 'READY', 'IDLE'],
  };
  // Deliberately forbidden, and what each would mean if it happened:
  //   IDLE -> PROMPTING        speaking with no connection
  //   READY -> LISTENING       a capture with no field to answer
  //   READY/LISTENING -> FILLING  writing without a transcript
  //   PROMPTING -> FILLING     writing while still asking
  //   FILLING -> TRANSCRIBING  a transcript acted on before the write settled

  class DialogMachine {
    constructor(onChange) {
      this.state = 'IDLE';
      this.history = [];            // last 40 transitions, for the harness
      this.illegal = [];            // every forbidden transition we were forced to make
      this.onChange = onChange || null;
    }
    can(to) { return (ALLOWED[this.state] || []).includes(to); }
    /**
     * Move. A forbidden transition is recorded and STILL performed: wedging the
     * session to protect an invariant would be worse for the user than the
     * inconsistency, and the harness asserts the count is zero anyway.
     */
    go(to, why = '') {
      if (!STATES.includes(to)) throw new Error(`unknown state ${to}`);
      const from = this.state;
      if (!this.can(to)) this.illegal.push({ from, to, why, at: Date.now() });
      this.state = to;
      this.history.push({ from, to, why, at: Date.now() });
      if (this.history.length > 40) this.history.shift();
      if (this.onChange) { try { this.onChange(from, to, why); } catch {} }
      return this;
    }
    get illegalCount() { return this.illegal.length; }
  }

  /* ------------------------------------------------------- playback clock -- */

  /**
   * Maps AudioContext time to the audio position within one utterance.
   *
   * Chunks are scheduled gap-free while the network stays ahead of realtime.
   * When it falls behind, the next chunk is scheduled just ahead of "now" and
   * a gap of silence opens in the timeline: wall time keeps moving, audio
   * position does not. `ctx.currentTime - startedAt` would then be AHEAD of
   * the words actually played, and the ledger would claim the user heard
   * words that were still in flight. Each scheduled chunk is one segment, so
   * the mapping is exact wherever the query lands.
   */
  class PlaybackClock {
    constructor() { this.segments = []; this.gapSec = 0; }
    /** Record a scheduled chunk: starts at ctxStart, lasts dur, carries audio from audioStart. */
    add(ctxStart, dur, audioStart) {
      const prev = this.segments[this.segments.length - 1];
      if (prev) {
        const gap = ctxStart - prev.ctxEnd;
        if (gap > 1e-6) this.gapSec += gap;
      }
      this.segments.push({ ctxStart, ctxEnd: ctxStart + dur, audioStart, audioEnd: audioStart + dur });
    }
    get startedAt() { return this.segments.length ? this.segments[0].ctxStart : null; }
    get scheduledEnd() { return this.segments.length ? this.segments[this.segments.length - 1].ctxEnd : null; }
    get audioScheduledSec() { return this.segments.length ? this.segments[this.segments.length - 1].audioEnd : 0; }
    /** Audio position (seconds of the utterance) at context time t. */
    positionAt(t) {
      if (!this.segments.length || t <= this.segments[0].ctxStart) return 0;
      let pos = 0;
      for (const s of this.segments) {
        if (t >= s.ctxEnd) { pos = s.audioEnd; continue; }
        if (t >= s.ctxStart) return s.audioStart + (t - s.ctxStart);
        // t is inside a gap before this segment: nothing new has played.
        return pos;
      }
      return pos;
    }
    /** How far wall time has run ahead of audio at t (the drift a naive clock would carry). */
    driftAt(t) {
      const s0 = this.startedAt;
      if (s0 === null || t <= s0) return 0;
      return Math.max(0, (t - s0) - this.positionAt(t));
    }
  }

  /* ---------------------------------------------------------- heard words -- */

  const isPauseToken = (w) => /^<\d+>$/.test(String(w || '').trim());

  /**
   * Which words were audible before the audio stopped at `playedSec`.
   *
   * PRD rule: a word counts as heard when it had STARTED before the stop.
   * Rime returns pause tokens ("<300>") as timed words; they are kept for
   * timing and excluded from the text. `partial` is the word that was cut
   * mid-way, reported separately so the popup can show "What's your PI—".
   */
  function heardWords(ts, playedSec) {
    if (!ts || !Array.isArray(ts.words) || !Array.isArray(ts.start)) {
      return { known: false, heard: [], partial: null, heardText: '', total: 0, heardCount: 0, complete: false };
    }
    const heard = [], n = ts.words.length;
    let partial = null, total = 0;
    for (let i = 0; i < n; i++) {
      const w = ts.words[i], s = ts.start[i], e = ts.end?.[i] ?? s;
      if (isPauseToken(w)) continue;
      total++;
      if (s < playedSec) {
        heard.push(w);
        if (e > playedSec) partial = w;
      }
    }
    const complete = heard.length === total && (ts.end ? (ts.end[n - 1] ?? 0) <= playedSec + 0.05 : true);
    return { known: true, heard, partial, heardText: heard.join(' '), total, heardCount: heard.length, complete };
  }

  /** "What's your PIN— [interrupted]" - the string the PRD shows in the popup. */
  function heardDisplay(entry) {
    if (!entry) return '';
    if (entry.status === 'played' || entry.status === 'done') return entry.text;
    const h = entry.heard;
    if (!h || !h.known) return `[interrupted at ${(entry.playedSec ?? 0).toFixed(2)}s - words unknown]`;
    if (!h.heardCount) return `[interrupted before any word was heard]`;
    const tail = h.partial ? '—' : '…';
    return `${h.heardText}${tail} [interrupted]`;
  }

  /* --------------------------------------------------------------- ledger -- */

  class Ledger {
    constructor(max = 80) { this.max = max; this.entries = []; }
    /** Add or replace by contextId. Late timestamps update in place. */
    upsert(entry) {
      const i = this.entries.findIndex(e => e.contextId === entry.contextId);
      if (i >= 0) this.entries[i] = { ...this.entries[i], ...entry };
      else { this.entries.push(entry); if (this.entries.length > this.max) this.entries.shift(); }
      return this.get(entry.contextId);
    }
    get(contextId) { return this.entries.find(e => e.contextId === contextId) || null; }
    /** Timestamps that arrive AFTER the stop finalise the heard set retroactively. */
    lateTimestamps(contextId, ts) {
      const e = this.get(contextId);
      if (!e) return null;
      if (e.status === 'interrupted' || e.status === 'failed') {
        e.heard = heardWords(ts, e.playedSec ?? 0);
        e.lateTimestamps = true;
      }
      e.display = heardDisplay(e);
      return e;
    }
    last(n = 10) { return this.entries.slice(-n); }
    /** Prompts spoken for a field after it already had an answer, minus legitimate reasons. */
    promptsFor(fieldId) { return this.entries.filter(e => e.fieldId === fieldId && (e.kind === 'prompt' || e.kind === 'options')); }
  }

  /* --------------------------------------------------------- frame filter -- */

  /**
   * Decide what to do with one inbound frame given the turn that currently
   * owns audio. `current` is { contextId, status } or null.
   *
   *   play      decode and schedule
   *   stale     a known-old context: count and drop before decode
   *   orphan    no contextId on a chunk when one is expected: drop
   *   noturn    nothing is playing; drop
   */
  function chunkDecision(frameCtx, current) {
    if (!current || !['sent', 'playing'].includes(current.status)) return 'noturn';
    if (frameCtx === null || frameCtx === undefined) return 'orphan';
    if (frameCtx !== current.contextId) return 'stale';
    return 'play';
  }

  /* --------------------------------------------------- transcript ordering - */

  /**
   * Captures complete out of order: a short "yes" transcribes in 400ms while
   * the long correction before it is still in whisper. Acting on the "yes"
   * first would accept the value the correction was about to replace. Every
   * capture gets a sequence number at START; results are released strictly in
   * that order, and a capture that fails or is abandoned releases the ones
   * behind it.
   */
  class TranscriptOrder {
    constructor({ maxAgeMs = 30000 } = {}) { this.seq = 0; this.slots = new Map(); this.processing = false; this.queue = []; this.handler = null; this.maxAgeMs = maxAgeMs; this.swept = 0; }
    open(binding) {
      this.sweep();
      const id = ++this.seq;
      const slot = { id, binding: { ...binding, captureId: id }, result: undefined, settled: false, openedAt: Date.now() };
      this.slots.set(id, slot);
      return slot.binding;
    }
    /**
     * A capture whose result never comes - the microphone mode was switched
     * mid-segment, whisper hung, the tab died - must not hold every later
     * transcript hostage. Anything unsettled past maxAgeMs is abandoned.
     */
    sweep(now = Date.now()) {
      for (const s of this.slots.values()) {
        if (!s.settled && now - s.openedAt > this.maxAgeMs) { s.result = null; s.settled = true; s.sweptOut = true; this.swept++; }
      }
      if (this.swept) this.drain();
    }
    /** Abandon everything still open (session stop, mic mode change). */
    abandonAll(why = 'abandon-all') {
      for (const s of this.slots.values()) if (!s.settled) { s.result = null; s.settled = true; s.abandonedWhy = why; }
      this.drain();
    }
    /** Deliver a result (text or null for failure); returns a promise for when it has been acted on. */
    settle(captureId, result) {
      this.sweep();
      const slot = this.slots.get(captureId);
      if (!slot) return Promise.resolve({ ok: false, error: 'unknown capture' });
      if (slot.settled) return Promise.resolve({ ok: false, dropped: 'already-settled' });
      slot.result = result; slot.settled = true;
      return new Promise((resolve) => { slot.resolve = resolve; this.drain(); });
    }
    /** Abandon a capture that produced nothing (too short, mic error). */
    abandon(captureId) { return this.settle(captureId, null); }
    async drain() {
      if (this.processing) return;
      this.processing = true;
      try {
        for (;;) {
          const ids = [...this.slots.keys()].sort((a, b) => a - b);
          if (!ids.length) break;
          const head = this.slots.get(ids[0]);
          if (!head.settled) break;              // in-order: wait for the oldest
          this.slots.delete(head.id);
          let out;
          try { out = head.result === null ? { ok: false, dropped: 'abandoned' } : await this.handler(head.binding, head.result); }
          catch (e) { out = { ok: false, error: String(e?.message || e) }; }
          head.resolve?.(out);
        }
      } finally { this.processing = false; }
    }
    get pendingCount() { return this.slots.size; }
    /** Oldest unsettled capture bound to a field, if any (a "the user already answered" signal). */
    inFlightFor(fieldId) { return [...this.slots.values()].some(s => !s.settled && s.binding.fieldId === fieldId); }
  }

  /* --------------------------------------------------------- resume table -- */

  /**
   * What an interrupting (or ordinary) transcript means, given what was being
   * said when the user spoke. A small table, not an LLM.
   *
   * deps: { parseCommand, parseYesNo, fromSpeech, matchOption }
   * ctx:  { transcript, binding, pending, field, intent, heardText, options }
   *
   * Returns one of:
   *   { action:'drop', reason }                    superseded / stale epoch
   *   { action:'command', command }
   *   { action:'accept' }                          yes to the pending read-back
   *   { action:'reject' }                          no to the pending read-back
   *   { action:'correction', ex }                  a new value spoken into the read-back
   *   { action:'reconfirm' }                       unusable answer to a read-back
   *   { action:'answer', ex, viaHeard }            value for the field
   *   { action:'ambiguous', ex }
   *   { action:'options-remaining', remaining }    choice field, nothing matched
   *   { action:'unusable', ex }
   */
  // "Scratch that, it's Arnav" / "actually, Arnav" / "wait, I mean Arnav":
  // the retraction is conversation, the rest is the value. Stripped before
  // anything else looks at the transcript, so a name field never receives
  // "Scratch That, It's Arnav".
  // Alternations are longest-first and \b-anchored throughout. With `no` listed
  // before `nope`, "nope, scratch that" matched only the "no", left "pe, ..."
  // behind, and the retraction was never recognised at all.
  const RETRACT = /^\s*(?:(?:nope|no|nah|wait|oh|sorry|um|uh)\b[,.!\s-]*)*(?:scratch that|strike that|forget that|cancel that|change that|correction|actually|i meant|i mean|no wait|wait no|let me (?:fix|correct|change) that|that'?s (?:wrong|not right)|not that)[,.!\s-]*(?:(?:it'?s|it is|its|actually|make it|make that|should be|i said|i meant|change it to|put|try|use|to)\b[,\s]+)?/i;
  function stripRetraction(text) {
    const m = RETRACT.exec(text);
    if (!m || !m[0].trim()) return { retracted: false, rest: text };
    return { retracted: true, rest: text.slice(m[0].length).trim() };
  }

  function resumePolicy(deps, ctx) {
    const { transcript, binding, pending, field, intent, options = [], heardText = '' } = ctx;
    const raw = String(transcript || '').trim();
    const { retracted, rest } = stripRetraction(raw);
    // A retraction with nothing after it ("scratch that") is a rejection.
    const text = retracted ? rest : raw;

    // 1. A transcript from a previous session, or bound to a field the user has
    //    since navigated away from, is not acted on: their later instruction wins.
    if (binding && binding.epoch !== ctx.epoch) return { action: 'drop', reason: 'stale-epoch' };
    const cmd = deps.parseCommand(text);
    if (binding && binding.fieldId && field && binding.fieldId !== field.id && !cmd) {
      return { action: 'drop', reason: 'superseded' };
    }
    if (!text) {
      if (retracted && pending) return { action: 'reject', retracted: true };
      return { action: 'unusable', ex: { value: null, note: 'empty transcript' } };
    }
    if (retracted && pending && field) {
      // "Scratch that, it's Arnav" straight into the read-back: the new value.
      const ex = deps.fromSpeech(text, field, pending.intent);
      if (ex.value !== null && ex.value !== undefined) {
        return String(ex.value) === String(pending.value) ? { action: 'accept', sameValue: true } : { action: 'correction', ex, retracted: true };
      }
      return { action: 'reject', retracted: true };
    }

    // 2. A pending confirmation outranks everything: the user is answering the
    //    question just asked, whether or not they let it finish.
    if (pending) {
      const yn = deps.parseYesNo(text);
      if (yn === true) return { action: 'accept' };
      if (yn === false) {
        // "no, it's 160072": the no AND the correction in one breath.
        // Two bugs lived in one line here, both of which wrote junk into the
        // field the read-back was about:
        //   `no` before `nope` matched three letters of "nope" and left "pe",
        //   which fromSpeech then took for the corrected value;
        //   a single leading negation was stripped, so "No no, it's Arnav"
        //   became the name "No, It'S Arnav".
        // Longest-first, \b-anchored, and the negation may repeat.
        const NEG_LEAD = /^\s*(?:(?:nope|no|nah|wrong|incorrect|that'?s wrong|not right)\b[,.!\s-]*)+(?:(?:it'?s|it is|its|actually|make it|make that|should be|i said|i meant|try|use)\b[,\s]*)?/i;
        const rest = text.replace(NEG_LEAD, '');
        if (rest && rest !== text && field) {
          const ex = deps.fromSpeech(rest, field, pending.intent);
          if (ex.value !== null && ex.value !== undefined && String(ex.value) !== String(pending.value)) {
            return { action: 'correction', ex };
          }
        }
        return { action: 'reject' };
      }
      if (cmd) return { action: 'command', command: cmd.command };
      if (field) {
        const ex = deps.fromSpeech(text, field, pending.intent);
        if (ex.value !== null && ex.value !== undefined && String(ex.value) !== String(pending.value)) {
          return { action: 'correction', ex };
        }
        // The same value again ("one six zero zero seven one" while it was being
        // read back) is agreement, not a correction and not a reconfirm loop.
        if (ex.value !== null && ex.value !== undefined && String(ex.value) === String(pending.value)) {
          return { action: 'accept', sameValue: true };
        }
      }
      return { action: 'reconfirm' };
    }

    if (cmd) return { action: 'command', command: cmd.command };
    if (!field) return { action: 'unusable', ex: { value: null, note: 'no field' } };

    // 3. Choice fields: options the user actually HEARD are matched first. An
    //    option they could not have heard is still accepted - they may know the
    //    form - but with confirmation, and nothing matched means we continue
    //    the list from where it was cut rather than starting the question over.
    if ((intent === 'choice' || intent === 'multichoice') && options.length) {
      const heardSet = optionsHeard(options, heardText);
      if (heardSet.length && intent === 'choice') {
        const m = deps.matchOption(text, heardSet);
        if (m && m.value != null && !m.ambiguous) {
          return { action: 'answer', viaHeard: true, ex: { value: m.value, display: m.text, confidence: m.score, needsConfirmation: m.score < 0.95, ambiguous: false } };
        }
      }
      const ex = deps.fromSpeech(text, field, intent);
      if (ex.ambiguous) return { action: 'ambiguous', ex };
      if (ex.value !== null && ex.value !== undefined) {
        const unheardPick = binding?.interrupted && heardSet.length < options.length &&
          !heardSet.some(o => String(o.value) === String(Array.isArray(ex.value) ? ex.value[0] : ex.value));
        return { action: 'answer', viaHeard: false, ex: unheardPick ? { ...ex, needsConfirmation: true } : ex };
      }
      if (binding?.interrupted && heardSet.length < options.length) {
        const heardValues = new Set(heardSet.map(o => String(o.value)));
        return { action: 'options-remaining', remaining: options.filter(o => !heardValues.has(String(o.value))), ex };
      }
      return { action: 'unusable', ex };
    }

    // 4. Everything else: the transcript is the answer to the current field,
    //    however much of the question was heard. Interrupting a prompt is the
    //    user saying "I know what you're asking".
    const ex = deps.fromSpeech(text, field, intent);
    if (ex.ambiguous) return { action: 'ambiguous', ex };
    if (ex.value === null || ex.value === undefined) return { action: 'unusable', ex };
    return { action: 'answer', viaHeard: false, ex };
  }

  /** Options whose full label appears in the heard text (case-insensitive, punctuation-free). */
  function optionsHeard(options, heardText) {
    const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    const h = ` ${norm(heardText)} `;
    if (!h.trim()) return [];
    return options.filter(o => { const l = norm(o.text); return l && h.includes(` ${l} `); });
  }

  /**
   * How much of `transcript` is a VERBATIM RUN of something just spoken aloud,
   * as a share of the transcript's length.
   *
   * An open microphone beside a speaker hears the extension itself, and Rime's
   * own words come back looking exactly like an answer. Contiguity is what
   * separates the two: echo reproduces word ORDER, so "let me read that back"
   * scores 1.0 against the prompt it came from, while a real reply that merely
   * reuses prompt vocabulary ("yes that's correct" vs "Is that correct?") only
   * ever matches a word here and there and stays low.
   *
   * A bag-of-words overlap cannot make that distinction and rejects the user's
   * confirmations, which are the most common thing they say.
   */
  function echoRun(transcript, spoken, { minWords = 2 } = {}) {
    // Apostrophes are DELETED, not split on: "what's" must stay one token or a
    // contraction breaks the run in half and real echo scores below threshold.
    const words = (x) => String(x || '').toLowerCase().replace(/['\u2019]/g, '').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
    const a = words(transcript), b = words(spoken);
    if (a.length < minWords || !b.length) return 0;
    // Longest common contiguous run (classic DP, one row).
    let best = 0, prev = new Array(b.length + 1).fill(0);
    for (let i = 1; i <= a.length; i++) {
      const cur = new Array(b.length + 1).fill(0);
      for (let j = 1; j <= b.length; j++) {
        if (a[i - 1] === b[j - 1]) { cur[j] = prev[j - 1] + 1; if (cur[j] > best) best = cur[j]; }
      }
      prev = cur;
    }
    return best / a.length;
  }

  return {
    STATES, ALLOWED, DialogMachine, stripRetraction,
    echoRun,
    PlaybackClock, heardWords, heardDisplay, isPauseToken,
    Ledger, chunkDecision, TranscriptOrder,
    resumePolicy, optionsHeard,
  };
})();
