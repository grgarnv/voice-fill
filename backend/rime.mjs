// Backend-side Rime /ws3 client. The API key lives here and is never shipped
// to the extension - a credential in extension code makes the entry ineligible.
import WebSocket from 'ws';

export function connectRime({ speaker, modelId, audioFormat, lang, samplingRate }) {
  const u = new URL(process.env.RIME_WS_URL || 'wss://users-ws.rime.ai/ws3');
  u.searchParams.set('speaker', speaker);
  u.searchParams.set('modelId', modelId);
  u.searchParams.set('audioFormat', audioFormat);
  u.searchParams.set('lang', lang);
  if (samplingRate) u.searchParams.set('samplingRate', String(samplingRate));
  return new WebSocket(u.toString(), {
    headers: { Authorization: `Bearer ${process.env.RIME_API_KEY}` },
    handshakeTimeout: 15000,
  });
}
