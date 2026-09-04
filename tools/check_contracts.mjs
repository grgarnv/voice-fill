// Static contract check for the extension's message passing. Chrome cannot be
// run in every build environment, and a typo'd message type fails silently at
// runtime (sendMessage just never resolves). This catches that statically.
import fs from 'node:fs';
const read = f => fs.readFileSync(f, 'utf8');
const bg = read('extension/background.js');
const off = read('extension/offscreen/player.js');
const pop = read('extension/popup/popup.js');
const con = read('extension/content/content.js');
const errs = [], notes = [];

const sent = s => [...s.matchAll(/type:\s*'([A-Z_]+)'/g)].map(m => m[1]);
const handled = s => [...s.matchAll(/msg\??\.type === '([A-Z_]+)'|case '([A-Z_]+)'/g)].map(m => m[1] || m[2]);

const bgHandles = new Set(handled(bg));
const offHandles = new Set(handled(off));
const conHandles = new Set(handled(con));

// Popup -> background
for (const m of sent(pop)) {
  if (m.startsWith('VF_') && !bgHandles.has(m) && !conHandles.has(m)) errs.push(`popup sends ${m}, nothing handles it`);
}
// Background -> offscreen
for (const m of sent(bg)) {
  if (m.startsWith('OFF_') && !offHandles.has(m)) errs.push(`background sends ${m}, offscreen does not handle it`);
}
// Offscreen messages must be addressed, or the service worker will swallow them.
if (!/target:\s*'offscreen'/.test(bg)) errs.push("background sends to offscreen without target:'offscreen' - the SW listener will intercept");
if (!/msg\?\.target !== 'offscreen'/.test(off)) errs.push('offscreen does not filter on target - it will answer messages meant for background');
if (!/return true/.test(bg)) errs.push('background listener does not return true - async sendResponse will be dropped');
if (!/return true/.test(off)) errs.push('offscreen listener does not return true - async sendResponse will be dropped');

// Offscreen lifecycle guards
if (!/getContexts/.test(bg)) errs.push('no getContexts guard - createDocument throws if the document already exists');
if (!/creating/.test(bg)) notes.push('concurrent createDocument calls are collapsed via a shared promise');
if (!/AUDIO_PLAYBACK/.test(bg)) errs.push("offscreen reason must be AUDIO_PLAYBACK to keep the document alive during playback");

// Autoplay gesture chain
if (!/addEventListener\('click'/.test(pop)) errs.push('no click handler in popup - nothing establishes the user gesture for autoplay');
if (!/resume\(\)/.test(off)) errs.push('offscreen never resumes a suspended AudioContext');

console.log(errs.length ? 'CONTRACT ERRORS:' : 'extension message contracts: consistent');
errs.forEach(e => console.log('  ERROR  ' + e));
notes.forEach(n => console.log('  note   ' + n));
process.exit(errs.length ? 1 : 0);
