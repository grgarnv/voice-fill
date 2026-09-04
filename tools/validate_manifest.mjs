// MV3 manifest validation. Catches the mistakes that make Chrome refuse to load
// the unpacked extension - which, on a hackathon clock, is an expensive way to
// find out you typo'd a permission.
import fs from 'node:fs';
const m = JSON.parse(fs.readFileSync('extension/manifest.json', 'utf8'));
const errs = [], warns = [];

if (m.manifest_version !== 3) errs.push('manifest_version must be 3');
if (!m.name || !m.version) errs.push('name and version are required');
if (m.background?.scripts) errs.push('MV3 forbids background.scripts; use background.service_worker');
if (!m.background?.service_worker) errs.push('missing background.service_worker');

const VALID = new Set(['offscreen','activeTab','scripting','storage','tabs','alarms','tabCapture',
  'declarativeNetRequest','clipboardWrite','contextMenus','notifications','unlimitedStorage','webNavigation']);
for (const p of m.permissions || []) if (!VALID.has(p)) warns.push(`permission "${p}" not in the known-good list - verify`);
if (!(m.permissions || []).includes('offscreen')) errs.push('offscreen permission required for the offscreen document');

for (const h of m.host_permissions || []) {
  if (!/^(\*|https?|wss?|file|ftp):\/\//.test(h) && h !== '<all_urls>') errs.push(`bad host_permission "${h}"`);
}
for (const cs of m.content_scripts || []) {
  if (!cs.matches?.length) errs.push('content_scripts entry without matches');
  for (const f of cs.js || []) if (!fs.existsSync(`extension/${f}`)) errs.push(`content script file missing: ${f}`);
}
if (m.action?.default_popup && !fs.existsSync(`extension/${m.action.default_popup}`)) errs.push(`popup missing: ${m.action.default_popup}`);
if (!fs.existsSync(`extension/${m.background.service_worker}`)) errs.push(`service worker missing: ${m.background.service_worker}`);
for (const w of m.web_accessible_resources || []) for (const r of w.resources || [])
  if (!fs.existsSync(`extension/${r}`)) errs.push(`web_accessible_resource missing: ${r}`);
if (!fs.existsSync('extension/offscreen/offscreen.html')) errs.push('offscreen/offscreen.html missing');

console.log(errs.length ? 'MANIFEST ERRORS:' : 'manifest: valid MV3');
errs.forEach(e => console.log('  ERROR  ' + e));
warns.forEach(w => console.log('  warn   ' + w));
process.exit(errs.length ? 1 : 0);
