// Phase 1 exit criterion: read real, unmodified third-party forms.
//
// These are live sites the scanner has never been tuned against. Network
// failure is reported BLOCKED, never FAIL - the project's existing convention,
// and the distinction matters: "the site was down" is not "the code is wrong".
import fs from 'node:fs';
import { launchChrome, CDP, newPage } from './cdp.mjs';

const SHARED = ['extension/shared/fieldgraph.js', 'extension/shared/prompts.js']
  .map(f => fs.readFileSync(f, 'utf8')).join('\n;\n');

// minFields is a floor, not an exact count: these pages change without notice,
// and an exact count would make the suite fail for the wrong reason.
const SITES = [
  { name: 'selenium.dev web-form',   url: 'https://www.selenium.dev/selenium/web/web-form.html', minFields: 10, mustFind: ['Text input', 'Password', 'Dropdown (select)'] },
  { name: 'httpbin pizza order',     url: 'https://httpbin.org/forms/post',                      minFields: 6,  mustFind: ['Customer name'] },
  { name: 'GitHub login (strict CSP)', url: 'https://github.com/login',                          minFields: 2,  mustFind: ['Username or email address', 'Password'] },
  { name: 'Wikipedia create account', url: 'https://en.wikipedia.org/w/index.php?title=Special:CreateAccount', minFields: 3, mustFind: [] },
  { name: 'demoqa practice form (React)', url: 'https://demoqa.com/automation-practice-form',    minFields: 6,  mustFind: [] },
  { name: 'expandtesting register',  url: 'https://practice.expandtesting.com/register',         minFields: 3,  mustFind: [] },
  { name: 'GOV.UK HMRC sign-in',     url: 'https://www.gov.uk/log-in-register-hmrc-online-services', minFields: 0, mustFind: [] },
];

const results = [];

async function inspect(page, site) {
  let how;
  try {
    how = await page.goto(site.url, { waitMs: 3000, timeoutMs: 35000 });
  } catch (e) {
    return { ...site, status: 'BLOCKED', note: `navigation failed: ${String(e.message).slice(0, 80)}` };
  }

  let data;
  try {
    await page.eval(SHARED);
    data = await page.eval(`(() => {
      const g = VFFieldGraph.scan(document);
      return {
        title: document.title.slice(0, 60),
        url: location.href.slice(0, 90),
        skipped: g.skipped,
        fields: g.fields.map(f => ({
          id: f.id, label: f.label, labelSource: f.labelSource, type: f.type,
          required: f.required, optionCount: f.optionCount,
          prompt: VFPrompts.promptFor(f), intent: VFPrompts.classify(f),
        })),
      };
    })()`);
  } catch (e) {
    return { ...site, status: 'BLOCKED', note: `injection/scan failed: ${String(e.message).slice(0, 90)}` };
  }

  const f = data.fields;
  const unlabelled = f.filter(x => !x.label);
  const problems = [];

  if (f.length < site.minFields) problems.push(`only ${f.length} fields, expected >= ${site.minFields}`);
  for (const want of site.mustFind) {
    if (!f.some(x => (x.label || '').toLowerCase().includes(want.toLowerCase()))) problems.push(`missing "${want}"`);
  }
  // The read-aloud quality gates.
  const junk = f.filter(x => /undefined|null|NaN|\[object/i.test(x.prompt));
  if (junk.length) problems.push(`${junk.length} junk prompts (e.g. "${junk[0].prompt.slice(0, 50)}")`);
  const dupes = f.length - new Set(f.map(x => x.id)).size;
  if (dupes) problems.push(`${dupes} duplicate field ids`);
  const unlabelledRate = f.length ? unlabelled.length / f.length : 0;
  if (f.length >= 4 && unlabelledRate > 0.34) problems.push(`${Math.round(unlabelledRate * 100)}% unlabelled`);
  // A prompt that is only punctuation cannot be answered.
  const tooShort = f.filter(x => (x.prompt || '').replace(/<\d+>/g, '').trim().length < 8);
  if (tooShort.length) problems.push(`${tooShort.length} prompts under 8 chars`);

  const sources = {};
  for (const x of f) sources[x.labelSource] = (sources[x.labelSource] || 0) + 1;

  return {
    ...site, status: problems.length ? 'FAIL' : 'PASS', how,
    title: data.title, finalUrl: data.url,
    fieldCount: f.length, unlabelled: unlabelled.length, sources,
    skipped: data.skipped, problems, sample: f.slice(0, 6),
  };
}

const chrome = await launchChrome({ headless: true });
const cdp = await new CDP(chrome.browserWsUrl).connect();
const page = await newPage(cdp);

try {
  for (const s of SITES) results.push(await inspect(page, s));
} finally {
  await page.close(); cdp.close(); await chrome.close();
}

console.log(`\nReal third-party forms - Chrome ${chrome.version.Browser}\n`);
for (const r of results) {
  console.log(`  ${r.status.padEnd(7)} ${r.name}`);
  if (r.status === 'BLOCKED') { console.log(`          ${r.note}`); continue; }
  console.log(`          ${r.fieldCount} fields, ${r.unlabelled} unlabelled  ${JSON.stringify(r.sources)}`);
  console.log(`          skipped: ${JSON.stringify(r.skipped)}`);
  for (const p of r.problems) console.log(`          PROBLEM: ${p}`);
  for (const s of r.sample) {
    console.log(`            - [${s.type}${s.required ? '/req' : ''}] "${s.label ?? '(none)'}" (${s.labelSource}) -> ${s.prompt.replace(/\s+/g, ' ').slice(0, 90)}`);
  }
}
const pass = results.filter(r => r.status === 'PASS').length;
const fail = results.filter(r => r.status === 'FAIL');
const blocked = results.filter(r => r.status === 'BLOCKED');
console.log(`\n  PASS ${pass}   FAIL ${fail.length}   BLOCKED ${blocked.length}\n`);
fs.mkdirSync('artifacts', { recursive: true });
fs.writeFileSync('artifacts/phase1_real_forms.json', JSON.stringify({ browser: chrome.version.Browser, results }, null, 2));
process.exit(fail.length ? 1 : 0);
