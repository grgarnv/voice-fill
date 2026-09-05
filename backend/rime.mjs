// Backend-side Rime /ws3 client. The API key lives here and is never shipped
// to the extension - a credential in extension code makes the entry ineligible.
import WebSocket from 'ws';

/**
 * Phase 1 verification (tools/verify_ws3_params.mjs) established two things that
 * are NOT interchangeable with the REST API's shape:
 *
 *   segment=never          honoured as a query param. Nothing synthesises until
 *                          an explicit {"operation":"flush"}, which is what
 *                          keeps `clear` able to catch anything at all (Phase 0
 *                          probe 05: 83% of buffered audio cancellable, ~0%
 *                          once committed).
 *   pauseBetweenBrackets   honoured ONLY as a query param. Sent as a per-message
 *                          field - the way REST accepts it - it is silently
 *                          ignored and every <400> pause token in a prompt gets
 *                          read out loud as "less than four hundred greater
 *                          than". Measured: 2.17s unflagged, 4.17s query param,
 *                          2.17s per-message.
 *
 * Both are therefore connection-level and set here, once, on the URL.
 */
export function connectRime({ speaker, modelId, audioFormat, lang, samplingRate, segment, pauseBetweenBrackets, phonemizeBetweenBrackets }) {
  const u = new URL(process.env.RIME_WS_URL || 'wss://users-ws.rime.ai/ws3');
  u.searchParams.set('speaker', speaker);
  u.searchParams.set('modelId', modelId);
  u.searchParams.set('audioFormat', audioFormat);
  u.searchParams.set('lang', lang);
  if (samplingRate) u.searchParams.set('samplingRate', String(samplingRate));
  if (segment) u.searchParams.set('segment', String(segment));
  if (pauseBetweenBrackets) u.searchParams.set('pauseBetweenBrackets', 'true');
  if (phonemizeBetweenBrackets) u.searchParams.set('phonemizeBetweenBrackets', 'true');
  return new WebSocket(u.toString(), {
    headers: { Authorization: `Bearer ${process.env.RIME_API_KEY}` },
    handshakeTimeout: 15000,
  });
}
