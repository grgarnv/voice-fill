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

/**
 * Strip comments before checking for forbidden API use. Without this the check
 * fires on the comment that documents the restriction, which is a check that
 * can only be satisfied by deleting the explanation.
 */
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

const offCode = stripComments(off);
const conCode = stripComments(con);

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

// ---- Phase 1 additions: the other three message directions ----------------
//
// The original file checked popup->background and background->offscreen only.
// Phase 1 added background->content, content->background and offscreen->
// background, and a typo in any of those fails exactly as silently: the
// sendMessage promise simply never resolves.

const sentToContent = [...bg.matchAll(/toContent\([^,]+,\s*\{\s*type:\s*'([A-Z_]+)'/g)].map(m => m[1]);
for (const m of sentToContent) {
  if (!conHandles.has(m)) errs.push(`background sends ${m} to the content script, which does not handle it`);
}

// The content script must answer these, and must return true to keep the
// message channel open for its async reply.
for (const required of ['VF_SCAN', 'VF_FOCUS_FIELD', 'VF_CLEAR_FOCUS']) {
  if (!conHandles.has(required)) errs.push(`content script does not handle ${required}`);
}
if (!/return true/.test(conCode)) errs.push('content listener does not return true - async sendResponse will be dropped');

// Offscreen and content both message the service worker; every type they send
// must be handled there.
for (const m of sent(off)) {
  if (m.startsWith('VF_') && !bgHandles.has(m)) errs.push(`offscreen sends ${m}, background does not handle it`);
}
for (const m of sent(con)) {
  if (m.startsWith('VF_') && !bgHandles.has(m)) errs.push(`content script sends ${m}, background does not handle it`);
}

// The offscreen document's API surface is limited to chrome.runtime. Reading
// chrome.storage there throws "Cannot read properties of undefined", and the
// session dies before the socket is ever opened.
if (/chrome\.storage/.test(offCode)) {
  errs.push('offscreen uses chrome.storage - not available in an offscreen document; pass config from background');
}
if (/chrome\.tabs/.test(offCode)) {
  errs.push('offscreen uses chrome.tabs - not available in an offscreen document; route via background');
}

// Every utterance must carry a contextId, or the Phase 3 stale-drop has
// nothing to filter on.
if (!/contextId/.test(offCode)) errs.push('offscreen never sets a contextId - stale-chunk dropping cannot work');
if (!/operation:\s*'flush'/.test(offCode)) errs.push("offscreen never flushes - under segment=never nothing is ever synthesised");

// A message literal with two `type:` keys: the second silently wins, the
// message type becomes something like 'text', and no handler ever matches.
// This shipped once, in the VF_WRITE_FIELD relay, and cost a debugging cycle.
for (const [file, src] of [['background', bg], ['offscreen', off], ['content', con], ['popup', pop]]) {
  const literals = src.match(/\{[^{}]*\btype:\s*'[A-Z_]+'[^{}]*\}/g) || [];
  for (const lit of literals) {
    const n = (lit.match(/\btype:/g) || []).length;
    if (n > 1) errs.push(`${file}: message literal has ${n} 'type:' keys - the later one overwrites the message type: ${lit.replace(/\s+/g, ' ').slice(0, 90)}`);
  }
}

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
