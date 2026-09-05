// Phase 1 scanner tests, driven against REAL Chrome via CDP.
//
// Asserts behaviour, not implementation: each case names the field it expects
// and the label-resolution rule that must have produced it, so a scan that
// finds the right label by the wrong route is still a failure.
import fs from 'node:fs';
import path from 'node:path';
import { launchChrome, CDP, newPage } from './cdp.mjs';

const SHARED = ['extension/shared/fieldgraph.js', 'extension/shared/prompts.js']
  .map(f => fs.readFileSync(f, 'utf8')).join('\n;\n');

const results = [];
const rec = (name, ok, detail) => { results.push({ name, ok, detail }); return ok; };

/** Inject the exact files the extension ships, then scan. One implementation. */
async function scanPage(page) {
  await page.eval(SHARED);
  return page.eval(`(() => {
    const g = VFFieldGraph.scan(document);
    return {
      skipped: g.skipped,
      fields: g.fields.map(f => ({
        id: f.id, index: f.index, label: f.label, labelSource: f.labelSource,
        type: f.type, name: f.name, required: f.required,
        optionCount: f.optionCount, options: f.options.slice(0, 8).map(o => o.text),
        prompt: VFPrompts.promptFor(f), intent: VFPrompts.classify(f),
      })),
    };
  })()`);
}

const fileUrl = (p) => 'file://' + path.resolve(p);
const byName = (fields, n) => fields.find(f => f.name === n);
const byLabel = (fields, l) => fields.find(f => (f.label || '').toLowerCase() === l.toLowerCase());

/* ------------------------------------------------------------------ cases -- */

async function testLabelTorture(page) {
  await page.goto(fileUrl('eval/fixtures/01_label_torture.html'), { waitMs: 300 });
  const { fields } = await scanPage(page);
  const want = [
    ['fullname',  'Full name',        'label-for'],
    ['wrapped',   'Email address',    'label-wrap'],
    ['aria',      'Mobile number',    'aria-label'],
    ['alby',      'Postal code',      'aria-labelledby'],
    ['ph',        'Company name',     'placeholder'],
    ['preceding', 'Reference number', 'preceding-text'],
    ['weirdid',   'Display name',     'label-for'],
  ];
  for (const [name, label, source] of want) {
    const f = byName(fields, name);
    rec(`label: ${name} -> "${label}" via ${source}`,
        !!f && f.label === label && f.labelSource === source,
        f ? `got "${f.label}" via ${f.labelSource}` : 'field missing');
  }
  const dob = byName(fields, 'date_of_birth');
  rec('label: unlabelled input falls back to humanised name',
      !!dob && dob.label === 'date of birth' && dob.labelSource === 'name-attr',
      dob ? `got "${dob.label}" via ${dob.labelSource}` : 'missing');

  const anon = fields.find(f => f.labelSource === 'unlabelled');
  rec('label: genuinely anonymous field survives and gets a usable prompt',
      !!anon && /next field/i.test(anon.prompt),
      anon ? anon.prompt : 'no unlabelled field found');

  const req = byName(fields, 'req');
  rec('label: "*", "(required)" and trailing colon stripped',
      !!req && req.label === 'Card holder name' && req.required === true,
      req ? `"${req.label}" required=${req.required}` : 'missing');

  const wrapped = byName(fields, 'wrapped');
  rec('label: wrapping label does not absorb the control value',
      !!wrapped && !/SHOULD-NOT-APPEAR/.test(wrapped.label), wrapped?.label);
}

async function testVisibility(page) {
  await page.goto(fileUrl('eval/fixtures/02_visibility.html'), { waitMs: 300 });
  const { fields } = await scanPage(page);
  const names = fields.map(f => f.name);

  rec('visible: position:fixed control is NOT dropped (offsetParent is null for these)',
      names.includes('fixedsearch'), names.join(','));
  rec('visible: ordinary field kept', names.includes('plain'), names.join(','));

  for (const hidden of ['csrf_token', 'h_display', 'h_vis', 'h_op', 'h_aria', 'h_attr', 'h_clip']) {
    rec(`hidden: ${hidden} excluded`, !names.includes(hidden), names.join(','));
  }
  rec('buttons: submit/button/reset excluded',
      !fields.some(f => ['submit', 'button', 'reset'].includes(f.type)),
      fields.map(f => f.type).join(','));
}

async function testChoices(page) {
  await page.goto(fileUrl('eval/fixtures/03_choices.html'), { waitMs: 400 });
  const { fields } = await scanPage(page);

  const contact = byName(fields, 'contact');
  rec('radios: three radios collapse into ONE radiogroup field',
      !!contact && contact.type === 'radiogroup' && contact.optionCount === 3,
      contact ? `${contact.type} x${contact.optionCount}` : 'missing');
  rec('radios: group question comes from the fieldset legend',
      !!contact && contact.label === 'Preferred contact method' && contact.labelSource === 'fieldset-legend',
      contact ? `"${contact.label}" via ${contact.labelSource}` : 'missing');
  rec('radios: option text read from the wrapping labels, not the values',
      !!contact && contact.options.includes('Email') && contact.options.includes('Post'),
      JSON.stringify(contact?.options));

  const consent = byName(fields, 'consent');
  rec('radios: group with no fieldset takes the container question, NOT the first option label',
      !!consent && consent.label === 'Do you consent?' && !/^(Yes|No)$/i.test(consent.label),
      consent ? `"${consent.label}" via ${consent.labelSource} -> ${consent.prompt}` : 'missing');

  const terms = byName(fields, 'terms');
  rec('checkbox: a lone checkbox is a yes/no question',
      !!terms && terms.type === 'checkbox' && terms.intent === 'yesno' && /yes or no/i.test(terms.prompt),
      terms ? terms.prompt : 'missing');

  const diet = byName(fields, 'diet');
  rec('checkbox: same-name checkboxes collapse into ONE multi-select',
      !!diet && diet.type === 'checkboxgroup' && diet.optionCount === 3,
      diet ? `${diet.type} x${diet.optionCount}` : 'missing');

  const country = byName(fields, 'country');
  rec('select: optgroup options flattened, placeholder option dropped',
      !!country && country.optionCount === 4 && !country.options.includes('Please choose…'),
      country ? `${country.optionCount}: ${country.options.join('|')}` : 'missing');

  const tz = byName(fields, 'tz');
  rec('select: a 60-option list is NOT read out in full',
      !!tz && tz.optionCount === 60 && (tz.prompt.match(/Zone number/g) || []).length <= 6 && /more/.test(tz.prompt),
      tz ? tz.prompt.slice(0, 120) : 'missing');

  const slot = byName(fields, 'slot');
  rec('select: valueless placeholder option ("Open this select menu") dropped',
      !!slot && slot.optionCount === 2 && !/open this select menu/i.test(slot.prompt),
      slot ? `${slot.optionCount}: ${slot.prompt}` : 'missing');

  const cttee = byName(fields, 'committee');
  rec('select: a REAL first option beginning "Select" is not mistaken for a placeholder',
      !!cttee && cttee.optionCount === 2 && /Select Committee/.test(cttee.prompt),
      cttee ? `${cttee.optionCount}: ${cttee.prompt}` : 'missing');

  const langs = byName(fields, 'langs');
  rec('select[multiple]: classified as multichoice',
      !!langs && langs.intent === 'multichoice', langs ? langs.intent : 'missing');
}

async function testMalformed(page) {
  await page.goto(fileUrl('eval/fixtures/04_malformed.html'), { waitMs: 300 });
  const { fields } = await scanPage(page);
  const names = fields.map(f => f.name);

  rec('malformed: input with no <form> ancestor is still found', names.includes('orphan'), names.join(','));
  rec('malformed: nested-form fields both found',
      names.includes('outer') && names.includes('inner'), names.join(','));
  rec('malformed: duplicate ids do not crash the scan and both fields appear',
      names.includes('d1') && names.includes('d2'), names.join(','));
  rec('malformed: unclosed tag does not truncate the scan', names.includes('unclosed'), names.join(','));
  rec('malformed: label wrapping two controls yields two fields',
      names.includes('multi_a') && names.includes('multi_b'), names.join(','));
  rec('malformed: contenteditable is a field',
      fields.some(f => f.type === 'contenteditable'), fields.map(f => f.type).join(','));
  const combo = fields.find(f => f.type === 'combobox');
  const rgroup = fields.find(f => f.type === 'radiogroup' && f.name === '');
  rec('malformed: role=combobox / role=radiogroup ARIA widgets are found and named',
      !!combo && combo.label === 'Delivery slot' && !!rgroup && rgroup.label === 'Contact preference',
      `combo=${combo?.label} radiogroup=${rgroup?.label}`);

  // tabindex 1 and 2 must be read BEFORE every tabindex-0 field.
  const i3 = fields.findIndex(f => f.name === 't3');
  const i4 = fields.findIndex(f => f.name === 't4');
  const iOrphan = fields.findIndex(f => f.name === 'orphan');
  rec('ordering: positive tabindex is read before document order',
      i3 === 0 && i4 === 1 && iOrphan > i4, `t3@${i3} t4@${i4} orphan@${iOrphan}`);

  rec('malformed: unique ids assigned even with duplicate name/label',
      new Set(fields.map(f => f.id)).size === fields.length,
      `${new Set(fields.map(f => f.id)).size}/${fields.length} unique`);
}

async function testShadowIframe(page) {
  await page.goto(fileUrl('eval/fixtures/05_shadow_iframe.html'), { waitMs: 500 });
  const { fields } = await scanPage(page);
  const names = fields.map(f => f.name);

  rec('shadow: light DOM field found', names.includes('light'), names.join(','));
  rec('shadow: OPEN shadow root is scanned', names.includes('shadow_open'), names.join(','));
  rec('shadow: nested open roots are scanned', names.includes('shadow_nested'), names.join(','));
  rec('shadow: CLOSED shadow root is NOT reachable (declared limitation)',
      !names.includes('shadow_closed'), names.join(','));
  // The top-frame scan must not reach into the iframe document; the content
  // script is injected there separately with all_frames:true.
  rec('iframe: top-frame scan does not cross the frame boundary',
      !names.includes('iframe_field'), names.join(','));
}

async function testSpaDynamic(page) {
  await page.goto(fileUrl('eval/fixtures/06_spa_dynamic.html'), { waitMs: 150 });

  await page.eval(SHARED);
  const early = await page.eval('VFFieldGraph.scan(document).fields.length');
  rec('spa: nothing to find at load time (this is the React shape)', early === 0, `found ${early}`);

  await new Promise(r => setTimeout(r, 700));
  const after = await page.eval(`VFFieldGraph.scan(document).fields.map(f=>f.id)`);
  rec('spa: fields found once mounted', after.length === 2, JSON.stringify(after));

  await new Promise(r => setTimeout(r, 700));
  const withDep = await page.eval(`VFFieldGraph.scan(document).fields.map(f=>f.id)`);
  rec('spa: a later dependent field is picked up', withDep.length === 3, JSON.stringify(withDep));

  // The remount replaces every element object. Ids must be stable across it,
  // because that is the only thing keeping the user's place.
  await new Promise(r => setTimeout(r, 900));
  const remounted = await page.eval(`(() => ({
    remounted: !!window.__remounted,
    ids: VFFieldGraph.scan(document).fields.map(f=>f.id),
  }))()`);
  rec('spa: stable ids survive a full remount',
      remounted.remounted && JSON.stringify(remounted.ids) === JSON.stringify(withDep),
      `${JSON.stringify(withDep)} -> ${JSON.stringify(remounted.ids)}`);
}

/** No prompt may ever contain a raw bracket token or an undefined. */
async function testPromptHygiene(page) {
  const pages = ['01_label_torture', '02_visibility', '03_choices', '04_malformed', '05_shadow_iframe'];
  let bad = [];
  for (const p of pages) {
    await page.goto(fileUrl(`eval/fixtures/${p}.html`), { waitMs: 300 });
    const { fields } = await scanPage(page);
    for (const f of fields) {
      if (/undefined|null|\[object/i.test(f.prompt)) bad.push(`${p}/${f.id}: ${f.prompt}`);
      if (/\{\}|\bNaN\b/.test(f.prompt)) bad.push(`${p}/${f.id}: ${f.prompt}`);
      if (!f.prompt || f.prompt.length < 4) bad.push(`${p}/${f.id}: empty prompt`);
    }
  }
  rec('prompts: no undefined/null/NaN/empty prompt on any fixture', bad.length === 0, bad.slice(0, 4).join(' | '));

  // With pauses disabled the tokens must vanish, not be spoken.
  await page.eval('VFPrompts.setPauseEnabled(false)');
  const noPause = await page.eval(`(() => {
    const g = VFFieldGraph.scan(document);
    return g.fields.map(f => VFPrompts.promptFor(f)).filter(t => /<\\d+>/.test(t));
  })()`);
  rec('prompts: pause tokens disappear entirely when the flag is off',
      noPause.length === 0, JSON.stringify(noPause.slice(0, 3)));
  await page.eval('VFPrompts.setPauseEnabled(true)');
}

async function testNotAField(page) {
  await page.goto(fileUrl('eval/fixtures/07_not_a_field.html'), { waitMs: 350 });
  const { fields, skipped } = await scanPage(page);
  const names = fields.map(f => f.name);

  rec('not-a-field: the real field survives', names.includes('real'), names.join(','));

  for (const n of ['disabled_one', 'ariadisabled_one', 'in_disabled_fieldset']) {
    rec(`unanswerable: ${n} excluded (disabled)`, !names.includes(n), names.join(','));
  }
  rec('unanswerable: readonly_one excluded', !names.includes('readonly_one'), names.join(','));
  rec('unanswerable: skip counters populated',
      skipped.disabled >= 3 && skipped.readonly >= 1, JSON.stringify(skipped));

  // The Wikipedia navigation pattern.
  rec('widget: role=button checkbox is NOT a question',
      !fields.some(f => /main menu/i.test(f.label || '')), JSON.stringify(fields.map(f => f.label)));
  rec('widget: aria-haspopup checkbox is NOT a question',
      !fields.some(f => /appearance settings/i.test(f.label || '')), JSON.stringify(fields.map(f => f.label)));
  rec('widget: role=button div is NOT a question',
      !fields.some(f => /open the picker/i.test(f.label || '')), JSON.stringify(fields.map(f => f.label)));

  // ...but a genuinely styled custom checkbox must NOT be collateral damage.
  rec('widget: a styled opacity:0 checkbox with a visible label IS still a field',
      names.includes('styled_real'), names.join(','));

  // Example-value placeholders must not become the spoken question.
  const ex = [
    ['userEmail',  /name@example\.com/i],
    ['home_phone', /555/],
    ['start_date', /DD\/MM/i],
    ['web_site',   /https?:/i],
    ['staff_id',   /AB-12345/i],
  ];
  for (const [n, bad] of ex) {
    const f = byName(fields, n);
    rec(`placeholder: ${n} example value is not spoken as the label`,
        !!f && !bad.test(f.prompt), f ? f.prompt : 'field missing');
  }
  const em = byName(fields, 'userEmail');
  rec('placeholder: rejected example still classifies as email via the name',
      !!em && em.intent === 'email' && /email address/i.test(em.prompt), em ? em.prompt : 'missing');

  // Instruction-shaped labels.
  const cp = byName(fields, 'cp');
  rec('phrasing: "Confirm password" -> an instruction, not "your confirm password"',
      !!cp && /^please confirm your password/i.test(cp.prompt) && !/your confirm/i.test(cp.prompt),
      cp ? cp.prompt : 'missing');
  const re = byName(fields, 're');
  rec('phrasing: "Re-enter email address" -> an instruction',
      !!re && /^please re-enter your email address/i.test(re.prompt), re ? re.prompt : 'missing');
}

/* -------------------------------------------------------------------- run -- */

const chrome = await launchChrome({ headless: true });
const cdp = await new CDP(chrome.browserWsUrl).connect();
const page = await newPage(cdp);

try {
  await testLabelTorture(page);
  await testVisibility(page);
  await testChoices(page);
  await testMalformed(page);
  await testShadowIframe(page);
  await testSpaDynamic(page);
  await testNotAField(page);
  await testPromptHygiene(page);
} finally {
  await page.close(); cdp.close(); await chrome.close();
}

const pass = results.filter(r => r.ok).length;
const fail = results.filter(r => !r.ok);
console.log(`\nFieldGraph tests - real Chrome ${chrome.version.Browser}\n`);
for (const r of results) {
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
  if (!r.ok) console.log(`        got: ${String(r.detail).slice(0, 160)}`);
}
console.log(`\n  PASS ${pass}   FAIL ${fail.length}\n`);
fs.mkdirSync('artifacts', { recursive: true });
fs.writeFileSync('artifacts/phase1_fieldgraph.json', JSON.stringify({ browser: chrome.version.Browser, results }, null, 2));
process.exit(fail.length ? 1 : 0);
