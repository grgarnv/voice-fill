// PRD Phase 1 exit criterion, verified rather than asserted:
//
//   "on 3 different real forms, the extension reads the first 5 fields aloud
//    with sensible questions, popup shows Rime as active provider."
//
// Reads aloud means audio actually arrived: for every field this records the
// contextId, the chunk count and the synthesised duration, so "spoke it" is a
// measurement and not a claim. Chrome runs WITHOUT the autoplay override, so
// the offscreen document has to earn its playback the way it will in the demo.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadEnv } from '../scripts/probe/lib/env.mjs';
loadEnv();
import { launchChrome, CDP, newPage, unpackedExtensionId } from './cdp.mjs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const results = [];
const rec = (name, ok, detail) => { results.push({ name, ok, detail }); return ok; };

const FORMS = [
  { name: 'selenium.dev web-form', url: 'https://www.selenium.dev/selenium/web/web-form.html', read: 5 },
  { name: 'httpbin pizza order',   url: 'https://httpbin.org/forms/post',                      read: 5 },
  { name: 'demoqa practice form',  url: 'https://demoqa.com/automation-practice-form',         read: 5 },
  { name: 'GitHub login (strict CSP)', url: 'https://github.com/login',                        read: 2 },
];

/* -------- extension copy: activeTab is what a real action click grants ----- */
const EXT_SRC = path.resolve('extension');
const EXT = path.resolve('artifacts/phase1-exit-extension');
fs.rmSync(EXT, { recursive: true, force: true });
fs.cpSync(EXT_SRC, EXT, { recursive: true });
{
  const mf = path.join(EXT, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
  m.host_permissions = [...(m.host_permissions || []), '<all_urls>'];
  fs.writeFileSync(mf, JSON.stringify(m, null, 2));
}

/* ------------------------------------------------------------- backend ---- */
const backend = spawn(process.execPath, ['backend/server.mjs'], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
// Always reap the backend, including on an early throw before the try block.
// A leaked proxy holding :8787 makes the NEXT run's selftest fail with 401
// against the wrong server, which is a confusing way to learn about it.
const reap = () => { try { backend.kill('SIGKILL'); } catch {} };
process.on('exit', reap);
process.on('uncaughtException', (e) => { reap(); console.error(e); process.exit(1); });
process.on('SIGINT', () => { reap(); process.exit(130); });

let backendLog = '';
backend.stdout.on('data', d => backendLog += d);
backend.stderr.on('data', d => backendLog += d);
const PORT = Number(process.env.PORT || 8787);
let up = false;
for (let i = 0; i < 60 && !up; i++) {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/health`); if (r.ok) up = true; } catch {}
  if (!up) await sleep(200);
}
if (!up) { console.error('backend did not start\n' + backendLog); process.exit(2); }
const providerHttp = await (await fetch(`http://127.0.0.1:${PORT}/provider`)).json();

/* -------------------------------------------------------------- chrome ---- */
const chrome = await launchChrome({ headless: true, extensionPath: EXT, autoplay: false });
const cdp = await new CDP(chrome.browserWsUrl).connect();
const extId = unpackedExtensionId(EXT);
for (let i = 0; i < 40; i++) {
  const { targetInfos } = await cdp.send('Target.getTargets');
  if (targetInfos.some(t => t.url.startsWith(`chrome-extension://${extId}/`))) break;
  await sleep(250);
}

const popup = await newPage(cdp);
await popup.goto(`chrome-extension://${extId}/popup/popup.html`, { waitMs: 800 });
await popup.eval(`chrome.storage.local.set({ backendUrl:'ws://localhost:${PORT}/speak', proxyToken:${JSON.stringify(process.env.PROXY_TOKEN || '')} })`, { awaitPromise: true });
const send = (m) => popup.eval(`chrome.runtime.sendMessage(${JSON.stringify(m)})`, { awaitPromise: true });

const transcripts = {};

try {
  // ---- F1.5 provider disclosure, read off the rendered popup --------------
  await send({ type: 'VF_CONNECT' });
  await sleep(2500);
  await popup.goto(`chrome-extension://${extId}/popup/popup.html`, { waitMs: 1500 });
  const badge = await popup.eval(`({
    speaker: document.getElementById('speaker').textContent.trim(),
    model:   document.getElementById('model').textContent.trim(),
    fmt:     document.getElementById('fmt').textContent.trim(),
    seg:     document.getElementById('seg').textContent.trim(),
    text:    document.querySelector('.badge').textContent.replace(/\\s+/g,' ').trim(),
  })`);
  rec('F1.5 popup discloses Rime as the active provider',
      /Speaking via Rime/.test(badge.text) && badge.model === (process.env.RIME_MODEL_ID || 'coda') && badge.speaker === providerHttp.speaker,
      JSON.stringify(badge));
  rec('F1.5 disclosure carries the real transport details, not a hardcoded string',
      badge.fmt.startsWith(providerHttp.audioFormat) && badge.seg === 'segment=never', JSON.stringify(badge));

  for (const form of FORMS) {
    const page = await newPage(cdp);
    let navOk = true;
    try { await page.goto(form.url, { waitMs: 3500, timeoutMs: 40000 }); }
    catch { navOk = false; }
    if (!navOk) { rec(`${form.name}: reachable`, false, 'navigation failed'); await page.close(); continue; }

    const tabs = await popup.eval(`chrome.tabs.query({}).then(t=>t.map(x=>({id:x.id,url:x.url||''})))`, { awaitPromise: true });
    const host = new URL(form.url).host;
    const tab = tabs.find(t => (t.url || '').includes(host));
    if (!tab) { rec(`${form.name}: tab located`, false, JSON.stringify(tabs.map(t => t.url.slice(0, 40)))); await page.close(); continue; }

    const started = await send({ type: 'VF_SESSION_START', tabId: tab.id });
    const spoken = [];
    const seen = new Set();

    // Walk the first N fields, recording what was said and whether audio came.
    for (let i = 0; i < form.read; i++) {
      // The LEDGER, not S.turn. Two Phase 3 changes invalidated the original
      // poll: a prompt now settles in LISTENING ("the user has the floor"),
      // never READY, and S.turn is cleared the instant an utterance finishes -
      // so `state === 'READY' && utterance.chunks > 0` can never both hold, and
      // every field reported `undefined chunks`. The ledger is the durable
      // record of what was actually spoken, which is what this test is about.
      let st = null, e = null;
      for (let k = 0; k < 60; k++) {
        st = await send({ type: 'VF_STATE' });
        e = (st?.ledger || []).filter(x => x.kind === 'prompt' && x.fieldId && x.fieldId === st?.field?.id).slice(-1)[0] || null;
        if (st?.ok && e && e.chunks > 0 && ['played', 'done', 'interrupted'].includes(e.status)) break;
        await sleep(400);
      }
      if (st?.field && !seen.has(st.field.id)) {
        seen.add(st.field.id);
        spoken.push({
          index: st.index, label: st.field.label, type: st.field.type,
          labelSource: st.field.labelSource,
          text: e?.text, chunks: e?.chunks,
          audioSec: e?.totalSec,
        });
      }
      if (i < form.read - 1) { await send({ type: 'VF_NEXT' }); await sleep(600); }
    }
    transcripts[form.name] = { url: form.url, scanned: started?.scanned, spoken };

    rec(`${form.name}: session started and scanned the page`,
        !!started?.ok && started.scanned > 0, JSON.stringify(started).slice(0, 140));
    rec(`${form.name}: read ${form.read} distinct fields aloud`,
        spoken.length === form.read, `read ${spoken.length}: ${spoken.map(s => s.label).join(' | ')}`);
    rec(`${form.name}: every field produced REAL Rime audio`,
        spoken.length > 0 && spoken.every(s => s.chunks > 0 && s.audioSec > 0.2),
        spoken.map(s => `${s.label}=${s.chunks}ch/${s.audioSec}s`).join(', '));
    rec(`${form.name}: every question is sensible (labelled, no junk, not trivially short)`,
        spoken.length > 0 && spoken.every(s => s.text && s.text.length > 12 && !/undefined|null|NaN|\[object/i.test(s.text)),
        spoken.map(s => s.text).join(' || ').slice(0, 200));

    await send({ type: 'VF_STOP' });
    await page.close();
  }
} catch (e) {
  rec('exit harness completed without throwing', false, String(e.message));
} finally {
  cdp.close(); await chrome.close(); backend.kill('SIGTERM');
}

console.log('\nPRD Phase 1 exit criterion - real forms, real Rime, no autoplay override\n');
for (const [name, t] of Object.entries(transcripts)) {
  console.log(`  ${name}  (${t.scanned} fields found)`);
  for (const s of t.spoken) {
    console.log(`     ${String(s.index + 1).padStart(2)}. [${s.type}] "${s.label}" via ${s.labelSource}`);
    console.log(`         spoke: ${String(s.text).replace(/\s+/g, ' ').slice(0, 96)}`);
    console.log(`         audio: ${s.chunks} chunks, ${s.audioSec}s`);
  }
  console.log('');
}
const pass = results.filter(r => r.ok).length;
const fail = results.filter(r => !r.ok);
for (const r of results) {
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
  if (!r.ok) console.log(`        got: ${String(r.detail).slice(0, 200)}`);
}
console.log(`\n  PASS ${pass}   FAIL ${fail.length}\n`);
fs.mkdirSync('artifacts', { recursive: true });
fs.writeFileSync('artifacts/phase1_exit.json', JSON.stringify({ provider: providerHttp, transcripts, results }, null, 2));
process.exit(fail.length ? 1 : 0);
