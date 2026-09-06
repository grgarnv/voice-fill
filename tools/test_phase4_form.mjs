// Phase 4 through the whole session, on a real form in a real browser.
//
// Chrome loads the extension, the offscreen document speaks real Rime audio,
// transcripts are injected on the exact path a spoken one takes, and every
// assertion reads the DOM or the session's own snapshot. What is under test is
// the SESSION's behaviour over the Phase 4 shapes: refreshing a dependent
// field, dropping a selection a rebuilt list no longer holds, keeping its place
// across a wizard step, explaining a rejection and refusing to retry forever.
//
// Injection rather than the fake microphone, for the reason
// tools/test_intent_form.mjs gives: what is under test is what the session
// DOES with an interpretation, and the microphone path is already proven by
// tools/test_bargein.mjs with real speech.
//
//   node tools/test_phase4_form.mjs
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

const EXT = path.resolve('artifacts/phase4-extension');
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
await formPage.goto(`http://127.0.0.1:${FPORT}/16_phase4.html`, { waitMs: 1200 });
const popup = await newPage(cdp);
await popup.goto(`chrome-extension://${extId}/popup/popup.html`, { waitMs: 800 });
await popup.eval(`chrome.storage.local.set({ backendUrl:'ws://localhost:${PORT}/speak', proxyToken:${JSON.stringify(process.env.PROXY_TOKEN || '')} })`, { awaitPromise: true });

const send = (m) => popup.eval(`chrome.runtime.sendMessage(${JSON.stringify(m)})`, { awaitPromise: true });
const state = () => send({ type: 'VF_STATE' });
const form = () => formPage.eval('window.__formState()');
const page = (js) => formPage.eval(js);
const label = async () => (await state())?.field?.label || '';
const spokenSince = (s, turnId) => (s.ledger || []).filter(e => e.turnId > turnId).map(e => e.text || '');

async function waitSettled(max = 40) {
  for (let i = 0; i < max; i++) {
    const s = await state();
    if (s?.ok && ['READY', 'LISTENING', 'CONFIRMING'].includes(s.state) && !s.utterance?.started) return s;
    if (s?.ok && ['LISTENING', 'CONFIRMING'].includes(s.state) && ['played', 'done', 'interrupted'].includes(s.utterance?.status)) return s;
    await sleep(400);
  }
  return state();
}
async function say(text, waitMs = 2800) {
  const r = await send({ type: 'VF_TRANSCRIPT', text });
  await sleep(waitMs);
  await waitSettled();
  return r;
}
/** Answer the current field and accept the read-back, however it is phrased. */
async function answer(text, waitMs = 3000) {
  await say(text, waitMs);
  let s = await state();
  if (s?.pending) { await say('yes', 2600); s = await state(); }
  return s;
}
/** Walk forward to the field whose label matches, up to a bound. */
async function goTo(re, max = 14) {
  for (let i = 0; i < max; i++) {
    if (re.test(await label())) return true;
    await send({ type: 'VF_NEXT' });
    await sleep(1400); await waitSettled();
  }
  return re.test(await label());
}

const tabs = await popup.eval(`chrome.tabs.query({}).then(t=>t.map(x=>({id:x.id,url:x.url||''})))`, { awaitPromise: true });
const tabId = tabs.find(t => (t.url || '').includes('16_phase4'))?.id;
if (tabId == null) { console.error('form tab not found'); process.exit(2); }

await send({ type: 'VF_SET_STT', provider: 'backend' });
await send({ type: 'VF_CONNECT' });
await sleep(2200);

const startSession = () => send({ type: 'VF_SESSION_START', tabId, speakSummary: false });
const restart = async () => {
  await send({ type: 'VF_STOP' }); await sleep(500);
  await page('window.__reset()');
  await sleep(700);
  await startSession(); await sleep(1500);
  return waitSettled();
};

/* ============================================================ scenarios === */

const started = await startSession();
rec('session started on the Phase 4 fixture', !!started?.ok, JSON.stringify(started).slice(0, 160));
rec('...on the country field', /country/i.test(await label()), await label());

S('1. F4.1  a dependent field is refreshed before it is asked');
{
  await restart();
  let s = await state();
  const dep = s.dependents || [];
  rec('the session knows the cascade', dep.length >= 2, JSON.stringify(dep));
  const st = dep.find(d => /state|province/i.test(d.label || d.id));
  rec('...and that the state list is empty to begin with',
      (st?.optionCount ?? 0) === 0 && st?.awaitingParent === true, JSON.stringify(st));

  await answer('United Kingdom');
  s = await state();
  rec('answering the country moved on to the state', /state|province/i.test(s.field?.label || ''), s.field?.label);
  rec('...and the state now has options to offer', (s.field?.optionCount || 0) === 2, JSON.stringify(s.field));

  await answer('England');
  s = await state();
  rec('answering the state moved on to the city', /city/i.test(s.field?.label || ''), s.field?.label);
  rec('...populated with the cities for England', (s.field?.optionCount || 0) === 3, JSON.stringify(s.field));
  await answer('Bristol');
  rec('the whole cascade is written to the page',
      (await form()).country === 'GB' && (await form()).state === 'England' && (await form()).city === 'Bristol',
      JSON.stringify(await form()));
}

S('2. F4.1  changing an earlier answer invalidates the stale selection');
{
  // The cascade above is still filled. Going back and changing the country
  // makes "England" an answer the form can no longer hold.
  await say('go back to the country field');
  rec('back on the country field', /country/i.test(await label()), await label());
  await answer('United States', 3400);
  await sleep(900);
  const s = await state();
  const dom = await form();
  rec('the page rebuilt the state list', dom.stateOptions === 2, JSON.stringify(dom));
  const staleState = (s.stale || []).find(x => /state|province/i.test(x.label));
  rec('the session DROPPED the stale state selection',
      !!staleState && !s.answered?.[staleState.fieldId] && s.filled?.[staleState.fieldId] === undefined,
      JSON.stringify({ stale: s.stale, answered: s.answered, filled: s.filled }));
  rec('...and recorded which selection it dropped and why',
      (s.stale || []).some(x => /state|province/i.test(x.label) && /England/i.test(x.dropped)),
      JSON.stringify(s.stale));
  rec('...and the city selection went with it',
      (s.stale || []).some(x => /city/i.test(x.label)), JSON.stringify(s.stale));
  rec('nothing was invented in their place', !dom.state && !dom.city, JSON.stringify(dom));

  // The re-ask is legitimate: the answer is genuinely gone. It must not be
  // counted as the re-ask failure the PRD forbids, because the field is no
  // longer answered.
  await say('California');
  rec('the state can be answered again from the new list',
      /california/i.test(JSON.stringify(await state()).slice(0, 4000)) || (await form()).state === 'California',
      JSON.stringify(await form()));
}

S('3. F4.5 / F4.4  masked and date fields, spoken');
{
  await restart();
  await goTo(/phone/i);
  rec('reached the phone field', /phone/i.test(await label()), await label());
  await answer('five five five one two three four five six seven', 3600);
  rec('a spoken phone number lands in the page\'s own format',
      (await form()).phone === '(555) 123-4567', (await form()).phone);

  await goTo(/start date/i);
  await answer('the fourteenth of June two thousand twenty six', 3800);
  rec('a spoken date reaches a native date input as ISO', (await form()).start === '2026-06-14', (await form()).start);

  await goTo(/expiry/i);
  await answer('the fourteenth of June two thousand twenty six', 3800);
  rec('...and reaches a month input as year and month only', (await form()).expiry === '2026-06', (await form()).expiry);

  await goTo(/renewal/i);
  await answer('the fourteenth of June two thousand twenty six', 3800);
  rec('...and a masked text date in the order the page asks for',
      (await form()).renewal === '06/14/2026', (await form()).renewal);
}

S('4. F4.4  a date with no year is asked about, not guessed');
{
  await restart();
  await goTo(/start date/i);
  const mark = (await state()).turnId;
  await say('March the fifth', 3400);
  const s = await state();
  rec('nothing was written', !(await form()).start, JSON.stringify(await form()));
  rec('...and the session asked for the year specifically',
      /year/i.test(spokenSince(s, mark).join(' ')), spokenSince(s, mark).join(' | ').slice(0, 220));
  rec('...and stayed on the field', /start date/i.test(s.field?.label || ''), s.field?.label);
}

S('5. F4.3  a rejected value is explained, retried once, then let go');
{
  await restart();
  await page('window.__step(2)');
  await sleep(1600);
  await goTo(/coupon/i);
  rec('reached the coupon field', /coupon/i.test(await label()), await label());

  let mark = (await state()).turnId;
  await answer('WINTER25', 3600);
  let s = await state();
  rec('the page\'s rejection was read out in the page\'s own words',
      /expired/i.test(spokenSince(s, mark).join(' ')), spokenSince(s, mark).join(' | ').slice(0, 220));
  rec('...and the session came back to the same field', /coupon/i.test(s.field?.label || ''), s.field?.label);
  rec('...and counted the attempt', (s.attempts?.[s.field?.id] || 0) >= 1, JSON.stringify(s.attempts));

  // The same value again. Repeating the question forever is the trap the PRD
  // forbids; the session must give up on this field and move on.
  mark = (await state()).turnId;
  await answer('WINTER25', 3600);
  s = await state();
  rec('offering the same rejected value again does not loop',
      !/coupon/i.test(s.field?.label || '') || (s.attempts?.[s.field?.id] || 0) >= 2,
      `${s.field?.label} attempts=${JSON.stringify(s.attempts)}`);
  rec('...and the session says it is leaving the field for now',
      /leave this one|come back to it|skip this one/i.test(spokenSince(s, mark).join(' ')),
      spokenSince(s, mark).join(' | ').slice(0, 240));
  rec('...and remembers which values the page refused',
      Object.values(s.rejected || {}).some(v => v.includes('WINTER25')), JSON.stringify(s.rejected));
}

S('6. F4.3  the form-wide sweep goes to the field the page is complaining about');
{
  const before = await label();
  const r = await send({ type: 'VF_CHECK_FORM' });
  await sleep(2600); await waitSettled();
  const s = await state();
  rec('the sweep ran and found the rejected coupon',
      (s.invalidSweep?.count || 0) >= 1, JSON.stringify(s.invalidSweep));
  rec('...and moved the session to that field', /coupon/i.test(s.field?.label || ''),
      `${before} -> ${s.field?.label} ${JSON.stringify(r).slice(0, 120)}`);
  await answer('SPRING26', 3600);
  rec('a value the page accepts clears it', (await form()).coupon === 'SPRING26' && !(await form()).couponError,
      JSON.stringify(await form()));
}

S('7. F4.7  custom controls answered by voice');
{
  await restart();
  await page('window.__step(2)');
  await sleep(1800);
  await send({ type: 'VF_RESCAN' });
  await sleep(900);

  await goTo(/support plan/i);
  rec('the custom select is a field the session asks about', /support plan/i.test(await label()), await label());
  await answer('Professional', 3600);
  rec('...and a spoken option is opened, picked and verified', (await form()).plan === 'pro', (await form()).plan);

  await goTo(/billing tier/i);
  await answer('Annual', 3400);
  rec('a custom radio group takes a spoken option', (await form()).tier === 'annual', (await form()).tier);

  await goTo(/contact channels/i);
  await answer('email and post', 3600);
  rec('a custom checkbox group takes two spoken options',
      JSON.stringify((await form()).channels) === JSON.stringify(['email', 'post']),
      JSON.stringify((await form()).channels));

  await send({ type: 'VF_PREV' }); await sleep(1600); await waitSettled();
  await goTo(/contact channels/i);
  await answer('all of them', 3600);
  rec('"all of them" takes every option in the group',
      JSON.stringify((await form()).channels) === JSON.stringify(['email', 'sms', 'post']),
      JSON.stringify((await form()).channels));
}

S('8. F4.2  a wizard step replaces the form without losing the session');
{
  await restart();
  await answer('United Kingdom');
  await goTo(/phone/i);
  await answer('five five five one two three four five six seven', 3600);
  const answeredBefore = Object.keys((await state()).answered || {}).length;
  const filledBefore = { ...(await state()).filled };

  await page('window.__step(2)');
  await sleep(2200); await waitSettled();
  let s = await state();
  rec('the session noticed the form replaced itself', (s.steps || 0) >= 1, `steps=${s.steps}`);
  rec('...and is on a field of the NEW step, not at a stale index',
      /speed|extras|plan|tier|channel|coupon/i.test(s.field?.label || ''), s.field?.label);
  rec('...on the first thing there it has not answered',
      /delivery speed/i.test(s.field?.label || ''), s.field?.label);
  rec('step 1\'s answers were not forgotten',
      Object.keys(s.answered || {}).length >= answeredBefore
      && JSON.stringify(s.filled) === JSON.stringify(filledBefore),
      `${Object.keys(s.answered || {}).length} vs ${answeredBefore}`);
  rec('...and it still knows what those fields were called',
      Object.values(s.labels || {}).some(l => /country/i.test(l)), JSON.stringify(Object.values(s.labels || {})).slice(0, 200));

  // A field on the previous step is named and refused, not swapped for a
  // visible one. That is the Phase 3 behaviour, unchanged.
  const mark = s.turnId;
  await say('take me back to my phone number');
  s = await state();
  rec('a field on the previous step is refused by name, not guessed at',
      !/phone/i.test(s.field?.label || '')
      && /not on this part|which field/i.test(spokenSince(s, mark).join(' ')),
      `${s.field?.label} | ${spokenSince(s, mark).join(' | ').slice(0, 200)}`);

  await answer('express', 3400);
  rec('the new step fills normally', (await form()).speed === 'express', (await form()).speed);

  await page('window.__step(1)');
  await sleep(2200); await waitSettled();
  await say('take me back to my phone number');
  s = await state();
  rec('once the step is back, the same request resolves', /phone/i.test(s.field?.label || ''), s.field?.label);
  rec('...with the value entered on that step still in the page',
      (await form()).phone === '(555) 123-4567', (await form()).phone);
  rec('...and the session reads it back rather than erasing it',
      s.filled?.[s.field?.id] != null, JSON.stringify(s.filled));
}

S('9. Phase 3 invariants across the whole run');
{
  const s = await state();
  rec('no stale audio played', (s.metrics?.staleAudioEvents || 0) === 0, JSON.stringify(s.metrics?.staleAudioDetail));
  rec('no illegal state transitions', (s.machine?.illegalCount || 0) === 0, JSON.stringify(s.machine?.illegal));
  rec('no capture left hanging', (s.capturesInFlight || 0) === 0, String(s.capturesInFlight));
  info(`barge-ins ${s.metrics?.bargeIns} · stop p50 ${s.metrics?.stopLatencyP50}ms · re-asks ${s.metrics?.reasks}`);
  info(`steps ${s.steps} · stale selections dropped ${(s.stale || []).length} · rejected values ${JSON.stringify(s.rejected)}`);
  fs.mkdirSync('artifacts', { recursive: true });
  fs.writeFileSync('artifacts/phase4_form.json', JSON.stringify({ at: new Date().toISOString(), live: LIVE, results, snapshot: s }, null, 2));
}

/* ------------------------------------------------------------------ done -- */
const pass = results.filter(r => r.ok).length, fail = results.filter(r => !r.ok);
console.log(`\n  PASS ${pass}   FAIL ${fail.length}${LIVE ? '' : '   (provider not configured)'}\n`);
try { await cdp.close(); } catch {}
try { await chrome.close(); } catch {}
srv.close(); reap();
process.exit(fail.length ? 1 : 0);
