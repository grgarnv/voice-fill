// Model-switch probe: does `coda` on /ws3 give Phase 3 what it needs?
//   word timestamps, contextId echo, `clear`, warm TTFA - and whether <300>
//   pause tokens are honoured (a timed "<300>" word) or read aloud as words.
import { loadEnv } from '../scripts/probe/lib/env.mjs';
loadEnv({ quiet: true });
import WebSocket from 'ws';
const MODEL = process.argv[2] || 'coda', SPEAKER = process.argv[3] || 'astra';

function session({ pause }, texts) {
  return new Promise((resolve, reject) => {
    const u = new URL(process.env.RIME_WS_URL);
    u.searchParams.set('speaker', SPEAKER); u.searchParams.set('modelId', MODEL);
    u.searchParams.set('audioFormat', 'pcm'); u.searchParams.set('lang', 'eng');
    u.searchParams.set('samplingRate', '24000'); u.searchParams.set('segment', 'never');
    if (pause) u.searchParams.set('pauseBetweenBrackets', 'true');
    const ws = new WebSocket(u.toString(), { headers: { Authorization: `Bearer ${process.env.RIME_API_KEY}` } });
    const t0 = performance.now(); const ms = () => +(performance.now() - t0).toFixed(0);
    const out = []; let cur = null, i = 0, firstAt = null, cleared = null;
    const next = () => {
      if (i >= texts.length) { try { ws.close(); } catch {} return resolve(out); }
      const t = texts[i++]; cur = { contextId: `c${i}`, text: t.text, sentAt: ms(), bytes: 0, chunks: 0, firstChunkAt: null, ts: null, otherCtx: 0, staleAfterClear: 0, doneAt: null, errors: [] };
      firstAt = null; cleared = null; out.push(cur);
      ws.send(JSON.stringify({ text: t.text, contextId: cur.contextId })); ws.send(JSON.stringify({ operation: 'flush' }));
      if (t.clearAfterMs) setTimeout(() => { ws.send(JSON.stringify({ operation: 'clear' })); cleared = ms(); cur.clearedAt = cleared; }, t.clearAfterMs + 0);
      cur.timer = setTimeout(() => { cur.timeout = true; next(); }, 15000);
    };
    ws.on('open', next);
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      const c = m.contextId ?? null;
      if (m.type === 'chunk') {
        if (c !== cur.contextId) { cur.otherCtx++; return; }
        cur.chunks++; cur.bytes += Buffer.from(m.data, 'base64').length;
        if (cur.firstChunkAt === null) cur.firstChunkAt = ms();
        if (cleared !== null) cur.staleAfterClear++;
        return;
      }
      if (m.type === 'timestamps') { cur.ts = { ctx: c, words: m.word_timestamps?.words, start: m.word_timestamps?.start, end: m.word_timestamps?.end, at: ms() }; return; }
      if (m.type === 'error') { cur.errors.push(m); return; }
      if (/^done$/i.test(m.type || '')) { cur.doneAt = ms(); cur.doneCtx = c; clearTimeout(cur.timer); setTimeout(next, 300); }
    });
    ws.on('error', reject);
  });
}

const texts = [
  { text: 'Ready.' },                                                            // cold
  { text: 'Field 4 of 12. <300> What is your postal code?' },                   // warm + pause token
  { text: 'Let me read that back. <300> one six, <300> zero zero, <300> seven one. <400> Is that correct?' },
  { text: 'This is a long sentence that will be cleared in the middle, so we can see what the tail looks like after the cancel.', clearAfterMs: 900 },
  { text: 'After the clear, this one must still play.' },
];
for (const pause of [true, false]) {
  const r = await session({ pause }, texts);
  console.log(`\n== ${MODEL}/${SPEAKER} pauseBetweenBrackets=${pause} ==`);
  for (const u of r) {
    const dur = +(u.bytes / 48000).toFixed(2);
    const words = u.ts?.words || [];
    const pauseWords = words.filter(w => /^<\d+>$/.test(w));
    const readAloud = words.filter(w => /less|than|hundred|three|four|bracket/i.test(w));
    console.log(JSON.stringify({ text: u.text.slice(0, 40), ttfaMs: u.firstChunkAt !== null ? u.firstChunkAt - u.sentAt : null, audioSec: dur, chunks: u.chunks, tsWords: words.length, tsCtx: u.ts?.ctx, tsAfterFirstChunkMs: u.ts && u.firstChunkAt !== null ? u.ts.at - u.firstChunkAt : null, pauseTokenWords: pauseWords.length, pauseDur: pauseWords.length ? +((u.ts.end[words.indexOf(pauseWords[0])] - u.ts.start[words.indexOf(pauseWords[0])])).toFixed(2) : null, readAloudWords: readAloud, clearedAt: u.clearedAt ?? null, staleAfterClear: u.staleAfterClear, doneMs: u.doneAt !== null ? u.doneAt - u.sentAt : null, doneCtx: u.doneCtx, otherCtx: u.otherCtx, errors: u.errors, timeout: !!u.timeout }));
  }
}
