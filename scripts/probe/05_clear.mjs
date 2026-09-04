// PROBE 05 - what `clear` actually cancels on /ws3.
//
// Three versions of this probe were wrong in the same way, so the failure is
// worth naming: each one sent text that the server DISPATCHED IMMEDIATELY, then
// tried to observe a buffer cancellation. Under the default segment=bySentence,
// any text ending in '.' '?' or '!' goes straight to synthesis on arrival, so
// the accumulated buffer is empty before the cancel is ever sent. ~0% saved was
// not evidence about `clear`; it was evidence the experiment could not see it.
//
// v4 uses segment=never, where nothing is synthesised until the client sends an
// explicit flush. That makes the buffer real and the question answerable, and it
// splits two things the architecture needs separately:
//
//   A. Does clear empty BUFFERED text?      -> determines wasted synthesis cost
//   B. Does clear stop IN-FLIGHT synthesis? -> determines the barge-in tail
//
// A is decisive and fast. B is the one that shapes Phase 3.
import { openWs3, collect, audioFrames, cfg, saveArtifact } from './lib/rime.mjs';
import { record, classify } from './lib/report.mjs';

const TOKENS = [
  'This is the first part of a prompt. ',
  'This is the second part, which should be cancellable. ',
  'This is the third part, which should never be synthesised. ',
  'And this is the fourth part, which should also never be heard.',
];

const bytesOf = fs => fs.reduce((n, f) =>
  n + (typeof f.msg.data === 'string' ? Buffer.from(f.msg.data, 'base64').length : 0), 0);
const sec = b => +(b / 48000).toFixed(2);   // pcm 24kHz mono 16-bit

/**
 * TEST A - buffered text. segment=never means nothing synthesises until flush,
 * so `clear` has something real to act on.
 */
async function bufferTest(speaker, model, { cancelWith = null } = {}) {
  const ws = openWs3({ speaker, modelId: model, audioFormat: 'pcm', samplingRate: 24000, segment: 'never' });
  let flushed = false;
  const out = await collect(ws, {
    onOpen: ({ ws }) => {
      TOKENS.forEach(t => ws.send(JSON.stringify({ text: t, contextId: 'probe05' })));
      if (cancelWith) ws.send(JSON.stringify(cancelWith));   // cancel BEFORE flush
      ws.send(JSON.stringify({ operation: 'flush' }));
      flushed = true;
    },
    done: ({ msg }) => /^done$/i.test(msg.type || ''),
    // A cancelled buffer may never produce a done event; bound the wait.
    timeoutMs: cancelWith ? 12000 : 45000,
  });
  const chunks = audioFrames(out.frames);
  return { cancelWith, flushed, chunks: chunks.length, bytes: bytesOf(chunks), audioSec: sec(bytesOf(chunks)), reason: out.reason };
}

/**
 * TEST B - in-flight synthesis. Flush first, wait for audio to actually start,
 * then cancel. This is the real barge-in shape.
 */
async function inFlightTest(speaker, model, { cancelWith = null, settleMs = 250 } = {}) {
  const ws = openWs3({ speaker, modelId: model, audioFormat: 'pcm', samplingRate: 24000, segment: 'never' });
  let firstChunkAt = null, clearAt = null, armed = false;
  const out = await collect(ws, {
    onOpen: ({ ws }) => {
      TOKENS.forEach(t => ws.send(JSON.stringify({ text: t, contextId: 'probe05' })));
      ws.send(JSON.stringify({ operation: 'flush' }));
    },
    done: ({ msg, at, ws: sock }) => {
      if (audioFrames([{ msg, at }]).length && firstChunkAt === null) firstChunkAt = at;
      if (cancelWith && firstChunkAt !== null && !armed && at >= firstChunkAt + settleMs) {
        armed = true; clearAt = at; sock.send(JSON.stringify(cancelWith));
      }
      if (/^done$/i.test(msg.type || '')) return true;
      return clearAt !== null && at > clearAt + 4000;
    },
    timeoutMs: 45000,
  });
  const chunks = audioFrames(out.frames);
  const after = chunks.filter(f => clearAt !== null && f.at >= clearAt);
  return {
    cancelWith, firstChunkAt, clearAt,
    chunks: chunks.length, bytes: bytesOf(chunks), audioSec: sec(bytesOf(chunks)),
    tailChunks: after.length, tailBytes: bytesOf(after),
    tailMs: after.length ? after[after.length - 1].at - clearAt : 0,
    reason: out.reason,
  };
}

const VARIANTS = [{ operation: 'clear' }, { type: 'clear' }];

export default async function run(state) {
  const c = cfg();
  const speaker = state.speaker || c.speaker;
  try {
    // --- A: buffered text ---
    const bufBase = await bufferTest(speaker, c.model);
    if (bufBase.bytes === 0) {
      return record('05', 'clear cancels queued synthesis', 'FAIL', {
        note: `Control produced NO audio under segment=never + flush (${bufBase.reason}). ` +
              `The flush workflow is not behaving as documented, so nothing downstream is measurable. ` +
              `Probe issue, not a clear result.`,
        bufBase,
      });
    }

    let bufBest = null;
    const bufAttempts = [];
    for (const v of VARIANTS) {
      const r = await bufferTest(speaker, c.model, { cancelWith: v });
      r.savedFraction = 1 - r.bytes / bufBase.bytes;
      bufAttempts.push(r);
      if (r.savedFraction > 0.8) { bufBest = r; break; }
    }

    // --- B: in-flight synthesis ---
    const flightBase = await inFlightTest(speaker, c.model);
    const flightVariant = bufBest?.cancelWith ?? VARIANTS[0];
    const flight = await inFlightTest(speaker, c.model, { cancelWith: flightVariant });
    flight.savedFraction = flightBase.bytes ? 1 - flight.bytes / flightBase.bytes : 0;

    saveArtifact('05_clear.json', JSON.stringify(
      { buffered: { control: bufBase, attempts: bufAttempts }, inFlight: { control: flightBase, test: flight } }, null, 2));

    state.clearBuffered = !!bufBest;
    state.clearInFlight = flight.savedFraction > 0.35;
    state.clearVariant = bufBest?.cancelWith ?? null;

    const flightNote = `In-flight: cancel ${(flight.clearAt - flight.firstChunkAt).toFixed(0)}ms after first audio ` +
      `saved ${(flight.savedFraction * 100).toFixed(0)}% (${flight.audioSec}s vs ${flightBase.audioSec}s), ` +
      `tail ${flight.tailChunks} chunks / ${sec(flight.tailBytes)}s over ${flight.tailMs.toFixed(0)}ms.`;

    if (!bufBest) {
      const a = bufAttempts[0];
      return record('05', 'clear cancels queued synthesis', 'FAIL', {
        note: `Buffered: clear before flush saved only ${(a.savedFraction * 100).toFixed(0)}% ` +
              `(${a.audioSec}s vs ${bufBase.audioSec}s). Tried ${JSON.stringify(VARIANTS)}. ${flightNote} ` +
              `CONSEQUENCE: no usable upstream cancel. Barge-in relies entirely on local flush plus stale-frame ` +
              `drop by contextId (probe 06 confirmed that works), so the 300ms LOCAL silence budget is unaffected - ` +
              `but interrupted prompts are synthesised and billed in full. MITIGATION: one short question per ` +
              `utterance, which the PRD already requires.`,
        buffered: { control: bufBase, attempts: bufAttempts }, inFlight: flight,
      });
    }

    return record('05', 'clear cancels queued synthesis', 'PASS', {
      note: `Buffered: ${JSON.stringify(bufBest.cancelWith)} before flush cancelled ` +
            `${(bufBest.savedFraction * 100).toFixed(0)}% (${bufBest.audioSec}s vs ${bufBase.audioSec}s). ${flightNote} ` +
            (state.clearInFlight
              ? `Upstream cancel works on both buffered and in-flight audio; the tail must still be dropped locally.`
              : `NOTE: clear empties the BUFFER but does not stop audio already synthesising. Barge-in design: ` +
                `send prompts under segment=never in short flushes so a cancel has something to catch.`),
      buffered: { control: bufBase, best: bufBest }, inFlight: flight,
    });
  } catch (e) {
    const { status, note } = classify(e);
    return record('05', 'clear cancels queued synthesis', status, { note });
  }
}
