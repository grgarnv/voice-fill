// PROBE 04 - /ws3 connect, chunk stream, word timestamps. Runs BOTH pcm and mp3.
// The pcm-vs-mp3 decision is the load-bearing Phase 0 call: the heard ledger is
// computed by comparing Rime word timestamps against a local playback clock, and
// chunked mp3 decode inserts frame-boundary padding that makes those two drift.
import { openWs3, collect, audioFrames, timestampFrames, extractWordTimestamps, cfg, saveArtifact } from './lib/rime.mjs';
import { record, classify } from './lib/report.mjs';

const TEXT = 'Hello. What is your postal code, and what is your reference number?';

// PRD Phase 5 requires cached vs uncached numbers labelled separately, with
// "cold" defined as the first utterance after a new WS connection. Measuring
// only cold overstates latency for every turn after the first.
async function oneFormat(speaker, model, fmt) {
  const ws = openWs3({ speaker, modelId: model, audioFormat: fmt, samplingRate: fmt === 'pcm' ? 24000 : undefined });
  const COLD_CTX = `probe04-${fmt}-cold`, WARM_CTX = `probe04-${fmt}-warm`;
  let coldFirstAudio = null, warmSentAt = null, warmFirstAudio = null, sentWarm = false, doneCount = 0;

  // Identify which utterance a frame belongs to by its echoed contextId.
  // Earlier versions used "first audio after the warm send", but probe 05 showed
  // the cold utterance's tail is ~7s delivered in under a second - so that rule
  // measured cold tail chunks, not warm latency. contextId is exact.
  const ctxOf = (msg) => {
    let found = null;
    const scan = o => { if (!o || typeof o !== 'object') return;
      for (const [k, v] of Object.entries(o)) {
        if (/context/i.test(k) && typeof v === 'string') found ??= v;
        else if (typeof v === 'object') scan(v);
      } };
    scan(msg); return found;
  };

  const out = await collect(ws, {
    onOpen: ({ ws }) => ws.send(JSON.stringify({ text: TEXT, contextId: COLD_CTX })),
    done: ({ msg, at, ws: sock }) => {
      const isAudio = audioFrames([{ msg, at }]).length > 0;
      const ctx = ctxOf(msg);
      if (isAudio && coldFirstAudio === null) coldFirstAudio = at;

      // Send the warm utterance only once the cold one has fully completed.
      // Sending it mid-stream measured queueing delay, not warm latency.
      if (/^done$/i.test(msg.type || '')) doneCount++;
      if (!sentWarm && doneCount >= 1) {
        sentWarm = true; warmSentAt = at;
        sock.send(JSON.stringify({ text: 'And what is your date of birth?', contextId: WARM_CTX }));
        return false;
      }
      // Warm audio is identified by contextId, never by arrival order.
      if (isAudio && sentWarm && warmFirstAudio === null && ctx === WARM_CTX) warmFirstAudio = at;

      if (warmFirstAudio !== null) return true;
      return sentWarm && at > warmSentAt + 15000;   // bounded, never infinite
    },
    timeoutMs: 60000,
  });
  const chunks = audioFrames(out.frames);
  const tsFrames = timestampFrames(out.frames);
  const wt = tsFrames.length ? extractWordTimestamps(tsFrames[0].msg) : null;
  const firstAudioMs = chunks[0]?.at ?? null;

  let totalBytes = 0;
  for (const f of chunks) {
    const d = f.msg.data;
    if (typeof d === 'string') totalBytes += Buffer.from(d, 'base64').length;
  }
  return {
    fmt, url: ws.__url, reason: out.reason,
    chunkCount: chunks.length, totalAudioBytes: totalBytes,
    timestampFrameCount: tsFrames.length, wordTimestamps: wt,
    timeToFirstAudioMs: firstAudioMs,
    ttfaColdMs: coldFirstAudio,
    ttfaWarmMs: warmFirstAudio !== null && warmSentAt !== null ? warmFirstAudio - warmSentAt : null,
    frameTypes: [...new Set(out.frames.map(f => f.msg.type || '__untyped__'))],
    sampleFrame: out.frames[0]?.msg ?? null,
  };
}

export default async function run(state) {
  const c = cfg();
  const speaker = state.speaker || c.speaker;
  try {
    const pcm = await oneFormat(speaker, c.model, 'pcm');
    const mp3 = await oneFormat(speaker, c.model, 'mp3');
    saveArtifact('04_ws3_shapes.json', JSON.stringify({ pcm, mp3 }, null, 2));
    state.frameTypes = pcm.frameTypes;

    if (pcm.chunkCount === 0 && mp3.chunkCount === 0) {
      return record('04', '/ws3 chunks + word timestamps', 'FAIL', {
        note: `No audio chunks in either format. Frame types seen: ${JSON.stringify(pcm.frameTypes)}. Close reason: ${pcm.reason}`,
      });
    }
    if (!pcm.wordTimestamps && !mp3.wordTimestamps) {
      return record('04', '/ws3 chunks + word timestamps', 'FAIL', {
        note: `Chunks arrived but NO word timestamps could be extracted. This is fatal for the heard ledger. ` +
              `Frame types: ${JSON.stringify(pcm.frameTypes)}. Inspect artifacts/preflight/04_ws3_shapes.json and ` +
              `update extractWordTimestamps() for the real field names.`,
      });
    }
    const wt = pcm.wordTimestamps || mp3.wordTimestamps;
    state.wordTimestampShape = wt ? Object.keys(wt) : null;
    return record('04', '/ws3 chunks + word timestamps', 'PASS', {
      note: `pcm: ${pcm.chunkCount} chunks/${pcm.totalAudioBytes}B, TTFA cold ${pcm.ttfaColdMs?.toFixed(0)}ms / warm ${pcm.ttfaWarmMs?.toFixed(0) ?? 'n/a'}ms | ` +
            `mp3: ${mp3.chunkCount} chunks/${mp3.totalAudioBytes}B, TTFA cold ${mp3.ttfaColdMs?.toFixed(0)}ms / warm ${mp3.ttfaWarmMs?.toFixed(0) ?? 'n/a'}ms | ` +
            `${wt.count} word timestamps. DECISION: use pcm (see PHASE0 report).` +
            (pcm.ttfaColdMs > 1000 ? ` WARNING: cold TTFA over 1s - pre-warm the socket before the demo.` : ''),
      pcm, mp3,
    });
  } catch (e) {
    const { status, note } = classify(e);
    return record('04', '/ws3 chunks + word timestamps', status, { note });
  }
}
