// PROBE 00 - Live voice catalog. Locks a real mistv2 English speaker + a fallback.
// PRD: "Pick from live catalog on day 1 - must be a mistv2 English voice."
//
// The catalog's JSON shape is not contractually fixed. Parsing lives in
// lib/catalog.mjs and is path-based, so it works whether voices arrive as bare
// strings nested under model/language keys or as objects carrying fields.
import { fetchCatalog, cfg, saveArtifact } from './lib/rime.mjs';
import { parseCatalog, selectMistV2English } from './lib/catalog.mjs';
import { record, classify } from './lib/report.mjs';

/** Compact structural summary, printed on failure so one run is enough to diagnose. */
function skeleton(n, depth = 0, path = '(root)', lines = []) {
  const pad = '  '.repeat(depth);
  if (Array.isArray(n)) {
    lines.push(`${pad}${path}: array[${n.length}] of ${[...new Set(n.map(x => typeof x))].join('|')}`);
    if (n.length && typeof n[0] === 'string') lines.push(`${pad}  e.g. ${JSON.stringify(n.slice(0, 5))}`);
    else if (n.length && depth < 3) skeleton(n[0], depth + 1, '[0]', lines);
  } else if (n && typeof n === 'object') {
    const k = Object.keys(n);
    lines.push(`${pad}${path}: object {${k.slice(0, 10).join(', ')}${k.length > 10 ? `, +${k.length - 10}` : ''}}`);
    if (depth < 3) for (const key of k.slice(0, 5)) skeleton(n[key], depth + 1, key, lines);
  } else {
    lines.push(`${pad}${path}: ${typeof n}`);
  }
  return lines;
}

export default async function run() {
  const c = cfg();
  try {
    const cat = await fetchCatalog();
    saveArtifact('voices-all-v2.json', JSON.stringify(cat, null, 2));

    const voices = parseCatalog(cat);
    const { voices: mist2, confidence } = selectMistV2English(voices);

    if (mist2.length === 0) {
      // Print the shape inline. A second "go look at the file" round trip costs
      // more than the twenty lines this takes.
      const shape = skeleton(cat).join('\n        ');
      const models = [...new Set(voices.map(v => v.model))].filter(Boolean);
      const langs = [...new Set(voices.map(v => v.lang))].filter(Boolean);
      return record('00', 'Live catalog: mistv2 English speakers', 'FAIL', {
        note: `Catalog fetched OK, parsed ${voices.length} voice entries, but none resolved to mistv2+English.\n` +
              `        models seen: ${JSON.stringify(models)}  langs seen: ${JSON.stringify(langs)}\n` +
              `        sample: ${JSON.stringify(voices.slice(0, 5))}\n` +
              `        structure:\n        ${shape}\n` +
              `        -> Set RIME_SPEAKER in .env to a mistv2 English voice and re-run; probe 01 will confirm it.`,
        parsed: voices.length, models, langs,
      });
    }

    // Honour an explicit RIME_SPEAKER, but refuse it if the catalog disagrees.
    if (c.speaker && !mist2.some(v => v.name === c.speaker)) {
      const known = voices.filter(v => v.name === c.speaker);
      return record('00', 'Live catalog: mistv2 English speakers', 'FAIL', {
        note: `RIME_SPEAKER="${c.speaker}" is not a mistv2 English voice. ` +
              (known.length ? `Catalog lists it as ${JSON.stringify(known.map(k => `${k.model}/${k.lang}`))}. ` : 'It is not in the catalog at all. ') +
              `PRD rule: change the speaker, not the model. Candidates: ${mist2.slice(0, 10).map(v => v.name).join(', ')}`,
        candidates: mist2.map(v => v.name),
      });
    }

    const chosen = c.speaker || mist2[0].name;
    const fallback = mist2.find(v => v.name !== chosen)?.name ?? null;

    if (!fallback) {
      // Risk register: "Speaker missing from mistv2 at submission - Low / Fatal.
      // Keep a second speaker configured." One voice means no fallback exists.
      return record('00', 'Live catalog: mistv2 English speakers', 'PASS', {
        note: `speaker=${chosen}, NO FALLBACK AVAILABLE (only one mistv2/eng voice found). ` +
              `Confidence: ${confidence}. Note this in the risk register.`,
        chosen, fallback: null, confidence, candidates: mist2.map(v => v.name),
      });
    }

    return record('00', 'Live catalog: mistv2 English speakers', 'PASS', {
      note: `speaker=${chosen} fallback=${fallback} (${mist2.length} mistv2/eng voices). Confidence: ${confidence}` +
            (confidence === 'strict' ? '' : ' <- probe 01 must confirm this speaker actually renders on mistv2'),
      chosen, fallback, confidence, candidates: mist2.slice(0, 25).map(v => v.name),
    });
  } catch (e) {
    const { status, note } = classify(e);
    return record('00', 'Live catalog: mistv2 English speakers', status, { note });
  }
}
