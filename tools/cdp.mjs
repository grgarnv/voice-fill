// Minimal Chrome DevTools Protocol client.
//
// The Phase 1 scanner is nothing but DOM semantics - offsetParent, computed
// style, shadow roots, label association. A JS DOM shim would be testing the
// shim's opinion of those rules, not Chrome's, and every interesting bug lives
// exactly where those two differ. So the harness drives real Chrome.
//
// `ws` is already a dependency (the backend proxy uses it); nothing new is
// added for testing.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

export const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
];

/** PATH is not where Chrome lives on macOS - check the app bundles too. */
export function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  for (const p of CHROME_CANDIDATES) if (fs.existsSync(p)) return p;
  return null;
}

/**
 * Chrome stable 137+ silently ignores --load-extension: it was removed as a
 * malware-persistence vector. Verified here on Chrome 152 - headless AND
 * headful, with --enable-unsafe-extension-debugging and with
 * --disable-features=DisableLoadExtensionCommandLineSwitch. No target for the
 * extension ever appears and nothing is logged.
 *
 * Chrome for Testing keeps the flag working, which is what it exists for. Any
 * test that needs the extension actually loaded must use that binary.
 *
 *   npx @puppeteer/browsers install chrome@stable --path <dir>
 *   export CHROME_TEST_PATH="<dir>/chrome/mac_arm-<ver>/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
 */
export function findChromeForTesting() {
  if (process.env.CHROME_TEST_PATH && fs.existsSync(process.env.CHROME_TEST_PATH)) return process.env.CHROME_TEST_PATH;
  const roots = [
    process.env.CHROME_TEST_DIR,
    path.join(process.env.CLAUDE_JOB_DIR || '', 'tmp', 'browsers'),
    path.join(os.homedir(), '.cache', 'puppeteer'),
    path.join(process.cwd(), '.cache', 'browsers'),
  ].filter(Boolean);
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const stack = [root];
    while (stack.length) {
      const d = stack.pop();
      let entries = [];
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) { if (stack.length < 400) stack.push(full); }
        else if (/^Google Chrome for Testing$|^chrome$/.test(e.name)) {
          try { fs.accessSync(full, fs.constants.X_OK); return full; } catch {}
        }
      }
    }
  }
  return null;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Chrome derives an unpacked extension's id from its absolute path: SHA-256,
 * first 16 bytes, each nibble mapped 0-15 onto a-p. Computing it beats scanning
 * targets for "a service worker whose url ends in background.js" - Chrome ships
 * component extensions that match that description too, and picking one of
 * those yields a valid-looking id that resolves to the wrong extension.
 */
export function unpackedExtensionId(absPath) {
  const h = crypto.createHash('sha256').update(absPath, 'utf8').digest();
  let id = '';
  for (let i = 0; i < 16; i++) {
    id += String.fromCharCode(97 + (h[i] >> 4));
    id += String.fromCharCode(97 + (h[i] & 15));
  }
  return id;
}

export async function launchChrome({ headless = true, extensionPath = null, port = 0, extraArgs = [], autoplay = true } = {}) {
  // Loading an extension requires Chrome for Testing; stable ignores the flag.
  const bin = extensionPath ? (findChromeForTesting() || null) : findChrome();
  if (!bin && extensionPath) {
    throw new Error(
      'Loading an unpacked extension needs Chrome for Testing (Chrome stable 137+ ignores --load-extension).\n' +
      '  npx @puppeteer/browsers install chrome@stable --path .cache/browsers\n' +
      'then set CHROME_TEST_PATH, or CHROME_TEST_DIR to the download directory.');
  }
  if (!bin) throw new Error('No Chrome binary found. Set CHROME_PATH.');
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-chrome-'));
  const chosenPort = port || (9500 + Math.floor(Math.random() * 400));

  const args = [
    `--remote-debugging-port=${chosenPort}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-sync', '--disable-features=Translate,MediaRouter',
    // Omitting this is the honest test: an offscreen document created with
    // reason AUDIO_PLAYBACK must be able to play without the override.
    ...(autoplay ? ['--autoplay-policy=no-user-gesture-required'] : []),
    ...extraArgs,
  ];
  // --headless=new keeps extension support, which old headless did not have.
  if (headless) args.push('--headless=new', '--disable-gpu');
  if (extensionPath) args.push(`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`);
  args.push('about:blank');

  const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', d => { stderr += d.toString(); });

  // Poll /json/version rather than parsing stderr: the banner format has
  // changed between Chrome releases, the HTTP endpoint has not.
  const deadline = Date.now() + 30000;
  let version = null;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${chosenPort}/json/version`);
      if (r.ok) { version = await r.json(); break; }
    } catch {}
    if (proc.exitCode !== null) throw new Error(`Chrome exited ${proc.exitCode}: ${stderr.slice(-400)}`);
    await sleep(150);
  }
  if (!version) { try { proc.kill('SIGKILL'); } catch {} ; throw new Error(`Chrome did not expose CDP on :${chosenPort}. ${stderr.slice(-400)}`); }

  return {
    proc, port: chosenPort, version, userDataDir,
    browserWsUrl: version.webSocketDebuggerUrl,
    async close() {
      try { proc.kill('SIGTERM'); } catch {}
      await sleep(300);
      try { proc.kill('SIGKILL'); } catch {}
      try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
    },
  };
}

/** One CDP connection, multiplexed over flat sessions. */
export class CDP {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; this.pending = new Map(); this.handlers = new Map(); }

  connect() {
    return new Promise((res, rej) => {
      // Chrome refuses CDP frames over ~1MB by default on the client side; raise
      // the limit so a big Runtime.evaluate payload is not silently truncated.
      this.ws = new WebSocket(this.wsUrl, { maxPayload: 256 * 1024 * 1024 });
      this.ws.on('open', () => res(this));
      this.ws.on('error', rej);
      this.ws.on('message', (raw) => {
        let m; try { m = JSON.parse(raw.toString()); } catch { return; }
        if (m.id && this.pending.has(m.id)) {
          const { resolve, reject } = this.pending.get(m.id);
          this.pending.delete(m.id);
          m.error ? reject(new Error(`${m.error.message} (${m.error.code})`)) : resolve(m.result);
        } else if (m.method) {
          for (const [key, fn] of this.handlers) {
            if (key === m.method || key === `${m.sessionId}:${m.method}`) fn(m.params, m.sessionId);
          }
        }
      });
    });
  }

  send(method, params = {}, sessionId = undefined) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }
      }, 60000);
    });
  }

  on(method, fn) { this.handlers.set(method, fn); return this; }
  close() { try { this.ws.close(); } catch {} }
}

/** Open a tab and attach flat, returning a small page handle. */
export async function newPage(cdp) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);

  const page = {
    targetId, sessionId,

    async goto(url, { waitMs = 2500, timeoutMs = 30000 } = {}) {
      const loaded = new Promise((res) => {
        const h = (_p, sid) => { if (sid === sessionId) { cdp.handlers.delete(`${sessionId}:Page.loadEventFired`); res('load'); } };
        cdp.handlers.set(`${sessionId}:Page.loadEventFired`, h);
        setTimeout(() => res('timeout'), timeoutMs);
      });
      await cdp.send('Page.navigate', { url }, sessionId);
      const how = await loaded;
      // Settle time for SPA hydration: a React form has no fields at
      // loadEventFired, so asserting immediately measures the wrong moment.
      await sleep(waitMs);
      return how;
    },

    async eval(expression, { awaitPromise = false } = {}) {
      const r = await cdp.send('Runtime.evaluate', {
        expression, returnByValue: true, awaitPromise, allowUnsafeEvalBlockedByCSP: true,
      }, sessionId);
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      }
      return r.result?.value;
    },

    async setContent(html) {
      await cdp.send('Page.navigate', { url: 'about:blank' }, sessionId);
      await sleep(80);
      await cdp.send('Page.setDocumentContent', {
        frameId: (await cdp.send('Page.getFrameTree', {}, sessionId)).frameTree.frame.id,
        html,
      }, sessionId);
      await sleep(120);
    },

    async close() { try { await cdp.send('Target.closeTarget', { targetId }); } catch {} },
  };
  return page;
}
