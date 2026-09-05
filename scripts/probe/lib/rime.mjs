// Shared Rime client for Phase 0 preflight probes.
// This module talks ONLY to real Rime endpoints. There is deliberately no
// stub/mock path here: a probe that can fall back to a fake would let a red
// dependency report green, which is the exact failure Phase 0 exists to prevent.

import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

export const ART = path.resolve('artifacts/preflight');

export function env(name, fallback = undefined) {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') {
    throw new Error(`Missing required env var ${name}. Copy .env.example to .env and fill it in.`);
  }
  return v;
}

export function cfg() {
  return {
    key: env('RIME_API_KEY'),
    model: env('RIME_MODEL_ID', 'mistv2'),
    speaker: process.env.RIME_SPEAKER || '',
    lang: env('RIME_LANG', 'eng'),
    restUrl: env('RIME_REST_URL', 'https://users.rime.ai/v1/rime-tts'),
    wsUrl: env('RIME_WS_URL', 'wss://users-ws.rime.ai/ws3'),
    phonemizeUrl: env('RIME_PHONEMIZE_URL', 'https://optimize.rime.ai/phonemize'),
    catalogUrl: env('RIME_CATALOG_URL', 'https://users.rime.ai/data/voices/all-v2.json'),
  };
}

export function saveArtifact(name, buf) {
  fs.mkdirSync(ART, { recursive: true });
  const p = path.join(ART, name);
  fs.writeFileSync(p, buf);
  return p;
}

/** REST synthesis. Returns { status, contentType, bytes, savedTo }. */
export async function ttsRest({ text, speaker, modelId, extra = {}, accept = 'audio/mpeg', saveAs }) {
  const c = cfg();
  const body = { text, speaker, modelId, lang: c.lang, ...extra };
  const res = await fetch(c.restUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${c.key}`,
      'Content-Type': 'application/json',
      Accept: accept,
    },
    body: JSON.stringify(body),
  });
  const contentType = res.headers.get('content-type') || '';
  const denyReason = res.headers.get('x-deny-reason') || null;
  const buf = Buffer.from(await res.arrayBuffer());
  let savedTo = null;
  if (res.ok && saveAs && buf.length > 0) savedTo = saveArtifact(saveAs, buf);
  if (denyReason) throw new Error(`rime-tts HTTP ${res.status} host_not_allowed (egress proxy deny-reason: ${denyReason})`);
  return { status: res.status, ok: res.ok, contentType, bytes: buf.length, buf, savedTo, sent: body };
}

/** Live voice catalog. */
/**
 * Turn a non-OK response into an error that says WHY. An egress proxy and Rime
 * both answer 403; only the deny reason distinguishes "your network blocked
 * this" from "Rime rejected your key", and confusing those two costs hours.
 */
export async function httpError(res, what) {
  const deny = res.headers.get('x-deny-reason');
  let body = '';
  try { body = (await res.text()).slice(0, 200); } catch {}
  if (deny) return new Error(`${what} HTTP ${res.status} host_not_allowed (egress proxy deny-reason: ${deny})`);
  return new Error(`${what} HTTP ${res.status}${body ? ` - ${body}` : ''}`);
}

export async function fetchCatalog() {
  const c = cfg();
  const res = await fetch(c.catalogUrl, { headers: { Authorization: `Bearer ${c.key}` } });
  if (!res.ok) throw await httpError(res, 'catalog');
  return res.json();
}

/**
 * Open a /ws3 connection. Query params carry speaker/model/format per Rime's
 * flagship WebSocket contract.
 */
export function openWs3({ speaker, modelId, audioFormat, samplingRate, segment, pauseBetweenBrackets }) {
  const c = cfg();
  const u = new URL(c.wsUrl);
  u.searchParams.set('speaker', speaker);
  u.searchParams.set('modelId', modelId);
  u.searchParams.set('audioFormat', audioFormat);
  u.searchParams.set('lang', c.lang);
  if (samplingRate) u.searchParams.set('samplingRate', String(samplingRate));
  // Was missing: probe 05 passed segment:'never' and it was silently dropped on
  // the floor here, so its buffered-cancel result was actually measured under
  // DEFAULT segmentation. Verified honoured as a query param in Phase 1.
  if (segment) u.searchParams.set('segment', String(segment));
  if (pauseBetweenBrackets) u.searchParams.set('pauseBetweenBrackets', 'true');

  const ws = new WebSocket(u.toString(), {
    headers: { Authorization: `Bearer ${c.key}` },
    handshakeTimeout: 15000,
  });
  ws.__url = u.toString().replace(c.key, '***');
  return ws;
}

/**
 * Collect messages from a /ws3 session until `done` returns true or timeout.
 * Records a monotonic receive timestamp on every frame so probes can measure
 * stop latency without re-deriving a clock.
 */
export function collect(ws, { onOpen, done, timeoutMs = 20000 }) {
  return new Promise((resolve, reject) => {
    const frames = [];
    const t0 = process.hrtime.bigint();
    const ms = () => Number(process.hrtime.bigint() - t0) / 1e6;
    let settled = false;

    const finish = (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      resolve({ frames, reason, elapsedMs: ms() });
    };

    const timer = setTimeout(() => finish('timeout'), timeoutMs);

    ws.on('open', () => { try { onOpen?.({ ws, ms }); } catch (e) { reject(e); } });
    ws.on('message', (raw) => {
      const at = ms();
      let msg;
      const s = raw.toString('utf8');
      try { msg = JSON.parse(s); } catch { msg = { type: '__nonjson__', raw: s.slice(0, 200), byteLength: raw.length }; }
      frames.push({ at, msg });
      if (done?.({ msg, at, frames, ws })) finish('done');
    });
    ws.on('error', (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } });
    ws.on('close', (code, r) => finish(`closed:${code}:${r?.toString() || ''}`));
  });
}

/** Frames whose payload looks like an audio chunk, regardless of field naming. */
export function audioFrames(frames) {
  return frames.filter(({ msg }) => {
    const t = (msg.type || '').toLowerCase();
    return t.includes('chunk') || t === 'audio' || typeof msg.data === 'string';
  });
}

export function timestampFrames(frames) {
  return frames.filter(({ msg }) => {
    const t = (msg.type || '').toLowerCase();
    return t.includes('timestamp') || msg.word_timestamps || msg.wordTimestamps;
  });
}

/** Pull word timestamps out without assuming one exact shape. */
export function extractWordTimestamps(msg) {
  const wt = msg.word_timestamps || msg.wordTimestamps || msg.timestamps;
  if (!wt) return null;
  const words = wt.words ?? wt.word ?? null;
  const start = wt.start ?? wt.starts ?? wt.start_times ?? null;
  const end = wt.end ?? wt.ends ?? wt.end_times ?? null;
  if (!words || !start) return null;
  return { words, start, end, count: words.length };
}
