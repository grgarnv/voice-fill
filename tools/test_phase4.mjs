// Phase 4 robustness, the parts that are pure functions (PRD F4.1, F4.3-F4.6).
//
// Dates from speech, mask translation, quantifiers over an option list, and the
// rejection explainer. No browser: these are the rules, and they are the half
// of Phase 4 that can be wrong silently. The DOM half - dependent selects,
// wizard steps, custom controls, controlled inputs - is tools/test_phase4_form.mjs.
//
// The shared files are eval'd exactly as the extension loads them, so there is
// one implementation and no second copy to drift.
//
//   node tools/test_phase4.mjs
import fs from 'node:fs';
import vm from 'node:vm';

const ctx = vm.createContext({ console, setTimeout, clearTimeout, Promise, Date });
ctx.globalThis = ctx;
for (const f of ['extension/shared/normalize.js', 'extension/shared/domwrite.js', 'extension/shared/prompts.js']) {
  vm.runInContext(fs.readFileSync(f, 'utf8'), ctx, { filename: f });
}
const N = ctx.VFNormalize;
const D = ctx.VFDomWrite;
const P = ctx.VFPrompts;

const results = [];
let group = '';
const G = (g) => { group = g; };
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  results.push({ group, name, ok, got, want });
  return ok;
};
const ok = (name, cond, detail = '') => {
  results.push({ group, name, ok: !!cond, got: detail, want: 'true' });
  return !!cond;
};

/** A stand-in element: the writer only ever reads attributes off it. */
const el = (attrs = {}) => ({
  tagName: 'INPUT',
  getAttribute: (k) => (k in attrs ? attrs[k] : null),
  id: attrs.id || '',
});

/* ===================== F4.4  natural spoken dates ======================== */
G('F4.4 relative dates');
// Sunday, 6 September 2026. Fixed, so the suite is not a race against midnight.
const TODAY = new Date(2026, 8, 6);
const rel = (t) => N.parseRelativeDate(t, TODAY);

eq('today', rel('today'), '2026-09-06');
eq('tomorrow', rel('tomorrow'), '2026-09-07');
eq('yesterday', rel('yesterday'), '2026-09-05');
eq('the day after tomorrow', rel('the day after tomorrow'), '2026-09-08');
eq('the day before yesterday', rel('the day before yesterday'), '2026-09-04');
eq('in three days', rel('in three days'), '2026-09-09');
eq('in 10 days', rel('in 10 days'), '2026-09-16');
eq('two weeks from now', rel('two weeks from now'), '2026-09-20');
eq('in a month', rel('in a month'), '2026-10-06');
eq('in two years', rel('in two years'), '2028-09-06');
// "next week" names a WEEK, not a day. "a week from today" names a day.
eq('"next week" is refused - it names a week, not a day', rel('next week'), null);
eq('"a week from today" does name a day', rel('a week from today'), '2026-09-13');
eq('a hedged phrase is refused', rel('sometime next week'), null);
eq('...however plausible it looks', rel('maybe tomorrow'), null);
eq('next friday', rel('next friday'), '2026-09-11');
eq('this saturday', rel('this saturday'), '2026-09-12');
eq('last tuesday', rel('last tuesday'), '2026-09-01');
// A weekday named on its own is genuinely ambiguous - which side of today? -
// and a wrong appointment date is expensive. It must NOT be guessed at.
eq('a bare weekday is refused, not guessed', rel('friday'), null);
eq('a bare "the fifth" is refused', rel('the fifth'), null);

G('F4.4 spoken and written dates');
eq('14 June 2026', N.parseDate('the fourteenth of June two thousand twenty six'), '2026-06-14');
eq('June 14th 2026', N.parseDate('June 14th 2026'), '2026-06-14');
eq('day-first slashes', N.parseDate('14/06/2026'), '2026-06-14');
eq('unambiguous month-first', N.parseDate('06/25/2026'), '2026-06-25');
eq('ISO passes through', N.parseDate('2026-06-14'), '2026-06-14');
eq('a two-digit year', N.parseDate('14/06/94'), '1994-06-14');
eq('relative dates reach parseDate too', N.parseDate('tomorrow', { today: TODAY }), '2026-09-07');

G('F4.4 a date with no year fails safely');
eq('"March fifth" is not a date', N.parseDate('march fifth'), null);
ok('...and is reported as a MISSING YEAR, not as unintelligible',
   N.isMonthDayWithoutYear('march fifth') === true);
ok('...so the extraction asks for the year',
   /no year/i.test(N.fromSpeech('march fifth', {}, 'date').note || ''),
   N.fromSpeech('march fifth', {}, 'date').note);
ok('gibberish is still reported as unintelligible, not as a missing year',
   !N.isMonthDayWithoutYear('purple monkey dishwasher')
   && /could not read/i.test(N.fromSpeech('purple monkey dishwasher', {}, 'date').note || ''));
eq('nothing is written either way', N.fromSpeech('march fifth', {}, 'date').value, null);

/* ===================== F4.5  masked inputs =============================== */
G('F4.5 recognising a mask');
eq('a phone sample is a mask', D.maskOf(el({ placeholder: '(555) 555-5555' })), '(###) ###-####');
eq('a dashed phone sample', D.maskOf(el({ placeholder: '555-555-5555' })), '###-###-####');
eq('a date template', D.maskOf(el({ placeholder: 'MM/DD/YYYY' })), '##/##/####');
eq('underscores', D.maskOf(el({ placeholder: '___-__-____' })), '###-##-####');
eq('explicit slots keep their literals', D.maskOf(el({ placeholder: '+1 (###) ###-####' })), '+1 (###) ###-####');
eq('data-mask beats placeholder', D.maskOf(el({ 'data-mask': '###-###', placeholder: 'anything' })), '###-###');
// A hint is not a format. Treating "Your phone number" as a mask silently
// mangles the value into "Y", which is the worst possible outcome: it looks
// like it worked.
eq('a worded hint is not a mask', D.maskOf(el({ placeholder: 'Your phone number' })), null);
eq('an example VALUE is not a mask', D.maskOf(el({ placeholder: 'SW1A 2AA' })), null);
eq('an e.g. hint is not a mask', D.maskOf(el({ placeholder: 'e.g. AB12 3CD' })), null);
eq('an email sample is not a mask', D.maskOf(el({ placeholder: 'name@example.com' })), null);
eq('no placeholder, no mask', D.maskOf(el({})), null);

G('F4.5 pouring a value into a mask');
eq('a phone', D.applyMask('5551234567', '(###) ###-####'), '(555) 123-4567');
eq('a national id', D.applyMask('123456789', '###-##-####'), '123-45-6789');
// A half-filled or over-filled mask is a plausible-looking wrong value, and a
// wrong value that reads back as if it were right is this product's one
// unrecoverable failure. It fits exactly or it does not fit.
eq('too few characters does not half-fill the mask', D.applyMask('555', '(###) ###-####'), null);
eq('too many characters is refused outright', D.applyMask('55512345678901', '(###) ###-####'), null);

G('F4.5 the session value -> what this element accepts');
eq('digits into a phone mask', D.formatForField('5551234567', 'tel', el({ placeholder: '(555) 555-5555' })), '(555) 123-4567');
eq('ISO into a US date mask', D.formatForField('2026-06-14', 'text', el({ placeholder: 'MM/DD/YYYY' })), '06/14/2026');
eq('ISO into a day-first mask', D.formatForField('2026-06-14', 'text', el({ placeholder: 'DD/MM/YYYY' })), '14/06/2026');
eq('ISO into a dotted two-digit-year mask', D.formatForField('2026-06-14', 'text', el({ placeholder: 'DD.MM.YY' })), '14.06.26');
eq('a native date input takes ISO unchanged', D.formatForField('2026-06-14', 'date', el({})), '2026-06-14');
eq('a month input takes YYYY-MM', D.formatForField('2026-06-14', 'month', el({})), '2026-06');
eq('a week input takes an ISO week', D.formatForField('2026-06-14', 'week', el({})), '2026-W24');
eq('a datetime-local input takes a time too', D.formatForField('2026-06-14', 'datetime-local', el({})), '2026-06-14T00:00');
// A value that does not fit the stated mask goes in RAW so the page's own
// validation refuses it, rather than being trimmed into something acceptable.
eq('a value that does not fit the mask is not trimmed to fit',
   D.formatForField('55512', 'tel', el({ placeholder: '(555) 555-5555' })), '55512');
eq('no mask, no change', D.formatForField('Arnav', 'text', el({})), 'Arnav');
eq('an empty value stays empty', D.formatForField('', 'tel', el({ placeholder: '(555) 555-5555' })), '');

/* ===================== F4.6  checkbox and radio groups =================== */
G('F4.6 spoken selection over a group');
const EXTRAS = [{ value: 'insurance', text: 'Insurance' }, { value: 'tracking', text: 'Tracking' },
                { value: 'signature', text: 'Signature on delivery' }];
const multi = (t) => N.fromSpeech(t, { options: EXTRAS }, 'multichoice');
eq('one named option', multi('tracking').value, ['tracking']);
eq('two joined by "and"', multi('insurance and tracking').value, ['insurance', 'tracking']);
eq('a comma list', multi('insurance, signature on delivery').value, ['insurance', 'signature']);
eq('"all of them" takes every option', multi('all of them').value, ['insurance', 'tracking', 'signature']);
eq('"everything" too', multi('everything').value, ['insurance', 'tracking', 'signature']);
eq('"none of the above" selects nothing', multi('none of the above').value, []);
eq('"none" alone', multi('none').value, []);
ok('a selection of nothing is still read back before it counts', multi('none').needsConfirmation === true);
eq('an option that is not offered matches nothing', multi('gift wrapping').value, null);

const SPEED = [{ value: 'standard', text: 'Standard' }, { value: 'express', text: 'Express' },
               { value: 'overnight', text: 'Overnight' }];
const one = (t) => N.fromSpeech(t, { options: SPEED }, 'choice');
eq('a radio group by its label', one('express').value, 'express');
eq('...case and padding do not matter', one('  Overnight  ').value, 'overnight');
eq('an unoffered answer is refused', one('by carrier pigeon').value, null);

/* ===================== F4.3  explaining a rejection ====================== */
G('F4.3 the field types Phase 4 adds are classified');
eq('a custom select is a choice', P.classify({ type: 'combobox', label: 'Support plan' }), 'choice');
eq('a custom radio group is a choice', P.classify({ type: 'aria-radiogroup', label: 'Billing tier' }), 'choice');
eq('a custom checkbox group is a multichoice', P.classify({ type: 'aria-checkboxgroup', label: 'Contact channels' }), 'multichoice');
eq('a custom switch is a yes or no', P.classify({ type: 'aria-checkbox', label: 'Marketing emails' }), 'yesno');
eq('a month input is still a date', P.classify({ type: 'month', label: 'Expiry' }), 'date');

/* ============================== report ================================== */
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
fs.writeFileSync('artifacts/phase4_rules.json', JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
process.exit(fail.length ? 1 : 0);
