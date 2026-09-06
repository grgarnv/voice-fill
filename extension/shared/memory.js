// Personal voice memory and natural correction.
//
// Two problems, both solved the same way the intent layer solves everything:
// the model interprets, a function executes.
//
//   SPELLING   "Arnav is A R N A V and Garg is G A R G" is not the value
//              "Arnav Garg Arnav Garg", and it is not the literal text
//              "A-R-N-A-V". It is a base value plus per-component letter
//              evidence, and assembling letters is string arithmetic.
//   CASING     "all caps" is one of five closed operations over a value, not
//              an instruction to a model to retype a string.
//   MEMORY     when STT hears "Enough" for "Arnav" a second time, the first
//              time's CONFIRMED correction is a candidate interpretation -
//              never an override, never global, never automatic.
//
// Pure: no DOM, no extension APIs, no network, no storage. The caller supplies
// the profile and persists it. Loaded as a classic script after normalize.js, the
// same way session-core.js and intent.js are, so the Node harness and the
// offscreen document run one implementation.
globalThis.VFMemory = (() => {
  'use strict';

  const N = () => globalThis.VFNormalize;

  /* ------------------------------------------------------------ helpers --- */

  const APOS = /['’]/g;
  const key = (s) => String(s ?? '').toLowerCase().replace(APOS, '').replace(/[^a-z0-9]/g, '');
  const title = (w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w);

  // Intents whose own parser in normalize.js already owns spelled input, and
  // which spelling must therefore stay out of:
  //   idnumber  wordsToAlphanumeric assembles letters AND NATO anchors
  //   email     parseEmail turns "a r n a v at gmail dot com" into an address
  //   digits/dates/amounts  wordsToDigits / parseDate / wordsToNumber
  // Running a second assembler over these would fight a working one.
  const SPELL_SKIP = new Set(['email', 'idnumber', 'date', 'dob', 'time', 'amount', 'phone',
    'postal', 'pin', 'number', 'age', 'quantity', 'yesno', 'password', 'file', 'color', 'url']);

  // Where an explicit casing instruction is meaningful. A digit string has no
  // case; a choice field's value must remain one of the option values; an email
  // is canonically lower and nothing else. Anything outside this is a question,
  // not a silent no-op - see caseError().
  const CASE_OK = new Set(['name', 'city', 'state', 'country', 'company', 'jobtitle',
    'address', 'comment', 'freetext', 'search', 'idnumber']);

  // What a learned correction may be recorded against. Deliberately small: the
  // point is personal VOCABULARY - names, places, institutions, employers - not
  // storing form answers. Everything sensitive or identifying is absent by
  // construction rather than by a filter that has to be kept in step.
  const LEARNABLE = new Set(['name', 'city', 'state', 'country', 'company', 'jobtitle', 'freetext']);

  /* ============================================================ spelling === */

  // Conversation around a value, never part of it. Includes the casing
  // vocabulary, so "Arnav Garg, all uppercase" yields the base "Arnav Garg".
  const FILLER = new Set(`spell spells spelled spelt spelling spellings it its that thats this these
    the my mine name names named first last full surname family given forename for you your yours i
    ill im is are was were be to a an of no nope nah not actually wait sorry um uh yes yeah yep ok
    okay so well please let me here goes write written put puts make makes made set sets as in with
    and but all caps capital capitals capitalise capitalize capitalised capitalized capitalisation
    capitalization uppercase lowercase upper lower case cases title normal normally word words letter
    letters whole thing entire everything both each every keep keeps only just like reads read goes
    said say says change changed correct corrected correction should would could`
    .split(/\s+/).filter(Boolean));

  const RUN_SEP = new Set([',', '.', '-', '–', '—']);
  // A comma or full stop inside a run may separate two SPELLED WORDS ("A R N A
  // V, G A R G") or merely the letters of one ("that's A, R, N, A, V"). Both
  // are real phrasings, so the run is kept as groups and the ambiguity is
  // resolved by group SIZE below - a run of single-letter groups is one word.
  const GROUP_SEP = new Set([',', '.']);
  const SEG_SEP = new Set([',', ';', '.', '!', '?', ':', '-', '–', '—']);
  const isLetter = (t) => t.length === 1 && /[a-z]/i.test(t);
  const tokenize = (text) => String(text ?? '').match(/[A-Za-z0-9’']+|[,;.!?:–—-]/g) || [];

  const SPELL_CUE = /\bspell(?:ed|s|ing|t)?\b/i;

  /**
   * The utterance as a flat list of { word } | { run: ['A','R',...] } | { sep }.
   *
   * A LETTER RUN is what makes spelling recognisable without a grammar: three
   * or more single-letter tokens in a row, separated by nothing but spaces,
   * commas, dashes or full stops - which covers "A R N A V", "A, R, N, A, V"
   * and "A-R-N-A-V" identically, because STT returns all three for the same
   * breath.
   *
   * THREE, not two, because two consecutive single letters happen by accident:
   * "it's a T shirt" would otherwise spell "AT". Two is allowed only when the
   * word "spell" is somewhere in the utterance, which is an explicit signal.
   */
  function scan(text) {
    const toks = tokenize(text);
    const minRun = SPELL_CUE.test(String(text ?? '')) ? 2 : 3;
    const out = [];
    for (let i = 0; i < toks.length;) {
      const t = toks[i];
      if (isLetter(t)) {
        const groups = [[t.toUpperCase()]];
        let j = i + 1, lastLetter = i, total = 1, broke = false;
        while (j < toks.length) {
          if (RUN_SEP.has(toks[j])) { if (GROUP_SEP.has(toks[j])) broke = true; j++; continue; }
          if (isLetter(toks[j])) {
            if (broke) groups.push([]);
            groups[groups.length - 1].push(toks[j].toUpperCase());
            broke = false; total++; lastLetter = j; j++; continue;
          }
          break;
        }
        // i jumps to just past the last LETTER, never past the separator after
        // it: "A-R-N-A-V, Garg" must leave the comma to end the clause.
        if (total >= minRun) {
          // Every group one letter long is one word spelled with commas
          // between its letters; anything longer is a word of its own.
          const runs = groups.every(g => g.length === 1) ? [groups.flat()] : groups;
          for (const r of runs) out.push({ run: r });
          i = lastLetter + 1;
          continue;
        }
      }
      if (SEG_SEP.has(t)) { out.push({ sep: true }); i++; continue; }
      const k = key(t);
      // "and" / "but" / "then" join two clauses about two different components
      // ("Arnav is A R N A V and Garg is G A R G") and are clause boundaries
      // here for exactly that reason.
      if (k === 'and' || k === 'but' || k === 'then') { out.push({ sep: true }); i++; continue; }
      out.push({ word: t, key: k });
      i++;
    }
    return out;
  }

  function segmentsOf(items) {
    const segs = [[]];
    for (const it of items) {
      if (it.sep) { if (segs[segs.length - 1].length) segs.push([]); continue; }
      segs[segs.length - 1].push(it);
    }
    return segs.filter(s => s.length);
  }

  /* -------------------------------------------------------------- casing -- */

  // An instruction about case, not a word that happens to contain "capital".
  // The bare noun "capital" is deliberately absent from every alternative here,
  // so "Capital Region" is a value; and a bare "caps" needs a lead-in or the end
  // of the utterance, so "Caps Lock Key" is one too.
  const CASE_RULES = [
    // Most specific first: "capitalize the first letter" is not "capitalize".
    ['CAPITALIZE_FIRST', /\bcapitali[sz]e\s+(?:only\s+)?the\s+first\s+letter\b/i],
    ['LOWER', /\blower\s?case\b/i],
    ['UPPER', /\b(?:all|in|the|to|it|that|everything|whole)\s+caps\b|\bcaps\s*[.!?]?\s*$|\ball\s+capitals\b|\bcapital\s+letters\b|\bblock\s+capitals\b|\bin\s+capitals\b|\bupper\s?case\b/i],
    ['TITLE', /\bcapitali[sz]ed?\s+normal(?:ly)?\b|\bnormal\s+case\b|\btitle\s?case\b|\bcapitali[sz]e[sd]?\b|\bcapitali[sz]ation\b/i],
  ];
  const CASES = new Set(['UPPER', 'LOWER', 'TITLE', 'CAPITALIZE_FIRST', 'PRESERVE']);

  const caseIn = (clause) => { for (const [c, re] of CASE_RULES) if (re.test(clause)) return c; return null; };

  const SCOPE_FIRST = /\b(first\s+(?:name|word)|given\s+name|forename)\b/i;
  const SCOPE_LAST = /\b(last\s+(?:name|word)|surname|family\s+name)\b/i;
  const SCOPE_ALL = /\b(whole|entire|everything|all\s+of\s+it|both|each|every)\b/i;

  /**
   * "capital A, lowercase rnav" - casing given per fragment rather than per
   * word. Two or more fragments are required: one is indistinguishable from an
   * ordinary casing instruction, and guessing wrong would rewrite the value.
   */
  function casedFragments(text) {
    const re = /\b(capital|uppercase|upper\s?case|lowercase|lower\s?case|small)\s+([A-Za-z]+)\b/gi;
    const parts = [];
    let m;
    while ((m = re.exec(String(text ?? '')))) {
      // "capital letters" names the operation; "capital A" names a fragment.
      // A single letter is never filler here, whatever the filler list says.
      if (m[2].length > 1 && FILLER.has(key(m[2]))) continue;
      const up = /^(capital|upper)/i.test(m[1]);
      parts.push(up ? m[2].toUpperCase() : m[2].toLowerCase());
    }
    return parts.length >= 2 ? parts.join('') : null;
  }

  /* ---------------------------------------------------------- assembling -- */

  /** The case a SPELLED component takes before any explicit instruction. */
  function fieldCase(word, intent) {
    if (intent === 'idnumber') return word.toUpperCase();
    if (intent === 'email') return word.toLowerCase();
    return title(word);
  }

  /** Which base word a component names. Exact key, then near-miss, then null. */
  function matchWord(word, words, used) {
    const k = key(word);
    if (!k) return -1;
    for (let i = 0; i < words.length; i++) if (!used.has(i) && key(words[i]) === k) return i;
    const lev = N()?.levenshtein;
    if (lev) {
      for (let i = 0; i < words.length; i++) {
        if (used.has(i)) continue;
        const w = key(words[i]);
        if (w && lev(k, w) <= 2 && Math.abs(w.length - k.length) <= 2) return i;
      }
    }
    return -1;
  }

  /**
   * Utterance -> { base, components, ops, casedFragments, conflict }.
   *
   * `base` is the value as SPOKEN, `components` is the letter evidence, `ops`
   * is the casing instruction. Kept apart because they are applied in that
   * order and mixing them is exactly how "Arnav Garg Arnav Garg" happens: a
   * clause that spells a component contributes its letters, never its words.
   */
  function parse(text) {
    const raw = String(text ?? '');
    const items = scan(raw);
    const segs = segmentsOf(items);
    const base = [], components = [], ops = [];
    let sawRun = false;

    for (const seg of segs) {
      const clause = seg.map(i => i.word || (i.run ? i.run.join(' ') : '')).join(' ');
      const runs = seg.filter(i => i.run);
      const content = seg.filter(i => i.word && i.key && !FILLER.has(i.key));

      if (runs.length) {
        sawRun = true;
        // The word a run spells is the nearest content word BEFORE it in the
        // clause. Words after it ("A R N A V at gmail dot com") belong to the
        // parsers this layer stays out of - see SPELL_SKIP.
        for (const r of runs) {
          const at = seg.indexOf(r);
          let word = null;
          for (let i = at - 1; i >= 0; i--) {
            const it = seg[i];
            if (it.word && it.key && !FILLER.has(it.key)) { word = it.word; break; }
          }
          components.push({ word, letters: r.run });
        }
        continue;
      }

      const c = caseIn(clause);
      if (c) {
        // A clause carrying a casing instruction names a SCOPE, not a value:
        // "keep Garg capitalized normally" is about the word Garg already in
        // the value. Unless nothing else supplies a value, in which case the
        // clause is carrying it ("Arnav Garg all uppercase").
        let scope = null;
        if (SCOPE_FIRST.test(clause)) scope = 'first';
        else if (SCOPE_LAST.test(clause)) scope = 'last';
        else if (!SCOPE_ALL.test(clause) && content.length) {
          if (base.length || segs.some(s => s !== seg && !s.some(i => i.run) && !caseIn(s.map(i => i.word || '').join(' ')) && s.some(i => i.word && i.key && !FILLER.has(i.key)))) {
            scope = content[0].word;
          } else {
            for (const w of content) base.push(w.word);
          }
        }
        ops.push({ scope, case: c });
        continue;
      }

      for (const w of content) base.push(w.word);
    }

    if (!sawRun && !ops.length) return null;

    // Two clauses spelling the same word differently is not a value, it is a
    // question. Guessing which one the person meant is the wrong answer.
    let conflict = false;
    const seen = new Map();
    for (const c of components) {
      if (!c.word) continue;
      const k = key(c.word), asm = c.letters.join('');
      if (seen.has(k) && seen.get(k) !== asm) conflict = true;
      seen.set(k, asm);
    }
    return { base, components, ops, conflict, fragments: casedFragments(raw) };
  }

  /** Base words + letter evidence -> the words of the value, spelled ones cased. */
  function assemble(base, components, intent) {
    const words = base.slice();
    const spelled = new Set();
    let next = 0;
    for (const c of components) {
      const asm = c.letters.join('');
      let idx = c.word && words.length ? matchWord(c.word, words, spelled) : -1;
      if (idx < 0) {
        while (next < words.length && spelled.has(next)) next++;
        idx = next < words.length ? next : -1;
      }
      if (idx < 0) { words.push(asm); idx = words.length - 1; }
      else words[idx] = asm;
      spelled.add(idx);
      next = idx + 1;
    }
    return { words: words.map((w, i) => (spelled.has(i) ? fieldCase(w, intent) : w)), spelled };
  }

  const applyOne = (w, c) => {
    switch (c) {
      case 'UPPER': return w.toUpperCase();
      case 'LOWER': return w.toLowerCase();
      case 'TITLE': return title(w);
      default: return w;
    }
  };

  /** Casing operations against the words of a value, by scope. */
  function applyCase(words, ops) {
    let out = words.slice();
    for (const op of ops) {
      if (op.case === 'PRESERVE') continue;
      if (op.case === 'CAPITALIZE_FIRST') {
        // The FIRST LETTER of the value, not of every word - that is TITLE.
        const j = out.findIndex(w => /[a-z]/i.test(w));
        if (j >= 0) out = out.map((w, i) => (i === j ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase()));
        continue;
      }
      let idxs;
      if (op.scope === 'first') idxs = [0];
      else if (op.scope === 'last') idxs = [out.length - 1];
      else if (op.scope) {
        const i = matchWord(op.scope, out, new Set());
        idxs = i >= 0 ? [i] : [];
      } else idxs = out.map((_, i) => i);
      out = out.map((w, i) => (idxs.includes(i) ? applyOne(w, op.case) : w));
    }
    return out;
  }

  /**
   * Why a casing instruction cannot be honoured on this field, or null.
   *
   * Silently ignoring it would leave the person believing the value is in caps
   * when it is not; silently applying it to a digit string or an option value
   * would corrupt the field. Both are worse than asking.
   */
  function caseError(intent, ops) {
    if (intent === 'email') {
      return ops.every(o => o.case === 'LOWER' || o.case === 'PRESERVE')
        ? null : 'An email address is stored in lower case. Should I leave it as it is?';
    }
    if (intent === 'choice' || intent === 'multichoice') {
      return 'That field takes one of the listed options, so I cannot change its capitalisation. Which option would you like?';
    }
    if (!CASE_OK.has(intent)) return 'That field has no capital letters to change. What should it be?';
    return null;
  }

  /** Is there anything here for this layer to do? Cheap, used by the router. */
  function hasFormatting(text) {
    const t = String(text ?? '');
    if (caseIn(t)) return true;
    return scan(t).some(i => i.run);
  }

  /**
   * The whole deterministic path: transcript + field + current value -> the
   * COMPLETE resulting value, a clarifying question, or null to leave it alone.
   *
   * Null is the important return. It means "this layer has nothing to say",
   * and the provider and the deterministic table both still get their turn.
   */
  function resolveUtterance(text, { intent = null, currentValue = null } = {}) {
    const p = parse(text);
    if (!p) return null;
    const spelling = p.components.length && !SPELL_SKIP.has(intent) ? p.components : [];
    if (!spelling.length && !p.ops.length && !p.fragments) return null;
    if (spelling.length && p.conflict) {
      return { clarify: 'I heard two different spellings there. Could you spell it once more?' };
    }
    if (p.ops.length) {
      const err = caseError(intent, p.ops);
      if (err) return { clarify: err };
    }

    // "capital A, lowercase rnav" builds the value out of its own fragments.
    if (p.fragments && !spelling.length) {
      const words = applyCase([p.fragments], p.ops.filter(o => o.scope === null && o.case === 'CAPITALIZE_FIRST'));
      return { value: words.join(' '), via: 'casing' };
    }

    let words = null;
    if (p.base.length || spelling.length) {
      words = assemble(p.base, spelling, intent).words;
    } else if (currentValue != null && !Array.isArray(currentValue) && String(currentValue).trim()) {
      words = String(currentValue).trim().split(/\s+/);
    } else {
      // "Make that all caps" with nothing in the field yet.
      return { clarify: 'There is nothing there to change yet. What should I put in?' };
    }
    if (p.ops.length) words = applyCase(words, p.ops);

    const value = words.join(' ').trim();
    if (!value) return null;
    const via = spelling.length ? (p.ops.length ? 'spelling+casing' : 'spelling') : 'casing';
    return { value, via, spelled: spelling.length };
  }

  /* ------------------------------------------ model-supplied structure ---- */

  /** A model's `spelling` argument, or null. Untrusted: shape-checked, capped. */
  function normalizeSpelling(raw) {
    if (!Array.isArray(raw) || !raw.length || raw.length > 8) return null;
    const out = [];
    for (const c of raw) {
      if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
      const letters = Array.isArray(c.letters) ? c.letters : null;
      if (!letters || !letters.length || letters.length > 40) return null;
      const chars = [];
      for (const l of letters) {
        if (typeof l !== 'string' || !/^[A-Za-z0-9]$/.test(l)) return null;
        chars.push(l.toUpperCase());
      }
      const word = typeof c.word === 'string' && c.word.length <= 40 ? c.word : null;
      out.push({ word, letters: chars });
    }
    return out;
  }

  /** A model's `case` argument, or null. */
  const normalizeCase = (raw) => (typeof raw === 'string' && CASES.has(raw.toUpperCase()) ? raw.toUpperCase() : null);

  /**
   * Apply a model's structured spelling/casing to the value it also returned.
   *
   * The model says WHICH letters and WHICH case. It never says what the string
   * becomes - that is this function, and it is the same one the deterministic
   * path uses, so a provider-resolved utterance and a locally-resolved one
   * cannot disagree about what "all caps" means.
   */
  function applyStructured(value, { spelling = null, caseOp = null } = {}, intent = null) {
    let words = String(value ?? '').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return { clarify: 'I did not catch the value. What should I put in?' };
    if (spelling && !SPELL_SKIP.has(intent)) words = assemble(words, spelling, intent).words;
    if (caseOp) {
      const err = caseError(intent, [{ scope: null, case: caseOp }]);
      if (err) return { clarify: err };
      words = applyCase(words, [{ scope: null, case: caseOp }]);
    }
    return { value: words.join(' ').trim() };
  }

  /* ============================================================= profile === */

  const PROFILE_VERSION = 1;
  const CAP = { vocabulary: 200, corrections: 200, pronunciations: 100 };

  // No `formatting` list. The PRD sketches one, but nothing writes it and
  // nothing reads it: a casing instruction is resolved from the utterance that
  // carries it, and a remembered preference would fire on a later turn where
  // the person said nothing about case. A field that is only ever sanitised is
  // not a schema, it is a liability.
  const emptyProfile = () => ({ v: PROFILE_VERSION, vocabulary: [], corrections: [], pronunciations: [] });

  const str = (x, max) => (typeof x === 'string' && x.length && x.length <= max ? x : null);

  /**
   * A profile out of storage is untrusted input: absent, an array, a future
   * version, hand-edited, or corrupted. Anything unrecognised is dropped rather
   * than repaired, and a wholly unusable profile is an empty one - never an
   * exception on the turn path.
   */
  function sanitize(raw) {
    const p = emptyProfile();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return p;
    const arr = (x) => (Array.isArray(x) ? x : []);
    for (const e of arr(raw.vocabulary).slice(0, CAP.vocabulary)) {
      const canonical = str(e?.canonical, 60);
      const context = str(e?.context, 24);
      if (canonical && context) p.vocabulary.push({ canonical, context, n: Number(e.n) || 1, at: Number(e.at) || 0 });
    }
    for (const e of arr(raw.corrections).slice(0, CAP.corrections)) {
      const observed = str(e?.observed, 80);
      const canonical = str(e?.canonical, 60);
      const context = str(e?.context, 24);
      if (observed && canonical && context && LEARNABLE.has(context)) {
        p.corrections.push({ observed, canonical, context, n: Number(e.n) || 1, at: Number(e.at) || 0 });
      }
    }
    for (const e of arr(raw.pronunciations).slice(0, CAP.pronunciations)) {
      const canonical = str(e?.canonical, 60);
      if (!canonical) continue;
      const phonemes = str(e?.phonemes, 120);
      const respell = str(e?.respell, 120);
      if (phonemes || respell) p.pronunciations.push({ canonical, phonemes: phonemes || null, respell: respell || null });
    }
    return p;
  }

  // Lead-ins a person puts in front of an answer. Stripped so "Arnav" and
  // "it's Arnav" are the same observation, and nothing more: the rest of the
  // transcript is compared WHOLE.
  const LEAD = /^\s*(?:(?:um|uh|so|well|ok|okay|yes|yeah|no|nope|its|it is|it s|i think its|my name is|the name is|i am|im)\b[,.\s]*)+/i;
  const observedKey = (s) => String(s ?? '').toLowerCase().replace(APOS, '').replace(LEAD, '')
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

  /**
   * Has this exact utterance been corrected before, in this kind of field?
   *
   * WHOLE-UTTERANCE equality, deliberately. A substring rule would turn "How
   * much is enough?" into "How much is Arnav?", which is the failure mode the
   * PRD names. The context must match too, so a learned name never fires on a
   * comment box.
   */
  function lookupCorrection(profile, transcript, context) {
    if (!profile || !context || !LEARNABLE.has(context)) return null;
    const t = observedKey(transcript);
    if (!t) return null;
    const hit = (profile.corrections || []).find(c => c.context === context && c.observed === t);
    return hit ? hit.canonical : null;
  }

  /** Personal vocabulary for this kind of field - a hint for the provider. */
  function vocabularyFor(profile, context, limit = 20) {
    if (!profile || !context) return [];
    return (profile.vocabulary || [])
      .filter(v => v.context === context)
      .sort((a, b) => (b.n || 0) - (a.n || 0))
      .slice(0, limit)
      .map(v => v.canonical);
  }

  /** Pronunciation dictionary, keyed lowercase, for VFNormalize.speakName. */
  function pronunciationMap(profile) {
    const m = {};
    for (const p of (profile?.pronunciations || [])) m[p.canonical.toLowerCase()] = { phonemes: p.phonemes, respell: p.respell };
    return m;
  }

  /**
   * Record a CONFIRMED correction. Returns { profile, learned, why }.
   *
   * Everything here is a reason NOT to learn. A personal profile that is wrong
   * is worse than one that is empty, because a wrong entry fires silently on
   * every later turn, and the person has no way to see it.
   */
  function learn(profile, { observed, canonical, context } = {}) {
    const p = sanitize(profile);
    const why = (w) => ({ profile: p, learned: false, why: w });
    if (!context || !LEARNABLE.has(context)) return why('context-not-learnable');
    const value = String(canonical ?? '').trim();
    const obs = observedKey(observed);
    if (!obs || obs.length > 80) return why('no-observation');
    if (!value || value.length > 40) return why('value-out-of-range');
    // Digits, @ and markup are the shapes of the things this must never keep:
    // account numbers, addresses, emails, codes. A name has none of them.
    if (/[\d@<>{}]/.test(value)) return why('value-not-vocabulary');
    if (value.split(/\s+/).length > 4) return why('value-too-many-words');
    // STT was right: there is nothing to remember.
    if (observedKey(value) === obs) return why('no-difference');
    // "no" / "yes" / "skip" as an observation would fire on every later turn.
    const n = N();
    if (n && (n.parseYesNo(obs) !== null || n.parseCommand(obs))) return why('observation-is-a-command');

    const now = Date.now();
    const i = p.corrections.findIndex(c => c.context === context && c.observed === obs);
    if (i >= 0) p.corrections[i] = { ...p.corrections[i], canonical: value, n: (p.corrections[i].n || 1) + 1, at: now };
    else p.corrections.push({ observed: obs, canonical: value, context, n: 1, at: now });
    if (p.corrections.length > CAP.corrections) p.corrections.sort((a, b) => (a.at || 0) - (b.at || 0)).shift();

    const vi = p.vocabulary.findIndex(v => v.context === context && v.canonical.toLowerCase() === value.toLowerCase());
    if (vi >= 0) p.vocabulary[vi] = { ...p.vocabulary[vi], n: (p.vocabulary[vi].n || 1) + 1, at: now };
    else p.vocabulary.push({ canonical: value, context, n: 1, at: now });
    if (p.vocabulary.length > CAP.vocabulary) p.vocabulary.sort((a, b) => (a.at || 0) - (b.at || 0)).shift();

    return { profile: p, learned: true, why: null };
  }

  return {
    // spelling + casing
    scan, parse, assemble, applyCase, resolveUtterance, hasFormatting, caseError,
    normalizeSpelling, normalizeCase, applyStructured, casedFragments,
    // profile
    emptyProfile, sanitize, learn, lookupCorrection, vocabularyFor, pronunciationMap, observedKey,
    LEARNABLE, SPELL_SKIP, CASE_OK, CASES, PROFILE_VERSION,
  };
})();
