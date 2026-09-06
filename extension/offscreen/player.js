// Offscreen: WebSocket to the proxy, the session state machine, turn_id, PCM
// playback, the playback clock, the microphone, and - Phase 3 - barge-in.
//
// Phase 0 locked all of these into THIS document rather than the service
// worker: MV3 workers idle out around 30s against a session that runs for
// minutes, and every chrome.runtime hop costs 5-20ms against the barge-in
// budget. background.js routes and nothing else.
//
// Phase 3 shape of a turn:
//
//   PROMPT(turn n) ── user speaks ──▶ STOP (local, <1 quantum) ──▶ clear upstream
//        │                               │
//        │                               ├─▶ heard ledger: words with start < played
//        │                               └─▶ every frame tagged turn-n is now stale
//        ▼
//   capture (VAD / PTT) ──▶ STT ──▶ in-order queue ──▶ resume table ──▶ fill / accept / correct
//
// Everything that has to be exactly right and can run without a browser lives
// in shared/session-core.js and is unit-tested there. This file wires it to
// Web Audio, the socket and the microphone.

const el = document.getElementById('player');
const CORE = () => globalThis.VFSessionCore;
const NORM = () => globalThis.VFNormalize;
const STT = () => globalThis.VFStt;
const INTENT = () => globalThis.VFIntent;
const MEM = () => globalThis.VFMemory;
const PROMPTS = () => globalThis.VFPrompts;

/* ------------------------------------------------------------ audio ------- */

let ctx = null;
let monitor = null;              // AudioWorkletNode tapping the output
let monitorReady = null;
function audioContext() {
  // 24 kHz to match Rime's pcm sampling rate exactly. Any other rate makes the
  // browser resample, which puts the playback clock out of step with the word
  // timestamps the heard ledger compares against.
  if (!ctx) ctx = new AudioContext({ sampleRate: 24000 });
  return ctx;
}

/** The output monitor sees exactly what the destination sees. It is how stop
 *  latency and "stale audio played" are measured rather than asserted. */
async function ensureMonitor() {
  const c = audioContext();
  if (monitor) return monitor;
  if (!monitorReady) {
    monitorReady = (async () => {
      try {
        await c.audioWorklet.addModule(chrome.runtime.getURL('offscreen/monitor-worklet.js'));
        const node = new AudioWorkletNode(c, 'vf-monitor');
        // Web Audio renders by pulling from the destination, so a node with no
        // path to it is never processed. Route through a zero gain: audible
        // output is unchanged, but the monitor actually runs.
        const mute = c.createGain(); mute.gain.value = 0;
        node.connect(mute); mute.connect(c.destination);
        node.port.onmessage = (e) => {
          if (e.data?.type === 'rec') { recWaiters.splice(0).forEach(r => r(e.data)); return; }
          if (e.data?.type === 'monitor') monitorLast = e.data;
          monitorWaiters.splice(0).forEach(r => r(e.data));
        };
        monitor = node;
      } catch (e) { S.lastError = 'monitor: ' + String(e.message); }
      return monitor;
    })();
  }
  return monitorReady;
}
let monitorLast = null;
const monitorWaiters = [];
// ponytail: debug capture for the static report. Remove with the worklet half.
const recWaiters = [];
function recStart() { if (!monitor) return { ok: false, error: 'no monitor' }; monitor.port.postMessage('rec-start'); return { ok: true }; }
function recDump(timeoutMs = 3000) {
  if (!monitor) return Promise.resolve({ ok: false, error: 'no monitor' });
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ ok: false, error: 'dump timeout' }), timeoutMs);
    recWaiters.push((d) => {
      clearTimeout(t);
      const f = d.samples || new Float32Array(0);
      const pcm = new Int16Array(f.length);
      for (let i = 0; i < f.length; i++) { const v = Math.max(-1, Math.min(1, f[i])); pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff; }
      let bin = ''; const u8 = new Uint8Array(pcm.buffer);
      for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
      resolve({ ok: true, frames: d.frames, rate: audioContext().sampleRate, b64: btoa(bin) });
    });
    monitor.port.postMessage('rec-dump');
  });
}
function queryMonitor(timeoutMs = 200) {
  if (!monitor) return Promise.resolve(null);
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(monitorLast), timeoutMs);
    monitorWaiters.push((d) => { clearTimeout(t); resolve(d); });
    monitor.port.postMessage('query');
  });
}

/** Playback-context time -> performance.now() ms. getOutputTimestamp is the
 *  spec'd mapping; the fallback is exact to one render quantum. */
function ctxTimeToPerf(t) {
  const c = audioContext();
  try {
    const o = c.getOutputTimestamp?.();
    if (o && typeof o.contextTime === 'number' && o.contextTime > 0) return o.performanceTime + (t - o.contextTime) * 1000;
  } catch {}
  return performance.now() - (c.currentTime - t) * 1000;
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
  machine: null,              // DialogMachine; S.state is a getter below
  epoch: 0,                   // bumps on session start/stop; transcripts from an old epoch are dropped
  turnId: 0,
  contextId: null,            // contextId of the turn that currently owns audio (null = nothing may play)
  turn: null,                 // the Turn owning audio
  turns: new Map(),           // contextId -> Turn, bounded, for late frames
  fields: [],
  index: -1,
  provider: null,
  ws: null,
  wsUrl: null,
  connected: false,
  prewarmed: false,
  lastError: null,
  tabId: null,
  reconnect: { attempts: 0, timer: null, lostAt: null, restoredAt: null },

  // frame accounting
  droppedStaleChunks: 0,
  orphanChunks: 0,
  noTurnChunks: 0,
  playedChunks: 0,
  rawChunkFrames: 0,
  contextsSeen: {},
  lastWordTimestamps: null,

  // Phase 2
  sttProvider: 'backend',     // 'backend' | 'webspeech'
  listening: false,           // a PTT turn is open
  liveTurn: null,             // web-speech handle
  pending: null,              // { value, actual, display, intent, fieldId } awaiting yes/no
  attempts: {},
  filled: {},
  answered: {},               // fieldId -> true once a transcript produced a value for it
  lastTranscript: null,
  lastStt: null,

  // Phase 3
  micMode: 'ptt',             // 'ptt' | 'open'
  ledger: null,               // Ledger
  order: null,                // TranscriptOrder
  ptt: null,                  // { binding } for the open push-to-talk turn
  openBinding: null,          // binding for the open-mic segment in progress

  // Personal voice memory. This document has no chrome.storage access, so the
  // service worker loads the profile and hands it down with the message that
  // needs it, exactly as it does the backend address.
  profile: null,
  // The confirmation gate. A correction is only ever remembered once the user
  // has ACCEPTED the corrected value, and only when exactly one correction
  // stood between what was heard and what was accepted.
  learn: null,                // { fieldId, intent, observed, steps }

  metrics: {
    bargeIns: 0, bargeInsBySource: {}, stopSamples: [], staleAudioEvents: 0, staleAudioDetail: [],
    reasks: 0, reaskDetail: [], droppedTranscripts: [], lateTimestamps: 0, clearsSent: 0,
    doubleInterrupts: 0, disconnects: 0, reconnects: 0, preAudioInterrupts: 0,
    // Conversational layer. Every number here is about INTERPRETATION; none of
    // it touches the barge-in path, which runs before a transcript exists.
    intent: { consulted: 0, byOrdinal: 0, byProvider: 0, byFormatting: 0, byMemory: 0, rejected: [],
              clarifications: 0, providerMs: [], providerFailures: 0, staleDiscarded: 0,
              skipped: {}, consultedWhy: {}, learned: [] },
  },
};
Object.defineProperty(S, 'state', { get() { return S.machine.state; } });
const go = (to, why) => S.machine.go(to, why);

// Two failures on one field is the point at which repeating the question stops
// being help and starts being a trap; the PRD's error-recovery loop caps it.
const MAX_ATTEMPTS = 2;
const MAX_TURNS_KEPT = 60;

function init() {
  const C = CORE();
  S.machine = new C.DialogMachine();
  S.ledger = new C.Ledger(80);
  S.order = new C.TranscriptOrder();
  S.order.handler = processTranscript;
  setProfile(null);
}
init();

/* --------------------------------------------------------------- turns ---- */

/**
 * One utterance, from send to its end. `kind` drives the resume table:
 *   prompt   the question for a field           options  the remainder of a choice list
 *   confirm  a read-back awaiting yes/no         info     "Got it.", position, summary
 *   error    "I didn't catch that"               prewarm  never audible
 */
function newTurn(kind, text, { fieldId = null, why = '' } = {}) {
  S.turnId += 1;
  const t = {
    id: S.turnId, contextId: `${kind === 'prewarm' ? 'prewarm' : 'turn'}-${S.turnId}`, kind, text, fieldId, why,
    status: 'queued',            // queued | sent | playing | done | played | interrupted | cancelled | failed
    sentAt: null, firstChunkAt: null, doneAt: null, endedAt: null,
    clock: new (CORE().PlaybackClock)(), sources: [],
    chunks: 0, bytes: 0, ts: null, stop: null, heard: null,
    endResolve: null, endTimer: null,
  };
  S.turns.set(t.contextId, t);
  if (S.turns.size > MAX_TURNS_KEPT) { const k = S.turns.keys().next().value; S.turns.delete(k); }
  return t;
}

/** Audio position of the turn now, in seconds of its utterance. */
function playedSecondsOf(t) {
  if (!t || !ctx) return 0;
  return t.clock.positionAt(ctx.currentTime);
}
const playedSeconds = () => playedSecondsOf(S.turn);

const perfToMs = (perf) => Date.now() - (performance.now() - perf);

function ledgerEntry(t, extra = {}) {
  const C = CORE();
  const e = {
    turnId: t.id, contextId: t.contextId, kind: t.kind, fieldId: t.fieldId, text: t.text, why: t.why,
    sentMs: t.sentAt ? perfToMs(t.sentAt) : null,
    ttfaMs: t.sentAt && t.firstChunkAt ? +(t.firstChunkAt - t.sentAt).toFixed(0) : null,
    audioStartMs: t.clock.startedAt !== null ? perfToMs(ctxTimeToPerf(t.clock.startedAt)) : null,
    status: t.status, playedSec: +(t.stop?.playedSec ?? playedSecondsOf(t)).toFixed(3),
    totalSec: +(t.clock.audioScheduledSec).toFixed(3), chunks: t.chunks,
    gapSec: +t.clock.gapSec.toFixed(3),
    // The utterance's full spoken length, from Rime's word timestamps - known
    // even when it was interrupted, unlike the audio scheduled so far.
    speechSec: t.ts?.end?.length ? +t.ts.end[t.ts.end.length - 1].toFixed(3) : null,
    driftSec: t.stop?.ctxTime !== undefined ? +t.clock.driftAt(t.stop.ctxTime).toFixed(3) : null,
    heard: t.heard, stop: t.stop ? { reason: t.stop.reason, source: t.stop.source } : null,
    at: Date.now(), ...extra,
  };
  e.display = C.heardDisplay(e);
  return S.ledger.upsert(e);
}

/* --------------------------------------------------------------- ws ------- */

// An offscreen document's API surface is restricted to chrome.runtime -
// chrome.storage is NOT defined here. The background service worker owns
// storage and hands the config down with the message that needs it.
let backendCfg = { backendUrl: 'ws://localhost:8787/speak', proxyToken: '' };

function connect() {
  if (S.ws && (S.ws.readyState === 0 || S.ws.readyState === 1)) return Promise.resolve(S.connected);
  return Promise.resolve(backendCfg).then(({ backendUrl, proxyToken }) => new Promise((resolve) => {
    const u = new URL(backendUrl);
    if (proxyToken) u.searchParams.set('token', proxyToken);
    S.wsUrl = u.toString();
    go('CONNECTING', 'connect');
    let settled = false;
    let ws;
    try { ws = new WebSocket(S.wsUrl); }
    catch (e) { S.lastError = String(e.message); go('IDLE', 'connect-threw'); return resolve(false); }
    S.ws = ws;

    const fail = (why) => {
      if (settled) return; settled = true;
      S.connected = false; S.lastError = why;
      go('IDLE', why);
      resolve(false);
    };

    ws.addEventListener('open', () => {
      S.connected = true; S.lastError = null;
      // A reconnect inside a live session resumes where the dialog was; READY
      // means "no session" and would make the next read-back an illegal move.
      go(S.fields.length ? (S.pending ? 'CONFIRMING' : 'LISTENING') : 'READY', S.fields.length ? 'ws-reopen' : 'ws-open');
      if (!settled) { settled = true; resolve(true); }
    });
    ws.addEventListener('message', (ev) => onFrame(ev.data));
    ws.addEventListener('error', () => fail('websocket error - is the backend running on :8787?'));
    ws.addEventListener('close', (e) => {
      const wasConnected = S.connected;
      S.connected = false;
      if (!settled) { fail(`closed before open (${e.code})`); return; }
      if (wasConnected) onDisconnect(e.code);
    });
    setTimeout(() => fail('connect timeout'), 8000);
  }));
}

/**
 * The socket dropped under a live session. The turn in flight can never
 * finish: it is recorded as failed (not interrupted - nobody spoke), local
 * audio is cut so a half-sentence does not hang in the air, and reconnection
 * is attempted with backoff. Nothing is re-asked on recovery: if a read-back
 * was pending it is spoken again, because the user still owes a yes or no.
 */
function onDisconnect(code) {
  S.metrics.disconnects++;
  S.reconnect.lostAt = Date.now();
  S.lastError = `connection lost (${code})`;
  const t = S.turn;
  if (t && (t.status === 'sent' || t.status === 'playing')) {
    const playedSec = playedSecondsOf(t);
    stopAudio('disconnect');
    t.status = 'failed';
    t.stop = { reason: 'connection lost', source: 'disconnect', playedSec, perf: performance.now() };
    t.heard = CORE().heardWords(t.ts, playedSec);
    ledgerEntry(t);
    settleEnd(t, 'disconnect');
  }
  Q.length = 0; abortWaits();
  go('IDLE', 'disconnect');
  scheduleReconnect();
}

function scheduleReconnect() {
  if (S.reconnect.timer || !S.fields.length) return;
  const n = S.reconnect.attempts;
  if (n >= 6) return;
  const delay = Math.min(8000, 500 * 2 ** n);
  S.reconnect.timer = setTimeout(async () => {
    S.reconnect.timer = null;
    S.reconnect.attempts++;
    const ok = await connect();
    if (!ok) { scheduleReconnect(); return; }
    S.reconnect.attempts = 0; S.reconnect.restoredAt = Date.now(); S.metrics.reconnects++;
    if (S.pending) await speakReadback(S.pending, 'reconnect');
    else if (currentField()) await speak('Connection restored.', { kind: 'info', why: 'reconnect' });
  }, delay);
}

/** contextId is echoed on chunk frames (Phase 0 probe 06), field name unassumed. */
function ctxOf(m) { return m.contextId ?? m.context_id ?? m.context ?? null; }

function onFrame(raw) {
  let m;
  try { m = JSON.parse(typeof raw === 'string' ? raw : ''); } catch { return; }
  const C = CORE();

  if (m.type === 'proxy_ready') {
    S.provider = m.provider || null;
    if (globalThis.VFPromptFlagSink) globalThis.VFPromptFlagSink(!!m.provider?.pauseBetweenBrackets, !!m.provider?.phonemizeBetweenBrackets);
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
    // ---- THE STALE DROP ---------------------------------------------------
    // Decided BEFORE decode, from the contextId alone. The post-cancel tail
    // measured in Phase 0 is 192 chunks / 7.4s arriving inside 811ms; decoding
    // audio that is about to be thrown away spends the barge-in budget on
    // nothing. Chunks with no contextId are dropped too: Rime tags every one,
    // so an untagged chunk is not ours to play.
    const cur = S.turn && S.turn.contextId === S.contextId ? S.turn : null;
    const decision = C.chunkDecision(c, cur ? { contextId: cur.contextId, status: cur.status } : null);
    if (decision === 'stale' || (decision === 'noturn' && c !== null && S.turns.has(c))) {
      // A chunk for a turn that is over - interrupted, replaced, played - is the
      // stale tail, whether or not something else is playing yet.
      S.droppedStaleChunks++; const old = S.turns.get(c); if (old) old.staleAfter = (old.staleAfter || 0) + 1; return;
    }
    if (decision === 'orphan') { S.orphanChunks++; return; }
    if (decision === 'noturn') { S.noTurnChunks++; return; }
    if (cur.kind === 'prewarm') { cur.chunks++; return; }     // never audible
    enqueue(cur, m.data);
    return;
  }

  if (m.type === 'timestamps' || m.word_timestamps || m.wordTimestamps) {
    const wt = m.word_timestamps || m.wordTimestamps || m.timestamps;
    const c = ctxOf(m);
    if (wt && wt.words) {
      const ts = { contextId: c, words: wt.words, start: wt.start, end: wt.end };
      S.lastWordTimestamps = ts;
      const t = c !== null ? S.turns.get(c) : (S.turn || null);
      // First timestamps frame per turn wins. Rime sends one per flush; anything
      // later under the same contextId (the stub's stale-tail case) must not
      // rewrite what the user is known to have heard.
      if (t && t.ts) { S.metrics.duplicateTimestamps = (S.metrics.duplicateTimestamps || 0) + 1; return; }
      if (t) {
        t.ts = ts;
        // Late for a turn already stopped: finalise its heard set retroactively.
        if (t.stop && (t.status === 'interrupted' || t.status === 'failed' || t.status === 'cancelled')) {
          t.heard = C.heardWords(ts, t.stop.playedSec);
          S.ledger.lateTimestamps(c, ts);
          S.metrics.lateTimestamps++;
        }
      }
    }
    return;
  }

  if (/^done$/i.test(m.type || '')) {
    const c = ctxOf(m);
    const t = c !== null ? S.turns.get(c) : S.turn;
    if (t) {
      t.doneAt = performance.now();
      if (t.status === 'sent' || t.status === 'playing') {
        t.status = t.chunks ? 'done' : 'played';
        armPlaybackEnd(t);
      }
    }
    settleWait(c ?? S.turn?.contextId, 'done');
    return;
  }
}

/** Schedule one chunk. Sequential, gap-free while the stream outruns realtime. */
function enqueue(t, b64) {
  const c = audioContext();
  const f32 = decodePcmChunk(b64);
  if (f32.length === 0) return;

  const buf = c.createBuffer(1, f32.length, PCM_RATE);
  buf.copyToChannel(f32, 0);

  let at;
  if (!t.clock.segments.length) {
    at = c.currentTime + PREBUFFER_SEC;
    t.firstChunkAt = performance.now();
    t.status = 'playing';
    duckMic(true);
  } else {
    at = t.clock.scheduledEnd;
  }
  // If the network fell behind realtime the schedule point is already in the
  // past; restart just ahead of now rather than scheduling into it (silently
  // dropped by the Web Audio API). The clock records the gap so the ledger
  // does not count the silence as words.
  if (at < c.currentTime + SCHEDULE_LEAD) at = c.currentTime + SCHEDULE_LEAD;

  const src = c.createBufferSource();
  src.buffer = buf;
  src.connect(c.destination);
  if (monitor) src.connect(monitor);
  src.start(at);
  t.sources.push(src);
  t.clock.add(at, buf.duration, t.clock.audioScheduledSec);
  t.chunks++; t.bytes += f32.length * 2;
  S.playedChunks++;
}

/** Cut local audio NOW. Synchronous; the one step on the barge-in critical path. */
function stopAudio(reason = 'stop') {
  const t = S.turn;
  if (t) {
    for (const s of t.sources) { try { s.stop(); } catch {} try { s.disconnect(); } catch {} }
    t.sources.length = 0;
    if (t.endTimer) { clearTimeout(t.endTimer); t.endTimer = null; }
  }
  S.turn = null;
  S.contextId = null;        // nothing may play until the next send re-arms it
  duckMic(false);
  return t;
}

/* ------------------------------------------------- playback end tracking -- */

// `done` from Rime means "all chunks delivered", which for a 2s utterance is
// ~600ms after the first chunk. The user has heard a quarter of it. The turn
// ENDS when the last scheduled sample has played, so state changes and the
// next queued utterance wait for that moment, not for `done`.
function armPlaybackEnd(t) {
  if (t.endTimer) clearTimeout(t.endTimer);
  const c = audioContext();
  const end = t.clock.scheduledEnd;
  const ms = end === null ? 0 : Math.max(0, (end - c.currentTime) * 1000) + 40;
  t.endTimer = setTimeout(() => onPlaybackEnd(t), ms);
}

function onPlaybackEnd(t) {
  t.endTimer = null;
  if (S.turn !== t) return;           // interrupted or replaced meanwhile
  t.status = 'played'; t.endedAt = performance.now();
  t.heard = CORE().heardWords(t.ts, Infinity);
  ledgerEntry(t);
  S.turn = null; S.contextId = null;
  afterPlayback(t);
  settleEnd(t, 'played');
}

/** Where the dialog is once an utterance has been fully heard. */
function afterPlayback(t) {
  if (Q.length) return;                          // the next utterance sets state
  if (t.kind === 'prewarm') return;
  // An utterance from the PREVIOUS session settling after stop, or between a
  // restart assigning fields and its socket opening. Audio finishing cannot
  // make a session that is not connected live, and letting it try produced a
  // real IDLE -> LISTENING transition under a harness that restarts often.
  if (S.state === 'IDLE' || S.state === 'CONNECTING') return;
  if (S.pending) { if (S.state !== 'CONFIRMING') go('CONFIRMING', `after ${t.kind}`); return; }
  if (currentField()) { if (S.state !== 'LISTENING') go('LISTENING', `after ${t.kind}`); return; }
  if (S.state !== 'READY') go('READY', `after ${t.kind}`);
}

function settleEnd(t, why) {
  // Every route out of a turn passes here - played out, interrupted, replaced,
  // disconnected - so this is the one place the microphone is guaranteed to be
  // un-ducked. Missing it would leave the detector deaf to the user.
  duckMic(false);
  const r = t.endResolve; t.endResolve = null; if (r) r(why);
}
const waitEnd = (t) => new Promise((r) => { t.endResolve = r; });

/* ------------------------------------------------------------- speaking --- */
//
// Utterances are QUEUED, never fired back to back. Measured against real Rime:
// three text+flush pairs sent on one socket with no gap yield audio for the
// LAST contextId only. The queue waits for each utterance to END (played, not
// merely delivered) before sending the next.
//
// Interrupting is the opposite case and stays immediate: when the user speaks
// or presses Next, replacing the in-flight utterance is exactly the point.

const Q = [];
let pumping = false;
const waiters = new Map();          // contextId -> { resolve, timer }

function settleWait(c, why) {
  const w = waiters.get(c);
  if (!w) return;
  clearTimeout(w.timer);
  waiters.delete(c);
  w.resolve(why);
}
function waitForDone(c, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { waiters.delete(c); resolve('timeout'); }, ms);
    waiters.set(c, { resolve, timer });
  });
}
/** Abandon every pending wait so an interrupting utterance can go out now. */
function abortWaits() { for (const c of [...waiters.keys()]) settleWait(c, 'aborted'); }

async function sendUtterance(t) {
  const c = audioContext();
  if (c.state === 'suspended') { try { await c.resume(); } catch {} }
  await ensureMonitor();

  if (!S.connected) {
    const ok = await connect();
    if (!ok) { t.status = 'failed'; t.stop = { reason: 'not connected', source: 'send', playedSec: 0 }; ledgerEntry(t); return; }
  }

  // Anything still owning audio is replaced (system-initiated, never counted
  // as a user interruption).
  const prev = stopAudio('replace');
  if (prev && prev !== t && ['sent', 'playing', 'done'].includes(prev.status)) {
    prev.status = 'cancelled'; prev.stop = { reason: 'replaced', source: 'system', playedSec: playedSecondsOf(prev) };
    prev.heard = CORE().heardWords(prev.ts, prev.stop.playedSec); ledgerEntry(prev); settleEnd(prev, 'replaced');
  }

  S.turn = t;
  S.contextId = t.contextId;
  noteSpoken(t.text);        // echo reference: this is about to come out of the speaker
  t.status = 'sent'; t.sentAt = performance.now();
  if (t.kind !== 'prewarm') go(t.kind === 'confirm' ? 'CONFIRMING' : 'PROMPTING', `speak:${t.kind}`);

  try {
    S.ws.send(JSON.stringify({ text: t.text, contextId: t.contextId }));
    // segment=never means nothing synthesises until this flush. Short explicit
    // flushes are what keep `clear` able to cancel anything.
    S.ws.send(JSON.stringify({ operation: 'flush' }));
  } catch (e) {
    S.lastError = String(e.message);
    t.status = 'failed'; t.stop = { reason: 'send failed', source: 'send', playedSec: 0 }; ledgerEntry(t);
    if (S.turn === t) { S.turn = null; S.contextId = null; }
    return;
  }

  // Bounded by the text length: a stuck utterance must not wedge the queue.
  const budget = Math.min(30000, 4000 + t.text.length * 90);
  const endP = waitEnd(t);
  const why = await waitForDone(t.contextId, budget);
  if (S.turn !== t) return;                        // interrupted / replaced during synthesis
  if (why === 'timeout') {
    if (!t.chunks) { t.status = 'failed'; t.stop = { reason: 'no audio (timeout)', source: 'send', playedSec: 0 }; ledgerEntry(t); S.turn = null; S.contextId = null; afterPlayback(t); return; }
    armPlaybackEnd(t);
  }
  if (t.kind === 'prewarm') { S.turn = null; S.contextId = null; return; }
  await Promise.race([endP, new Promise(r => setTimeout(r, 20000))]);
}

async function pump() {
  if (pumping) return;
  pumping = true;
  try { while (Q.length) await sendUtterance(Q.shift()); }
  finally { pumping = false; }
}

/**
 * @param kind       prompt | confirm | options | info | error | prewarm
 * @param interrupt  true  - replace whatever is playing and drop the queue
 *                   false - must be heard after what is already queued
 */
async function speak(text, { kind = 'info', fieldId = null, why = '', interrupt = true, prewarm = false } = {}) {
  const ok = await connect();
  if (!ok) return { ok: false, error: S.lastError || 'not connected' };
  const t = newTurn(prewarm ? 'prewarm' : kind, text, { fieldId, why });
  if (interrupt) {
    for (const q of Q) { q.status = 'cancelled'; q.stop = { reason: 'dequeued', source: 'system', playedSec: 0 }; ledgerEntry(q); }
    Q.length = 0;
    const prev = stopAudio('replace');
    if (prev && ['sent', 'playing', 'done'].includes(prev.status)) {
      prev.status = 'cancelled'; prev.stop = { reason: 'replaced', source: 'system', playedSec: playedSecondsOf(prev) };
      prev.heard = CORE().heardWords(prev.ts, prev.stop.playedSec); ledgerEntry(prev); settleEnd(prev, 'replaced');
    }
    abortWaits();
  }
  Q.push(t);
  pump();
  return { ok: true, contextId: t.contextId, turnId: t.id, text };
}

/** Pre-warm (Phase 0 constraint 3): cold TTFA 1475ms vs warm 513ms. */
async function prewarm() {
  if (S.prewarmed) return { ok: true, already: true };
  S.prewarmed = true;
  return speak('Ready.', { prewarm: true, interrupt: false });
}

/* ------------------------------------------------------------ barge-in ---- */

/**
 * The user spoke (or pressed to talk) while Rime was speaking. Order matters:
 *
 *   1. stop local audio            synchronous, this is the latency figure
 *   2. make the turn stale         S.contextId = null: every in-flight chunk
 *                                  tagged with it is dropped before decode
 *   3. record the heard ledger     words with start < played position
 *   4. clear upstream              off the critical path; measured in Phase 0
 *                                  to save little once synthesis is committed,
 *                                  sent anyway so Rime stops streaming the tail
 *   5. measure                     ask the output monitor when the last loud
 *                                  block was rendered
 *
 * Idempotent: a second call for the same turn does nothing but count.
 */
function bargeIn({ source = 'vad', onsetPerf = performance.now(), receivedPerf = performance.now() } = {}) {
  const t = S.turn;
  const C = CORE();
  S.metrics.bargeInsBySource[source] = (S.metrics.bargeInsBySource[source] || 0) + 1;

  if (!t || !['sent', 'playing', 'done'].includes(t.status)) {
    // Nothing is playing: there is nothing to stop. Queued utterances are left
    // alone - if the speech turns out to be a real answer its transcript will
    // interrupt whatever is playing by then; if it was a breath or a click,
    // the user must still hear the read-back they are owed.
    return { stopped: false, dropped: 0, turnId: null };
  }

  const stopCallPerf = performance.now();
  const c = audioContext();
  const stopCtxTime = c.currentTime;
  const playedSec = t.clock.positionAt(stopCtxTime);
  const hadAudio = t.clock.segments.length > 0 && stopCtxTime >= t.clock.startedAt;

  stopAudio('barge-in');                                           // 1 + 2
  const stopDonePerf = performance.now();
  S.metrics.bargeIns++;
  if (!hadAudio) S.metrics.preAudioInterrupts++;

  t.status = 'interrupted';
  t.stop = { reason: 'barge-in', source, playedSec, perf: stopCallPerf, ctxTime: stopCtxTime, onsetPerf, receivedPerf, hadAudio };
  t.heard = C.heardWords(t.ts, playedSec);                         // 3
  const entry = ledgerEntry(t);
  settleEnd(t, 'interrupted');

  // 4. Upstream cancel. Never awaited.
  try { if (S.ws && S.ws.readyState === 1) { S.ws.send(JSON.stringify({ operation: 'clear' })); S.metrics.clearsSent++; } } catch {}
  Q.length = 0; abortWaits();

  if (S.state === 'PROMPTING' || S.state === 'CONFIRMING') go('LISTENING', `barge-in:${source}`);

  // 5. Measure against the rendered output, not our own bookkeeping.
  const sample = {
    turnId: t.id, kind: t.kind, source, playedSec: +playedSec.toFixed(3), hadAudio,
    totalSec: +t.clock.audioScheduledSec.toFixed(3), heardCount: t.heard?.heardCount ?? null,
    onsetToReceiveMs: +(receivedPerf - onsetPerf).toFixed(1),
    detectToStopCallMs: +(stopDonePerf - onsetPerf).toFixed(1),
    // Two "silent" figures, because they answer different questions:
    //   detectToRenderSilentMs  onset -> last loud block RENDERED by the graph
    //                           (our pipeline: detector, hop, stop, one quantum)
    //   detectToSilentMs        onset -> that block leaving the OUTPUT device,
    //                           per getOutputTimestamp: adds the platform's sink
    //                           buffer (ctx.outputLatency; 216ms on headless
    //                           Chrome's fake sink, ~5-30ms on real hardware)
    detectToRenderSilentMs: null, detectToSilentMs: null, alreadySilent: null,
    stopLatencyMs: null,          // max(render-silent, stop-call): the pipeline figure
    stopLatencyIncSinkMs: null,   // max(output-silent, stop-call): what a listener on THIS device hears
  };
  S.metrics.stopSamples.push(sample);
  if (S.metrics.stopSamples.length > 200) S.metrics.stopSamples.shift();
  setTimeout(async () => {
    const m = await queryMonitor();
    if (!m || !hadAudio) { sample.stopLatencyMs = sample.detectToStopCallMs; sample.stopLatencyIncSinkMs = sample.detectToStopCallMs; sample.alreadySilent = !hadAudio; return; }
    const lastLoudEndPerf = m.lastLoudEnd > 0 ? ctxTimeToPerf(m.lastLoudEnd) : -Infinity;
    const lastLoudEndRenderPerf = m.lastLoudEnd > 0 ? performance.now() - (c.currentTime - m.lastLoudEnd) * 1000 : -Infinity;
    // Loud output after our stop, before any new turn began, is stale audio.
    const newTurnStarted = S.turn && S.turn.clock.startedAt !== null && S.turn.clock.startedAt <= m.lastLoudEnd;
    if (m.lastLoudEnd > stopCtxTime + 0.02 && !newTurnStarted) {
      S.metrics.staleAudioEvents++;
      S.metrics.staleAudioDetail.push({ turnId: t.id, afterStopMs: +((m.lastLoudEnd - stopCtxTime) * 1000).toFixed(1) });
    }
    if (lastLoudEndRenderPerf < onsetPerf) {
      // Output was already silent when the user began (a pause token, or the
      // pre-buffer). Report the pipeline figure so the number never flatters.
      sample.alreadySilent = true;
      sample.detectToRenderSilentMs = 0; sample.detectToSilentMs = 0;
      sample.stopLatencyMs = sample.detectToStopCallMs;
      sample.stopLatencyIncSinkMs = sample.detectToStopCallMs;
    } else {
      sample.alreadySilent = false;
      sample.detectToRenderSilentMs = +(lastLoudEndRenderPerf - onsetPerf).toFixed(1);
      sample.detectToSilentMs = +(lastLoudEndPerf - onsetPerf).toFixed(1);
      sample.stopLatencyMs = +Math.max(sample.detectToRenderSilentMs, sample.detectToStopCallMs).toFixed(1);
      sample.stopLatencyIncSinkMs = +Math.max(sample.detectToSilentMs, sample.detectToStopCallMs).toFixed(1);
    }
    sample.outputLatencyMs = +((c.outputLatency || 0) * 1000).toFixed(1);
    sample.baseLatencyMs = +((c.baseLatency || 0) * 1000).toFixed(1);
  }, 150);

  return { stopped: true, turnId: t.id, kind: t.kind, playedSec, heard: entry.display, sample };
}

/* ------------------------------------------------------ Phase 2: filling -- */

async function writeToPage(fieldId, type, value) {
  try { return await chrome.runtime.sendMessage({ type: 'VF_WRITE_FIELD', tabId: S.tabId, fieldId, fieldType: type, value }); }
  catch (e) { return { ok: false, error: String(e?.message || e) }; }
}
async function readFromPage(fieldId) {
  try { return await chrome.runtime.sendMessage({ type: 'VF_READ_FIELD', tabId: S.tabId, fieldId }); }
  catch (e) { return { ok: false, error: String(e?.message || e) }; }
}
const intentOf = (field) => PROMPTS().classify(field);
const pauseToken = (ms) => (PROMPTS().getPauseEnabled() ? `<${ms}> ` : '');

/* ------------------------------------------------------------ captures ---- */

/** What a transcript is bound to at the moment speech STARTS. */
function openCapture(source, extra = {}) {
  const f = currentField();
  const t = S.turn;
  const interrupted = t && ['sent', 'playing', 'done'].includes(t.status)
    ? { turnId: t.id, kind: t.kind, playedSec: +playedSecondsOf(t).toFixed(3) } : null;
  return S.order.open({
    epoch: S.epoch, fieldId: f?.id ?? null, source,
    pendingKey: S.pending ? `${S.pending.fieldId}:${S.pending.value}` : null,
    interrupted, startedPerf: performance.now(), ...extra,
  });
}

/** Fill in what the interrupted turn turned out to have said (after bargeIn ran). */
function bindInterrupted(binding, result) {
  if (result?.stopped) {
    const t = S.turns.get(`turn-${result.turnId}`);
    binding.interrupted = { turnId: result.turnId, kind: result.kind, playedSec: result.playedSec, heardText: t?.heard?.heardText ?? '', heardKnown: !!t?.heard?.known };
  }
  return binding;
}

/* ------------------------------------------------------------ listening -- */
//
// Push-to-talk (Phase 2). Pressing while Rime speaks IS a barge-in: same stop,
// same ledger, same resume table as the open microphone.

async function listenStart() {
  if (S.listening) return { ok: true, already: true };
  S.listening = true;
  const bi = bargeIn({ source: 'ptt' });
  const binding = bindInterrupted(openCapture('ptt'), bi);
  S.ptt = { binding };
  if (['PROMPTING', 'CONFIRMING', 'LISTENING'].includes(S.state) && S.state !== 'LISTENING') go('LISTENING', 'ptt');
  try {
    if (S.sttProvider === 'webspeech') {
      S.liveTurn = STT().webSpeechTurn({ maxMs: 15000 });
    } else {
      await STT().backendStart({ workletUrl: chrome.runtime.getURL('offscreen/recorder-worklet.js') });
    }
    return { ok: true, provider: S.sttProvider, bargeIn: bi.stopped ? bi : null };
  } catch (e) {
    S.listening = false; S.ptt = null;
    S.order.abandon(binding.captureId);
    return { ok: false, error: String(e?.message || e) };
  }
}

function sttUrl() {
  const url = new URL(backendCfg.backendUrl);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = '/stt';
  return url.toString();
}

async function listenStop() {
  if (!S.listening) return { ok: false, error: 'not listening' };
  S.listening = false;
  const binding = S.ptt?.binding; S.ptt = null;

  let r;
  if (S.sttProvider === 'webspeech') {
    S.liveTurn?.stop();
    r = await (S.liveTurn?.promise ?? Promise.resolve({ ok: false, text: '', error: 'no turn' }));
    S.liveTurn = null;
  } else {
    if (['LISTENING', 'CONFIRMING'].includes(S.state)) go('TRANSCRIBING', 'ptt-release');
    r = await STT().backendStop({ backendUrl: sttUrl(), proxyToken: backendCfg.proxyToken });
  }
  return finishCapture(binding, r);
}

/* ------------------------------------------------------------ echo guard -- */
//
// An open microphone next to a speaker hears the extension itself. Rime's own
// words come back as a transcript, get taken for the user's answer, trigger a
// read-back, and that is heard again: the runaway that shreds the output.
// Chrome's echoCancellation cannot carry this alone - the playback graph is a
// separate 24 kHz AudioContext, a poor AEC reference - so the loop is broken
// here instead, at the one point every transcript passes.
//
// The reference is what was AUDIBLE when the capture cut in (heardText from the
// heard ledger), not the whole utterance: only words that actually reached the
// speaker can have come back through the microphone.
const ECHO_MIN_OVERLAP = 0.6;   // share of the transcript that is a verbatim run of our own speech
const ECHO_MIN_WORDS = 2;       // "yes"/"no" are never echo-rejected
const ECHO_RESUME_MAX = 2;      // re-speak a self-interrupted prompt, but never forever
const ECHO_WINDOW_MS = 10000;   // how long our own words stay "recently spoken"

// Rejecting echo transcripts stops the runaway, but the microphone still FIRES
// on our own voice, so every prompt was cut off and restarted - the stutter
// that reads as clipping. On speakers the echo is attenuated relative to a user
// talking into the machine, so the detector is ducked while our audio is
// audible: self-triggering needs the echo to clear a much higher bar, and a
// real barge-in still clears it.
const VAD_BASE = { ABS_MIN: 0.012 };            // recorder-worklet default
const VAD_DUCKED = { ABS_MIN: 0.012 * 3.5 };    // ponytail: fixed ratio; make it adaptive if a room defeats it
let ducked = false;
function duckMic(on) {
  if (S.micMode !== 'open' || on === ducked) return;
  if (STT().setVadParams(on ? VAD_DUCKED : VAD_BASE)) ducked = on;
}

/**
 * What we have said aloud recently.
 *
 * The interrupted binding alone is not enough, which is why the first version
 * of this guard never fired: the microphone segment only ends after the VAD's
 * 0.9s hangover, so a capture of our own speech is routinely transcribed AFTER
 * the audio finished and carries no interrupted turn at all. Word timestamps
 * may also not have arrived, leaving heardText empty. A time window catches all
 * three cases without depending on either.
 */
function noteSpoken(text) {
  if (!text) return;
  const now = Date.now();
  (S.spoken ||= []).push({ text: String(text), at: now });
  while (S.spoken.length && now - S.spoken[0].at > ECHO_WINDOW_MS) S.spoken.shift();
}
function recentSpokenText() {
  const cut = Date.now() - ECHO_WINDOW_MS;
  return (S.spoken || []).filter(e => e.at >= cut).map(e => e.text).join(' ');
}

/**
 * Was this capture the extension hearing itself? Only a capture that
 * interrupted our own audio can be echo; anything spoken after the audio
 * stopped is the user, however similar it reads.
 */
function echoVerdict(binding, text) {
  const ref = `${binding?.interrupted?.heardText || ''} ${recentSpokenText()}`.trim();
  if (!ref) return null;
  const overlap = CORE().echoRun(text, ref, { minWords: ECHO_MIN_WORDS });
  if (overlap < ECHO_MIN_OVERLAP) return null;
  // The machine hearing itself REPRODUCES the value it just said. A person
  // re-speaking a digit string to change one digit produces nearly the same
  // words - "one six zero zero seven THREE" against a read-back of "one six
  // zero zero seven two" is a contiguous run of five words out of six - and
  // was being thrown away as echo. Measured: 2 of 5 double-interrupt trials in
  // tools/test_bargein.mjs, and it is exactly the fight with the recogniser
  // this layer exists to end.
  //
  // Same LENGTH, different digits is the discriminator, and it is safe in both
  // directions: a verbatim echo matches the value, and an echo that whisper
  // dropped a digit from is SHORTER, so both stay rejected.
  const p = S.pending;
  if (p && INTENT()?.DIGIT_INTENTS?.has(p.intent)) {
    const said = NORM().wordsToDigits(text);
    const val = String(p.value ?? '');
    if (said && said.length === val.length && said !== val) return null;
  }
  return { overlap: +overlap.toFixed(2), turnId: binding?.interrupted?.turnId ?? null };
}

/** Common tail for PTT and open-mic segments: hand the transcript to the in-order queue. */
async function finishCapture(binding, r) {
  S.lastStt = r;
  S.lastTranscript = r.text || null;
  if (!r.ok || !r.text) {
    if (binding) S.order.abandon(binding.captureId);
    (S.transcripts ||= []).push({ captureId: binding?.captureId ?? null, source: binding?.source ?? null, transcript: '', decision: 'abandoned', error: r.error || null, seconds: r.seconds ?? null, at: Date.now() });
    if (S.state === 'TRANSCRIBING') go(S.pending ? 'CONFIRMING' : (currentField() ? 'LISTENING' : 'READY'), 'empty-transcript');
    // Push-to-talk: a silent turn is the single most common thing that goes
    // wrong, and saying nothing leaves the user unsure whether it is broken or
    // deaf. Open mic: a short burst of energy that transcribes to nothing is a
    // breath or a click; only real speech that came back empty is worth a
    // word, and it is QUEUED behind whatever is owed (a read-back), never
    // allowed to cancel it.
    const worthSaying = binding?.source === 'ptt' ? !r.silent : ((r.seconds || 0) >= 0.8 && !r.silent && r.error !== 'too short');
    if (worthSaying) {
      await speak("I didn't catch that. " + pauseToken(300) + (S.micMode === 'open' ? 'Please say that again.' : 'Try again, holding the key while you speak.'),
                  { kind: 'error', fieldId: currentField()?.id ?? null, why: 'no-speech', interrupt: binding?.source === 'ptt' });
    }
    return { ok: false, error: r.error || (r.silent ? 'mic captured silence' : 'no speech'), transcript: '', seconds: r.seconds, peak: r.peak };
  }
  // The extension hearing itself is not an answer. Drop it before it can reach
  // the resume table, or it becomes the next utterance and is heard again.
  const echo = echoVerdict(binding, r.text);
  if (echo) {
    S.metrics.echoRejected = (S.metrics.echoRejected || 0) + 1;
    S.order.abandon(binding.captureId);
    (S.transcripts ||= []).push({ captureId: binding.captureId, source: binding.source ?? null, transcript: r.text,
                                  decision: 'echo', overlap: echo.overlap, seconds: r.seconds ?? null, at: Date.now() });
    // Our own prompt was cut off by our own voice, so say it again - but a
    // bounded number of times, or the resume is just the runaway again.
    const t = echo.turnId ? S.turns.get(`turn-${echo.turnId}`) : null;
    const n = echo.turnId ? ((S.echoResumes ||= new Map()).get(echo.turnId) || 0) : ECHO_RESUME_MAX;
    if (t && t.text && n < ECHO_RESUME_MAX) {
      S.echoResumes.set(echo.turnId, n + 1);
      await speak(t.text, { kind: t.kind, fieldId: t.fieldId, why: 'echo-resume', interrupt: true });
    } else {
      S.metrics.echoGaveUp = (S.metrics.echoGaveUp || 0) + 1;
      if (S.state === 'TRANSCRIBING') go(S.pending ? 'CONFIRMING' : (currentField() ? 'LISTENING' : 'READY'), 'echo-drop');
    }
    return { ok: false, error: 'echo rejected', transcript: r.text, echo, seconds: r.seconds, peak: r.peak };
  }

  const out = binding ? await S.order.settle(binding.captureId, r.text) : await processTranscript(openCapture('direct'), r.text);
  return { ...out, transcript: r.text, seconds: r.seconds, peak: r.peak, sttMs: r.ms };
}

/* ------------------------------------------------------- open microphone -- */

async function setMicMode(mode, params) {
  mode = mode === 'open' ? 'open' : 'ptt';
  if (mode === S.micMode && (mode === 'ptt' || STT().isOpenMic())) return { ok: true, mode, already: true };
  if (mode === 'ptt') {
    const r = STT().openMicStop();
    // A segment cut off by the switch would otherwise leave an unsettled
    // capture at the head of the in-order queue, holding every later
    // transcript. Found by the repeated-interruption scenario.
    if (S.openBinding) S.order.abandon(S.openBinding.captureId);
    S.openBinding = null;
    S.micMode = 'ptt';
    if (S.state === 'LISTENING' && S.pending) go('CONFIRMING', 'mic-ptt');
    return { ok: true, mode, cutSegment: !!r.segmentInProgress };
  }
  try {
    await STT().openMicStart({
      workletUrl: chrome.runtime.getURL('offscreen/recorder-worklet.js'),
      params,
      onOnset: (info) => {
        // Wall-clock time of the onset, for the harness's phase locking.
        S.lastOnset = { perf: info.onsetPerf, ms: perfToMs(info.onsetPerf), rms: info.rms, threshold: info.threshold, n: (S.lastOnset?.n || 0) + 1 };
        (S.onsets ||= []).push(S.lastOnset.ms); if (S.onsets.length > 8) S.onsets.shift();
        if (!S.fields.length) return;                    // no session: ignore room noise
        const bi = bargeIn({ source: 'vad', onsetPerf: info.onsetPerf, receivedPerf: info.receivedPerf });
        // Speech starting while a transcript is still in whisper is the
        // double-interrupt case; it is counted so the harness can see it.
        if (S.order.pendingCount > 0) S.metrics.doubleInterrupts++;
        S.openBinding = bindInterrupted(openCapture('vad', { rms: info.rms, threshold: info.threshold }), bi);
        if (['PROMPTING', 'CONFIRMING'].includes(S.state)) go('LISTENING', 'vad-onset');
      },
      onSegment: async (seg) => {
        const binding = S.openBinding; S.openBinding = null;
        if (!binding) return;
        if (['LISTENING', 'CONFIRMING'].includes(S.state)) go('TRANSCRIBING', 'vad-end');
        let r;
        if (S.sttProvider === 'webspeech' && S.liveTurn) { S.liveTurn.stop(); r = await S.liveTurn.promise; S.liveTurn = null; }
        else r = await STT().transcribeSegment(seg, { backendUrl: sttUrl(), proxyToken: backendCfg.proxyToken });
        await finishCapture(binding, r);
      },
    });
    S.micMode = 'open';
    return { ok: true, mode };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

/* --------------------------------------------- conversational intent ----- */
//
// Interpretation, never execution. This runs AFTER bargeIn has already stopped
// the audio (at VAD onset, synchronously, with no transcript in existence yet),
// so nothing here can be on the audio-stop path however slow it is.
//
//   resumePolicy  ->  shouldConsult  ->  [ordinals | provider]  ->  validate
//                                                                      |
//                             a decision in the SAME vocabulary the switch
//                             below already executes, or the original one.

function intentUrl() {
  const url = new URL(backendCfg.backendUrl);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = '/intent';
  return url.toString();
}

const INTENT_HTTP_TIMEOUT_MS = 4000;   // outer bound; the backend has its own

async function askProvider(context) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), INTENT_HTTP_TIMEOUT_MS);
  const t0 = performance.now();
  try {
    const r = await fetch(intentUrl(), {
      method: 'POST', signal: ac.signal,
      headers: { 'content-type': 'application/json', 'x-vf-token': backendCfg.proxyToken || '' },
      body: JSON.stringify(context),
    });
    const j = await r.json().catch(() => null);
    return { ...(j || { ok: false, error: `http ${r.status}` }), httpMs: +(performance.now() - t0).toFixed(0) };
  } catch (e) {
    return { ok: false, error: String(e?.name === 'AbortError' ? 'timeout' : (e?.message || e)), httpMs: +(performance.now() - t0).toFixed(0) };
  } finally { clearTimeout(timer); }
}

/**
 * A decision that arrived after the world moved on is not executed. The turn
 * machinery already drops stale transcripts; this is the same rule applied to
 * the interpretation of one, because the provider round trip is the window in
 * which a second interruption can land.
 */
function stillCurrent(binding, field, pendingKey) {
  if (S.epoch !== binding.epoch) return 'stale-epoch';
  if ((currentField()?.id ?? null) !== (field?.id ?? null)) return 'field-moved';
  const now = S.pending ? `${S.pending.fieldId}:${S.pending.value}` : null;
  if (now !== pendingKey) return 'confirmation-moved';
  return null;
}

/* ------------------------------------------------ personal voice memory --- */
//
// The profile is data, never authority. It can propose a value the recogniser
// keeps getting wrong; the deterministic validator, the field's own shape and
// the read-back all still stand between that proposal and the DOM.

/** Load a profile (from storage, via the service worker) and wire it to Rime. */
function setProfile(raw) {
  const M = MEM();
  if (!M) return null;
  S.profile = M.sanitize(raw);
  // Pronunciation: the user's dictionary layered over the global one. Whether
  // the phoneme form or the respelling is used depends on the Rime model, and
  // that is decided in VFPromptFlagSink from what the proxy reports.
  try { NORM().setUserPronunciations(M.pronunciationMap(S.profile)); } catch {}
  return S.profile;
}

/** chrome.storage lives in the service worker; this document only asks. */
function saveProfile() {
  try { chrome.runtime.sendMessage({ type: 'VF_MEMORY_PUT', profile: S.profile })?.catch?.(() => {}); } catch {}
}

/**
 * The confirmation gate.
 *
 * A correction is remembered only when the user has said yes to the corrected
 * value, and only when EXACTLY ONE correction stood between the transcript that
 * was wrong and the value that was accepted. Two corrections in a row means the
 * person was still deciding, and a profile entry built out of that fires
 * silently on every later turn with no way for them to see it.
 */
function learnFromAccept(pending) {
  const M = MEM(), L = S.learn;
  S.learn = null;
  if (!M || !L || !S.profile) return null;
  if (L.fieldId !== pending.fieldId || L.steps !== 1) return null;
  const r = M.learn(S.profile, { observed: L.observed, canonical: String(pending.value ?? ''), context: L.intent });
  if (!r.learned) return null;
  S.profile = r.profile;
  S.metrics.intent.learned.push({ context: L.intent, at: Date.now() });
  if (S.metrics.intent.learned.length > 20) S.metrics.intent.learned.shift();
  try { NORM().setUserPronunciations(M.pronunciationMap(S.profile)); } catch {}
  saveProfile();
  return r.profile;
}

/** Wire the pure layer to this session: the ledger, the clock, and the proxy. */
async function consultIntent(decision, ctx, binding) {
  const I = INTENT(), C = CORE();
  if (!I) return null;
  const m = S.metrics.intent;
  const pendingKey = binding.pendingKey ?? (ctx.pending ? `${ctx.pending.fieldId}:${ctx.pending.value}` : null);
  return I.consult(decision, {
    ...ctx,
    field: { ...ctx.field, currentValue: ctx.pending?.value ?? S.filled[ctx.field.id] ?? null },
    interrupted: !!binding.interrupted && !!ctx.heardText,
    state: S.state, turnId: S.turnId, epoch: S.epoch, ledger: S.ledger.last(6),
    profile: S.profile,
  }, {
    optionsHeard: C.optionsHeard,
    stillCurrent: () => stillCurrent(binding, ctx.field, pendingKey),
    askProvider: async (context) => {
      const r = await askProvider(context);
      if (r.ms != null) { m.providerMs.push(r.ms); if (m.providerMs.length > 60) m.providerMs.shift(); }
      return r;
    },
    metric: (name, detail) => {
      if (name === 'skipped' || name === 'consultedWhy') { m[name][detail] = (m[name][detail] || 0) + 1; return; }
      if (name === 'rejected') { m.rejected.push({ why: detail, at: Date.now() }); if (m.rejected.length > 30) m.rejected.shift(); return; }
      m[name] = (m[name] || 0) + 1;
    },
  });
}

/* ------------------------------------------------------------- the loop -- */

/**
 * Every transcript - push-to-talk, open mic, or injected by the harness -
 * arrives here, in capture order, one at a time. If audio is playing when a
 * transcript is acted on, the user has spoken over it: it is stopped first,
 * so an injected transcript takes exactly the barge-in path a spoken one does.
 */
async function processTranscript(binding, transcript) {
  const N = NORM();
  const C = CORE();
  if (S.turn && ['sent', 'playing', 'done'].includes(S.turn.status)) {
    const bi = bargeIn({ source: binding.source === 'inject' ? 'inject' : 'late-transcript' });
    if (!binding.interrupted) bindInterrupted(binding, bi);
  }
  if (S.fields.length && !['TRANSCRIBING'].includes(S.state)) {
    if (S.state === 'READY') go('PROMPTING', 'transcript-with-fields'); // never happens with a field selected; keeps the table honest
    go('TRANSCRIBING', `transcript:${binding.source}`);
  }
  S.lastTranscript = transcript;

  const field = currentField();
  const intent = field ? intentOf(field) : null;
  let decision = C.resumePolicy(
    { parseCommand: N.parseCommand, parseYesNo: N.parseYesNo, fromSpeech: N.fromSpeech, matchOption: N.matchOption },
    { transcript, binding, epoch: S.epoch, pending: S.pending, field, intent,
      options: field?.options || [], heardText: binding.interrupted?.heardText || '' });

  // The conversational layer gets a look before anything is executed. It may
  // only ever return a decision from the vocabulary below - it cannot reach the
  // DOM, the machine, or the audio path, all of which live past this switch.
  const policyCtx = { transcript, binding, epoch: S.epoch, pending: S.pending, field, intent,
                      options: field?.options || [], heardText: binding.interrupted?.heardText || '' };
  let conversational = null;
  try { conversational = await consultIntent(decision, policyCtx, binding); }
  catch { S.metrics.intent.providerFailures++; }
  if (conversational) decision = conversational;

  const base = { transcript, captureId: binding.captureId, decision: decision.action, interrupted: binding.interrupted || null, via: decision.via || 'deterministic' };
  // What STT heard and what was done with it - the evidence a judge asks for.
  (S.transcripts ||= []).push({ captureId: binding.captureId, source: binding.source, transcript, decision: decision.action, value: decision.ex?.value ?? null, via: decision.via || 'deterministic', interrupted: binding.interrupted?.kind ?? null, seconds: S.lastStt?.seconds ?? null, sttMs: S.lastStt?.ms ?? null, at: Date.now() });
  if (S.transcripts.length > 30) S.transcripts.shift();

  switch (decision.action) {
    case 'drop':
      S.metrics.droppedTranscripts.push({ captureId: binding.captureId, reason: decision.reason, transcript, boundField: binding.fieldId, currentField: field?.id ?? null, at: Date.now() });
      restoreAfterNoop();
      return { ...base, ok: false, dropped: decision.reason };

    case 'command':
      return { ...base, ...(await runCommand(decision.command, transcript)) };

    case 'accept': {
      const p = S.pending;
      S.pending = null;
      S.attempts[p.fieldId] = 0;
      // The one point at which a correction is known to have been RIGHT.
      learnFromAccept(p);
      return { ...base, ...(await move(+1, 'accepted')), accepted: p.value };
    }

    case 'reject': {
      const p = S.pending;
      S.pending = null;
      S.learn = null;
      await speak(`Let's try that again.`, { kind: 'info', fieldId: p.fieldId, why: 'reject', interrupt: true });
      await speakCurrent({ interrupt: false, why: 'reject' });
      return { ...base, ok: true, rejected: true, fieldId: p.fieldId };
    }

    case 'correction': {
      const p = S.pending;
      const f = S.fields.find(x => x.id === p.fieldId) || field;
      S.pending = null;
      // A second correction on the same field abandons the chain: what the
      // recogniser first heard is no longer evidence about anything.
      if (S.learn && S.learn.fieldId === p.fieldId) S.learn.steps++;
      else S.learn = null;
      return { ...base, ...(await fillAndConfirm(f, p.intent, decision.ex, transcript)), corrected: true };
    }

    case 'reconfirm':
      await speakReadback(S.pending, 'reconfirm', `Sorry - ${pauseToken(200)}I have ${S.pending.spoken}. ${pauseToken(300)}Is that correct? Say yes or no.`);
      return { ...base, ok: false, error: 'not a yes or no' };

    case 'ambiguous':
      await speak(`Did you mean ${decision.ex.best}, ${pauseToken(300)}or ${decision.ex.runnerUp}?`, { kind: 'prompt', fieldId: field.id, why: 'ambiguous' });
      return { ...base, ok: false, ambiguous: true, options: [decision.ex.best, decision.ex.runnerUp] };

    case 'options-remaining': {
      // The list was cut off and nothing said matched. Continue it from where
      // it stopped - the question itself is not asked again.
      const names = decision.remaining.map(o => o.text).filter(Boolean).slice(0, PROMPTS().MAX_SPOKEN_OPTIONS);
      const more = decision.remaining.length - names.length;
      const text = `The other options are: ${pauseToken(200)}${names.join(`, ${pauseToken(400)}`)}.${more > 0 ? ` ${pauseToken(300)}And ${more} more.` : ''}`;
      await speak(text, { kind: 'options', fieldId: field.id, why: 'options-remaining' });
      return { ...base, ok: false, optionsRemaining: decision.remaining.map(o => o.text) };
    }

    // The interpretation was genuinely ambiguous. Asking is the correct outcome
    // and nothing is written - but it still COUNTS. A question that spends no
    // attempt is a question with no end: a microphone producing gibberish had
    // the field asking forever instead of being skipped, because clarify sat
    // outside the error-recovery cap that failAttempt enforces.
    case 'clarify': {
      if (!field) { await speak(decision.question, { kind: 'info', why: 'clarify' }); return { ...base, ok: false, clarifying: true }; }
      S.attempts[field.id] = (S.attempts[field.id] || 0) + 1;
      if (S.attempts[field.id] >= MAX_ATTEMPTS) {
        await speak(`I'm still not sure what you meant. ${pauseToken(300)}I'll skip this one - you can come back to it.`,
                    { kind: 'error', fieldId: field.id, why: 'clarify-skip' });
        return { ...base, ...(await move(+1, 'clarify-skip')), clarifying: false, skipped: true };
      }
      await speak(decision.question, { kind: 'prompt', fieldId: field.id, why: 'clarify', interrupt: true });
      return { ...base, ok: false, clarifying: true, question: decision.question, attempts: S.attempts[field.id] };
    }

    case 'unusable':
      if (!field) { await speak('There is no field selected. Say start to begin.', { kind: 'info', why: 'no-field' }); return { ...base, ok: false, error: 'no field' }; }
      return { ...base, ...(await failAttempt(field, decision.ex?.note || 'I could not use that', transcript)) };

    case 'answer':
      S.answered[field.id] = true;
      // What the recogniser produced for this field, kept only until the turn
      // resolves. If a single correction follows and is then accepted, this is
      // the misrecognition worth remembering; anything else discards it.
      // Only a value the RECOGNISER produced is evidence about the recogniser.
      // An answer the profile, the ordinal resolver or the spelling assembler
      // built is not a misrecognition worth remembering.
      S.learn = ['memory', 'ordinal', 'spelling', 'casing', 'spelling+casing'].includes(decision.via) ? null
        : { fieldId: field.id, intent, observed: transcript, steps: 0 };
      return { ...base, ...(await fillAndConfirm(field, intent, decision.ex, transcript)), viaHeard: !!decision.viaHeard };

    default:
      return { ...base, ok: false, error: `unhandled decision ${decision.action}` };
  }
}

/** A dropped transcript changes nothing; put the state back where the dialog is. */
function restoreAfterNoop() {
  if (S.state !== 'TRANSCRIBING') return;
  if (S.turn) return;
  if (S.pending) go('CONFIRMING', 'noop'); else if (currentField()) go('LISTENING', 'noop'); else go('READY', 'noop');
}

async function fillAndConfirm(field, intent, ex, transcript) {
  const N = NORM();
  go('FILLING', 'write');
  const w = await writeToPage(field.id, field.type, ex.value);

  if (!w?.ok) return failAttempt(field, w?.error || 'the page would not accept that value', transcript);

  // F2.7: the page gets the last word on whether the value is acceptable.
  if (w.valid === false) {
    S.attempts[field.id] = (S.attempts[field.id] || 0) + 1;
    const reason = String(w.reason || 'that value was not accepted').replace(/\s+/g, ' ').slice(0, 120);
    if (S.attempts[field.id] >= MAX_ATTEMPTS) {
      await speak(`${reason}. ${pauseToken(300)}I'll leave this one for now and come back to it.`, { kind: 'error', fieldId: field.id, why: 'invalid-skip' });
      return move(+1, 'invalid-skip');
    }
    await speak(`${reason}. ${pauseToken(300)}Let's try again.`, { kind: 'error', fieldId: field.id, why: 'invalid' });
    await speakCurrent({ interrupt: false, why: 'invalid' });
    return { ok: false, invalid: true, reason, attempts: S.attempts[field.id] };
  }

  S.filled[field.id] = ex.value;
  S.answered[field.id] = true;

  const mustConfirm = N.isHighRisk(intent) || ex.needsConfirmation;
  if (!mustConfirm) {
    await speak(`Got it.`, { kind: 'info', fieldId: field.id, why: 'filled', interrupt: false });
    return move(+1, 'filled');
  }

  // Read back what is ACTUALLY in the field, not what we meant to write.
  const actual = w.current != null && String(w.current).length ? String(w.current) : String(ex.value);
  const spoken = N.toSpeech(actual, intent) || String(ex.display ?? actual);
  S.pending = { value: ex.value, actual, display: ex.display ?? actual, intent, fieldId: field.id, spoken };
  await speakReadback(S.pending, 'confirm');
  return { ok: true, confirming: true, value: ex.value, actual, spoken };
}

/** "Let me read that back" - measured 10/10 against 6/10 for "Got it" (PHASE2.md). */
function speakReadback(p, why, text) {
  return speak(text || `Let me read that back. ${pauseToken(300)}${p.spoken}. ${pauseToken(400)}Is that correct?`,
               { kind: 'confirm', fieldId: p.fieldId, why, interrupt: why !== 'confirm' });
}

async function failAttempt(field, note, transcript) {
  S.attempts[field.id] = (S.attempts[field.id] || 0) + 1;
  if (S.attempts[field.id] >= MAX_ATTEMPTS) {
    await speak(`I'm still not getting that. ${pauseToken(300)}I'll skip this one - you can come back to it.`, { kind: 'error', fieldId: field.id, why: 'failed-skip' });
    return move(+1, 'failed-skip');
  }
  await speak(`Sorry, I didn't get that.`, { kind: 'error', fieldId: field.id, why: 'failed', interrupt: true });
  await speakCurrent({ interrupt: false, why: 'failed' });
  return { ok: false, error: note, transcript, attempts: S.attempts[field.id] };
}

/* ---------------------------------------------------------- commands F2.6 */

async function runCommand(command, transcript) {
  const field = currentField();
  switch (command) {
    case 'repeat':   await speakCurrent({ why: 'repeat' }); return { ok: true, command };
    case 'next':     return { command, ...(await move(+1, 'next')) };
    case 'previous': return { command, ...(await move(-1, 'previous')) };
    case 'stop':     Q.length = 0; abortWaits(); stopAudio('command'); S.pending = null;
                     await speak('Stopped.', { kind: 'info', why: 'stop' }); return { ok: true, command };
    case 'skip':
      if (field) S.attempts[field.id] = 0;
      S.pending = null;
      await speak('Skipped.', { kind: 'info', fieldId: field?.id, why: 'skip', interrupt: true });
      return { command, ...(await move(+1, 'skip')) };
    case 'readback': {
      if (!field) { await speak('Nothing is selected.', { kind: 'info', why: 'readback' }); return { ok: true, command }; }
      const r = await readFromPage(field.id);
      const cur = r?.current;
      if (cur === null || cur === undefined || cur === '') {
        await speak(`${field.label || 'This field'} is empty.`, { kind: 'info', fieldId: field.id, why: 'readback' });
      } else {
        const spoken = NORM().toSpeech(String(cur), intentOf(field)) || String(cur);
        await speak(`${field.label || 'This field'} contains ${pauseToken(200)}${spoken}.`, { kind: 'info', fieldId: field.id, why: 'readback' });
      }
      return { ok: true, command, current: cur };
    }
    case 'help':
      await speak(`Say your answer, ${pauseToken(200)}or say repeat, ${pauseToken(200)}next, ${pauseToken(200)}back, ${pauseToken(200)}skip, ${pauseToken(200)}or what did you enter.`, { kind: 'info', why: 'help' });
      return { ok: true, command };
    default:
      return { ok: false, error: `unknown command ${command}` };
  }
}

/* -------------------------------------------------------------- session --- */

function currentField() {
  return S.index >= 0 && S.index < S.fields.length ? S.fields[S.index] : null;
}

function requestFocus(field) {
  if (!field) return;
  try { chrome.runtime.sendMessage({ type: 'VF_FOCUS_FIELD', fieldId: field.id, index: S.index, tabId: S.tabId }); } catch {}
}

// Reasons a prompt may legitimately be spoken for a field that already has an
// answer. Anything else is a RE-ASK - the failure the PRD forbids - and is
// counted, never hidden.
const REASK_OK = new Set(['repeat', 'reject', 'invalid', 'failed', 'previous', 'next', 'skip', 'start', 'nav']);

async function speakCurrent({ withPosition = true, interrupt = true, why = 'nav' } = {}) {
  const f = currentField();
  if (!f) return { ok: false, error: 'no current field' };
  if ((S.answered[f.id] || S.pending?.fieldId === f.id || S.order.inFlightFor(f.id)) && !REASK_OK.has(why)) {
    S.metrics.reasks++;
    S.metrics.reaskDetail.push({ fieldId: f.id, why, at: Date.now() });
  }
  requestFocus(f);
  const prompt = PROMPTS().promptFor(f);
  const text = withPosition ? `${PROMPTS().positionFor(S.index, S.fields.length)} ${prompt}` : prompt;
  const r = await speak(text, { kind: 'prompt', fieldId: f.id, why, interrupt });
  return { ...r, field: f, prompt: text };
}

async function sessionStart({ fields, tabId, backend, speakSummary = true, profile }) {
  if (backend) backendCfg = { ...backendCfg, ...backend };
  if (profile !== undefined) setProfile(profile);
  S.epoch += 1;
  S.fields = Array.isArray(fields) ? fields : [];
  S.tabId = tabId ?? S.tabId;
  S.index = S.fields.length ? 0 : -1;
  // Frame counters are NOT reset here: they are monotonic for the life of the
  // document so a harness can take deltas across a session restart.
  S.contextsSeen = {};
  S.pending = null; S.attempts = {}; S.filled = {}; S.answered = {}; S.lastTranscript = null; S.lastStt = null;
  S.learn = null;
  S.reconnect.attempts = 0;

  const ok = await connect();
  if (!ok) return { ok: false, error: S.lastError || 'backend not reachable', fieldCount: S.fields.length };

  if (!S.fields.length) {
    await speak(PROMPTS().summaryFor([]), { kind: 'info', why: 'start' });
    return { ok: true, fieldCount: 0, spoke: 'empty-form' };
  }
  if (speakSummary) {
    // Two separate utterances - one short question per flush keeps `clear`
    // useful and matches how the ear parses it.
    await speak(PROMPTS().summaryFor(S.fields), { kind: 'info', why: 'start', interrupt: true });
  }
  const r = await speakCurrent({ interrupt: !speakSummary, why: 'start' });
  return { ok: true, fieldCount: S.fields.length, index: S.index, prompt: r.prompt, field: r.field };
}

async function move(delta, why = 'nav') {
  if (!S.fields.length) return { ok: false, error: 'no fields' };
  const next = S.index + delta;
  if (next < 0) { await speak('That was the first field.', { kind: 'info', why }); return { ok: true, index: S.index, edge: 'start' }; }
  if (next >= S.fields.length) { await speak('That was the last field.', { kind: 'info', why }); return { ok: true, index: S.index, edge: 'end' }; }
  S.index = next;
  const r = await speakCurrent({ why: ['accepted', 'filled', 'invalid-skip', 'failed-skip'].includes(why) ? 'nav' : why });
  return { ok: true, index: S.index, prompt: r.prompt, field: r.field };
}

/** Replace the field list after a DOM mutation without losing the user's place. */
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

function stopSession() {
  Q.length = 0; abortWaits();
  const t = stopAudio('stop');
  if (t && ['sent', 'playing', 'done'].includes(t.status)) { t.status = 'cancelled'; t.stop = { reason: 'session stopped', source: 'system', playedSec: playedSecondsOf(t) }; ledgerEntry(t); settleEnd(t, 'stopped'); }
  try { if (S.micMode === 'ptt') STT().releaseMic(); } catch {}
  S.order.abandonAll('session-stop');
  S.listening = false; S.ptt = null; S.openBinding = null; S.pending = null; S.learn = null;
  S.epoch += 1;
  S.index = -1; S.fields = [];
  if (S.reconnect.timer) { clearTimeout(S.reconnect.timer); S.reconnect.timer = null; }
  go(S.connected ? 'READY' : 'IDLE', 'stop');
}

function snapshot() {
  const f = currentField();
  const t = S.turn;
  const m = S.metrics;
  const lat = m.stopSamples.filter(s => s.stopLatencyMs !== null && s.hadAudio).map(s => s.stopLatencyMs).sort((a, b) => a - b);
  const pct = (p) => lat.length ? lat[Math.min(lat.length - 1, Math.floor(p * (lat.length - 1) + 0.5))] : null;
  return {
    ok: true,
    state: S.state, connected: S.connected, provider: S.provider,
    turnId: S.turnId, contextId: S.contextId, epoch: S.epoch,
    index: S.index, total: S.fields.length,
    field: f ? { id: f.id, label: f.label, type: f.type, required: f.required, labelSource: f.labelSource, optionCount: f.optionCount } : null,
    playedSeconds: +playedSeconds().toFixed(3),
    utterance: t ? { id: t.id, kind: t.kind, status: t.status, chunks: t.chunks, bytes: t.bytes, scheduledSec: +t.clock.audioScheduledSec.toFixed(2), text: t.text, started: t.clock.startedAt !== null } : null,
    lastWordTimestampCount: S.lastWordTimestamps?.words?.length ?? 0,
    droppedStaleChunks: S.droppedStaleChunks, orphanChunks: S.orphanChunks, noTurnChunks: S.noTurnChunks,
    playedChunks: S.playedChunks, rawChunkFrames: S.rawChunkFrames, contextsSeen: S.contextsSeen,
    prewarmed: S.prewarmed, lastError: S.lastError, wsUrl: S.wsUrl,
    sttProvider: S.sttProvider, listening: S.listening, micMode: S.micMode, micLevel: STT().micLevel(),
    // `spoken` is the exact string the read-back says. Exposed because the
    // ledger only records an utterance once it FINISHES, so anything asserting
    // on what was read back was racing the speech.
    pending: S.pending ? { display: S.pending.display, intent: S.pending.intent, fieldId: S.pending.fieldId, value: S.pending.value, spoken: S.pending.spoken } : null,
    lastTranscript: S.lastTranscript, lastSttError: S.lastStt?.error ?? null, lastSttMs: S.lastStt?.ms ?? null, lastSttSeconds: S.lastStt?.seconds ?? null,
    attempts: S.attempts, filled: S.filled, filledCount: Object.keys(S.filled).length, answered: S.answered,
    queue: Q.length, capturesInFlight: S.order.pendingCount, capturesSwept: S.order.swept,
    machine: { state: S.state, illegal: S.machine.illegal, illegalCount: S.machine.illegalCount, history: S.machine.history.slice(-12) },
    ledger: S.ledger.last(14),
    metrics: { ...m, stopSamples: m.stopSamples.slice(-40), stopLatencyN: lat.length, stopLatencyP50: pct(0.5), stopLatencyP95: pct(0.95), stopLatencyMax: lat.length ? lat[lat.length - 1] : null },
    reconnect: { attempts: S.reconnect.attempts, lostAt: S.reconnect.lostAt, restoredAt: S.reconnect.restoredAt },
    intent: { ...m.intent, providerMs: m.intent.providerMs.slice(-20) },
    // The personal profile, in full. It is local to this machine and contains
    // only vocabulary the user confirmed - no digits, no addresses, no field
    // answers - so there is nothing here to redact and a great deal to debug.
    memory: S.profile ? { ...S.profile, pendingLearn: S.learn ? { fieldId: S.learn.fieldId, steps: S.learn.steps } : null } : null,
    lastOnset: S.lastOnset || null, onsets: S.onsets || [], transcripts: (S.transcripts || []).slice(-12),
    turnAudioStartMs: t && t.clock.startedAt !== null ? perfToMs(ctxTimeToPerf(t.clock.startedAt)) : null,
    nowPerf: performance.now(), nowMs: Date.now(),
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
      resolve({ ok: true, startLatencyMs, playCallMs: Math.round(afterPlayCall), playedMs: Math.round(performance.now() - t0 - startLatencyMs),
                durationSec: el.duration, audioContextState: c.state, endedCleanly: why === 'ended' });
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
        // The service worker owns chrome.storage; the profile arrives and
        // leaves through it. OFF_PROFILE also lets the harness seed one.
        case 'OFF_PROFILE':
          if (msg.profile !== undefined) setProfile(msg.profile);
          respond({ ok: true, profile: S.profile });
          break;
        case 'OFF_NEXT':           respond(await move(+1, 'next')); break;
        case 'OFF_PREV':           respond(await move(-1, 'previous')); break;
        case 'OFF_REPEAT':         respond(await speakCurrent({ why: 'repeat' })); break;
        case 'OFF_SPEAK':          respond(await speak(msg.text, { kind: msg.kind || 'info', why: 'manual' })); break;
        case 'OFF_UPDATE_FIELDS':  respond(updateFields(msg.fields)); break;
        case 'OFF_STATE':          respond(snapshot()); break;
        case 'OFF_LEDGER':         respond({ ok: true, ledger: S.ledger.entries, metrics: S.metrics, machine: { illegal: S.machine.illegal, history: S.machine.history } }); break;
        case 'OFF_LISTEN_START':   respond(await listenStart()); break;
        case 'OFF_LISTEN_STOP':    respond(await listenStop()); break;
        case 'OFF_SET_MIC_MODE':   respond(await setMicMode(msg.mode, msg.params)); break;
        // A transcript from outside the microphone (the harness). It takes the
        // same path as speech: if Rime is talking, it is a barge-in.
        case 'OFF_TRANSCRIPT': {
          const bi = bargeIn({ source: 'inject' });
          const binding = bindInterrupted(openCapture('inject'), bi);
          if (['PROMPTING', 'CONFIRMING'].includes(S.state)) go('LISTENING', 'inject');
          respond(await S.order.settle(binding.captureId, String(msg.text ?? '')));
          break;
        }
        // Barge-in without speech content - the harness's controlled trigger
        // for the delayed-frame tests. Counted under source 'inject'.
        case 'OFF_BARGEIN':        respond({ ok: true, ...bargeIn({ source: 'inject' }) }); break;
        case 'OFF_REC_START':      await ensureMonitor(); respond(recStart()); break;
        case 'OFF_REC_DUMP':       respond(await recDump()); break;
        case 'OFF_SET_STT':        S.sttProvider = msg.provider === 'webspeech' ? 'webspeech' : 'backend';
                                   respond({ ok: true, provider: S.sttProvider }); break;
        case 'OFF_STOP':
          stopSession();
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
globalThis.VFPromptFlagSink = (enabled, phonemes = false) => {
  if (globalThis.VFPrompts) globalThis.VFPrompts.setPauseEnabled(enabled);
  // The read-back's digit groups carry the same tokens; on Coda they must be
  // commas too, or every pair costs a fixed 0.9 s of silence.
  if (globalThis.VFNormalize) {
    globalThis.VFNormalize.setPauseEnabled(enabled);
    // And the same guard for pronunciation braces: on a model that ignores
    // phonemizeBetweenBrackets, "{ˈɑːrnəv}" is spoken as its characters.
    globalThis.VFNormalize.setPhonemesEnabled(phonemes);
  }
};

console.log('[VoiceFill] offscreen document loaded (Phase 3)');
