// PRD Phase 3 exit criterion, measured for real:
//
//   "stop latency p95 < 300 ms across 20 interruptions; 0 stale-audio
//    playbacks; 0 re-asks; double-interrupt resolves to last instruction."
//
// Everything here is the real chain: real Rime audio through the proxy, real
// speech at the (fake-device) microphone, the real energy detector in the
// AudioWorklet, the real stop, the real heard ledger, real whisper, the real
// DOM. The one substitution is the one Phase 2 documented: Chrome's fake audio
// device plays ONE file, looping, chosen at launch. So the interrupting speech
// is a Rime-synthesised utterance placed in a mostly-silent loop, and a
// scenario that needs different words relaunches Chrome with a different file.
//
// Phase locking: the file loops with a known period, and every burst the
// detector hears is reported with its wall-clock time. The harness predicts
// the next burst and starts the prompt so the burst lands at the phase it
// wants - just after the first word, mid-sentence, near the end. The phase
// actually achieved is read back from the playback clock, never assumed.
//
// Stop latency = from the first microphone block above threshold to the last
// non-silent block rendered to the output (an AudioWorklet tap on the
// destination), or to the stop call returning - whichever is LATER. It does
// not include hardware ADC/DAC latency, which a fake device cannot exhibit;
// Chrome's reported outputLatency is recorded alongside.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { loadEnv } from '../scripts/probe/lib/env.mjs';
loadEnv();
import WebSocket from 'ws';
import vm from 'node:vm';
import { pcmToWav, sttAvailable, sttConfig } from '../backend/stt.mjs';
import { launchChrome, CDP, newPage, unpackedExtensionId } from './cdp.mjs';

// The product's own digit parser, so "what STT heard" is judged the way the
// product judges it ("one six zero" and "1-6-0" are the same digits).
const NCTX = vm.createContext({ console }); NCTX.globalThis = NCTX;
vm.runInContext(fs.readFileSync('extension/shared/normalize.js', 'utf8'), NCTX, { filename: 'normalize.js' });
const heardDigits = (t) => NCTX.VFNormalize.wordsToDigits(String(t || '').toLowerCase());

const args = process.argv.slice(2);
const argOf = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const RUNS = Number(argOf('--runs', 20));
const ONLY = (argOf('--only', '') || '').split(',').filter(Boolean);
const P95_BUDGET_MS = 300;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const results = [];
const rec = (name, ok, detail) => { results.push({ name, ok, detail: String(detail ?? '').slice(0, 400) }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got: ${String(detail ?? '').slice(0, 300)}`}`); return ok; };
const info = (s) => console.log(`        ${s}`);

if (!sttAvailable()) { console.error('BLOCKED: set WHISPER_MODEL to a ggml model file.'); process.exit(2); }

/* ------------------------------------------------------- Rime synthesis ---- */

const RATE = 48000;   // Chrome's fake capture device wants 48 kHz mono
function synth(text) {
  return new Promise((resolve, reject) => {
    const u = new URL(process.env.RIME_WS_URL);
    u.searchParams.set('speaker', process.env.RIME_SPEAKER);
    u.searchParams.set('modelId', process.env.RIME_MODEL_ID || 'coda');
    u.searchParams.set('audioFormat', 'pcm'); u.searchParams.set('lang', 'eng');
    u.searchParams.set('samplingRate', String(RATE)); u.searchParams.set('segment', 'never');
    const ws = new WebSocket(u.toString(), { headers: { Authorization: `Bearer ${process.env.RIME_API_KEY}` } });
    const parts = []; let done = false;
    const fin = () => { if (done) return; done = true; try { ws.close(); } catch {} resolve(Buffer.concat(parts)); };
    ws.on('open', () => { ws.send(JSON.stringify({ text, contextId: 'a' })); ws.send(JSON.stringify({ operation: 'flush' })); });
    ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.type === 'chunk') parts.push(Buffer.from(m.data, 'base64')); if (/^done$/i.test(m.type || '')) fin(); });
    ws.on('error', reject);
    setTimeout(fin, 40000);
  });
}
const silence = (sec) => Buffer.alloc(Math.round(sec * RATE) * 2);
function synthAt16k(text) {
  return new Promise((resolve, reject) => {
    const u = new URL(process.env.RIME_WS_URL);
    u.searchParams.set('speaker', process.env.RIME_SPEAKER); u.searchParams.set('modelId', process.env.RIME_MODEL_ID || 'coda');
    u.searchParams.set('audioFormat', 'pcm'); u.searchParams.set('lang', 'eng'); u.searchParams.set('samplingRate', '16000'); u.searchParams.set('segment', 'never');
    const ws = new WebSocket(u.toString(), { headers: { Authorization: `Bearer ${process.env.RIME_API_KEY}` } });
    const parts = []; let done = false;
    const fin = () => { if (done) return; done = true; try { ws.close(); } catch {} resolve(Buffer.concat(parts)); };
    ws.on('open', () => { ws.send(JSON.stringify({ text, contextId: 'a' })); ws.send(JSON.stringify({ operation: 'flush' })); });
    ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.type === 'chunk') parts.push(Buffer.from(m.data, 'base64')); if (/^done$/i.test(m.type || '')) fin(); });
    ws.on('error', reject); setTimeout(fin, 40000);
  });
}
const secOf = (pcm) => pcm.length / 2 / RATE;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-bargein-'));
const UTT = {
  answer: 'one six zero zero seven one',
  yes: 'yes',
  correction: "no, it's one six zero zero seven two",
  correction2: 'no, one six zero zero seven three',
  // A short isolated word is where whisper is weakest (Phase 2: utterance-initial
  // clipping); a carrier phrase is how a person would answer anyway.
  cardiology: "I'd like cardiology",
  neurology: "I'll take neurology",
  nonsense: 'purple elephants',
};
console.log('\nSynthesising interruption speech with Rime…');
const PCM = {};
for (const [k, text] of Object.entries(UTT)) { PCM[k] = await synth(text); info(`${k.padEnd(12)} "${text}"  ${secOf(PCM[k]).toFixed(2)}s`); }

/** A looping WAV: parts are numbers (seconds of silence) or utterance keys. Returns { path, periodSec, bursts:[{atSec, durSec, key}] }. */
function loopWav(name, parts) {
  const bufs = [], bursts = [];
  let t = 0;
  for (const p of parts) {
    if (typeof p === 'number') { bufs.push(silence(p)); t += p; }
    else { bursts.push({ atSec: t, durSec: secOf(PCM[p]), key: p }); bufs.push(PCM[p]); t += secOf(PCM[p]); }
  }
  const pcm = Buffer.concat(bufs);
  const file = path.join(TMP, `${name}.wav`);
  fs.writeFileSync(file, pcmToWav(pcm, RATE));
  return { path: file, periodSec: secOf(pcm), bursts };
}

/* -------------------------------------------------------------- backend --- */

const PORT = Number(process.env.PORT || 8787);
let backend = null, backendLog = '';
async function startBackend() {
  backend = spawn(process.execPath, ['backend/server.mjs'], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  backend.stdout.on('data', d => backendLog += d); backend.stderr.on('data', d => backendLog += d);
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/health`); if (r.ok) return true; } catch {} await sleep(200); }
  return false;
}
const reap = () => { try { backend?.kill('SIGKILL'); } catch {} };
process.on('exit', reap);
process.on('uncaughtException', (e) => { reap(); console.error(e); process.exit(1); });
if (!await startBackend()) { console.error('backend did not start\n' + backendLog); process.exit(2); }

// whisper loads a 1.5 GB model per invocation; the first call after a cold page
// cache took long enough to be mistaken for a lost transcript. Warm it once.
{
  const t0 = Date.now();
  const url = new URL(`http://127.0.0.1:${PORT}/stt`); if (process.env.PROXY_TOKEN) url.searchParams.set('token', process.env.PROXY_TOKEN);
  const pcm16 = await synthAt16k(UTT.answer);
  const j = await (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'x-vf-rate': '16000' }, body: pcm16 })).json().catch(() => ({}));
  info(`whisper warm-up: ${Date.now() - t0}ms  -> ${JSON.stringify(j.text)}`);
}

const srv = http.createServer((req, res) => {
  const f = path.join('eval/fixtures', decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, ''));
  if (!fs.existsSync(f) || !fs.statSync(f).isFile()) { res.statusCode = 404; return res.end('no'); }
  res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(fs.readFileSync(f));
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const FPORT = srv.address().port;

const EXT_SRC = path.resolve('extension');
const EXT = path.resolve('artifacts/phase3-bargein-extension');
fs.rmSync(EXT, { recursive: true, force: true });
fs.cpSync(EXT_SRC, EXT, { recursive: true });
{
  const mf = path.join(EXT, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
  m.host_permissions = [...(m.host_permissions || []), 'http://127.0.0.1:*/*', 'http://localhost:*/*'];
  fs.writeFileSync(mf, JSON.stringify(m, null, 2));
}

/* --------------------------------------------------------------- chrome --- */

// BARGEIN_HEADFUL=1 runs the same harness in a visible Chrome on the real audio
// device, so the "including sink buffer" column carries the real hardware's
// outputLatency instead of the headless fake sink's 216 ms. It plays Rime
// through the speakers; the fake microphone file is still the interrupter.
const HEADFUL = !!process.env.BARGEIN_HEADFUL;
async function launch(wav, fixture) {
  const chrome = await launchChrome({
    headless: !HEADFUL, extensionPath: EXT,
    extraArgs: ['--disable-features=AudioServiceOutOfProcess,AudioServiceSandbox',
                '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
                `--use-file-for-fake-audio-capture=${wav.path}`],
  });
  const cdp = await new CDP(chrome.browserWsUrl).connect();
  const extId = unpackedExtensionId(EXT);
  for (let i = 0; i < 40; i++) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    if (targetInfos.some(t => t.url.startsWith(`chrome-extension://${extId}/`))) break;
    await sleep(250);
  }
  const formPage = await newPage(cdp);
  await formPage.goto(`http://127.0.0.1:${FPORT}/${fixture}`, { waitMs: 900 });
  const popup = await newPage(cdp);
  await popup.goto(`chrome-extension://${extId}/popup/popup.html`, { waitMs: 700 });
  await popup.eval(`chrome.storage.local.set({ backendUrl:'ws://localhost:${PORT}/speak', proxyToken:${JSON.stringify(process.env.PROXY_TOKEN || '')} })`, { awaitPromise: true });
  const send = (m) => popup.eval(`chrome.runtime.sendMessage(${JSON.stringify(m)})`, { awaitPromise: true });
  const tabs = await popup.eval(`chrome.tabs.query({}).then(t=>t.map(x=>({id:x.id,url:x.url||''})))`, { awaitPromise: true });
  const tab = tabs.find(t => t.url.includes(fixture));
  await send({ type: 'VF_SET_STT', provider: 'backend' });
  await send({ type: 'VF_CONNECT' });
  await sleep(1800);   // prewarm
  const h = {
    chrome, cdp, popup, formPage, send, tabId: tab.id, wav,
    state: () => send({ type: 'VF_STATE' }),
    ledger: () => send({ type: 'VF_LEDGER' }),
    form: () => formPage.eval('window.__formState()'),
    async waitFor(pred, timeoutMs = 8000, pollMs = 40) {
      const end = Date.now() + timeoutMs;
      let s;
      while (Date.now() < end) { s = await h.state(); if (s?.ok && pred(s)) return s; await sleep(pollMs); }
      return null;
    },
    async openMic() { const r = await send({ type: 'VF_SET_MIC_MODE', mode: 'open' }); if (!r?.ok) throw new Error('open mic failed: ' + r?.error); return r; },
    /** Wait until enough bursts have been heard to know where the loop is (two, if the file has more than one burst). */
    async sync(timeoutMs = 40000) {
      const need = wav.bursts.length > 1 ? 2 : 1;
      const s = await h.waitFor(x => (x.onsets || []).length >= need, timeoutMs, 60);
      if (!s) throw new Error('never heard enough bursts from the fake device');
      return s.lastOnset;
    },
    /**
     * Wall-clock ms of the next onset of burst `burstIndex`, at least
     * `minAheadMs` from now. With several bursts per loop, which one the latest
     * onset belonged to is identified by the gap since the one before it -
     * the gaps inside the file are all different from each other.
     */
    async nextBurst(minAheadMs = 1500, burstIndex = 0) {
      const s = await h.state();
      const on = s.onsets || [s.lastOnset.ms];
      const P = wav.periodSec * 1000;
      let lastIdx = 0;
      if (wav.bursts.length > 1 && on.length >= 2) {
        const gap = on.at(-1) - on.at(-2);
        // expected gap ending at burst k = at[k] - at[k-1] (wrapping around the loop)
        const gaps = wav.bursts.map((b, k) => { const prev = wav.bursts[(k - 1 + wav.bursts.length) % wav.bursts.length]; let g = (b.atSec - prev.atSec) * 1000; if (g <= 0) g += P; return g; });
        lastIdx = gaps.map((g, k) => [Math.abs(g - gap), k]).sort((a, b) => a[0] - b[0])[0][1];
      }
      const lastAt = wav.bursts[lastIdx].atSec * 1000, wantAt = wav.bursts[burstIndex].atSec * 1000;
      let t = on.at(-1) + (wantAt - lastAt);
      while (t < Date.now() + minAheadMs) t += P;
      return t;
    },
    async close() { try { cdp.close(); } catch {} try { await chrome.close(); } catch {} },
  };
  return h;
}
const until = async (ms) => { const d = ms - Date.now(); if (d > 0) await sleep(d); };
const DIGIT_WORD = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
/** The read-back's rendering of a digit string, pause tokens stripped: "one six, zero zero, seven two". */
const N_toSpeechDigits = (d) => { const w = [...d].map(c => DIGIT_WORD[+c] ?? c); const g = []; for (let i = 0; i < w.length; i += 2) g.push(w.slice(i, i + 2).join(' ')); return g.join(', '); };
const dump = (s) => (s?.ledger || []).map(e => `${e.turnId}:${e.kind}:${e.status}:${e.why || ''}:${(e.display || e.text || '').replace(/<\d+> /g, '').slice(0, 40)}`);

/* ================================================================ SECTION 1 */
/* 20+ real interruptions of the PIN prompt at controlled phases.             */

const runs = [];
async function latencyRuns() {
  console.log(`\n── Section 1: ${RUNS} real interruptions of a prompt (fake-device speech, VAD, real stop) ──`);
  const wav = loopWav('answer', [8.0, 'answer', 0.5]);     // one burst every ~9.7s
  const h = await launch(wav, '11_bargein.html');
  try {
    await h.openMic();
    await h.sync();
    info(`burst period ${wav.periodSec.toFixed(2)}s, first onset seen; phase-locking`);
    // Target phases as FRACTIONS of the prompt's length (measured from the first
    // run's ledger; 2.3s until then): just after the first word, a quarter in,
    // mid-sentence, and twice in the last third. Absolute targets beyond the
    // prompt's end land in LISTENING and are answered, not interrupted.
    const PHASE_FRACS = [0.08, 0.08, 0.3, 0.5, 0.65, 0.8];   // two early targets: phase-lock jitter is ±0.2s
    let promptSec = 2.3;
    let lead = 720;                                          // ms from VF_SESSION_START to first audible sample; adapted
    let attempts = 0;
    while (runs.filter(r => r.hadAudio).length < RUNS && attempts < RUNS * 2) {
      attempts++;
      await h.send({ type: 'VF_STOP' });
      await sleep(150);
      const before = await h.state();
      const phi = +(PHASE_FRACS[(attempts - 1) % PHASE_FRACS.length] * promptSec).toFixed(2);
      const burst = await h.nextBurst(1800);
      const sendAt = burst - phi * 1000 - lead;
      await until(sendAt);
      const sentMs = Date.now();
      h.send({ type: 'VF_SESSION_START', tabId: h.tabId, speakSummary: false }).catch(() => {});
      const bBefore = before.metrics.bargeIns;
      const s1 = await h.waitFor(x => x.metrics.bargeIns > bBefore, (burst - Date.now()) + 3500, 30);
      if (!s1) { info(`run ${attempts}: no barge-in observed (burst predicted ${burst - sentMs}ms after start)`); continue; }
      // The measurement is filled in ~150ms after the stop by the output monitor.
      const s2 = await h.waitFor(x => { const smp = x.metrics.stopSamples.at(-1); return smp && smp.stopLatencyMs !== null; }, 1500, 30) || s1;
      const smp = s2.metrics.stopSamples.at(-1);
      const led = s2.ledger.find(e => e.turnId === smp.turnId) || {};
      // Now the answer: whisper -> fill -> read-back.
      const s3 = await h.waitFor(x => x.pending || x.metrics.reasks > before.metrics.reasks || (x.ledger.some(e => e.kind === 'error' && e.turnId > smp.turnId)) || x.metrics.droppedTranscripts.length > before.metrics.droppedTranscripts.length, 25000, 80);
      const form = await h.form();
      const st = s3 || await h.state();
      const promptsAfter = st.ledger.filter(e => e.fieldId === led.fieldId && (e.kind === 'prompt') && e.turnId > smp.turnId);
      if (led.audioStartMs && led.sentMs) lead = Math.round(lead * 0.5 + (led.audioStartMs - sentMs) * 0.5);
      if (led.speechSec > 1) promptSec = led.speechSec;
      const r = {
        run: attempts, targetPhase: phi, phase: smp.playedSec, phaseFrac: (led.speechSec || smp.totalSec) ? +(smp.playedSec / (led.speechSec || smp.totalSec)).toFixed(2) : null, promptSec: led.speechSec || smp.totalSec, hadAudio: smp.hadAudio, kind: smp.kind,
        stopLatencyMs: smp.stopLatencyMs, stopLatencyIncSinkMs: smp.stopLatencyIncSinkMs, detectToRenderSilentMs: smp.detectToRenderSilentMs, detectToSilentMs: smp.detectToSilentMs, detectToStopCallMs: smp.detectToStopCallMs,
        onsetToReceiveMs: smp.onsetToReceiveMs, alreadySilent: smp.alreadySilent, outputLatencyMs: smp.outputLatencyMs,
        heard: led.display, heardCount: led.heard?.heardCount ?? null, totalWords: led.heard?.total ?? null, heardKnown: led.heard?.known ?? null,
        ttfaMs: led.ttfaMs, staleDropped: st.droppedStaleChunks - before.droppedStaleChunks,
        staleAudio: st.metrics.staleAudioEvents - before.metrics.staleAudioEvents,
        reasks: st.metrics.reasks - before.metrics.reasks, promptReaskTurns: promptsAfter.length,
        transcript: st.lastTranscript, sttMs: st.lastSttMs, segmentSec: st.lastSttSeconds, vadSegments: st.transcripts.filter(t => t.at > before.nowMs && t.source === 'vad').map(t => `${t.seconds}s:${JSON.stringify(t.transcript)}`),
        pending: st.pending?.value ?? null, dom: form.postcode,
        // "Landed" = the value STT heard is what was filled and is being read
        // back. Exact 160071 is whisper's accuracy (Phase 2's metric), reported alongside.
        heardDigits: heardDigits(st.lastTranscript),
        filledCorrectly: !!st.pending && st.pending.value === heardDigits(st.lastTranscript) && form.postcode === st.pending.value && st.pending.value.length >= 4,
        exact: form.postcode === '160071' && st.pending?.value === '160071',
        illegal: st.machine.illegalCount, state: st.state, disconnects: st.metrics.disconnects,
      };
      runs.push(r);
      info(`run ${String(attempts).padStart(2)}: phase ${r.phase.toFixed(2)}s (target ${phi})  stop ${r.stopLatencyMs}ms (+sink ${r.stopLatencyIncSinkMs}ms)  heard ${r.heardCount}/${r.totalWords} "${(r.heard || '').slice(0, 48)}"  stale ${r.staleDropped} dropped/${r.staleAudio} played  fill ${r.filledCorrectly ? (r.exact ? 'ok' : `as heard (${r.dom})`) : 'MISS(' + r.dom + '|' + r.transcript + ')'}  seg ${r.vadSegments.join(' ')}  reask ${r.reasks}`);
    }
    await h.send({ type: 'VF_STOP' });
  } finally { await h.close(); }

  const audible = runs.filter(r => r.hadAudio && r.stopLatencyMs !== null);
  const lat = audible.map(r => r.stopLatencyMs).sort((a, b) => a - b);
  const latSink = audible.map(r => r.stopLatencyIncSinkMs).filter(x => x != null).sort((a, b) => a - b);
  const q = (arr, p) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(p * (arr.length - 1) + 0.5))] : null;
  const stats = {
    n: audible.length, p50: q(lat, 0.5), p95: q(lat, 0.95), max: lat.at(-1) ?? null, min: lat[0] ?? null,
    sinkP50: q(latSink, 0.5), sinkP95: q(latSink, 0.95), sinkMax: latSink.at(-1) ?? null,
    outputLatencyMs: audible.find(r => r.outputLatencyMs != null)?.outputLatencyMs ?? null,
    silentP50: q(audible.map(r => r.detectToSilentMs).filter(x => x != null).sort((a, b) => a - b), 0.5),
    silentP95: q(audible.map(r => r.detectToSilentMs).filter(x => x != null).sort((a, b) => a - b), 0.95),
    stopCallP50: q(audible.map(r => r.detectToStopCallMs).sort((a, b) => a - b), 0.5),
    stopCallP95: q(audible.map(r => r.detectToStopCallMs).sort((a, b) => a - b), 0.95),
    staleAudio: runs.reduce((n, r) => n + r.staleAudio, 0), staleDropped: runs.reduce((n, r) => n + r.staleDropped, 0),
    reasks: runs.reduce((n, r) => n + r.reasks, 0), promptReaskTurns: runs.reduce((n, r) => n + r.promptReaskTurns, 0),
    filled: runs.filter(r => r.filledCorrectly).length, exact: runs.filter(r => r.exact).length, preAudio: runs.filter(r => !r.hadAudio).length,
    heardKnown: audible.filter(r => r.heardKnown).length, illegal: Math.max(0, ...runs.map(r => r.illegal)),
    disconnects: runs.at(-1)?.disconnects ?? 0, sttMsMedian: (() => { const a = runs.map(r => r.sttMs).filter(x => x != null).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : null; })(),
    phases: { early: audible.filter(r => r.phaseFrac < 0.25).length, mid: audible.filter(r => r.phaseFrac >= 0.25 && r.phaseFrac < 0.6).length, late: audible.filter(r => r.phaseFrac >= 0.6).length },
  };
  console.log('');
  rec(`S1: ${RUNS}+ interruptions with real audio stopped`, stats.n >= RUNS, `n=${stats.n} (pre-audio bursts: ${stats.preAudio})`);
  rec(`S1: stop latency p95 < ${P95_BUDGET_MS}ms (pipeline: onset -> last block rendered)`, stats.p95 !== null && stats.p95 < P95_BUDGET_MS, `p50 ${stats.p50}ms  p95 ${stats.p95}ms  max ${stats.max}ms  (to-stop-call p95 ${stats.stopCallP95}ms)`);
  rec(`S1: stop latency p95 < ${P95_BUDGET_MS}ms even including this device's output sink buffer (${stats.outputLatencyMs}ms)`, stats.sinkP95 !== null && stats.sinkP95 < P95_BUDGET_MS, `p50 ${stats.sinkP50}ms  p95 ${stats.sinkP95}ms  max ${stats.sinkMax}ms`);
  rec('S1: zero stale audio played after any interruption', stats.staleAudio === 0, `${stats.staleAudio} events; ${stats.staleDropped} stale chunks were dropped before decode`);
  rec('S1: zero re-asks of an answered field', stats.reasks === 0 && stats.promptReaskTurns === 0, `reask counter ${stats.reasks}, prompt turns after answer ${stats.promptReaskTurns}`);
  rec('S1: heard ledger known for every audible interruption', stats.heardKnown === stats.n, `${stats.heardKnown}/${stats.n}`);
  rec('S1: heard words grow with the phase (ledger tracks the clock)', (() => {
    const e = audible.filter(r => r.phaseFrac < 0.25), l = audible.filter(r => r.phaseFrac >= 0.6);
    if (!e.length || !l.length) return true;
    const avg = a => a.reduce((n, r) => n + r.heardCount, 0) / a.length;
    return avg(l) > avg(e);
  })(), `early avg ${(audible.filter(r => r.phaseFrac < 0.25).reduce((n, r) => n + r.heardCount, 0) / Math.max(1, stats.phases.early)).toFixed(1)} words, late avg ${(audible.filter(r => r.phaseFrac >= 0.6).reduce((n, r) => n + r.heardCount, 0) / Math.max(1, stats.phases.late)).toFixed(1)} words`);
  rec('S1: phases covered - just after start (first quarter), mid-sentence, near the end (last 40%)', stats.phases.early >= 2 && stats.phases.mid >= 2 && stats.phases.late >= 2, JSON.stringify(stats.phases));
  rec('S1: the interrupting speech became the answer - filled and read back as heard - in ≥ 90% of runs', stats.filled >= Math.ceil(runs.length * 0.9), `${stats.filled}/${runs.length} landed as heard; exact 160071 in ${stats.exact}/${runs.length}; misses: ${JSON.stringify(runs.filter(r => !r.filledCorrectly).map(r => `run ${r.run}: seg ${r.vadSegments.join(' ')} pending=${r.pending}`))}`);
  rec('S1: zero illegal state transitions', stats.illegal === 0, `${stats.illegal}`);
  return stats;
}

/* ================================================================ SECTION 2 */
/* Scenarios, each with its own interrupting speech.                          */

const scenarios = {};

/** Shared opening: start the session right after a burst so the prompt plays undisturbed, then inject the answer so the read-back is playing when the next burst lands. */
async function primeConfirmation(h, wav, readbackPhaseSec = 1.2) {
  // Start the session right after the LAST burst of the loop, so the prompt
  // plays in the quiet stretch before the first burst comes round again.
  const lastIdx = wav.bursts.length - 1;
  const burst0 = await h.nextBurst(400, lastIdx);
  await until(burst0 + wav.bursts[lastIdx].durSec * 1000 + 700);
  await h.send({ type: 'VF_SESSION_START', tabId: h.tabId, speakSummary: false });
  await h.waitFor(x => x.state === 'LISTENING', 9000);
  const burst = await h.nextBurst(2500);
  await until(burst - 700 - readbackPhaseSec * 1000);
  const before = await h.state();
  await h.send({ type: 'VF_TRANSCRIPT', text: UTT.answer });
  return { before, burst };
}

scenarios.confirmYes = async () => {
  console.log('\n── S2a: confirmation read-back interrupted by "yes" ──');
  const wav = loopWav('yes', [7.0, 'yes', 0.5]);
  const h = await launch(wav, '11_bargein.html');
  try {
    await h.openMic(); await h.sync();
    const { before } = await primeConfirmation(h, wav);
    const s1 = await h.waitFor(x => x.metrics.bargeIns > before.metrics.bargeIns, 6000, 30);
    rec('S2a: the read-back was interrupted', !!s1, 'no barge-in seen');
    const turn = s1?.ledger.find(e => e.status === 'interrupted' && e.kind === 'confirm');
    rec('S2a: the interrupted turn is the confirmation, ledger knows what was heard', !!turn && turn.heard?.known, JSON.stringify(turn?.display));
    const s2 = await h.waitFor(x => !x.pending && x.index === 1, 12000, 60);
    const form = await h.form();
    rec('S2a: "yes" accepted the value and moved on', !!s2 && form.postcode === '160071', `state=${s2?.state} index=${s2?.index} dom=${form.postcode} transcript=${JSON.stringify(s2?.lastTranscript ?? (await h.state()).lastTranscript)}`);
    const st = await h.state();
    rec('S2a: no re-ask, no stale audio, no illegal transition', st.metrics.reasks === 0 && st.metrics.staleAudioEvents === 0 && st.machine.illegalCount === 0, JSON.stringify({ reasks: st.metrics.reasks, stale: st.metrics.staleAudioEvents, illegal: st.machine.illegalCount }));
    info(`heard before the yes: ${turn?.display}`);
    return { heard: turn?.display, transcript: st.lastTranscript, sample: st.metrics.stopSamples.at(-1), ledger: dump(st), ledgerAtBargeIn: dump(s1) };
  } finally { await h.close(); }
};

scenarios.confirmCorrection = async () => {
  console.log('\n── S2b: confirmation read-back interrupted by a correction ──');
  const wav = loopWav('correction', [7.0, 'correction', 0.5]);
  const h = await launch(wav, '11_bargein.html');
  try {
    await h.openMic(); await h.sync();
    const { before } = await primeConfirmation(h, wav);
    const s1 = await h.waitFor(x => x.metrics.bargeIns > before.metrics.bargeIns, 6000, 30);
    rec('S2b: the read-back was interrupted', !!s1, 'no barge-in seen');
    const s2 = await h.waitFor(x => x.pending && x.pending.value === '160072', 12000, 60);
    const form = await h.form();
    rec('S2b: the correction replaced the value and is being read back', !!s2 && form.postcode === '160072', `pending=${JSON.stringify((s2 || await h.state()).pending)} dom=${form.postcode} transcript=${JSON.stringify((await h.state()).lastTranscript)}`);
    const st = await h.state();
    // The new read-back is usually still PLAYING here, so it is the current
    // utterance rather than a ledger entry yet.
    const readbacks = st.ledger.filter(e => e.kind === 'confirm').concat(st.utterance?.kind === 'confirm' ? [{ text: st.utterance.text, status: st.utterance.status }] : []);
    rec('S2b: a NEW read-back for 160072 was spoken; the field prompt was not', readbacks.some(e => /seven two/.test(e.text)) && st.metrics.reasks === 0 && !st.ledger.some(e => e.kind === 'prompt' && e.turnId > (s1?.ledger.find(x => x.status === 'interrupted')?.turnId || 0)), `confirm turns: ${readbacks.map(e => `${e.status}:` + e.text.replace(/<\d+> /g, '').slice(23, 60)).join(' | ')}`);
    rec('S2b: no stale audio, no illegal transition', st.metrics.staleAudioEvents === 0 && st.machine.illegalCount === 0, JSON.stringify({ stale: st.metrics.staleAudioEvents, illegal: st.machine.illegalCount }));
    return { transcript: st.lastTranscript, pending: st.pending?.value, dom: form.postcode };
  } finally { await h.close(); }
};

scenarios.doubleInterrupt = async () => {
  console.log('\n── S2c: the correction is interrupted again (double interrupt), 5 trials ──');
  // Burst A: correction to 160072.  Burst B, ~4.7s later: correction to 160073,
  // timed to land inside the read-back of 160072. The PRD's evidence table asks
  // for this "_ / 5", so five trials in one browser, reset between them.
  const wav = loopWav('double', [7.0, 'correction', 4.7, 'correction2', 6.0]);
  const h = await launch(wav, '11_bargein.html');
  const trials = [];
  try {
    await h.openMic(); await h.sync();
    for (let k = 1; k <= 5; k++) {
      await h.send({ type: 'VF_STOP' }); await sleep(200);
      const { before } = await primeConfirmation(h, wav);
      const s1 = await h.waitFor(x => x.metrics.bargeIns > before.metrics.bargeIns, 8000, 30);
      const s2 = s1 && await h.waitFor(x => x.metrics.bargeIns > before.metrics.bargeIns + 1, 12000, 30);
      // Settle: the second capture transcribed and acted on, nothing in flight.
      const s3 = s2 && await h.waitFor(x => x.capturesInFlight === 0 && x.transcripts.filter(t => t.at > before.nowMs && t.source === 'vad').length >= 2, 20000, 80);
      const st = await h.state();
      const form = await h.form();
      const vad = st.transcripts.filter(t => t.at > before.nowMs && t.source === 'vad' && t.decision !== 'abandoned' && t.decision !== 'drop');
      const last = vad.at(-1);
      const lastValue = last?.value ?? null;
      const confirms = st.ledger.filter(e => e.kind === 'confirm' && e.turnId > (before.turnId || 0)).sort((a, b) => a.turnId - b.turnId);
      const digits = (e) => (/seven one/.test(e.text) ? '160071' : /seven two/.test(e.text) ? '160072' : /seven three/.test(e.text) ? '160073' : e.text.replace(/<\d+> /g, '').replace(/^Let me read that back\. /, '').split('.')[0]);
      const t = {
        trial: k, bargeIns: st.metrics.bargeIns - before.metrics.bargeIns, transcripts: vad.map(v => `${JSON.stringify(v.transcript)}->${v.decision}:${v.value}`),
        finalPending: st.pending?.value ?? null, dom: form.postcode,
        resolvedToLast: !!last && lastValue !== null && form.postcode === String(lastValue) && (st.pending?.value === String(lastValue) || !st.pending),
        exact: form.postcode === '160073',
        order: confirms.map(e => `${e.status}:${digits(e)}`).concat(st.utterance?.kind === 'confirm' ? [`${st.utterance.status}:(current)`] : []),
        // The final read-back is usually still PLAYING at this point, so it is
        // the current utterance rather than a ledger entry.
        orderOk: confirms.length >= 2 && digits(confirms[0]) === '160071' && confirms[0].status === 'interrupted'
                 && confirms[1].status === 'interrupted' && vad[0] && confirms[1].text.replace(/<\d+> /g, '').includes(N_toSpeechDigits(String(vad[0].value)))
                 && (confirms.length >= 3 || st.utterance?.kind === 'confirm' || st.queue > 0 || !st.pending),
        orderDebug: { v0: vad[0]?.value ?? null, want: vad[0] ? N_toSpeechDigits(String(vad[0].value)) : null, c1: confirms[1]?.text?.replace(/<\d+> /g, '') ?? null, c1status: confirms[1]?.status ?? null, n: confirms.length, cur: st.utterance?.kind ?? null },
        reasks: st.metrics.reasks, stale: st.metrics.staleAudioEvents, illegal: st.machine.illegalCount, illegalDetail: st.machine.illegal,
        disconnects: st.metrics.disconnects, reconnects: st.metrics.reconnects,
        failed: st.ledger.filter(e => e.status === 'failed' && e.turnId > (before.turnId || 0)).map(e => `${e.kind}:${e.stop?.reason}`),
        abandoned: st.transcripts.filter(t => t.at > before.nowMs && t.decision === 'abandoned').length,
      };
      trials.push(t);
      info(`trial ${k}: barge-ins ${t.bargeIns}  heard ${t.transcripts.join(' | ')}  final ${t.dom}${t.exact ? '' : ' (STT variance)'}  order ${t.order.join(' > ')}${t.orderOk ? '' : `  ORDER? ${JSON.stringify(t.orderDebug)}`}${t.abandoned ? `  abandoned captures ${t.abandoned}` : ''}${t.disconnects ? `  DISCONNECTS ${t.disconnects} failed=${JSON.stringify(t.failed)}` : ''}${t.illegal ? `  ILLEGAL ${JSON.stringify(t.illegalDetail)}` : ''}`);
    }
    const resolved = trials.filter(t => t.resolvedToLast).length, exact = trials.filter(t => t.exact).length;
    rec('S2c: both interruptions landed in every trial', trials.every(t => t.bargeIns >= 2), trials.map(t => t.bargeIns).join(','));
    rec('S2c: double interrupt resolved to the LAST instruction as heard, 5 / 5', resolved === 5, `${resolved}/5 (exact 160073 in ${exact}/5; the rest are whisper digit drops the read-back exists to catch)`);
    rec('S2c: read-backs in order - 160071 interrupted, the first correction (as heard) interrupted, then the final value', trials.every(t => t.orderOk), trials.map(t => t.order.join('>')).join(' ; '));
    rec('S2c: no re-ask, no stale audio, no illegal transition across 5 trials', trials.every(t => t.reasks === 0 && t.stale === 0 && t.illegal === 0), JSON.stringify(trials.map(t => [t.reasks, t.stale, t.illegal])));
    if (trials.some(t => t.disconnects)) info(`proxy log: ${backendLog.split('\n').filter(l => /\[proxy\]/.test(l)).slice(-6).join(' | ')}`);
    return { trials, resolved, exact, disconnects: trials.at(-1)?.disconnects ?? 0 };
  } finally { await h.close(); }
};

async function optionsScenario(key, phaseSec, check) {
  const wav = loopWav(`opt-${key}`, [8.0, key, 0.5]);
  const h = await launch(wav, '12_bargein_options.html');
  try {
    await h.openMic(); await h.sync();
    const lead = 1000;                                   // observed in section 1: ~1s from VF_SESSION_START to first audible sample
    const burst = await h.nextBurst(2500);
    await until(burst - phaseSec * 1000 - lead);
    const before = await h.state();
    h.send({ type: 'VF_SESSION_START', tabId: h.tabId, speakSummary: false }).catch(() => {});
    const s1 = await h.waitFor(x => x.metrics.bargeIns > before.metrics.bargeIns, (burst - Date.now()) + 3500, 30);
    if (!s1) { rec(`S2 options/${key}: list interrupted`, false, 'no barge-in'); return null; }
    const turn = s1.ledger.find(e => e.status === 'interrupted');
    info(`heard: ${turn?.display}`);
    const s2 = await h.waitFor(x => x.ledger.some(e => e.turnId > turn.turnId && (e.kind === 'options' || e.kind === 'confirm' || e.kind === 'info' || e.kind === 'error' || e.kind === 'prompt')), 12000, 60) || await h.state();
    const st = await h.state();
    const form = await h.form();
    return check({ h, turn, st, form, heard: turn?.heard?.heardText || '' });
  } finally { await h.close(); }
}

scenarios.optionsHeard = async () => {
  console.log('\n── S2d: option list cut off; the user names an option they HEARD ──');
  return optionsScenario('cardiology', 4.4, ({ turn, st, form, heard }) => {
    const heardIt = /cardiology/i.test(heard);
    rec('S2d: list interrupted after Cardiology was spoken', heardIt, `heard: ${turn?.display}`);
    rec('S2d: Cardiology selected in the DOM', form.dept === 'card', `dept=${form.dept} transcript=${JSON.stringify(st.lastTranscript)}`);
    const reprompt = st.ledger.filter(e => e.turnId > turn.turnId && e.kind === 'prompt' && e.fieldId === turn.fieldId);
    rec('S2d: the question was not asked again', reprompt.length === 0 && st.metrics.reasks === 0, `${reprompt.length} re-prompts`);
    return { heard: turn?.display, dept: form.dept, transcript: st.lastTranscript };
  });
};

scenarios.optionsUnheard = async () => {
  console.log('\n── S2e: option list cut off; the user names an option NOT yet heard ──');
  return optionsScenario('neurology', 4.4, ({ turn, st, form, heard }) => {
    rec('S2e: Neurology had not been spoken when interrupted', !/neurology/i.test(heard), `heard: ${turn?.display}`);
    rec('S2e: Neurology still selected (the user may know the form)', form.dept === 'neur', `dept=${form.dept} transcript=${JSON.stringify(st.lastTranscript)}`);
    rec('S2e: ...but confirmed, because it was not audible', !!st.pending || st.ledger.some(e => e.kind === 'confirm' && e.turnId > turn.turnId), `pending=${JSON.stringify(st.pending)}`);
    const reprompt = st.ledger.filter(e => e.turnId > turn.turnId && e.kind === 'prompt' && e.fieldId === turn.fieldId);
    rec('S2e: the question was not asked again', reprompt.length === 0 && st.metrics.reasks === 0, `${reprompt.length} re-prompts`);
    return { heard: turn?.display, dept: form.dept, transcript: st.lastTranscript };
  });
};

scenarios.optionsNone = async () => {
  console.log('\n── S2f: option list cut off; nothing said matches ──');
  return optionsScenario('nonsense', 4.4, ({ turn, st, form, heard }) => {
    const cont = st.ledger.find(e => e.turnId > turn.turnId && e.kind === 'options');
    rec('S2f: the list is CONTINUED with the unheard options', !!cont, `turns after: ${st.ledger.filter(e => e.turnId > turn.turnId).map(e => e.kind + ':' + e.text.replace(/<\d+> /g, '').slice(0, 50)).join(' | ')}`);
    const heardOpts = ['Cardiology', 'Dermatology', 'Neurology', 'Orthopaedics', 'Paediatrics', 'Radiology'].filter(o => new RegExp(o, 'i').test(heard));
    rec('S2f: the continuation omits the options already heard', !!cont && heardOpts.every(o => !new RegExp(o, 'i').test(cont.text)) && heardOpts.length > 0, `heard ${JSON.stringify(heardOpts)}; continuation: ${cont?.text.replace(/<\d+> /g, '')}`);
    const reprompt = st.ledger.filter(e => e.turnId > turn.turnId && e.kind === 'prompt' && e.fieldId === turn.fieldId);
    rec('S2f: the full question was not asked again', reprompt.length === 0 && st.metrics.reasks === 0, `${reprompt.length} re-prompts`);
    rec('S2f: nothing was written', form.dept === '', `dept=${form.dept}`);
    return { heard: turn?.display, continuation: cont?.text, transcript: st.lastTranscript };
  });
};

scenarios.repeated = async () => {
  console.log('\n── S2g: repeated interruptions every ~3.4s for 30s ──');
  const wav = loopWav('rapid', [3.2, 'answer', 0.3]);     // ~5.1s period: fast enough to pile up, slow enough that read-backs become audible
  const h = await launch(wav, '11_bargein.html');
  try {
    await h.openMic(); await h.sync();
    await h.send({ type: 'VF_SESSION_START', tabId: h.tabId, speakSummary: true });
    await sleep(30000);
    const st = await h.state();
    const lat = st.metrics.stopSamples.filter(s => s.hadAudio && s.stopLatencyMs !== null).map(s => s.stopLatencyMs);
    const preAudio = st.metrics.stopSamples.filter(s => !s.hadAudio).length;
    // One burst per loop period, minus the one that lands during session start.
    const expected = Math.max(3, Math.floor(30 / wav.periodSec) - 1);
    rec('S2g: many interruptions landed', st.metrics.bargeIns >= expected, `${st.metrics.bargeIns} barge-ins in 30s (period ${wav.periodSec.toFixed(1)}s, expected ≥ ${expected}; ${lat.length} on audible speech, ${preAudio} on a turn sent but not yet audible)`);
    rec('S2g: every audible stop under budget', lat.every(x => x < P95_BUDGET_MS), `max ${lat.length ? Math.max(...lat) : '—'}ms over ${lat.length} audible stops; ${preAudio} pre-audio interruptions cancelled before a sample played`);
    rec('S2g: no stale audio, no illegal transitions, no re-asks', st.metrics.staleAudioEvents === 0 && st.machine.illegalCount === 0 && st.metrics.reasks === 0, JSON.stringify({ stale: st.metrics.staleAudioEvents, illegal: st.machine.illegalCount, reasks: st.metrics.reasks, dropped: st.droppedStaleChunks, double: st.metrics.doubleInterrupts }));
    await h.send({ type: 'VF_SET_MIC_MODE', mode: 'ptt' });
    const settled = await h.waitFor(x => ['LISTENING', 'CONFIRMING', 'READY', 'PROMPTING'].includes(x.state) && x.capturesInFlight === 0, 15000, 100);
    rec('S2g: session is not wedged afterwards', !!settled, `state=${(settled || await h.state()).state} inflight=${(settled || await h.state()).capturesInFlight}`);
    const form = await h.form();
    info(`final: state ${st.state}, index ${st.index}, dom postcode=${form.postcode}, dropped stale chunks ${st.droppedStaleChunks}`);
    return { bargeIns: st.metrics.bargeIns, maxStop: Math.max(...lat, 0), dom: form.postcode };
  } finally { await h.close(); }
};

scenarios.sttAfterNavigation = async () => {
  console.log('\n── S2h: STT result arrives after the user has moved on (turn invalidated) ──');
  const wav = loopWav('answer2', [8.0, 'answer', 0.5]);
  const h = await launch(wav, '11_bargein.html');
  try {
    await h.openMic(); await h.sync();
    const burst = await h.nextBurst(2500);
    await until(burst - 1000 - 720);
    const before = await h.state();
    h.send({ type: 'VF_SESSION_START', tabId: h.tabId, speakSummary: false }).catch(() => {});
    const s1 = await h.waitFor(x => x.metrics.bargeIns > before.metrics.bargeIns, (burst - Date.now()) + 3500, 30);
    rec('S2h: prompt interrupted', !!s1, 'no barge-in');
    // The user changes their mind and moves on BEFORE whisper returns.
    await h.send({ type: 'VF_NEXT' });
    const s2 = await h.waitFor(x => x.metrics.droppedTranscripts.length > 0, 12000, 60);
    const st = await h.state();
    const form = await h.form();
    rec('S2h: the late transcript was dropped as superseded, not applied', !!s2 && st.metrics.droppedTranscripts.some(d => d.reason === 'superseded'), JSON.stringify(st.metrics.droppedTranscripts));
    rec('S2h: the abandoned field stayed empty and the session is on field 2', form.postcode === '' && st.index === 1, `postcode=${JSON.stringify(form.postcode)} index=${st.index}`);
    rec('S2h: no re-ask, no illegal transition', st.metrics.reasks === 0 && st.machine.illegalCount === 0, JSON.stringify({ reasks: st.metrics.reasks, illegal: st.machine.illegalCount }));
    return { dropped: st.metrics.droppedTranscripts };
  } finally { await h.close(); }
};

scenarios.reconnect = async () => {
  console.log('\n── S2i: backend dies mid-prompt; reconnect ──');
  const wav = loopWav('quiet', [20.0]);
  const h = await launch(wav, '11_bargein.html');
  try {
    await h.send({ type: 'VF_SESSION_START', tabId: h.tabId, speakSummary: true });
    await h.waitFor(x => x.utterance && x.utterance.started, 8000, 30);
    backend.kill('SIGKILL');
    const s1 = await h.waitFor(x => !x.connected, 6000, 50);
    rec('S2i: loss detected; the turn in flight is recorded as failed, not left playing', !!s1 && s1.ledger.some(e => e.status === 'failed' && e.stop?.reason === 'connection lost') && !s1.utterance, JSON.stringify({ connected: s1?.connected, state: s1?.state, last: s1?.ledger.at(-1)?.status, reason: s1?.ledger.at(-1)?.stop }));
    await sleep(1500);
    await startBackend();
    const s2 = await h.waitFor(x => x.connected && x.metrics.reconnects >= 1, 16000, 100);
    rec('S2i: reconnected automatically with backoff', !!s2, `reconnects=${(s2 || await h.state()).metrics.reconnects} attempts=${(s2 || await h.state()).reconnect.attempts}`);
    const s3 = await h.waitFor(x => x.ledger.some(e => e.text === 'Connection restored.' && (e.status === 'played' || e.status === 'playing' || e.status === 'done')), 8000, 100);
    rec('S2i: "Connection restored." spoken; the field was NOT re-asked', !!s3 && !s3.ledger.some(e => e.kind === 'prompt' && e.turnId > s1.ledger.at(-1).turnId), JSON.stringify((s3 || await h.state()).ledger.slice(-3).map(e => `${e.kind}:${e.status}`)));
    const played0 = (await h.state()).playedChunks;
    await h.send({ type: 'VF_REPEAT' });
    const s4 = await h.waitFor(x => x.playedChunks > played0, 8000, 50);
    rec('S2i: audio flows again on the new socket', !!s4, `playedChunks ${played0} -> ${(s4 || await h.state()).playedChunks}`);
    const st = await h.state();
    rec('S2i: no illegal transitions through disconnect and recovery', st.machine.illegalCount === 0, JSON.stringify(st.machine.illegal));
    return { disconnects: st.metrics.disconnects, reconnects: st.metrics.reconnects };
  } finally { await h.close(); }
};

/* =================================================================== run === */

const out = { runs: [], stats: null, scenarios: {} };
try {
  const want = (k) => !ONLY.length || ONLY.includes(k);
  if (want('latency')) out.stats = await latencyRuns();
  out.runs = runs;
  for (const [k, fn] of Object.entries(scenarios)) {
    if (!want(k)) continue;
    try { out.scenarios[k] = await fn(); }
    catch (e) { rec(`${k}: scenario completed without throwing`, false, e.stack || e.message); }
  }
} catch (e) {
  rec('harness completed without throwing', false, e.stack || String(e.message));
} finally {
  reap(); srv.close();
  fs.rmSync(TMP, { recursive: true, force: true });
}

const pass = results.filter(r => r.ok).length, fail = results.filter(r => !r.ok);
console.log(`\nPhase 3 barge-in - real Rime, real fake-device speech, real VAD, real STT (${path.basename(sttConfig().model)}), real DOM\n`);
for (const r of results) { console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`); if (!r.ok) console.log(`        got: ${r.detail}`); }
console.log(`\n  PASS ${pass}   FAIL ${fail.length}\n`);
fs.mkdirSync('artifacts', { recursive: true });
fs.writeFileSync('artifacts/phase3_bargein.json', JSON.stringify({ ...out, results, model: sttConfig().model, at: new Date().toISOString() }, null, 2));
process.exit(fail.length ? 1 : 0);
