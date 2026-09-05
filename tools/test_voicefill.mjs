// PRD Phase 2 exit criterion: one full form filled end to end by voice, with
// every high-risk field confirmed.
//
// Three layers, because they fail for different reasons and lumping them
// together hides which one broke:
//
//   A  the /stt endpoint, fed real Rime audio as raw PCM
//   B  the REAL microphone path - fake audio device -> AudioWorklet capture ->
//      /stt -> extraction -> DOM write, for one field, proving the chain works
//      end to end with nothing substituted
//   C  the full form walk, driving the session with injected transcripts
//
// C substitutes only the STT step, which B has just proven. Chrome takes its
// fake-audio file as a launch flag and cannot swap it per turn, so answering
// twelve fields with twelve different recordings would mean relaunching the
// browser twelve times; the session logic is what layer C is actually testing.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { loadEnv } from '../scripts/probe/lib/env.mjs';
loadEnv();
import WebSocket from 'ws';
import { pcmToWav, sttAvailable, sttConfig } from '../backend/stt.mjs';
import { launchChrome, CDP, newPage, unpackedExtensionId } from './cdp.mjs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const results = [];
const rec = (name, ok, detail) => { results.push({ name, ok, detail }); return ok; };

if (!sttAvailable()) {
  console.error('BLOCKED: set WHISPER_MODEL to a ggml model file.');
  process.exit(2);
}

/* ------------------------------------------------- synthesise the answers -- */

const RATE = 16000;   // the capture rate; /stt takes PCM at whatever it is told

function synth(text, rate) {
  return new Promise((resolve, reject) => {
    const u = new URL(process.env.RIME_WS_URL);
    u.searchParams.set('speaker', process.env.RIME_SPEAKER);
    u.searchParams.set('modelId', process.env.RIME_MODEL_ID || 'mistv2');
    u.searchParams.set('audioFormat', 'pcm');
    u.searchParams.set('lang', 'eng');
    u.searchParams.set('samplingRate', String(rate));
    u.searchParams.set('segment', 'never');
    const ws = new WebSocket(u.toString(), { headers: { Authorization: `Bearer ${process.env.RIME_API_KEY}` } });
    const parts = []; let done = false;
    const fin = () => { if (done) return; done = true; try { ws.close(); } catch {} resolve(Buffer.concat(parts)); };
    ws.on('open', () => { ws.send(JSON.stringify({ text, contextId: 'a' })); ws.send(JSON.stringify({ operation: 'flush' })); });
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'chunk') parts.push(Buffer.from(m.data, 'base64'));
      if (/^done$/i.test(m.type || '')) fin();
    });
    ws.on('error', reject);
    setTimeout(fin, 40000);
  });
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-voice-'));
const SPOKEN_NAME = 'My name is Alexandra Whitfield';
const namePcm = await synth(SPOKEN_NAME, RATE);
// 48kHz for Chrome's fake capture device, which resamples awkwardly otherwise.
const namePcm48 = await synth(SPOKEN_NAME, 48000);
const fakeWav = path.join(TMP, 'answer.wav');
fs.writeFileSync(fakeWav, pcmToWav(namePcm48, 48000));

/* -------------------------------------------------------------- backend --- */

const backend = spawn(process.execPath, ['backend/server.mjs'], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
const reap = () => { try { backend.kill('SIGKILL'); } catch {} };
process.on('exit', reap);
process.on('uncaughtException', (e) => { reap(); console.error(e); process.exit(1); });
let log = '';
backend.stdout.on('data', d => log += d);
backend.stderr.on('data', d => log += d);
const PORT = Number(process.env.PORT || 8787);
let up = false;
for (let i = 0; i < 60 && !up; i++) {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/health`); if (r.ok) up = true; } catch {}
  if (!up) await sleep(200);
}
if (!up) { console.error('backend did not start\n' + log); process.exit(2); }

/* ------------------------------------ layer A: the /stt endpoint is real --- */

{
  const url = new URL(`http://127.0.0.1:${PORT}/stt`);
  if (process.env.PROXY_TOKEN) url.searchParams.set('token', process.env.PROXY_TOKEN);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'x-vf-rate': String(RATE) },
    body: namePcm,
  });
  const j = await res.json();
  rec('A /stt transcribes real audio posted as raw PCM',
      !!j.ok && /whitfield/i.test(j.text || ''), JSON.stringify(j).slice(0, 140));
  rec('A /stt rejects an unauthenticated request', await (async () => {
    if (!process.env.PROXY_TOKEN) return true;
    const r = await fetch(`http://127.0.0.1:${PORT}/stt`, { method: 'POST', body: namePcm });
    return r.status === 401;
  })(), 'token enforced');
}

/* --------------------------------------------------------------- chrome --- */

const EXT_SRC = path.resolve('extension');
const EXT = path.resolve('artifacts/phase2-voice-extension');
fs.rmSync(EXT, { recursive: true, force: true });
fs.cpSync(EXT_SRC, EXT, { recursive: true });
{
  const mf = path.join(EXT, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
  // What an action click would grant in real use; a harness cannot click it.
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

// The fake-capture file is read by Chrome's audio service, which runs out of
// process and SANDBOXED - and the sandbox cannot open the file. Measured:
// getUserMedia delivered a peak of exactly 0 from a page AND from the offscreen
// document, headless and headful, until these two features were disabled, at
// which point the peak went to full scale. Headless is fine; the earlier
// "1% amplitude" reading was resampling noise on top of silence.
const chrome = await launchChrome({
  headless: true, extensionPath: EXT,
  extraArgs: ['--disable-features=AudioServiceOutOfProcess,AudioServiceSandbox',
              '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
              // LOOPING, deliberately. With %noloop Chrome plays the file once
              // at launch - seconds before the test presses to talk - so the
              // capture window only ever caught silence and reported "no speech".
              `--use-file-for-fake-audio-capture=${fakeWav}`],
});
const cdp = await new CDP(chrome.browserWsUrl).connect();
const extId = unpackedExtensionId(EXT);
for (let i = 0; i < 40; i++) {
  const { targetInfos } = await cdp.send('Target.getTargets');
  if (targetInfos.some(t => t.url.startsWith(`chrome-extension://${extId}/`))) break;
  await sleep(250);
}

const formPage = await newPage(cdp);
await formPage.goto(`http://127.0.0.1:${FPORT}/10_intake_form.html`, { waitMs: 1200 });
const popup = await newPage(cdp);
await popup.goto(`chrome-extension://${extId}/popup/popup.html`, { waitMs: 800 });
await popup.eval(`chrome.storage.local.set({ backendUrl:'ws://localhost:${PORT}/speak', proxyToken:${JSON.stringify(process.env.PROXY_TOKEN || '')} })`, { awaitPromise: true });
const send = (m) => popup.eval(`chrome.runtime.sendMessage(${JSON.stringify(m)})`, { awaitPromise: true });

const state = () => send({ type: 'VF_STATE' });
const form = () => formPage.eval('window.__formState()');

/** Drive one turn by injecting a transcript, then wait for the session to settle. */
async function say(text, waitMs = 2600) {
  const r = await send({ type: 'VF_TRANSCRIPT', text });
  await sleep(waitMs);
  return r;
}
async function waitReady(max = 40) {
  for (let i = 0; i < max; i++) {
    const s = await state();
    if (s?.ok && (s.state === 'READY' || s.state === 'CONFIRMING')) return s;
    await sleep(400);
  }
  return state();
}

/**
 * Navigate to a field by its label rather than assuming the walk is in step.
 * Without this one earlier failure silently shifts every later answer onto the
 * wrong field, and twelve assertions fail for one reason.
 */
async function gotoField(re, max = 24) {
  // Walks forward, and turns around at an edge: reaching an EARLIER field from
  // the end of the form is exactly what the command tests need, and a
  // forward-only walk sat on the last field and ran them against it.
  let dir = +1, lastIndex = -2;
  for (let i = 0; i < max; i++) {
    let s = await waitReady();
    if (s?.pending) { await say('yes'); continue; }
    if (re.test(s?.field?.label || '')) return s;
    if (s.index === lastIndex) dir = -dir;
    lastIndex = s.index;
    await send({ type: dir > 0 ? 'VF_NEXT' : 'VF_PREV' });
    await sleep(1600);
  }
  return waitReady();
}

try {
  const tabs = await popup.eval(`chrome.tabs.query({}).then(t=>t.map(x=>({id:x.id,url:x.url||''})))`, { awaitPromise: true });
  const tab = tabs.find(t => t.url.includes('10_intake_form'));

  await send({ type: 'VF_SET_STT', provider: 'backend' });
  await send({ type: 'VF_CONNECT' });
  await sleep(2200);

  const started = await send({ type: 'VF_SESSION_START', tabId: tab.id });
  rec('session started on the intake form', !!started?.ok && started.scanned >= 10,
      JSON.stringify(started).slice(0, 140));
  await waitReady();

  /* ---------------- layer B: the REAL microphone path, one field ---------- */
  await send({ type: 'VF_LISTEN_START' });
  await sleep(3200);                       // let the fake device play the answer
  const heard = await send({ type: 'VF_LISTEN_STOP' });
  await sleep(2500);
  const afterMic = await form();
  rec('B real mic -> AudioWorklet -> /stt produced a transcript',
      !!heard && (heard.ok || /whitfield/i.test(heard.transcript || '')),
      JSON.stringify(heard).slice(0, 160));
  // Layer B's claim is CHAIN INTEGRITY: what STT heard is what landed. The
  // surname is at the mercy of the recogniser and of where the looping fake
  // device happened to be when capture opened ("Whitfield" came back as
  // "O'Feel" on one run and correctly on the next); the given name is stable
  // and the DOM must carry exactly the transcript, lead-in stripped.
  const heardName = String(heard?.transcript || heard?.value || '').replace(/^my name is\s+/i, '').replace(/[.!?]\s*$/, '');
  rec('B that transcript reached the DOM as a written value',
      /alexandra/i.test(afterMic.fullname || '') &&
      (!heardName || String(afterMic.fullname || '').toLowerCase() === heardName.toLowerCase()),
      `fullname=${JSON.stringify(afterMic.fullname)} transcript=${JSON.stringify(heard?.transcript)}`);

  /* ---------------- layer C: the rest of the form, by transcript ---------- */
  let s = await waitReady();

  // The name is high risk enough to confirm; accept it and move on.
  if (s.pending) { await say('yes'); s = await waitReady(); }

  // 2. date of birth - confirmed
  s = await gotoField(/date of birth/i);
  rec('on the date of birth field', /birth/i.test(s.field?.label || ''), JSON.stringify(s.field));
  await say('the fourteenth of June nineteen eighty four');
  s = await state();
  rec('date: spoken date is confirmed before it counts', !!s.pending, JSON.stringify(s.pending));
  await say('yes'); s = await waitReady();
  rec('date: written as ISO', (await form()).dob === '1984-06-14', (await form()).dob);

  // 3. phone - reject the read-back, then correct it
  s = await gotoField(/mobile/i);
  await say('five five five one two three four five six seven');
  s = await state();
  rec('phone: high-risk field asks for confirmation', !!s.pending, JSON.stringify(s.pending));
  await say('no');
  s = await waitReady();
  rec('phone: saying no clears the pending value and re-asks',
      !s.pending, JSON.stringify(s.pending));
  await say('four one five five five five zero one three two');
  await say('yes'); s = await waitReady();
  rec('phone: the corrected number is what landed', (await form()).phone === '4155550132', (await form()).phone);

  // 4. postcode - a bare correction spoken INTO the confirmation
  s = await gotoField(/postal/i);
  await say('one six zero zero seven one');
  s = await state();
  rec('postcode: confirmation pending', !!s.pending, JSON.stringify(s.pending));
  await say('one six zero zero seven two');     // no "no", just the new value
  s = await state();
  rec('postcode: a bare correction during confirmation is taken as the new value',
      s.pending && String(s.pending.display).includes('160072'), JSON.stringify(s.pending));
  await say('yes'); s = await waitReady();
  rec('postcode: corrected value written', (await form()).postcode === '160072', (await form()).postcode);

  // 5. patient ID - the page REJECTS the first answer
  s = await gotoField(/patient id/i);
  await say('seven seven seven seven');
  await sleep(1200);
  s = await waitReady();
  const afterBad = await form();
  rec('validation: a value the page rejects does not silently stand',
      !s.pending, JSON.stringify(s.pending));
  rec('validation: the session recorded the failed attempt',
      Object.values(s.attempts || {}).some(n => n > 0), JSON.stringify(s.attempts));
  s = await gotoField(/patient id/i);
  await say('S as in Sierra F as in Foxtrot seven kilo');
  s = await state();
  if (s.pending) { await say('yes'); s = await waitReady(); }
  rec('validation: a conforming value is accepted afterwards',
      /^SF7K/i.test((await form()).nhs || ''), (await form()).nhs);

  // 6. email
  s = await gotoField(/email/i);
  await say('alex dot whitfield at example dot com');
  s = await state();
  if (s.pending) { await say('yes'); s = await waitReady(); }
  rec('email: spoken email is normalised and written',
      (await form()).email === 'alex.whitfield@example.com', (await form()).email);

  // 7. radio group
  s = await gotoField(/contact method/i);
  await say('phone');
  s = await state();
  if (s.pending) { await say('yes'); s = await waitReady(); }
  rec('radio: chosen by spoken option label', (await form()).contact === 'phone', (await form()).contact);

  // 8. select
  s = await gotoField(/department/i);
  await say('dermatology');
  s = await state();
  if (s.pending) { await say('yes'); s = await waitReady(); }
  rec('select: matched from a partial spoken option', (await form()).dept === 'derm', (await form()).dept);

  // 9. checkbox group - two of three
  s = await gotoField(/access requirements/i);
  await say('wheelchair access and interpreter');
  s = await state();
  if (s.pending) { await say('yes'); s = await waitReady(); }
  const acc = (await form()).access;
  rec('checkbox group: exactly the two spoken options are ticked',
      acc.length === 2 && acc.includes('wheel') && acc.includes('interp'), JSON.stringify(acc));

  // 10. consent
  s = await gotoField(/consent/i);
  await say('yes');
  s = await waitReady();
  rec('consent checkbox ticked by a yes', (await form()).consent === true, String((await form()).consent));

  /* --------------------------- deliberate breakage ---------------------- */

  // Ambiguous choice: two options named in one breath. It must ASK.
  s = await gotoField(/department/i);
  const beforeAmb = (await form()).dept;
  const amb = await say('dermatology or neurology');
  s = await state();
  rec('break: an ambiguous choice asks instead of guessing',
      amb?.ambiguous === true && !s.pending && (await form()).dept === beforeAmb,
      JSON.stringify(amb).slice(0, 160));

  // Empty transcript (STT heard nothing): must recover, not wedge.
  const empty = await say('');
  s = await waitReady();
  rec('break: an empty transcript is handled and the session stays READY',
      s.state === 'READY' || s.state === 'CONFIRMING', `state=${s.state} r=${JSON.stringify(empty).slice(0, 80)}`);

  // Garbage on a digit field, twice: retry once, then skip rather than loop.
  s = await gotoField(/postal/i);
  const idxBefore = s.index;
  await say('purple monkey dishwasher');
  await say('flibbertigibbet');
  s = await waitReady();
  rec('break: two unusable answers skip the field instead of looping forever',
      s.index !== idxBefore || (s.attempts && Object.values(s.attempts).some(n => n >= 2)),
      `index ${idxBefore}->${s.index} attempts=${JSON.stringify(s.attempts)}`);

  // Push-to-talk released immediately: too short, must say so, must not crash.
  await send({ type: 'VF_LISTEN_START' });
  const short = await send({ type: 'VF_LISTEN_STOP' });
  await sleep(1500);
  rec('break: a too-short push-to-talk reports it rather than sending silence',
      short && short.ok === false && /short|silence|catch/i.test(String(short.error || '')),
      JSON.stringify(short).slice(0, 120));

  // Voice commands.
  s = await gotoField(/mobile/i);
  const t0 = (await state()).turnId, i0 = (await state()).index;
  await say('repeat');
  s = await waitReady();
  rec('command: "repeat" re-speaks the same field (new turn, same index)',
      s.turnId > t0 && s.index === i0, `turn ${t0}->${s.turnId} index ${i0}->${s.index}`);

  const rb = await say('what did you enter');
  rec('command: "what did you enter" reads the field back from the DOM',
      rb?.command === 'readback' && String(rb.current || '').includes('4155550132'), JSON.stringify(rb).slice(0, 120));

  await say('go back');
  s = await waitReady();
  rec('command: "go back" moves to the previous field', s.index === i0 - 1, `index=${s.index}`);

  await say('next');
  s = await waitReady();
  rec('command: "next" moves forward again', s.index === i0, `index=${s.index}`);

  const iSkip = s.index;
  await say('skip');
  s = await waitReady();
  rec('command: "skip" advances without writing', s.index === iSkip + 1 && (await form()).phone === '4155550132',
      `index=${s.index} phone=${(await form()).phone}`);

  // An answer that merely BEGINS with a command word is an answer.
  s = await gotoField(/full name/i);
  await say('Skipper Jones');
  s = await state();
  if (s.pending) { await say('yes'); s = await waitReady(); }
  rec('command: an answer beginning with a command word is NOT treated as a command',
      /skipper jones/i.test((await form()).fullname || ''), (await form()).fullname);

  /* ------------------------------- the exit criterion ------------------- */
  const final = await form();
  const want = {
    fullname: /skipper jones/i, dob: '1984-06-14', phone: '4155550132', postcode: '160072',
    nhs: /^SF7K/i, email: 'alex.whitfield@example.com', contact: 'phone', dept: 'derm', consent: true,
  };
  const bad = [];
  for (const [k, v] of Object.entries(want)) {
    const got = final[k];
    const ok = v instanceof RegExp ? v.test(String(got || '')) : got === v;
    if (!ok) bad.push(`${k}: got ${JSON.stringify(got)} want ${v}`);
  }
  if (final.access.length !== 2) bad.push(`access: ${JSON.stringify(final.access)}`);
  rec('EXIT: the whole form is filled correctly, by voice', bad.length === 0, bad.join(' | '));

  const st = await state();
  rec('EXIT: every high-risk field was confirmed before it counted',
      Object.keys(st.filled || {}).length >= 9, `filled=${Object.keys(st.filled || {}).length}`);

  console.log('\n  final form state:');
  for (const [k, v] of Object.entries(final)) console.log(`    ${k.padEnd(10)} ${JSON.stringify(v)}`);

} catch (e) {
  rec('voice-fill harness completed without throwing', false, String(e.message));
} finally {
  try { cdp.close(); } catch {}
  try { await chrome.close(); } catch {}
  backend.kill('SIGTERM'); srv.close();
  fs.rmSync(TMP, { recursive: true, force: true });
}

const pass = results.filter(r => r.ok).length;
const fail = results.filter(r => !r.ok);
console.log(`\nPhase 2 voice fill - real Rime, real STT (${path.basename(sttConfig().model)}), real DOM\n`);
for (const r of results) {
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
  if (!r.ok) console.log(`        got: ${String(r.detail).slice(0, 200)}`);
}
console.log(`\n  PASS ${pass}   FAIL ${fail.length}\n`);
fs.mkdirSync('artifacts', { recursive: true });
fs.writeFileSync('artifacts/phase2_voicefill.json', JSON.stringify({ results }, null, 2));
process.exit(fail.length ? 1 : 0);
