// Text normalisation for confirmation read-back (PRD F2.5), plus the inverse
// direction: turning what the user SAID into a value to write.
//
// Classic script, same as the other shared files - MV3 content scripts have no
// ES module support. The Node test harness eval's this exact file, so there is
// one implementation of every rule and no second copy to drift.
//
// Two directions, deliberately separated:
//   toSpeech(...)   value -> text Rime will pronounce intelligibly
//   fromSpeech(...) transcript -> a value the DOM can accept
//
// They are not inverses and must not be written as if they were: "160071" reads
// as "one six zero, zero seven one" but arrives back from STT as any of
// "160071", "160 071", "one six zero zero seven one", or "16 00 71".
globalThis.VFNormalize = (() => {
  'use strict';

  /* ------------------------------------------------------------- shared --- */

  // Includes the manglings a recogniser actually returns for spoken digits.
  // "three" comes back as "free" often enough to cost a whole identifier, and
  // these tables are only consulted in a digit context, so a homophone here
  // cannot corrupt free text.
  const DIGIT_WORDS = {
    zero: 0, oh: 0, o: 0, nought: 0, none: 0,
    one: 1, won: 1, want: 1,
    two: 2, to: 2, too: 2,
    three: 3, free: 3, tree: 3, thee: 3,
    four: 4, for: 4, fore: 4,
    five: 5, hive: 5,
    six: 6, sics: 6,
    seven: 7, sevin: 7,
    eight: 8, ate: 8, ait: 8,
    nine: 9, nein: 9, niner: 9,
  };
  const TEENS = { ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
    sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
  const TENS = { twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60,
    seventy: 70, eighty: 80, ninety: 90 };

  // NATO alphabet, both directions. Read-back uses it to disambiguate; the
  // parser accepts it because users spell back the same way.
  const NATO = { a: 'Alpha', b: 'Bravo', c: 'Charlie', d: 'Delta', e: 'Echo', f: 'Foxtrot',
    g: 'Golf', h: 'Hotel', i: 'India', j: 'Juliett', k: 'Kilo', l: 'Lima', m: 'Mike',
    n: 'November', o: 'Oscar', p: 'Papa', q: 'Quebec', r: 'Romeo', s: 'Sierra', t: 'Tango',
    u: 'Uniform', v: 'Victor', w: 'Whiskey', x: 'X-ray', y: 'Yankee', z: 'Zulu' };
  const NATO_REVERSE = (() => {
    const m = {};
    for (const [letter, word] of Object.entries(NATO)) m[word.toLowerCase().replace(/-/g, '')] = letter;
    // Spellings and manglings STT actually produces, measured against real
    // clips: "kilos" for Kilo, "mic" for Mike, "x ray" split in two.
    Object.assign(m, {
      juliet: 'j', xray: 'x', whisky: 'w', alfa: 'a', mic: 'm', mike: 'm',
      oskar: 'o', quebeck: 'q', tangoes: 't', golfs: 'g', zulus: 'z',
    });
    // Plurals: a trailing s is a transcription artefact, never a different letter.
    for (const [w, l] of Object.entries({ ...m })) if (!m[w + 's']) m[w + 's'] = l;
    return m;
  })();

  const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
    'august', 'september', 'october', 'november', 'december'];

  const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  const digitsOnly = (s) => String(s ?? '').replace(/\D+/g, '');

  /** Pause token. Only a pause if the request set pauseBetweenBrackets. */
  let pauseEnabled = true;
  const setPauseEnabled = (v) => { pauseEnabled = !!v; };
  const pause = (ms) => (pauseEnabled ? `<${ms}> ` : '');

  /* ============================ value -> speech ============================ */

  const DIGIT_SPOKEN = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

  /**
   * Digits spoken individually. "0" is "zero", never "oh" - "oh" comes back
   * from STT as the letter O.
   *
   * Short values are NOT grouped: a 4-digit PIN read as "four eight two, one"
   * sounds like a mistake, because the pause implies a boundary that is not
   * there. Grouping only earns its place once the string is long enough to be
   * hard to hold in one piece.
   */
  function spellDigits(s, { groupSize = 2, gapMs = 300 } = {}) {
    const d = digitsOnly(s);
    if (!d) return '';
    const groups = [];
    // PAIRS, not triples. Measured across all ten digit items in the read-back
    // corpus: pairs 10/10, triples 9/10, no grouping 8/10. Pause LENGTH made no
    // difference at 300/500/800ms - the grouping is what carries it.
    if (d.length <= 4) groups.push(d);
    else for (let i = 0; i < d.length; i += groupSize) groups.push(d.slice(i, i + groupSize));
    return groups
      .map(g => g.split('').map(c => DIGIT_SPOKEN[+c]).join(' '))
      .join(`, ${pause(gapMs)}`);
  }

  /**
   * Alphanumerics letter by letter, letters anchored to NATO. Confusable pairs
   * (B/D/P, M/N) survive a laptop speaker only with the anchor; digits do not
   * need one and get noisier with it.
   */
  function spellAlphanumeric(s, { gapMs = 250 } = {}) {
    const t = String(s ?? '').trim();
    if (!t) return '';
    const parts = [];
    for (const ch of t) {
      if (/[a-z]/i.test(ch)) parts.push(`${ch.toUpperCase()} as in ${NATO[ch.toLowerCase()]}`);
      else if (/\d/.test(ch)) parts.push(DIGIT_SPOKEN[+ch]);
      else if (ch === '-') parts.push('dash');
      else if (ch === '/') parts.push('slash');
      else if (ch === ' ') continue;
      else if (ch === '.') parts.push('dot');
      else parts.push(ch);
    }
    return parts.join(`, ${pause(gapMs)}`);
  }

  /**
   * Phone numbers in 3-3-4, the way a person reads one aloud.
   *
   * Short codes and long numbers want different groupings, and measurement says
   * so rather than taste: on the five phone numbers, two samples each,
   * 3-3-4 scored 10/10 and threes 10/10 against 9/10 for pairs, while on
   * six-digit postal codes pairs were what rescued 160071. So pairs for short
   * values (spellDigits), conventional phone grouping here. Convenient that the
   * measured answer is also the natural one.
   */
  function speakPhone(s) {
    const d = digitsOnly(s);
    if (!d) return '';
    let groups;
    if (d.length === 10) groups = [d.slice(0, 3), d.slice(3, 6), d.slice(6)];
    else if (d.length === 11) groups = [d.slice(0, 1), d.slice(1, 4), d.slice(4, 7), d.slice(7)];
    else {
      groups = [];
      for (let i = 0; i < d.length; i += 3) groups.push(d.slice(i, i + 3));
    }
    return groups.map(g => g.split('').map(c => DIGIT_SPOKEN[+c]).join(' ')).join(`, ${pause(300)}`);
  }

  const ORDINAL = { 1: 'first', 2: 'second', 3: 'third', 5: 'fifth', 8: 'eighth', 9: 'ninth',
    12: 'twelfth', 20: 'twentieth', 21: 'twenty first', 22: 'twenty second', 23: 'twenty third',
    30: 'thirtieth', 31: 'thirty first' };

  function speakYear(y) {
    const n = Number(y);
    if (!Number.isFinite(n)) return String(y);
    if (n >= 2000 && n <= 2009) return `two thousand${n === 2000 ? '' : ' ' + DIGIT_SPOKEN[n - 2000]}`;
    if (n >= 2010 && n <= 2099) return `two thousand ${speakNumber(n - 2000)}`;
    if (n >= 1100 && n <= 1999) return `${speakNumber(Math.floor(n / 100))} ${n % 100 === 0 ? 'hundred' : speakNumber(n % 100)}`;
    return String(n);
  }

  function speakNumber(n) {
    n = Number(n);
    if (!Number.isFinite(n)) return String(n);
    if (n < 0) return `minus ${speakNumber(-n)}`;
    if (n < 10) return DIGIT_SPOKEN[n];
    const teens = Object.entries(TEENS).find(([, v]) => v === n);
    if (teens) return teens[0];
    if (n < 100) {
      const t = Math.floor(n / 10) * 10, r = n % 10;
      const tens = Object.entries(TENS).find(([, v]) => v === t)?.[0] ?? String(t);
      return r ? `${tens} ${DIGIT_SPOKEN[r]}` : tens;
    }
    if (n < 1000) {
      const h = Math.floor(n / 100), r = n % 100;
      return `${DIGIT_SPOKEN[h]} hundred${r ? ' and ' + speakNumber(r) : ''}`;
    }
    return String(n);
  }

  /**
   * ISO date -> the way a person says it.
   *
   * Month first. Five forms were synthesised and put through STT; leading with
   * the ordinal lost three of five ("first January" came back as "for
   * streaming", "second March" as "Succomage"), because an unstressed ordinal
   * at the start of an utterance has no context to disambiguate it. Leading
   * with the month name gives the recogniser an anchor before the number, and
   * that form transcribed cleanly on all five.
   */
  function speakDate(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '').trim());
    if (!m) return String(iso || '');
    const [, y, mo, d] = m;
    const day = Number(d);
    const dayWord = ORDINAL[day] || `${speakNumber(day)}th`;
    const month = MONTHS[Number(mo) - 1];
    if (!month) return String(iso);
    return `${month[0].toUpperCase()}${month.slice(1)} ${dayWord}, ${pause(200)}${speakYear(y)}`;
  }

  /**
   * "19:30" -> the way a person says it. Reading the 24-hour string back
   * verbatim ("nineteen thirty") is not how anyone confirms a delivery slot.
   */
  function speakTime(hhmm) {
    const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm ?? '').trim());
    if (!m) return String(hhmm ?? '');
    const h = Number(m[1]), mi = Number(m[2]);
    if (h > 23 || mi > 59) return String(hhmm);
    const h12 = h % 12 === 0 ? 12 : h % 12;
    const mins = mi === 0 ? "o'clock" : mi < 10 ? `oh ${speakNumber(mi)}` : speakNumber(mi);
    return `${speakNumber(h12)} ${mins} ${h < 12 ? 'A M' : 'P M'}`;
  }

  function speakEmail(s) {
    const t = String(s ?? '').trim();
    if (!t) return '';
    const [user, domain] = t.split('@');
    if (!domain) return spellAlphanumeric(t);
    // The local part is where errors hide; the domain is usually a known word.
    return `${spellAlphanumeric(user)}, ${pause(300)}at, ${pause(200)}${domain.replace(/\./g, ' dot ')}`;
  }

  function speakAmount(s) {
    const t = String(s ?? '').trim().replace(/[£$€,]/g, '');
    const n = Number(t);
    if (!Number.isFinite(n)) return t;
    const whole = Math.floor(n), cents = Math.round((n - whole) * 100);
    const w = whole < 1000 ? speakNumber(whole) : String(whole);
    return cents ? `${w} point ${DIGIT_SPOKEN[Math.floor(cents / 10)]} ${DIGIT_SPOKEN[cents % 10]}` : w;
  }

  /**
   * A name dictionary keyed lowercase; values are Rime phoneme strings from
   * /phonemize. Wrapped in braces for phonemizeBetweenBrackets. Empty until
   * tools/build_names.mjs fills it - a missing entry falls back to the raw name,
   * which is the correct behaviour and not an error.
   */
  let NAME_PHONEMES = {};
  const setNamePhonemes = (m) => { NAME_PHONEMES = m || {}; };
  const getNamePhonemes = () => NAME_PHONEMES;

  /**
   * The USER's own dictionary, layered over the global one.
   *
   *   { "arnav": { phonemes: "ˈɑːrnəv" | null, respell: "ar nuv" | null } }
   *
   * Two representations because only one of them works everywhere. Phonemes
   * need `phonemizeBetweenBrackets`, which Mist v1/v2 honour and Coda does not
   * (README "Model"); a RESPELLING is ordinary text and works on any model, at
   * the cost of being approximate. When phonemes are unavailable the respelling
   * is used, and when neither exists the raw word is spoken - which is the
   * correct behaviour, not an error.
   */
  let USER_PRONUNCIATIONS = {};
  const setUserPronunciations = (m) => { USER_PRONUNCIATIONS = m || {}; };
  const getUserPronunciations = () => USER_PRONUNCIATIONS;

  // Braces are only a phoneme directive when the connection asked for them. On
  // a model that ignores the flag they are read out as literal characters, so
  // the same guard the pause tokens have applies here - see setPauseEnabled.
  let phonemesEnabled = true;
  const setPhonemesEnabled = (v) => { phonemesEnabled = !!v; };

  function speakName(s) {
    const t = String(s ?? '').trim();
    if (!t) return '';
    return t.split(/\s+/).map(word => {
      const u = USER_PRONUNCIATIONS[word.toLowerCase()];
      if (u?.phonemes && phonemesEnabled) return `{${u.phonemes}}`;
      if (u?.respell) return u.respell;
      const p = NAME_PHONEMES[word.toLowerCase()];
      return p && phonemesEnabled ? `{${p}}` : word;
    }).join(' ');
  }

  /**
   * The read-back text for a value, by intent. This is what the confirmation
   * claim rests on, so every branch is exercised by the normalisation tests.
   */
  function toSpeech(value, intent) {
    const v = String(value ?? '').trim();
    if (!v) return '';
    switch (intent) {
      case 'postal':   return spellDigits(v);
      case 'pin':      return spellDigits(v);
      case 'idnumber': return spellAlphanumeric(v);
      case 'phone':    return speakPhone(v);
      case 'date':
      case 'dob':      return speakDate(v);
      case 'time':     return speakTime(v);
      case 'email':    return speakEmail(v);
      case 'amount':   return speakAmount(v);
      case 'name':     return speakName(v);
      case 'number':
      case 'age':
      case 'quantity': return /^\d+$/.test(v) ? speakNumber(Number(v)) : v;
      case 'yesno':    return v === 'true' || v === 'yes' ? 'yes' : 'no';
      default:
        // Free text is read as written; a bare alphanumeric code is not.
        if (/^[A-Z0-9][A-Z0-9\-]{2,}$/i.test(v) && /\d/.test(v) && !/\s/.test(v)) return spellAlphanumeric(v);
        return v;
    }
  }

  /* ============================ speech -> value ============================ */

  /**
   * Spoken words to digits. Handles the three shapes STT returns for the same
   * utterance: digit words ("one six zero"), compound numbers ("sixteen"), and
   * digits already ("160071") - often mixed inside one transcript.
   */
  function wordsToDigits(text) {
    const t = String(text ?? '').toLowerCase().replace(/[,]/g, ' ').replace(/-/g, ' ');
    const tokens = t.split(/\s+/).filter(Boolean);
    let out = '';
    for (let i = 0; i < tokens.length; i++) {
      const w = tokens[i].replace(/[^a-z0-9]/g, '');
      if (!w) continue;
      if (/^\d+$/.test(w)) { out += w; continue; }
      if (w in DIGIT_WORDS) { out += DIGIT_WORDS[w]; continue; }
      if (w in TEENS) { out += String(TEENS[w]); continue; }
      if (w in TENS) {
        // "twenty three" is 23; a bare "twenty" is 20.
        const next = (tokens[i + 1] || '').replace(/[^a-z]/g, '');
        if (next in DIGIT_WORDS && DIGIT_WORDS[next] !== 0) { out += String(TENS[w] + DIGIT_WORDS[next]); i++; }
        else out += String(TENS[w]);
        continue;
      }
      if (w === 'hundred') {
        // "one hundred" -> 100. Only meaningful attached to what came before.
        if (out.length) { out = String(Number(out) * 100); }
        continue;
      }
      if (w === 'double' || w === 'triple') {
        const next = (tokens[i + 1] || '').replace(/[^a-z0-9]/g, '');
        const d = /^\d$/.test(next) ? next : (next in DIGIT_WORDS ? String(DIGIT_WORDS[next]) : null);
        if (d !== null) { out += d.repeat(w === 'double' ? 2 : 3); i++; }
        continue;
      }
    }
    return out;
  }

  /**
   * Letters and digits from speech.
   *
   * The load-bearing rule: WHEN AN ANCHOR IS PRESENT, TRUST THE ANCHOR AND
   * DISCARD THE LETTER BEFORE IT. That is the entire reason for saying "Q as in
   * Quebec" rather than "Q" - the letter is the fragile part and the anchor is
   * the redundancy. Measured on real clips, the recogniser returned
   *
   *   "Hugo is in Quebec, Ke is in Kilo, 5-2, T is in Tango, G is in Golf"
   *
   * for QK52TG: every letter mangled, every anchor intact. An earlier version
   * required the anchor to follow a single-letter token, so it threw that
   * redundancy away and scored 0/5 on identifiers.
   *
   * The connective is matched loosely ("as in", "is in", "as an", "for", "and")
   * because that unstressed syllable is exactly what a recogniser drops.
   */
  const CONNECTIVE = new Set(['as', 'is', 'in', 'an', 'a', 'for', 'and', 'the', 's', 'of']);

  function natoLetterAt(tokens, j) {
    if (j >= tokens.length) return null;
    const w = tokens[j].replace(/[^a-z]/g, '');
    if (!w || w.length < 3) return null;      // "an" must never resolve to a letter
    return NATO_REVERSE[w] || null;
  }

  /**
   * Is this transcript from a SPELLED read-back? True when at least one NATO
   * anchor survived. It licenses one inference that would be unsafe otherwise.
   */
  function hasAnchors(tokens) {
    for (let j = 0; j < tokens.length; j++) if (natoLetterAt(tokens, j)) return true;
    return false;
  }

  function wordsToAlphanumeric(text) {
    const t = String(text ?? '').toLowerCase()
      .replace(/[.,!?]/g, ' ')
      .replace(/(\d)\s*-\s*(\d)/g, '$1 $2')      // "5-2" is two digits, not a dash
      .replace(/x[\s-]?ray/g, 'xray');
    // "4X" is a run-together transcription of "four, X". Split it here rather
    // than in the loop: the anchor lookahead would otherwise consume the whole
    // token on its way to the NATO word and take the digit with it.
    const tokens = t.split(/\s+/).filter(Boolean)
      .flatMap(tok => (/^[a-z0-9]{2,4}$/.test(tok) && /\d/.test(tok) && /[a-z]/.test(tok)
        ? tok.match(/\d+|[a-z]+/g) : [tok]));
    const anchored8 = hasAnchors(tokens);
    let out = '';

    for (let i = 0; i < tokens.length;) {
      const raw = tokens[i];
      const w = raw.replace(/[^a-z0-9]/g, '');
      if (!w) { i++; continue; }

      // A NATO word standing on its own is the letter, full stop. Checked first
      // so "Bravo and Charlie" is B then C, not C alone.
      const self = natoLetterAt(tokens, i);
      if (self) { out += self.toUpperCase(); i++; continue; }

      // Otherwise: is there an anchor just ahead, with only connectives between?
      //
      // A connective is REQUIRED. Allowing zero of them made "seven kilo" look
      // like an anchored letter and swallowed the digit - "sierra foxtrot seven
      // kilo" came out as SFK. The single exception is a bare letter directly
      // followed by its own NATO word ("B Bravo"), where the letter is the
      // thing being anchored.
      const selfIsLetter = w.length === 1 && /[a-z]/.test(w);
      let anchored = false;
      for (let j = i + 1; j <= i + 3 && j < tokens.length; j++) {
        if (j === i + 1 && !selfIsLetter) continue;   // no connective, no anchor
        const between = tokens.slice(i + 1, j).map(x => x.replace(/[^a-z]/g, ''));
        if (!between.every(x => CONNECTIVE.has(x))) break;
        const letter = natoLetterAt(tokens, j);
        if (letter) { out += letter.toUpperCase(); i = j + 1; anchored = true; break; }
      }
      if (anchored) continue;

      if (/^\d+$/.test(w)) { out += w; i++; continue; }
      if (w in DIGIT_WORDS) { out += DIGIT_WORDS[w]; i++; continue; }
      if (w in TEENS) { out += String(TEENS[w]); i++; continue; }
      if (w in TENS) {
        const next = (tokens[i + 1] || '').replace(/[^a-z]/g, '');
        if (next in DIGIT_WORDS && DIGIT_WORDS[next] !== 0) { out += String(TENS[w] + DIGIT_WORDS[next]); i += 2; }
        else { out += String(TENS[w]); i++; }
        continue;
      }
      if (w === 'dash' || w === 'hyphen') { out += '-'; i++; continue; }
      if (w === 'slash') { out += '/'; i++; continue; }
      if (w.length === 1 && /[a-z]/.test(w)) {
        // "eight" is heard as the letter A inside a spelled identifier - the
        // one digit name that collides with a letter name, measured twice on
        // BD8PM3 -> BDAPM3. Every real letter in this form arrives anchored
        // ("A as in Alpha"), so a BARE "a" among anchored letters is the digit,
        // not the letter. Scoped to anchored transcripts so it cannot fire on
        // ordinary spelling.
        if (w === 'a' && anchored8) { out += '8'; i++; continue; }
        out += w.toUpperCase(); i++; continue;
      }


      // Everything else is filler. An earlier version guessed that any short
      // word was spelled-out letters, which turned "is an" into "AN" and
      // "Hugh is in" into "HUGH".
      i++;
    }
    return out;
  }

  /**
   * Spoken words to a NUMBER, with place value. Distinct from wordsToDigits on
   * purpose: a PIN is a sequence of digits ("one six zero" is 160), while an
   * amount is arithmetic ("two hundred and fifty" is 250, not 20050). Using the
   * digit reader for amounts produced exactly that.
   */
  function wordsToNumber(text) {
    const t = String(text ?? '').toLowerCase().replace(/[,]/g, ' ').replace(/-/g, ' ');
    const tokens = t.split(/\s+/).filter(Boolean);
    let total = 0, current = 0, seen = false;
    for (const raw of tokens) {
      const w = raw.replace(/[^a-z0-9.]/g, '');
      if (!w || w === 'and') continue;
      if (/^\d+(\.\d+)?$/.test(w)) { current += Number(w); seen = true; continue; }
      if (w in DIGIT_WORDS) { current += DIGIT_WORDS[w]; seen = true; continue; }
      if (w in TEENS) { current += TEENS[w]; seen = true; continue; }
      if (w in TENS) { current += TENS[w]; seen = true; continue; }
      if (w === 'hundred') { current = (current || 1) * 100; seen = true; continue; }
      if (w === 'thousand') { total += (current || 1) * 1000; current = 0; seen = true; continue; }
      if (w === 'million') { total += (current || 1) * 1e6; current = 0; seen = true; continue; }
    }
    return seen ? total + current : null;
  }

  /** Ordinals to cardinals, so "June fourteenth" reads as a day. */
  const ORDINAL_WORDS = {
    first: 'one', second: 'two', third: 'three', fourth: 'four', fifth: 'five',
    sixth: 'six', seventh: 'seven', eighth: 'eight', ninth: 'nine', tenth: 'ten',
    eleventh: 'eleven', twelfth: 'twelve', thirteenth: 'thirteen', fourteenth: 'fourteen',
    fifteenth: 'fifteen', sixteenth: 'sixteen', seventeenth: 'seventeen',
    eighteenth: 'eighteen', nineteenth: 'nineteen', twentieth: 'twenty', thirtieth: 'thirty',
  };
  function deOrdinal(text) {
    let t = String(text ?? '').toLowerCase();
    t = t.replace(/\b(\d{1,2})(st|nd|rd|th)\b/g, '$1');
    for (const [o, c] of Object.entries(ORDINAL_WORDS)) t = t.replace(new RegExp(`\\b${o}\\b`, 'g'), c);
    return t;
  }

  const YES = /\b(yes|yeah|yep|yup|correct|right|affirmative|sure|ok|okay|true|confirm|confirmed)\b/i;
  const NO = /\b(no|nope|nah|negative|incorrect|wrong|false|not right)\b/i;

  function parseYesNo(text) {
    const t = String(text ?? '');
    // Check NO first: "no, that's not right" contains neither a bare yes nor
    // any ambiguity, but "yes" appears inside "yesterday".
    if (NO.test(t) && !YES.test(t)) return false;
    if (YES.test(t) && !NO.test(t)) return true;
    if (NO.test(t) && YES.test(t)) {
      // Both present: the first one wins ("no, yes I mean..." is rare enough).
      const iy = t.search(YES), inn = t.search(NO);
      return iy < inn;
    }
    return null;
  }

  function parseEmail(text) {
    let t = String(text ?? '').toLowerCase().trim();
    t = t.replace(/\s+at\s+/g, '@').replace(/\s+dot\s+/g, '.')
         .replace(/\bunderscore\b/g, '_').replace(/\bdash\b|\bhyphen\b/g, '-')
         .replace(/\s+/g, '');
    // STT writes emails correctly quite often; if it already looks like one, keep it.
    const m = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/.exec(t);
    return m ? m[0] : t;
  }

  /**
   * Dates from speech -> ISO. Accepts "14 June 2026", "June 14th 2026",
   * "14/06/2026", "the fourteenth of June two thousand twenty six".
   *
   * The month-name path used to run the whole string through the digit reader,
   * which happily concatenated the day and the year into one number: "the
   * fourteenth of June two thousand twenty six" came out as the 22nd. The year
   * is now identified and REMOVED before the day is read, so the two numbers
   * can never merge.
   */
  function parseDate(text) {
    const t0 = String(text ?? '').toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
    if (!t0) return null;
    const t = deOrdinal(t0);

    const iso = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t);
    if (iso) return `${iso[1]}-${String(+iso[2]).padStart(2, '0')}-${String(+iso[3]).padStart(2, '0')}`;

    const slash = /(\d{1,2})\s*[\/.-]\s*(\d{1,2})\s*[\/.-]\s*(\d{2,4})/.exec(t);
    if (slash) {
      let [, a, b, y] = slash;
      if (y.length === 2) y = String(Number(y) > 30 ? '19' + y : '20' + y);
      // Day-first: the PRD's judged flow is en-GB shaped. A value over 12 in
      // either slot removes the ambiguity on its own.
      let d = +a, mo = +b;
      if (mo > 12 && d <= 12) { const tmp = d; d = mo; mo = tmp; }
      if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
      return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }

    const monthIdx = MONTHS.findIndex(m => new RegExp(`\\b${m.slice(0, 3)}[a-z]*\\b`).test(t));
    if (monthIdx < 0) return null;

    // Pull the year out first, so its digits cannot be read as the day.
    let year = null, rest = t;
    const numericYear = /\b(19|20)\d{2}\b/.exec(t);
    if (numericYear) {
      year = Number(numericYear[0]);
      rest = t.replace(numericYear[0], ' ');
    } else {
      year = parseSpokenYear(t);
      if (year !== null) {
        rest = t.replace(/\b(two thousand(\s+and)?(\s+[a-z]+){0,2}|nineteen(\s+[a-z]+){1,2})\b/, ' ');
      }
    }
    if (year === null) return null;

    // Whatever is left, minus the month name, holds the day.
    const dayText = rest.replace(new RegExp(MONTHS[monthIdx], 'g'), ' ')
                        .replace(/\b(the|of|on|in)\b/g, ' ');
    const numericDay = /\b(\d{1,2})\b/.exec(dayText);
    const day = numericDay ? Number(numericDay[1]) : wordsToNumber(dayText);
    if (!day || day < 1 || day > 31) return null;

    return `${year}-${String(monthIdx + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  function parseSpokenYear(text) {
    const t = String(text ?? '').toLowerCase();
    const m2k = /two thousand(?:\s+and)?\s+([a-z]+(?:\s+[a-z]+)?)/.exec(t);
    if (m2k) {
      const n = Number(wordsToDigits(m2k[1]));
      if (Number.isFinite(n) && n > 0 && n < 100) return 2000 + n;
      return 2000;
    }
    if (/\btwo thousand\b/.test(t)) return 2000;
    const m19 = /nineteen\s+([a-z]+(?:\s+[a-z]+)?)/.exec(t);
    if (m19) {
      const n = Number(wordsToDigits(m19[1]));
      if (Number.isFinite(n) && n >= 0 && n < 100) return 1900 + n;
    }
    return null;
  }

  // Only the unambiguous number words. DIGIT_WORDS carries STT homophones
  // ("to", "for", "ate") that are ordinary English inside a spoken time.
  const CLOCK_WORDS = { ...TEENS, ...TENS, zero: 0, oh: 0, o: 0,
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };

  /** The numbers in a spoken time, in order, digit runs kept as written. */
  function clockNumbers(text) {
    const tokens = String(text ?? '').split(/\s+/).map(w => w.replace(/[^a-z0-9]/g, '')).filter(Boolean);
    const out = [];
    for (let i = 0; i < tokens.length; i++) {
      const w = tokens[i];
      if (/^\d+$/.test(w)) { out.push(w); continue; }
      if (!(w in CLOCK_WORDS)) continue;
      let n = CLOCK_WORDS[w];
      // "seven thirty five" is 7:35, not 7:30 then 5.
      if (w in TENS && tokens[i + 1] in CLOCK_WORDS && CLOCK_WORDS[tokens[i + 1]] < 10) n += CLOCK_WORDS[tokens[++i]];
      if (n === 0 && !/^(zero)$/.test(w) && out.length) continue; // a filler "oh" in "seven oh five"
      out.push(String(n));
    }
    return out;
  }

  /**
   * Spoken time -> "HH:MM", the only shape <input type=time> accepts.
   *
   * Without this the transcript went to the field verbatim and the browser
   * silently dropped it - a time field looked filled in the log and was empty
   * on the page (httpbin's "Preferred delivery time").
   */
  function parseTime(text) {
    let t = String(text ?? '').toLowerCase()
      .replace(/[.,]/g, ' ')
      .replace(/\bo'?\s?clock\b/g, ' ')
      .replace(/[-\u2013]/g, ' ')
      .replace(/\s+/g, ' ').trim();
    if (!t) return null;
    if (/\b(noon|midday)\b/.test(t)) return '12:00';
    if (/\bmidnight\b/.test(t)) return '00:00';

    // The recogniser writes the meridiem as "pm", "p m" or "p.m." (dots are
    // spaces by now); a time of day says it in words instead.
    const mer = /\b([ap])\s?m\b/.exec(t);
    let pm = mer ? mer[1] === 'p'
      : /\b(afternoon|evening|tonight|night)\b/.test(t) ? true
      : /\b(morning)\b/.test(t) ? false : null;
    if (mer) t = t.replace(mer[0], ' ');

    let h = null, m = 0;
    const hhmm = /\b(\d{1,2})\s*[:h]\s*(\d{2})\b/.exec(t);
    const rel = /^(.*?)\b(past|after|to|til|till|until)\b(.*)$/.exec(t);
    if (hhmm) {
      h = Number(hhmm[1]); m = Number(hhmm[2]);
    } else if (rel && /\d|[a-z]/.test(rel[3])) {
      const mins = /\bquarter\b/.test(rel[1]) ? 15 : /\bhalf\b/.test(rel[1]) ? 30 : Number(clockNumbers(rel[1])[0]);
      const hour = Number(clockNumbers(rel[3])[0]);
      if (!Number.isFinite(mins) || !Number.isFinite(hour)) return null;
      if (/^(past|after)$/.test(rel[2])) { h = hour; m = mins; }
      else { h = (hour + 23) % 24; m = 60 - mins; }
    } else {
      const nums = clockNumbers(t);
      if (!nums.length) return null;
      if (nums[0].length >= 3) { h = Number(nums[0].slice(0, -2)); m = Number(nums[0].slice(-2)); }
      else { h = Number(nums[0]); m = nums[1] != null ? Number(nums[1]) : 0; }
    }

    if (pm === true && h < 12) h += 12;
    if (pm === false && h === 12) h = 0;
    if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) return null;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  /** Levenshtein, for matching a spoken answer against option labels. */
  function levenshtein(a, b) {
    a = String(a); b = String(b);
    const m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    let prev = Array.from({ length: n + 1 }, (_, i) => i);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[n];
  }

  /**
   * Best option for a spoken answer.
   * Returns { value, text, score, ambiguous, runnerUp } - `ambiguous` when the
   * top two are close enough that guessing would be a coin flip, which is when
   * the caller must ask rather than fill.
   */
  function matchOption(text, options, { threshold = 0.62 } = {}) {
    const said = clean(text).toLowerCase().replace(/[^a-z0-9 ]/g, '');
    if (!said || !options?.length) return null;

    const scored = options.map(o => {
      const label = clean(o.text).toLowerCase().replace(/[^a-z0-9 ]/g, '');
      if (!label) return { o, score: 0 };
      let score;
      if (label === said) score = 1;
      // "I would like a medium please" contains the option as a whole word.
      // Scoring that by length ratio buried it at 0.29 and matched nothing.
      else if (new RegExp(`\\b${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(said)) score = 0.95;
      else if (label.includes(said)) {
        score = 0.9 * (said.length / label.length) + 0.1;
      } else {
        const d = levenshtein(said, label);
        score = 1 - d / Math.max(said.length, label.length);
      }
      return { o, score };
    }).sort((a, b) => b.score - a.score);

    const top = scored[0], second = scored[1];
    if (!top || top.score < threshold) {
      return { value: null, text: null, score: top?.score ?? 0, ambiguous: false, runnerUp: top?.o?.text ?? null, best: top?.o ?? null };
    }
    // Two plausible options and almost nothing between them: do not guess.
    const ambiguous = !!second && top.score - second.score < 0.08 && second.score >= threshold;
    return { value: top.o.value, text: top.o.text, score: +top.score.toFixed(3), ambiguous, runnerUp: second?.o?.text ?? null, best: top.o };
  }

  /* ------------------------------------------------------ voice commands --- */

  const COMMANDS = [
    ['repeat',  /^(repeat|say (that )?again|again|pardon|what)\b/i],
    ['next',    /^(next|skip forward|move on|continue|go on)\b/i],
    ['previous',/^(previous|back|go back|last one|prior)\b/i],
    ['skip',    /^(skip|leave (it |this )?blank|pass|none)\b/i],
    ['stop',    /^(stop|cancel|quit|exit|never ?mind)\b/i],
    ['readback',/^(what did (you|i) (enter|put|say)|read ?back|what'?s in there|check)\b/i],
    ['help',    /^(help|what can i say|commands)\b/i],
  ];

  /**
   * A command, or null if this is an answer.
   *
   * Deliberately anchored to the START of the transcript: "skip" as a command
   * is the whole utterance, whereas "skip hire company" is an answer that
   * happens to begin with the word. Length is the tiebreak.
   */
  function parseCommand(text) {
    const t = clean(text);
    if (!t) return null;
    for (const [name, re] of COMMANDS) {
      const m = re.exec(t);
      if (!m) continue;
      const matched = m[0];
      // Only a command if it is essentially the entire utterance.
      if (t.length <= matched.length + 6) return { command: name, matched, transcript: t };
    }
    return null;
  }

  /* ---------------------------------------------------------- extraction -- */

  /**
   * Transcript -> value for a field, by intent. Returns
   * { value, display, confidence, needsConfirmation, ambiguous, note }.
   * `value` null means "could not extract" and the caller must re-ask.
   */
  function fromSpeech(transcript, field, intent) {
    const raw = clean(transcript);
    const t = raw.toLowerCase();
    const opts = field?.options || [];
    const res = (value, extra = {}) => ({
      value, display: value, confidence: 1, needsConfirmation: false, ambiguous: false, note: null, ...extra,
    });

    if (!raw) return res(null, { confidence: 0, note: 'empty transcript' });

    switch (intent) {
      case 'yesno': {
        const v = parseYesNo(raw);
        if (v === null) return res(null, { confidence: 0, note: 'not a yes or no' });
        return res(v ? 'true' : 'false', { display: v ? 'yes' : 'no' });
      }

      case 'postal':
      case 'pin': {
        const d = wordsToDigits(t);
        if (!d) return res(null, { confidence: 0, note: 'no digits heard' });
        return res(d, { needsConfirmation: true });
      }

      case 'phone': {
        const d = wordsToDigits(t);
        if (d.length < 7) return res(null, { confidence: 0, note: `only ${d.length} digits heard` });
        return res(d, { needsConfirmation: true });
      }

      case 'idnumber': {
        const a = wordsToAlphanumeric(t);
        if (!a) return res(null, { confidence: 0, note: 'nothing spellable heard' });
        return res(a, { needsConfirmation: true });
      }

      case 'email': {
        const e = parseEmail(raw);
        if (!/@/.test(e)) return res(null, { confidence: 0, note: 'no @ in the transcript' });
        return res(e, { needsConfirmation: true });
      }

      case 'date':
      case 'dob': {
        const d = parseDate(raw);
        if (!d) return res(null, { confidence: 0, note: 'could not read a date' });
        return res(d, { needsConfirmation: true });
      }

      case 'time': {
        const v = parseTime(raw);
        if (!v) return res(null, { confidence: 0, note: 'could not read a time' });
        return res(v, { display: v, needsConfirmation: true });
      }

      case 'number':
      case 'age':
      case 'quantity': {
        const n = wordsToNumber(t);
        if (n === null) return res(null, { confidence: 0, note: 'no number heard' });
        return res(String(n));
      }

      case 'amount': {
        const cleaned = t.replace(/[£$€]/g, '').replace(/,/g, '');
        // A spoken decimal ("twelve pounds fifty") is not arithmetic, so a
        // literal numeral wins when one is present.
        const direct = /(\d+(?:\.\d{1,2})?)/.exec(cleaned);
        if (direct) return res(direct[1], { needsConfirmation: true });
        const n = wordsToNumber(cleaned);
        if (n === null) return res(null, { confidence: 0, note: 'no amount heard' });
        return res(String(n), { needsConfirmation: true });
      }

      case 'choice':
      case 'multichoice': {
        if (!opts.length) return res(raw);
        if (intent === 'multichoice') {
          // Split on connectives before matching, or "bacon and onion" scores
          // as one bad match instead of two good ones.
          const parts = raw.split(/\b(?:and|also|plus|,)\b/i).map(s => s.trim()).filter(Boolean);
          const picks = [];
          for (const p of parts) {
            const m = matchOption(p, opts);
            if (m?.value != null && !m.ambiguous) picks.push(m);
          }
          if (!picks.length) return res(null, { confidence: 0, note: 'no option matched' });
          return res(picks.map(p => p.value), {
            display: picks.map(p => p.text).join(', '), needsConfirmation: true,
          });
        }
        const m = matchOption(raw, opts);
        if (!m || m.value == null) {
          return res(null, { confidence: m?.score ?? 0, note: 'no option matched', ambiguous: false, runnerUp: m?.runnerUp ?? null });
        }
        if (m.ambiguous) {
          return res(null, { confidence: m.score, ambiguous: true, note: 'two options scored alike', best: m.text, runnerUp: m.runnerUp });
        }
        return res(m.value, { display: m.text, confidence: m.score, needsConfirmation: m.score < 0.95 });
      }

      case 'name': {
        // People answer "What's your name?" with "My name is Ada" - the lead-in
        // is conversation, not data, and it was being written into the field
        // verbatim ("My Name Is Alexandra Whitfield."). STT also capitalises
        // inconsistently and appends a full stop.
        const stripped = raw
          .replace(/^(my name is|my name's|the name is|name is|it's|it is|i'm|i am|this is|call me)\s+/i, '')
          .replace(/[.!?]+\s*$/, '');
        if (!stripped) return res(null, { confidence: 0, note: 'no name heard' });
        return res(stripped.replace(/\b[a-z]/g, c => c.toUpperCase()), { needsConfirmation: true });
      }

      default:
        return res(raw);
    }
  }

  /** Intents where a wrong value is expensive and must always be confirmed. */
  const HIGH_RISK = new Set(['postal', 'pin', 'idnumber', 'phone', 'date', 'dob', 'amount', 'email', 'number']);
  const isHighRisk = (intent) => HIGH_RISK.has(intent);

  return {
    // value -> speech
    toSpeech, spellDigits, spellAlphanumeric, speakPhone, speakDate, speakEmail,
    speakNumber, speakYear, speakName, speakAmount, speakTime,
    // speech -> value
    fromSpeech, wordsToDigits, wordsToNumber, deOrdinal, wordsToAlphanumeric, parseYesNo, parseDate,
    parseTime,
    parseSpokenYear, parseEmail, matchOption, levenshtein, parseCommand,
    // config
    setPauseEnabled, setNamePhonemes, getNamePhonemes, isHighRisk,
    setUserPronunciations, getUserPronunciations, setPhonemesEnabled,
    NATO, NATO_REVERSE, HIGH_RISK, COMMANDS,
  };
})();
