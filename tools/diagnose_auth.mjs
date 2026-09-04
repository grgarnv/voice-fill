// Auth diagnostic. Isolates WHY a 401 is happening without ever printing the key.
//
// Rime's documented 401 bodies:
//   "missing headers"  -> no Authorization header was sent
//   "invalid api key"  -> token not recognised, or sent without the Bearer scheme
// The header is always "Authorization: Bearer <token>", capital B, for HTTP,
// WebSocket and metadata endpoints alike.
import { loadEnv } from '../scripts/probe/lib/env.mjs';
loadEnv();
import fs from 'node:fs';

const URL_TTS = process.env.RIME_REST_URL || 'https://users.rime.ai/v1/rime-tts';
const raw = process.env.RIME_API_KEY;

console.log('=== key metadata (value never printed) ===');
if (!raw) { console.log('  RIME_API_KEY is undefined. Is .env in the repo root, next to package.json?'); process.exit(1); }

const issues = [];
const show = (k, v) => console.log(`  ${k.padEnd(26)} ${v}`);
show('length', raw.length);
show('first 6', JSON.stringify(raw.slice(0, 6)));
show('last 4', JSON.stringify(raw.slice(-4)));
show('leading whitespace', /^\s/.test(raw) ? 'YES <- strip it' : 'no');
show('trailing whitespace', /\s$/.test(raw) ? 'YES <- strip it' : 'no');
show('internal whitespace', /\s/.test(raw.trim()) ? 'YES <- key was line-wrapped on paste' : 'no');
show('wrapping quotes', /^["'].*["']$/.test(raw) ? 'YES <- remove quotes from .env' : 'no');
show('contains "Bearer"', /bearer/i.test(raw) ? 'YES <- .env should hold the token ONLY' : 'no');
show('non-ASCII chars', /[^\x20-\x7e]/.test(raw) ? 'YES <- smart quotes or a stray newline' : 'no');
show('is the placeholder', /^rime_sk_x+$/i.test(raw) || raw.includes('xxxx') ? 'YES <- .env.example was never filled in' : 'no');

if (/^\s|\s$/.test(raw)) issues.push('whitespace around the key');
if (/^["'].*["']$/.test(raw)) issues.push('quotes around the key in .env');
if (/bearer/i.test(raw)) issues.push('"Bearer" included in the key value');
if (/[^\x20-\x7e]/.test(raw)) issues.push('non-ASCII characters in the key');
if (raw.includes('xxxx')) issues.push('placeholder key');

// Check the .env line itself for the classic mistakes.
if (fs.existsSync('.env')) {
  const line = fs.readFileSync('.env', 'utf8').split('\n').find(l => l.trim().startsWith('RIME_API_KEY'));
  if (line) {
    console.log('\n=== .env line shape (value redacted) ===');
    const redacted = line.replace(/=(.*)$/, (m, v) => '=' + '<' + v.length + ' chars>');
    show('as parsed', JSON.stringify(redacted));
    if (/=\s/.test(line)) issues.push('space after the = in .env');
    if (line.includes('#')) issues.push('trailing comment on the .env line (dotenv keeps it unless quoted)');
  }
} else {
  console.log('\n  NOTE: no .env file in this directory. The key is coming from the shell environment.');
}

// Short-circuit before touching the network: if the key is the shipped
// placeholder, three live requests tell us nothing we do not already know.
if (raw.includes('xxxx') || /^rime_sk_x+$/i.test(raw)) {
  console.log('\n=== verdict ===');
  console.log('  RIME_API_KEY is still the placeholder from .env.example.');
  console.log('  Nothing else is wrong. Get a token at https://app.rime.ai/tokens,');
  console.log('  then replace the whole value in .env:');
  console.log('');
  console.log('      RIME_API_KEY=rime_<your actual token>');
  console.log('');
  console.log('  Then re-run:  npm run auth');
  process.exit(1);
}

// Three-way probe: this triad tells us definitively where the fault lies.
const body = JSON.stringify({ text: 'auth check', speaker: process.env.RIME_SPEAKER || 'abbie', modelId: 'mistv2', lang: 'eng' });
const call = async (label, headers) => {
  try {
    const res = await fetch(URL_TTS, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'audio/mpeg', ...headers }, body });
    const ct = res.headers.get('content-type') || '';
    const txt = ct.includes('audio') ? `<${res.headers.get('content-length') || '?'} bytes of audio>` : (await res.text()).slice(0, 120);
    console.log(`  ${label.padEnd(34)} ${res.status}  ${txt}`);
    return { status: res.status, txt };
  } catch (e) {
    console.log(`  ${label.padEnd(34)} network error: ${e.message}`);
    return { status: 0, txt: e.message };
  }
};

console.log('\n=== live auth triad ===');
const none = await call('no Authorization header', {});
const noScheme = await call('token without "Bearer "', { Authorization: raw.trim() });
const bearer = await call('Bearer + token (what we send)', { Authorization: `Bearer ${raw.trim()}` });
const trimmed = raw !== raw.trim() ? await call('Bearer + TRIMMED token', { Authorization: `Bearer ${raw.trim()}` }) : null;

console.log('\n=== verdict ===');
if (bearer.status === 200) {
  console.log('  Bearer + token WORKS. If the probes still fail, they are sending a different value');
  console.log('  than this script - check for a stale shell export shadowing .env:  env | grep RIME_API_KEY');
} else if (none.txt.includes('missing headers') && bearer.txt.includes('invalid api key')) {
  console.log('  The header IS being sent correctly (no-header returns "missing headers",');
  console.log('  ours returns "invalid api key"). The header is fine; THE TOKEN VALUE IS REJECTED.');
  console.log('  Causes, in order of likelihood:');
  console.log('    1. The token was truncated or mistyped on paste - regenerate at https://app.rime.ai/tokens');
  console.log('    2. The token was revoked, or belongs to a different account/environment');
  console.log('    3. A stale shell export is shadowing .env  ->  env | grep RIME_API_KEY');
  if (issues.length) console.log(`    4. Formatting problems detected above: ${issues.join('; ')}`);
} else if (bearer.status === 0) {
  console.log('  Could not reach the API at all. Network, not auth.');
} else {
  console.log(`  Unexpected: no-header=${none.status}/"${none.txt}", bearer=${bearer.status}/"${bearer.txt}"`);
}
if (issues.length) console.log(`\n  Formatting issues found in the key: ${issues.join('; ')}`);
