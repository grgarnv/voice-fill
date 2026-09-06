// Personal voice memory + natural correction, on a real form, in a real
// browser, through the real extension.
//
// Not unit tests. Chrome loads the extension, the offscreen document connects
// to the proxy and speaks real Rime audio, transcripts are injected on the
// exact path a spoken one takes (VF_TRANSCRIPT -> bargeIn -> openCapture ->
// TranscriptOrder -> processTranscript), the profile is read from and written
// to real chrome.storage by the real service worker, and every assertion reads
// the DOM or that storage.
//
// Injection rather than the fake microphone is deliberate: what is under test
// is INTERPRETATION and MEMORY, and Phase 3's harness (tools/test_bargein.mjs)
// already proves the microphone path with real speech and real whisper. Injected
// text means the utterance under test is the exact wording the corpus names.
//
//   node tools/test_memory_form.mjs
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
  results.push({ scenario, name, ok: !!ok, detail: String(detail).slice(0, 300) });
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
console.log(`  intent provider: ${LIVE ? 'live' : 'NOT CONFIGURED - the deterministic paths are what is under test either way'}`);

/* --------------------------------------------------------------- chrome --- */

const EXT = path.resolve('artifacts/memory-extension');
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
await formPage.goto(`http://127.0.0.1:${FPORT}/14_memory.html`, { waitMs: 1200 });
const popup = await newPage(cdp);
await popup.goto(`chrome-extension://${extId}/popup/popup.html`, { waitMs: 800 });
await popup.eval(`chrome.storage.local.set({ backendUrl:'ws://localhost:${PORT}/speak', proxyToken:${JSON.stringify(process.env.PROXY_TOKEN || '')} })`, { awaitPromise: true });

const send = (m) => popup.eval(`chrome.runtime.sendMessage(${JSON.stringify(m)})`, { awaitPromise: true });
const state = () => send({ type: 'VF_STATE' });
const form = () => formPage.eval('window.__formState()');
/** What is actually in chrome.storage - the profile as it will survive a restart. */
const stored = () => popup.eval(`chrome.storage.local.get(['voiceProfile']).then(d => d.voiceProfile ?? null)`, { awaitPromise: true });

const askedSince = (s, sinceTurnId) => (s.ledger || []).some(e => e.turnId > sinceTurnId && e.why === 'clarify');
const spokenSince = (s, sinceTurnId) => (s.ledger || []).filter(e => e.turnId > sinceTurnId).map(e => e.text || '');

async function waitSettled(max = 40) {
  for (let i = 0; i < max; i++) {
    const s = await state();
    if (s?.ok && ['READY', 'LISTENING', 'CONFIRMING'].includes(s.state) && !s.utterance?.started) return s;
    if (s?.ok && ['LISTENING', 'CONFIRMING'].includes(s.state) && ['played', 'done', 'interrupted'].includes(s.utterance?.status)) return s;
    await sleep(400);
  }
  return state();
}
async function say(text, waitMs = 2500) {
  const r = await send({ type: 'VF_TRANSCRIPT', text });
  await sleep(waitMs);
  await waitSettled();
  return r;
}
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

const tabs = await popup.eval(`chrome.tabs.query({}).then(t=>t.map(x=>({id:x.id,url:x.url||''})))`, { awaitPromise: true });
const tabId = tabs.find(t => (t.url || '').includes('14_memory'))?.id;
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

await send({ type: 'VF_MEMORY_CLEAR' });
const started = await startSession();
rec('session started on the memory fixture', !!started?.ok, JSON.stringify(started).slice(0, 160));
rec('the profile starts empty', ((await stored())?.corrections || []).length === 0, JSON.stringify(await stored()));

S('1. first-name correction through spelling');
{
  await restart();
  await gotoField(/first name/i);
  await say('Enough.');
  let s = await state();
  rec('the recogniser\'s mistake is read back, not written blind', s.pending?.value === 'Enough', JSON.stringify(s.pending));
  await say("No, it's Arnav. Spell it A R N A V.", 4000);
  s = await state();
  rec('"Spell it A R N A V" produces Arnav', s.pending?.value === 'Arnav' || (await form()).first === 'Arnav',
      `pending=${JSON.stringify(s.pending)} dom=${JSON.stringify(await form())}`);
  rec('...not the literal letters', !/A[- ]R[- ]N/i.test(String(s.pending?.value ?? (await form()).first)),
      String(s.pending?.value ?? (await form()).first));
  rec('...resolved by deterministic assembly, no provider round trip', (s.intent?.byFormatting || 0) >= 1, JSON.stringify(s.intent));
  await say('yes');
  rec('...and "yes" writes Arnav to the DOM', (await form()).first === 'Arnav', JSON.stringify(await form()));
}

S('2. the confirmed correction is remembered');
{
  const p = await stored();
  rec('the correction was persisted to chrome.storage', (p?.corrections || []).some(c => c.canonical === 'Arnav'), JSON.stringify(p));
  rec('...against the field CONTEXT, not the field id', (p?.corrections || [])[0]?.context === 'name', JSON.stringify(p?.corrections));
  rec('...with the observed transcript normalised', (p?.corrections || [])[0]?.observed === 'enough', JSON.stringify(p?.corrections));
  rec('...and the name became personal vocabulary', (p?.vocabulary || []).some(v => v.canonical === 'Arnav'), JSON.stringify(p?.vocabulary));
  rec('nothing else was stored', (p?.corrections || []).length === 1 && (p?.vocabulary || []).length === 1, JSON.stringify(p));
}

S('3. the SAME mistake is easier the second time');
{
  await restart();                       // new session; the profile is reloaded
  await gotoField(/first name/i);
  const before = (await state()).intent?.byMemory || 0;
  await say('Enough.', 3500);
  const s = await state();
  rec('"Enough." now resolves straight to Arnav', s.pending?.value === 'Arnav' || (await form()).first === 'Arnav',
      `pending=${JSON.stringify(s.pending)} dom=${JSON.stringify(await form())}`);
  rec('...via the profile, with no provider call', (s.intent?.byMemory || 0) > before, JSON.stringify(s.intent));
  rec('...and it is STILL read back before it counts', !!s.pending, JSON.stringify(s.pending));
  rec('...so one turn now does what took two', (await form()).first !== 'Enough', JSON.stringify(await form()));
  await say('yes');
  rec('...confirmed into the DOM', (await form()).first === 'Arnav', JSON.stringify(await form()));
}

S('4. the learned word does NOT fire in another context');
{
  const s0 = await state();
  await gotoField(/city/i);
  await say('Enough.', 3000);
  let s = await state();
  const cityVal = s.pending?.value ?? (await form()).city;
  rec('"Enough." in a City field is not turned into Arnav', cityVal !== 'Arnav', String(cityVal));
  await say('no');
  await gotoField(/notes/i);
  await say('How much is enough?', 3000);
  s = await state();
  const notes = s.pending?.value ?? (await form()).notes;
  rec('"How much is enough?" stays exactly what was said', /how much is enough/i.test(String(notes)), String(notes));
  rec('...and does not contain the learned name', !/arnav/i.test(String(notes)), String(notes));
}

S('5. full-name multi-component spelling');
{
  await restart();
  await gotoField(/full name/i);
  await say('My full name is Arnav Garg. Arnav is spelled A R N A V and Garg is G A R G.', 4000);
  const s = await state();
  const v = s.pending?.value ?? (await form()).full;
  rec('the value is "Arnav Garg"', v === 'Arnav Garg', String(v));
  rec('...not doubled', String(v).split(/\s+/).length === 2, String(v));
  rec('...and not the letters', !/A R N A V/i.test(String(v)), String(v));
  await say('yes');
  rec('...written to the DOM', (await form()).full === 'Arnav Garg', JSON.stringify(await form()));
}

S('6. a natural uppercase instruction');
{
  await restart();
  await gotoField(/full name/i);
  await say('Arnav Garg, all uppercase.', 3500);
  const s = await state();
  const v = s.pending?.value ?? (await form()).full;
  rec('"all uppercase" gives ARNAV GARG', v === 'ARNAV GARG', String(v));
  await say('yes');
  rec('...written to the DOM in caps', (await form()).full === 'ARNAV GARG', JSON.stringify(await form()));
}

S('7. a natural lowercase instruction on a value ALREADY WRITTEN');
{
  // Not a correction inside a read-back - the value is accepted, the session
  // has moved on, and the person comes back to it and asks for a change.
  await restart();
  await gotoField(/full name/i);
  await say('Arnav Garg');
  await say('yes', 3000);
  rec('Arnav Garg is written and accepted', (await form()).full === 'Arnav Garg', JSON.stringify(await form()));
  await send({ type: 'VF_PREV' });
  await sleep(2000);
  const back = await waitSettled();
  rec('...and we are back on it', /full name/i.test(back?.field?.label || ''), JSON.stringify(back?.field));
  await say('make it all lowercase', 3500);
  const s = await state();
  const v = s.pending?.value ?? (await form()).full;
  rec('"make it all lowercase" gives arnav garg', v === 'arnav garg', String(v));
  await say('yes');
  rec('...written to the DOM', (await form()).full === 'arnav garg', JSON.stringify(await form()));
}

S('8. a mixed casing instruction');
{
  await restart();
  await gotoField(/full name/i);
  await say('Arnav Garg, first name normal case, last name all caps.', 4000);
  const s = await state();
  const v = s.pending?.value ?? (await form()).full;
  rec('"first name normal case, last name all caps" gives Arnav GARG', v === 'Arnav GARG', String(v));
}

S('9. casing may not corrupt a field that has no case');
{
  await restart();
  await gotoField(/postal/i);
  await say('one six zero zero seven one');
  let mark = (await state()).turnId;
  await say('make that all caps', 3500);
  const s = await state();
  rec('a digit field wrote nothing', (await form()).postcode !== 'ONE', JSON.stringify(await form()));
  rec('...and asked instead', askedSince(s, mark), spokenSince(s, mark).join(' | ').slice(0, 200));
  rec('...leaving the number intact', s.pending?.value === '160071' || (await form()).postcode === '160071',
      `pending=${JSON.stringify(s.pending)} dom=${JSON.stringify(await form())}`);
}

S('10. partial numeric correction');
{
  await restart();
  await gotoField(/postal/i);
  await say('one six zero zero seven one');
  rec('160071 is pending', (await state()).pending?.value === '160071', JSON.stringify((await state()).pending));
  await say('No, the last digit is two', 4000);
  const s = await state();
  rec('"the last digit is two" -> 160072', s.pending?.value === '160072' || (await form()).postcode === '160072',
      `pending=${s.pending?.value} dom=${(await form()).postcode}`);
  await say('yes');
  rec('...written to the DOM', (await form()).postcode === '160072', JSON.stringify(await form()));
}

S('11. an ambiguous correction asks');
{
  await restart();
  await gotoField(/postal/i);
  await say('one six zero zero seven one');
  const mark = (await state()).turnId;
  await say('change the third digit', 3500);
  const s = await state();
  rec('"change the third digit" to WHAT wrote nothing', (await form()).postcode !== '16', JSON.stringify(await form()));
  rec('...and asked', askedSince(s, mark), spokenSince(s, mark).join(' | ').slice(0, 200));

  // A fresh field: a clarification SPENDS an error-recovery attempt (by
  // design - a question that costs nothing is a question with no end), so two
  // of them on one field is the bounded-loop path, not the one under test.
  await restart();
  await gotoField(/postal/i);
  await say('one six zero zero seven one');
  const mark2 = (await state()).turnId;
  await say('everything is right except the last digit', 3500);
  const s2 = await state();
  rec('"everything is right except the last digit" is not an acceptance', !(await form()).postcode || (await form()).postcode === '160071',
      JSON.stringify(await form()));
  rec('...it asks what it should be', askedSince(s2, mark2), spokenSince(s2, mark2).join(' | ').slice(0, 200));
}

S('12. option correction');
{
  await restart();
  await say('fever and cough');
  rec('Fever + Cough pending', JSON.stringify((await state()).pending?.value) === '["fever","cough"]', JSON.stringify((await state()).pending));
  await say('no, actually just the headache', 3500);
  const s = await state();
  rec('"actually just the headache" replaces the selection', JSON.stringify(s.pending?.value) === '["headache"]',
      `pending=${JSON.stringify(s.pending)} dom=${JSON.stringify(await form())}`);
  await say('yes');
  rec('...and only Headache is checked', JSON.stringify((await form()).symptoms) === '["headache"]', JSON.stringify(await form()));
}

S('13. interruption + correction, and double interruption + correction');
{
  await restart();
  await gotoField(/first name/i);
  await say('Arjun');
  await send({ type: 'VF_REPEAT' });
  await interruptWith("no, Arnav — A R N A V", 700);
  let s = await state();
  rec('a spelled correction lands over an interrupted read-back',
      s.pending?.value === 'Arnav' || (await form()).first === 'Arnav',
      `pending=${JSON.stringify(s.pending)} dom=${JSON.stringify(await form())}`);
  rec('no illegal state transition', (s.machine?.illegalCount || 0) === 0, JSON.stringify(s.machine?.illegal));

  await restart();
  await gotoField(/first name/i);
  await say('Arjun');
  await send({ type: 'VF_TRANSCRIPT', text: 'no, spell it A R N A V' });
  await sleep(500);
  await send({ type: 'VF_TRANSCRIPT', text: 'no wait, spell it A A R A V' });
  await sleep(6000);
  s = await state();
  const final = s.pending?.value ?? (await form()).first;
  rec('the LAST spelling is what stands', final === 'Aarav', `final=${final} dom=${JSON.stringify(await form())}`);
  rec('no stale audio, no illegal transitions', (s.metrics?.staleAudioEvents || 0) === 0 && (s.machine?.illegalCount || 0) === 0,
      JSON.stringify({ stale: s.metrics?.staleAudioEvents, illegal: s.machine?.illegalCount }));
}

S('14. two corrections in a row teach nothing');
{
  const before = ((await stored())?.corrections || []).length;
  await restart();
  await gotoField(/city/i);
  await say('Bangalore');
  await say('no, Bengaluru', 3000);
  await say('no, actually Bengaluru City', 3000);
  await say('yes', 3000);
  const after = ((await stored())?.corrections || []).length;
  rec('a two-step correction is NOT persisted', after === before, `before=${before} after=${after} ${JSON.stringify(await stored())}`);
}

S('15. Phase 3 invariants across the whole run');
{
  const s = await state();
  rec('no stale audio played', (s.metrics?.staleAudioEvents || 0) === 0, JSON.stringify(s.metrics?.staleAudioDetail));
  rec('no illegal state transitions', (s.machine?.illegalCount || 0) === 0, JSON.stringify(s.machine?.illegal));
  rec('no capture left hanging', (s.capturesInFlight || 0) === 0, String(s.capturesInFlight));
  const p = await stored();
  rec('the profile still holds no digits, emails or free text', !/[\d@]/.test(JSON.stringify((p?.corrections || []).concat(p?.vocabulary || []).map(x => [x.observed, x.canonical]))),
      JSON.stringify(p));
  const it = s.intent || {};
  info(`intent: byOrdinal=${it.byOrdinal || 0} byFormatting=${it.byFormatting || 0} byMemory=${it.byMemory || 0} byProvider=${it.byProvider || 0} clarify=${it.clarifications || 0} rejected=${(it.rejected || []).length} providerFailures=${it.providerFailures || 0}`);
  info(`skipped (deterministic wins): ${JSON.stringify(it.skipped || {})}`);
  info(`consulted why: ${JSON.stringify(it.consultedWhy || {})}`);
  if ((it.providerMs || []).length) {
    const lat = [...it.providerMs].sort((a, b) => a - b);
    info(`provider latency p50 ${lat[Math.floor(lat.length / 2)]}ms p95 ${lat[Math.min(lat.length - 1, Math.floor(0.95 * lat.length))]}ms n=${lat.length}`);
  }
  const lat = s.metrics?.stopLatencyP50;
  if (lat != null) info(`barge-in stop latency p50 ${lat}ms p95 ${s.metrics.stopLatencyP95}ms n=${s.metrics.stopLatencyN}`);
  fs.mkdirSync('artifacts', { recursive: true });
  fs.writeFileSync('artifacts/memory_form.json', JSON.stringify({ at: new Date().toISOString(), live: LIVE, results, profile: p, snapshot: s }, null, 2));
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
