// PROBE 02 - phonemizeBetweenBrackets on mistv2, plus the mistv3 question.
//
// v1 WAS AN INVALID EXPERIMENT. It compared "{g1orby0ul2Ets}" WITH the flag
// against "glorbyoulets" WITHOUT it - two variables changed at once, so a
// difference proved nothing about the flag. v2 holds the TEXT constant and
// toggles only the flag. If the flag is silently ignored (the failure mode the
// PRD warns about), the two renders are byte-identical.
//
// v1 also reported a mistv3 400 as if it settled the docs discrepancy. It did
// not: the error was "Speaker 'abbie' not found ... for language 'en'", a
// wrong-speaker error. v2 resolves a real mistv3 speaker before concluding.
import { ttsRest, cfg, fetchCatalog, saveArtifact } from './lib/rime.mjs';
import { parseCatalog } from './lib/catalog.mjs';
import { record, classify } from './lib/report.mjs';

const BRACKETED = 'actually, {g1orby0ul2Ets} is made up.';
const PLAIN     = 'actually, glorbyoulets is made up.';

async function mistv3Speaker() {
  try {
    const voices = parseCatalog(await fetchCatalog());
    const v3 = voices.filter(v => v.model === 'mistv3');
    return v3[0]?.name ?? null;
  } catch { return null; }
}

export default async function run(state) {
  const c = cfg();
  // phonemizeBetweenBrackets is a Mist v1/v2 feature. Since the 2026-09-06 switch
  // to coda this probe records what Mist can do, not what the product uses.
  const speaker = process.env.RIME_MIST_SPEAKER || 'abbie';
  try {
    // The controlled comparison: identical text, flag toggled.
    const on = await ttsRest({
      text: BRACKETED, speaker, modelId: 'mistv2',
      extra: { phonemizeBetweenBrackets: true }, saveAs: '02_flagON_bracketed.mp3',
    });
    const off = await ttsRest({
      text: BRACKETED, speaker, modelId: 'mistv2',
      extra: { phonemizeBetweenBrackets: false }, saveAs: '02_flagOFF_bracketed.mp3',
    });
    // Reference: what the word sounds like spelled normally, for the ear check.
    const plain = await ttsRest({
      text: PLAIN, speaker, modelId: 'mistv2', saveAs: '02_reference_plaintext.mp3',
    });

    if (!on.ok) {
      return record('02', 'phonemizeBetweenBrackets on mistv2', 'FAIL', {
        note: `HTTP ${on.status}: ${on.buf.toString('utf8').slice(0, 200)}`,
      });
    }

    const identical = on.buf.equals(off.buf);

    // mistv3, with a speaker that actually exists on mistv3.
    let v3 = { tested: false, note: 'no mistv3 speaker found in the catalog' };
    const v3name = await mistv3Speaker();
    if (v3name) {
      try {
        const r3on = await ttsRest({ text: BRACKETED, speaker: v3name, modelId: 'mistv3',
          extra: { phonemizeBetweenBrackets: true }, saveAs: '02_mistv3_flagON.mp3' });
        const r3off = await ttsRest({ text: BRACKETED, speaker: v3name, modelId: 'mistv3',
          extra: { phonemizeBetweenBrackets: false }, saveAs: '02_mistv3_flagOFF.mp3' });
        v3 = {
          tested: true, speaker: v3name,
          onStatus: r3on.status, offStatus: r3off.status,
          identical: r3on.ok && r3off.ok ? r3on.buf.equals(r3off.buf) : null,
          body: r3on.ok ? null : r3on.buf.toString('utf8').slice(0, 200),
        };
      } catch (e) { v3 = { tested: false, speaker: v3name, error: String(e.message).slice(0, 160) }; }
    }
    saveArtifact('02_mistv3.json', JSON.stringify(v3, null, 2));
    state.mistv3 = v3;

    if (identical) {
      return record('02', 'phonemizeBetweenBrackets on mistv2', 'FAIL', {
        note: `Flag ON and flag OFF produced BYTE-IDENTICAL audio for the same bracketed text ` +
              `(${on.bytes}B each). The flag is being ignored. This is the exact silent failure the PRD warns ` +
              `about - a 200 proves nothing. Check modelId and that the parameter name is spelled correctly.`,
        onBytes: on.bytes, offBytes: off.bytes,
      });
    }

    const v3note = v3.tested
      ? `mistv3 (speaker ${v3.speaker}): flag ON vs OFF ${v3.identical === true ? 'IDENTICAL -> flag ignored on mistv3, matching Rime docs' : v3.identical === false ? 'DIFFER -> mistv3 appears to honour it, contradicting Rime docs' : `on=${v3.onStatus} off=${v3.offStatus}`}`
      : `mistv3 not tested: ${v3.note || v3.error}`;

    return record('02', 'phonemizeBetweenBrackets on mistv2', 'PASS', {
      note: `Same text, flag toggled -> renders DIFFER (ON=${on.bytes}B OFF=${off.bytes}B), so the flag is honoured. ` +
            `EAR CHECK REQUIRED: 02_flagON_bracketed.mp3 must say the invented word as speech; ` +
            `02_flagOFF_bracketed.mp3 should mangle it or read the brackets; ` +
            `02_reference_plaintext.mp3 is the unbracketed control. | ${v3note}`,
      onBytes: on.bytes, offBytes: off.bytes, plainBytes: plain.bytes, mistv3: v3, requiresEarCheck: true,
    });
  } catch (e) {
    const { status, note } = classify(e);
    return record('02', 'phonemizeBetweenBrackets on mistv2', status, { note });
  }
}
