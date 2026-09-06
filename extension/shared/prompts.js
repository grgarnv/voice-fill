// Prompt generation (PRD F1.3) - rule-based tier.
//
// Option C from the PRD: rules first, LLM fallback later. The demo form must be
// entirely rule-covered so no LLM latency ever appears on camera, so this file
// is deliberately exhaustive rather than clever.
//
// Pause syntax is Rime's `<ms>` form and requires pauseBetweenBrackets:true on
// the request. Every emitter goes through pause() so that if the flag is ever
// unset the literal "<400>" cannot leak into speech unnoticed - see
// VFPrompts.setPauseEnabled().
globalThis.VFPrompts = (() => {
  'use strict';

  let pauseEnabled = true;

  /** A pause token, or nothing at all if the request flag is off. */
  const pause = (ms) => (pauseEnabled ? `<${ms}> ` : '');

  const has = (s, re) => re.test(s || '');

  /* ------------------------------------------------------------- intents --- */
  // Ordered: the first match wins, so the specific patterns precede the vague.
  const LABEL_RULES = [
    ['email',      /\b(e-?mail|email address)\b/i],
    ['password',   /\b(password|passcode|pass phrase|passphrase)\b/i],
    ['phone',      /\b(phone|mobile|cell|telephone|contact number|tel)\b/i],
    ['postal',     /\b(zip|postal|post code|postcode|pin ?code|eircode)\b/i],
    ['dob',        /\b(date of birth|birth date|birthday|dob)\b/i],
    ['date',       /\b(date|expiry|expiration|valid (from|until)|deadline)\b/i],
    ['time',       /\b(time|hour|appointment slot)\b/i],
    ['city',       /\b(city|town|suburb|locality)\b/i],
    ['state',      /\b(state|province|county|region)\b/i],
    ['country',    /\b(country|nation)\b/i],
    ['address',    /\b(address|street|apartment|apt|unit|building|line ?[12])\b/i],
    ['idnumber',   /\b(id|identifier|reference|licence|license|passport|ssn|nino|account number|policy|member(ship)? number|customer number|order number)\b/i],
    ['amount',     /\b(amount|price|salary|income|cost|fee|budget|total|payment)\b/i],
    ['age',        /\b(age|years old)\b/i],
    ['quantity',   /\b(quantity|qty|how many|number of)\b/i],
    ['url',        /\b(website|url|homepage|link|profile)\b/i],
    ['company',    /\b(company|organisation|organization|employer|business)\b/i],
    ['jobtitle',   /\b(job title|occupation|role|position)\b/i],
    ['name',       /\b(name|surname|given|forename|initials)\b/i],
    ['comment',    /\b(comment|message|notes?|description|feedback|details|reason|bio|about)\b/i],
    ['search',     /\b(search|find|query|filter)\b/i],
  ];

  const TYPE_INTENT = {
    email: 'email', tel: 'phone', url: 'url', password: 'password',
    date: 'date', 'datetime-local': 'date', month: 'date', week: 'date',
    time: 'time', number: 'number', range: 'number', file: 'file',
    color: 'color', search: 'search',
    select: 'choice', 'select-multiple': 'multichoice',
    radiogroup: 'choice', checkboxgroup: 'multichoice',
    checkbox: 'yesno', textarea: 'comment', combobox: 'choice',
    contenteditable: 'comment',
    // Custom controls (PRD F4.7). A widget built out of divs asks exactly the
    // same question as the native control it imitates, so it gets the same
    // intent and the same prompt - the difference is only in how it is written.
    'aria-radiogroup': 'choice', 'aria-checkboxgroup': 'multichoice',
    'aria-checkbox': 'yesno',
  };

  /**
   * Field -> intent. Structure beats wording: a <select> is a choice no matter
   * what its label says, and type=email is an email even when labelled "Login".
   */
  function classify(field) {
    const t = field.type;
    if (t === 'select' || t === 'select-multiple' || t === 'radiogroup' ||
        t === 'checkboxgroup' || t === 'checkbox' || t === 'file' || t === 'color' ||
        t === 'combobox' || t === 'aria-radiogroup' || t === 'aria-checkboxgroup' || t === 'aria-checkbox') {
      return TYPE_INTENT[t];
    }
    if (TYPE_INTENT[t] && t !== 'text') {
      // A typed input is authoritative except where the label is more specific
      // (type=text is the default and carries no information).
      if (t === 'number') {
        for (const [intent, re] of LABEL_RULES) {
          if (has(field.label, re) && ['amount', 'age', 'quantity', 'postal', 'phone'].includes(intent)) return intent;
        }
      }
      return TYPE_INTENT[t];
    }
    for (const [intent, re] of LABEL_RULES) if (has(field.label, re)) return intent;
    return 'freetext';
  }

  /* ------------------------------------------------------------- speech ---- */

  const MAX_SPOKEN_OPTIONS = 6;

  /** Options as speech, capped so a 200-entry country list is not read aloud. */
  function speakOptions(options) {
    const texts = options.map(o => o.text).filter(Boolean);
    if (texts.length === 0) return { text: '', truncated: false, total: 0 };
    if (texts.length <= MAX_SPOKEN_OPTIONS) {
      return { text: texts.join(`, ${pause(400)}`), truncated: false, total: texts.length };
    }
    const head = texts.slice(0, MAX_SPOKEN_OPTIONS).join(`, ${pause(400)}`);
    return { text: head, truncated: true, total: texts.length };
  }

  /**
   * Lowercase a label for mid-sentence use, but leave acronyms and proper nouns
   * alone: "What's your PIN code?" must not become "What's your pin code?".
   */
  function midSentence(label) {
    if (!label) return label;
    const first = label.split(' ')[0];
    if (first.length > 1 && first === first.toUpperCase()) return label;
    return label.charAt(0).toLowerCase() + label.slice(1);
  }

  const A_AN = (w) => (/^[aeiou]/i.test(w || '') ? 'an' : 'a');

  /**
   * One short question per utterance - the Phase 0 flush design and the ear
   * both want it, and it keeps `clear` useful during Phase 3 barge-in.
   */
  function promptFor(field, opts = {}) {
    const intent = opts.intent || classify(field);
    const labelRaw = field.label;
    const known = !!labelRaw;
    const L = midSentence(labelRaw);

    // "Confirm password" / "Re-enter email" are instructions, not nouns. Run
    // through the normal template and you get "What's your confirm password?".
    const conf = known && labelRaw.match(/^(confirm|repeat|re-?enter|re-?type|verify)\s+(.+)$/i);
    if (conf) {
      const verb = conf[1].toLowerCase().replace(/^re([a-z])/, 're-$1');
      return `Please ${verb} your ${conf[2].toLowerCase()}.`;
    }

    // PRD: unlabelled fields must not kill the flow.
    if (!known) {
      switch (intent) {
        case 'choice': {
          const o = speakOptions(field.options);
          return o.total
            ? `The next field is a choice. ${pause(300)}Options are: ${o.text}.${o.truncated ? ` ${pause(300)}And ${o.total - MAX_SPOKEN_OPTIONS} more.` : ''}`
            : 'The next field is a choice.';
        }
        case 'yesno': return 'The next field is a yes or no question. Say yes or no.';
        default: return 'The next field. What should I put here?';
      }
    }

    switch (intent) {
      case 'email':    return `What's your email address?`;
      case 'password': return `What's your ${L}? ${pause(300)}You may prefer to type this one.`;
      case 'phone':    return `What's your ${L}?`;
      case 'postal':   return `What's your ${L}?`;
      case 'dob':      return `What's your date of birth?`;
      case 'date':     return `What's the ${L}?`;
      case 'time':     return `What's the ${L}?`;
      case 'city':     return `Which city?`;
      case 'state':    return `Which ${L}?`;
      case 'country':  return `Which country?`;
      case 'address':  return `What's your ${L}?`;
      case 'idnumber': return `What's your ${L}?`;
      case 'amount':   return `What's the ${L}?`;
      case 'age':      return `What's your ${L}?`;
      case 'quantity': return `How many? ${pause(300)}This is ${L}.`;
      case 'url':      return `What's your ${L}?`;
      case 'company':  return `What's your ${L}?`;
      case 'jobtitle': return `What's your ${L}?`;
      case 'name':     return `What's your ${L}?`;
      case 'number':   return `What's your ${L}?`;
      case 'search':   return `What would you like to ${/search/i.test(labelRaw) ? 'search for' : 'find'}?`;
      case 'file':     return `${labelRaw} needs a file. ${pause(300)}Say skip to move on - files can't be filled by voice.`;
      case 'color':    return `${labelRaw} is a colour picker. ${pause(300)}Say skip to move on.`;
      case 'comment':  return `${labelRaw}. ${pause(300)}What would you like to say?`;

      case 'yesno':
        return `${labelRaw}? ${pause(300)}Say yes or no.`;

      case 'choice': {
        const o = speakOptions(field.options);
        if (!o.total) return `What's your ${L}?`;
        const tail = o.truncated
          ? ` ${pause(400)}And ${o.total - MAX_SPOKEN_OPTIONS} more. ${pause(300)}Say the one you want, or say list to hear them all.`
          : '';
        return `${labelRaw}. ${pause(300)}Choose one: ${pause(300)}${o.text}.${tail}`;
      }

      case 'multichoice': {
        const o = speakOptions(field.options);
        if (!o.total) return `${labelRaw}. What applies?`;
        const tail = o.truncated
          ? ` ${pause(400)}And ${o.total - MAX_SPOKEN_OPTIONS} more.`
          : '';
        return `${labelRaw}. ${pause(300)}Which of these apply? ${pause(300)}${o.text}.${tail} ${pause(300)}Say the ones you want.`;
      }

      default:
        return `What's your ${L}?`;
    }
  }

  /** Spoken on session start (PRD F4.6 in spirit; cheap and it orients the user). */
  function summaryFor(fields) {
    const n = fields.length;
    const req = fields.filter(f => f.required).length;
    if (n === 0) return `I couldn't find any fields to fill on this page.`;
    const fieldWord = n === 1 ? 'field' : 'fields';
    return req
      ? `This form has ${n} ${fieldWord}, ${req} required. ${pause(300)}Starting now.`
      : `This form has ${n} ${fieldWord}. ${pause(300)}Starting now.`;
  }

  const positionFor = (i, n) => `Field ${i + 1} of ${n}.`;

  function setPauseEnabled(v) { pauseEnabled = !!v; }
  function getPauseEnabled() { return pauseEnabled; }

  /**
   * Guard used by the harness: any `<...>` left in text that will be sent with
   * pauseBetweenBrackets disabled would be read out character by character.
   */
  function hasBareBrackets(text) { return /<\d+>/.test(text || ''); }

  return {
    classify, promptFor, summaryFor, positionFor, speakOptions,
    setPauseEnabled, getPauseEnabled, hasBareBrackets,
    MAX_SPOKEN_OPTIONS, LABEL_RULES,
  };
})();
