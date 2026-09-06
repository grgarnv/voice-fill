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
//   parseNavigation transcript -> a structured navigation intent (no model)
//   resolveNav      navigation intent x visit history -> the field to move to
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


  /* ------------------------------------------------------------ navigation -- */

  /**
   * Conversational navigation, the deterministic half.
   *
   *   parseNavigation      transcript -> a structured navigation intent, or null
   *   matchFieldReference  "my phone number" -> the field it names, or the tie
   *   resolveNav           intent x session history -> the field to move to
   *
   * Nothing here touches the DOM, and nothing here MOVES anything: resolveNav
   * returns an index into the field list the session already holds, or a reason
   * it will not. The model, when it is consulted at all, produces the same
   * structured intent shape this parser does - it never names a field id, an
   * index, or a selector, so the resolution below is the only way a target is
   * ever chosen.
   */

  const navNorm = (s) => String(s ?? '').toLowerCase().replace(/[’]/g, "'")
    .replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();

  const NAV_NUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5,
                    six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  const navCount = (w) => (w == null ? null : (NAV_NUM[w] ?? (/^\d{1,2}$/.test(w) ? Number(w) : null)));

  // Conversation that only ever introduces a request. "No no, go back" and
  // "Don't confirm that, take me to my email" are navigation with a refusal
  // stuck to the front; the refusal is not the instruction.
  const NAV_LEAD = /^(?:(?:no|nope|nah|not that|wait|hang on|hold on|actually|um|uh|er|sorry|hey|ok|okay|alright|right|yeah|yep|yes|so|well|please|can you|could you|would you|will you|i want to|i wanna|i need to|i'd like to|id like to|i would like to|let's|lets|don't confirm that|dont confirm that|do not confirm that|don't confirm|cancel that|forget that|scratch that|hold off)\b[\s,.!-]*)+/;

  const NAV_BACKWARD = /\b(back|backward|backwards|previous|prior|earlier|preceding)\b/;
  const NAV_FORWARD = /\b(forward|forwards|ahead|next|onward|onwards)\b/;
  // The words a bare relative move is allowed to be made of. Anything else in
  // the utterance means it is an ANSWER that happens to contain "back" - a
  // "back end developer" in an occupation field is not a navigation request.
  const NAV_VOCAB = new Set(['go', 'goes', 'move', 'jump', 'skip', 'step', 'head', 'scroll', 'take', 'takes',
    'bring', 'get', 'put', 'send', 'return', 'navigate', 'switch', 'revisit', 'me', 'us', 'the', 'a', 'an',
    'to', 'up', 'over', 'by', 'and', 'then', 'just', 'now', 'again', 'please', 'lets', "let's",
    'back', 'backward', 'backwards', 'previous', 'prior', 'earlier', 'preceding', 'last',
    'forward', 'forwards', 'ahead', 'next', 'onward', 'onwards', 'on', 'one', 'ones',
    'field', 'fields', 'question', 'questions', 'step', 'steps', 'entry', 'entries', 'item', 'items',
    'change', 'that', 'this', 'it', 'answer', 'my', 'of', 'value']);
  const CHANGE_VERB = /^(?:change|edit|fix|update|correct|amend|modify|redo|revisit|re-?do)\b/;

  /**
   * "Go back to my phone number. The last digit is wrong." - the move and the
   * change arrive in one breath. The first clause is the navigation; whatever
   * follows is handed to the ordinary answer path against the field moved TO,
   * where it is extracted, written and read back exactly like a spoken value.
   */
  function splitNavClause(text) {
    const s = String(text ?? '').trim();
    const m = /^(.+?)\s*(?:[.;!?]+\s+|\s+[–—]\s+|\s+-\s+)(.+)$/.exec(s);
    return m ? { head: m[1].trim(), rest: m[2].trim() } : { head: s, rest: '' };
  }

  // Phrases that point at a field through the conversation rather than by name.
  // The third element is whether the phrase may stand ALONE as a navigation
  // request. "The last one" on a choice field is the last OPTION far more often
  // than it is the previous field, so it only navigates behind a verb ("take me
  // back to the last one"); "the previous one" is never an option reference.
  const NAV_REFERENCES = [
    [/^(?:the\s+)?(?:very\s+)?(?:previous|prior|preceding)(?:\s+(?:field|one|question|step|entry|item))?$/, 'previous', true],
    [/^(?:the\s+)?last(?:\s+(?:field|question|step|entry|item))$/, 'previous', true],
    [/^(?:the\s+)?last\s+one$/, 'previous', false],
    [/^(?:the\s+)?(?:field|one|question)?\s*(?:i|that i)\s+(?:just\s+)?(?:answered|entered|filled(?:\s+in)?|did|gave|said)(?:\s+(?:just\s+)?(?:before|prior to)\s+(?:this|that|it)(?:\s+one)?)?$/, 'last_answered'],
    [/^(?:the\s+)?(?:field|one|question)\s+before\s+(?:this|the current)(?:\s+one)?$/, 'previous'],
    [/^(?:the\s+)?(?:field|one|question)?\s*before\s+that(?:\s+one)?$/, 'before_previous'],
    [/^(?:the\s+)?(?:field|one|question)\s+before\s+(?:my|the|our)?\s*(.+)$/, 'before_field'],
  ];
  // "...to the next field" / "...to the one after this" is a direction wearing
  // the grammar of a target.
  const NAV_FORWARD_TARGET = /^(?:the\s+)?(?:next|following)(?:\s+(?:field|one|question|step|entry|item))?$|^(?:the\s+)?(?:field|one|question)\s+after\s+(?:this|that|the current)(?:\s+one)?$/;

  /**
   * Transcript -> a structured navigation intent, or null when this is not one.
   *
   *   { kind:'relative',   direction:'backward'|'forward', count }
   *   { kind:'field',      field_reference }
   *   { kind:'referenced', reference, field_reference? }
   *
   * `rest` carries any trailing clause ("...and change that answer"), which the
   * session applies to the field it lands on, never to the field it left.
   *
   * Deliberately narrow. The obvious commands resolve here with no model and no
   * latency (PRD §13); everything contextual falls through to null, which is
   * what routes the utterance to the conversational layer.
   */
  function parseNavigation(raw, depth = 0) {
    const { head, rest } = splitNavClause(raw);
    let t = navNorm(head).replace(NAV_LEAD, '').trim();
    // "Don't confirm that. Take me back to my email." - the first sentence is
    // the refusal and the second is the instruction.
    const orTail = (v) => (v || depth > 2 || !rest ? v : parseNavigation(rest, depth + 1));
    if (!t) return orTail(null);
    const out = (nav) => ({ ...nav, rest, transcript: String(raw ?? '').trim() });

    // 0. A bare referring phrase, with no verb of its own: "the one before my
    //    email", "the field I just answered". A bare NAME is deliberately not
    //    accepted here - "email" alone is an answer far more often than it is a
    //    request to move.
    const bare = navTarget(t, { bare: true });
    if (bare && bare.kind === 'referenced') return out(bare);

    // 1. A named or referred target: "...to my first name", "go to the email field".
    const toM = /^(.*?)\b(?:to|into|at)\s+(.+)$/.exec(t);
    if (toM) {
      const lead = toM[1].trim();
      // The words before "to" must be movement, or this is an answer that
      // happens to contain the word ("send it to accounts").
      const leadOk = !lead || lead.split(' ').every(w => NAV_VOCAB.has(w));
      if (leadOk && (/(?:go|move|jump|take|bring|get|put|send|head|step|return|navigate|switch|revisit|back|backward|backwards|forward|next|skip)/.test(lead) || CHANGE_VERB.test(t))) {
        const target = navTarget(toM[2]);
        if (target) return out(target);
      }
    }

    // 2. "change my phone number", "change what I entered for my phone number".
    if (CHANGE_VERB.test(t)) {
      const phrase = t.replace(CHANGE_VERB, '')
        .replace(/^\s*(?:what|the value|the answer|the one)\s+(?:i\s+)?(?:just\s+)?(?:entered|put|gave|said|filled in|typed)\s+(?:for|in|on)?\s*/, ' ')
        .trim();
      const target = navTarget(phrase);
      // "change that", "change it", "change that answer" is a correction of the
      // field in play, not a request to move: it belongs to the answer path.
      if (target && target.kind === 'field') return out(target);
      if (target && target.kind === 'referenced') return out(target);
      return orTail(null);
    }

    // 3. A bare relative move: "go back", "back two fields", "move forward one".
    const words = t.split(' ').filter(Boolean);
    const counts = words.map(navCount).filter(n => n !== null);
    if (!words.every(w => NAV_VOCAB.has(w) || navCount(w) !== null)) return orTail(null);
    const backward = NAV_BACKWARD.test(t), forward = NAV_FORWARD.test(t);
    if (backward === forward) return orTail(null);          // neither, or both
    // "one" is a noun as often as a number ("the previous one"); a count only
    // counts when the utterance is not already complete without it.
    const complete = /\b(?:the\s+)?(?:previous|prior|last|next)\s+(?:one|field|question|step)?\s*$/.test(t);
    const count = complete ? 1 : (counts.length ? counts[counts.length - 1] : 1);
    if (count < 1 || count > 20) return orTail(null);
    return out({ kind: 'relative', direction: backward ? 'backward' : 'forward', count });
  }

  /** The phrase after "to" / a change verb -> a referenced or a named target. */
  function navTarget(phrase, { bare = false } = {}) {
    const p = navNorm(phrase).replace(/\?+$/, '').trim();
    if (!p) return null;
    if (!bare && NAV_FORWARD_TARGET.test(p)) return { kind: 'relative', direction: 'forward', count: 1 };
    for (const [re, reference, bareOk = true] of NAV_REFERENCES) {
      if (bare && !bareOk) continue;
      const m = re.exec(p);
      if (!m) continue;
      if (reference === 'before_field') {
        const anchor = cleanFieldPhrase(m[1]);
        return anchor ? { kind: 'referenced', reference, field_reference: anchor } : null;
      }
      return { kind: 'referenced', reference };
    }
    // "that", "it", "that answer" refer to the field in play - not a move.
    if (/^(?:that|this|it|that one|this one|that answer|the answer|that value)$/.test(p)) return null;
    // "change the third digit", "fix the last letter": an edit of the value in
    // play, wearing the grammar of a target. Positional editing owns those, and
    // it is exact where a name match would be a guess.
    if (EDIT_TARGET.test(p)) return null;
    const ref = cleanFieldPhrase(p);
    return ref ? { kind: 'field', field_reference: ref } : null;
  }

  const EDIT_TARGET = /\b(?:first|second|third|fourth|fifth|sixth|seventh|eighth|last|final|middle)\s+(?:\w+\s+)?(?:digits?|letters?|characters?|numbers?|words?)\b|^(?:the\s+)?(?:digits?|letters?|characters?)\b/;

  /** "my first name field" -> "first name". Nouns for "field" carry no meaning. */
  function cleanFieldPhrase(phrase) {
    const p = navNorm(phrase)
      .replace(/^(?:the|my|our|your|a|an)\s+/, '')
      .replace(/\s+(?:field|question|box|input|entry|section)$/, '')
      .replace(/\s+(?:that\s+)?i\s+(?:just\s+)?(?:entered|answered|filled(?:\s+in)?|gave|said|put|typed)$/, '')
      .replace(/^(?:what|the value|the answer)\s+(?:i\s+)?(?:just\s+)?(?:entered|put|gave|said)\s+(?:for|in)?\s*/, '')
      .replace(/^(?:the|my|our|your)\s+/, '')
      .trim();
    return p && p.length <= 60 ? p : null;
  }

  /* ------------------------------------------------- field-name resolution - */

  // Ways of saying the same field. Both sides of a match are tested against the
  // same expression, so "date of birth" finds a field labelled "Birthday" and
  // vice versa, without either spelling being privileged.
  const FIELD_ALIASES = [
    ['first-name', /\b(?:first|given|fore)\s*name\b|\bfirstname\b|^first$/],
    ['last-name', /\b(?:last|family|sur)\s*name\b|\blastname\b|\bsurname\b|^last$/],
    ['middle-name', /\bmiddle\s*(?:name|initial)\b/],
    ['full-name', /\b(?:full|whole|complete)\s*name\b|^name$|^your name$/],
    ['email', /\be-?\s?mail\b/],
    ['phone', /\b(?:phone|telephone|mobile|cell|cellphone|contact number)\b/],
    ['address', /\b(?:address|street)\b/],
    ['city', /\b(?:city|town|suburb)\b/],
    ['state', /\b(?:state|province|region|county)\b/],
    ['zip', /\b(?:zip|postal|postcode|post code|pin code|pincode)\b/],
    ['country', /\bcountry\b/],
    ['dob', /\b(?:date of birth|birth\s?date|birthday|dob)\b/],
    ['age', /\bage\b/],
    ['company', /\b(?:company|employer|organisation|organization|business)\b/],
    ['website', /\b(?:website|web site|url|homepage)\b/],
    ['password', /\b(?:password|passcode)\b/],
  ];
  const NAV_STOPWORDS = new Set(['the', 'my', 'a', 'an', 'of', 'for', 'your', 'our', 'is', 'please', 'to']);
  const navWords = (s) => navNorm(s).split(' ').filter(w => w && !NAV_STOPWORDS.has(w));
  const aliasGroups = (s) => FIELD_ALIASES.filter(([, re]) => re.test(navNorm(s))).map(([g]) => g);

  /**
   * A spoken field reference against the fields this session actually holds.
   *
   * Returns { best, score, candidates } - candidates being every field within a
   * hair of the best, which is what makes "my name" on a form with a first and
   * a last name a QUESTION rather than a coin flip.
   */
  function matchFieldReference(phrase, fields = []) {
    const p = navNorm(phrase);
    const pw = navWords(p);
    if (!p || !fields.length) return { best: null, score: 0, candidates: [] };
    const pg = aliasGroups(p);
    const scored = fields.map((f) => {
      const label = navNorm(f.label || '');
      const name = navNorm(String(f.name || '').replace(/[_\-.]+/g, ' '));
      const hay = `${label} ${name}`.trim();
      if (!hay) return { f, s: 0, rank: 0 };
      let s = 0;
      const hg = aliasGroups(hay);
      if (label === p || name === p) s = 1;
      else {
        const hw = new Set(navWords(hay));
        if (pw.length && pw.every(w => hw.has(w))) s = 0.85;
        if (pg.length && hg.some(g => pg.includes(g))) s = Math.max(s, 0.8);
        if (!s && pw.length) {
          const hit = pw.filter(w => hw.has(w)).length;
          s = 0.55 * (hit / pw.length);
        }
      }
      // "My address" over "Street address" and "Email address": both contain
      // the word, but one of them is ALSO an email, and the person did not say
      // email. A kind the reference never mentioned costs the match, so the
      // plain one wins outright instead of the pair being an unanswerable tie.
      const extra = pg.length ? hg.filter(g => !pg.includes(g)).length : 0;
      return { f, s, rank: s - 0.15 * extra };
    }).sort((a, b) => b.rank - a.rank);
    const best = scored[0];
    if (!best || best.s < 0.6) return { best: null, score: best ? best.s : 0, candidates: [] };
    const candidates = scored.filter(x => x.rank >= best.rank - 0.1 && x.s >= 0.6).map(x => x.f);
    return { best: best.f, score: best.s, candidates };
  }

  /* --------------------------------------------------------- nav resolution */

  /**
   * A navigation intent x the session's own history -> the field to move to.
   *
   * `ctx` is the session's truth and nothing else:
   *   fields    the fields reachable RIGHT NOW (this step, this DOM)
   *   index     where the session is
   *   trail     field ids in the order the user actually met them
   *   answered  fieldId -> true
   *   labels    fieldId -> label, for fields seen earlier in the session
   *
   * "The previous field" is the previous entry in `trail`, not index - 1: a
   * field that was skipped, conditionally shown, or inserted by the page after
   * the user passed it is not somewhere they have been.
   *
   * Never guesses. Every refusal names why, and the caller asks.
   */
  function resolveNav(nav, ctx) {
    const fields = ctx.fields || [];
    const trail = ctx.trail || [];
    const labels = ctx.labels || {};
    const answered = ctx.answered || {};
    if (!nav) return { ok: false, reason: 'no-intent' };
    if (!fields.length) return { ok: false, reason: 'no-fields' };

    const has = (id) => fields.some(f => f.id === id);
    const at = (id) => fields.findIndex(f => f.id === id);
    const found = (i, why) => ({ ok: true, index: i, field: fields[i], why });
    // The visit history, oldest first, once per field, minus anything the page
    // has since taken away (a previous wizard step, a collapsed branch).
    const path = [];
    for (const id of trail) if (has(id) && !path.includes(id)) path.push(id);
    const currentId = fields[ctx.index]?.id ?? null;
    const pos = currentId === null ? -1 : path.indexOf(currentId);
    const before = pos >= 0 ? path.slice(0, pos) : [];

    const backTo = (n) => {
      // No history to walk (a fresh session, or every earlier field is gone):
      // form order is the honest fallback, and it is what the user sees.
      if (pos < 0) {
        const i = ctx.index - n;
        if (i < 0) return { ok: false, edge: 'start', available: Math.max(0, ctx.index) };
        return found(i, 'form-order');
      }
      if (n > before.length) return { ok: false, edge: 'start', available: before.length };
      return found(at(before[before.length - n]), 'history');
    };
    const fwdTo = (n) => {
      const i = ctx.index + n;
      if (i >= fields.length) return { ok: false, edge: 'end', available: Math.max(0, fields.length - 1 - ctx.index) };
      return found(i, 'form-order');
    };

    switch (nav.kind) {
      case 'relative': {
        const n = Number(nav.count) || 1;
        if (!Number.isInteger(n) || n < 1 || n > 20) return { ok: false, reason: 'count-out-of-range' };
        return nav.direction === 'forward' ? fwdTo(n) : backTo(n);
      }

      case 'referenced': {
        switch (nav.reference) {
          case 'previous': return backTo(1);
          case 'before_previous': return backTo(2);
          case 'last_answered': {
            for (let i = before.length - 1; i >= 0; i--) if (answered[before[i]]) return found(at(before[i]), 'history');
            return { ok: false, reason: 'nothing-answered' };
          }
          case 'before_field': {
            const anchor = resolveTarget(nav.field_reference, fields, labels);
            if (!anchor.ok) return anchor;
            // Before it in the user's own path where that is known, in form
            // order otherwise - a field they have not reached has no history.
            const ap = path.indexOf(anchor.field.id);
            if (ap > 0) return found(at(path[ap - 1]), 'history');
            const ai = at(anchor.field.id);
            if (ai > 0) return found(ai - 1, 'form-order');
            return { ok: false, edge: 'start', available: 0 };
          }
          default: return { ok: false, reason: 'unknown-reference' };
        }
      }

      case 'field': {
        const r = resolveTarget(nav.field_reference, fields, labels);
        if (!r.ok) return r;
        return found(at(r.field.id), 'named');
      }

      default: return { ok: false, reason: 'unknown-kind' };
    }
  }

  /** A field reference -> exactly one reachable field, or the reason it is not. */
  function resolveTarget(reference, fields, labels) {
    const ref = String(reference ?? '').trim();
    if (!ref) return { ok: false, reason: 'no-reference' };
    const m = matchFieldReference(ref, fields);
    if (m.best && m.candidates.length === 1) return { ok: true, field: m.best };
    if (m.candidates.length > 1) return { ok: false, reason: 'ambiguous', candidates: m.candidates };
    // Known to the session but not on the page any more: a previous step of a
    // multi-step form, or a branch that closed. Saying so is the honest answer;
    // guessing at the nearest visible field is not.
    const gone = Object.entries(labels)
      .filter(([id]) => !fields.some(f => f.id === id))
      .map(([id, label]) => ({ id, label }));
    const g = gone.length ? matchFieldReference(ref, gone) : { best: null };
    if (g.best) return { ok: false, reason: 'off-step', label: g.best.label };
    return { ok: false, reason: 'no-such-field' };
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
    // A navigation request is about the SESSION, not about the field it was
    // spoken at, so - like a command - it survives the pointer having moved.
    const nav = parseNavigation(text);
    if (binding && binding.fieldId && field && binding.fieldId !== field.id && !cmd && !nav) {
      return { action: 'drop', reason: 'superseded' };
    }
    if (!text) {
      if (retracted && pending) return { action: 'reject', retracted: true };
      return { action: 'unusable', ex: { value: null, note: 'empty transcript' } };
    }

    // 1b. Navigation OUTRANKS the confirmation flow (PRD navigation §6). "No,
    //     go back to the previous field" into a read-back is a request to move,
    //     not a rejection of the value: the value was written before it was read
    //     back, so leaving the confirmation unanswered loses nothing, and the
    //     user can correct it when they come back to it.
    if (nav) {
      // The two moves the command grammar already had stay commands - same fast
      // path, same metrics - and runCommand resolves them through the history.
      if (nav.kind === 'relative' && nav.count === 1 && !nav.rest) {
        return { action: 'command', command: nav.direction === 'forward' ? 'next' : 'previous', nav };
      }
      return { action: 'navigate', nav };
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
    parseNavigation, matchFieldReference, resolveNav, splitNavClause, FIELD_ALIASES,
  };
})();
