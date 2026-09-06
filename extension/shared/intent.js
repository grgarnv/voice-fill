// The conversational intent layer: interpretation only, never execution.
//
// resumePolicy (session-core.js) is a table. It is fast, deterministic, and
// right about most of what a person says to a form. What it cannot do is
// resolve language that only means something RELATIVE to context - "the first
// two", "actually just the headache", "no, the last digit is two". This file
// decides when that is happening, builds the context a model needs, and - the
// part that matters - validates whatever comes back against the same facts the
// core already holds.
//
// The model's entire reachable output is the decision vocabulary resumePolicy
// already produces. There is no code path from here to the DOM, to a selector,
// or to the state machine: a decision is data that player.js's switch may or
// may not act on. Nothing the model can say widens that.
//
//   resolveRelative   ordinals/quantifiers over options, no provider needed
//   shouldConsult     the router: deterministic where obvious, model where not
//   buildContext      what the model is allowed to know
//   validateIntent    model JSON x context -> a decision, or a rejection
globalThis.VFIntent = (() => {
  'use strict';

  /* ------------------------------------------------------------ helpers --- */

  const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

  // Spelling assembly, casing operations and the personal profile. Optional:
  // the layer must still work if memory.js is not loaded, so every use is
  // guarded rather than assumed.
  const MEM = () => globalThis.VFMemory || null;
  // The deterministic core, for the one thing the router needs from it: whether
  // a spoken field reference matches a field this session actually holds.
  const CORE = () => globalThis.VFSessionCore || null;

  // Only intents whose value is a bare digit string can be length-compared, and
  // that comparison is what catches a partial correction being read as a whole
  // value ("the last digit is two" -> "2").
  const DIGIT_INTENTS = new Set(['postal', 'pin', 'phone', 'number', 'age', 'quantity']);

  /* -------------------------------------------------- relative selection --- */

  const ORDINALS = {
    first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8,
    '1st': 1, '2nd': 2, '3rd': 3, '4th': 4, '5th': 5, '6th': 6, '7th': 7, '8th': 8,
  };
  const COUNTS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, couple: 2, both: 2 };

  /**
   * "the first two" / "first and third" / "all four" / "the last two" / "none",
   * over the options the user could actually have heard.
   *
   * This is the trivial half of the PRD's option language and it does not need
   * a model: it is positional arithmetic. Returns 1-based indices INTO `opts`
   * (the heard set), or null when the phrase is not purely positional - which
   * is the signal to consult the provider.
   */
  function resolveRelative(text, opts) {
    if (!opts?.length) return null;
    const n = opts.length;
    const all = () => Array.from({ length: n }, (_, i) => i + 1);

    // Conversational lead-in first ("actually only the third", "no wait, the
    // first two"). The core strips retractions before its own parsing; this is
    // the same idea, kept local so the resolver works on a bare utterance.
    // Only ever a prefix, so "not that one" is untouched and still goes to the
    // provider, where it belongs.
    const LEAD = /^(?:(?:no|nope|nah|wait|sorry|um|uh|actually|i mean|i meant|scratch that|forget that|instead|rather|just|only|ok|okay|so|well|hmm|yeah|please)\s+)+/;
    // "the first ONE" is position 1; "the first TWO" is a quantity. The noun
    // after an ordinal is not a number, and reading it as one turned "the first
    // one and the last one" into a single pick.
    let t = norm(text).replace(LEAD, '').replace(/\b(first|second|third|fourth|fifth|sixth|last)\s+(?:one|ones|option|options|item|items)\b/g, '$1');
    if (!t) return null;

    // "none of them" / "neither" - an explicit empty selection, not a failure.
    if (/^(none|neither|nothing|not any)\b/.test(t)) return [];

    // "all four", "all of them", "every option", "everything"
    if (/^(all|every|each)\b/.test(t) || /^(i want|give me|just|only)?\s*(all|every)\b/.test(t)) {
      const w = /\b(?:all|every|each)\s+(?:of\s+)?(?:the\s+)?(\w+)/.exec(t)?.[1];
      const count = w ? (COUNTS[w] ?? (/^\d+$/.test(w) ? Number(w) : null)) : null;
      // "all four" when only three were heard is a claim about options that do
      // not exist in this context. Refuse rather than silently select three.
      if (count !== null && count !== n) return { outOfRange: [count], max: n };
      return all();
    }

    // Quantities: "the first two", "the first couple", "the last two".
    const mFirstK = /\bfirst\s+(\w+)/.exec(t);
    if (mFirstK && COUNTS[mFirstK[1]] !== undefined && !ORDINALS[mFirstK[1]]) {
      const k = COUNTS[mFirstK[1]];
      return k <= n ? all().slice(0, k) : { outOfRange: [k], max: n };
    }
    const mLastK = /\blast\s+(\w+)/.exec(t);
    if (mLastK && COUNTS[mLastK[1]] !== undefined && !ORDINALS[mLastK[1]]) {
      const k = COUNTS[mLastK[1]];
      return k <= n ? all().slice(n - k) : { outOfRange: [k], max: n };
    }

    // Enumerated positions: "first and third", "the first and the last",
    // "one and three", "second, fourth". A bare cardinal only counts as a
    // position when the whole utterance is an enumeration - otherwise "I want
    // two" (two of something) would select option 2.
    const FILLER = new Set(['the', 'and', 'a', 'an', 'plus', 'also', 'option', 'options', 'number', 'numbers',
      'i', 'want', 'give', 'me', 'take', 'pick', 'choose', 'select', 'just', 'only', 'ones', 'one of',
      'please', 'ill', 'id', 'like', 'those', 'these', 'them', 'both']);
    const words = t.split(' ').filter(Boolean);
    const isNum = (w) => ORDINALS[w] !== undefined || COUNTS[w] !== undefined || /^\d+$/.test(w) || w === 'last';
    // Two or more numbers, and nothing but numbers and filler, is an
    // enumeration. ONE bare number is a quantity ("I want two") or a reference
    // ("those two") - neither is a position, so both go to the provider.
    const numericCount = words.filter(isNum).length;
    const pureEnumeration = words.every(w => isNum(w) || FILLER.has(w)) &&
      (numericCount >= 2 || /\b(?:option|number)\s+\w+/.test(t));

    const picks = [];
    let sawOrdinal = false;
    for (const w of words) {
      if (ORDINALS[w] !== undefined) { picks.push(ORDINALS[w]); sawOrdinal = true; continue; }
      if (w === 'last') { picks.push(n); sawOrdinal = true; continue; }
      if (!sawOrdinal && !pureEnumeration) continue;
      if (COUNTS[w] !== undefined && w !== 'couple' && w !== 'both') picks.push(COUNTS[w]);
      else if (/^\d+$/.test(w)) picks.push(Number(w));
    }
    if (!picks.length) return null;
    // "give me the first one and headache" is positional AND referential. Taking
    // the positional half and dropping the label silently loses a selection, so
    // anything left over that is neither a number nor filler hands the whole
    // utterance to the provider.
    if (words.some(w => !isNum(w) && !FILLER.has(w))) return null;
    const uniq = [...new Set(picks)].sort((a, b) => a - b);
    // A reference outside the heard set is not resolvable here; the caller asks.
    if (uniq.some(i => i < 1 || i > n)) return { outOfRange: uniq, max: n };
    return uniq;
  }

  /* ------------------------------------------------------------ exclusion -- */

  // "everything except the fever", "all but the cough", "not the fever".
  const EXCLUSION = /\b(?:except|excluding|but not|other than|apart from|aside from|besides|without|minus)\b|\b(?:all|everything|every|any|anything|none|neither)\b[^.]*\bbut\b|^\s*(?:not|no)\s+(?:the\s+)?\w/i;

  /** Options whose label appears as a whole phrase in the text. */
  function optionsNamedIn(text, options) {
    const h = ` ${norm(text)} `;
    return options.filter(o => { const l = norm(o.text); return l && h.includes(` ${l} `); });
  }

  /**
   * The clause an exclusion actually governs.
   *
   * "not the fever, the other one I mentioned - nausea" excludes the fever and
   * REQUESTS the nausea. Reading the whole remainder as excluded banned both
   * and turned a clear instruction into a question. An exclusion reaches to the
   * end of its clause, so the raw punctuation is split on before normalising -
   * norm() turns commas and dashes into spaces and the boundary is lost.
   */
  function exclusionClause(text) {
    const segs = String(text || '').split(/\s*[,;:\u2013\u2014-]+\s*|\s+\bthen\b\s+/);
    return segs.find(sg => EXCLUSION.test(sg)) || segs[0] || '';
  }

  /**
   * "everything except the fever" -> every option but that one.
   *
   * This exists because the deterministic matcher ignores negation entirely and
   * scored the EXCLUDED label as the answer: "not the fever" selected Fever,
   * and "all but the cough" selected Cough. Set arithmetic over a known list is
   * exact, so it is done here rather than asked of a model.
   *
   * Returns options, [] for a refusal that selects nothing, or null when the
   * utterance is an exclusion whose remainder cannot be worked out - which the
   * caller must treat as "ask", never as the deterministic answer.
   */
  function resolveExclusion(text, options) {
    if (!options?.length) return null;
    if (!EXCLUSION.test(text)) return null;
    const clause = exclusionClause(text);
    const t = norm(clause);
    if (!t) return null;

    const m = /\b(except|excluding|but not|but|other than|apart from|aside from|besides|without|minus)\b(.*)$/i.exec(t);
    const head = m ? t.slice(0, m.index) : t;
    const tail = m ? m[2] : t.replace(/^\s*(?:not|no)\s+/i, '');
    const named = optionsNamedIn(tail, options);
    if (!named.length) return null;                     // nothing recognisable to exclude

    // "none of them except headache" is the inverse: only the ones named.
    if (/\b(none|neither|nothing|not any)\b/.test(head)) return named;
    if (/\b(all|everything|every|each|any|anything)\b/.test(head)) {
      const drop = new Set(named.map(o => String(o.value)));
      return options.filter(o => !drop.has(String(o.value)));
    }
    // A bare "not the fever" says what they do NOT want and leaves three
    // candidates. That is a question, not an answer.
    return null;
  }

  /* ------------------------------------------------- positional editing --- */

  const DIGIT_WORD = { zero: '0', oh: '0', o: '0', one: '1', two: '2', three: '3', four: '4',
                       five: '5', six: '6', seven: '7', eight: '8', nine: '9' };

  /**
   * "the last digit is two" / "the second digit should be a five" /
   * "make the third one a nine" / "the first letter is A", against the value
   * that is currently there.
   *
   * Counting positions in a string is exact arithmetic, and it is the one thing
   * a small model reliably gets wrong: asked to change the SECOND digit of
   * 160071 it returned 160075, having changed the last. So it is done here,
   * with no model, and the provider is left the corrections that actually need
   * judgement.
   *
   * Returns the COMPLETE new value, or null when this is not a positional edit
   * or the position/replacement cannot be read with certainty.
   */
  /**
   * The parse behind editByPosition, kept separate so a refusal can say WHY.
   *
   * Returns { positions, replacement, count, span, unit } or a reason string.
   */
  function parsePositionalEdit(text, currentValue) {
    const cur = String(currentValue ?? '');
    if (!cur) return 'no-value';
    const t = norm(text);
    if (!t) return 'no-value';

    // "the last digit", "the 2nd digit", and - the multi-character form - "the
    // last two digits", "the first three letters".
    const m = /\b(?:(first|second|third|fourth|fifth|sixth|seventh|eighth|last|final)|([1-8])(?:st|nd|rd|th))\s+(?:(two|three|four|couple)\s+)?(digits?|letters?|characters?|numbers?|ones?)\b/.exec(t);
    if (!m) return 'not-positional';
    const word = m[1], numeral = m[2], countWord = m[3];
    const unit = m[4].replace(/s$/, '');
    const span = countWord ? (COUNTS[countWord] ?? 1) : 1;

    // Which characters are even eligible. "The second digit" of "A1B2" means
    // the 2, not the 1 - counting runs over digits, not over the whole string.
    const isDigit = unit === 'digit' || (unit !== 'letter' && /^\d+$/.test(cur));
    const idxs = [];
    for (let i = 0; i < cur.length; i++) {
      if (unit === 'letter') { if (/[a-z]/i.test(cur[i])) idxs.push(i); }
      else if (isDigit) { if (/\d/.test(cur[i])) idxs.push(i); }
      else idxs.push(i);
    }
    if (!idxs.length) return 'nothing-to-count';

    const fromEnd = word === 'last' || word === 'final';
    const start = fromEnd ? idxs.length - span + 1 : (word ? ORDINALS[word] : Number(numeral));
    if (!start || start < 1 || start + span - 1 > idxs.length) return 'out-of-range';

    // The replacement: everything nameable AFTER the position phrase, so that
    // "the second digit should be a five" takes the five and not the second,
    // and "the last two digits should be 42" takes both characters of 42.
    const after = t.slice(m.index + m[0].length);
    let rep = '';
    for (const w of after.split(/\s+/).filter(Boolean)) {
      if (isDigit) {
        if (DIGIT_WORD[w] !== undefined) rep = span > 1 ? rep + DIGIT_WORD[w] : DIGIT_WORD[w];
        else if (/^\d+$/.test(w)) rep = span > 1 ? rep + w : w.slice(-1);
      } else if (/^[a-z]+$/i.test(w) && w.length <= span) rep = span > 1 ? rep + w.toUpperCase() : w.toUpperCase();
    }
    if (!rep) return 'no-replacement';
    if (rep.length !== span) return 'replacement-length-mismatch';
    return { idxs, start, span, replacement: rep, unit, count: idxs.length };
  }

  function editByPosition(text, currentValue) {
    const p = parsePositionalEdit(text, currentValue);
    if (typeof p === 'string') return null;
    const out = String(currentValue).split('');
    for (let k = 0; k < p.span; k++) out[p.idxs[p.start - 1 + k]] = p.replacement[k];
    const next = out.join('');
    return next === String(currentValue) ? null : next;
  }

  /**
   * A positional edit that CANNOT be carried out, as a question to ask.
   *
   * Returns null for anything that is not a positional edit, or is one that
   * worked - only a genuine impossibility ("the fifth letter" of four) or a
   * genuine ambiguity ("change the third digit" to what?) produces a question.
   */
  function editRefusal(text, currentValue) {
    const p = parsePositionalEdit(text, currentValue);
    if (typeof p !== 'string') return null;
    const cur = String(currentValue ?? '');
    if (p === 'out-of-range') {
      const unit = /letter/.test(norm(text)) ? 'letters' : 'characters';
      const n = /letter/.test(norm(text)) ? (cur.match(/[a-z]/gi) || []).length : cur.length;
      return `There ${n === 1 ? 'is' : 'are'} only ${n} ${n === 1 ? unit.replace(/s$/, '') : unit} in that. Which one did you mean?`;
    }
    if (p === 'no-replacement' || p === 'replacement-length-mismatch') return 'What should it be instead?';
    return null;
  }

  /**
   * A candidate value -> the `ex` a decision carries, or null if the field
   * cannot hold it. One definition, shared by the spelling, casing, memory and
   * provider paths, so a value that reaches the DOM writer is always the
   * OPTION's own value and never a model's or an assembler's spelling of it.
   */
  function shapeValue(v, intent, options = []) {
    const raw = coerceTime(String(v ?? '').trim(), intent);
    if (!raw || raw.length > 200) return null;
    if (valueShapeError(raw, intent, options)) return null;
    const isChoice = options.length && (intent === 'choice' || intent === 'multichoice');
    const picks = isChoice ? matchAllOptions(raw, options, intent) : null;
    if (isChoice && !picks) return null;
    return {
      value: picks ? (intent === 'multichoice' ? picks.map(o => o.value) : picks[0].value) : raw,
      display: picks ? picks.map(o => o.text).join(', ') : raw,
      confidence: 0.99, needsConfirmation: true, ambiguous: false,
    };
  }

  /* ------------------------------------------------- a value riding along -- */

  // The conversation that carries a value into a navigation: "...it's actually
  // Arnav", "...make it Arnav". Repeated, so a stack of lead-ins comes off.
  const FOLLOW_LEAD = /^\s*(?:(?:no|nope|nah|wait|actually|and|but|oh|um|uh|sorry|please|it'?s|it is|its|make it|make that|change it to|change that to|set it to|should be|i said|i meant|put|use|try)\b[\s,.!-]*)+/i;
  // An INSTRUCTION is not a value. "...and change that answer" names nothing to
  // write, and fromSpeech would take the words themselves as the value.
  const FOLLOW_INSTRUCTION = /^(?:change|fix|update|edit|correct|redo|amend|modify|do)\b/i;
  // What is left of "change that answer" once the retraction stripper has taken
  // "change that" off it. A noun standing in for the value is not the value:
  // without this the field is filled with the word "answer".
  const FOLLOW_NOT_A_VALUE = /^(?:the\s+)?(?:answer|value|entry|response|one|thing|it|that|this)\s*[.!]*$/i;

  /**
   * The clause that rides along with a move ("go back to my name - it's
   * A R N A V") -> a value that field can hold, or null.
   *
   * The same three steps a spoken answer gets, in the same order: personal
   * spelling and casing first, then ordinary extraction, then the shape check.
   * Nothing here writes anything - the caller reads the result back before it
   * counts, exactly as it does for a value spoken at the field.
   */
  function followValue(text, { intent, options = [], currentValue = null } = {}) {
    const K = CORE(), M = MEM(), N = globalThis.VFNormalize;
    if (!N) return null;
    const raw = String(text || '');
    const stripped = K ? K.stripRetraction(raw) : { retracted: false, rest: raw };
    const t = (stripped.retracted ? stripped.rest : raw).replace(FOLLOW_LEAD, '').trim();
    if (!t || FOLLOW_INSTRUCTION.test(t) || FOLLOW_NOT_A_VALUE.test(t)) return null;
    if (M) {
      const built = M.resolveUtterance(t, { intent, currentValue });
      if (built?.value) { const ex = shapeValue(built.value, intent, options); if (ex) return ex; }
      if (built?.clarify) return null;               // ask on arrival, write nothing
    }
    const ex = N.fromSpeech(t, { options }, intent);
    if (ex.value === null || ex.value === undefined || ex.ambiguous) return null;
    return shapeValue(ex.value, intent, options);
  }

  /* -------------------------------------------------------------- router -- */

  // Language that only means something relative to what was just said. These
  // are cheap tests on the transcript, not a command grammar: a hit routes to
  // the provider, it never decides anything by itself.
  // Language that COUNTS. Distinct from RELATIVE below, which also covers
  // reference ("the other one") - only counting is gated by the heard ledger.
  const POSITIONAL = /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|last|all|every|each|both|1st|2nd|3rd|[4-8]th)\b/i;
  // Reference of any kind: position, deixis, or a callback to earlier in the
  // conversation. The "same / before / earlier" family is here because the PRD
  // names it and because without it "the same ones I said before" fell through
  // to "I didn't get that" instead of asking which ones.
  const RELATIVE = /\b(first|second|third|fourth|fifth|last|other|another|those|these|that one|the one|all of|both|couple|only the|just the|instead|rather|as well|too|same|before|earlier|previous|again like|as i said|i mentioned)\b/i;
  // An explicit signal that the user is replacing the value, not agreeing with
  // it. Its absence is what routes an ambiguous read-back reply to the provider.
  const CORRECTION_MARKER = /^\s*(?:nope|no|nah|wrong|incorrect|not right|scratch|strike|forget|cancel|actually|i meant|i mean|change|make it|make that|should be|it'?s|its|use|try|put)\b/i;
  const PARTIAL_EDIT = /\b(digit|letter|character|number)\b.*\b(is|should be|to)\b|\b(last|first|second|third|fourth|middle|final)\s+(digit|letter|character|number|one|word|name)\b|\breplace\b|\bchange\b|\bmake (it|that)\b/i;
  // Language that is asking to MOVE. Only ever a route: the deterministic
  // parser has already had its turn by the time this is tested, so a hit here
  // means the phrasing looks navigational and did NOT resolve - which is
  // exactly the contextual case the model is for ("the one I answered before
  // this", "change what I entered for my phone number").
  const NAVIGATION = /\b(?:go|take me|bring me|get me|put me|move|jump|head|scroll|switch)\s+(?:me\s+)?(?:back|forward|to|into|over)\b|\b(?:previous|next|last|prior)\s+(?:field|question|one|step)\b|\bone before\b|\bfield i (?:just )?(?:answered|entered|filled)\b|\bchange (?:what|the|my)\b.*\b(?:entered|answered|filled|put)\b|\bgo back\b|\btake me back\b/i;

  /**
   * Should the conversational provider see this transcript at all?
   *
   * Deterministic handling is preferred wherever it is already correct: a plain
   * "yes", a command, a clean option match, a clean value. The provider is for
   * the cases where the table either failed or - worse - succeeded wrongly.
   *
   * `decision` is resumePolicy's output; `ctx` is what it was given.
   */
  function shouldConsult(decision, ctx) {
    const { field, pending, intent, options = [], transcript = '' } = ctx;
    // Properties of the UTTERANCE, carried on the route regardless of which
    // branch below decides to consult. The deterministic-failure branch fires
    // first, so keying the fallback off `why` alone missed every reference that
    // also happened to be unparseable - which is most of them.
    const isChoice = intent === 'choice' || intent === 'multichoice';
    const tags = {
      referential: isChoice && options.length && RELATIVE.test(transcript),
      exclusion: isChoice && options.length && EXCLUSION.test(transcript),
      navigational: NAVIGATION.test(transcript),
    };
    const yes = (why) => ({ consult: true, why, ...tags });
    const no = (why) => ({ consult: false, why, ...tags });
    if (!field) return no('no-field');
    // A stale or superseded transcript must never reach a model: acting on it
    // later is exactly the failure the turn machinery exists to prevent.
    if (decision.action === 'drop') return no('dropped');
    // The navigation the parser already resolved. "Go back", "next field",
    // "go back two fields", "take me back to my email" cost no model call and
    // no latency (PRD §13). A NAMED target the matcher cannot find is the
    // exception: the words may be a phrasing it missed rather than a field the
    // form does not have, and that is what the layer is for. An AMBIGUOUS one
    // is not sent - two fields matching equally well is a question for the
    // person, not a choice for a model.
    if (decision.action === 'navigate') {
      const K = CORE(), nav = decision.nav || {};
      if (nav.kind === 'field' && K && (ctx.fields || []).length) {
        const m = K.matchFieldReference(nav.field_reference, ctx.fields);
        if (!m.best) return yes('navigation-unresolved');
      }
      return no('deterministic-navigation');
    }
    // Passwords never leave the machine, whatever the interpretation would gain.
    if (field.type === 'password' || intent === 'password') return no('sensitive-field');

    // 0. Spelling, casing, and a remembered misrecognition. These are checked
    //    FIRST because they are properties of the utterance that the table
    //    cannot see: "no, Arnav is A R N A V" is a perfectly ordinary-looking
    //    correction to resumePolicy, which would write the letters as words.
    //    Both are resolved locally in consult(); the route only says "look".
    const M = MEM();
    if (M) {
      if (M.hasFormatting(transcript)) return yes('spelling-or-casing');
      if (ctx.profile && M.lookupCorrection(ctx.profile, transcript, intent)) return yes('personal-memory');
    }

    // 1. The table could not use it.
    //
    // `ambiguous` is deliberately NOT here. It means two options scored within
    // a hair of each other - "dermatology or neurology" - and the core already
    // does the right thing: it asks which. Routing it to the model turned a
    // correct question into a coin flip that picked Neurology and filled the
    // form with it. The model has no information the matcher lacks about which
    // of two equally-named options was meant; if the utterance is genuinely
    // referential, the tags below still send it.
    if (['unusable', 'reconfirm', 'options-remaining'].includes(decision.action)) {
      return yes(`deterministic-${decision.action}`);
    }

    // 2. The table produced a correction that looks like a FRAGMENT of the
    //    value rather than a replacement for it. "No, the last digit is two"
    //    extracts "2" and would overwrite 160071 with it.
    if (decision.action === 'correction' && pending) {
      const v = String(decision.ex?.value ?? '');
      const prev = String(pending.value ?? '');
      if (PARTIAL_EDIT.test(transcript)) return yes('partial-edit-phrasing');
      // A digit field has a shape, so a suspicious correction is one that is
      // SHORTER than what it replaces - "the last digit is two" extracting "2"
      // over "160071". A same-length correction is a genuine re-speak and stays
      // deterministic, which keeps the common case off the network.
      if (DIGIT_INTENTS.has(pending.intent)) {
        if (v.length && prev.length && v.length < prev.length) return yes('correction-shorter-than-value');
        return no('deterministic-correction');
      }
      // A free-text field has no shape: fromSpeech takes any words at all as
      // the new value, so "That's fine." / "Perfect." / "Looks good." overwrite
      // the very value the user just approved. Without an explicit correction
      // marker, a "correction" into a read-back is not trustworthy.
      if (!CORRECTION_MARKER.test(transcript)) return yes('unmarked-correction');
    }

    // 2b. An acceptance that also names a change is not an acceptance.
    //     "Everything is right except the last digit" contains "right" and no
    //     negation at all, so parseYesNo returns true and the table accepts the
    //     very value the person just said was wrong.
    if (decision.action === 'accept' && pending && PARTIAL_EDIT.test(transcript)) {
      return yes('accept-with-an-edit');
    }

    // 3. Relative language on a choice list, where position and reference only
    //    mean something against what was said.
    if ((intent === 'choice' || intent === 'multichoice') && options.length) {
      // Exclusion FIRST: the deterministic matcher has no notion of negation
      // and returns the excluded option as the answer, so this must never be
      // left to it whatever else it decided.
      if (tags.exclusion) return yes('exclusion-language');
      if (tags.referential) return yes('relative-option-language');
    }

    // 4. A plain answer whose phrasing is an edit of the value already there.
    if (decision.action === 'answer' && field.currentValue && PARTIAL_EDIT.test(transcript)) {
      return yes('partial-edit-on-answer');
    }

    // 5. Navigation the parser could not resolve - a field named in a way the
    //    matcher missed, or a reference into the conversation. Whatever comes
    //    back is still resolved against the session's own history, so the model
    //    widens the LANGUAGE understood and nothing else.
    //    Commands are excluded: those already moved.
    if (tags.navigational && !['command', 'navigate', 'drop'].includes(decision.action)) {
      return yes('navigation-language');
    }

    return no(`deterministic-${decision.action}`);
  }

  /* ------------------------------------------------------------- context -- */

  /**
   * What the model is allowed to know.
   *
   * Options carry `heard`, computed from the Phase 3 ledger, and the unheard
   * ones are still listed: a user who knows the form may name an option the
   * list never reached, and Phase 3 already accepts that with confirmation.
   * What they may NOT do is be counted by a positional reference - validation
   * enforces that below, so a wrong heard set cannot become a wrong selection.
   */
  function buildContext(ctx) {
    const { field, intent, options = [], heardOptionValues = [], pending, transcript,
            state, turnId, epoch, ledger = [], interrupted, profile = null,
            fields = [], answered = {}, index = -1 } = ctx;
    const heard = new Set(heardOptionValues.map(String));
    // Personal vocabulary this person has already confirmed for this KIND of
    // field. A hint, nothing more: the value the model returns is validated
    // against the field exactly as any other, and an empty profile leaves the
    // context byte-identical to what it was before this existed.
    const vocab = MEM() && profile ? MEM().vocabularyFor(profile, intent) : [];
    return {
      ...(vocab.length ? { known_values: vocab.map(v => String(v).slice(0, 60)) } : {}),
      state,
      turn_id: turnId,
      epoch,
      field: {
        id: field.id,
        label: String(field.label || '').slice(0, 200),
        type: field.type,
        intent,
        current_value: field.currentValue == null ? null : String(field.currentValue).slice(0, 200),
      },
      options: options.slice(0, 40).map((o, i) => ({
        index: i + 1, label: String(o.text || '').slice(0, 120), heard: heard.has(String(o.value)),
      })),
      // The form, as a list of NAMES - so a navigation request can be matched
      // to something that exists rather than invented. There are no ids, no
      // selectors and no values here: the model returns the words the person
      // used, and the session decides which field that is.
      ...(fields.length ? {
        form_fields: fields.slice(0, 40).map((f, i) => ({
          position: i + 1, label: String(f.label || '').slice(0, 80),
          answered: !!answered[f.id], current: i === index,
        })),
      } : {}),
      // Which of the listed options had actually been spoken aloud when the
      // user cut in. Authoritative: the model may not assume anything else.
      heard_option_indices: options.slice(0, 40)
        .map((o, i) => (heard.has(String(o.value)) ? i + 1 : null)).filter(Boolean),
      list_was_interrupted: !!interrupted,
      pending_confirmation: pending ? { value: String(pending.value).slice(0, 200), spoken: pending.spoken } : null,
      recent_conversation: ledger.slice(-6).map(e => ({
        role: 'assistant', kind: e.kind, said: String(e.display || e.text || '').slice(0, 240),
        status: e.status,
      })),
      user_transcript: String(transcript).slice(0, 500),
    };
  }

  /* ----------------------------------------------------------- validation -- */

  const INTENTS = new Set([
    'ANSWER_FIELD', 'SELECT_OPTIONS', 'CORRECT_VALUE',
    'ACCEPT_CONFIRMATION', 'REJECT_CONFIRMATION',
    'REPEAT', 'SKIP', 'GO_BACK', 'NEXT', 'REQUEST_CLARIFICATION',
    // Conversational navigation. These name a DIRECTION or a REFERENCE, never
    // a field id, an index or a selector: which field that turns out to be is
    // decided by resolveNav against the session's own history, so the model
    // cannot reach a field the user has not met or a control that is not one.
    'NAVIGATE_PREVIOUS', 'NAVIGATE_NEXT', 'NAVIGATE_RELATIVE',
    'NAVIGATE_TO_FIELD', 'NAVIGATE_TO_REFERENCED_FIELD',
  ]);
  const NAV_REFERENCES = new Set(['previous', 'before_previous', 'last_answered', 'before_field']);

  /** A spoken field reference, as text and nothing else. */
  function navReference(v) {
    if (typeof v !== 'string') return null;
    // Markup is not a way of saying a field name. Stripping it and keeping the
    // rest would turn "<script>x</script>" into the plausible-looking "scriptx".
    if (/[<>{}]/.test(v)) return null;
    const t = v.trim().slice(0, 60);
    return /[a-z0-9]/i.test(t) ? t : null;
  }
  /**
   * A value the model believes rides along with the move ("go back to my name,
   * it's Arnav"). Carried, never trusted: the session shape-checks it against
   * the field it LANDS on and reads it back before it counts.
   */
  function navCorrection(v) {
    if (typeof v !== 'string' || !v.trim()) return null;
    const t = v.trim();
    return t.length <= 200 && !/[<>{}]/.test(t) ? t : null;
  }
  const COMMAND_FOR = { REPEAT: 'repeat', SKIP: 'skip', GO_BACK: 'previous', NEXT: 'next' };

  const reject = (why, detail) => ({ ok: false, why, detail: detail ?? null });

  /**
   * Model output x context -> a decision the core already knows how to execute.
   *
   * Every check here is against state the core holds, not against anything the
   * model said about itself. `confidence` is carried through for logging and is
   * never a reason to execute: a high-confidence invalid intent is invalid.
   */
  function validateIntent(raw, ctx) {
    const { field, intent, options = [], heardOptionValues = [], pending, turnId } = ctx;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return reject('not-an-object');
    if (!INTENTS.has(raw.intent)) return reject('unknown-intent', raw.intent);
    const args = (raw.arguments && typeof raw.arguments === 'object' && !Array.isArray(raw.arguments)) ? raw.arguments : {};
    const conf = typeof raw.confidence === 'number' ? raw.confidence : null;

    // The turn the model was asked about must still be the turn in play.
    if (raw.turn_id != null && String(raw.turn_id) !== String(turnId)) return reject('stale-turn', raw.turn_id);
    // A model naming a different field is hallucinating one; there is exactly
    // one active field and the core chose it. Navigation is the exception and
    // the ONLY one: naming another field is what a request to move IS. It is
    // still not how the target is chosen - field_id is ignored outright, and
    // the move resolves from field_reference against the session's own fields -
    // so a model that echoes the wrong thing here cannot reach a field, it can
    // only be ignored. (Measured: qwen3:8b puts the target's LABEL in field_id
    // on NAVIGATE_TO_FIELD, and rejecting those threw away correct readings.)
    const isNav = String(raw.intent || '').startsWith('NAVIGATE_');
    if (!isNav && raw.field_id != null && String(raw.field_id) !== String(field.id)) return reject('wrong-field', raw.field_id);

    const meta = { via: 'intent', modelIntent: raw.intent, confidence: conf, needsClarification: !!raw.needs_clarification };

    if (raw.needs_clarification || raw.intent === 'REQUEST_CLARIFICATION') {
      const src = args.question ?? raw.question;
      // A number or an object coerced into a spoken question is a malformed
      // response, not a question. `<` and `>` go because Rime reads "<400>" as
      // a pause directive, and the model does not get to control timing.
      if (typeof src !== 'string') return reject('clarification-question-not-a-string', typeof src);
      const q = src.replace(/[<>]/g, '').slice(0, 160).trim();
      if (!q) return reject('clarification-without-question');
      return { ok: true, decision: { action: 'clarify', question: q, ...meta } };
    }

    switch (raw.intent) {
      case 'ACCEPT_CONFIRMATION':
        if (!pending) return reject('accept-without-pending');
        return { ok: true, decision: { action: 'accept', ...meta } };

      case 'REJECT_CONFIRMATION':
        if (!pending) return reject('reject-without-pending');
        return { ok: true, decision: { action: 'reject', ...meta } };

      case 'REPEAT': case 'SKIP': case 'GO_BACK': case 'NEXT':
        return { ok: true, decision: { action: 'command', command: COMMAND_FOR[raw.intent], ...meta } };

      // --- navigation: a request to MOVE, resolved by the session ----------
      //
      // Nothing below chooses a field. Each case produces the same structured
      // intent the deterministic parser produces, which resolveNav then
      // resolves against the fields and the visit history the session holds -
      // and refuses, rather than guesses, when it cannot.
      case 'NAVIGATE_PREVIOUS':
        return { ok: true, decision: { action: 'navigate', nav: { kind: 'relative', direction: 'backward', count: 1 }, ...meta } };

      case 'NAVIGATE_NEXT':
        return { ok: true, decision: { action: 'navigate', nav: { kind: 'relative', direction: 'forward', count: 1 }, ...meta } };

      case 'NAVIGATE_RELATIVE': {
        const dir = String(args.direction || '').toLowerCase();
        if (dir !== 'backward' && dir !== 'forward') return reject('bad-direction', args.direction);
        const n = args.count === null || args.count === undefined ? 1 : args.count;
        if (!Number.isInteger(n) || n < 1 || n > 20) return reject('count-out-of-range', args.count);
        return { ok: true, decision: { action: 'navigate', nav: { kind: 'relative', direction: dir, count: n }, ...meta } };
      }

      case 'NAVIGATE_TO_FIELD': {
        const ref = navReference(args.field_reference);
        if (!ref) return reject('no-field-reference', args.field_reference);
        return { ok: true, decision: { action: 'navigate',
          nav: { kind: 'field', field_reference: ref, correction: navCorrection(args.value) }, ...meta } };
      }

      case 'NAVIGATE_TO_REFERENCED_FIELD': {
        const r = String(args.reference || '').toLowerCase();
        if (!NAV_REFERENCES.has(r)) return reject('unknown-nav-reference', args.reference);
        const ref = r === 'before_field' ? navReference(args.field_reference) : null;
        if (r === 'before_field' && !ref) return reject('no-field-reference', args.field_reference);
        return { ok: true, decision: { action: 'navigate',
          nav: { kind: 'referenced', reference: r, field_reference: ref, correction: navCorrection(args.value) }, ...meta } };
      }

      case 'SELECT_OPTIONS': {
        if (!options.length) return reject('select-on-non-choice');
        if (intent !== 'choice' && intent !== 'multichoice') return reject('select-on-non-choice', intent);
        const raw2 = args.option_indices;
        if (!Array.isArray(raw2) || !raw2.length) return reject('no-option-indices');
        // More picks than there are options is not a selection, it is a
        // malformed response - and left unchecked it becomes a 10,000-entry
        // write and a read-back that never ends.
        if (raw2.length > options.length) return reject('too-many-option-indices', raw2.length);
        // The same option twice is one selection. Deduplicated here so it
        // cannot reach the DOM writer or the read-back as a repeat.
        const idx = [...new Set(raw2)];
        if (intent === 'choice' && idx.length > 1) return reject('multiple-on-single-select', idx);
        const heard = new Set(heardOptionValues.map(String));
        // The heard ledger is authoritative for POSITIONAL reference: an option
        // the list never reached cannot be "the third one", because the user was
        // not counting it. Naming an option is different and is still allowed -
        // Phase 3 accepts that with a forced confirmation - but a MISSING or
        // unrecognised `by` must default to the strict reading, or an omitted
        // field silently disables the rule.
        const byLabel = String(args.by || '').toLowerCase() === 'label';
        const picked = [];
        for (const oneBased of idx) {
          if (!Number.isInteger(oneBased) || oneBased < 1 || oneBased > options.length) {
            return reject('option-index-out-of-range', oneBased);
          }
          const o = options[oneBased - 1];
          if (ctx.interrupted && heardOptionValues.length && !heard.has(String(o.value)) && !byLabel) {
            return reject('option-not-heard', o.text);
          }
          picked.push(o);
        }
        const value = intent === 'multichoice' ? picked.map(o => o.value) : picked[0].value;
        return {
          ok: true,
          decision: {
            action: 'answer', viaHeard: picked.every(o => heard.has(String(o.value))),
            // Everything the model chose is read back. The model is an
            // interpreter; the user is the one who confirms.
            ex: { value, display: picked.map(o => o.text).join(', '), confidence: conf ?? 0.9,
                  needsConfirmation: true, ambiguous: false },
            ...meta,
          },
        };
      }

      case 'ANSWER_FIELD':
      case 'CORRECT_VALUE': {
        const M = MEM();
        // Structured formatting, if the model chose to express it: WHICH
        // letters and WHICH case, never the resulting string. Assembling it is
        // this side's job, using the same function the deterministic path uses,
        // so "all caps" cannot mean two different things depending on who
        // resolved the turn. Malformed structure is dropped, not repaired.
        const spelling = M ? M.normalizeSpelling(args.spelling) : null;
        const caseOp = M ? M.normalizeCase(args.case) : null;
        let v = args.value;
        if (typeof v !== 'string' || !v.trim()) {
          // A pure formatting change carries no value of its own: "make that
          // all caps" operates on whatever is already there.
          const cur = pending?.value ?? field.currentValue ?? null;
          if ((spelling || caseOp) && typeof cur === 'string' && cur.trim()) v = cur;
          else return reject('no-value');
        }
        if (v.length > 200) return reject('value-too-long');
        if (spelling || caseOp) {
          const built = M.applyStructured(v, { spelling, caseOp }, intent);
          if (built.clarify) return reject('formatting-not-applicable', built.clarify);
          v = built.value;
        }
        // A value that is not what this field can hold is not made valid by the
        // model being sure about it.
        v = coerceTime(v, intent);
        const bad = valueShapeError(v, intent, options);
        if (bad) return reject(bad, v);
        // For a choice field the option's OWN value is what the DOM writer
        // matches on. Passing the model's spelling through ("FEVER" for value
        // "fever") writes nothing at all and looks like a silent failure.
        //
        // A multi-select also answers "those two, the fever and the headache"
        // as one string naming both. Rejecting that as "not an option" threw
        // away a correct interpretation over its packaging, so the string is
        // split on the same connectives the deterministic parser uses and each
        // part resolved. Every part must resolve, or it is not a selection.
        const isChoice = options.length && (intent === 'choice' || intent === 'multichoice');
        const picks = isChoice ? matchAllOptions(v, options, intent) : null;
        if (isChoice && !picks) return reject('value-not-an-option', v);
        const value = picks ? (intent === 'multichoice' ? picks.map(o => o.value) : picks[0].value) : v.trim();
        const display = picks ? picks.map(o => o.text).join(', ') : v.trim();
        const ex = { value, display, confidence: conf ?? 0.9, needsConfirmation: true, ambiguous: false };
        if (raw.intent === 'CORRECT_VALUE' && pending) return { ok: true, decision: { action: 'correction', ex, ...meta } };
        return { ok: true, decision: { action: 'answer', viaHeard: false, ex, ...meta } };
      }

      default:
        return reject('unhandled-intent', raw.intent);
    }
  }

  /**
   * A time the model wrote the way people say it ("7:30 PM") is a good answer
   * in the wrong shape; only "HH:MM" reaches a time input.
   */
  function coerceTime(v, intent) {
    if (intent !== 'time' || /^\d{2}:\d{2}$/.test(v)) return v;
    return globalThis.VFNormalize?.parseTime(v) || v;
  }

  /** Field-shape rules the model does not get to override. */
  function valueShapeError(v, intent, options) {
    if (/[<>{}]/.test(v)) return 'value-has-markup';
    if (DIGIT_INTENTS.has(intent) && !/^\d+$/.test(v.trim())) return 'non-digits-for-digit-field';
    if (intent === 'email' && !/^[^@\s]+@[^@\s]+$/.test(v.trim())) return 'not-an-email';
    if (intent === 'yesno' && !/^(true|false|yes|no)$/i.test(v.trim())) return 'not-a-yesno';
    if ((intent === 'date' || intent === 'dob') && !/^\d{4}-\d{2}-\d{2}$/.test(v.trim())) return 'not-an-iso-date';
    if (intent === 'time' && !/^\d{2}:\d{2}$/.test(v.trim())) return 'not-a-time';
    // Membership in the option list is checked by matchAllOptions, which can
    // also resolve a value naming several of them.
    return null;
  }

  /**
   * A value string -> the options it names, or null if any part names none.
   *
   * A single-select gets one option or nothing; a multi-select may be given
   * "Fever and Headache" or "Fever, Headache" and gets both. Splitting on the
   * same connectives the deterministic multichoice parser uses keeps one
   * definition of what "and" means in an answer.
   */
  function matchAllOptions(v, options, intent) {
    const find = (part) => options.find(o => norm(o.value) === norm(part) || norm(o.text) === norm(part)) || null;
    const whole = find(v);
    if (whole) return [whole];
    if (intent !== 'multichoice') return null;
    const parts = String(v).split(/\s*(?:,|\band\b|\balso\b|\bplus\b)\s*/i).map(x => x.trim()).filter(Boolean);
    if (parts.length < 2) return null;
    const out = [];
    for (const part of parts) {
      const o = find(part);
      if (!o) return null;                     // one unmatched part = not a selection
      if (!out.includes(o)) out.push(o);
    }
    return out.length ? out : null;
  }

  /* ---------------------------------------------------------- orchestrator - */

  /**
   * resumePolicy's decision -> the decision that should actually run, or null
   * to keep the deterministic one.
   *
   * All of it is pure: the caller supplies the three things that touch the
   * outside world.
   *
   *   deps.optionsHeard(options, heardText)  the Phase 3 heard-ledger match
   *   deps.askProvider(context)              -> { ok, intent, ms } | { ok:false }
   *   deps.stillCurrent()                    -> null, or why the turn moved on
   *   deps.metric(name, detail)              optional counter sink
   *
   * The provider is consulted at most once, and whatever it says is validated
   * against `ctx` - not against itself - before it can be returned.
   */
  async function consult(decision, ctx, deps) {
    const { field, intent, options = [], pending, transcript, heardText = '', interrupted = false, profile = null } = ctx;
    const metric = deps.metric || (() => {});
    const M = MEM();

    const route = shouldConsult(decision, ctx);
    if (!route.consult) { metric('skipped', route.why); return null; }
    metric('consulted', route.why);
    metric('consultedWhy', route.why);

    // The heard ledger decides which options a POSITIONAL reference may count.
    // POSITION and LABEL are deliberately kept apart here:
    //
    //   position  only what was actually spoken aloud. "The third one" cannot
    //             mean an option the list never reached, because the user was
    //             not counting it. Zero heard means zero countable, and the
    //             right answer is to ask - collapsing back to the full list
    //             here is exactly the assumption the PRD forbids.
    //   label     the whole list. Someone who knows the form may name an option
    //             over the top of it; Phase 3 already accepts that, confirmed.
    const heardOpts = interrupted ? deps.optionsHeard(options, heardText) : options;
    const isChoice = intent === 'choice' || intent === 'multichoice';

    // Ordinals and quantifiers over a list are arithmetic, not interpretation:
    // no provider, no latency, and no way to name an option that is not there.
    if (options.length && isChoice) {
      // Interrupted before any option was audible, and the user counted anyway.
      if (interrupted && !heardOpts.length && POSITIONAL.test(transcript)) {
        metric('clarifications');
        return { action: 'clarify', via: 'ordinal',
                 question: 'I had not read the options out yet. Which one did you mean?' };
      }
      // "everything except the fever" is set arithmetic over a known list.
      const excl = resolveExclusion(transcript, heardOpts);
      if (excl && excl.length) {
        if (intent === 'choice' && excl.length > 1) {
          metric('clarifications');
          return { action: 'clarify', via: 'ordinal', question: 'That leaves more than one. Which would you like?' };
        }
        metric('byOrdinal');
        return { action: 'answer', via: 'ordinal', viaHeard: true,
                 ex: { value: intent === 'multichoice' ? excl.map(o => o.value) : excl[0].value,
                       display: excl.map(o => o.text).join(', '), confidence: 0.99,
                       needsConfirmation: true, ambiguous: false } };
      }

      const rel = resolveRelative(transcript, heardOpts);
      if (Array.isArray(rel)) {
        // "none of them" is a deliberate empty selection, which for a form
        // field is the skip the core already implements.
        if (!rel.length) { metric('byOrdinal'); return { action: 'command', command: 'skip', via: 'ordinal' }; }
        if (intent === 'choice' && rel.length > 1) {
          metric('clarifications');
          return { action: 'clarify', via: 'ordinal', question: 'This one takes a single answer. Which one would you like?' };
        }
          const picked = rel.map(i => heardOpts[i - 1]);
        metric('byOrdinal');
        return {
          action: 'answer', via: 'ordinal', viaHeard: true,
          ex: { value: intent === 'multichoice' ? picked.map(o => o.value) : picked[0].value,
                display: picked.map(o => o.text).join(', '), confidence: 0.99,
                needsConfirmation: true, ambiguous: false },
        };
      }
      // "the fifth" over four options, or "the third" over a list cut after two.
      if (rel && rel.outOfRange) {
        metric('clarifications');
        return { action: 'clarify', via: 'ordinal',
                 question: `I only have ${heardOpts.length} option${heardOpts.length === 1 ? '' : 's'} so far. Which one did you mean?` };
      }
    }

    const currentValue = pending?.value ?? field.currentValue ?? null;

    // Spelling and casing: assembling letters and changing case are string
    // arithmetic, and the model is worse at both than a function is. The letter
    // evidence WINS over the words it was spoken alongside, which is the whole
    // point - "no, it's Arnav, spell it A R N A V" over a transcript of
    // "Enough" resolves to Arnav without the recogniser ever getting it right.
    //
    // BEFORE the positional editor, because "capitalize the first letter" reads
    // as a positional edit naming no replacement, and would have asked a
    // question instead of doing the plainly-stated thing.
    if (M) {
      const built = M.resolveUtterance(transcript, { intent, currentValue });
      if (built?.clarify) { metric('clarifications'); return { action: 'clarify', via: 'spelling', question: built.clarify }; }
      if (built?.value) {
        const ex = shapeValue(built.value, intent, options);
        if (ex) {
          metric('byFormatting');
          return pending ? { action: 'correction', via: built.via, ex } : { action: 'answer', via: built.via, viaHeard: false, ex };
        }
        // Assembled into something the field cannot hold: not an answer. The
        // provider still gets its turn below rather than this being fatal.
        metric('rejected', 'assembled-value-invalid');
      }
    }

    // A positional edit against a known value is arithmetic too. Doing it here
    // costs nothing and is exactly right, where the provider is neither.
    if (currentValue && PARTIAL_EDIT.test(transcript)) {
      const edited = editByPosition(transcript, currentValue);
      // shapeValue, not valueShapeError: on a choice field the latter says
      // nothing about MEMBERSHIP, so an edited string that is no longer any
      // option would have been written straight through.
      const ex = edited ? shapeValue(edited, intent, options) : null;
      if (ex) {
        metric('byOrdinal');
        return pending ? { action: 'correction', via: 'ordinal', ex } : { action: 'answer', via: 'ordinal', viaHeard: false, ex };
      }
      // A positional edit naming a character the value does not have ("the
      // fifth letter" of four) is a mistake, not something to interpret. The
      // deterministic decision here is the FRAGMENT bug - it would write "2" -
      // so falling back to it is not an option; asking is.
      const bad = editRefusal(transcript, currentValue);
      if (bad) {
        metric('clarifications');
        return { action: 'clarify', via: 'ordinal', question: bad };
      }
    }

    // A misrecognition this person has already corrected, in this kind of
    // field. A CANDIDATE, never an override: it is shape-checked here and read
    // back before it counts, exactly like anything a model returns.
    if (M && profile) {
      const canonical = M.lookupCorrection(profile, transcript, intent);
      const ex = canonical ? shapeValue(canonical, intent, options) : null;
      if (ex) {
        ex.confidence = 0.9;
        metric('byMemory');
        return pending ? { action: 'correction', via: 'memory', ex } : { action: 'answer', via: 'memory', viaHeard: false, ex };
      }
    }

    const context = buildContext({ ...ctx, options, heardOptionValues: heardOpts.map(o => o.value), interrupted, profile });
    const r = await deps.askProvider(context);

    // Provider down, slow, or refusing: the deterministic decision stands. This
    // is the fallback path, and it is why the layer is additive rather than
    // load-bearing.
    if (!r || !r.ok || !r.intent) {
      metric('providerFailures', r?.error || 'no-intent');
      return exclusionFallback(route, isChoice, options, transcript, metric, decision);
    }

    const moved = deps.stillCurrent ? deps.stillCurrent() : null;
    if (moved) { metric('staleDiscarded', moved); return { action: 'drop', reason: `intent-${moved}`, via: 'intent' }; }

    const v = validateIntent(r.intent, { ...ctx, options, heardOptionValues: heardOpts.map(o => o.value), interrupted });
    if (!v.ok) {
      // A rejected intent is not a reason to guess: the deterministic decision -
      // usually "I did not get that" - is the safe outcome.
      metric('rejected', v.why);
      return exclusionFallback(route, isChoice, options, transcript, metric, decision);
    }
    // A model answer that selects the very option the user ruled out is not a
    // near miss, it is the opposite of the request - and "Fever" IS a valid
    // option, so structural validation cannot catch it. The exclusion is known
    // deterministically, so it is enforced deterministically.
    if (route.exclusion && v.decision.ex) {
      const banned = new Set(excludedIn(transcript, options).map(o => String(o.value)));
      const chosen = [].concat(v.decision.ex.value ?? []).map(String);
      if (banned.size && chosen.some(x => banned.has(x))) {
        metric('rejected', 'selected-an-excluded-option');
        return exclusionFallback(route, isChoice, options, transcript, metric, decision);
      }
    }
    // A question is not always better than the answer the table already had.
    // With an option list cut off and nothing matching, the deterministic
    // decision CONTINUES the list from where it stopped - which tells the
    // person what the remaining options are. "Which one did you mean?" is a
    // strictly worse version of the same turn, so it does not replace it.
    if (v.decision.action === 'clarify' && decision.action === 'options-remaining') {
      metric('skipped', 'clarify-would-lose-the-option-list');
      return null;
    }
    metric(v.decision.action === 'clarify' ? 'clarifications' : 'byProvider', v.decision.modelIntent);
    return { ...v.decision, providerMs: r.ms ?? null };
  }

  /**
   * Falling back to the deterministic decision is safe for every route EXCEPT
   * exclusion, where that decision is the excluded option itself. There, a
   * question is the only honest answer.
   */
  function exclusionFallback(route, isChoice, options, transcript, metric, decision) {
    if (!isChoice || !options.length) return null;
    // A reference the model could not resolve is only worth a question when the
    // TABLE could not resolve it either. "No, actually just the headache" reads
    // as referential ("just the...") and routes to the provider, but the table
    // had already produced the right correction - asking there would replace a
    // correct answer with a question every time the provider was slow.
    //
    // Exclusion is the exception and is handled below: there the deterministic
    // decision is the excluded option, so it is not something to fall back TO.
    const usable = ['answer', 'correction', 'accept', 'reject', 'command'].includes(decision?.action);
    if (usable && !route.exclusion) return null;
    // Exclusion: the deterministic decision IS the excluded option, so falling
    // back to it would do the opposite of what was asked.
    // Reference: "the other one", "the same ones I said before". If the model
    // could not resolve it either, asking beats "I didn't get that", and it
    // spends no attempt against the error-recovery cap.
    //
    // A plainly unmatched utterance ("banana") is NOT covered: there the
    // existing failAttempt path is correct, and it is what bounds the loop.
    if (!route.exclusion && !route.referential) return null;
    metric('clarifications');
    return { action: 'clarify', via: 'ordinal', question: 'Sorry - which ones would you like?' };
  }

  /** The options an exclusion utterance rules out - within its own clause only. */
  function excludedIn(text, options) {
    const t = norm(exclusionClause(text));
    const m = /\b(?:except|excluding|but not|but|other than|apart from|aside from|besides|without|minus)\b(.*)$/i.exec(t);
    const tail = m ? m[1] : t.replace(/^\s*(?:not|no)\s+/i, '');
    // "none of them except headache" names what IS wanted, not what is barred.
    if (/\b(none|neither|nothing|not any)\b/.test(m ? t.slice(0, m.index) : '')) return [];
    return optionsNamedIn(tail, options);
  }

  return { consult, resolveRelative, resolveExclusion, editByPosition, editRefusal, shouldConsult, buildContext,
           validateIntent, valueShapeError, matchAllOptions, shapeValue, followValue,
           INTENTS, DIGIT_INTENTS, RELATIVE, POSITIONAL, PARTIAL_EDIT, CORRECTION_MARKER, NAVIGATION };
})();
