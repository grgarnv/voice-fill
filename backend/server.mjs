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
  // Connection-level, and only effective as query params - see backend/rime.mjs.
  segment: process.env.RIME_SEGMENT || 'never',
  pauseBetweenBrackets: true,
  samplingRate: (process.env.RIME_AUDIO_FORMAT || 'pcm') === 'pcm' ? 24000 : null,
});

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  res.setHeader('Content-Type', 'application/json');
  if (url.pathname === '/health') return res.end(JSON.stringify({ ok: true, keyLoaded: !!process.env.RIME_API_KEY }));
  if (url.pathname === '/provider') return res.end(JSON.stringify(CFG()));
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
