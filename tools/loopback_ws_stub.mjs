// ============================================================================
// LOOPBACK /ws3 STUB - PLUMBING TEST ONLY.
//
// This is NOT a Rime mock and it MUST NOT be used to satisfy any exit
// criterion about Rime. It exists to exercise the backend relay, the chunk
// queue and the contextId drop logic when the real endpoint is unreachable, and
// (Phase 3) to produce network conditions Rime will not produce on demand:
// chunks arriving slower than realtime, a timestamps frame that arrives late,
// and a stale tail after `clear` that is long, out of order, and carries its
// own late timestamps and done.
//
// Default frame shape is deliberately DIFFERENT from Rime's (STUB_chunk) so
// nobody can mistake a green here for a green there. `--rime-shape` switches to
// Rime's field names so the real extension code path can be driven; results
// from that mode are labelled PLUMBING in the report and count for nothing
// against Rime.
//
//   --rime-shape            emit type: chunk | timestamps | done (Rime's names)
//   --chunk-ms N            wall ms between chunks           (default 60)
//   --chunk-audio-ms N      audio ms per chunk (pcm 24k)     (default 20)
//   --chunks N              chunks per utterance             (default 10)
//   --ts-delay-ms N         delay the timestamps frame       (default 0 = with first chunk)
//   --tail N                stale chunks after clear         (default 4)
//   --tail-spread-ms N      the tail arrives within this     (default 60)
//   --tone                  chunks carry a 440 Hz tone, not silence (so an output monitor sees them)
// ============================================================================
import { WebSocketServer } from 'ws';

const args = process.argv.slice(2);
const flag = (k) => args.includes(k);
const num = (k, d) => { const i = args.indexOf(k); return i >= 0 ? Number(args[i + 1]) : d; };
const RIME = flag('--rime-shape');
const CHUNK_MS = num('--chunk-ms', 60), AUDIO_MS = num('--chunk-audio-ms', 20), CHUNKS = num('--chunks', 10);
const TS_DELAY = num('--ts-delay-ms', 0), TAIL = num('--tail', 4), TAIL_SPREAD = num('--tail-spread-ms', 60);
const TONE = flag('--tone');
const T = (name) => (RIME ? name : `STUB_${name}`);

const wss = new WebSocketServer({ port: 8799 });
console.log(`LOOPBACK STUB on ws://localhost:8799  (plumbing only - proves nothing about Rime)${RIME ? '  [rime-shape]' : ''}`);

function chunkData(i) {
  const n = Math.round(24000 * AUDIO_MS / 1000);
  const b = Buffer.alloc(n * 2);
  if (TONE) for (let k = 0; k < n; k++) b.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * (i * n + k) / 24000) * 12000), k * 2);
  return b.toString('base64');
}

wss.on('connection', (ws) => {
  let timers = [], ctx = null, buffered = [];
  const later = (ms, fn) => { const t = setTimeout(fn, ms); timers.push(t); return t; };
  const send = (o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };

  function synthesise(text, c) {
    const words = text.split(/\s+/).filter(Boolean);
    const total = (CHUNKS * AUDIO_MS) / 1000;
    const per = total / Math.max(1, words.length);
    const ts = { type: T('timestamps'), contextId: c, word_timestamps: { words, start: words.map((_, i) => +(i * per).toFixed(3)), end: words.map((_, i) => +((i + 1) * per).toFixed(3)) } };
    let i = 0;
    const tick = () => {
      if (ctx !== c) return;                       // cleared
      // The timestamps frame is already "in flight" from the server's point of
      // view: a clear must not cancel it (Rime has sent it with the first chunk).
      if (i === 0) { if (TS_DELAY <= 0) send(ts); else setTimeout(() => send(ctx === c ? ts : { ...ts, stale: true }), TS_DELAY); }
      send({ type: T('chunk'), contextId: c, data: chunkData(i), seq: i });
      i++;
      if (i >= CHUNKS) { later(CHUNK_MS, () => { if (ctx === c) send({ type: T('done'), contextId: c }); }); return; }
      later(CHUNK_MS, tick);
    };
    tick();
  }

  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.operation === 'clear' || m.type === 'clear') {
      timers.forEach(clearTimeout); timers = [];
      const staleCtx = ctx; ctx = null; buffered = [];
      send({ type: T('cleared'), contextId: staleCtx });
      if (!staleCtx) return;
      // The in-flight TAIL: chunks already committed upstream when the clear
      // landed. They arrive AFTER the cancel, carry the OLD contextId, out of
      // order, and are followed by that context's own timestamps and done.
      // Deterministically out of order (a random shuffle can come out sorted,
      // which made the self-test's ordering-independence check flaky).
      const order = Array.from({ length: TAIL }, (_, k) => TAIL - 1 - k);
      if (TAIL >= 3) { const t = order[1]; order[1] = order[2]; order[2] = t; }
      order.forEach((seq, k) => later(5 + Math.round(k * TAIL_SPREAD / Math.max(1, TAIL)), () =>
        send({ type: T('chunk'), contextId: staleCtx, stale: true, seq: TAIL - seq, data: chunkData(seq) })));
      // Rime sends a context's timestamps with its first chunk, so any later
      // timestamps frame for that context can only FOLLOW the real one; keep
      // the stub's stale copy behind the (possibly delayed) real frame.
      later(TAIL_SPREAD + 20 + Math.max(0, TS_DELAY), () => send({ type: T('timestamps'), contextId: staleCtx, stale: true,
        word_timestamps: { words: ['stale', 'words'], start: [0, 0.1], end: [0.1, 0.2] } }));
      later(TAIL_SPREAD + 40, () => send({ type: T('done'), contextId: staleCtx, stale: true }));
      return;
    }
    if (m.operation === 'flush') {
      const b = buffered.splice(0);
      for (const { text, contextId } of b) synthesise(text, contextId);
      return;
    }
    if (typeof m.text === 'string') {
      ctx = m.contextId ?? null;
      // With segment=never the real service waits for flush; the old default
      // shape synthesised on arrival. Keep the old behaviour unless rime-shape.
      if (RIME) buffered.push({ text: m.text, contextId: ctx });
      else synthesise(m.text, ctx);
    }
  });
  ws.on('close', () => { timers.forEach(clearTimeout); });
});
