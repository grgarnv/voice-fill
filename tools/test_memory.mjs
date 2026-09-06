// Personal voice memory + natural correction, attacked in Node.
//
// Same files the offscreen document loads, run as classic scripts, so there is
// one implementation of the spelling assembler, the casing operations, the
// learning gate and the profile. The provider is a stub: what is asserted here
// is what the SYSTEM does, including what it does when a model says something
// wrong, malformed, or hostile.
//
//   node tools/test_memory.mjs
import fs from 'node:fs';
import vm from 'node:vm';

const ctx = vm.createContext({ console, performance, setTimeout, clearTimeout, Date, Promise, JSON, Math, Number, String, Array, Object, Set, Map, RegExp, Error });
ctx.globalThis = ctx;
for (const f of ['extension/shared/normalize.js', 'extension/shared/session-core.js',
                 'extension/shared/memory.js', 'extension/shared/intent.js']) {
  vm.runInContext(fs.readFileSync(f, 'utf8'), ctx, { filename: f });
}
const C = ctx.VFSessionCore, N = ctx.VFNormalize, I = ctx.VFIntent, M = ctx.VFMemory;
const deps = { parseCommand: N.parseCommand, parseYesNo: N.parseYesNo, fromSpeech: N.fromSpeech, matchOption: N.matchOption };

const results = [];
let group = '';
const G = (g) => { group = g; };
const ok = (name, pass, detail = '') => { results.push({ group, name, pass: !!pass, detail: String(detail).slice(0, 220) }); };
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

/* ---------------------------------------------------------------- fixtures */

const opt = (...labels) => labels.map(l => ({ value: l.toLowerCase().replace(/\W+/g, '_'), text: l }));
const SYMPTOMS = opt('Fever', 'Cough', 'Headache', 'Nausea');

const fields = {
  first:    { id: 'text/first', label: 'First name', type: 'text' },
  full:     { id: 'text/full', label: 'Full name', type: 'text' },
  email:    { id: 'email/email', label: 'Email address', type: 'email' },
  code:     { id: 'text/code', label: 'Reference number', type: 'text' },
  college:  { id: 'text/college', label: 'Institute', type: 'text' },
  city:     { id: 'text/city', label: 'City', type: 'text' },
  postcode: { id: 'text/postcode', label: 'Postal code', type: 'text' },
  symptoms: { id: 'checkboxgroup/symptoms', label: 'Which symptoms apply?', type: 'checkboxgroup', options: SYMPTOMS },
  pin:      { id: 'password/pin', label: 'PIN', type: 'password' },
};
const INTENTS = {
  'text/first': 'name', 'text/full': 'name', 'email/email': 'email', 'text/code': 'idnumber',
  'text/college': 'freetext', 'text/city': 'city', 'text/postcode': 'postal',
  'checkboxgroup/symptoms': 'multichoice', 'password/pin': 'pin',
};
const intentOf = (f) => INTENTS[f.id];

/** One turn, exactly as player.js runs it: resumePolicy, then the layer. */
async function turn({ field, transcript, pending = null, profile = null, model = null,
                      providerFails = false, currentValue = null }) {
  const intent = intentOf(field);
  const opts = field.options ?? [];
  const binding = { epoch: 1, fieldId: field.id, source: 'vad', captureId: 1, interrupted: null,
                    pendingKey: pending ? `${pending.fieldId}:${pending.value}` : null };
  const pctx = { transcript, binding, epoch: 1, pending, field, intent, options: opts, heardText: '' };
  const deterministic = C.resumePolicy(deps, pctx);
  let asked = null;
  const layer = await I.consult(deterministic, {
    ...pctx, interrupted: false, state: pending ? 'CONFIRMING' : 'TRANSCRIBING', turnId: 7, ledger: [], profile,
    field: { ...field, currentValue: pending?.value ?? currentValue },
  }, {
    optionsHeard: C.optionsHeard,
    stillCurrent: () => null,
    askProvider: async (context) => {
      asked = context;
      if (providerFails) return { ok: false, error: 'timeout' };
      const out = typeof model === 'function' ? model(context) : model;
      return out == null ? { ok: false, error: 'no provider' } : { ok: true, intent: out, ms: 42 };
    },
    metric: () => {},
  });
  return { deterministic, decision: layer || deterministic, replaced: !!layer, askedContext: asked };
}

const valueOf = (r) => r.decision.ex?.value ?? null;

/* ============================================================== spelling === */

G('spelling - one word, every natural phrasing');
{
  for (const t of [
    'spell it A R N A V',
    "it's spelled A R N A V",
    "I'll spell that for you, A R N A V",
    'the spelling is A R N A V',
    "that's A, R, N, A, V",
    'no, Arnav — A R N A V',
    'Arnav, spelled A-R-N-A-V',
  ]) {
    const r = await turn({ field: fields.first, transcript: t, model: null });
    eq(`"${t}"`, valueOf(r), 'Arnav');
    ok(`"${t}" needed no provider`, r.askedContext === null, `asked=${!!r.askedContext}`);
  }
  const r = await turn({ field: fields.first, transcript: 'spell it A R N A V', model: null });
  ok('the letters are not written as literal text', !/[- ]/.test(String(valueOf(r))), valueOf(r));
  ok('...and it is still read back before it counts', r.decision.ex?.needsConfirmation === true);
  ok('...marked as deterministic assembly, not a model', r.decision.via === 'spelling', r.decision.via);
}

G('spelling - a full name, component by component');
{
  for (const t of [
    'My full name is Arnav Garg. Arnav is spelled A R N A V and Garg is G A R G.',
    'Arnav Garg. A R N A V, G A R G.',
    'Arnav is A R N A V and Garg is G A R G.',
    'First name Arnav, spelled A R N A V. Last name Garg, G A R G.',
    'Arnav A R N A V, Garg G A R G.',
    'My name is Arnav Garg, A R N A V, G A R G.',
    'Arnav Garg. Arnav is A-R-N-A-V, Garg is G-A-R-G.',
  ]) {
    const r = await turn({ field: fields.full, transcript: t, model: null });
    eq(`"${t.slice(0, 52)}..."`, valueOf(r), 'Arnav Garg');
  }
  // The failure the PRD names by name.
  const r = await turn({ field: fields.full, transcript: 'My full name is Arnav Garg. Arnav is spelled A R N A V and Garg is G A R G.', model: null });
  ok('the value is not doubled', String(valueOf(r)).split(/\s+/).length === 2, valueOf(r));
  ok('...and the deterministic table alone would have written the letters as words',
     /A R N A V/i.test(String(r.deterministic.ex?.value ?? '')), r.deterministic.ex?.value);
}

G('spelling - partial: only one component spelled');
{
  const r = await turn({ field: fields.full, transcript: 'Arnav Garg, Garg is G A R G', model: null });
  eq('the unspelled word is left alone', valueOf(r), 'Arnav Garg');
  const r2 = await turn({ field: fields.full, transcript: 'Arnav Garg, and Garg is G A R J', model: null });
  eq('the spelled word is replaced by the letters', valueOf(r2), 'Arnav Garj');
}

G('spelling - the letters win over what the recogniser heard');
{
  // The headline case: STT returned "Enough" for "Arnav" and the person spells
  // it. Whatever the transcript says the name is, the letters are the value.
  const pending = { value: 'Enough', fieldId: fields.first.id, intent: 'name', spoken: 'Enough' };
  for (const t of ["No, it's Arnav. Spell it A R N A V.", 'No, spell it A R N A V', "no it's enough, A R N A V"]) {
    const r = await turn({ field: fields.first, transcript: t, pending, model: null });
    eq(`"${t}"`, valueOf(r), 'Arnav');
    ok(`"${t}" is a correction, not a fresh answer`, r.decision.action === 'correction', r.decision.action);
  }
}

G('spelling - field semantics decide the case of an assembled word');
{
  eq('a name field title-cases it', valueOf(await turn({ field: fields.first, transcript: 'spell it A R N A V' })), 'Arnav');
  eq('a free-text field title-cases it too', valueOf(await turn({ field: fields.college, transcript: 'spell it A R N A V' })), 'Arnav');
  // An explicit instruction beats the field default in both directions.
  eq('...unless told otherwise (upper)', valueOf(await turn({ field: fields.first, transcript: 'spell it A R N A V, all caps' })), 'ARNAV');
  eq('...unless told otherwise (lower)', valueOf(await turn({ field: fields.first, transcript: "It's Arnav, A R N A V, and make it lowercase." })), 'arnav');
}

G('spelling - the parsers that already own spelled input keep it');
{
  // normalize.js assembles letters and NATO anchors for an id field and turns
  // "a r n a v at gmail dot com" into an address for an email one. A second
  // assembler over the top of a working one is how both stop working.
  ok('an id field is left to wordsToAlphanumeric', M.SPELL_SKIP.has('idnumber'));
  ok('an email field is left to parseEmail', M.SPELL_SKIP.has('email'));
  const r = await turn({ field: fields.email, transcript: 'A R N A V at gmail dot com', model: null });
  eq('...and it still produces an address', valueOf(r), 'arnav@gmail.com');
  const c = await turn({ field: fields.code, transcript: 'B D 8 P M 3', model: null });
  eq('...and an id still assembles', valueOf(c), 'BD8PM3');
}

/* ================================================================ casing === */

G('casing - uppercase, every natural phrasing');
{
  const cur = 'Arnav Garg';
  for (const t of ['make it all caps', 'all uppercase', 'uppercase that', 'put it in capital letters',
                   'make everything uppercase', 'put it in capitals', 'make that all caps']) {
    const r = await turn({ field: fields.full, transcript: t, currentValue: cur, model: null });
    eq(`"${t}"`, valueOf(r), 'ARNAV GARG');
    ok(`"${t}" needed no provider`, r.askedContext === null);
  }
}

G('casing - lowercase');
{
  for (const t of ['make it all lowercase', 'all lowercase', 'lowercase that', 'make everything lowercase']) {
    const r = await turn({ field: fields.full, transcript: t, currentValue: 'Arnav Garg', model: null });
    eq(`"${t}"`, valueOf(r), 'arnav garg');
  }
}

G('casing - capitalisation of components');
{
  const lower = 'arnav garg';
  eq('"capitalize the first letter"', valueOf(await turn({ field: fields.full, transcript: 'capitalize the first letter', currentValue: lower })), 'Arnav garg');
  eq('"capitalize both words"', valueOf(await turn({ field: fields.full, transcript: 'capitalize both words', currentValue: lower })), 'Arnav Garg');
  eq('"capitalize my name"', valueOf(await turn({ field: fields.full, transcript: 'capitalize my name', currentValue: lower })), 'Arnav Garg');
  eq('"capitalize both names"', valueOf(await turn({ field: fields.full, transcript: 'capitalize both names', currentValue: lower })), 'Arnav Garg');
  eq('"first name normal case, last name all caps"',
     valueOf(await turn({ field: fields.full, transcript: 'first name normal case, last name all caps', currentValue: lower })), 'Arnav GARG');
  eq('"keep the surname uppercase"',
     valueOf(await turn({ field: fields.full, transcript: 'keep the surname uppercase', currentValue: 'Arnav Garg' })), 'Arnav GARG');
  eq('"the first name is capital A, lowercase rnav"',
     valueOf(await turn({ field: fields.first, transcript: 'the first name is capital A, lowercase rnav' })), 'Arnav');
}

G('casing - the value can arrive in the same breath');
{
  eq('"Arnav Garg, all uppercase"', valueOf(await turn({ field: fields.full, transcript: 'Arnav Garg, all uppercase' })), 'ARNAV GARG');
  eq('"Arnav Garg, all caps"', valueOf(await turn({ field: fields.full, transcript: 'Arnav Garg, all caps' })), 'ARNAV GARG');
  eq('"Arnav Garg, all lowercase"', valueOf(await turn({ field: fields.full, transcript: 'Arnav Garg, all lowercase' })), 'arnav garg');
  eq('"Arnav Garg all uppercase" (no comma)', valueOf(await turn({ field: fields.full, transcript: 'Arnav Garg all uppercase' })), 'ARNAV GARG');
  eq('"it\'s all caps: IIT"', valueOf(await turn({ field: fields.college, transcript: "it's all caps: IIT" })), 'IIT');
}

G('casing - field-aware: it may not corrupt a field that has no case');
{
  const pending = { value: '160071', fieldId: fields.postcode.id, intent: 'postal', spoken: '160071' };
  const r = await turn({ field: fields.postcode, transcript: 'make it all caps', pending, model: null });
  ok('a digit field asks instead of mangling the number', r.decision.action === 'clarify', JSON.stringify(r.decision));
  ok('...and writes nothing', !['answer', 'correction'].includes(r.decision.action), r.decision.action);

  const c = await turn({ field: fields.symptoms, transcript: 'make that all caps', currentValue: 'fever', model: null });
  ok('a choice field asks: its value must stay an option', c.decision.action === 'clarify', JSON.stringify(c.decision));

  const e = await turn({ field: fields.email, transcript: 'make it all caps',
                         pending: { value: 'arnav@gmail.com', fieldId: fields.email.id, intent: 'email', spoken: 'arnav at gmail dot com' }, model: null });
  ok('uppercasing an email address asks rather than doing it', e.decision.action === 'clarify', JSON.stringify(e.decision));
  eq('...but lowercase is the canonical form and is applied',
     M.resolveUtterance('make it all lowercase', { intent: 'email', currentValue: 'Arnav@Gmail.com' })?.value, 'arnav@gmail.com');
}

G('casing - nothing to change yet');
{
  const r = await turn({ field: fields.full, transcript: 'make it all caps', model: null });
  ok('an empty field asks what to put in', r.decision.action === 'clarify', JSON.stringify(r.decision));
}

/* ================================================== spelling + casing ===== */

G('spelling and casing in one utterance, applied in order');
{
  eq('"...and make the whole thing uppercase"',
     valueOf(await turn({ field: fields.full, transcript: 'My name is Arnav Garg. Arnav is spelled A R N A V, Garg is G A R G, and make the whole thing uppercase.' })),
     'ARNAV GARG');
  eq('"It\'s Arnav, A R N A V, and make it lowercase."',
     valueOf(await turn({ field: fields.first, transcript: "It's Arnav, A R N A V, and make it lowercase." })), 'arnav');
  eq('"...but keep Garg capitalized normally"',
     valueOf(await turn({ field: fields.full, transcript: 'Arnav Garg, spell Arnav A R N A V, but keep Garg capitalized normally' })), 'Arnav Garg');
  const r = await turn({ field: fields.full, transcript: 'Arnav Garg, A R N A V, G A R G, all caps' });
  ok('the combined path is marked as such', r.decision.via === 'spelling+casing', r.decision.via);
}

/* ============================================== positional corrections ==== */

G('partial corrections - single and multi character');
{
  const cases = [
    ['the last digit is two', '160071', '160072'],
    ['No, the last digit is two', '160071', '160072'],
    ['the first letter is A', 'Ernav', 'Arnav'],
    ['the second letter is R', 'Banav', 'BRnav'],
    ['change the third digit to 7', '160071', '167071'],
    ['the last two digits should be 42', '9876543210', '9876543242'],
    ['the last two digits are four two', '9876543210', '9876543242'],
  ];
  for (const [t, cur, want] of cases) eq(`"${t}" on ${cur}`, I.editByPosition(t, cur), want);

  const pending = { value: '160071', fieldId: fields.postcode.id, intent: 'postal', spoken: '160071' };
  const r = await turn({ field: fields.postcode, transcript: 'No, the last digit is two', pending, model: null });
  eq('the whole corrected value results', [r.decision.action, valueOf(r)], ['correction', '160072']);
  ok('...with no provider call at all', r.askedContext === null);
}

G('partial corrections - impossible or ambiguous ones ask');
{
  const pending = { value: 'Arnav', fieldId: fields.first.id, intent: 'name', spoken: 'Arnav' };
  const r = await turn({ field: fields.first, transcript: 'the seventh letter is A', pending, model: null });
  ok('"the seventh letter" of five asks', r.decision.action === 'clarify', JSON.stringify(r.decision));
  ok('...and says how many there are', /5/.test(r.decision.question || ''), r.decision.question);

  const post = { value: '160071', fieldId: fields.postcode.id, intent: 'postal', spoken: '160071' };
  const r2 = await turn({ field: fields.postcode, transcript: 'change the third digit', pending: post, model: null });
  ok('"change the third digit" to WHAT asks', r2.decision.action === 'clarify', JSON.stringify(r2.decision));
  ok('...and never writes the fragment the table extracted',
     !['answer', 'correction'].includes(r2.decision.action), JSON.stringify(r2.decision));

  const r3 = await turn({ field: fields.postcode, transcript: 'everything is right except the last digit', pending: post, model: null });
  ok('"everything is right except the last digit" asks what it should be', r3.decision.action === 'clarify', JSON.stringify(r3.decision));

  // Refusals must not become answers even with the provider down.
  const down = await turn({ field: fields.first, transcript: 'the seventh letter is A', pending, providerFails: true });
  ok('...and the same holds with the provider down', down.decision.action === 'clarify', JSON.stringify(down.decision));
}

G('conflicting spellings are a question, not a guess');
{
  const r = await turn({ field: fields.first, transcript: 'Arnav is A R N A V and Arnav is A R N O V', model: null });
  ok('two spellings of one word asks', r.decision.action === 'clarify', JSON.stringify(r.decision));
  ok('...and writes nothing', !['answer', 'correction'].includes(r.decision.action));
}

/* =============================================== personal voice memory ==== */

G('the learning gate - what may be remembered');
{
  const p0 = M.emptyProfile();
  const r = M.learn(p0, { observed: 'Enough.', canonical: 'Arnav', context: 'name' });
  ok('a confirmed name correction is remembered', r.learned, JSON.stringify(r));
  eq('...normalised for later matching', r.profile.corrections[0].observed, 'enough');
  eq('...and the canonical becomes personal vocabulary', r.profile.vocabulary[0].canonical, 'Arnav');

  const refusals = [
    ['a digit field is not learnable', { observed: 'one six zero', canonical: '160071', context: 'postal' }],
    ['a PIN is not learnable', { observed: 'four eight two one', canonical: '4821', context: 'pin' }],
    ['an email is not learnable', { observed: 'arnav at gmail', canonical: 'arnav@gmail.com', context: 'email' }],
    ['an address is not learnable', { observed: 'twelve high street', canonical: '12 High Street', context: 'address' }],
    ['a comment box is not learnable', { observed: 'blah', canonical: 'Some feedback', context: 'comment' }],
    ['a value with digits in it is refused', { observed: 'flat two', canonical: 'Flat 2', context: 'name' }],
    ['a value with an @ in it is refused', { observed: 'x', canonical: 'a@b', context: 'name' }],
    ['a sentence is not vocabulary', { observed: 'x', canonical: 'the quick brown fox jumped', context: 'name' }],
    ['a 200-char value is refused', { observed: 'x', canonical: 'A'.repeat(200), context: 'name' }],
    ['"no" as an observation is refused', { observed: 'no', canonical: 'Arnav', context: 'name' }],
    ['"yes" as an observation is refused', { observed: 'yes', canonical: 'Arnav', context: 'name' }],
    ['"skip" as an observation is refused', { observed: 'skip', canonical: 'Arnav', context: 'name' }],
    ['an observation equal to the value teaches nothing', { observed: 'Arnav', canonical: 'Arnav', context: 'name' }],
    ['an empty observation is refused', { observed: '   ', canonical: 'Arnav', context: 'name' }],
    ['an empty value is refused', { observed: 'enough', canonical: '', context: 'name' }],
    ['no context is refused', { observed: 'enough', canonical: 'Arnav' }],
  ];
  for (const [name, args] of refusals) {
    const rr = M.learn(M.emptyProfile(), args);
    ok(name, !rr.learned, `learned, why=${rr.why}`);
    ok(`${name} - and nothing was written`, rr.profile.corrections.length === 0);
  }
  const again = M.learn(r.profile, { observed: 'enough', canonical: 'Arnav', context: 'name' });
  eq('the same correction twice is one entry', again.profile.corrections.length, 1);
  eq('...with a count', again.profile.corrections[0].n, 2);
}

G('a learned correction fires - and only in its own context');
{
  const p = M.learn(M.emptyProfile(), { observed: 'Enough.', canonical: 'Arnav', context: 'name' }).profile;

  const hit = await turn({ field: fields.first, transcript: 'Enough.', profile: p, model: null });
  eq('"Enough." on a name field becomes Arnav', valueOf(hit), 'Arnav');
  ok('...marked as memory, not as a model', hit.decision.via === 'memory', hit.decision.via);
  ok('...and is still read back before it counts', hit.decision.ex?.needsConfirmation === true);
  ok('...without any provider call', hit.askedContext === null);

  // The failure mode the PRD names: a global replacement.
  const sentence = await turn({ field: fields.college, transcript: 'How much is enough?', profile: p, model: null });
  ok('"How much is enough?" is NOT turned into Arnav', !/Arnav/.test(String(valueOf(sentence))), valueOf(sentence));
  const other = await turn({ field: fields.city, transcript: 'Enough.', profile: p, model: null });
  ok('"Enough." in a CITY field is not the name either', valueOf(other) !== 'Arnav', valueOf(other));
  const substring = await turn({ field: fields.first, transcript: 'Enough already', profile: p, model: null });
  ok('a partial match does not fire - the whole utterance must match', valueOf(substring) !== 'Arnav', valueOf(substring));

  // Sensitive fields are not reachable by memory at all.
  const pin = await turn({ field: fields.pin, transcript: 'Enough.', profile: p,
                           pending: { value: '4821', fieldId: fields.pin.id, intent: 'pin', spoken: '4821' }, model: null });
  ok('a password field is never touched by the profile', valueOf(pin) !== 'Arnav', JSON.stringify(pin.decision));
}

G('a learned correction is a candidate, never an override');
{
  // A remembered value that the field cannot hold is not written just because
  // it was remembered. The deterministic validator stays the authority.
  const bad = M.emptyProfile();
  bad.corrections.push({ observed: 'enough', canonical: 'Arnav', context: 'name', n: 1, at: Date.now() });
  const asDigits = await turn({ field: fields.postcode, transcript: 'Enough.', profile: bad, model: null });
  ok('a name in a digit field is not written', valueOf(asDigits) !== 'Arnav', valueOf(asDigits));

  const notAnOption = M.emptyProfile();
  notAnOption.corrections.push({ observed: 'fiver', canonical: 'Arnav', context: 'name', n: 1, at: Date.now() });
  const r = await turn({ field: fields.symptoms, transcript: 'fiver', profile: notAnOption, model: null });
  ok('a remembered value is not forced onto a choice field', valueOf(r) !== 'Arnav', JSON.stringify(r.decision));
}

G('personal vocabulary reaches the provider as a hint, and only then');
{
  const p = M.learn(M.emptyProfile(), { observed: 'Karen Jane', canonical: 'Karan Jain', context: 'name' }).profile;
  eq('vocabulary is listed for its own context', M.vocabularyFor(p, 'name'), ['Karan Jain']);
  eq('...and is empty for any other', M.vocabularyFor(p, 'city'), []);

  const withVocab = I.buildContext({ field: fields.first, intent: 'name', options: [], pending: null,
                                     transcript: 'the other one', state: 'LISTENING', turnId: 7, epoch: 1, profile: p });
  eq('the context carries it', withVocab.known_values, ['Karan Jain']);
  const empty = I.buildContext({ field: fields.first, intent: 'name', options: [], pending: null,
                                 transcript: 'x', state: 'LISTENING', turnId: 7, epoch: 1, profile: M.emptyProfile() });
  ok('an empty profile adds no key at all', !('known_values' in empty), JSON.stringify(Object.keys(empty)));
  ok('...and neither does no profile', !('known_values' in I.buildContext({ field: fields.first, intent: 'name', options: [], pending: null, transcript: 'x', state: 'LISTENING', turnId: 7, epoch: 1 })));
}

G('a corrupted or hostile profile cannot break a turn');
{
  const junk = [null, undefined, 42, 'a string', [], { v: 99 }, { corrections: 'not an array' },
                { corrections: [null, 7, {}, { observed: 'x' }] },
                { corrections: [{ observed: 'x', canonical: 'y', context: 'password' }] },
                { corrections: [{ observed: 'x', canonical: '<script>', context: 'name' }] },
                { vocabulary: [{ canonical: 'A'.repeat(5000), context: 'name' }] },
                { pronunciations: [{ canonical: 'x' }] }];
  for (const j of junk) {
    const p = M.sanitize(j);
    ok(`sanitize(${String(JSON.stringify(j)).slice(0, 40)}) yields a usable profile`,
       Array.isArray(p.corrections) && Array.isArray(p.vocabulary) && Array.isArray(p.pronunciations));
    const r = await turn({ field: fields.first, transcript: 'Arnav', profile: p, model: null });
    ok(`...and the turn still resolves`, r.decision.action === 'answer', JSON.stringify(r.decision).slice(0, 120));
  }
  eq('a correction in a non-learnable context is dropped on load',
     M.sanitize({ corrections: [{ observed: 'x', canonical: 'y', context: 'password' }] }).corrections.length, 0);
  const dup = M.sanitize({ corrections: Array(500).fill({ observed: 'x', canonical: 'y', context: 'name' }) });
  ok('a 500-entry profile is capped', dup.corrections.length <= 200, String(dup.corrections.length));
}

/* ========================================== model-supplied structure ====== */

G('the model expresses spelling as structure, never as a string');
{
  const base = { field: fields.full, intent: 'name', options: [], heardOptionValues: [], pending: null, turnId: 7 };
  const m = { intent: 'ANSWER_FIELD', confidence: 0.9, needs_clarification: false,
              arguments: { value: 'Arnav Garg', spelling: [{ word: 'Arnav', letters: ['A', 'R', 'N', 'A', 'V'] },
                                                           { word: 'Garg', letters: ['G', 'A', 'R', 'G'] }] } };
  const v = I.validateIntent(m, base);
  eq('structured spelling is assembled deterministically', v.decision?.ex?.value, 'Arnav Garg');

  const up = I.validateIntent({ ...m, arguments: { ...m.arguments, case: 'UPPER' } }, base);
  eq('...and the case operation is applied after it', up.decision?.ex?.value, 'ARNAV GARG');

  const pureCase = I.validateIntent({ intent: 'CORRECT_VALUE', confidence: 1, needs_clarification: false, arguments: { case: 'UPPER' } },
                                    { ...base, pending: { value: 'Arnav Garg', fieldId: fields.full.id, intent: 'name' } });
  eq('a formatting-only intent operates on what is already there', pureCase.decision?.ex?.value, 'ARNAV GARG');
  eq('...as a correction', pureCase.decision?.action, 'correction');

  const nothing = I.validateIntent({ intent: 'ANSWER_FIELD', confidence: 1, needs_clarification: false, arguments: { case: 'UPPER' } }, base);
  ok('a formatting-only intent with nothing to format is rejected', !nothing.ok && nothing.why === 'no-value', JSON.stringify(nothing));
}

G('adversarial - malformed structure from the model is dropped, not repaired');
{
  const base = { field: fields.full, intent: 'name', options: [], heardOptionValues: [], pending: null, turnId: 7 };
  const bad = [
    ['spelling that is a string', { value: 'Arnav', spelling: 'A R N A V' }],
    ['spelling that is an object', { value: 'Arnav', spelling: { letters: ['A'] } }],
    ['an entry with no letters', { value: 'Arnav', spelling: [{ word: 'Arnav' }] }],
    ['letters that are words', { value: 'Arnav', spelling: [{ word: 'Arnav', letters: ['Alpha', 'Romeo'] }] }],
    ['letters that are markup', { value: 'Arnav', spelling: [{ word: 'Arnav', letters: ['<', 's'] }] }],
    ['letters that are numbers', { value: 'Arnav', spelling: [{ word: 'Arnav', letters: [1, 2, 3] }] }],
    ['a 500-letter component', { value: 'Arnav', spelling: [{ word: 'Arnav', letters: Array(500).fill('A') }] }],
    ['forty components', { value: 'Arnav', spelling: Array(40).fill({ word: 'x', letters: ['A'] }) }],
  ];
  for (const [name, args] of bad) {
    const v = I.validateIntent({ intent: 'ANSWER_FIELD', confidence: 1, needs_clarification: false, arguments: args }, base);
    ok(`${name} -> the spelling is ignored, the value stands`, v.ok && v.decision.ex.value === 'Arnav', JSON.stringify(v).slice(0, 140));
  }
  for (const c of ['SHOUT', 'upper', 42, {}, [], null, 'DROP TABLE']) {
    const v = I.validateIntent({ intent: 'ANSWER_FIELD', confidence: 1, needs_clarification: false,
                                 arguments: { value: 'Arnav Garg', case: c } }, base);
    const want = c === 'upper' ? 'ARNAV GARG' : 'Arnav Garg';   // case-insensitive enum, everything else ignored
    ok(`case ${JSON.stringify(c)} -> ${want}`, v.ok && v.decision.ex.value === want, JSON.stringify(v).slice(0, 140));
  }
  const onDigits = I.validateIntent({ intent: 'CORRECT_VALUE', confidence: 1, needs_clarification: false,
                                      arguments: { value: '160071', case: 'UPPER' } },
                                    { field: fields.postcode, intent: 'postal', options: [], heardOptionValues: [],
                                      pending: { value: '160071', fieldId: fields.postcode.id }, turnId: 7 });
  ok('a case operation on a digit field is rejected outright',
     !onDigits.ok && onDigits.why === 'formatting-not-applicable', JSON.stringify(onDigits));
}

G('adversarial - spelling cannot invent a value the field will not take');
{
  const digits = I.validateIntent({ intent: 'ANSWER_FIELD', confidence: 1, needs_clarification: false,
                                    arguments: { value: '160071', spelling: [{ word: '160071', letters: ['A', 'B', 'C'] }] } },
                                  { field: fields.postcode, intent: 'postal', options: [], heardOptionValues: [], pending: null, turnId: 7 });
  ok('spelling is ignored on a digit field - its own parser owns spelled input',
     digits.ok && digits.decision.ex.value === '160071', JSON.stringify(digits).slice(0, 140));
  const opt2 = I.validateIntent({ intent: 'ANSWER_FIELD', confidence: 1, needs_clarification: false,
                                  arguments: { value: 'Fever', spelling: [{ word: 'Fever', letters: ['D', 'I', 'Z', 'Z', 'Y'] }] } },
                                { field: fields.symptoms, intent: 'multichoice', options: SYMPTOMS,
                                  heardOptionValues: SYMPTOMS.map(o => o.value), pending: null, turnId: 7 });
  ok('a spelled non-option is rejected', !opt2.ok && opt2.why === 'value-not-an-option', JSON.stringify(opt2));
  const markup = M.applyStructured('Arnav', { spelling: [{ word: 'Arnav', letters: ['A'] }] }, 'name');
  ok('assembly never emits markup', !/[<>{}]/.test(markup.value || ''), JSON.stringify(markup));
}

G('adversarial - false positives the layer must NOT claim');
{
  for (const [t, why] of [
    ["it's a T shirt", 'two stray single letters are not a spelling'],
    ['I want a b', 'nor are two more'],
    ['Capital Region', 'a value containing "capital" is not a casing instruction'],
    ['Caps Lock Key', 'nor is a value containing "caps"'],
    ['Upper Street', 'nor one containing "upper"'],
    ['yes', 'a confirmation is not formatting'],
    ['no, the last digit is two', 'a positional edit is not formatting'],
    ['fever and cough', 'an option list is not formatting'],
    ['skip', 'a command is not formatting'],
  ]) ok(`${why}: "${t}"`, !M.hasFormatting(t), 'claimed');
  for (const t of ['spell it A R N A V', 'A R N A V', 'make it all caps', 'lowercase that']) {
    ok(`...but "${t}" is`, M.hasFormatting(t));
  }
  // A stray letter run in a value the field cannot hold must not be written.
  const r = await turn({ field: fields.postcode, transcript: 'A R N A V',
                         pending: { value: '160071', fieldId: fields.postcode.id, intent: 'postal', spoken: '160071' }, model: null });
  ok('spelled letters into a postcode are not written', !['answer', 'correction'].includes(r.decision.action) || !/[A-Z]/.test(String(valueOf(r))),
     JSON.stringify(r.decision));
  // A positional edit on a CHOICE field can produce a string that is no longer
  // any option. valueShapeError says nothing about membership, so this went
  // straight through until the audit; shapeValue is what closes it.
  const c = await turn({ field: fields.symptoms, transcript: 'the last letter is X', currentValue: 'fever', model: null });
  ok('a positional edit that leaves the option list is not written as a value',
     !/fevex/i.test(JSON.stringify(valueOf(c) ?? '')), JSON.stringify(c.decision).slice(0, 160));
  ok('...and nothing off the option list reaches a decision at all',
     !['answer', 'correction'].includes(c.decision.action) ||
     [].concat(valueOf(c) ?? []).every(v => SYMPTOMS.some(o => o.value === v)), JSON.stringify(c.decision).slice(0, 160));
}

G('adversarial - the router still stays out of the way');
{
  const skipped = [];
  for (const [t, f, pending] of [
    ['yes', fields.first, { value: 'Arnav', fieldId: fields.first.id, intent: 'name', spoken: 'Arnav' }],
    ['no', fields.first, { value: 'Arnav', fieldId: fields.first.id, intent: 'name', spoken: 'Arnav' }],
    ['repeat', fields.first, null],
    ['skip', fields.first, null],
    ['Arnav', fields.first, null],
    ['Bengaluru', fields.city, null],
  ]) {
    const r = await turn({ field: f, transcript: t, pending, profile: M.emptyProfile(), model: { intent: 'REPEAT', confidence: 1, needs_clarification: false } });
    if (r.askedContext === null) skipped.push(t);
  }
  eq('an ordinary utterance with a profile loaded still costs no provider call', skipped.length, 6);
}

/* ============================================= Rime pronunciation ========= */

G('pronunciation - a user dictionary layered over the global one');
{
  N.setNamePhonemes({ siobhan: 'ʃɪˈvɔn' });
  N.setUserPronunciations(M.pronunciationMap(M.sanitize({
    pronunciations: [{ canonical: 'Arnav', phonemes: 'ˈɑːrnəv' }, { canonical: 'Garg', respell: 'gurg' }],
  })));

  N.setPhonemesEnabled(true);
  eq('a user phoneme entry is braced for phonemizeBetweenBrackets', N.speakName('Arnav'), '{ˈɑːrnəv}');
  eq('the global dictionary still applies', N.speakName('Siobhan'), '{ʃɪˈvɔn}');
  eq('an unknown name is spoken as written', N.speakName('Smith'), 'Smith');
  eq('mixed', N.speakName('Arnav Garg'), '{ˈɑːrnəv} gurg');

  // Coda ignores phonemizeBetweenBrackets, so braces would be READ OUT. The
  // proxy reports the flag and the respelling is what is used instead.
  N.setPhonemesEnabled(false);
  eq('with phonemes unavailable, no braces are emitted', N.speakName('Arnav'), 'Arnav');
  eq('...and a respelling still works, because it is ordinary text', N.speakName('Garg'), 'gurg');
  ok('...so nothing can leak "{...}" into speech', !/[{}]/.test(N.speakName('Arnav Garg Siobhan')), N.speakName('Arnav Garg Siobhan'));

  N.setPhonemesEnabled(true); N.setNamePhonemes({}); N.setUserPronunciations({});
}

/* =========================================== structural / privacy ========= */

G('structural - nothing here can reach the DOM or the state machine');
{
  const src = fs.readFileSync('extension/shared/memory.js', 'utf8');
  ok('memory.js contains no DOM access', !/document\.|querySelector|\.click\(|innerHTML|eval\(/.test(src));
  ok('memory.js contains no extension APIs', !/chrome\.[a-z]/.test(src));
  ok('memory.js contains no network access', !/fetch\(|XMLHttpRequest|WebSocket/.test(src));
  ok('memory.js contains no storage access', !/localStorage|indexedDB|chrome\.storage/.test(src));

  // Every action the new paths can produce is one the core already executes.
  const allowed = new Set(['answer', 'correction', 'accept', 'reject', 'command', 'clarify', 'drop']);
  const seen = new Set();
  for (const [f, t, pending] of [
    [fields.first, 'spell it A R N A V', null],
    [fields.full, 'make it all caps', { value: 'Arnav Garg', fieldId: fields.full.id, intent: 'name', spoken: 'Arnav Garg' }],
    [fields.postcode, 'make it all caps', { value: '160071', fieldId: fields.postcode.id, intent: 'postal', spoken: '160071' }],
    [fields.first, 'the seventh letter is A', { value: 'Arnav', fieldId: fields.first.id, intent: 'name', spoken: 'Arnav' }],
  ]) seen.add((await turn({ field: f, transcript: t, pending, model: null })).decision.action);
  ok('every producible action is in the existing vocabulary', [...seen].every(a => allowed.has(a)), [...seen].join(','));
}

G('privacy - what a profile may contain');
{
  const p = M.emptyProfile();
  // Walk a realistic session's worth of confirmed values through the gate and
  // see what survives. Only vocabulary should.
  const offered = [
    ['name', 'Arnav'], ['name', 'Karan Jain'], ['city', 'Bengaluru'], ['company', 'Acme Ltd'],
    ['postal', '160071'], ['pin', '4821'], ['phone', '9876543210'], ['email', 'arnav@gmail.com'],
    ['dob', '1998-04-12'], ['amount', '250'], ['idnumber', 'BD8PM3'], ['address', '12 High Street'],
    ['password', 'hunter2'], ['comment', 'I have had a headache since Tuesday'],
  ];
  let cur = p;
  const kept = [];
  for (const [context, canonical] of offered) {
    const r = M.learn(cur, { observed: `heard ${canonical}`, canonical, context });
    cur = r.profile;
    if (r.learned) kept.push(canonical);
  }
  eq('only personal vocabulary is persisted', kept, ['Arnav', 'Karan Jain', 'Bengaluru', 'Acme Ltd']);
  // The stored strings only - counts and timestamps are bookkeeping.
  const stored = JSON.stringify([...cur.vocabulary.map(v => v.canonical), ...cur.corrections.map(c => [c.observed, c.canonical])]);
  ok('no digits reached the profile', !/\d/.test(stored), stored.slice(0, 200));
  ok('no email address reached the profile', !/@/.test(stored));
  ok('no medical free text reached the profile', !/headache/i.test(stored));
  ok('no password reached the profile', !/hunter/i.test(stored));
}

/* ============================================ live provider (optional) ==== */
//
// The deterministic assembler covers every spelling phrasing in the corpus
// above, so a live run is NOT a measurement of the common path - it is a
// measurement of the FALLBACK: what the model does with the structured
// `spelling` and `case` fields for phrasings the assembler declines (a NATO
// alphabet read-back, a two-letter spelling with no cue, a bare formatting
// instruction). What is scored is the SYSTEM's outcome after validateIntent,
// never the model's raw reply.
//
//   MEMORY_LIVE=1 node tools/test_memory.mjs      (needs the backend running)
if (process.env.MEMORY_LIVE === '1') {
  G('live provider - structured spelling and casing');
  // Imported here rather than at the top: the pure corpus must not depend on a
  // .env existing at all, and this branch is the only thing that needs one.
  const { loadEnv } = await import('../scripts/probe/lib/env.mjs');
  loadEnv();
  const url = process.env.VF_INTENT_URL || 'http://localhost:8787/intent';
  const token = process.env.PROXY_TOKEN || '';
  const ask = async (context) => {
    const t0 = Date.now();
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-vf-token': token }, body: JSON.stringify(context) });
      const j = await r.json();
      return { ...j, wallMs: Date.now() - t0 };
    } catch (e) { return { ok: false, error: String(e.message), wallMs: Date.now() - t0 }; }
  };

  const LIVE = [
    // [field, transcript, pending, expected value]
    [fields.full, 'Arnav Garg. Arnav is A as in Alpha, R as in Romeo, N as in November, A as in Alpha, V as in Victor.', null, 'Arnav Garg'],
    [fields.first, "it's Jo, J O", null, 'Jo'],
    [fields.full, 'make that all caps', { value: 'Arnav Garg', fieldId: fields.full.id, intent: 'name', spoken: 'Arnav Garg' }, 'ARNAV GARG'],
    [fields.full, 'put the surname in capitals', { value: 'Arnav Garg', fieldId: fields.full.id, intent: 'name', spoken: 'Arnav Garg' }, null],
  ];
  const lat = [], said = [];
  for (const [field, transcript, pending, want] of LIVE) {
    const intent = intentOf(field);
    const context = I.buildContext({
      field: { ...field, currentValue: pending?.value ?? null }, intent, options: field.options || [],
      heardOptionValues: [], pending, transcript, state: pending ? 'CONFIRMING' : 'LISTENING',
      turnId: 7, epoch: 1, ledger: [], interrupted: false, profile: null,
    });
    const r = await ask(context);
    lat.push(r.wallMs);
    const v = r.ok && r.intent ? I.validateIntent(r.intent, { field, intent, options: field.options || [], heardOptionValues: [], pending, turnId: 7 }) : null;
    const got = v?.ok ? v.decision.ex?.value : (v ? `rejected:${v.why}` : `provider:${r.error}`);
    said.push({ transcript, modelIntent: r.intent?.intent ?? null, spelling: r.intent?.arguments?.spelling ?? null,
                case: r.intent?.arguments?.case ?? null, got, ms: r.wallMs });
    if (want === null) {
      ok(`"${transcript}" -> a usable outcome, whatever it is`, !!v, JSON.stringify(got));
    } else {
      ok(`"${transcript}" -> ${want}`, got === want, JSON.stringify(got));
    }
  }
  if (lat.length) {
    const q = [...lat].sort((a, b) => a - b);
    ok(`provider latency p50 ${q[Math.floor(q.length / 2)]}ms max ${q[q.length - 1]}ms`, true);
  }
  fs.mkdirSync('artifacts', { recursive: true });
  fs.writeFileSync('artifacts/memory_live.json', JSON.stringify({ at: new Date().toISOString(), latencyMs: lat, turns: said }, null, 2));
}

/* ------------------------------------------------------------------ report */

let last = '';
let pass = 0, fail = 0;
for (const r of results) {
  if (r.group !== last) { console.log(`\n  ${r.group}`); last = r.group; }
  console.log(`    ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : '   ' + r.detail}`);
  r.pass ? pass++ : fail++;
}
console.log(`\n  PASS ${pass}   FAIL ${fail}\n`);
fs.mkdirSync('artifacts', { recursive: true });
fs.writeFileSync('artifacts/memory_corpus.json', JSON.stringify({ at: new Date().toISOString(), pass, fail, results }, null, 2));
process.exit(fail ? 1 : 0);
