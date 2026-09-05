// Local self-test. Deliberately scoped: this proves the code is well-formed and
// the plumbing works. It proves NOTHING about Rime or Chrome. Those two require
// the real preflight (`just preflight`) and a real browser.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import WebSocket from 'ws';

const rows = [];
const t = (name, kind, fn) => rows.push({ name, kind, fn });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- static checks ---------------------------------------------------------

t('MV3 manifest validates', 'LOCAL', () => {
  execFileSync('node', ['tools/validate_manifest.mjs'], { stdio: 'pipe' });
  return 'no errors';
});

t('Extension message contracts consistent', 'LOCAL', () => {
  execFileSync('node', ['tools/check_contracts.mjs'], { stdio: 'pipe' });
  return 'popup/background/offscreen/content agree';
});

t('All JS parses', 'LOCAL', () => {
  const files = [];
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (!/node_modules|\.git|artifacts/.test(p)) walk(p); }
    else if (/\.m?js$/.test(e.name)) files.push(p);
  });
  ['extension', 'backend', 'scripts', 'tools'].forEach(walk);
  const bad = [];
  for (const f of files) {
    try { execFileSync('node', ['--input-type=module', '--check'], { input: fs.readFileSync(f), stdio: 'pipe' }); }
    catch (e) { bad.push(`${f}: ${String(e.stderr).split('\n').find(l => l.includes('Error')) || 'parse error'}`); }
  }
  if (bad.length) throw new Error(bad.join(' | '));
  return `${files.length} files parse clean`;
});

t('Every probe module exports a runnable default', 'LOCAL', async () => {
  const dir = 'scripts/probe';
  const probes = fs.readdirSync(dir).filter(f => /^\d\d_.*\.mjs$/.test(f));
  for (const p of probes) {
    const m = await import(path.resolve(dir, p));
    if (typeof m.default !== 'function') throw new Error(`${p} has no default export`);
  }
  return `${probes.length} probes loadable`;
});

t('Env loader parses .env edge cases', 'LOCAL', async () => {
  const { parseEnvFile } = await import(path.resolve('scripts/probe/lib/env.mjs'));
  const got = parseEnvFile([
    'PLAIN=plain_value', 'QUOTED="quoted value"', "SINGLE='single quoted'",
    'export EXPORTED=with_prefix', 'COMMENTED=value123 # trailing',
    'HASH_QUOTED="has#hash"', '# whole line', 'EMPTY=', 'SPACED  =  spaced',
  ].join('\n'));
  const want = { PLAIN: 'plain_value', QUOTED: 'quoted value', SINGLE: 'single quoted',
    EXPORTED: 'with_prefix', COMMENTED: 'value123', HASH_QUOTED: 'has#hash', EMPTY: '', SPACED: 'spaced' };
  for (const [k, v] of Object.entries(want)) if (got[k] !== v) throw new Error(`${k}: got ${JSON.stringify(got[k])} want ${JSON.stringify(v)}`);
  return `${Object.keys(want).length} cases correct`;
});

t('Auth diagnostic runs with zero dependencies', 'LOCAL', () => {
  // It must work on a tree with no node_modules - that is exactly when you
  // need it. Verified by resolving its import graph against node: builtins only.
  const src = fs.readFileSync('tools/diagnose_auth.mjs', 'utf8');
  const bare = [...src.matchAll(/from '([^']+)'/g)].map(m => m[1])
    .filter(x => !x.startsWith('node:') && !x.startsWith('.'));
  if (bare.length) throw new Error(`imports external packages: ${bare.join(', ')}`);
  const env = fs.readFileSync('scripts/probe/lib/env.mjs', 'utf8');
  const envBare = [...env.matchAll(/from '([^']+)'/g)].map(m => m[1]).filter(x => !x.startsWith('node:'));
  if (envBare.length) throw new Error(`env.mjs imports external packages: ${envBare.join(', ')}`);
  return 'node: builtins only';
});

t('Placeholder key short-circuits the auth verdict', 'LOCAL', () => {
  // Regression: the placeholder was detected but reported as cause #4, under
  // three speculative causes. A detected placeholder is the answer, not a hint.
  // The short-circuit exits non-zero by design, so execFileSync throws; the
  // output we want is on the error object.
  let out;
  try {
    out = execFileSync('node', ['tools/diagnose_auth.mjs'], {
      env: { ...process.env, RIME_API_KEY: 'rime_sk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' },
      stdio: 'pipe', encoding: 'utf8',
    }).toString();
  } catch (e) {
    out = String(e.stdout || '');
    if (e.status !== 1) throw new Error(`expected exit 1 for a placeholder key, got ${e.status}`);
  }
  if (!out.includes('=== verdict ===')) throw new Error('no verdict printed');
  const verdict = out.slice(out.indexOf('=== verdict ==='));
  if (!/still the placeholder/.test(verdict)) throw new Error('placeholder not called out in the verdict');
  if (/truncated or mistyped/.test(verdict)) throw new Error('speculative causes still shown alongside a known placeholder');
  return 'placeholder reported as the sole cause';
});

t('Catalog parser handles every plausible shape', 'LOCAL', async () => {
  // Regression guard. The first parser only handled objects with a `name`
  // field and returned zero voices against a catalog that nests arrays of
  // name strings, producing a misleading "no mistv2 English voice" failure.
  const { parseCatalog, selectMistV2English } = await import(path.resolve('scripts/probe/lib/catalog.mjs'));
  const shapes = {
    'lang>model>[names]':   { eng: { mistv2: ['luna', 'celeste'], coda: ['rex'] }, spa: { mistv2: ['sofia'] } },
    'model>lang>[names]':   { mistv2: { eng: ['luna', 'abbie'] }, arcana: { eng: ['zed'] } },
    'flat array of objects':[{ name: 'luna', model: 'mistv2', lang: 'eng' }, { name: 'rex', model: 'coda', lang: 'hin' }],
    'objects with models[]':{ voices: [{ name: 'luna', lang: 'eng', models: ['mistv1', 'mistv2'] }] },
    'lang>model>demo>[n]':  { eng: { mistv2: { female: ['luna'], male: ['dan'] } } },
    'voices>lang>model':    { voices: { eng: { mistv2: ['luna', 'marsh'] } } },
    'model only, no lang':  { mistv2: ['luna', 'celeste'] },
  };
  const bad = [];
  for (const [label, data] of Object.entries(shapes)) {
    const sel = selectMistV2English(parseCatalog(data));
    if (!sel.voices.length) bad.push(label);
    if (!sel.voices.some(v => v.name === 'luna')) bad.push(`${label} (missed luna)`);
  }
  if (bad.length) throw new Error(`shapes not handled: ${bad.join(', ')}`);
  return `${Object.keys(shapes).length} catalog shapes resolve correctly`;
});

t('Bundled test.mp3 is real audio', 'LOCAL', () => {
  const b = fs.readFileSync('extension/assets/test.mp3');
  const ok = b.subarray(0, 3).toString() === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0);
  if (!ok) throw new Error('no MP3 frame sync / ID3 header');
  if (b.length < 1000) throw new Error(`only ${b.length} bytes`);
  return `${b.length} bytes, valid MP3 sync`;
});

t('No secrets committed', 'LOCAL', () => {
  const hits = [];
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (!/node_modules|\.git|artifacts/.test(p)) walk(p); }
    else if (/\.(m?js|json|md|html|example|yml)$/.test(e.name)) {
      const s = fs.readFileSync(p, 'utf8');
      // Real Rime keys, generic bearer tokens, AWS ids.
      for (const re of [/rime_sk_(?!x{4})[A-Za-z0-9]{16,}/g, /AKIA[0-9A-Z]{16}/g, /sk-[A-Za-z0-9]{32,}/g]) {
        const f = s.match(re); if (f) hits.push(`${p}: ${f[0].slice(0, 12)}...`);
      }
    }
  });
  walk('.');
  if (hits.length) throw new Error(hits.join(', '));
  if (!fs.readFileSync('.gitignore', 'utf8').includes('.env')) throw new Error('.gitignore does not exclude .env');
  // This used to fail whenever .env merely EXISTED - which the README's own
  // setup step (`cp .env.example .env`) guarantees for every developer. The
  // question is not whether the file is on disk, it is whether git tracks it.
  try {
    const tracked = execFileSync('git', ['ls-files', '--error-unmatch', '.env'], { stdio: 'pipe' }).toString().trim();
    if (tracked) throw new Error('.env is TRACKED BY GIT - remove it from the index immediately');
  } catch (e) {
    if (/TRACKED BY GIT/.test(String(e.message))) throw e;   // real failure, not "not found"
  }
  return fs.existsSync('.env') ? '.env present locally, untracked, .gitignore correct' : '.env.example only';
});

// ---- runtime checks --------------------------------------------------------

const waitPort = async (port, ms = 6000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const ok = await new Promise(r => { const s = net.connect(port, '127.0.0.1'); s.on('connect', () => { s.end(); r(true); }); s.on('error', () => r(false)); });
    if (ok) return true; await sleep(120);
  }
  return false;
};

let backend = null;
t('Backend boots and serves /health + /provider', 'LOCAL', async () => {
  // Refuse to test a server we did not start. A leftover proxy on this port
  // answers /health perfectly well and then rejects the selftest's token,
  // which surfaces as two unrelated PLUMBING failures.
  if (await waitPort(8787, 300)) {
    throw new Error('port 8787 is already in use - stop the other backend first (lsof -ti:8787 | xargs kill)');
  }
  backend = spawn('node', ['backend/server.mjs'], {
    env: { ...process.env, PORT: '8787', PROXY_TOKEN: 'selftest', RIME_API_KEY: 'rime_sk_PLACEHOLDER_NOT_REAL', RIME_WS_URL: 'ws://127.0.0.1:8799' },
    stdio: 'pipe',
  });
  let bootErr = '';
  backend.stderr.on('data', d => { bootErr += d.toString(); });
  if (!await waitPort(8787)) throw new Error(`backend did not listen on 8787: ${bootErr.slice(-160)}`);
  if (/EADDRINUSE/.test(bootErr)) throw new Error('backend could not bind 8787 (EADDRINUSE)');
  const h = await (await fetch('http://127.0.0.1:8787/health')).json();
  const p = await (await fetch('http://127.0.0.1:8787/provider')).json();
  if (!h.ok) throw new Error('health not ok');
  if (p.active !== 'rime' || p.model !== 'mistv2') throw new Error(`bad provider payload ${JSON.stringify(p)}`);
  return `provider: ${p.active}/${p.model}/${p.audioFormat}`;
});

t('Proxy rejects an unauthenticated /speak upgrade', 'LOCAL', async () => {
  const err = await new Promise(r => {
    const ws = new WebSocket('ws://127.0.0.1:8787/speak?token=wrong');
    ws.on('open', () => r(null)); ws.on('error', e => r(e));
  });
  if (!err) throw new Error('open relay: bad token was accepted');
  return `rejected (${String(err.message).slice(0, 40)})`;
});

let stub = null;
t('Relay carries chunks + timestamps end to end', 'PLUMBING', async () => {
  stub = spawn('node', ['tools/loopback_ws_stub.mjs'], { stdio: 'pipe' });
  if (!await waitPort(8799)) throw new Error('stub did not listen');
  const frames = await new Promise((res, rej) => {
    const got = [];
    const ws = new WebSocket('ws://127.0.0.1:8787/speak?token=selftest&speaker=x&modelId=mistv2&audioFormat=pcm');
    ws.on('open', () => ws.send(JSON.stringify({ text: 'one two three four', contextId: 'turn-1' })));
    ws.on('message', d => { got.push(JSON.parse(d.toString())); if (got.filter(f => f.type === 'STUB_chunk').length >= 5) { ws.close(); res(got); } });
    ws.on('error', rej);
    setTimeout(() => { try { ws.close(); } catch {} res(got); }, 5000);
  });
  const chunks = frames.filter(f => f.type === 'STUB_chunk');
  const ts = frames.find(f => f.type === 'STUB_timestamps');
  if (!chunks.length) throw new Error('no chunks relayed');
  if (!ts?.word_timestamps?.words) throw new Error('no timestamps relayed');
  return `${chunks.length} chunks + ${ts.word_timestamps.words.length} word timestamps through the proxy`;
});

t('Stale-chunk drop by contextId works', 'PLUMBING', async () => {
  const kept = await new Promise((res, rej) => {
    let current = 'turn-1'; const accepted = [], dropped = [];
    const ws = new WebSocket('ws://127.0.0.1:8787/speak?token=selftest&speaker=x&modelId=mistv2&audioFormat=pcm');
    ws.on('open', () => {
      ws.send(JSON.stringify({ text: 'first utterance here', contextId: 'turn-1' }));
      setTimeout(() => { current = 'turn-2'; ws.send(JSON.stringify({ operation: 'clear' })); ws.send(JSON.stringify({ text: 'second one', contextId: 'turn-2' })); }, 200);
    });
    ws.on('message', d => {
      const f = JSON.parse(d.toString());
      if (f.type !== 'STUB_chunk') return;
      (f.contextId === current ? accepted : dropped).push(f);
      if (accepted.length + dropped.length >= 8) { ws.close(); res(summarise()); }
    });
    ws.on('error', rej);
    // Ordering-independence: the stale tail must NOT be sequential on arrival.
    const summarise = () => {
      const seqs = dropped.map(f => f.seq).filter(n => typeof n === 'number');
      const sorted = [...seqs].sort((a, b) => a - b);
      return { accepted: accepted.length, dropped: dropped.length,
               outOfOrder: seqs.length > 1 && seqs.join() !== sorted.join() };
    };
    setTimeout(() => { try { ws.close(); } catch {} res(summarise()); }, 5000);
  });
  if (kept.dropped === 0) throw new Error('no stale chunks were identified - the filter never fired');
  if (!kept.outOfOrder) throw new Error('stale tail arrived in order - ordering-independence not exercised');
  return `${kept.accepted} accepted, ${kept.dropped} stale dropped (tail arrived out of order)`;
});

// ---- external reachability (honest reporting) ------------------------------

for (const host of ['users.rime.ai', 'users-ws.rime.ai', 'optimize.rime.ai']) {
  t(`Reachable: ${host}`, 'EXTERNAL', async () => {
    const res = await fetch(`https://${host}/`, { signal: AbortSignal.timeout(10000) });
    const deny = res.headers.get('x-deny-reason');
    if (deny) throw new Error(`egress blocked: ${deny}`);
    return `HTTP ${res.status}`;
  });
}

// Searching only PATH reported BLOCKED on a machine with Chrome installed:
// macOS puts it in an .app bundle and never on PATH. A false BLOCKED is worse
// than a FAIL - it reads as "environment problem, not my code" and gets skipped.
t('Chrome binary available', 'EXTERNAL', () => {
  const paths = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ].filter(Boolean);
  for (const p of paths) {
    try { if (fs.existsSync(p)) return execFileSync(p, ['--version'], { stdio: 'pipe' }).toString().trim(); } catch {}
  }
  for (const c of ['google-chrome', 'chromium', 'chromium-browser']) {
    try { return execFileSync(c, ['--version'], { stdio: 'pipe' }).toString().trim(); } catch {}
  }
  throw new Error('no Chrome/Chromium in the usual locations or on PATH');
});

// Loading the unpacked extension needs Chrome for Testing: Chrome stable 137+
// ignores --load-extension entirely (verified on 152, headless and headful).
t('Chrome for Testing available (needed to load the extension)', 'EXTERNAL', () => {
  const roots = [process.env.CHROME_TEST_PATH, process.env.CHROME_TEST_DIR,
    path.join(process.env.CLAUDE_JOB_DIR || '', 'tmp', 'browsers'),
    path.join(os.homedir(), '.cache', 'puppeteer'),
    path.join(process.cwd(), '.cache', 'browsers')].filter(Boolean);
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    if (fs.statSync(root).isFile()) return root;
    const stack = [root];
    while (stack.length) {
      const d = stack.pop();
      let entries = [];
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) { if (stack.length < 400) stack.push(full); }
        else if (e.name === 'Google Chrome for Testing' || e.name === 'chrome') return full;
      }
    }
  }
  throw new Error('not installed - npx @puppeteer/browsers install chrome@stable --path .cache/browsers');
});

// ---- run -------------------------------------------------------------------

const out = [];
for (const r of rows) {
  try { const detail = await r.fn(); out.push({ ...r, status: 'PASS', detail }); }
  catch (e) { out.push({ ...r, status: r.kind === 'EXTERNAL' ? 'BLOCKED' : 'FAIL', detail: String(e.message || e).slice(0, 200) }); }
}
backend?.kill(); stub?.kill();

const w = Math.max(...out.map(o => o.name.length));
console.log('\nVoiceFill Phase 0 self-test\n');
for (const o of out) console.log(`  ${o.status.padEnd(7)} ${o.kind.padEnd(9)} ${o.name.padEnd(w)}  ${o.detail}`);
const fail = out.filter(o => o.status === 'FAIL').length;
const blocked = out.filter(o => o.status === 'BLOCKED').length;
console.log(`\n  PASS ${out.filter(o => o.status === 'PASS').length}   FAIL ${fail}   BLOCKED ${blocked}`);
if (blocked) console.log('  BLOCKED = environment cannot reach the dependency. Not a code result. Re-run where it is reachable.');
fs.mkdirSync('artifacts', { recursive: true });
fs.writeFileSync('artifacts/selftest.json', JSON.stringify(out, null, 2));
process.exit(fail ? 1 : 0);
