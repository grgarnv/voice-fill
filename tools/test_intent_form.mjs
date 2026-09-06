// The conversational intent layer on a real form, in a real browser.
//
// Not unit tests. Chrome loads the extension, the offscreen document connects
// to the proxy and speaks real Rime audio, transcripts are injected on the
// exact path a spoken one takes (VF_TRANSCRIPT -> bargeIn -> openCapture ->
// TranscriptOrder -> processTranscript), and every assertion reads the DOM.
//
// Injection rather than the fake microphone is deliberate here: what is under
// test is INTERPRETATION, and Phase 3's own harness (tools/test_bargein.mjs)
// already proves the microphone path with real speech and real whisper. Using
// injected text means the utterance under test is the exact wording the corpus
// names, instead of whatever whisper made of it.
//
//   node tools/test_intent_form.mjs
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadEnv } from '../scripts/probe/lib/env.mjs';
loadEnv();
import { launchChrome, CDP, newPage, unpackedExtensionId } from './cdp.mjs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const results = [];
const rec = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail: String(detail).slice(0, 300) });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got: ${String(detail).slice(0, 240)}`}`);
  return ok;
};
const info = (s) => console.log(`        ${s}`);
let scenario = '';
const S = (s) => { scenario = s; console.log(`\n  ${s}`); };

/* -------------------------------------------------------------- backend --- */

const PORT = Number(process.env.PORT || 8787);
const backend = spawn(process.execPath, ['backend/server.mjs'], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
const reap = () => { try { backend.kill('SIGKILL'); } catch {} };
process.on('exit', reap);
process.on('uncaughtException', (e) => { reap(); console.error(e); process.exit(1); });
let blog = '';
backend.stdout.on('data', d => blog += d);
backend.stderr.on('data', d => blog += d);
let up = false, health = null;
for (let i = 0; i < 60 && !up; i++) {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/health`); if (r.ok) { health = await r.json(); up = true; } } catch {}
  if (!up) await sleep(200);
}
if (!up) { console.error('backend did not start\n' + blog); process.exit(2); }
const LIVE = !!health.intent;
console.log(`  intent provider: ${LIVE ? 'live' : 'NOT CONFIGURED - provider-backed scenarios will assert the FALLBACK behaviour'}`);

/* --------------------------------------------------------------- chrome --- */

const EXT = path.resolve('artifacts/intent-extension');
fs.rmSync(EXT, { recursive: true, force: true });
fs.cpSync(path.resolve('extension'), EXT, { recursive: true });
{
  const mf = path.join(EXT, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
  m.host_permissions = [...(m.host_permissions || []), 'http://127.0.0.1:*/*', 'http://localhost:*/*'];
  fs.writeFileSync(mf, JSON.stringify(m, null, 2));
}

const srv = http.createServer((req, res) => {
  const f = path.join('eval/fixtures', decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, ''));
  if (!fs.existsSync(f) || !fs.statSync(f).isFile()) { res.statusCode = 404; return res.end('no'); }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(fs.readFileSync(f));
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const FPORT = srv.address().port;

const chrome = await launchChrome({
  headless: true, extensionPath: EXT,
  extraArgs: ['--disable-features=AudioServiceOutOfProcess,AudioServiceSandbox',
              '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
const cdp = await new CDP(chrome.browserWsUrl).connect();
const extId = unpackedExtensionId(EXT);
for (let i = 0; i < 40; i++) {
  const { targetInfos } = await cdp.send('Target.getTargets');
  if (targetInfos.some(t => t.url.startsWith(`chrome-extension://${extId}/`))) break;
  await sleep(250);
}

const formPage = await newPage(cdp);
await formPage.goto(`http://127.0.0.1:${FPORT}/13_intent.html`, { waitMs: 1200 });
const popup = await newPage(cdp);
await popup.goto(`chrome-extension://${extId}/popup/popup.html`, { waitMs: 800 });
await popup.eval(`chrome.storage.local.set({ backendUrl:'ws://localhost:${PORT}/speak', proxyToken:${JSON.stringify(process.env.PROXY_TOKEN || '')} })`, { awaitPromise: true });

const send = (m) => popup.eval(`chrome.runtime.sendMessage(${JSON.stringify(m)})`, { awaitPromise: true });
const state = () => send({ type: 'VF_STATE' });
const form = () => formPage.eval('window.__formState()');

/** Everything spoken since a marker, newest last. */
const spokenSince = (s, sinceTurnId) => (s.ledger || []).filter(e => e.turnId > sinceTurnId).map(e => e.text || '');
/** Did the session ASK something (a clarification turn), rather than act? */
const askedSince = (s, sinceTurnId) => (s.ledger || []).some(e => e.turnId > sinceTurnId && e.why === 'clarify');

async function waitSettled(max = 40) {
  for (let i = 0; i < max; i++) {
    const s = await state();
    if (s?.ok && ['READY', 'LISTENING', 'CONFIRMING'].includes(s.state) && !s.utterance?.started) return s;
    if (s?.ok && ['LISTENING', 'CONFIRMING'].includes(s.state) && ['played', 'done', 'interrupted'].includes(s.utterance?.status)) return s;
    await sleep(400);
  }
  return state();
}
/**
 * Inject a transcript on the barge-in path and let the turn resolve.
 *
 * Waiting for the reply to finish SPEAKING matters: a clarification is only
 * written to the heard ledger when its utterance ends, so a fixed sleep samples
 * a ledger that does not yet contain the thing under test.
 */
async function say(text, waitMs = 2500) {
  const r = await send({ type: 'VF_TRANSCRIPT', text });
  await sleep(waitMs);
  await waitSettled();
  return r;
}
/** Interrupt whatever is being spoken, right now, with these words. */
async function interruptWith(text, afterMs) { await sleep(afterMs); return say(text); }

async function gotoField(re, max = 20) {
  for (let i = 0; i < max; i++) {
    const s = await waitSettled();
    if (s?.pending) { await say('yes'); continue; }
    if (re.test(s?.field?.label || '')) return s;
    await send({ type: 'VF_NEXT' });
    await sleep(1800);
  }
  return waitSettled();
}
/* Connect once, then each scenario gets a clean form and a fresh session. */
const tabs = await popup.eval(`chrome.tabs.query({}).then(t=>t.map(x=>({id:x.id,url:x.url||''})))`, { awaitPromise: true });
const tabId = tabs.find(t => (t.url || '').includes('13_intent'))?.id;
if (tabId == null) { console.error('form tab not found'); process.exit(2); }

await send({ type: 'VF_SET_STT', provider: 'backend' });
await send({ type: 'VF_CONNECT' });
await sleep(2200);

const startSession = () => send({ type: 'VF_SESSION_START', tabId, speakSummary: false });
const restart = async () => {
  await send({ type: 'VF_STOP' }); await sleep(500);
  await formPage.eval(`document.getElementById('f').reset()`);
  await startSession(); await sleep(1200);
  return waitSettled();
};

/* ============================================================ scenarios === */

const started = await startSession();
rec('session started on the intent fixture', !!started?.ok, JSON.stringify(started).slice(0, 160));
const first = await waitSettled();
rec('session starts on the symptoms multi-select', /symptom/i.test(first?.field?.label || ''), JSON.stringify(first?.field));

S('1. option selection in natural language');
{
  await say('the first two');
  let s = await state();
  rec('"the first two" -> Fever + Cough are pending', JSON.stringify(s.pending?.value) === '["fever","cough"]', JSON.stringify(s.pending));
  // The read-back must use the LABELS the user heard and the DOM's own truth,
  // not the option values a selection is stored as ("fever,cough").
  rec('...and read back as "Fever, Cough", not the raw option values',
      /Fever,\s*Cough/.test(s.pending?.spoken || ''), JSON.stringify(s.pending?.spoken));
  rec('...resolved by the ordinal path, no provider round trip', (s.intent?.byOrdinal || 0) >= 1, JSON.stringify(s.intent));
  await say('yes');
  rec('...and written to the DOM once confirmed', JSON.stringify((await form()).symptoms) === '["fever","cough"]', JSON.stringify(await form()));

  await restart();
  await say('the first and third');
  s = await state();
  rec('"the first and third" -> Fever + Headache', JSON.stringify(s.pending?.value) === '["fever","headache"]', JSON.stringify(s.pending));

  await restart();
  await say('all four');
  s = await state();
  rec('"all four" -> every option', JSON.stringify(s.pending?.value) === '["fever","cough","headache","nausea"]', JSON.stringify(s.pending));
  await say('yes');
  rec('...all four written to the DOM', (await form()).symptoms.length === 4, JSON.stringify(await form()));

  await restart();
  await say('fever and headache');
  s = await state();
  rec('natural labels still work', JSON.stringify(s.pending?.value) === '["fever","headache"]',
      `pending=${JSON.stringify(s.pending)} field=${s.field?.id} opts=${s.field?.optionCount} last=${JSON.stringify((s.transcripts||[]).slice(-2))}`);
}

S('2. ambiguity asks instead of guessing');
{
  let mark = (await restart()).turnId;
  await say('the fifth one');
  let s = await state();
  rec('"the fifth" of four options wrote nothing', (await form()).symptoms.length === 0, JSON.stringify(await form()));
  rec('...and asked a clarifying question instead', askedSince(s, mark),
      spokenSince(s, mark).join(' | ').slice(0, 200));

  await restart();
  await gotoField(/contact/i);
  mark = (await state()).turnId;
  await say('all of them');
  s = await state();
  rec('"all of them" on a single-select wrote nothing', !(await form()).contact, JSON.stringify(await form()));
  rec('...and asked which one', askedSince(s, mark), spokenSince(s, mark).join(' | ').slice(0, 200));
}

S('3. natural confirmation and correction on a text field');
{
  await restart();
  await gotoField(/first name/i);
  await say('Arjun');
  let s = await state();
  rec('the name is read back for confirmation', s.pending?.value === 'Arjun', JSON.stringify(s.pending));
  await say("No no, it's Arnav");
  s = await state();
  rec('"No no, it\'s Arnav" corrected the value to Arnav', s.pending?.value === 'Arnav', JSON.stringify(s.pending));
  rec('...and the DOM holds Arnav, not "No, It\'S Arnav"', (await form()).first === 'Arnav', JSON.stringify(await form()));
  await say('yes');
  rec('"yes" accepted it', (await form()).first === 'Arnav', JSON.stringify(await form()));
}

S('4. partial digit correction');
{
  await restart();
  await gotoField(/postal/i);
  await say('one six zero zero seven one');
  let s = await state();
  rec('160071 is pending', s.pending?.value === '160071', JSON.stringify(s.pending));
  await say('No, the last digit is two', 6000);
  s = await state();
  const got = (await form()).postcode;
  if (LIVE) {
    rec('"the last digit is two" -> 160072', s.pending?.value === '160072' || got === '160072', `pending=${s.pending?.value} dom=${got}`);
  } else {
    // Without a provider the deterministic table extracts "2". The layer cannot
    // repair that; what it MUST do is never let it pass as final.
    rec('without a provider the fragment is at least confirmed, never silently accepted',
        !!s.pending || got !== '2', `pending=${JSON.stringify(s.pending)} dom=${got}`);
  }
  info(`intent metrics: ${JSON.stringify(s.intent)}`);
}

S('5. interrupted option list respects the heard ledger');
{
  await restart();
  await gotoField(/contact/i);
  const mark5 = (await state()).turnId;
  await send({ type: 'VF_REPEAT' });
  // Cut in early: only the first option or two can have been spoken.
  await interruptWith('the first and third', 900);
  const s = await state();
  const entry = (s.ledger || []).filter(e => e.status === 'interrupted').slice(-1)[0];
  const heard = entry?.display || '';
  const heardCount = ['Email', 'Phone', 'SMS', 'WhatsApp'].filter(o => new RegExp(o, 'i').test(heard)).length;
  info(`heard: ${heard.slice(0, 120)}`);
  rec('the list was interrupted and the ledger knows what was audible', !!entry, JSON.stringify(entry?.status));
  const dom = (await form()).contact;
  if (heardCount >= 3) {
    rec('option 3 had been heard, so the reference resolved', !!dom || !!s.pending, `dom=${dom} pending=${JSON.stringify(s.pending)}`);
  } else {
    rec(`only ${heardCount} option(s) were heard, so "the third" was NOT assumed`, !dom, `dom=${dom}`);
    rec('...it asked instead', askedSince(s, mark5), spokenSince(s, mark5).join(' | ').slice(0, 200));
  }
}

S('6. interrupted confirmation');
{
  await restart();
  await gotoField(/first name/i);
  await say('Arjun');
  await send({ type: 'VF_REPEAT' });
  await interruptWith("no, it's Arnav", 700);
  const s = await state();
  rec('the read-back was interrupted and the correction landed', s.pending?.value === 'Arnav' || (await form()).first === 'Arnav',
      `pending=${JSON.stringify(s.pending)} dom=${JSON.stringify(await form())}`);
  rec('no illegal state transition', (s.machine?.illegalCount || 0) === 0, JSON.stringify(s.machine?.illegal));
}

S('7. double interruption - the newest instruction wins');
{
  await restart();
  await gotoField(/first name/i);
  await say('Arjun');
  await send({ type: 'VF_TRANSCRIPT', text: "no, it's Arnav" });
  await sleep(500);
  await send({ type: 'VF_TRANSCRIPT', text: 'no wait, I meant Aarav' });
  await sleep(5000);
  const s = await state();
  const final = s.pending?.value ?? (await form()).first;
  rec('the LAST correction is what stands', final === 'Aarav', `final=${final} pending=${JSON.stringify(s.pending)} dom=${JSON.stringify(await form())}`);
  rec('no stale audio, no illegal transitions', (s.metrics?.staleAudioEvents || 0) === 0 && (s.machine?.illegalCount || 0) === 0,
      JSON.stringify({ stale: s.metrics?.staleAudioEvents, illegal: s.machine?.illegalCount }));
}

S('8. Phase 3 invariants across the whole run');
{
  const s = await state();
  rec('no stale audio played', (s.metrics?.staleAudioEvents || 0) === 0, JSON.stringify(s.metrics?.staleAudioDetail));
  rec('no illegal state transitions', (s.machine?.illegalCount || 0) === 0, JSON.stringify(s.machine?.illegal));
  rec('no field was re-asked after it was answered', (s.metrics?.reasks || 0) === 0, JSON.stringify(s.metrics?.reaskDetail));
  rec('no capture left hanging', (s.capturesInFlight || 0) === 0, String(s.capturesInFlight));
  const it = s.intent || {};
  info(`intent: consulted=${it.consulted || 0} byOrdinal=${it.byOrdinal || 0} byProvider=${it.byProvider || 0} clarify=${it.clarifications || 0} rejected=${(it.rejected || []).length} providerFailures=${it.providerFailures || 0}`);
  info(`skipped (deterministic wins): ${JSON.stringify(it.skipped || {})}`);
  if ((it.providerMs || []).length) {
    const lat = [...it.providerMs].sort((a, b) => a - b);
    info(`provider latency p50 ${lat[Math.floor(lat.length / 2)]}ms p95 ${lat[Math.min(lat.length - 1, Math.floor(0.95 * lat.length))]}ms n=${lat.length}`);
  }
  fs.mkdirSync('artifacts', { recursive: true });
  fs.writeFileSync('artifacts/intent_form.json', JSON.stringify({ at: new Date().toISOString(), live: LIVE, results, snapshot: s }, null, 2));
}

/* ------------------------------------------------------------------ done -- */
const pass = results.filter(r => r.ok).length, fail = results.filter(r => !r.ok);
console.log(`\n  PASS ${pass}   FAIL ${fail.length}${LIVE ? '' : '   (provider not configured)'}\n`);
try { await cdp.close(); } catch {}
// close(), not kill(): launchChrome returns a handle with close(), and the
// missing method threw into the empty catch - leaving a headless Chrome, a
// live VoiceFill session and its backend socket running after the suite
// exited. The next suite then shared the machine with it and failed for
// reasons that had nothing to do with the code under test.
try { await chrome.close(); } catch {}
srv.close(); reap();
process.exit(fail.length ? 1 : 0);
