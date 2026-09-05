// Re-score the SAVED read-back clips with a different STT model.
//
// The audio is byte-identical, so the only variable is the recogniser. That
// isolates how much of the residual miss rate is a property of the read-back
// and how much is a property of the instrument measuring it - a question the
// metric cannot answer on its own.
//
//   node tools/rescore_readback.mjs <model.bin> [<model.bin> ...]
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

const ctx = vm.createContext({ console });
ctx.globalThis = ctx;
vm.runInContext(fs.readFileSync('extension/shared/normalize.js', 'utf8'), ctx, { filename: 'normalize.js' });
const N = ctx.VFNormalize;

const prior = JSON.parse(fs.readFileSync('artifacts/phase2_readback.json', 'utf8'));
const models = process.argv.slice(2);
if (!models.length) { console.error('usage: rescore_readback.mjs <model.bin> ...'); process.exit(2); }

async function transcribe(model, wav) {
  const { stdout } = await exec('whisper-cli', ['-m', model, '-f', wav, '-nt', '-np', '-l', 'en', '-t', '6'],
    { timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  return String(stdout || '').replace(/\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim();
}

const out = {};
for (const model of models) {
  const name = path.basename(model);
  const per = { naive: 0, tuned: 0, n: 0, byIntent: {}, misses: [] };
  for (const row of prior.rows) {
    per.n++;
    const b = per.byIntent[row.intent] || (per.byIntent[row.intent] = { n: 0, naive: 0, tuned: 0 });
    b.n++;
    for (const arm of ['naive', 'tuned']) {
      const clip = row[arm]?.clip;
      if (!clip || !fs.existsSync(clip)) continue;
      const transcript = await transcribe(model, clip);
      const body = transcript
        .replace(/^\W*(let me read that back|got it|i heard)[.,!:]?\s*/i, '')
        .replace(/\s*(is that )?correct\s*\??\s*$/i, '');
      const extracted = N.fromSpeech(body, {}, row.intent).value;
      const match = String(extracted ?? '') === String(row.value);
      if (match) { per[arm]++; b[arm]++; }
      else if (arm === 'tuned') per.misses.push({ value: row.value, intent: row.intent, transcript, extracted });
    }
  }
  out[name] = per;
  const pct = (x) => `${((x / per.n) * 100).toFixed(0)}%`;
  console.log(`\n  ${name}`);
  console.log(`    naive ${per.naive}/${per.n}  ${pct(per.naive)}`);
  console.log(`    tuned ${per.tuned}/${per.n}  ${pct(per.tuned)}   ${per.tuned / per.n >= 0.9 ? 'PASS' : 'FAIL'} against the 90% bar`);
  for (const [k, v] of Object.entries(per.byIntent)) {
    console.log(`      ${k.padEnd(9)} naive ${v.naive}/${v.n}   tuned ${v.tuned}/${v.n}`);
  }
  for (const m of per.misses) {
    console.log(`      miss ${m.value} (${m.intent}) -> ${JSON.stringify(m.extracted)}`);
    console.log(`           heard: ${m.transcript.slice(0, 90)}`);
  }
}

fs.writeFileSync('artifacts/phase2_readback_models.json', JSON.stringify(out, null, 2));
console.log('\n  wrote artifacts/phase2_readback_models.json\n');
