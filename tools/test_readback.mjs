// PRD Phase 2 exit metric: the 20-item read-back round-trip.
//
//   "a 20-item read-back round-trip (Rime -> STT) >= 90% exact match"
//
// What is actually measured, end to end, with nothing simulated:
//
//   value -> read-back text -> REAL Rime synthesis (pcm 24kHz, the format the
//   product ships) -> REAL STT (whisper.cpp) -> extraction -> compare to the
//   original value, exact.
//
// Two arms, identical except for how the VALUE is rendered, which is the whole
// point:
//   naive  the value read as-is ("160071")
//   tuned  the normalisation under test ("one six, <300> zero zero, <300> seven one")
//
// Extraction is the same for both arms, so the delta isolates pronunciation
// control rather than measuring the parser twice.
//
// Both arms are wrapped in the REAL confirmation carrier - "Let me read that
// back. <value>. Is that correct?" - because that is what the product speaks and
// therefore the only one worth measuring. Synthesising a bare value tests
// something no user ever hears, and it is measurably harsher: an
// utterance-initial letter gets clipped ("M as in Mike" came back as "And as
// of"), which cost identifiers 2/5 on an artefact of the test rather than of
// the read-back. Measured side by side on the identifier set: bare 3/5,
// carrier 5/5.
//
// Every clip is written to eval/clips/ so the numbers can be re-checked by ear.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadEnv } from '../scripts/probe/lib/env.mjs';
loadEnv();
import WebSocket from 'ws';
import { pcmToWav, sttConfig, sttAvailable } from '../backend/stt.mjs';

const exec = promisify(execFile);

/* ------------------------------------------------- load the shared module -- */
const ctx = vm.createContext({ console });
ctx.globalThis = ctx;
vm.runInContext(fs.readFileSync('extension/shared/normalize.js', 'utf8'), ctx, { filename: 'normalize.js' });
const N = ctx.VFNormalize;
// The clips are rendered with pauseBetweenBrackets on, exactly as the proxy
// opens the socket, so the tokens become silence rather than words.
const PAUSE_TOKENS = /^mist/.test(process.env.RIME_MODEL_ID || 'coda');   // the proxy's policy: Coda renders any <N> as ~0.9 s
N.setPauseEnabled(PAUSE_TOKENS);

/* ------------------------------------------------------------- corpus ----- */
//
// 20 items across the intents that confirmation read-back exists for - the
// values where a single wrong character costs the user the submission.
const CORPUS = [
  // PINs and postal codes
  { value: '160071', intent: 'postal' },
  { value: '482913', intent: 'postal' },
  { value: '900001', intent: 'postal' },
  { value: '4821',   intent: 'postal' },
  { value: '070707', intent: 'postal' },
  // alphanumeric identifiers - the confusable-letter case
  { value: 'SF7K0B2Q', intent: 'idnumber' },
  { value: 'BD8PM3',   intent: 'idnumber' },
  { value: 'A1B2C3',   intent: 'idnumber' },
  { value: 'MN4XZ9',   intent: 'idnumber' },
  { value: 'QK52TG',   intent: 'idnumber' },
  // phone numbers
  { value: '5551234567',  intent: 'phone' },
  { value: '02079460958', intent: 'phone' },
  { value: '7700900123',  intent: 'phone' },
  { value: '4155550132',  intent: 'phone' },
  { value: '8005550199',  intent: 'phone' },
  // dates
  { value: '2026-06-14', intent: 'dob' },
  { value: '1984-03-02', intent: 'dob' },
  { value: '1999-12-31', intent: 'dob' },
  { value: '2001-09-08', intent: 'dob' },
  { value: '1970-01-01', intent: 'dob' },
];

/* --------------------------------------------------------------- rime ----- */

const RATE = 24000;   // the product's own format; whisper.cpp resamples on read

function synth(text) {
  return new Promise((resolve, reject) => {
    const u = new URL(process.env.RIME_WS_URL || 'wss://users-ws.rime.ai/ws3');
    u.searchParams.set('speaker', process.env.RIME_SPEAKER || 'abbie');
    u.searchParams.set('modelId', process.env.RIME_MODEL_ID || 'coda');
    u.searchParams.set('audioFormat', 'pcm');
    u.searchParams.set('lang', process.env.RIME_LANG || 'eng');
    u.searchParams.set('samplingRate', String(RATE));
    u.searchParams.set('segment', 'never');
    if (PAUSE_TOKENS) u.searchParams.set('pauseBetweenBrackets', 'true');
    const ws = new WebSocket(u.toString(), {
      headers: { Authorization: `Bearer ${process.env.RIME_API_KEY}` }, handshakeTimeout: 15000,
    });
    const parts = [];
    let settled = false;
    const finish = () => { if (settled) return; settled = true; try { ws.close(); } catch {} resolve(Buffer.concat(parts)); };
    ws.on('open', () => {
      ws.send(JSON.stringify({ text, contextId: 'readback' }));
      ws.send(JSON.stringify({ operation: 'flush' }));
    });
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.type === 'chunk' && typeof m.data === 'string') parts.push(Buffer.from(m.data, 'base64'));
      if (/^done$/i.test(m.type || '')) finish();
    });
    ws.on('error', (e) => { if (!settled) { settled = true; reject(e); } });
    setTimeout(finish, 45000);
  });
}

/* -------------------------------------------------------------- whisper --- */

async function transcribe(wavPath) {
  const c = sttConfig();
  const { stdout } = await exec(c.bin, ['-m', c.model, '-f', wavPath, '-nt', '-np', '-l', 'en', '-t', '6'],
    { timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  return String(stdout || '').replace(/\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim();
}

/* ----------------------------------------------------------------- run ---- */

if (!sttAvailable()) {
  console.error('\nBLOCKED: no STT configured.\n' +
    '  brew install whisper-cpp\n' +
    '  export WHISPER_MODEL=/path/to/ggml-base.en.bin\n');
  process.exit(2);
}

const CLIPS = 'eval/clips';
for (const arm of ['naive', 'tuned']) fs.mkdirSync(path.join(CLIPS, arm), { recursive: true });

const rows = [];
let i = 0;
for (const item of CORPUS) {
  i++;
  const row = { ...item, n: i };
  for (const arm of ['naive', 'tuned']) {
    const rendered = arm === 'naive' ? String(item.value) : N.toSpeech(item.value, item.intent);
    // Identical to the template in extension/offscreen/player.js.
    const text = `Let me read that back. <300> ${rendered}. <400> Is that correct?`;
    let pcm;
    try { pcm = await synth(text); }
    catch (e) { row[arm] = { text, error: String(e.message), match: false }; continue; }

    const base = `${String(i).padStart(2, '0')}_${item.intent}_${item.value.replace(/[^A-Za-z0-9]/g, '')}`;
    const wavPath = path.join(CLIPS, arm, `${base}.wav`);
    fs.writeFileSync(wavPath, pcmToWav(pcm, RATE));

    let transcript = '';
    try { transcript = await transcribe(wavPath); }
    catch (e) { transcript = `__stt_error__ ${String(e.message).slice(0, 80)}`; }

    // Strip the carrier before extraction - the session knows it said it.
    const body = transcript
      .replace(/^\W*(let me read that back|got it|i heard)[.,!:]?\s*/i, '')
      .replace(/\s*(is that )?correct\s*\??\s*$/i, '');
    const extracted = N.fromSpeech(body, {}, item.intent).value;
    row[arm] = {
      text, rendered, transcript, body, extracted,
      match: String(extracted ?? '') === String(item.value),
      seconds: +(pcm.length / (RATE * 2)).toFixed(2),
      clip: wavPath,
    };
  }
  const mark = (a) => (row[a]?.match ? 'MATCH' : 'miss ');
  console.log(`  ${String(i).padStart(2)}. ${item.intent.padEnd(9)} ${item.value.padEnd(12)} ` +
              `naive ${mark('naive')}  tuned ${mark('tuned')}   ` +
              `tuned heard: "${String(row.tuned?.body ?? '').slice(0, 44)}"`);
  rows.push(row);
}

const rate = (arm) => rows.filter(r => r[arm]?.match).length;
const naiveHits = rate('naive'), tunedHits = rate('tuned');
const pct = (n) => `${((n / rows.length) * 100).toFixed(0)}%`;

// The model is a property of the measurement and must appear beside the number.
console.log(`\n  Read-back round trip - real Rime -> real STT (whisper.cpp ${path.basename(sttConfig().model)})\n`);
console.log(`    items                 ${rows.length}`);
console.log(`    naive  exact match    ${naiveHits}/${rows.length}  ${pct(naiveHits)}`);
console.log(`    tuned  exact match    ${tunedHits}/${rows.length}  ${pct(tunedHits)}`);
console.log(`    PRD exit bar          >= 90%`);
console.log(`    verdict               ${tunedHits / rows.length >= 0.9 ? 'PASS' : 'FAIL'}\n`);

const byIntent = {};
for (const r of rows) {
  const b = byIntent[r.intent] || (byIntent[r.intent] = { n: 0, naive: 0, tuned: 0 });
  b.n++; if (r.naive?.match) b.naive++; if (r.tuned?.match) b.tuned++;
}
console.log('    by intent:');
for (const [k, v] of Object.entries(byIntent)) {
  console.log(`      ${k.padEnd(9)} naive ${v.naive}/${v.n}   tuned ${v.tuned}/${v.n}`);
}

const misses = rows.filter(r => !r.tuned?.match);
if (misses.length) {
  console.log('\n    tuned misses:');
  for (const m of misses) {
    console.log(`      ${m.value} (${m.intent})`);
    console.log(`        spoke:     ${m.tuned?.text}`);
    console.log(`        heard:     ${m.tuned?.transcript}`);
    console.log(`        body:      ${m.tuned?.body}`);
    console.log(`        extracted: ${JSON.stringify(m.tuned?.extracted)}`);
  }
}

fs.mkdirSync('artifacts', { recursive: true });
fs.writeFileSync('artifacts/phase2_readback.json', JSON.stringify({
  model: sttConfig().model, speaker: process.env.RIME_SPEAKER, rimeModel: process.env.RIME_MODEL_ID,
  items: rows.length, naiveHits, tunedHits, byIntent, rows,
}, null, 2));
console.log(`\n  clips: ${CLIPS}/{naive,tuned}/   raw: artifacts/phase2_readback.json\n`);
process.exit(tunedHits / rows.length >= 0.9 ? 0 : 1);
