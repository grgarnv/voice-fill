// Shape-agnostic voice-catalog parser.
//
// Rime's all-v2.json is not a contractually stable shape, and the first version
// of this walker only handled objects carrying a `name` field. A catalog that
// nests plain arrays of voice-name STRINGS under model/language keys produced
// zero entries and a confusing "no mistv2 English voice" failure. This version
// keys off the PATH to each leaf, so it works whether voices arrive as strings
// in arrays or as objects with fields.

const MODEL_RE = /(mistv\d|mist_v\d|mist|codav?\d?|coda|arcana)/i;
const LANG_RE = /^(eng|en|english|spa|es|spanish|fre|fr|french|ger|de|german|hin|hi|hindi)$/i;

const normModel = s => {
  if (!s) return null;
  const m = String(s).match(MODEL_RE);
  if (!m) return null;
  return m[1].toLowerCase().replace('mist_v', 'mistv');
};
const normLang = s => {
  if (!s) return null;
  const t = String(s).toLowerCase();
  if (/^(eng|en|english)$/.test(t)) return 'eng';
  if (/^(spa|es|spanish)$/.test(t)) return 'spa';
  if (/^(fre|fr|french)$/.test(t)) return 'fre';
  if (/^(ger|de|german)$/.test(t)) return 'ger';
  if (/^(hin|hi|hindi)$/.test(t)) return 'hin';
  return null;
};

/** Returns [{ name, model, lang, path }] from any nesting arrangement. */
export function parseCatalog(root) {
  const out = [];

  const walk = (node, path) => {
    // Context inferred from every key seen on the way down.
    const ctxModel = path.map(normModel).filter(Boolean).pop() ?? null;
    const ctxLang = path.map(normLang).filter(Boolean).pop() ?? null;

    if (typeof node === 'string') {
      // A bare string inside the tree is a voice name, if we know its context.
      if (node.length < 64 && !/^https?:/.test(node)) {
        out.push({ name: node, model: ctxModel, lang: ctxLang, path: path.join('.') });
      }
      return;
    }
    if (Array.isArray(node)) { node.forEach((v, i) => walk(v, path)); return; }
    if (node && typeof node === 'object') {
      // Object-style entry: fields win over path context.
      const name = node.name ?? node.speaker ?? node.voice ?? node.id;
      if (typeof name === 'string') {
        out.push({
          name,
          model: normModel(node.model ?? node.modelId ?? node.model_id) ?? ctxModel,
          lang: normLang(node.lang ?? node.language ?? node.languageCode) ?? ctxLang,
          demographic: node.demographic ?? node.gender ?? null,
          path: path.join('.'),
        });
        // Some entries also list supported models as an array.
        const models = node.models ?? node.supportedModels;
        if (Array.isArray(models)) for (const m of models) {
          const nm = normModel(typeof m === 'string' ? m : m?.name ?? m?.id);
          if (nm) out.push({ name, model: nm, lang: normLang(node.lang ?? node.language) ?? ctxLang, path: path.join('.') });
        }
        return;
      }
      for (const [k, v] of Object.entries(node)) walk(v, [...path, k]);
    }
  };

  walk(root, []);

  // Dedupe on name+model+lang.
  const seen = new Set();
  return out.filter(v => {
    const k = `${v.name}|${v.model}|${v.lang}`;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
}

/** English voices for a model (default: the configured RIME_MODEL_ID, else coda). */
export function selectModelEnglish(voices, model = process.env.RIME_MODEL_ID || 'coda') {
  // Strict: explicitly this model and explicitly English.
  const strict = voices.filter(v => v.model === model && v.lang === 'eng');
  if (strict.length) return { voices: strict, confidence: 'strict' };
  // Model known, language unlabelled (a catalog that only splits by model).
  const modelOnly = voices.filter(v => v.model === model && v.lang === null);
  if (modelOnly.length) return { voices: modelOnly, confidence: 'model-only (language not labelled in catalog)' };
  // English known, model unlabelled.
  const langOnly = voices.filter(v => v.lang === 'eng' && v.model === null);
  if (langOnly.length) return { voices: langOnly, confidence: 'lang-only (model not labelled - VERIFY with probe 01)' };
  return { voices: [], confidence: 'none' };
}

/** Kept for the self-test's shape regression, which was written against mistv2. */
export const selectMistV2English = (voices) => selectModelEnglish(voices, 'mistv2');
