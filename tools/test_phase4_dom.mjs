// Phase 4 in a real browser, at the DOM layer (PRD F4.1, F4.2, F4.5-F4.9).
//
// No extension and no Rime: the scanner and the writer are put against the
// fixtures directly, because what is under test here is whether a custom
// widget, a cascading select, a masked field and a controlled input can be
// READ and WRITTEN at all. The session's behaviour on top of that -
// re-asking, invalidating, refusing - is tools/test_phase4_form.mjs.
//
// Every assertion reads the PAGE's own state (window.__formState, aria-checked,
// React's mirror), never the return value of the thing under test on its own.
//
//   node tools/test_phase4_dom.mjs
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { launchChrome, CDP, newPage } from './cdp.mjs';

const SHARED = ['extension/shared/fieldgraph.js', 'extension/shared/prompts.js',
                'extension/shared/normalize.js', 'extension/shared/domwrite.js']
  .map(f => fs.readFileSync(f, 'utf8')).join('\n;\n');

const results = [];
let scenario = '';
const S = (s) => { scenario = s; console.log(`\n  ${s}`); };
const rec = (name, ok, detail = '') => {
  results.push({ scenario, name, ok: !!ok, detail: String(detail).slice(0, 300) });
  console.log(`    ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n          got: ${String(detail).slice(0, 240)}`}`);
  return ok;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const srv = http.createServer((req, res) => {
  const f = path.join('eval/fixtures', decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, ''));
  if (!fs.existsSync(f) || !fs.statSync(f).isFile()) { res.statusCode = 404; return res.end('no'); }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(fs.readFileSync(f));
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const PORT = srv.address().port;

const chrome = await launchChrome({ headless: true });
const cdp = await new CDP(chrome.browserWsUrl).connect();
const page = await newPage(cdp);

const state = () => page.eval('window.__formState()');
const scan = () => page.eval(`(() => {
  const g = VFFieldGraph.scan(document);
  return g.fields.map(f => ({ id: f.id, label: f.label, type: f.type, options: f.options.map(o => o.text),
    optionCount: f.optionCount, dependsOn: f.dependsOn, dependsSource: f.dependsSource,
    awaitingParent: f.awaitingParent, mask: f.mask }));
})()`);

/** Write to a field by label, exactly as the content script does. */
const write = (label, value) => page.eval(`(async () => {
  const g = VFFieldGraph.scan(document);
  const i = g.fields.findIndex(f => (f.label || '').toLowerCase() === ${JSON.stringify(String(label).toLowerCase())});
  if (i < 0) return { found: false, labels: g.fields.map(f => f.label) };
  const f = g.fields[i], els = g.elements[i];
  const r = await VFDomWrite.write(els, f.type, ${JSON.stringify(value)});
  return { found: true, type: f.type, result: r,
           current: VFDomWrite.readCurrent(els, f.type), validity: VFDomWrite.validate(els) };
})()`, { awaitPromise: true });

try {

/* ================================================== fixture 16: the form == */
await page.goto(`http://127.0.0.1:${PORT}/16_phase4.html`, { waitMs: 800 });
await page.eval(SHARED);

S('F4.1  the country -> state -> city cascade is found in the DOM');
{
  const fields = await scan();
  const by = (l) => fields.find(f => (f.label || '').toLowerCase().startsWith(l));
  const country = by('country'), st = by('state'), city = by('city');
  rec('all three rungs are scanned', !!country && !!st && !!city, JSON.stringify(fields.map(f => f.label)));
  rec('country depends on nothing', country?.dependsOn === null, JSON.stringify(country));
  rec('state depends on country', st?.dependsOn === country?.id, `${st?.dependsOn} vs ${country?.id}`);
  rec('city depends on STATE, not on country', city?.dependsOn === st?.id, `${city?.dependsOn} vs state=${st?.id} country=${country?.id}`);
  rec('...and both say the cascade is why', st?.dependsSource === 'cascade' && city?.dependsSource === 'cascade',
      `${st?.dependsSource} / ${city?.dependsSource}`);
  rec('an unpopulated dependent is marked as awaiting its parent',
      st?.awaitingParent === true && st?.optionCount === 0, JSON.stringify(st));
}

S('F4.1  answering the parent repopulates the dependent, and the scan sees it');
{
  const before = await scan();
  const sig0 = await page.eval('VFFieldGraph.scan(document).signature');
  await write('Country', 'United Kingdom');
  await sleep(300);                              // the page's cascade is asynchronous
  const after = await scan();
  const st = after.find(f => (f.label || '').toLowerCase().startsWith('state'));
  const sig1 = await page.eval('VFFieldGraph.scan(document).signature');
  rec('the country was written', (await state()).country === 'GB', JSON.stringify(await state()));
  rec('the state list is now populated', st?.optionCount === 2, JSON.stringify(st));
  rec('...with the options the page chose', JSON.stringify(st?.options) === JSON.stringify(['England', 'Scotland']), JSON.stringify(st?.options));
  rec('...and it no longer awaits its parent', st?.awaitingParent === false, String(st?.awaitingParent));
  // The signature is the whole point of F4.9: no field id changed, so an
  // id-only signature would have reported nothing had happened.
  rec('the form signature changed even though no field id did',
      sig0 !== sig1 && before.map(f => f.id).join() === after.map(f => f.id).join(),
      `sigChanged=${sig0 !== sig1}`);

  await write('State or province', 'England');
  await sleep(300);
  const city = (await scan()).find(f => (f.label || '').toLowerCase().startsWith('city'));
  rec('answering the state repopulates the city', city?.optionCount === 3, JSON.stringify(city?.options));

  // Changing the country invalidates what the old list offered. The DOM layer's
  // job is to REBUILD; dropping the stale answer is the session's, and is
  // asserted in tools/test_phase4_form.mjs.
  await write('Country', 'United States');
  await sleep(300);
  const st2 = (await scan()).find(f => (f.label || '').toLowerCase().startsWith('state'));
  rec('changing the country rebuilds the state list',
      JSON.stringify(st2?.options) === JSON.stringify(['California', 'Texas']), JSON.stringify(st2?.options));
  rec('...and the stale selection is no longer among the options',
      !(st2?.options || []).includes('England'), JSON.stringify(st2?.options));
}

S('F4.5  masked inputs take the value in the shape the page states');
{
  await page.eval('window.__reset()');
  const fields = await scan();
  const phone = fields.find(f => (f.label || '').toLowerCase().startsWith('phone'));
  rec('the scanner reports the mask the page advertises', phone?.mask === '(###) ###-####', JSON.stringify(phone?.mask));

  // The field reformats whatever it is given, so `el.value === what I wrote`
  // is false on a correct write. Significant characters are the comparison.
  const w = await write('Phone number', '5551234567');
  rec('a phone written from bare digits lands formatted', (await state()).phone === '(555) 123-4567',
      `${(await state()).phone} result=${JSON.stringify(w.result)}`);
  rec('...and the writer reports success despite the reformatting', w.result?.ok === true, JSON.stringify(w.result));
  rec('...and the read-back reads what is really there', w.current === '(555) 123-4567', String(w.current));

  const r = await write('Renewal date', '2026-06-14');
  rec('an ISO date into a US-format masked text field', (await state()).renewal === '06/14/2026',
      `${(await state()).renewal} result=${JSON.stringify(r.result)}`);
  rec('...reported as written', r.result?.ok === true, JSON.stringify(r.result));
}

S('F4.4  native date inputs take their own wire format');
{
  const d = await write('Start date', '2026-06-14');
  rec('a date input takes ISO', (await state()).start === '2026-06-14', `${(await state()).start} ${JSON.stringify(d.result)}`);
  const m = await write('Expiry', '2026-06-14');
  rec('a month input is given YYYY-MM, not the whole date', (await state()).expiry === '2026-06',
      `${(await state()).expiry} ${JSON.stringify(m.result)}`);
  rec('...and reports success', m.result?.ok === true, JSON.stringify(m.result));
}

S('F4.3  a value the page refuses is detected, with the page\'s own reason');
{
  await page.eval('window.__step(2)');
  await sleep(200);
  const bad = await write('Coupon code', 'WINTER25');
  rec('the page marked the value invalid', bad.validity?.valid === false, JSON.stringify(bad.validity));
  rec('...and the reason is the page\'s own words', /expired/i.test(bad.validity?.reason || ''), bad.validity?.reason);
  const good = await write('Coupon code', 'SPRING26');
  rec('an accepted value is not reported invalid', good.validity?.valid === true, JSON.stringify(good.validity));

  await page.eval('window.__step(1)');
  await sleep(200);
  const pc = await write('Postal code', 'NOTAPOSTCODE');
  rec('a pattern mismatch is caught by constraint validation', pc.validity?.valid === false, JSON.stringify(pc.validity));
  rec('...and the form-wide sweep names the field', await page.eval(`(() => {
    const g = VFFieldGraph.scan(document); const by = {};
    g.fields.forEach((f, i) => { by[f.id] = g.elements[i]; });
    return VFDomWrite.findInvalid(by).some(v => /postcode|postal/i.test(v.id));
  })()`), 'findInvalid');
}

S('F4.7  custom form controls built out of divs');
{
  await page.eval('window.__reset(); window.__step(2)');
  await sleep(200);
  const fields = await scan();
  const label = (s) => fields.find(f => (f.label || '').toLowerCase().includes(s));
  const plan = label('support plan'), tier = label('billing tier'), chan = label('contact channels');

  rec('a custom combobox is scanned as a field', plan?.type === 'combobox', JSON.stringify(plan));
  rec('...named from its aria-labelledby, not from its options', plan?.label === 'Support plan', plan?.label);
  // The widget builds its options only when open, so there is nothing to read.
  // Inventing them is exactly the guess this product must not make.
  rec('...with no options while it is closed, rather than invented ones',
      plan?.optionCount === 0, JSON.stringify(plan?.options));

  rec('a custom radio group is one field, not one per option', tier?.type === 'aria-radiogroup', JSON.stringify(tier));
  rec('...with both options read off the DOM',
      JSON.stringify(tier?.options) === JSON.stringify(['Monthly', 'Annual']), JSON.stringify(tier?.options));
  rec('a custom checkbox group is one multi-select field', chan?.type === 'aria-checkboxgroup', JSON.stringify(chan));
  rec('...with all three options', chan?.optionCount === 3, JSON.stringify(chan?.options));
  rec('...and its members are NOT separate yes/no fields',
      !fields.some(f => f.type === 'aria-checkbox'), JSON.stringify(fields.map(f => f.type)));

  const p = await write('Support plan', 'Professional');
  rec('the custom select is opened, picked and verified', (await state()).plan === 'pro',
      `${(await state()).plan} ${JSON.stringify(p.result)}`);
  rec('...and reports success only because it checked', p.result?.ok === true, JSON.stringify(p.result));
  rec('...and closed itself again', await page.eval(`document.getElementById('plan').getAttribute('aria-expanded')`) === 'false',
      await page.eval(`document.getElementById('plan').getAttribute('aria-expanded')`));

  // An option the widget does not offer must fail, not pick something near it.
  const miss = await write('Support plan', 'Platinum');
  rec('an option the widget does not have is refused, not approximated',
      miss.result?.ok === false && (await state()).plan === 'pro',
      `${JSON.stringify(miss.result)} plan=${(await state()).plan}`);

  const t = await write('Billing tier', 'Annual');
  rec('a custom radio is clicked and confirmed by aria-checked', (await state()).tier === 'annual',
      `${(await state()).tier} ${JSON.stringify(t.result)}`);
  const c = await write('Contact channels', ['Email', 'Post']);
  rec('a custom checkbox group takes several answers',
      JSON.stringify((await state()).channels) === JSON.stringify(['email', 'post']),
      `${JSON.stringify((await state()).channels)} ${JSON.stringify(c.result)}`);
  rec('...and reads back the ones that are on', /Email/.test(c.current || '') && /Post/.test(c.current || ''), String(c.current));
  const none = await write('Contact channels', []);
  rec('an empty selection clears the group', JSON.stringify((await state()).channels) === '[]',
      JSON.stringify((await state()).channels));
}

S('F4.6  native radio and checkbox groups, unchanged by any of this');
{
  await page.eval('window.__reset(); window.__step(2)');
  await sleep(200);
  const r = await write('Delivery speed', 'express');
  rec('a native radio group still fills', (await state()).speed === 'express', `${(await state()).speed} ${JSON.stringify(r.result)}`);
  const c = await write('Optional extras', ['insurance', 'tracking']);
  rec('a native checkbox group still takes several',
      JSON.stringify((await state()).extras) === JSON.stringify(['insurance', 'tracking']),
      JSON.stringify((await state()).extras));
}

S('F4.2 / F4.9  a wizard step replaces the form under the scanner');
{
  await page.eval('window.__reset()');
  await sleep(150);
  const one = await scan();
  await page.eval('window.__step(2)');
  await sleep(250);
  const two = await scan();
  rec('step 1 and step 2 are different sets of fields',
      one.every(f => !two.some(g => g.id === f.id)),
      `${one.map(f => f.label).join()} -> ${two.map(f => f.label).join()}`);
  rec('...and the signature says so', await page.eval('VFFieldGraph.scan(document).signature') !== '',
      'signature present');
  await page.eval('window.__step(1)');
  await sleep(250);
  const back = await scan();
  rec('going back restores step 1 with the SAME stable ids',
      JSON.stringify(back.map(f => f.id)) === JSON.stringify(one.map(f => f.id)),
      `${back.map(f => f.id).join()} vs ${one.map(f => f.id).join()}`);
}

/* ============================================ fixture 08: controlled React = */
S('F4.8  programmatic values reach React state, verified after the re-render');
{
  await page.goto(`http://127.0.0.1:${PORT}/08_react_controlled.html`, { waitMs: 2500 });
  await page.eval(SHARED);
  rec('the React fixture mounted', await page.eval('!!window.__reactReady && !!window.__reactState'), 'mounted');

  const react = () => page.eval('window.__reactState');
  const w = await write('Account holder', 'Arnav Garg');
  rec('the write reports success', w.result?.ok === true, JSON.stringify(w.result));
  rec('...and REACT holds the value, not just the pixels', (await react()).name === 'Arnav Garg',
      JSON.stringify(await react()));

  // The check that only an awaited write can make: a controlled input that
  // reverts does so on the NEXT task, so a synchronous comparison sees the
  // value it just wrote and reports a success that is about to be undone.
  const rejected = await page.eval(`(async () => {
    const el = document.createElement('input');
    document.body.appendChild(el);
    el.addEventListener('input', () => { setTimeout(() => { el.value = 'REVERTED'; }, 0); });
    const r = await VFDomWrite.write(el, 'text', 'Arnav');
    return { ok: r.ok, value: el.value };
  })()`, { awaitPromise: true });
  rec('a value the page reverts a task later is NOT reported as written',
      rejected.ok === false && rejected.value === 'REVERTED', JSON.stringify(rejected));
}

} finally {
  const pass = results.filter(r => r.ok).length, fail = results.filter(r => !r.ok);
  console.log(`\n  PASS ${pass}   FAIL ${fail.length}\n`);
  fs.mkdirSync('artifacts', { recursive: true });
  fs.writeFileSync('artifacts/phase4_dom.json', JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  try { await cdp.close(); } catch {}
  try { await chrome.close(); } catch {}
  srv.close();
  process.exit(fail.length ? 1 : 0);
}
