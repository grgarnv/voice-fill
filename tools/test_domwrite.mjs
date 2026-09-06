// DOM writing tests (PRD F2.4) against real Chrome and real React.
//
// The assertion that matters is not "the input shows the value" - a naive
// `el.value = x` achieves that while leaving React's state stale, so the form
// submits the OLD value and the bug is invisible until it costs someone a
// submission. Every React case here checks window.__reactState, i.e. what the
// framework believes, not what the pixels show.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { launchChrome, CDP, newPage } from './cdp.mjs';

const SHARED = ['extension/shared/fieldgraph.js', 'extension/shared/prompts.js',
                'extension/shared/normalize.js', 'extension/shared/domwrite.js']
  .map(f => fs.readFileSync(f, 'utf8')).join('\n;\n');

const results = [];
const rec = (name, ok, detail) => { results.push({ name, ok, detail }); return ok; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// React must come over the network; a file:// page cannot load the CDN build.
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

/** Scan, then write to a named field, returning both the DOM and React views. */
async function writeField(name, value) {
  // write() is async since Phase 4: a controlled input's revert and a custom
  // listbox's opening both land a task later, and the result is only true once
  // they have had their chance.
  return page.eval(`(async () => {
    const g = VFFieldGraph.scan(document);
    const i = g.fields.findIndex(f => f.name === ${JSON.stringify(name)});
    if (i < 0) return { found: false, names: g.fields.map(f => f.name) };
    const field = g.fields[i];
    const els = g.elements[i];
    const r = await VFDomWrite.write(els, field.type, ${JSON.stringify(value)});
    return {
      found: true, type: field.type, result: r,
      current: VFDomWrite.readCurrent(els, field.type),
      validity: VFDomWrite.validate(els),
    };
  })()`, { awaitPromise: true });
}

const reactState = () => page.eval('window.__reactState');

try {
  /* ---------------------------------------------------- React controlled -- */
  await page.goto(`http://127.0.0.1:${PORT}/08_react_controlled.html`, { waitMs: 2500 });
  const ready = await page.eval('!!window.__reactReady && !!window.__reactState');
  rec('react: fixture mounted and exposing state', ready, String(ready));
  await page.eval(SHARED);

  // A naive assignment is the control case. It must FAIL to update React, or
  // this whole file is testing nothing.
  const naive = await page.eval(`(() => {
    const el = document.getElementById('name');
    el.value = 'Naive Write';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return { dom: el.value, react: window.__reactState.name };
  })()`);
  rec('react: CONTROL - a naive el.value write does NOT reach React state',
      naive.dom === 'Naive Write' && naive.react !== 'Naive Write',
      `dom=${JSON.stringify(naive.dom)} react=${JSON.stringify(naive.react)}`);

  const nm = await writeField('name', 'Ada Lovelace');
  await sleep(150);
  let st = await reactState();
  rec('react: text input reaches REACT STATE, not just the DOM',
      nm.found && st.name === 'Ada Lovelace' && nm.current === 'Ada Lovelace',
      `react=${JSON.stringify(st.name)} dom=${JSON.stringify(nm.current)}`);

  const pin = await writeField('pin', '160071');
  await sleep(150);
  st = await reactState();
  rec('react: a coercing input (digits only, max 6) accepts a clean value',
      st.pin === '160071', `react=${JSON.stringify(st.pin)}`);

  const sel = await writeField('size', 'md');
  await sleep(150);
  st = await reactState();
  rec('react: controlled <select> updates state',
      st.size === 'md' && sel.current === 'Medium', `react=${JSON.stringify(st.size)} label=${sel.current}`);

  const rad = await writeField('contact', 'phone');
  await sleep(150);
  st = await reactState();
  rec('react: controlled radio group updates state (clicked, not assigned)',
      st.contact === 'phone', `react=${JSON.stringify(st.contact)}`);

  const chk = await writeField('diet', ['v', 'gf']);
  await sleep(200);
  st = await reactState();
  rec('react: controlled checkbox group sets exactly the chosen boxes',
      Array.isArray(st.diet) && st.diet.length === 2 && st.diet.includes('v') && st.diet.includes('gf'),
      JSON.stringify(st.diet));

  const terms = await writeField('terms', 'true');
  await sleep(150);
  st = await reactState();
  rec('react: single checkbox becomes true', st.terms === true, JSON.stringify(st.terms));

  /* -------------------------------------------------------- validation ---- */
  const badEmail = await writeField('email', 'not-an-email');
  await sleep(250);
  const vBad = await page.eval(`(() => {
    const g = VFFieldGraph.scan(document);
    const i = g.fields.findIndex(f => f.name === 'email');
    return VFDomWrite.validate(g.elements[i]);
  })()`);
  rec('validation: a value the app rejects is detected as invalid',
      vBad.valid === false, JSON.stringify(vBad));
  rec('validation: the reason is the page\'s own message, spoken back verbatim',
      /valid email/i.test(String(vBad.reason || '')), String(vBad.reason));

  const goodEmail = await writeField('email', 'ada@example.com');
  await sleep(250);
  const vGood = await page.eval(`(() => {
    const g = VFFieldGraph.scan(document);
    const i = g.fields.findIndex(f => f.name === 'email');
    return VFDomWrite.validate(g.elements[i]);
  })()`);
  rec('validation: a good value clears the error', vGood.valid === true, JSON.stringify(vGood));

  /* ------------------------------------------------------------ vanilla --- */
  await page.goto(`http://127.0.0.1:${PORT}/03_choices.html`, { waitMs: 400 });
  await page.eval(SHARED);

  const country = await writeField('country', 'India');
  rec('vanilla: <select> matched by visible label, not just value',
      country.result?.ok && country.current === 'India', JSON.stringify(country.result));

  const contact2 = await writeField('contact', 'Email');
  rec('vanilla: radio matched by its label text', contact2.result?.ok, JSON.stringify(contact2.result));

  const diet2 = await writeField('diet', ['Vegan', 'Gluten free']);
  rec('vanilla: checkbox group matched by label text',
      diet2.current === 'Vegan, Gluten free', JSON.stringify(diet2.current));

  const terms2 = await writeField('terms', 'true');
  rec('vanilla: lone checkbox', terms2.current === 'yes', JSON.stringify(terms2.current));

  const missing = await writeField('country', 'Atlantis');
  rec('vanilla: an option that does not exist FAILS rather than picking a neighbour',
      missing.result?.ok === false, JSON.stringify(missing.result));

  /* -------------------------------------------- constraint validation ----- */
  await page.goto(`http://127.0.0.1:${PORT}/09_validation.html`, { waitMs: 400 });
  await page.eval(SHARED);

  const short = await writeField('postcode', '12');
  rec('constraint: pattern mismatch is detected',
      short.validity?.valid === false, JSON.stringify(short.validity));
  const okPost = await writeField('postcode', 'SW1A2AA');
  rec('constraint: a conforming value validates',
      okPost.validity?.valid === true, JSON.stringify(okPost.validity));

  const age = await writeField('age', '200');
  rec('constraint: out-of-range number is detected',
      age.validity?.valid === false, JSON.stringify(age.validity));

  const masked = await writeField('masked', '12345');
  rec('masked: a widget that only accepts keystrokes still receives the value',
      masked.current === '12345', `current=${JSON.stringify(masked.current)}`);

  const errNode = await writeField('coupon', 'BAD');
  await sleep(200);
  const vErr = await page.eval(`(() => {
    const g = VFFieldGraph.scan(document);
    const i = g.fields.findIndex(f => f.name === 'coupon');
    return VFDomWrite.validate(g.elements[i]);
  })()`);
  rec('validation: a visible error node beside the field is found',
      vErr.valid === false && /coupon/i.test(String(vErr.reason)), JSON.stringify(vErr));

  const farAway = await page.eval(`VFDomWrite.nearbyError(document.getElementById('lonely'))`);
  rec('validation: an unrelated error elsewhere on the page is NOT attributed to this field',
      farAway === null, JSON.stringify(farAway));

} catch (e) {
  rec('domwrite harness completed without throwing', false, String(e.message));
} finally {
  await page.close(); cdp.close(); await chrome.close(); srv.close();
}

const pass = results.filter(r => r.ok).length;
const fail = results.filter(r => !r.ok);
console.log('\nDOM writing - real Chrome, real React\n');
for (const r of results) {
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
  if (!r.ok) console.log(`        got: ${String(r.detail).slice(0, 180)}`);
}
console.log(`\n  PASS ${pass}   FAIL ${fail.length}\n`);
fs.mkdirSync('artifacts', { recursive: true });
fs.writeFileSync('artifacts/phase2_domwrite.json', JSON.stringify({ results }, null, 2));
process.exit(fail.length ? 1 : 0);
