// PROBE 06 - Do inbound frames carry the contextId we sent?
//
// v1 sent both utterances 700ms apart and stopped after 12 chunks. Measured
// TTFA is 1.3-1.7s and a sentence yields ~5 chunks, so the window closed before
// the second context produced anything. It then reported "contextId is not
// echoed" while its own evidence showed the FIRST id echoed correctly. Wrong
// verdict from an under-run probe.
//
// v2 separates two questions that v1 conflated:
//   Q1. Does the server echo contextId at all?          -> gates F3.3 as designed
//   Q2. Can two contexts be interleaved on one socket?  -> shapes the session model
// Utterance B is sent only after A's audio is actually flowing, and collection
// runs until both are seen or a generous timeout.
import { openWs3, collect, audioFrames, cfg, saveArtifact } from './lib/rime.mjs';
import { record, classify } from './lib/report.mjs';

const ID_A = 'turn-AAA-111', ID_B = 'turn-BBB-222';

/** Every string value under any key containing "context", with its frame type. */
function contextIds(frames) {
  const hits = [];
  const scan = (o, type) => {
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) {
      if (/context/i.test(k) && typeof v === 'string') hits.push({ id: v, type });
      else if (typeof v === 'object') scan(v, type);
    }
  };
  frames.forEach(f => scan(f.msg, f.msg.type || '__untyped__'));
  return hits;
}

export default async function run(state) {
  const c = cfg();
  const speaker = state.speaker || c.speaker;
  try {
    const ws = openWs3({ speaker, modelId: c.model, audioFormat: 'pcm', samplingRate: 24000 });
    let firstChunkAt = null, sentB = false, sawB = false;

    const out = await collect(ws, {
      onOpen: ({ ws }) => ws.send(JSON.stringify({ text: 'First utterance for context A.', contextId: ID_A })),
      done: ({ msg, at, ws: sock, frames }) => {
        if (audioFrames([{ msg, at }]).length && firstChunkAt === null) firstChunkAt = at;
        // Send B only once A is genuinely producing audio.
        if (firstChunkAt !== null && !sentB && at >= firstChunkAt + 300) {
          sentB = true;
          sock.send(JSON.stringify({ text: 'Second utterance for context B.', contextId: ID_B }));
        }
        if (contextIds(frames).some(h => h.id === ID_B)) sawB = true;
        return sawB && audioFrames(frames).length > 6;
      },
      timeoutMs: 45000,
    });

    const hits = contextIds(out.frames);
    const ids = [...new Set(hits.map(h => h.id))];
    const echoedOnChunks = hits.some(h => /chunk|audio/i.test(h.type));
    const echoedOnTimestamps = hits.some(h => /timestamp/i.test(h.type));
    saveArtifact('06_context.json', JSON.stringify({
      ids, hits, sentB, sawB,
      frameTypes: [...new Set(out.frames.map(f => f.msg.type))],
      reason: out.reason,
    }, null, 2));

    const echoesA = ids.includes(ID_A), echoesB = ids.includes(ID_B);
    state.contextEchoed = echoesA || echoesB;
    state.contextOnChunks = echoedOnChunks;

    if (!echoesA && !echoesB) {
      return record('06', 'Inbound frames echo contextId', 'FAIL', {
        note: `No sent contextId came back. Ids seen: ${JSON.stringify(ids)}. ` +
              `ARCHITECTURE CONSEQUENCE: stale-chunk rejection cannot key on server contextId. ` +
              `Use a local generation counter incremented on every barge-in, applied at the ` +
              `offscreen player's enqueue boundary.`,
        ids,
      });
    }

    if (!echoedOnChunks) {
      // Echoing on control frames but not on audio chunks is the important
      // distinction: F3.3 filters CHUNKS, so this still forces a local counter.
      return record('06', 'Inbound frames echo contextId', 'FAIL', {
        note: `contextId is echoed (${JSON.stringify(ids)}) but NOT on audio chunk frames - only on ` +
              `${JSON.stringify([...new Set(hits.map(h => h.type))])}. F3.3 filters chunks, so a server-side ` +
              `id cannot be used for stale-drop. Use a local generation counter; the echoed id remains ` +
              `useful for correlating timestamp frames to a turn.`,
        ids, echoedOnTimestamps,
      });
    }

    if (echoesA && !echoesB) {
      return record('06', 'Inbound frames echo contextId', 'PASS', {
        note: `contextId IS echoed on chunk frames (${JSON.stringify(ids)}), so F3.3 stale-drop works as designed. ` +
              `However the second context produced no frames within ${out.elapsedMs.toFixed(0)}ms ` +
              `(sentB=${sentB}) - this connection appears to serve one utterance at a time. ` +
              `SESSION MODEL: queue utterances client-side, or open a fresh context per turn; do not assume ` +
              `two turns can overlap on one socket.`,
        ids, oneAtATime: true, echoedOnChunks,
      });
    }

    return record('06', 'Inbound frames echo contextId', 'PASS', {
      note: `Both ids echoed on chunk frames (${JSON.stringify(ids)}). F3.3 stale-drop by contextId is ` +
            `implementable as designed, and two contexts can coexist on one connection.`,
      ids, oneAtATime: false, echoedOnChunks,
    });
  } catch (e) {
    const { status, note } = classify(e);
    return record('06', 'Inbound frames echo contextId', status, { note });
  }
}
