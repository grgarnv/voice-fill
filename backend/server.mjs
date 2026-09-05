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

const PORT = Number(process.env.PORT || 8787);
const TOKEN = process.env.PROXY_TOKEN || '';

const CFG = () => ({
  active: 'rime',
  model: process.env.RIME_MODEL_ID || 'mistv2',
  speaker: process.env.RIME_SPEAKER || null,
  lang: process.env.RIME_LANG || 'eng',
  audioFormat: process.env.RIME_AUDIO_FORMAT || 'pcm',
  endpoint: process.env.RIME_WS_URL || 'wss://users-ws.rime.ai/ws3',
  transport: 'websocket-via-backend-proxy',
  stt: sttAvailable() ? 'backend-whisper' : 'browser-webspeech',
  // Connection-level, and only effective as query params - see backend/rime.mjs.
  segment: process.env.RIME_SEGMENT || 'never',
  pauseBetweenBrackets: true,
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
  if (url.pathname === '/health') return res.end(JSON.stringify({ ok: true, keyLoaded: !!process.env.RIME_API_KEY }));
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
    pauseBetweenBrackets: true,
  });

  // Buffer client sends until upstream is open, so an early first utterance
  // (the user clicking Start fast) is not silently dropped.
  const pending = [];
  let up = false;
  upstream.on('open', () => { up = true; pending.splice(0).forEach(m => upstream.send(m)); client.send(JSON.stringify({ type: 'proxy_ready', provider: c })); });
  upstream.on('message', (d) => { if (client.readyState === 1) client.send(d.toString()); });
  upstream.on('close', (code) => { if (client.readyState === 1) client.close(1011, `upstream ${code}`); });
  upstream.on('error', (e) => { if (client.readyState === 1) client.send(JSON.stringify({ type: 'proxy_error', error: String(e.message) })); });

  client.on('message', (d) => { const m = d.toString(); up ? upstream.send(m) : pending.push(m); });
  client.on('close', () => { try { upstream.close(); } catch {} });
});

server.listen(PORT, () => console.log(`VoiceFill proxy on :${PORT}  (key ${process.env.RIME_API_KEY ? 'loaded' : 'MISSING'})`));
