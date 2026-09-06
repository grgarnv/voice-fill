// Conversational navigation, attacked in Node.
//
// The same files the offscreen document loads, run as classic scripts, so
// there is one implementation of the parser, the field matcher and the
// resolver. Nothing here is mocked except the model, whose output is supplied
// per case: what these tests assert is what the SYSTEM does with it, which is
// the part that has to be safe.
//
// The session simulator below is the deterministic chain player.js runs -
// resumePolicy -> (layer) -> resolveNav -> move - over the same state the
// session holds (fields, index, trail, answered, filled). The real audio,
// barge-in and DOM path is covered by tools/test_navigation_form.mjs in a
// browser; what is covered HERE is which field a request resolves to and when
// it refuses to resolve one at all.
//
//   node tools/test_navigation.mjs
import fs from 'node:fs';
import vm from 'node:vm';

const ctx = vm.createContext({ console, performance, setTimeout, clearTimeout, Date, Promise, JSON, Math, Number, String, Array, Object, Set, Map, RegExp, Error });
ctx.globalThis = ctx;
for (const f of ['extension/shared/normalize.js', 'extension/shared/session-core.js', 'extension/shared/memory.js', 'extension/shared/intent.js']) {
  vm.runInContext(fs.readFileSync(f, 'utf8'), ctx, { filename: f });
}
const C = ctx.VFSessionCore, N = ctx.VFNormalize, I = ctx.VFIntent;
const deps = { parseCommand: N.parseCommand, parseYesNo: N.parseYesNo, fromSpeech: N.fromSpeech, matchOption: N.matchOption };

const results = [];
let group = '';
const G = (g) => { group = g; };
const ok = (name, pass, detail = '') => { results.push({ group, name, pass: !!pass, detail: String(detail).slice(0, 200) }); };
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

/* ---------------------------------------------------------------- fixtures */

const F = (id, label, name, type = 'text', extra = {}) => ({ id, label, name, type, options: [], ...extra });
const INTAKE = () => [
  F('text|first', 'First name', 'first'),
  F('text|last', 'Last name', 'last'),
  F('email|email', 'Email address', 'email', 'email'),
  F('tel|phone', 'Phone number', 'phone', 'tel'),
  F('text|street', 'Street address', 'street'),
  F('text|city', 'City', 'city'),
  F('select|state', 'State', 'state', 'select', { options: [{ value: 'ca', text: 'California' }, { value: 'ny', text: 'New York' }] }),
  F('date|dob', 'Date of birth', 'dob', 'date'),
];
const intentOf = (f) => ({ email: 'email', tel: 'phone', date: 'date', select: 'choice' }[f.type] || (/name/.test(f.name) ? 'name' : 'text'));

/**
 * The session, as the deterministic chain sees it. `say` runs one transcript
 * through exactly the path player.js runs it through.
 */
class Sim {
  constructor(fields = INTAKE(), { model = null } = {}) {
    this.fields = fields; this.index = 0; this.trail = []; this.labels = {};
    this.answered = {}; this.filled = {}; this.pending = null; this.epoch = 1;
    this.model = model; this.consulted = 0;
    this.visit();
  }
  get field() { return this.fields[this.index] || null; }
  visit() {
    const f = this.field; if (!f) return;
    this.labels[f.id] = f.label;
    if (this.trail[this.trail.length - 1] !== f.id) this.trail.push(f.id);
  }
  /** The page changed shape: a step, a branch, an inserted field. */
  setFields(fields) {
    const prevId = this.field?.id ?? null;
    this.fields = fields;
    const i = this.fields.findIndex(f => f.id === prevId);
    this.index = i >= 0 ? i : Math.min(this.index, this.fields.length - 1);
    for (const f of this.fields) this.labels[f.id] = f.label;
    this.visit();
  }
  answer(value) {                                   // a field answered and accepted
    const f = this.field; this.filled[f.id] = value; this.answered[f.id] = true;
    this.pending = null;
    if (this.index < this.fields.length - 1) { this.index++; this.visit(); }
  }
  skip() { if (this.index < this.fields.length - 1) { this.index++; this.visit(); } }
  confirm(value) { const f = this.field; this.filled[f.id] = value; this.answered[f.id] = true; this.pending = { value, fieldId: f.id, intent: intentOf(f), spoken: String(value) }; }

  async say(transcript, { binding = null } = {}) {
    const field = this.field;
    const intent = field ? intentOf(field) : null;
    const b = binding || { epoch: this.epoch, fieldId: field?.id ?? null, source: 'vad', captureId: 1, interrupted: null };
    const pctx = { transcript, binding: b, epoch: this.epoch, pending: this.pending, field, intent,
                   options: field?.options || [], heardText: b.interrupted?.heardText || '' };
    let decision = C.resumePolicy(deps, pctx);
    let asked = null;
    const layer = await I.consult(decision, {
      ...pctx, interrupted: !!b.interrupted, state: this.pending ? 'CONFIRMING' : 'TRANSCRIBING', turnId: 7, ledger: [],
      field: { ...field, currentValue: this.pending?.value ?? this.filled[field?.id] ?? null },
      fields: this.fields, answered: this.answered, index: this.index,
    }, {
      optionsHeard: C.optionsHeard, stillCurrent: () => null,
      askProvider: async (context) => {
        asked = context; this.consulted++;
        const out = typeof this.model === 'function' ? this.model(context) : this.model;
        return out ? { ok: true, intent: out, ms: 1 } : { ok: false, error: 'no provider' };
      },
      metric: () => {},
    });
    if (layer) decision = layer;
    const nav = decision.action === 'navigate' ? decision.nav
      : (decision.action === 'command' && ['previous', 'next'].includes(decision.command)
         ? { kind: 'relative', direction: decision.command === 'next' ? 'forward' : 'backward', count: 1 } : null);
    const out = { decision, asked, nav, moved: false, resolved: null };
    if (!nav) return out;
    const r = C.resolveNav(nav, { fields: this.fields, index: this.index, trail: this.trail,
                                  answered: this.answered, labels: this.labels });
    out.resolved = r;
    if (r.ok) {
      this.pending = null;                          // navigating away abandons the read-back
      this.index = r.index; this.visit(); out.moved = true;
      // navigation + correction: the trailing clause is applied to the field
      // landed on, shaped by the same check the spoken path uses.
      const follow = (typeof nav.correction === 'string' && nav.correction) || nav.rest || '';
      if (follow) {
        // The same function player.js calls, with the same arguments.
        const shaped = I.followValue(follow, {
          intent: intentOf(this.field), options: this.field.options || [],
          currentValue: this.filled[this.field.id] ?? null,
        });
        if (shaped) { out.correction = shaped.value; this.confirm(shaped.value); }
      }
    }
    out.label = this.field?.label ?? null;
    return out;
  }
}

/** Walk the session to a field by label, answering as it goes. */
const fill = (sim, values) => { for (const v of values) sim.answer(v); };

/* ================================================ 1. previous / next ====== */
G('previous and next, in the words people actually use');
{
  for (const t of ['go back', 'back', 'previous', 'go to the previous field', 'previous field',
                   'move back', 'the previous one', 'take me back', 'go back one field',
                   'actually, go back to the previous one', 'can you go back']) {
    const sim = new Sim(); fill(sim, ['Arnav', 'Garg', 'a@b.co']);   // now on Phone number
    const r = await sim.say(t);
    ok(`"${t}" -> the previous field`, r.moved && r.label === 'Email address', `${r.label} ${JSON.stringify(r.decision.action)}`);
    ok(`"${t}" cost no provider call`, r.asked === null, String(r.asked && Object.keys(r.asked)));
  }
  for (const t of ['go forward', 'next field', 'move forward one', 'next', 'go on to the next field']) {
    const sim = new Sim(); fill(sim, ['Arnav', 'Garg']);            // now on Email address
    const r = await sim.say(t);
    ok(`"${t}" -> the next field`, r.moved && r.label === 'Phone number', `${r.label}`);
  }
  {
    const sim = new Sim();
    const r = await sim.say('go back');
    ok('"go back" on the first field moves nothing', !r.moved && r.resolved.edge === 'start', JSON.stringify(r.resolved));
  }
}

/* ================================================ 2. relative navigation == */
G('relative navigation resolves deterministically, within bounds');
{
  const cases = [
    ['go back two fields', 'Last name'], ['go back two', 'Last name'], ['take me back two fields', 'Last name'],
    ['go back three', 'First name'], ['move back three fields', 'First name'],
    ['go forward two fields', null], ['move forward one', null],
  ];
  for (const [t, want] of cases) {
    const sim = new Sim(); fill(sim, ['Arnav', 'Garg', 'a@b.co']);  // on Phone number (index 3)
    const r = await sim.say(t);
    const expected = want ?? (t.includes('two') ? 'City' : 'Street address');
    ok(`"${t}" -> ${expected}`, r.moved && r.label === expected, `${r.label} ${JSON.stringify(r.nav)}`);
  }
  {
    const sim = new Sim(); fill(sim, ['Arnav']);                    // one field of history
    const r = await sim.say('go back four fields');
    ok('more fields back than exist: refuses and stays put', !r.moved && r.resolved.edge === 'start' && r.resolved.available === 1, JSON.stringify(r.resolved));
    ok('...and the pointer did not move', sim.field.label === 'Last name', sim.field.label);
  }
  {
    const sim = new Sim(); fill(sim, ['a', 'b', 'c', 'd', 'e', 'f', 'g']);  // last field
    const r = await sim.say('go forward three fields');
    ok('past the end: refuses and stays put', !r.moved && r.resolved.edge === 'end', JSON.stringify(r.resolved));
  }
  {
    const sim = new Sim();
    const r = await sim.say('go back a hundred fields');
    ok('an absurd count is not navigation at all', r.nav === null || !r.moved, JSON.stringify(r.nav));
  }
}

/* ============================================== 3. named field navigation = */
G('navigating to a named field, by any of its names');
{
  const cases = [
    ['go back to my first name', 'First name'],
    ['go to the email field', 'Email address'],
    ['take me back to my phone number', 'Phone number'],
    ['I want to change my address', 'Street address'],
    ['go to date of birth', 'Date of birth'],
    ['can you take me back to my email?', 'Email address'],
    ['I need to change the phone number I just entered', 'Phone number'],
    ['wait, I want to change my first name', 'First name'],
    ['I want to change what I entered for my phone number', 'Phone number'],
    ['take me back to the city', 'City'],
    ['go back to my surname', 'Last name'],
    ['take me to my mobile', 'Phone number'],
    ['go back to my birthday', 'Date of birth'],
    ['go to the state', 'State'],
    ['take me back to my street address', 'Street address'],
  ];
  for (const [t, want] of cases) {
    const sim = new Sim(); fill(sim, ['Arnav', 'Garg', 'a@b.co', '5551234', '1 Main St', 'Ely']);
    const r = await sim.say(t);
    ok(`"${t}" -> ${want}`, r.moved && r.label === want, `${r.label} ${JSON.stringify(r.nav)} ${JSON.stringify(r.resolved?.reason)}`);
  }
}

/* ============================================ 4. referential navigation === */
G('references into the conversation resolve against the visit history');
{
  const back = async (t, want, prep = (s) => fill(s, ['Arnav', 'Garg', 'a@b.co'])) => {
    const sim = new Sim(); prep(sim);
    const r = await sim.say(t);
    ok(`"${t}" -> ${want}`, r.moved && r.label === want, `${r.label} ${JSON.stringify(r.resolved)}`);
    return sim;
  };
  await back('go back to the one before that', 'Last name');       // on Phone: back two
  await back('take me to the field I just answered', 'Email address');
  await back('go back to the field I answered before this', 'Email address');
  await back('go back to the last field', 'Email address');
  await back('the previous one', 'Email address');
  await back('the one before my email', 'Last name');
  await back('go back to the one before my phone number', 'Email address');
  {
    const sim = new Sim();
    const r = await sim.say('take me to the field I just answered');
    ok('nothing answered yet: asks instead of moving', !r.moved && r.resolved.reason === 'nothing-answered', JSON.stringify(r.resolved));
  }
}

/* ======================================= 5. ambiguity and nonexistence ==== */
G('ambiguous or unknown targets ask, and never guess');
{
  const sim = new Sim(); fill(sim, ['Arnav', 'Garg', 'a@b.co']);
  const r = await sim.say('go back to my name');
  ok('"my name" over a first AND a last name is ambiguous', !r.moved && r.resolved.reason === 'ambiguous', JSON.stringify(r.resolved?.reason));
  eq('...and it names both candidates', (r.resolved.candidates || []).map(f => f.label), ['First name', 'Last name']);
  ok('...and nothing moved', sim.field.label === 'Phone number', sim.field.label);

  const sim2 = new Sim(); fill(sim2, ['Arnav']);
  const r2 = await sim2.say('go to my fax number');
  ok('a field the form does not have is refused', !r2.moved && r2.resolved.reason === 'no-such-field', JSON.stringify(r2.resolved));

  const sim3 = new Sim(); fill(sim3, ['Arnav']);
  const r3 = await sim3.say('take me back to my social security number');
  ok('...however plausible it sounds', !r3.moved, JSON.stringify(r3.resolved));

  // A single-name form: "my name" is no longer ambiguous.
  const sim4 = new Sim([F('text|name', 'Your name', 'name'), F('email|email', 'Email address', 'email', 'email')]);
  fill(sim4, ['Arnav']);
  const r4 = await sim4.say('go back to my name');
  ok('one name field: "my name" resolves', r4.moved && r4.label === 'Your name', `${r4.label} ${JSON.stringify(r4.resolved)}`);
}

/* ================================= 6. skipped, conditional, dynamic ====== */
G('the previous field is the previous field VISITED, not the previous DOM node');
{
  // The page inserts a conditional field between two the user has already met.
  const sim = new Sim();
  sim.answer('Arnav');                                   // First name -> Last name
  sim.answer('Garg');                                    // Last name  -> Email
  const withExtra = INTAKE();
  withExtra.splice(2, 0, F('text|middle', 'Middle name', 'middle'));
  sim.setFields(withExtra);                              // Middle name appears BEHIND the pointer
  const r = await sim.say('go back');
  ok('an inserted field the user never met is not "the previous field"', r.label === 'Last name', `${r.label}`);
  ok('...and the DOM index would have said Middle name', withExtra[sim.fields.findIndex(f => f.id === 'email|email') - 1].label === 'Middle name');

  // A skipped field IS somewhere they have been: it was asked.
  const sim2 = new Sim();
  sim2.answer('Arnav'); sim2.skip();                     // Last name skipped, on Email
  const r2 = await sim2.say('go back');
  ok('a field that was asked and skipped is still the previous field', r2.label === 'Last name', r2.label);
  ok('...and it is still empty', sim2.filled['text|last'] === undefined);

  // A conditional field that the page has since removed drops out of history.
  const sim3 = new Sim();
  fill(sim3, ['Arnav', 'Garg', 'a@b.co']);               // on Phone
  const pruned = INTAKE().filter(f => f.id !== 'email|email');
  sim3.setFields(pruned);
  const r3 = await sim3.say('go back');
  ok('a field the page removed is skipped over, not navigated to', r3.label === 'Last name', `${r3.label}`);

  // A dynamically added field at the end is reachable by name straight away.
  const sim4 = new Sim();
  fill(sim4, ['Arnav']);
  sim4.setFields([...INTAKE(), F('text|company', 'Company name', 'company')]);
  const r4 = await sim4.say('go to the company name');
  ok('a field the page added is reachable by name', r4.moved && r4.label === 'Company name', r4.label);
}

/* ========================================== 7. multi-step forms ========== */
G('multi-step: the session keeps the name, and refuses to guess a way back');
{
  const STEP1 = [F('text|first', 'First name', 'first'), F('email|email', 'Email address', 'email', 'email')];
  const STEP2 = [F('text|street', 'Street address', 'street'), F('text|city', 'City', 'city')];
  const sim = new Sim(STEP1);
  sim.answer('Arnav');                                   // -> Email
  sim.answer('a@b.co');
  sim.setFields(STEP2);                                  // the wizard advanced
  const r = await sim.say('take me back to my email');
  ok('a field on a previous step is not silently swapped for a visible one', !r.moved, `${r.label} ${JSON.stringify(r.resolved)}`);
  eq('...it says which field, and that it is off this step', [r.resolved.reason, r.resolved.label], ['off-step', 'Email address']);

  sim.setFields(STEP1);                                  // the page went back a step
  const r2 = await sim.say('take me back to my email');
  ok('once the step is on the page again, the same request resolves', r2.moved && r2.label === 'Email address', `${r2.label}`);
  eq('...and the value entered on that step is still there', sim.filled['email|email'], 'a@b.co');
}

/* ======================================= 8. existing values survive ====== */
G('going back does not erase');
{
  const sim = new Sim(); fill(sim, ['Arnav', 'Garg', 'a@b.co']);
  await sim.say('go back to my email');
  eq('the value is still in the session after navigating to it', sim.filled['email|email'], 'a@b.co');
  ok('...and the field is still marked answered', sim.answered['email|email'] === true);
  const r = await sim.say('actually, change it to arnav@example.com');
  eq('...and only an ordinary answer replaces it', sim.filled['email|email'], 'a@b.co');   // pending, not written
  ok('...which is read back before it counts', !!r.decision.ex || r.decision.action === 'answer', JSON.stringify(r.decision.action));
}

/* ================================= 9. navigation during confirmation ===== */
G('navigation outranks the confirmation flow');
{
  const cases = [
    ['no, go back to the previous field', 'Email address'],
    ['no no, go back to the previous field', 'Email address'],
    ["don't confirm that. take me back to my email", 'Email address'],
    ['no, take me back to my first name', 'First name'],
    ['wait, go back two fields', 'Last name'],
  ];
  for (const [t, want] of cases) {
    const sim = new Sim(); fill(sim, ['Arnav', 'Garg', 'a@b.co']);
    sim.confirm('5551234');                              // Phone is awaiting yes/no
    const r = await sim.say(t);
    ok(`"${t}" navigates rather than rejecting`, r.moved && r.label === want, `${r.label} ${r.decision.action}`);
    ok(`"${t}" leaves the value it was confirming in place`, sim.filled['tel|phone'] === '5551234', JSON.stringify(sim.filled['tel|phone']));
    ok(`"${t}" clears the pending confirmation`, sim.pending === null || sim.pending.fieldId !== 'tel|phone', JSON.stringify(sim.pending));
  }
  // The ordinary rejection is untouched.
  for (const t of ['no', 'nope', "that's wrong"]) {
    const sim = new Sim(); fill(sim, ['Arnav', 'Garg', 'a@b.co']); sim.confirm('5551234');
    const r = await sim.say(t);
    ok(`"${t}" is still a plain rejection`, r.decision.action === 'reject', r.decision.action);
  }
  {
    const sim = new Sim(); fill(sim, ['Arnav', 'Garg', 'a@b.co']); sim.confirm('5551234');
    const r = await sim.say('yes');
    ok('"yes" is still a plain acceptance', r.decision.action === 'accept', r.decision.action);
  }
}

/* ================================== 10. navigation carrying a correction = */
G('a move and a change in one breath');
{
  const sim = new Sim(); fill(sim, ['Arjun', 'Garg', 'a@b.co']);
  const r = await sim.say("take me back to my first name - it's actually Arnav");
  ok('it moved to the named field', r.moved && r.label === 'First name', r.label);
  eq('...and the correction was applied there, not to the field it left', sim.filled['text|first'], 'Arnav');
  eq('...and the field it left is untouched', sim.filled['tel|phone'], undefined);
  ok('...and it is pending confirmation, not silently accepted', sim.pending?.value === 'Arnav', JSON.stringify(sim.pending));

  const sim2 = new Sim(); fill(sim2, ['Arnav', 'Garg', 'a@b.co', '5551234']);
  const r2 = await sim2.say('go back to my phone number. The last digit is wrong.');
  ok('a complaint with no value in it just navigates', r2.moved && r2.label === 'Phone number', r2.label);
  eq('...and the value is left for the user to correct', sim2.filled['tel|phone'], '5551234');

  const sim3 = new Sim(); fill(sim3, ['Arnav', 'Garg', 'a@b.co']);
  const r3 = await sim3.say('go back two fields and change that answer');
  ok('"and change that answer" is not a value', r3.moved && r3.label === 'Last name', r3.label);
  eq('...nothing was written', sim3.filled['text|last'], 'Garg');

  // An instruction that arrives as its own clause is refused for the same
  // reason: fromSpeech would take the words themselves as the value.
  const sim4 = new Sim(); fill(sim4, ['Arnav', 'Garg', 'a@b.co']);
  await sim4.say('take me back to my last name. change that answer.');
  eq('an instruction clause writes nothing', sim4.filled['text|last'], 'Garg');
  ok('...but the move still happened', sim4.field.label === 'Last name', sim4.field.label);

  // Spelling rides along with a move, assembled by the same function the
  // spoken path uses - not written down as letters.
  const sim5 = new Sim(); fill(sim5, ['Arjun', 'Garg', 'a@b.co']);
  const r5 = await sim5.say("take me back to my first name - it's A R N A V");
  ok('a spelled correction carried by a move lands on the field', r5.moved && r5.label === 'First name', r5.label);
  eq('...assembled into a word, not the letters', sim5.filled['text|first'], 'Arnav');
  ok('...and read back before it counts', sim5.pending?.value === 'Arnav', JSON.stringify(sim5.pending));
}

/* ========================================= 11. barge-in and staleness ==== */
G('barge-in, stale turns, and the latest instruction winning');
{
  const sim = new Sim(); fill(sim, ['Arnav', 'Garg', 'a@b.co']);
  // A transcript bound to the field the user has already left. An ANSWER is
  // dropped as superseded; a navigation is about the session, so it survives.
  const stale = { epoch: 1, fieldId: 'text|first', source: 'vad', captureId: 2, interrupted: { turnId: 3, kind: 'prompt', heardText: 'What is your' } };
  const r = await sim.say('go back to my email', { binding: stale });
  ok('a navigation bound to an earlier field is not dropped', r.moved && r.label === 'Email address', `${r.label} ${r.decision.action}`);

  const sim2 = new Sim(); fill(sim2, ['Arnav']);
  const old = { epoch: 0, fieldId: 'text|first', source: 'vad', captureId: 3, interrupted: null };
  const r2 = await sim2.say('go back to my first name', { binding: old });
  eq('a navigation from a previous session epoch is still dropped', [r2.decision.action, r2.decision.reason], ['drop', 'stale-epoch']);
  ok('...and nothing moved', sim2.field.label === 'Last name', sim2.field.label);

  // Double interruption: two navigations in the order they were captured.
  const sim3 = new Sim(); fill(sim3, ['Arnav', 'Garg', 'a@b.co', '5551234', '1 Main St']);
  await sim3.say('go back to my email');
  const r3 = await sim3.say('no wait, take me to my phone number');
  ok('the latest instruction wins', r3.moved && r3.label === 'Phone number', r3.label);
  eq('...and the trail records both places the user has been',
     sim3.trail.slice(-2), ['email|email', 'tel|phone']);
}

/* ============================================ 12. the structured intent == */
G('the model can ask to move, and can never say where');
{
  const base = { field: INTAKE()[3], intent: 'phone', options: [], pending: null, turnId: 7 };
  const V = (raw) => I.validateIntent(raw, base);
  const nav = (intent, args = {}) => ({ intent, arguments: args, confidence: 0.94, needs_clarification: false });

  eq('NAVIGATE_PREVIOUS -> backward one', V(nav('NAVIGATE_PREVIOUS')).decision.nav, { kind: 'relative', direction: 'backward', count: 1 });
  eq('NAVIGATE_NEXT -> forward one', V(nav('NAVIGATE_NEXT')).decision.nav, { kind: 'relative', direction: 'forward', count: 1 });
  eq('NAVIGATE_RELATIVE carries direction and count',
     V(nav('NAVIGATE_RELATIVE', { direction: 'backward', count: 2 })).decision.nav,
     { kind: 'relative', direction: 'backward', count: 2 });
  eq('NAVIGATE_TO_FIELD carries the words, not a field',
     V(nav('NAVIGATE_TO_FIELD', { field_reference: 'phone number' })).decision.nav,
     { kind: 'field', field_reference: 'phone number', correction: null });
  eq('NAVIGATE_TO_REFERENCED_FIELD carries the reference',
     V(nav('NAVIGATE_TO_REFERENCED_FIELD', { reference: 'before_previous' })).decision.nav,
     { kind: 'referenced', reference: 'before_previous', field_reference: null, correction: null });

  const bad = [
    ['a count past the cap', nav('NAVIGATE_RELATIVE', { direction: 'backward', count: 99 }), 'count-out-of-range'],
    ['a fractional count', nav('NAVIGATE_RELATIVE', { direction: 'backward', count: 1.5 }), 'count-out-of-range'],
    ['a direction that is not one', nav('NAVIGATE_RELATIVE', { direction: 'sideways', count: 1 }), 'bad-direction'],
    ['no field reference at all', nav('NAVIGATE_TO_FIELD', {}), 'no-field-reference'],
    ['a reference that is markup', nav('NAVIGATE_TO_FIELD', { field_reference: '<script>x</script>' }), 'no-field-reference'],
    ['a reference that is a number', nav('NAVIGATE_TO_FIELD', { field_reference: 3 }), 'no-field-reference'],
    ['an unknown reference word', nav('NAVIGATE_TO_REFERENCED_FIELD', { reference: 'the third one' }), 'unknown-nav-reference'],
    ['before_field with nothing to anchor to', nav('NAVIGATE_TO_REFERENCED_FIELD', { reference: 'before_field' }), 'no-field-reference'],
    ['a turn that has moved on', { ...nav('NAVIGATE_PREVIOUS'), turn_id: 3 }, 'stale-turn'],
  ];
  for (const [name, raw, why] of bad) {
    const v = V(raw);
    ok(`rejected: ${name}`, !v.ok && v.why === why, JSON.stringify(v));
  }

  // A field id echoed on a navigation is IGNORED, not obeyed. Naming another
  // field is what a move is; which field it turns out to be still comes only
  // from the reference, resolved against the session. (The same id on an
  // ANSWER is still rejected - tools/test_intent.mjs holds that case.)
  {
    const v = V({ ...nav('NAVIGATE_TO_FIELD', { field_reference: 'first name' }), field_id: 'email|somewhere-else' });
    ok('a field id on a navigation is not a way to choose a field', v.ok && !JSON.stringify(v.decision.nav).includes('somewhere-else'), JSON.stringify(v));
    const r = C.resolveNav(v.decision.nav, { fields: INTAKE(), index: 3, trail: ['text|first', 'text|last', 'email|email', 'tel|phone'], answered: {}, labels: {} });
    ok('...and the reference is what decides where it lands', r.ok && r.field.label === 'First name', JSON.stringify(r));
  }

  // A selector-shaped reference is only ever TEXT, and matches nothing.
  const hostile = V(nav('NAVIGATE_TO_FIELD', { field_reference: 'input[name=ssn]' }));
  const resolved = hostile.ok ? C.resolveNav(hostile.decision.nav, { fields: INTAKE(), index: 0, trail: ['text|first'], answered: {}, labels: {} }) : null;
  ok('a CSS selector as a field reference resolves to nothing', !resolved?.ok, JSON.stringify(resolved));

  // The value carried by a navigation is still shape-checked where it lands.
  const withVal = V(nav('NAVIGATE_TO_FIELD', { field_reference: 'first name', value: 'Arnav' }));
  eq('a correction rides along as text', withVal.decision.nav.correction, 'Arnav');
  ok('...and a value with markup in it does not', V(nav('NAVIGATE_TO_FIELD', { field_reference: 'first name', value: '<b>x</b>' })).decision.nav.correction === null);
}

/* ================================================ 13. hybrid routing ===== */
G('the fast path stays fast, and the model only sees what needs it');
{
  for (const t of ['go back', 'next', 'skip', 'previous field', 'go back two fields',
                   'take me back to my email', 'go to date of birth', 'the previous one']) {
    const sim = new Sim(); fill(sim, ['Arnav', 'Garg']);
    await sim.say(t);
    ok(`"${t}" resolved with no provider call`, sim.consulted === 0, `consulted=${sim.consulted}`);
  }
  // Language the parser cannot resolve DOES reach the model - and what comes
  // back is still resolved against the session, never applied as given.
  {
    const sim = new Sim([...INTAKE()], { model: { intent: 'NAVIGATE_TO_REFERENCED_FIELD', arguments: { reference: 'last_answered' }, confidence: 0.9, needs_clarification: false } });
    fill(sim, ['Arnav', 'Garg', 'a@b.co']);
    const r = await sim.say('can you bring me back to whichever one I filled in last');
    ok('a phrasing the parser misses reaches the model', sim.consulted === 1, `consulted=${sim.consulted}`);
    ok('...and the model\'s reference is resolved by the session', r.moved && r.label === 'Email address', `${r.label} ${JSON.stringify(r.resolved)}`);
    ok('...and the context it saw lists the form by NAME only', !!r.asked?.form_fields && r.asked.form_fields.every(f => Object.keys(f).join() === 'position,label,answered,current'),
       JSON.stringify(r.asked?.form_fields?.[0]));
    ok('...with no ids and no values in it', !JSON.stringify(r.asked?.form_fields || []).includes('text|first'), JSON.stringify(r.asked?.form_fields || []).slice(0, 120));
  }
  {
    // The model naming a field that does not exist changes nothing.
    const sim = new Sim([...INTAKE()], { model: { intent: 'NAVIGATE_TO_FIELD', arguments: { field_reference: 'passport number' }, confidence: 0.99, needs_clarification: false } });
    fill(sim, ['Arnav', 'Garg']);
    const r = await sim.say('put me back on whatever it was about my passport');
    ok('a confident model naming a field the form lacks moves nothing', !r.moved, JSON.stringify(r.resolved));
  }
  {
    // Provider down: the deterministic reading stands, nothing is invented.
    const sim = new Sim([...INTAKE()], { model: null });
    fill(sim, ['Arnav', 'Garg']);
    const r = await sim.say('can you bring me back to whichever one I filled in last');
    ok('with no provider, an unparseable navigation moves nothing', !r.moved, JSON.stringify(r.decision.action));
  }
}

/* ============================================ 14. not navigation ========= */
G('utterances that only look like navigation');
{
  const cases = [
    ['back end developer', F('text|job', 'Occupation', 'job')],
    ['I want to change my career', F('text|job', 'Occupation', 'job')],
    ['Next of kin', F('text|rel', 'Relationship', 'rel')],
    ['forward slash', F('text|job', 'Occupation', 'job')],
  ];
  for (const [t, field] of cases) {
    const sim = new Sim([INTAKE()[0], field]);
    sim.answer('Arnav');
    const r = await sim.say(t);
    ok(`"${t}" is an answer, not a move`, !r.moved, `${r.decision.action} ${JSON.stringify(r.nav)}`);
  }
  {
    const sim = new Sim(); fill(sim, ['Arnav', 'Garg', 'a@b.co']); sim.confirm('5551234');
    const r = await sim.say('change that answer');
    ok('"change that answer" is about the field in play', !r.moved, `${r.decision.action}`);
  }
}

/* -------------------------------------------------------------------- out */
const pass = results.filter(r => r.pass).length;
const fail = results.filter(r => !r.pass);
let last = '';
for (const r of results) {
  if (r.group !== last) { console.log(`\n  ${r.group}`); last = r.group; }
  console.log(`    ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   ${r.detail}`}`);
}
console.log(`\n  PASS ${pass}   FAIL ${fail.length}\n`);
fs.mkdirSync('artifacts', { recursive: true });
fs.writeFileSync('artifacts/navigation_corpus.json', JSON.stringify({ at: new Date().toISOString(), pass, fail: fail.length, results }, null, 2));
process.exit(fail.length ? 1 : 0);
