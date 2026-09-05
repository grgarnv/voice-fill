// Normalisation and extraction tests (PRD F2.3 / F2.5).
//
// These are pure functions, so they run in Node with no browser. The file is
// loaded the same way the extension loads it - as a classic script into a
// global - so there is one implementation and no second copy to drift.
//
// The read-back claim is the centre of this product: a user who cannot see the
// screen has only the spoken value to verify against. Every branch of toSpeech
// is exercised, and so is the reverse direction, because STT returns the same
// utterance in several different shapes.
import fs from 'node:fs';
import vm from 'node:vm';

const ctx = vm.createContext({ console });
ctx.globalThis = ctx;
for (const f of ['extension/shared/normalize.js']) {
  vm.runInContext(fs.readFileSync(f, 'utf8'), ctx, { filename: f });
}
const N = ctx.VFNormalize;

const results = [];
let group = '';
const G = (g) => { group = g; };
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  results.push({ group, name, ok, got, want });
  return ok;
};
const truthy = (name, got, note = '') => {
  results.push({ group, name, ok: !!got, got, want: `truthy ${note}` });
  return !!got;
};

/* ======================= value -> speech (read-back) ====================== */

G('spellDigits');
// Pairs, chosen by measurement: 10/10 through the real round trip against
// 9/10 for triples. See PHASE2.md.
eq('PIN grouped in pairs with a pause', N.spellDigits('160071'),
   'one six, <300> zero zero, <300> seven one');
eq('four digits', N.spellDigits('4821'), 'four eight two one');
eq('zero is "zero", never "oh"', N.spellDigits('0'), 'zero');
eq('non-digits stripped first', N.spellDigits('SW1A 2AA'), 'one two');
eq('empty is empty', N.spellDigits(''), '');

G('spellAlphanumeric');
eq('letters anchored to NATO, digits plain', N.spellAlphanumeric('SF7K'),
   'S as in Sierra, <250> F as in Foxtrot, <250> seven, <250> K as in Kilo');
eq('confusable pair both anchored', N.spellAlphanumeric('BD'),
   'B as in Bravo, <250> D as in Delta');
eq('dash is spoken', N.spellAlphanumeric('A-1'),
   'A as in Alpha, <250> dash, <250> one');
eq('lowercase is upcased for the anchor', N.spellAlphanumeric('q'), 'Q as in Quebec');

G('speakPhone');
// 3-3-4 for phones, pairs for short codes - both chosen by measurement.
eq('10 digits as 3-3-4', N.speakPhone('5551234567'),
   'five five five, <300> one two three, <300> four five six seven');
eq('11 digits keeps the leading digit alone', N.speakPhone('15551234567'),
   'one, <300> five five five, <300> one two three, <300> four five six seven');
eq('formatting stripped first', N.speakPhone('(555) 123-4567'),
   'five five five, <300> one two three, <300> four five six seven');

G('speakDate');
// Month first: measured cleanest through real STT of five candidate forms.
eq('ISO to spoken, month first', N.speakDate('2026-06-14'),
   'June fourteenth, <200> two thousand twenty six');
eq('ordinal special case', N.speakDate('2026-06-01'),
   'June first, <200> two thousand twenty six');
eq('twelfth', N.speakDate('1999-12-12'), 'December twelfth, <200> nineteen ninety nine');
eq('non-ISO passes through', N.speakDate('nonsense'), 'nonsense');

G('speakYear / speakNumber');
eq('2000', N.speakYear(2000), 'two thousand');
eq('2007', N.speakYear(2007), 'two thousand seven');
eq('2026', N.speakYear(2026), 'two thousand twenty six');
eq('1984', N.speakYear(1984), 'nineteen eighty four');
eq('1900', N.speakYear(1900), 'nineteen hundred');
eq('42', N.speakNumber(42), 'forty two');
eq('17', N.speakNumber(17), 'seventeen');
eq('105', N.speakNumber(105), 'one hundred and five');

G('speakEmail / speakAmount');
truthy('email spells the local part and says the domain',
  /at,/.test(N.speakEmail('jo.smith@example.com')) && /example dot com/.test(N.speakEmail('jo.smith@example.com')));
eq('whole amount', N.speakAmount('250'), 'two hundred and fifty');
eq('amount with pence', N.speakAmount('12.50'), 'twelve point five zero');
eq('currency symbol stripped', N.speakAmount('£99'), 'ninety nine');

G('speakName with a phoneme dictionary');
N.setNamePhonemes({ siobhan: 'ʃɪˈvɔn' });
truthy('known name is wrapped in braces for phonemizeBetweenBrackets',
  N.speakName('Siobhan') === '{ʃɪˈvɔn}');
eq('unknown name falls back to the raw word, which is correct not an error',
   N.speakName('Smith'), 'Smith');
eq('mixed', N.speakName('Siobhan Smith'), '{ʃɪˈvɔn} Smith');
N.setNamePhonemes({});

G('toSpeech dispatch');
eq('postal', N.toSpeech('160071', 'postal'), 'one six, <300> zero zero, <300> seven one');
eq('idnumber', N.toSpeech('A1', 'idnumber'), 'A as in Alpha, <250> one');
eq('yesno true', N.toSpeech('true', 'yesno'), 'yes');
eq('free text is read as written', N.toSpeech('Flat 2, Elm Road', 'freetext'), 'Flat 2, Elm Road');
truthy('a bare alphanumeric code is spelled even without an intent',
  /as in/.test(N.toSpeech('SF7K0B', 'freetext')));

G('pause tokens obey the connection flag');
N.setPauseEnabled(false);
eq('no bracket tokens leak when the flag is off', N.spellDigits('160071'),
   'one six, zero zero, seven one');
truthy('no <nnn> anywhere', !/<\d+>/.test(N.toSpeech('2026-06-14', 'date')));
N.setPauseEnabled(true);

/* ======================= speech -> value (extraction) ==================== */

G('wordsToDigits - the shapes STT actually returns');
eq('digit words', N.wordsToDigits('one six zero zero seven one'), '160071');
eq('already numeric', N.wordsToDigits('160071'), '160071');
eq('grouped numerals', N.wordsToDigits('160 071'), '160071');
eq('compound numbers', N.wordsToDigits('sixteen zero zero seventy one'), '16007 1'.replace(' ', ''));
eq('"oh" for zero', N.wordsToDigits('one six oh oh seven one'), '160071');
eq('"double" expands', N.wordsToDigits('one six double zero seven one'), '160071');
eq('"triple"', N.wordsToDigits('triple eight'), '888');
eq('twenty three', N.wordsToDigits('twenty three'), '23');
eq('filler words ignored', N.wordsToDigits('um it is four two'), '42');
eq('nothing numeric', N.wordsToDigits('hello there'), '');

G('wordsToAlphanumeric');
eq('NATO anchors', N.wordsToAlphanumeric('S as in Sierra F as in Foxtrot seven'), 'SF7');
eq('"B for Bravo" form', N.wordsToAlphanumeric('B for Bravo two'), 'B2');
eq('bare NATO words', N.wordsToAlphanumeric('sierra foxtrot seven kilo'), 'SF7K');
eq('spelled letters', N.wordsToAlphanumeric('a b c'), 'ABC');
eq('dash', N.wordsToAlphanumeric('A dash one'), 'A-1');
eq('filler dropped', N.wordsToAlphanumeric('um the S as in Sierra'), 'S');
eq('anchor beats the bare letter when they disagree',
   N.wordsToAlphanumeric('B as in Delta'), 'D');
// The measured failure mode: every letter mangled, every anchor intact.
eq('a mangled letter before an intact anchor still resolves',
   N.wordsToAlphanumeric('Hugo is in Quebec, Ke is in Kilo, 5 2, T is in Tango, G is in Golf'), 'QK52TG');
eq('plural anchor', N.wordsToAlphanumeric('7 K as in kilos'), '7K');
eq('"as an" connective', N.wordsToAlphanumeric('X as an x-ray'), 'X');
eq('filler words never become letters',
   N.wordsToAlphanumeric('um it is an A as in Alpha'), 'A');
eq('bare NATO sequence keeps every letter',
   N.wordsToAlphanumeric('Bravo and Charlie'), 'BC');
eq('a run-together digit+letter token is split, not dropped',
   N.wordsToAlphanumeric('November 4X is an x-ray'), 'N4X');
// "eight" collides with the letter A. Among anchored letters, a bare A is the
// digit - measured twice on BD8PM3.
eq('a bare A among anchored letters is the digit eight',
   N.wordsToAlphanumeric('B as in Bravo, D as in Delta, A, P as in Papa, M as in Mike, 3'), 'BD8PM3');
eq('but an ANCHORED A stays the letter',
   N.wordsToAlphanumeric('A as in Alpha, one, B as in Bravo'), 'A1B');
eq('and plain spelling without anchors is untouched',
   N.wordsToAlphanumeric('a b c'), 'ABC');

G('parseYesNo');
eq('yes', N.parseYesNo('yes'), true);
eq('yeah', N.parseYesNo('yeah that is right'), true);
eq('no', N.parseYesNo('no'), false);
eq('negative phrasing', N.parseYesNo("no that's wrong"), false);
eq('correction is a no', N.parseYesNo('incorrect'), false);
eq('neither', N.parseYesNo('maybe later'), null);

G('parseDate');
eq('day month year', N.parseDate('14 June 2026'), '2026-06-14');
eq('month day year', N.parseDate('June 14th 2026'), '2026-06-14');
eq('slashes, day first', N.parseDate('14/06/2026'), '2026-06-14');
eq('unambiguous month first', N.parseDate('06/14/2026'), '2026-06-14');
eq('two digit year', N.parseDate('14/06/26'), '2026-06-14');
eq('ISO passthrough', N.parseDate('2026-06-14'), '2026-06-14');
eq('spoken year', N.parseDate('the fourteenth of June two thousand twenty six'), '2026-06-14');
eq('nineteen-something', N.parseDate('2 March nineteen eighty four'), '1984-03-02');
eq('not a date', N.parseDate('sometime next week'), null);

G('matchOption');
const OPTS = [{ value: 'sm', text: 'Small' }, { value: 'md', text: 'Medium' }, { value: 'lg', text: 'Large' }];
eq('exact', N.matchOption('small', OPTS).value, 'sm');
eq('case and punctuation insensitive', N.matchOption('Large!', OPTS).value, 'lg');
eq('within a sentence', N.matchOption('I would like a medium please', OPTS).value, 'md');
truthy('no match returns a null value rather than a wrong one',
  N.matchOption('aubergine', OPTS).value === null);
const CLOSE = [{ value: 'a', text: 'Manchester' }, { value: 'b', text: 'Winchester' }];
truthy('near-identical options are flagged ambiguous, not guessed',
  (() => { const m = N.matchOption('chester', CLOSE); return m.value === null || m.ambiguous; })());

G('parseCommand - a command is the whole utterance, not a prefix');
eq('repeat', N.parseCommand('repeat').command, 'repeat');
eq('say that again', N.parseCommand('say that again').command, 'repeat');
eq('next', N.parseCommand('next').command, 'next');
eq('go back', N.parseCommand('go back').command, 'previous');
eq('skip', N.parseCommand('skip').command, 'skip');
eq('what did you enter', N.parseCommand('what did you enter').command, 'readback');
truthy('an answer that begins with a command word is NOT a command',
  N.parseCommand('skip hire company limited') === null);
truthy('a long answer is not a command', N.parseCommand('next of kin is my sister') === null);
truthy('free text is not a command', N.parseCommand('Flat 2 Elm Road') === null);

/* ============================== fromSpeech =============================== */

G('fromSpeech by intent');
const F = (t, intent, field = {}) => N.fromSpeech(t, field, intent);
eq('postal digits', F('one six zero zero seven one', 'postal').value, '160071');
eq('postal needs confirmation', F('160071', 'postal').needsConfirmation, true);
eq('phone', F('five five five one two three four five six seven', 'phone').value, '5551234567');
truthy('too few digits for a phone is a failure, not a short number',
  F('five five five', 'phone').value === null);
eq('id number', F('S as in Sierra F as in Foxtrot seven kilo', 'idnumber').value, 'SF7K');
eq('email spoken', F('jo dot smith at example dot com', 'email').value, 'jo.smith@example.com');
eq('email already formatted', F('jo@example.com', 'email').value, 'jo@example.com');
truthy('email without an @ fails', F('jo smith', 'email').value === null);
eq('date', F('14 June 2026', 'dob').value, '2026-06-14');
eq('age', F('forty two', 'age').value, '42');
eq('amount', F('two hundred and fifty', 'amount').value, '250');
eq('name: lead-in stripped and trailing stop removed',
   F('My name is Alexandra Whitfield.', 'name').value, 'Alexandra Whitfield');
eq('name: "it\'s" lead-in', F("it's Ada Lovelace", 'name').value, 'Ada Lovelace');
eq('name: a bare name is untouched', F('Ada Lovelace', 'name').value, 'Ada Lovelace');
eq('yes', F('yes please', 'yesno').value, 'true');
eq('no', F('no', 'yesno').value, 'false');
truthy('unparseable yes/no fails rather than defaulting',
  F('possibly', 'yesno').value === null);
eq('choice', F('medium', 'choice', { options: OPTS }).value, 'md');
eq('multichoice splits on "and"',
   F('bacon and onion', 'multichoice',
     { options: [{ value: 'b', text: 'Bacon' }, { value: 'o', text: 'Onion' }, { value: 'c', text: 'Cheese' }] }).value,
   ['b', 'o']);
truthy('empty transcript never yields a value', F('', 'postal').value === null);

G('high-risk classification');
truthy('PIN is high risk', N.isHighRisk('postal') && N.isHighRisk('idnumber') && N.isHighRisk('phone'));
truthy('free text is not', !N.isHighRisk('freetext') && !N.isHighRisk('choice'));

/* ===================== round trip: the read-back claim ==================== */
//
// Simulates the STT step by stripping the pause tokens and feeding the spoken
// text straight back. That is optimistic about acoustics - the real number comes
// from tools/test_readback.mjs, which puts real Rime audio through real STT -
// but it proves the two directions are consistent, which is the part that is
// this file's job.

G('round trip toSpeech -> fromSpeech');
const RT = [
  ['160071', 'postal'], ['4821', 'postal'], ['SF7K0B2Q', 'idnumber'],
  ['A1B2C3', 'idnumber'], ['5551234567', 'phone'], ['2026-06-14', 'dob'],
  ['1984-03-02', 'dob'], ['42', 'age'],
];
for (const [value, intent] of RT) {
  const spoken = N.toSpeech(value, intent).replace(/<\d+>/g, ' ');
  const back = N.fromSpeech(spoken, {}, intent).value;
  eq(`${intent} ${value} survives the round trip`, back, value);
}

/* ================================= report ================================ */

const pass = results.filter(r => r.ok).length;
const fail = results.filter(r => !r.ok);
let last = '';
for (const r of results) {
  if (r.group !== last) { console.log(`\n  ${r.group}`); last = r.group; }
  console.log(`    ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
  if (!r.ok) {
    console.log(`          got:  ${JSON.stringify(r.got)}`);
    console.log(`          want: ${JSON.stringify(r.want)}`);
  }
}
console.log(`\n  PASS ${pass}   FAIL ${fail.length}\n`);
fs.mkdirSync('artifacts', { recursive: true });
fs.writeFileSync('artifacts/phase2_normalize.json', JSON.stringify({ results }, null, 2));
process.exit(fail.length ? 1 : 0);
