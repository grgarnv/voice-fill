// Phase 3 design probe: WHEN does the `timestamps` frame arrive relative to the
// first chunk and to `done`, under segment=never + flush, and does it still
// arrive when a `clear` is sent mid-flight? The heard ledger needs the
// timestamps at stop time; if they arrive late the ledger must finalise late.
import { loadEnv } from '../scripts/probe/lib/env.mjs';
loadEnv({ quiet: true });
import WebSocket from 'ws';

const TEXT = process.argv[2] || 'Field 4 of 12. <300> What is your postal code?';
const CLEAR_AFTER_MS = Number(process.argv[3] || 0);   // 0 = no clear

function run(label, clearAfter) {
  return new Promise((resolve) => {
    const u = new URL(process.env.RIME_WS_URL);
    u.searchParams.set('speaker', process.env.RIME_SPEAKER);
    u.searchParams.set('modelId', process.env.RIME_MODEL_ID || 'coda');
    u.searchParams.set('audioFormat', 'pcm'); u.searchParams.set('lang', 'eng');
    u.searchParams.set('samplingRate', '24000'); u.searchParams.set('segment', 'never');
    u.searchParams.set('pauseBetweenBrackets', 'true');
    const ws = new WebSocket(u.toString(), { headers: { Authorization: `Bearer ${process.env.RIME_API_KEY}` } });
    const t0 = performance.now(); const ms = () => +(performance.now() - t0).toFixed(0);
    const ev = []; let first = null, bytes = 0, cleared = null, tsFrames = [];
    const fin = (why) => { try { ws.close(); } catch {} resolve({ label, why, ev, tsFrames, bytes, audioSec: +(bytes / 48000).toFixed(2) }); };
    ws.on('open', () => {
      ws.send(JSON.stringify({ text: TEXT, contextId: 'ctx-A' }));
      ws.send(JSON.stringify({ operation: 'flush' }));
      ev.push(['sent+flush', ms()]);
    });
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'chunk') {
        bytes += Buffer.from(m.data, 'base64').length;
        if (first === null) { first = ms(); ev.push(['first chunk', first, m.contextId]);
          if (clearAfter) setTimeout(() => { ws.send(JSON.stringify({ operation: 'clear' })); cleared = ms(); ev.push(['clear sent', cleared]); }, clearAfter); }
        return;
      }
      if (m.type === 'timestamps') {
        const wt = m.word_timestamps;
        tsFrames.push({ at: ms(), contextId: m.contextId ?? null, words: wt?.words, start: wt?.start, end: wt?.end, keys: Object.keys(m) });
        ev.push(['timestamps', ms(), m.contextId, wt?.words?.length, 'audioSoFar', +(bytes / 48000).toFixed(2)]);
        return;
      }
      ev.push([m.type, ms(), m.contextId]);
      if (/^done$/i.test(m.type || '')) fin('done');
    });
    ws.on('error', (e) => { ev.push(['error', ms(), String(e.message)]); fin('error'); });
    setTimeout(() => fin('timeout'), 20000);
  });
}

const a = await run('no clear', 0);
console.log(JSON.stringify(a, null, 1));
if (CLEAR_AFTER_MS) { const b = await run(`clear ${CLEAR_AFTER_MS}ms after first chunk`, CLEAR_AFTER_MS); console.log(JSON.stringify(b, null, 1)); }
