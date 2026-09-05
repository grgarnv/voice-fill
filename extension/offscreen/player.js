// Offscreen: WebSocket to the proxy, session state machine, turn_id, PCM
// playback and the playback clock.
//
// Phase 0 locked all five of these into THIS document rather than the service
// worker: MV3 workers idle out around 30s against a session that runs for
// minutes, and every chrome.runtime hop costs 5-20ms against the Phase 3
// barge-in budget. background.js routes and nothing else.
//
// Phase 1 scope: speak prompts, Next/Previous/Repeat. No mic, no barge-in - but
// turn_id, contextId tagging and the stale-drop are built in now because
// retrofitting them onto a playing stream later means rewriting this file.

const el = document.getElementById('player');

/* ------------------------------------------------------------ audio ------- */

let ctx = null;
function audioContext() {
  // 24 kHz to match Rime's pcm sampling rate exactly. Any other rate makes the
  // browser resample, which puts the playback clock out of step with the word
  // timestamps the heard ledger will compare against in Phase 3.
  if (!ctx) ctx = new AudioContext({ sampleRate: 24000 });
  return ctx;
}

const PCM_RATE = 24000;
const PREBUFFER_SEC = 0.15;   // absorbs network jitter before the first sample
const SCHEDULE_LEAD = 0.05;

/** base64 -> Int16 -> Float32. Only ever called for a chunk we intend to play. */
function decodePcmChunk(b64) {
  const bin = atob(b64);
  const n = bin.length;
  const bytes = new Uint8Array(n);
  for (let i = 0; i < n; i++) bytes[i] = bin.charCodeAt(i);
  const samples = new Int16Array(bytes.buffer, 0, n >> 1);
  const f32 = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) f32[i] = samples[i] / 32768;
  return f32;
}

/* ------------------------------------------------------------ session ----- */

const S = {
  state: 'IDLE',              // IDLE | CONNECTING | READY | PROMPTING
  turnId: 0,
  contextId: null,            // contextId of the utterance currently owning audio
  fields: [],
  index: -1,
  provider: null,
  ws: null,
  wsUrl: null,
  connected: false,
  prewarmed: false,
  lastError: null,
  tabId: null,

  // current utterance
  utt: null,
  // Phase 3 will consume these; Phase 1 records them to prove the plumbing.
  lastWordTimestamps: null,
  droppedStaleChunks: 0,
  playedChunks: 0,
  // Diagnostics: which contextIds actually arrived, and how many chunk frames
  // in total. Phase 3 debugging needs exactly this when audio does not stop.
  rawChunkFrames: 0,
  contextsSeen: {},

  // ---- Phase 2 -------------------------------------------------------------
  sttProvider: 'backend',     // 'backend' | 'webspeech'
  listening: false,
  liveTurn: null,             // handle for the in-flight web-speech turn
  pending: null,              // { value, display, intent, fieldId } awaiting yes/no
  attempts: {},               // fieldId -> failed attempts, for the retry cap
  filled: {},                 // fieldId -> value actually written
  lastTranscript: null,
  lastStt: null,
};

// Two failures on one field is the point at which repeating the question stops
// being help and starts being a trap; the PRD's error-recovery loop caps it.
const MAX_ATTEMPTS = 2;

const newUtterance = (contextId, text) => ({
  contextId, text,
  startedAt: null, nextTime: 0, scheduledSec: 0,
  chunks: 0, bytes: 0, firstChunkAt: null, sentAt: performance.now(),
  sources: [], done: false,
});

/** Playback position within the current utterance, in seconds. */
function playedSeconds() {
  const u = S.utt;
  if (!u || u.startedAt === null || !ctx) return 0;
  return Math.max(0, Math.min(ctx.currentTime - u.startedAt, u.scheduledSec));
}

/* --------------------------------------------------------------- ws ------- */

// An offscreen document's API surface is restricted to chrome.runtime -
// chrome.storage is NOT defined here, and reading it throws. The background
// service worker owns storage access and hands the config down with the message
// that needs it.
let backendCfg = { backendUrl: 'ws://localhost:8787/speak', proxyToken: '' };

function connect() {
  if (S.ws && (S.ws.readyState === 0 || S.ws.readyState === 1)) return Promise.resolve(S.connected);
  return Promise.resolve(backendCfg).then(({ backendUrl, proxyToken }) => new Promise((resolve) => {
    const u = new URL(backendUrl);
    if (proxyToken) u.searchParams.set('token', proxyToken);
    S.wsUrl = u.toString();
    S.state = 'CONNECTING';
    let settled = false;
    let ws;
    try { ws = new WebSocket(S.wsUrl); }
    catch (e) { S.lastError = String(e.message); S.state = 'IDLE'; return resolve(false); }
    S.ws = ws;

    const fail = (why) => {
      if (settled) return; settled = true;
      S.connected = false; S.state = 'IDLE'; S.lastError = why;
      resolve(false);
    };

    ws.addEventListener('open', () => {
      S.connected = true; S.lastError = null; S.state = 'READY';
      if (!settled) { settled = true; resolve(true); }
    });
    ws.addEventListener('message', (ev) => onFrame(ev.data));
    ws.addEventListener('error', () => fail('websocket error - is the backend running on :8787?'));
    ws.addEventListener('close', (e) => {
      S.connected = false;
      if (S.state !== 'IDLE') S.state = 'IDLE';
      if (!settled) fail(`closed before open (${e.code})`);
    });
    setTimeout(() => fail('connect timeout'), 8000);
  }));
}

/** contextId is echoed on chunk frames (Phase 0 probe 06), field name unassumed. */
function ctxOf(m) {
  return m.contextId ?? m.context_id ?? m.context ?? null;
}

function onFrame(raw) {
  let m;
  try { m = JSON.parse(typeof raw === 'string' ? raw : ''); } catch { return; }

  if (m.type === 'proxy_ready') {
    S.provider = m.provider || null;
    // Prompts carry <400> pause tokens. They are only spoken as pauses when the
    // proxy set pauseBetweenBrackets on the URL - it is silently ignored as a
    // per-message field. If it is off, strip the tokens rather than read them.
    if (globalThis.VFPromptFlagSink) globalThis.VFPromptFlagSink(!!m.provider?.pauseBetweenBrackets);
    return;
  }
  if (m.type === 'proxy_error') { S.lastError = m.error; return; }

  if (m.type === 'chunk' && typeof m.data === 'string') {
    const c = ctxOf(m);
    S.rawChunkFrames++;
    const seenKey = `${c}|cur=${S.contextId}`;
    if (S.contextsSeen[seenKey] !== undefined || Object.keys(S.contextsSeen).length < 60) {
      S.contextsSeen[seenKey] = (S.contextsSeen[seenKey] || 0) + 1;
    }
    // ---- THE STALE DROP -------------------------------------------------
    // Phase 0 constraint 2: discard at the enqueue boundary, BEFORE decode.
    // The post-cancel tail is 192 chunks / 7.4s arriving inside 811ms; decoding
    // audio that is about to be thrown away spends the barge-in budget on
    // nothing. `continue` here is the whole point of tagging every send.
    if (c !== null && S.contextId !== null && c !== S.contextId) { S.droppedStaleChunks++; return; }
    if (!S.utt || S.utt.contextId !== S.contextId) return;
    enqueue(m.data);
    return;
  }

  if (m.type === 'timestamps' || m.word_timestamps || m.wordTimestamps) {
    const wt = m.word_timestamps || m.wordTimestamps || m.timestamps;
    if (wt && wt.words) S.lastWordTimestamps = { contextId: ctxOf(m), words: wt.words, start: wt.start, end: wt.end };
    return;
  }

  if (/^done$/i.test(m.type || '')) {
    if (S.utt) S.utt.done = true;
    settleWait(ctxOf(m), 'done');
    return;
  }
}

/** Schedule one chunk. Sequential, gap-free while the stream outruns realtime. */
function enqueue(b64) {
  const u = S.utt;
  const c = audioContext();
  const f32 = decodePcmChunk(b64);
  if (f32.length === 0) return;

  const buf = c.createBuffer(1, f32.length, PCM_RATE);
  buf.copyToChannel(f32, 0);

  if (u.startedAt === null) {
    u.startedAt = c.currentTime + PREBUFFER_SEC;
    u.nextTime = u.startedAt;
    u.firstChunkAt = performance.now();
  }
  // If the network fell behind realtime the schedule point is already in the
  // past; restart just ahead of now rather than scheduling into it (silently
  // dropped by the Web Audio API).
  if (u.nextTime < c.currentTime + SCHEDULE_LEAD) u.nextTime = c.currentTime + SCHEDULE_LEAD;

  const src = c.createBufferSource();
  src.buffer = buf;
  src.connect(c.destination);
  src.start(u.nextTime);
  u.sources.push(src);
  u.nextTime += buf.duration;
  u.scheduledSec = u.nextTime - u.startedAt;
  u.chunks++; u.bytes += f32.length * 2;
  S.playedChunks++;
}

/** Cut local audio immediately. Phase 3's barge-in calls this; Repeat/Next too. */
function stopAudio() {
  const u = S.utt;
  if (u) {
    for (const s of u.sources) { try { s.stop(); } catch {} try { s.disconnect(); } catch {} }
    u.sources.length = 0;
  }
  S.utt = null;
}

/* ------------------------------------------------------------- speaking --- */
//
// Utterances are QUEUED, never fired back to back. Measured against real Rime
// (tools/verify_ws3_params.mjs and the probe behind it): three text+flush pairs
// sent on one socket with no gap yield audio for the LAST contextId only - the
// earlier ones are silently discarded, with no chunks and no `done`. At 250ms
// spacing all three synthesise.
//
//   back-to-back   {"C-prompt":3.38}
//   250ms apart    {"A-prewarm":0.64,"B-summary":1.71,"C-prompt":1.96}
//
// So "speak the summary, then the first question" cannot be two immediate
// sends: the summary is cancelled and the user never hears it. The queue waits
// for each `done` before sending the next.
//
// Interrupting is the opposite case and stays immediate: when the user presses
// Next, replacing the in-flight utterance is exactly what should happen.

const Q = [];
let pumping = false;
const waiters = new Map();          // contextId -> { resolve, timer }

function settleWait(ctx, why) {
  const w = waiters.get(ctx);
  if (!w) return;
  clearTimeout(w.timer);
  waiters.delete(ctx);
  w.resolve(why);
}

function waitForDone(ctx, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { waiters.delete(ctx); resolve('timeout'); }, ms);
    waiters.set(ctx, { resolve, timer });
  });
}

/** Abandon every pending wait so an interrupting utterance can go out now. */
function abortWaits() {
  for (const ctx of [...waiters.keys()]) settleWait(ctx, 'aborted');
}

async function sendUtterance(item) {
  const c = audioContext();
  if (c.state === 'suspended') { try { await c.resume(); } catch {} }

  stopAudio();
  // Prewarm audio is addressed to a contextId that is never current, so every
  // chunk it produces takes the same stale-drop path a barge-in will use.
  S.contextId = item.prewarm ? '__prewarm_discard__' : item.contextId;
  S.utt = item.prewarm ? null : newUtterance(item.contextId, item.text);
  if (!item.prewarm) S.state = 'PROMPTING';

  try {
    S.ws.send(JSON.stringify({ text: item.text, contextId: item.contextId }));
    // segment=never means nothing synthesises until this flush. Short explicit
    // flushes are what keep `clear` able to cancel anything in Phase 3.
    S.ws.send(JSON.stringify({ operation: 'flush' }));
  } catch (e) {
    S.lastError = String(e.message);
    return;
  }

  // Bounded by the text length: a stuck utterance must not wedge the queue.
  const budget = Math.min(30000, 4000 + item.text.length * 90);
  await waitForDone(item.contextId, budget);
  if (S.state === 'PROMPTING' && !item.prewarm) S.state = 'READY';
}

async function pump() {
  if (pumping) return;
  pumping = true;
  try { while (Q.length) await sendUtterance(Q.shift()); }
  finally { pumping = false; }
}

/**
 * @param interrupt  true  - user asked for something else: drop the queue, cut
 *                           local audio, and make in-flight chunks stale now.
 *                   false - must be heard after what is already queued.
 */
async function speak(text, { prewarm = false, interrupt = true } = {}) {
  const ok = await connect();
  if (!ok) return { ok: false, error: S.lastError || 'not connected' };

  S.turnId += 1;
  const contextId = prewarm ? `prewarm-${S.turnId}` : `turn-${S.turnId}`;

  if (interrupt) {
    Q.length = 0;
    stopAudio();
    // Advancing the current contextId BEFORE the send makes every chunk still
    // in flight from the previous turn stale, so it is dropped at the enqueue
    // boundary rather than decoded and played over the new prompt.
    S.contextId = contextId;
    abortWaits();
  }

  Q.push({ text, contextId, prewarm });
  pump();
  return { ok: true, contextId, turnId: S.turnId, text };
}

/**
 * Pre-warm (Phase 0 constraint 3): cold TTFA 1475ms vs warm 513ms. 1.5s of
 * silence after the user clicks Start reads as a broken product.
 *
 * Run when the popup opens, NOT inside sessionStart: queued ahead of the
 * summary it would simply move the same delay in front of the first prompt,
 * whereas run at popup-open time the socket is already warm by the time Start
 * is pressed.
 */
async function prewarm() {
  if (S.prewarmed) return { ok: true, already: true };
  S.prewarmed = true;
  return speak('Ready.', { prewarm: true, interrupt: false });
}

/* ------------------------------------------------------ Phase 2: filling -- */

const NORM = () => globalThis.VFNormalize;
const STT = () => globalThis.VFStt;

/** Ask the page to write a value, via background - offscreen has no tabs access. */
async function writeToPage(fieldId, type, value) {
  try {
    return await chrome.runtime.sendMessage({
      type: 'VF_WRITE_FIELD', tabId: S.tabId, fieldId, fieldType: type, value,
    });
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

async function readFromPage(fieldId) {
  try {
    return await chrome.runtime.sendMessage({ type: 'VF_READ_FIELD', tabId: S.tabId, fieldId });
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

const intentOf = (field) => globalThis.VFPrompts.classify(field);

/* ------------------------------------------------------------ listening -- */

async function listenStart() {
  if (S.listening) return { ok: true, already: true };
  S.listening = true;
  S.state = 'LISTENING';
  try {
    if (S.sttProvider === 'webspeech') {
      S.liveTurn = STT().webSpeechTurn({ maxMs: 15000 });
    } else {
      await STT().backendStart({ workletUrl: chrome.runtime.getURL('offscreen/recorder-worklet.js') });
    }
    return { ok: true, provider: S.sttProvider };
  } catch (e) {
    S.listening = false;
    S.state = 'READY';
    return { ok: false, error: String(e?.message || e) };
  }
}

/**
 * Release: finish the turn, transcribe, and act on it.
 *
 * Push-to-talk is the default the PRD asks for, and it is what makes Phase 1's
 * playback and Phase 2's capture able to share one device without the mic
 * hearing Rime.
 */
async function listenStop() {
  if (!S.listening) return { ok: false, error: 'not listening' };
  S.listening = false;

  let r;
  if (S.sttProvider === 'webspeech') {
    S.liveTurn?.stop();
    r = await (S.liveTurn?.promise ?? Promise.resolve({ ok: false, text: '', error: 'no turn' }));
    S.liveTurn = null;
  } else {
    const url = new URL(backendCfg.backendUrl);
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
    url.pathname = '/stt';
    r = await STT().backendStop({ backendUrl: url.toString(), proxyToken: backendCfg.proxyToken });
  }

  S.lastStt = r;
  S.lastTranscript = r.text || null;

  if (!r.ok || !r.text) {
    S.state = 'READY';
    // A silent turn is the single most common thing that goes wrong, and
    // saying nothing about it leaves the user with no idea whether the system
    // is broken or simply did not hear them.
    await speak("I didn't catch that. " + pauseToken(300) + 'Try again, holding the key while you speak.');
    return { ok: false, error: r.error || (r.silent ? 'mic captured silence' : 'no speech'), transcript: '',
             seconds: r.seconds, peak: r.peak };
  }
  return handleTranscript(r.text);
}

const pauseToken = (ms) => (globalThis.VFPrompts.getPauseEnabled() ? `<${ms}> ` : '');

/* ------------------------------------------------------------- the loop -- */

async function handleTranscript(transcript) {
  const N = NORM();
  const field = currentField();

  // A yes/no answer to a pending confirmation outranks everything: the user is
  // answering the question that was just asked, not starting a new one.
  if (S.pending) return resolveConfirmation(transcript);

  const cmd = N.parseCommand(transcript);
  if (cmd) return runCommand(cmd.command, transcript);

  if (!field) { await speak('There is no field selected. Say start to begin.'); return { ok: false, error: 'no field' }; }

  const intent = intentOf(field);
  const ex = N.fromSpeech(transcript, field, intent);

  if (ex.ambiguous) {
    // Two options scored alike. Guessing here is a coin flip the user cannot
    // see, so ask instead.
    await speak(`Did you mean ${ex.best}, ${pauseToken(300)}or ${ex.runnerUp}?`);
    return { ok: false, ambiguous: true, transcript, options: [ex.best, ex.runnerUp] };
  }

  if (ex.value === null || ex.value === undefined) {
    return failAttempt(field, ex.note || 'I could not use that', transcript);
  }

  return fillAndConfirm(field, intent, ex, transcript);
}

async function fillAndConfirm(field, intent, ex, transcript) {
  const N = NORM();
  S.state = 'FILLING';
  const w = await writeToPage(field.id, field.type, ex.value);

  if (!w?.ok) {
    return failAttempt(field, w?.error || 'the page would not accept that value', transcript);
  }

  // F2.7: the page gets the last word on whether the value is acceptable.
  if (w.valid === false) {
    S.attempts[field.id] = (S.attempts[field.id] || 0) + 1;
    const reason = String(w.reason || 'that value was not accepted').replace(/\s+/g, ' ').slice(0, 120);
    if (S.attempts[field.id] >= MAX_ATTEMPTS) {
      await speak(`${reason}. ${pauseToken(300)}I'll leave this one for now and come back to it.`);
      S.state = 'READY';
      return move(+1);
    }
    await speak(`${reason}. ${pauseToken(300)}Let's try again.`);
    S.state = 'READY';
    await speakCurrent({ interrupt: false });
    return { ok: false, invalid: true, reason, attempts: S.attempts[field.id] };
  }

  S.filled[field.id] = ex.value;

  // F2.5: confirm where a wrong value is expensive. Free text is confirmed in
  // bulk at the end rather than one question at a time.
  const mustConfirm = N.isHighRisk(intent) || ex.needsConfirmation;
  if (!mustConfirm) {
    S.state = 'READY';
    await speak(`Got it.`, { interrupt: false });
    return move(+1);
  }

  // Read back what is ACTUALLY in the field, not what we meant to write: a
  // masked or coercing input may have changed it, and the user must hear the
  // truth rather than our intention.
  const actual = w.current != null && String(w.current).length ? String(w.current) : String(ex.value);
  const spoken = N.toSpeech(actual, intent) || String(ex.display ?? actual);
  S.pending = { value: ex.value, actual, display: ex.display ?? actual, intent, fieldId: field.id };
  S.state = 'CONFIRMING';
  // "Let me read that back" rather than "Got it": measured 10/10 against 6/10
  // through the round trip. A short carrier leaves the recogniser to pluralise
  // the first digits ("zero zero" -> "zeros"), which silently loses one. It
  // also tells a user who cannot see the screen what is about to happen.
  await speak(`Let me read that back. ${pauseToken(300)}${spoken}. ${pauseToken(400)}Is that correct?`,
              { interrupt: false });
  return { ok: true, confirming: true, value: ex.value, actual, spoken };
}

async function resolveConfirmation(transcript) {
  const N = NORM();
  const p = S.pending;
  const yes = N.parseYesNo(transcript);

  if (yes === true) {
    S.pending = null;
    S.attempts[p.fieldId] = 0;
    S.state = 'READY';
    return move(+1);
  }

  if (yes === false) {
    S.pending = null;
    S.state = 'READY';
    await speak(`Let's try that again.`, { interrupt: true });
    await speakCurrent({ interrupt: false });
    return { ok: true, rejected: true, fieldId: p.fieldId };
  }

  // Not a yes or a no. A correction spoken straight into the confirmation is
  // the common case ("no, it's 160072" without the "no"), so try to read it as
  // a fresh answer before giving up.
  const field = S.fields.find(f => f.id === p.fieldId);
  const ex = field ? N.fromSpeech(transcript, field, p.intent) : { value: null };
  if (ex.value !== null && ex.value !== undefined && String(ex.value) !== String(p.value)) {
    S.pending = null;
    return fillAndConfirm(field, p.intent, ex, transcript);
  }

  await speak(`Sorry - ${pauseToken(200)}is that correct? ${pauseToken(300)}Say yes or no.`);
  return { ok: false, error: 'not a yes or no', transcript };
}

async function failAttempt(field, note, transcript) {
  S.attempts[field.id] = (S.attempts[field.id] || 0) + 1;
  S.state = 'READY';
  if (S.attempts[field.id] >= MAX_ATTEMPTS) {
    await speak(`I'm still not getting that. ${pauseToken(300)}I'll skip this one - you can come back to it.`);
    return move(+1);
  }
  await speak(`Sorry, I didn't get that.`, { interrupt: true });
  await speakCurrent({ interrupt: false });
  return { ok: false, error: note, transcript, attempts: S.attempts[field.id] };
}

/* ---------------------------------------------------------- commands F2.6 */

async function runCommand(command, transcript) {
  const field = currentField();
  switch (command) {
    case 'repeat':   await speakCurrent(); return { ok: true, command };
    case 'next':     return move(+1);
    case 'previous': return move(-1);
    case 'stop':     Q.length = 0; abortWaits(); stopAudio(); S.state = 'READY';
                     await speak('Stopped.'); return { ok: true, command };
    case 'skip':
      if (field) S.attempts[field.id] = 0;
      await speak('Skipped.', { interrupt: true });
      return move(+1);
    case 'readback': {
      if (!field) { await speak('Nothing is selected.'); return { ok: true, command }; }
      const r = await readFromPage(field.id);
      const cur = r?.current;
      if (cur === null || cur === undefined || cur === '') {
        await speak(`${field.label || 'This field'} is empty.`);
      } else {
        const spoken = NORM().toSpeech(String(cur), intentOf(field)) || String(cur);
        await speak(`${field.label || 'This field'} contains ${pauseToken(200)}${spoken}.`);
      }
      return { ok: true, command, current: cur };
    }
    case 'help':
      await speak(`Say your answer, ${pauseToken(200)}or say repeat, ${pauseToken(200)}next, ${pauseToken(200)}back, ${pauseToken(200)}skip, ${pauseToken(200)}or what did you enter.`);
      return { ok: true, command };
    default:
      return { ok: false, error: `unknown command ${command}` };
  }
}

/* -------------------------------------------------------------- session --- */

function currentField() {
  return S.index >= 0 && S.index < S.fields.length ? S.fields[S.index] : null;
}

/** Ask background to move the page's focus ring. Offscreen has no tabs access. */
function requestFocus(field) {
  if (!field) return;
  try {
    chrome.runtime.sendMessage({ type: 'VF_FOCUS_FIELD', fieldId: field.id, index: S.index, tabId: S.tabId });
  } catch {}
}

async function speakCurrent({ withPosition = true, interrupt = true } = {}) {
  const f = currentField();
  if (!f) return { ok: false, error: 'no current field' };
  requestFocus(f);
  const prompt = globalThis.VFPrompts.promptFor(f);
  const text = withPosition ? `${globalThis.VFPrompts.positionFor(S.index, S.fields.length)} ${prompt}` : prompt;
  const r = await speak(text, { interrupt });
  return { ...r, field: f, prompt: text };
}

async function sessionStart({ fields, tabId, backend, speakSummary = true }) {
  if (backend) backendCfg = { ...backendCfg, ...backend };
  S.fields = Array.isArray(fields) ? fields : [];
  S.tabId = tabId ?? S.tabId;
  S.index = S.fields.length ? 0 : -1;
  S.droppedStaleChunks = 0; S.playedChunks = 0; S.rawChunkFrames = 0; S.contextsSeen = {};
  S.pending = null; S.attempts = {}; S.filled = {}; S.lastTranscript = null; S.lastStt = null;

  const ok = await connect();
  if (!ok) return { ok: false, error: S.lastError || 'backend not reachable', fieldCount: S.fields.length };

  if (!S.fields.length) {
    await speak(globalThis.VFPrompts.summaryFor([]));
    return { ok: true, fieldCount: 0, spoke: 'empty-form' };
  }
  if (speakSummary) {
    // Two separate utterances - one short question per flush keeps `clear`
    // useful in Phase 3 and matches how the ear parses it. The first interrupts
    // whatever was playing; the question is QUEUED behind it, because sending
    // both immediately makes Rime discard the summary entirely.
    await speak(globalThis.VFPrompts.summaryFor(S.fields), { interrupt: true });
  }
  const r = await speakCurrent({ interrupt: !speakSummary });
  return { ok: true, fieldCount: S.fields.length, index: S.index, prompt: r.prompt, field: r.field };
}

async function move(delta) {
  if (!S.fields.length) return { ok: false, error: 'no fields' };
  const next = S.index + delta;
  if (next < 0) { await speak('That was the first field.'); return { ok: true, index: S.index, edge: 'start' }; }
  if (next >= S.fields.length) { await speak('That was the last field.'); return { ok: true, index: S.index, edge: 'end' }; }
  S.index = next;
  const r = await speakCurrent();
  return { ok: true, index: S.index, prompt: r.prompt, field: r.field };
}

/**
 * Replace the field list after a DOM mutation without losing the user's place.
 * Matched by stable id, never by index: an SPA remount renumbers everything.
 */
function updateFields(fields) {
  const prevId = currentField()?.id ?? null;
  const before = S.fields.length;
  S.fields = Array.isArray(fields) ? fields : [];
  if (prevId) {
    const i = S.fields.findIndex(f => f.id === prevId);
    S.index = i >= 0 ? i : Math.min(S.index, S.fields.length - 1);
  } else if (S.fields.length && S.index < 0) {
    S.index = 0;
  }
  return { ok: true, before, after: S.fields.length, index: S.index, keptPointer: !!prevId && S.fields.some(f => f.id === prevId) };
}

function snapshot() {
  const f = currentField();
  return {
    ok: true,
    state: S.state, connected: S.connected, provider: S.provider,
    turnId: S.turnId, contextId: S.contextId,
    index: S.index, total: S.fields.length,
    field: f ? { id: f.id, label: f.label, type: f.type, required: f.required, labelSource: f.labelSource, optionCount: f.optionCount } : null,
    playedSeconds: +playedSeconds().toFixed(3),
    utterance: S.utt ? { chunks: S.utt.chunks, bytes: S.utt.bytes, scheduledSec: +S.utt.scheduledSec.toFixed(2), text: S.utt.text } : null,
    lastWordTimestampCount: S.lastWordTimestamps?.words?.length ?? 0,
    droppedStaleChunks: S.droppedStaleChunks, playedChunks: S.playedChunks,
    rawChunkFrames: S.rawChunkFrames, contextsSeen: S.contextsSeen,
    prewarmed: S.prewarmed, lastError: S.lastError, wsUrl: S.wsUrl,
    sttProvider: S.sttProvider, listening: S.listening,
    pending: S.pending ? { display: S.pending.display, intent: S.pending.intent, fieldId: S.pending.fieldId } : null,
    lastTranscript: S.lastTranscript, lastSttError: S.lastStt?.error ?? null,
    attempts: S.attempts, filled: S.filled, filledCount: Object.keys(S.filled).length,
  };
}

/* ------------------------------------------------- phase 0 smoke test ----- */

async function playTest() {
  const url = chrome.runtime.getURL('assets/test.mp3');
  const c = audioContext();
  if (c.state === 'suspended') await c.resume();
  el.src = url;
  const t0 = performance.now();
  const playing = new Promise(res => el.addEventListener('playing', res, { once: true }));
  await el.play();
  const afterPlayCall = performance.now() - t0;
  await Promise.race([playing, new Promise(r => setTimeout(r, 2000))]);
  const startLatencyMs = Math.round(performance.now() - t0);
  return new Promise((resolve) => {
    let settled = false;
    const done = (why) => {
      if (settled) return; settled = true;
      resolve({
        ok: true, startLatencyMs, playCallMs: Math.round(afterPlayCall),
        playedMs: Math.round(performance.now() - t0 - startLatencyMs),
        durationSec: el.duration, audioContextState: c.state, endedCleanly: why === 'ended',
      });
    };
    el.addEventListener('ended', () => done('ended'), { once: true });
    setTimeout(() => done('timeout'), Math.max(3000, (el.duration || 1) * 1000 + 2000));
  });
}

/* -------------------------------------------------------------- router ---- */

chrome.runtime.onMessage.addListener((msg, _s, respond) => {
  if (msg?.target !== 'offscreen') return;
  (async () => {
    try {
      switch (msg.type) {
        case 'OFF_PLAY_TEST':      respond(await playTest()); break;
        case 'OFF_CLOCK':          respond({ ok: true, playedSeconds: playedSeconds() }); break;
        case 'OFF_CONNECT': {
          if (msg.backend) backendCfg = { ...backendCfg, ...msg.backend };
          const okc = await connect();
          if (okc && msg.warm !== false) await prewarm();
          respond({ ok: okc, provider: S.provider, error: S.lastError, prewarmed: S.prewarmed });
          break;
        }
        case 'OFF_PREWARM':        respond(await prewarm()); break;
        case 'OFF_SESSION_START':  respond(await sessionStart(msg)); break;
        case 'OFF_NEXT':           respond(await move(+1)); break;
        case 'OFF_PREV':           respond(await move(-1)); break;
        case 'OFF_REPEAT':         respond(await speakCurrent()); break;
        case 'OFF_SPEAK':          respond(await speak(msg.text)); break;
        case 'OFF_UPDATE_FIELDS':  respond(updateFields(msg.fields)); break;
        case 'OFF_STATE':          respond(snapshot()); break;
        case 'OFF_LISTEN_START':   respond(await listenStart()); break;
        case 'OFF_LISTEN_STOP':    respond(await listenStop()); break;
        case 'OFF_TRANSCRIPT':     respond(await handleTranscript(msg.text)); break;
        case 'OFF_SET_STT':        S.sttProvider = msg.provider === 'webspeech' ? 'webspeech' : 'backend';
                                   respond({ ok: true, provider: S.sttProvider }); break;
        case 'OFF_STOP':
          Q.length = 0; abortWaits(); stopAudio();
          try { STT().releaseMic(); } catch {}
          S.listening = false; S.pending = null;
          S.state = 'READY'; S.index = -1; S.fields = [];
          respond({ ok: true });
          break;
        default: respond({ ok: false, error: `unknown offscreen message ${msg.type}` });
      }
    } catch (e) {
      respond({ ok: false, error: String(e?.message || e) });
    }
  })();
  return true;
});

// The pause-token guard: prompts stop emitting <400> if the proxy did not set
// the query param, so the tokens can never be read aloud as literal text.
globalThis.VFPromptFlagSink = (enabled) => {
  if (globalThis.VFPrompts) globalThis.VFPrompts.setPauseEnabled(enabled);
};

console.log('[VoiceFill] offscreen document loaded');
