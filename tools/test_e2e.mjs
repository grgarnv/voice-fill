// Phase 1 end-to-end: popup -> background -> content scan -> offscreen -> proxy
// -> REAL Rime /ws3 -> pcm chunks -> Web Audio playback.
//
// Driven through the popup page, not by poking internals, so the path under
// test is the one a user actually takes. Fixtures are served over http because
// Chrome does not run content scripts on file:// without the "allow file
// access" flag, which is off for unpacked extensions.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadEnv } from '../scripts/probe/lib/env.mjs';
loadEnv();
import { launchChrome, CDP, newPage, unpackedExtensionId } from './cdp.mjs';

const results = [];
const rec = (name, ok, detail) => { results.push({ name, ok, detail }); return ok; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* -------------------------------------------------- fixture http server --- */

const fixtureServer = http.createServer((req, res) => {
  const f = path.join('eval/fixtures', decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, ''));
  if (!fs.existsSync(f) || !fs.statSync(f).isFile()) { res.statusCode = 404; return res.end('nope'); }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(fs.readFileSync(f));
});
await new Promise(r => fixtureServer.listen(0, '127.0.0.1', r));
const FIXTURE_PORT = fixtureServer.address().port;

/* ------------------------------------------------------------- backend ---- */

const backend = spawn(process.execPath, ['backend/server.mjs'], {
  stdio: ['ignore', 'pipe', 'pipe'], env: process.env,
});
// Always reap the backend, including on an early throw before the try block.
// A leaked proxy holding :8787 makes the NEXT run's selftest fail with 401
// against the wrong server, which is a confusing way to learn about it.
const reap = () => { try { backend.kill('SIGKILL'); } catch {} };
process.on('exit', reap);
process.on('uncaughtException', (e) => { reap(); console.error(e); process.exit(1); });
process.on('SIGINT', () => { reap(); process.exit(130); });

let backendLog = '';
backend.stdout.on('data', d => { backendLog += d.toString(); });
backend.stderr.on('data', d => { backendLog += d.toString(); });

const PORT = Number(process.env.PORT || 8787);
let up = false;
for (let i = 0; i < 60; i++) {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/health`); if (r.ok) { up = true; break; } } catch {}
  await sleep(200);
}
if (!up) { console.error('backend did not start:\n' + backendLog); process.exit(2); }
const provider = await (await fetch(`http://127.0.0.1:${PORT}/provider`)).json();

/* -------------------------------------------------------------- chrome ---- */

/**
 * The shipping manifest asks for `activeTab`, not broad host permissions: in
 * real use the user's click on the extension action grants access to the tab
 * they are on, which is the minimum this needs and the right thing to ship.
 *
 * A harness cannot produce that click, and without host access
 * chrome.tabs.sendMessage cannot reach the content script - so the test runs a
 * COPY of the extension with the loopback fixture origin added. The only
 * difference from what ships is the permission an action click would grant
 * anyway; every line of code under test is identical.
 */
const EXT_SRC = path.resolve('extension');
const EXT = path.resolve('artifacts/phase1-e2e-extension');
fs.rmSync(EXT, { recursive: true, force: true });
fs.cpSync(EXT_SRC, EXT, { recursive: true });
{
  const mf = path.join(EXT, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
  m.host_permissions = [...(m.host_permissions || []), 'http://127.0.0.1:*/*', 'http://localhost:*/*'];
  fs.writeFileSync(mf, JSON.stringify(m, null, 2));
}
const chrome = await launchChrome({ headless: true, extensionPath: EXT });
const cdp = await new CDP(chrome.browserWsUrl).connect();

// Derived from the path, then confirmed against a live target - Chrome's own
// component extensions also expose a service worker named background.js, so
// "the first extension target" is not a safe way to identify ours.
const extId = unpackedExtensionId(EXT);
let swSeen = false;
for (let i = 0; i < 40 && !swSeen; i++) {
  const { targetInfos } = await cdp.send('Target.getTargets');
  swSeen = targetInfos.some(x => x.url.startsWith(`chrome-extension://${extId}/`));
  if (!swSeen) await sleep(250);
}
if (!swSeen) {
  const { targetInfos } = await cdp.send('Target.getTargets');
  console.error(`VoiceFill service worker never appeared for id ${extId}. Targets:\n` +
    targetInfos.map(t => `  ${t.type} ${t.url}`).join('\n'));
  process.exit(2);
}

const fixtureUrl = `http://127.0.0.1:${FIXTURE_PORT}/03_choices.html`;
const formPage = await newPage(cdp);
await formPage.goto(fixtureUrl, { waitMs: 1200 });

const popup = await newPage(cdp);
await popup.goto(`chrome-extension://${extId}/popup/popup.html`, { waitMs: 900 });

// The proxy requires its shared token; the extension reads it from storage.
await popup.eval(`chrome.storage.local.set({
  backendUrl: 'ws://localhost:${PORT}/speak',
  proxyToken: ${JSON.stringify(process.env.PROXY_TOKEN || '')}
})`, { awaitPromise: true });

const send = (msg) => popup.eval(`chrome.runtime.sendMessage(${JSON.stringify(msg)})`, { awaitPromise: true });

/* --------------------------------------------------------------- tests ---- */

try {
  rec('e2e: extension loaded and service worker is alive', !!extId, extId);

  const ping = await send({ type: 'VF_PING' });
  rec('e2e: background responds', !!ping?.ok, JSON.stringify(ping));

  // Find the form tab's real id, then drive the session at it explicitly.
  const tabs = await popup.eval(`chrome.tabs.query({}).then(t => t.map(x => ({id:x.id,url:x.url||''})))`, { awaitPromise: true });
  const formTab = tabs.find(t => (t.url || '').includes('03_choices'));
  rec('e2e: form tab located', !!formTab, JSON.stringify(tabs.map(t => t.url.slice(0, 50))));

  // Popup-open prewarm, the real trigger, before any session exists.
  const warm = await send({ type: 'VF_CONNECT' });
  rec('e2e: popup-open prewarm connects and warms the socket',
      !!warm?.ok && warm.prewarmed === true, JSON.stringify(warm).slice(0, 160));
  await sleep(2500);
  const warmState = await send({ type: 'VF_STATE' });
  rec('e2e: prewarm audio was discarded by contextId, never played',
      (warmState?.droppedStaleChunks || 0) > 0 && (warmState?.playedChunks || 0) === 0,
      `dropped=${warmState?.droppedStaleChunks} played=${warmState?.playedChunks} contexts=${JSON.stringify(warmState?.contextsSeen)}`);

  const started = await send({ type: 'VF_SESSION_START', tabId: formTab.id });
  rec('e2e: session starts and the page is scanned through the content script',
      !!started?.ok && started.scanned >= 8, JSON.stringify(started).slice(0, 200));

  // Wait for the QUEUE TO DRAIN, not merely for the first audio: the summary
  // and the first question are two serialised utterances, and sampling at the
  // first chunk catches only the summary.
  const turnCount = (s) => Object.keys(s?.contextsSeen || {}).filter(k => k.startsWith('turn-')).length;
  let st = null;
  for (let i = 0; i < 75; i++) {
    st = await send({ type: 'VF_STATE' });
    if (st?.ok && st.connected && turnCount(st) >= 2 && (st.state === 'READY' || st.state === 'LISTENING')) break;
    await sleep(400);
  }

  rec('e2e: WebSocket to the proxy is connected', !!st?.connected, st?.lastError || 'no error');
  rec('e2e: provider disclosure reaches the popup from the backend',
      !!st?.provider && st.provider.active === 'rime' && st.provider.model === (process.env.RIME_MODEL_ID || 'coda') && !!st.provider.speaker,
      JSON.stringify(st?.provider));
  rec('e2e: disclosure matches what the proxy actually opened the socket with',
      st?.provider?.speaker === provider.speaker && st?.provider?.audioFormat === provider.audioFormat,
      `popup=${st?.provider?.speaker}/${st?.provider?.audioFormat} backend=${provider.speaker}/${provider.audioFormat}`);
  rec('e2e: segment=never is in force (Phase 0 constraint 1)',
      st?.provider?.segment === 'never', String(st?.provider?.segment));

  // The actual proof that Rime audio arrived and was scheduled for playback.
  rec('e2e: REAL Rime pcm chunks decoded and scheduled', (st?.playedChunks || 0) > 0,
      `playedChunks=${st?.playedChunks} scheduled=${st?.utterance?.scheduledSec}s`);
  rec('e2e: word timestamps received (the Phase 3 ledger input)',
      (st?.lastWordTimestampCount || 0) > 0, `count=${st?.lastWordTimestampCount}`);
  // The regression that motivated the queue: three utterances sent back to back
  // make Rime discard all but the last, so the summary is never heard.
  rec('e2e: summary AND first question both synthesise (queue, not back-to-back)',
      Object.keys(st?.contextsSeen || {}).filter(k => k.startsWith('turn-')).length >= 2,
      `contexts=${JSON.stringify(st?.contextsSeen)}`);

  const first = st?.field;
  rec('e2e: session sits on field 1 with a resolved label',
      st?.index === 0 && !!first?.label, JSON.stringify(first));

  // ---- F1.6 Next / Previous / Repeat --------------------------------------
  const turnBefore = st.turnId;
  const nx = await send({ type: 'VF_NEXT' });
  await sleep(1200);
  const st2 = await send({ type: 'VF_STATE' });
  rec('F1.6 Next: advances the pointer and speaks a new turn',
      nx?.ok && st2.index === 1 && st2.turnId > turnBefore,
      `index ${st?.index}->${st2.index}, turn ${turnBefore}->${st2.turnId}`);
  rec('F1.6 Next: the new field is a different question',
      st2.field?.id !== first?.id, `${first?.id} -> ${st2.field?.id}`);

  const pv = await send({ type: 'VF_PREV' });
  await sleep(1200);
  const st3 = await send({ type: 'VF_STATE' });
  rec('F1.6 Previous: returns to the earlier field',
      pv?.ok && st3.index === 0 && st3.field?.id === first?.id,
      `index -> ${st3.index}, field ${st3.field?.id}`);

  const turnBeforeRepeat = st3.turnId;
  const rp = await send({ type: 'VF_REPEAT' });
  await sleep(1200);
  const st4 = await send({ type: 'VF_STATE' });
  rec('F1.6 Repeat: same field, new turn id (the utterance is re-synthesised)',
      rp?.ok && st4.index === 0 && st4.turnId > turnBeforeRepeat,
      `index ${st4.index}, turn ${turnBeforeRepeat}->${st4.turnId}`);

  // ---- Previous at the first field must not run off the start -------------
  await send({ type: 'VF_PREV' });
  await sleep(900);
  const st5 = await send({ type: 'VF_STATE' });
  rec('F1.6 Previous at the first field stays put and says so',
      st5.index === 0, `index=${st5.index}`);

  // ---- the focus ring actually moved on the page --------------------------
  const ring = await formPage.eval(`(() => {
    const r = document.querySelector('[data-voicefill-ring]');
    if (!r) return { present: false };
    return { present: true, display: r.style.display, top: r.style.top, width: r.style.width };
  })()`);
  rec('F1.5 focus ring is drawn on the page and positioned',
      ring.present && ring.display === 'block' && parseFloat(ring.width) > 0, JSON.stringify(ring));

  // ---- dynamic DOM: the SPA fixture must update the live session ----------
  const spaUrl = `http://127.0.0.1:${FIXTURE_PORT}/06_spa_dynamic.html`;
  const spaPage = await newPage(cdp);
  await spaPage.goto(spaUrl, { waitMs: 2500 });
  const spaTabs = await popup.eval(`chrome.tabs.query({}).then(t=>t.map(x=>({id:x.id,url:x.url||''})))`, { awaitPromise: true });
  const spaTab = spaTabs.find(t => (t.url || '').includes('06_spa_dynamic'));
  const spaStart = await send({ type: 'VF_SESSION_START', tabId: spaTab.id });
  rec('dynamic: SPA fields that mount after load are scanned',
      spaStart?.ok && spaStart.scanned === 3, JSON.stringify(spaStart).slice(0, 160));

  // Add a field live and confirm the session count follows it.
  await spaPage.eval(`(() => { const d=document.createElement('div');
    d.innerHTML='<label for="late">Late arriving field</label><input id="late" name="late_field">';
    document.getElementById('root').appendChild(d); })()`);
  await sleep(1400);
  const st6 = await send({ type: 'VF_STATE' });
  rec('dynamic: MutationObserver pushes the new field into the live session',
      st6.total === 4, `total=${st6.total}`);

  await send({ type: 'VF_STOP' });
} catch (e) {
  rec('e2e: harness completed without throwing', false, String(e.message));
} finally {
  cdp.close(); await chrome.close();
  backend.kill('SIGTERM');
  fixtureServer.close();
}

const pass = results.filter(r => r.ok).length;
const fail = results.filter(r => !r.ok);
console.log(`\nPhase 1 end-to-end - real Rime through the proxy\n`);
for (const r of results) {
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
  if (!r.ok) console.log(`        got: ${String(r.detail).slice(0, 200)}`);
}
console.log(`\n  PASS ${pass}   FAIL ${fail.length}\n`);
fs.mkdirSync('artifacts', { recursive: true });
fs.writeFileSync('artifacts/phase1_e2e.json', JSON.stringify({ provider, results }, null, 2));
process.exit(fail.length ? 1 : 0);
