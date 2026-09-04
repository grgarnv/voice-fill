// ============================================================================
// LOOPBACK /ws3 STUB - PLUMBING TEST ONLY.
//
// This is NOT a Rime mock and it MUST NOT be used to satisfy any Phase 0 exit
// criterion. It exists for one purpose: to exercise the backend relay, the
// chunk queue and the contextId drop logic when the real endpoint is
// unreachable from the build environment. Every result it produces is labelled
// PLUMBING in the report and counts for nothing against Rime.
//
// It deliberately emits a DIFFERENT frame shape than Rime, so nobody can mistake
// a green here for a green there.
// ============================================================================
import { WebSocketServer } from 'ws';
const wss = new WebSocketServer({ port: 8799 });
console.log('LOOPBACK STUB on ws://localhost:8799  (plumbing only - proves nothing about Rime)');

wss.on('connection', (ws) => {
  let timer = null, ctx = null;
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.operation === 'clear' || m.type === 'clear') {
      clearInterval(timer);
      const staleCtx = ctx;
      ws.send(JSON.stringify({ type: 'STUB_cleared', contextId: staleCtx }));
      // Emit an in-flight TAIL: chunks already committed upstream when the clear
      // landed. This is the hazard the PRD calls out - they arrive AFTER the
      // cancel, carrying the OLD contextId, and not necessarily in order. A stub
      // that cancels instantly cannot exercise the drop filter at all.
      const TAIL = 4;
      for (let k = 0; k < TAIL; k++) {
        setTimeout(() => ws.send(JSON.stringify({
          type: 'STUB_chunk', contextId: staleCtx, stale: true,
          seq: TAIL - k,                       // deliberately out of order
          data: Buffer.alloc(480).toString('base64'),
        })), 10 + k * 12);
      }
      return;
    }
    if (typeof m.text === 'string') {
      ctx = m.contextId ?? null;
      const words = m.text.split(/\s+/);
      ws.send(JSON.stringify({ type: 'STUB_timestamps', contextId: ctx,
        word_timestamps: { words, start: words.map((_, i) => i * 0.3), end: words.map((_, i) => i * 0.3 + 0.28) } }));
      let i = 0;
      timer = setInterval(() => {
        if (i++ >= 10) { clearInterval(timer); ws.send(JSON.stringify({ type: 'STUB_done', contextId: ctx })); return; }
        ws.send(JSON.stringify({ type: 'STUB_chunk', contextId: ctx, data: Buffer.alloc(480).toString('base64') }));
      }, 60);
    }
  });
  ws.on('close', () => clearInterval(timer));
});
