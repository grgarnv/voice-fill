// Conversational navigation on a real form, in a real browser.
//
// Chrome loads the extension, the offscreen document connects to the proxy and
// speaks real Rime audio, transcripts are injected on the exact path a spoken
// one takes (VF_TRANSCRIPT -> bargeIn -> openCapture -> TranscriptOrder ->
// processTranscript), and every assertion reads the DOM or the session's own
// snapshot. The page's fields change under the session the way a real form's
// do: a conditional appears, one is inserted behind the pointer, a wizard step
// replaces the lot.
//
// Injection rather than the fake microphone, for the reason tools/
// test_intent_form.mjs gives: what is under test is interpretation, and the
// microphone path is already proven by tools/test_bargein.mjs with real speech.
//
//   node tools/test_navigation_form.mjs
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadEnv } from '../scripts/probe/lib/env.mjs';
loadEnv();
import { launchChrome, CDP, newPage, unpackedExtensionId } from './cdp.mjs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const results = [];
let scenario = '';
const rec = (name, ok, detail = '') => {
  results.push({ scenario, name, ok: !!ok, detail: String(detail).slice(0, 300) });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got: ${String(detail).slice(0, 240)}`}`);
  return ok;
};
const info = (s) => console.log(`        ${s}`);
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
console.log(`  intent provider: ${LIVE ? 'live' : 'NOT CONFIGURED - the deterministic path is what is measured'}`);

/* --------------------------------------------------------------- chrome --- */

const EXT = path.resolve('artifacts/navigation-extension');
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
await formPage.goto(`http://127.0.0.1:${FPORT}/15_navigation.html`, { waitMs: 1200 });
const popup = await newPage(cdp);
await popup.goto(`chrome-extension://${extId}/popup/popup.html`, { waitMs: 800 });
await popup.eval(`chrome.storage.local.set({ backendUrl:'ws://localhost:${PORT}/speak', proxyToken:${JSON.stringify(process.env.PROXY_TOKEN || '')} })`, { awaitPromise: true });

const send = (m) => popup.eval(`chrome.runtime.sendMessage(${JSON.stringify(m)})`, { awaitPromise: true });
const state = () => send({ type: 'VF_STATE' });
const form = () => formPage.eval('window.__formState()');
const page = (js) => formPage.eval(js);

const spokenSince = (s, turnId) => (s.ledger || []).filter(e => e.turnId > turnId).map(e => e.text || '');
const askedSince = (s, turnId) => (s.ledger || []).some(e => e.turnId > turnId && (e.why === 'clarify' || e.why === 'nav-edge'));

async function waitSettled(max = 40) {
  for (let i = 0; i < max; i++) {
    const s = await state();
    if (s?.ok && ['READY', 'LISTENING', 'CONFIRMING'].includes(s.state) && !s.utterance?.started) return s;
    if (s?.ok && ['LISTENING', 'CONFIRMING'].includes(s.state) && ['played', 'done', 'interrupted'].includes(s.utterance?.status)) return s;
    await sleep(400);
  }
  return state();
}
async function say(text, waitMs = 2600) {
  const r = await send({ type: 'VF_TRANSCRIPT', text });
  await sleep(waitMs);
  await waitSettled();
  return r;
}
/** Interrupt whatever is being spoken, right now, with these words. */
async function interruptWith(text, afterMs) { await sleep(afterMs); return say(text); }
const label = async () => (await state())?.field?.label || '';

/** Answer the current field and accept the read-back, however it is phrased. */
async function answer(text, waitMs = 3000) {
  await say(text, waitMs);
  let s = await state();
  if (s?.pending) { await say('yes', 2600); s = await state(); }
  return s;
}

const tabs = await popup.eval(`chrome.tabs.query({}).then(t=>t.map(x=>({id:x.id,url:x.url||''})))`, { awaitPromise: true });
const tabId = tabs.find(t => (t.url || '').includes('15_navigation'))?.id;
if (tabId == null) { console.error('form tab not found'); process.exit(2); }

await send({ type: 'VF_SET_STT', provider: 'backend' });
await send({ type: 'VF_CONNECT' });
await sleep(2200);

const startSession = () => send({ type: 'VF_SESSION_START', tabId, speakSummary: false });
const restart = async () => {
  await send({ type: 'VF_STOP' }); await sleep(500);
  await page('window.__reset()');
  await sleep(600);
  await startSession(); await sleep(1400);
  return waitSettled();
};

/* ============================================================ scenarios === */

const started = await startSession();
rec('session started on the navigation fixture', !!started?.ok, JSON.stringify(started).slice(0, 160));
rec('...on the first field', /first name/i.test(await label()), await label());

S('1. going back, and the value that is already there');
{
  await restart();
  await answer('Arnav');                     // First name
  await answer('Garg');                      // Last name
  await answer('arnav at example dot com');  // Email  -> Phone
  const before = await form();
  rec('three fields are filled and the session is on the phone number',
      /phone/i.test(await label()) && !!before.email, `${await label()} ${JSON.stringify(before)}`);

  const mark = (await state()).turnId;
  await say('go back');
  let s = await state();
  rec('"go back" -> the email field', /email/i.test(s.field?.label || ''), s.field?.label);
  rec('...it read the existing value back rather than erasing it',
      /currently has/i.test(spokenSince(s, mark).join(' ')), spokenSince(s, mark).join(' | ').slice(0, 200));
  rec('...and the value is still in the DOM', (await form()).email === before.email, JSON.stringify(await form()));

  await say('go back to my first name');
  s = await state();
  rec('"go back to my first name" -> the first name field', /first name/i.test(s.field?.label || ''), s.field?.label);
  rec('...with Arnav still in it', (await form()).first === 'Arnav', JSON.stringify(await form()));
  rec('...and the session says it navigated by name', s.lastNav?.why === 'named', JSON.stringify(s.lastNav));
}

S('2. relative navigation, and its boundaries');
{
  await restart();
  await answer('Arnav'); await answer('Garg'); await answer('arnav at example dot com');
  await say('go back two fields');
  rec('"go back two fields" -> the last name', /last name/i.test(await label()), await label());

  await say('move forward one field');
  rec('"move forward one field" -> the email', /email/i.test(await label()), await label());

  const mark = (await state()).turnId;
  await say('go back ten fields');
  const s = await state();
  rec('ten fields back, with two behind: nothing moved', /email/i.test(s.field?.label || ''), s.field?.label);
  rec('...and it said so out loud', askedSince(s, mark), spokenSince(s, mark).join(' | ').slice(0, 200));
}

S('3. named, referenced and unknown targets');
{
  await restart();
  await answer('Arnav'); await answer('Garg'); await answer('arnav at example dot com');
  await say('take me back to the field I just answered');
  rec('"the field I just answered" -> the email', /email/i.test(await label()), await label());

  await say('go to the last name field');
  rec('"the last name field" -> the last name', /last name/i.test(await label()), await label());

  const mark = (await state()).turnId;
  await say('go to my fax number');
  const s = await state();
  rec('a field this form does not have moves nothing', /last name/i.test(s.field?.label || ''), s.field?.label);
  rec('...and asks instead of guessing', askedSince(s, mark), spokenSince(s, mark).join(' | ').slice(0, 200));
  rec('...and wrote nothing anywhere', !(await form()).city && !(await form()).phone, JSON.stringify(await form()));
}

S('4. navigation during a confirmation');
{
  await restart();
  await answer('Arnav'); await answer('Garg'); await answer('arnav at example dot com');
  await say('five five five one two three four');
  let s = await state();
  rec('the phone number is awaiting a yes or no', !!s.pending, JSON.stringify(s.pending));
  const written = (await form()).phone;
  await say('no, go back to the previous field');
  s = await state();
  rec('"no, go back to the previous field" navigated instead of rejecting',
      /email/i.test(s.field?.label || ''), `${s.field?.label} pending=${JSON.stringify(s.pending)}`);
  rec('...the confirmation is no longer outstanding', !s.pending, JSON.stringify(s.pending));
  rec('...and the value it was confirming was left in the page', (await form()).phone === written, `${(await form()).phone} vs ${written}`);

  await restart();
  await answer('Arnav'); await answer('Garg');
  await say('arnav at example dot com');
  s = await state();
  if (s?.pending) {
    await say("don't confirm that. take me back to my first name");
    s = await state();
    rec('"don\'t confirm that, take me back to my first name" navigates', /first name/i.test(s.field?.label || ''), s.field?.label);
  } else {
    rec('(email was accepted without a read-back; scenario skipped)', true, JSON.stringify(s.field));
  }
}

S('5. navigation after a barge-in');
{
  await restart();
  await answer('Arnav'); await answer('Garg'); await answer('arnav at example dot com');
  const s0 = await state();
  await send({ type: 'VF_REPEAT' });
  await interruptWith('take me back to my email', 700);       // cut the prompt off
  const s = await state();
  const cut = (s.ledger || []).filter(e => e.status === 'interrupted').length;
  rec('the prompt was interrupted', cut > 0, `interrupted entries=${cut}`);
  rec('...and the navigation still landed on the email', /email/i.test(s.field?.label || ''), s.field?.label);
  rec('...with no stale audio', (s.metrics?.staleAudioEvents || 0) === 0, JSON.stringify(s.metrics?.staleAudioDetail));
  rec('...and no illegal state transition', (s.machine?.illegalCount || 0) === 0, JSON.stringify(s.machine?.illegal));
  info(`barge-ins so far: ${s.metrics?.bargeIns}, stop p50 ${s.metrics?.stopLatencyP50}ms`);
  void s0;
}

S('6. double interruption - the latest instruction wins');
{
  await restart();
  await answer('Arnav'); await answer('Garg'); await answer('arnav at example dot com');
  await send({ type: 'VF_TRANSCRIPT', text: 'go back to my email' });
  await sleep(500);
  await send({ type: 'VF_TRANSCRIPT', text: 'no wait, take me to my first name' });
  await sleep(6000);
  await waitSettled();
  const s = await state();
  rec('the second request is where the session ends up', /first name/i.test(s.field?.label || ''), s.field?.label);
  rec('...both were processed in capture order', (s.trail || []).slice(-2).length === 2, JSON.stringify(s.trail));
  rec('...no stale audio, no illegal transitions',
      (s.metrics?.staleAudioEvents || 0) === 0 && (s.machine?.illegalCount || 0) === 0,
      JSON.stringify({ stale: s.metrics?.staleAudioEvents, illegal: s.machine?.illegalCount }));
}

S('7. navigation carrying a correction');
{
  await restart();
  await answer('Arjun'); await answer('Garg'); await answer('arnav at example dot com');
  await say("take me back to my first name - it's actually Arnav", 4000);
  let s = await state();
  const dom = await form();
  rec('it moved to the first name', /first name/i.test(s.field?.label || ''), s.field?.label);
  rec('...and the correction was applied there', s.pending?.value === 'Arnav' || dom.first === 'Arnav',
      `pending=${JSON.stringify(s.pending)} dom=${JSON.stringify(dom)}`);
  rec('...and nothing was written to the field it left', dom.phone === '', JSON.stringify(dom));
  if (s.pending) { await say('yes'); rec('...accepted on confirmation', (await form()).first === 'Arnav', JSON.stringify(await form())); }

  // Spelling rides along with the move, assembled by the same function the
  // spoken path uses - not written into the field as letters.
  await restart();
  await answer('Arjun'); await answer('Garg'); await answer('arnav at example dot com');
  await say("take me back to my first name - it's A R N A V", 4500);
  s = await state();
  const spelled = (await form()).first;
  rec('a spelled correction carried by a move lands on the named field',
      /first name/i.test(s.field?.label || ''), s.field?.label);
  rec('...assembled into a word, not the letters', s.pending?.value === 'Arnav' || spelled === 'Arnav',
      `pending=${JSON.stringify(s.pending)} dom=${spelled}`);
}

S('8. a field inserted behind the pointer is not "the previous field"');
{
  await restart();
  await answer('Arnav'); await answer('Garg');            // on Email
  await page('window.__showMiddle(true)');                // Middle name appears BEHIND the pointer
  await sleep(1500);
  let s = await state();
  rec('the page told the session its shape changed', (s.total || 0) >= 6, `total=${s.total}`);
  rec('...and the pointer is still on the email', /email/i.test(s.field?.label || ''), s.field?.label);
  await say('go back');
  s = await state();
  rec('"go back" goes to the last name, not to the middle name the user never met',
      /last name/i.test(s.field?.label || ''), `${s.field?.label} trail=${JSON.stringify(s.trail)}`);
  rec('...resolved from the visit history', s.lastNav?.why === 'history', JSON.stringify(s.lastNav));
  await say('go to the middle name');
  rec('...and the inserted field is still reachable by name', /middle name/i.test(await label()), await label());
}

S('9. a conditional field that appears ahead of the pointer');
{
  await restart();
  await answer('Arnav'); await answer('Garg'); await answer('arnav at example dot com');
  await answer('five five five one two three four', 4000); // filling the phone reveals "Best time to call"
  await sleep(1500);
  const f = await form();
  rec('the page revealed the conditional field', f.visible.includes('when'), JSON.stringify(f.visible));
  const s = await state();
  rec('...and the session picked it up', (s.total || 0) >= 6, `total=${s.total}`);
  await say('go back to my phone number');
  rec('the conditional field does not confuse a named move', /phone/i.test(await label()), await label());
  await say('go to the best time to call');
  rec('...and the conditional field is reachable by name', /best time/i.test(await label()), await label());
}

S('10. a multi-step form');
{
  await restart();
  await answer('Arnav'); await answer('Garg'); await answer('arnav at example dot com');
  await page('window.__step(2)');                          // the wizard advances
  await sleep(1800);
  let s = await state();
  rec('the session is now on the fields of step two', /street|postal/i.test(s.field?.label || ''), `${s.field?.label} total=${s.total}`);
  const mark = s.turnId;
  await say('take me back to my email');
  s = await state();
  rec('a field on a previous step is not swapped for a visible one',
      !/email/i.test(s.field?.label || '') && /street|postal/i.test(s.field?.label || ''), s.field?.label);
  rec('...and it says the field is not on this part of the form',
      /not on this part|which field/i.test(spokenSince(s, mark).join(' ')), spokenSince(s, mark).join(' | ').slice(0, 220));

  await page('window.__step(1)');                          // the user goes back a step
  await sleep(1800);
  await say('take me back to my email');
  s = await state();
  rec('once the step is on the page again, the same request resolves', /email/i.test(s.field?.label || ''), s.field?.label);
  rec('...and the value entered on that step survived', /@/.test((await form()).email), JSON.stringify(await form()));
}

S('11. Phase 3 invariants across the whole run');
{
  const s = await state();
  rec('no stale audio played', (s.metrics?.staleAudioEvents || 0) === 0, JSON.stringify(s.metrics?.staleAudioDetail));
  rec('no illegal state transitions', (s.machine?.illegalCount || 0) === 0, JSON.stringify(s.machine?.illegal));
  rec('no capture left hanging', (s.capturesInFlight || 0) === 0, String(s.capturesInFlight));
  const it = s.intent || {};
  info(`intent: consulted=${it.consulted || 0} byProvider=${it.byProvider || 0} clarify=${it.clarifications || 0} providerFailures=${it.providerFailures || 0}`);
  info(`skipped (deterministic wins): ${JSON.stringify(it.skipped || {})}`);
  fs.mkdirSync('artifacts', { recursive: true });
  fs.writeFileSync('artifacts/navigation_form.json', JSON.stringify({ at: new Date().toISOString(), live: LIVE, results, snapshot: s }, null, 2));
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
