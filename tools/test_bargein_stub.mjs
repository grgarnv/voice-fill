// PLUMBING - network conditions Rime will not produce on demand, driven through
// the REAL extension code (offscreen player, frame filter, clock, ledger):
//
//   * chunks delivered slower than realtime  -> gaps in the schedule; the
//     playback clock must not count the silence as heard words (clock drift)
//   * the timestamps frame arriving 1.5s late -> an interruption before it
//     lands must say "words unknown", then finalise when it arrives
//   * a long, out-of-order stale tail after `clear`, with its own late
//     timestamps and done -> nothing from it plays, nothing from it overwrites
//     the ledger, the stale done does not end the new turn
//
// The stub emits Rime's frame names (--rime-shape) so the code path is the
// shipped one. None of this is evidence about Rime; that is test_bargein.mjs.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadEnv } from '../scripts/probe/lib/env.mjs';
loadEnv({ quiet: true });
import { launchChrome, CDP, newPage, unpackedExtensionId } from './cdp.mjs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const results = [];
const rec = (name, ok, detail) => { results.push({ name, ok, detail: String(detail ?? '').slice(0, 400) }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got: ${String(detail ?? '').slice(0, 300)}`}`); return ok; };
const PORT = 8797;   // not 8787: the real suites may be using it

const kids = [];
const spawnKid = (args, env) => { const k = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } }); kids.push(k); let log = ''; k.stdout.on('data', d => log += d); k.stderr.on('data', d => log += d); k.log = () => log; return k; };
const reap = () => kids.forEach(k => { try { k.kill('SIGKILL'); } catch {} });
process.on('exit', reap);
process.on('uncaughtException', (e) => { reap(); console.error(e); process.exit(1); });

// Slow delivery: 50ms of audio every 120ms (network at 0.42x realtime), the
// timestamps frame 1.5s late, a 40-chunk stale tail with a tone in it.
const stub = spawnKid(['tools/loopback_ws_stub.mjs', '--rime-shape', '--chunk-ms', '120', '--chunk-audio-ms', '50', '--chunks', '24', '--ts-delay-ms', '1500', '--tail', '40', '--tail-spread-ms', '400', '--tone']);
await sleep(400);
const backend = spawnKid(['backend/server.mjs'], { PORT: String(PORT), RIME_WS_URL: 'ws://127.0.0.1:8799', RIME_API_KEY: 'rime_sk_PLACEHOLDER_NOT_REAL', PROXY_TOKEN: 'stubtest', RIME_SPEAKER: 'x' });
let up = false;
for (let i = 0; i < 40 && !up; i++) { try { up = (await fetch(`http://127.0.0.1:${PORT}/health`)).ok; } catch {} if (!up) await sleep(150); }
if (!up) { console.error('backend did not start\n' + backend.log()); process.exit(2); }

const srv = http.createServer((req, res) => {
  const f = path.join('eval/fixtures', decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, ''));
  if (!fs.existsSync(f)) { res.statusCode = 404; return res.end('no'); }
  res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(fs.readFileSync(f));
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const FPORT = srv.address().port;

const EXT = path.resolve('artifacts/phase3-stub-extension');
fs.rmSync(EXT, { recursive: true, force: true });
fs.cpSync(path.resolve('extension'), EXT, { recursive: true });
{ const mf = path.join(EXT, 'manifest.json'); const m = JSON.parse(fs.readFileSync(mf, 'utf8')); m.host_permissions = [...(m.host_permissions || []), 'http://127.0.0.1:*/*', 'http://localhost:*/*']; fs.writeFileSync(mf, JSON.stringify(m, null, 2)); }

const chrome = await launchChrome({ headless: true, extensionPath: EXT, extraArgs: ['--disable-features=AudioServiceOutOfProcess,AudioServiceSandbox'] });
const cdp = await new CDP(chrome.browserWsUrl).connect();
const extId = unpackedExtensionId(EXT);
for (let i = 0; i < 40; i++) { const { targetInfos } = await cdp.send('Target.getTargets'); if (targetInfos.some(t => t.url.startsWith(`chrome-extension://${extId}/`))) break; await sleep(250); }
const formPage = await newPage(cdp);
await formPage.goto(`http://127.0.0.1:${FPORT}/11_bargein.html`, { waitMs: 800 });
const popup = await newPage(cdp);
await popup.goto(`chrome-extension://${extId}/popup/popup.html`, { waitMs: 700 });
await popup.eval(`chrome.storage.local.set({ backendUrl:'ws://localhost:${PORT}/speak', proxyToken:'stubtest' })`, { awaitPromise: true });
const send = (m) => popup.eval(`chrome.runtime.sendMessage(${JSON.stringify(m)})`, { awaitPromise: true });
const state = () => send({ type: 'VF_STATE' });
const waitFor = async (pred, ms = 8000, poll = 40) => { const end = Date.now() + ms; let s; while (Date.now() < end) { s = await state(); if (s?.ok && pred(s)) return s; await sleep(poll); } return null; };

try {
  const tabs = await popup.eval(`chrome.tabs.query({}).then(t=>t.map(x=>({id:x.id,url:x.url||''})))`, { awaitPromise: true });
  const tab = tabs.find(t => t.url.includes('11_bargein'));
  await send({ type: 'VF_CONNECT', warm: false });
  await sleep(500);
  const started = await send({ type: 'VF_SESSION_START', tabId: tab.id, speakSummary: false });
  rec('stub: session started through the proxy against the stub', !!started?.ok, JSON.stringify(started).slice(0, 120));

  // ---- 1. slow delivery: gaps open, the clock holds ---------------------------
  const s1 = await waitFor(x => x.utterance && x.utterance.chunks >= 6, 8000);
  rec('stub: audio is being scheduled from slow chunks', !!s1, JSON.stringify(s1?.utterance));
  await sleep(300);
  const before = await state();
  const bi = await send({ type: 'VF_BARGEIN' });
  const s2 = await waitFor(x => x.ledger.some(e => e.status === 'interrupted'), 3000);
  const led = s2?.ledger.find(e => e.status === 'interrupted');
  rec('stub: interruption stopped the turn', !!bi?.stopped && !!led, JSON.stringify({ bi: bi?.stopped, status: led?.status }));
  rec('stub: the clock recorded gaps (network slower than realtime) and the ledger position is audio, not wall time',
      led && led.gapSec > 0.2 && led.driftSec > 0.2 && led.playedSec <= led.totalSec + 0.01,
      JSON.stringify({ gapSec: led?.gapSec, driftSec: led?.driftSec, playedSec: led?.playedSec, totalSec: led?.totalSec }));
  // The timestamps frame is 1.5s late; we interrupted at ~1.0s.
  rec('stub: before the late timestamps, the ledger says the words are UNKNOWN - no guess', led && led.heard && led.heard.known === false && /words unknown/.test(led.display), JSON.stringify({ known: led?.heard?.known, display: led?.display }));

  // ---- 2. late timestamps finalise the ledger; the stale tail is dropped -------
  const s3 = await waitFor(x => { const e = x.ledger.find(e => e.turnId === led.turnId); return e && e.heard && e.heard.known === true; }, 4000);
  const led2 = s3?.ledger.find(e => e.turnId === led.turnId);
  rec('stub: late timestamps arrive after the stop and finalise the heard set retroactively', !!led2 && led2.lateTimestamps === true && led2.heard.heardCount > 0 && led2.heard.heardCount < led2.heard.total, JSON.stringify({ display: led2?.display, heard: led2?.heard?.heardCount, total: led2?.heard?.total, late: led2?.lateTimestamps }));
  const s4 = await state();
  rec('stub: the stale tail after clear was dropped before decode (out of order, 40 chunks)', s4.droppedStaleChunks - before.droppedStaleChunks >= 30, `dropped ${s4.droppedStaleChunks - before.droppedStaleChunks}, played after stop ${s4.playedChunks - before.playedChunks}`);
  // s2 was taken right after the stop; nothing may be scheduled after it until a new turn.
  rec('stub: nothing scheduled or rendered after the stop', s4.playedChunks === s2.playedChunks && s4.metrics.staleAudioEvents === 0, `scheduled ${s2.playedChunks} -> ${s4.playedChunks} after stop, staleAudioEvents ${s4.metrics.staleAudioEvents}`);
  rec("stub: the stale context's own late timestamps did not overwrite the ledger", led2 && !/stale words/.test(led2.heard.heardText), led2?.heard?.heardText);
  rec('stub: state is LISTENING (user has the floor), no illegal transitions', s4.state === 'LISTENING' && s4.machine.illegalCount === 0, `${s4.state} illegal=${s4.machine.illegalCount}`);

  // ---- 3. a new turn while the stale tail is still arriving -------------------
  const played0 = s4.playedChunks;
  await send({ type: 'VF_REPEAT' });
  const s5 = await waitFor(x => x.utterance && x.utterance.chunks >= 3, 8000);
  rec('stub: a new turn plays while the old tail may still be arriving; only its own chunks are scheduled', !!s5 && s5.playedChunks > played0 && s5.utterance.status === 'playing', JSON.stringify(s5?.utterance));
  await sleep(1200);
  const s6 = await state();
  rec("stub: the stale context's done did not end the new turn early", s6.utterance && s6.utterance.status !== 'played' || s6.state === 'PROMPTING' || (s6.ledger.at(-1)?.status === 'played' && s6.ledger.at(-1)?.turnId === s5.utterance.id), JSON.stringify({ utt: s6.utterance?.status, state: s6.state }));

  // ---- 4. interrupt immediately, before the first chunk -----------------------
  await send({ type: 'VF_STOP' }); await sleep(200);
  await send({ type: 'VF_SESSION_START', tabId: tab.id, speakSummary: false });
  const early = await send({ type: 'VF_BARGEIN' });            // the stub has a ~120ms first-chunk delay; this lands before any audio
  await sleep(1500);
  const s7 = await state();
  const e7 = s7.ledger.find(e => e.turnId === early.turnId);
  // `playedChunks` counts SCHEDULED chunks (Phase 1 name); a chunk scheduled
  // into the pre-buffer and stopped before it started is never rendered, which
  // is what the output monitor's stale-audio counter checks.
  rec('stub: interruption before the first audible sample - the turn is cancelled, nothing is rendered', early?.stopped && e7 && e7.status === 'interrupted' && early.sample?.hadAudio === false && s7.metrics.staleAudioEvents === 0, JSON.stringify({ stopped: early?.stopped, hadAudio: early?.sample?.hadAudio, status: e7?.status, chunks: e7?.chunks, stale: s7.metrics.staleAudioEvents }));
  rec('stub: pre-audio interruption counted separately, not as a stop-latency sample', s7.metrics.preAudioInterrupts >= 1 && s7.metrics.stopSamples.filter(x => !x.hadAudio).length >= 1, JSON.stringify({ pre: s7.metrics.preAudioInterrupts }));

  // ---- 5. repeated interrupts in a burst are idempotent -----------------------
  await send({ type: 'VF_REPEAT' });
  await waitFor(x => x.utterance && x.utterance.chunks >= 2, 8000);
  const b0 = (await state()).metrics.bargeIns;
  const r = await Promise.all([send({ type: 'VF_BARGEIN' }), send({ type: 'VF_BARGEIN' }), send({ type: 'VF_BARGEIN' })]);
  const s8 = await state();
  rec('stub: three simultaneous interruptions stop exactly one turn', r.filter(x => x.stopped).length === 1 && s8.metrics.bargeIns === b0 + 1, JSON.stringify({ stopped: r.map(x => x.stopped), bargeIns: s8.metrics.bargeIns - b0 }));
  rec('stub: zero illegal transitions across the whole run', s8.machine.illegalCount === 0, JSON.stringify(s8.machine.illegal));
} catch (e) {
  rec('stub harness completed without throwing', false, e.stack || e.message);
} finally {
  try { cdp.close(); } catch {} try { await chrome.close(); } catch {}
  reap(); srv.close();
}

const pass = results.filter(r => r.ok).length, fail = results.filter(r => !r.ok);
console.log(`\nPhase 3 delayed-frame plumbing - loopback stub, REAL extension code. Not evidence about Rime.\n  PASS ${pass}   FAIL ${fail.length}\n`);
fs.mkdirSync('artifacts', { recursive: true });
fs.writeFileSync('artifacts/phase3_stub.json', JSON.stringify({ results }, null, 2));
process.exit(fail.length ? 1 : 0);
