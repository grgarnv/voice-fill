// PROBE 03 - Do pauseBetweenBrackets and phonemizeBetweenBrackets coexist?
// Not in the PRD's task list, but Phase 2 read-back needs BOTH in one utterance:
//   "S as in Sierra, <300> F as in Foxtrot ... {phonemes for a name}"
// If they conflict, the whole normalization design changes - and it must change now.
import { ttsRest, cfg } from './lib/rime.mjs';
import { record, classify } from './lib/report.mjs';

const BOTH = 'Your P I N is one six zero, <300> zero seven one. <400> Name: {g1orby0ul2Ets}. Correct?';

export default async function run(state) {
  const c = cfg();
  // phonemizeBetweenBrackets is a Mist v1/v2 feature. Since the 2026-09-06 switch
  // to coda this probe records what Mist can do, not what the product uses.
  const speaker = process.env.RIME_MIST_SPEAKER || 'abbie';
  try {
    const both = await ttsRest({
      text: BOTH, speaker, modelId: 'mistv2',
      extra: { phonemizeBetweenBrackets: true, pauseBetweenBrackets: true },
      saveAs: '03_pause_plus_phoneme.mp3',
    });
    const neither = await ttsRest({
      text: BOTH, speaker, modelId: 'mistv2', saveAs: '03_neither_flag.mp3',
    });

    if (!both.ok) {
      return record('03', 'pauseBetweenBrackets + phonemizeBetweenBrackets together', 'FAIL', {
        note: `HTTP ${both.status}: ${both.buf.toString('utf8').slice(0, 300)}`,
      });
    }
    if (both.buf.equals(neither.buf)) {
      return record('03', 'pauseBetweenBrackets + phonemizeBetweenBrackets together', 'FAIL', {
        note: 'Both-flags render is byte-identical to no-flags render; at least one flag is ignored when combined.',
      });
    }
    return record('03', 'pauseBetweenBrackets + phonemizeBetweenBrackets together', 'PASS', {
      note: `Accepted together (${both.bytes}B vs ${neither.bytes}B baseline). ` +
            `EAR CHECK: must hear a real gap after "one six zero" AND a spoken name, ` +
            `with no literal "300" or bracket characters read aloud.`,
      requiresEarCheck: true, bytes: both.bytes,
    });
  } catch (e) {
    const { status, note } = classify(e);
    return record('03', 'pauseBetweenBrackets + phonemizeBetweenBrackets together', status, { note });
  }
}
