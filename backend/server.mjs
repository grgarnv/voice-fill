// VoiceFill backend proxy.
//   /health    liveness
//   /provider  active-provider disclosure, read by the popup badge
//   /speak     WebSocket relay: extension <-> Rime /ws3
//
// Auth: a shared token. Without it this is an open relay to your Rime key,
// which is a bad thing to leave running during a public demo.
import { loadEnv } from '../scripts/probe/lib/env.mjs';
loadEnv();
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { connectRime } from './rime.mjs';
import { transcribePcm, sttAvailable, sttConfig } from './stt.mjs';
import { interpret, intentAvailable, intentConfig, intentReachable, intentPrewarm } from './intent.mjs';

const PORT = Number(process.env.PORT || 8787);
const TOKEN = process.env.PROXY_TOKEN || '';

const CFG = () => ({
  active: 'rime',
  model: process.env.RIME_MODEL_ID || 'coda',
  speaker: process.env.RIME_SPEAKER || null,
  lang: process.env.RIME_LANG || 'eng',
  audioFormat: process.env.RIME_AUDIO_FORMAT || 'pcm',
  endpoint: process.env.RIME_WS_URL || 'wss://users-ws.rime.ai/ws3',
  transport: 'websocket-via-backend-proxy',
  stt: sttAvailable() ? 'backend-whisper' : 'browser-webspeech',
  // The conversational intent layer. 'none' is a supported state: the extension
  // falls back to its deterministic rules and stays usable.
  intent: intentConfig(),
  // Connection-level, and only effective as query params - see backend/rime.mjs.
  segment: process.env.RIME_SEGMENT || 'never',
  // Pause tokens: Mist honours "<300>" as 300 ms when the query flag is set.
  // Coda renders any "<N>" as a fixed ~0.9 s silence whatever N says (measured
  // 2026-09-06: <100>, <300>, <600> all 0.90 s; <1500> 1.08 s), which stretched
  // a read-back from 4 s to 7 s. Reported false for Coda, so the extension
  // emits commas instead - Phase 2 measured grouping, not pause length, as
  // what carries the read-back.
  pauseBetweenBrackets: /^mist/.test(process.env.RIME_MODEL_ID || 'coda'),
  // Inline pronunciation control, same story: a Mist v1/v2 feature (PHASE0
  // probe 02). On Coda the flag is ignored and "{ˈɑːrnəv}" would be READ OUT,
  // so it is reported here and the extension falls back to a plain-text
  // respelling for any name in the user's pronunciation dictionary.
  phonemizeBetweenBrackets: /^mist/.test(process.env.RIME_MODEL_ID || 'coda'),
  samplingRate: (process.env.RIME_AUDIO_FORMAT || 'pcm') === 'pcm' ? 24000 : null,
});

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  // The extension page is a chrome-extension:// origin, so /stt is cross-origin.
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-vf-rate, x-vf-token');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }

  res.setHeader('Content-Type', 'application/json');
  // stt is reported here because a broken model is otherwise indistinguishable
  // from a deaf microphone: every turn just says "I didn't catch that".
  // A configured-but-unreachable intent provider is the failure that otherwise
  // looks like the layer simply not working, so /health answers reachability,
  // not just configuration.
  if (url.pathname === '/health') {
    return intentReachable().then(ir => res.end(JSON.stringify({
      ok: true, keyLoaded: !!process.env.RIME_API_KEY, stt: sttAvailable(),
      sttModel: sttConfig().model || null, intent: intentAvailable() && ir,
      intentConfigured: intentAvailable(), intentProvider: intentConfig().provider,
    })));
  }
  if (url.pathname === '/provider') return res.end(JSON.stringify(CFG()));

  // POST /stt - raw 16-bit PCM mono in the body, transcript out.
  if (url.pathname === '/stt') {
    if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ error: 'POST only' })); }
    if (TOKEN && req.headers['x-vf-token'] !== TOKEN && url.searchParams.get('token') !== TOKEN) {
      res.statusCode = 401; return res.end(JSON.stringify({ error: 'unauthorized' }));
    }
    const rate = Number(req.headers['x-vf-rate'] || url.searchParams.get('rate') || sttConfig().rate);
    const chunks = [];
    let size = 0;
    req.on('data', (d) => {
      size += d.length;
      // A runaway upload must not become a memory problem: 60s at 16kHz mono.
      if (size > 16000 * 2 * 60) { req.destroy(); return; }
      chunks.push(d);
    });
    req.on('end', async () => {
      const r = await transcribePcm(Buffer.concat(chunks), { rate });
      res.statusCode = r.ok ? 200 : 503;
      res.end(JSON.stringify(r));
    });
    req.on('error', () => { res.statusCode = 400; res.end(JSON.stringify({ error: 'read failed' })); });
    return;
  }

  // POST /intent - a context object in, one structured intent out. The model
  // key stays here; the extension only ever sees the intent, and validates it
  // against its own state before anything is executed.
  if (url.pathname === '/intent') {
    if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ error: 'POST only' })); }
    if (TOKEN && req.headers['x-vf-token'] !== TOKEN && url.searchParams.get('token') !== TOKEN) {
      res.statusCode = 401; return res.end(JSON.stringify({ error: 'unauthorized' }));
    }
    const chunks = [];
    let size = 0;
    req.on('data', (d) => { size += d.length; if (size > 256 * 1024) { req.destroy(); return; } chunks.push(d); });
    req.on('end', async () => {
      let ctx;
      try { ctx = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'bad json' })); }
      const r = await interpret(ctx);
      res.statusCode = r.ok ? 200 : 503;
      res.end(JSON.stringify(r));
    });
    req.on('error', () => { res.statusCode = 400; res.end(JSON.stringify({ error: 'read failed' })); });
    return;
  }

  res.statusCode = 404; res.end(JSON.stringify({ error: 'not found' }));
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== '/speak') { socket.destroy(); return; }
  if (TOKEN && url.searchParams.get('token') !== TOKEN) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (client, req) => {
  const q = new URL(req.url, `http://localhost:${PORT}`).searchParams;
  const c = CFG();
  const upstream = connectRime({
    speaker: q.get('speaker') || c.speaker,
    modelId: q.get('modelId') || c.model,
    audioFormat: q.get('audioFormat') || c.audioFormat,
    lang: c.lang,
    samplingRate: (q.get('audioFormat') || c.audioFormat) === 'pcm' ? 24000 : undefined,
    segment: q.get('segment') || c.segment,
    pauseBetweenBrackets: c.pauseBetweenBrackets,
    phonemizeBetweenBrackets: c.phonemizeBetweenBrackets,
  });

  // Buffer client sends until upstream is open, so an early first utterance
  // (the user clicking Start fast) is not silently dropped.
  const pending = [];
  let up = false;
  upstream.on('open', () => { up = true; pending.splice(0).forEach(m => upstream.send(m)); client.send(JSON.stringify({ type: 'proxy_ready', provider: c })); });
  upstream.on('message', (d) => { if (client.readyState === 1) client.send(d.toString()); });
  // Logged, because a Rime-side close mid-session surfaces to the extension as
  // nothing more than a reconnect; the code and reason are only visible here.
  upstream.on('close', (code, reason) => { console.log(`[proxy] upstream closed ${code} ${String(reason || '')}`.trim()); if (client.readyState === 1) client.close(1011, `upstream ${code}`); });
  upstream.on('error', (e) => { console.log(`[proxy] upstream error ${String(e.message)}`); if (client.readyState === 1) client.send(JSON.stringify({ type: 'proxy_error', error: String(e.message) })); });

  client.on('message', (d) => { const m = d.toString(); up ? upstream.send(m) : pending.push(m); });
  client.on('close', () => { try { upstream.close(); } catch {} });
});

server.listen(PORT, async () => {
  console.log(`VoiceFill proxy on :${PORT}  (key ${process.env.RIME_API_KEY ? 'loaded' : 'MISSING'})`);
  const c = intentConfig();
  if (c.provider === 'none') return console.log('[intent] disabled - deterministic rules only');
  // Never awaited by anything: the proxy serves speech immediately, and the
  // conversational layer falls back on its own until the model is resident.
  const w = await intentPrewarm();
  console.log(`[intent] ${c.provider} ${c.model || ''} ${w.ok ? `warm in ${w.ms}ms` : `NOT READY (${w.error || 'unreachable'})`}`.trim());
});
