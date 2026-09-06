// PROBE 01 - REST synthesis on mistv2 with the locked speaker.
// Proves credential + model + speaker are a valid triple and return real audio.
import { ttsRest, cfg } from './lib/rime.mjs';
import { record, classify } from './lib/report.mjs';

export default async function run(state) {
  const c = cfg();
  const speaker = state.speaker || c.speaker;
  try {
    const r = await ttsRest({
      text: 'Phase zero preflight. Rime is speaking.',
      speaker, modelId: c.model, saveAs: '01_rest_baseline.mp3',
    });
    if (!r.ok) {
      return record('01', `REST /v1/rime-tts on ${c.model}`, 'FAIL', {
        note: `HTTP ${r.status}. Body head: ${r.buf.toString('utf8').slice(0, 200)}`,
      });
    }
    // A 200 with a tiny or non-audio body is a silent failure. Check the bytes.
    const isMp3 = r.buf.length > 4 && (r.buf[0] === 0xff || r.buf.subarray(0, 3).toString() === 'ID3');
    if (r.bytes < 2000) {
      return record('01', `REST /v1/rime-tts on ${c.model}`, 'FAIL', {
        note: `200 OK but only ${r.bytes} bytes - suspiciously small for this text. Do not trust the 200.`,
      });
    }
    return record('01', `REST /v1/rime-tts on ${c.model}`, 'PASS', {
      note: `${r.bytes} bytes, content-type=${r.contentType}, mp3-magic=${isMp3} -> ${r.savedTo}. LISTEN TO IT.`,
      bytes: r.bytes, savedTo: r.savedTo, speaker, model: c.model,
    });
  } catch (e) {
    const { status, note } = classify(e);
    return record('01', `REST /v1/rime-tts on ${c.model}`, status, { note });
  }
}
