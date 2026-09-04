// Phase 0 preflight orchestrator. Real Rime only.
//
// Only zero-dependency modules are imported statically here. The probes pull in
// `ws`, so they are imported dynamically AFTER the dependency guard - ESM
// imports are hoisted, so a static import would blow up before the guard could
// print anything useful.
import { loadEnv } from './lib/env.mjs';
import { flush, record, results } from './lib/report.mjs';
import { checkAuth } from './lib/authcheck.mjs';

loadEnv();

console.log('VoiceFill Phase 0 preflight - real Rime endpoints, no mocks.\n');

if (!process.env.RIME_API_KEY) {
  record('--', 'RIME_API_KEY present', 'BLOCKED', { note: 'No RIME_API_KEY. Copy .env.example to .env and set it.' });
  flush(); process.exit(2);
}

// Auth gate first. The catalog endpoint does not authenticate, so probe 00 can
// go green on a dead key; without this gate that turns one credential fault
// into six confusing downstream failures.
const auth = await checkAuth();
record('0A', 'Credential accepted by Rime', auth.status, { note: auth.note });
if (!auth.ok) {
  console.log('\nStopping: every remaining probe would fail for this one reason.');
  console.log('Diagnose the credential with:  npm run auth   (needs no dependencies)');
  flush(); process.exit(2);
}

// Dependency guard, after the auth gate so credential problems are reported
// even on a tree with no node_modules.
try { await import('ws'); } catch {
  console.error('\nThe /ws3 probes need dependencies. Run:  npm install\n');
  flush(); process.exit(2);
}

const state = { speaker: process.env.RIME_SPEAKER || '' };
const load = async f => (await import(`./${f}`)).default;

await (await load('00_catalog.mjs'))(state);

// Adopt whatever probe 00 locked in, so later probes use a catalog-verified speaker.
const c0 = results.find(r => r.id === '00');
if (c0?.status === 'PASS' && c0.detail.chosen) {
  state.speaker = c0.detail.chosen;
  state.fallback = c0.detail.fallback ?? null;
  console.log(`        -> locked speaker: ${state.speaker}\n`);
} else if (!state.speaker) {
  record('--', 'Speaker resolution', 'BLOCKED', { note: 'No speaker from catalog and none in RIME_SPEAKER; downstream probes cannot run.' });
  flush(); process.exit(2);
}

for (const f of ['01_tts_rest.mjs', '02_phonemize_brackets.mjs', '03_pause_plus_phoneme.mjs',
                 '04_ws3_timestamps.mjs', '05_clear.mjs', '06_context_tagging.mjs']) {
  await (await load(f))(state);
}

const s = flush();
console.log(`\nPASS ${s.pass}  FAIL ${s.fail}  BLOCKED ${s.blocked}`);
console.log('Artifacts: artifacts/preflight/  <- LISTEN to the mp3s before calling probes 02/03 green.');
// Write the resolved speaker into .env rather than asking the operator to
// re-type it. A value that must be copied by hand is a value that gets skipped.
if (state.speaker) {
  const fs = await import('node:fs');
  const line = (k, v) => new RegExp(`^${k}=.*$`, 'm');
  try {
    if (fs.existsSync('.env')) {
      let env = fs.readFileSync('.env', 'utf8');
      const set = (k, v) => {
        if (!v) return;
        env = line(k).test(env) ? env.replace(line(k), `${k}=${v}`) : env.trimEnd() + `\n${k}=${v}\n`;
      };
      set('RIME_SPEAKER', state.speaker);
      set('RIME_SPEAKER_FALLBACK', state.fallback);
      fs.writeFileSync('.env', env);
      console.log(`Wrote to .env:  RIME_SPEAKER=${state.speaker}` + (state.fallback ? `  RIME_SPEAKER_FALLBACK=${state.fallback}` : ''));
    } else {
      console.log(`Put this in .env:  RIME_SPEAKER=${state.speaker}` + (state.fallback ? `   RIME_SPEAKER_FALLBACK=${state.fallback}` : ''));
    }
  } catch (e) {
    console.log(`Put this in .env:  RIME_SPEAKER=${state.speaker}  (could not write automatically: ${e.message})`);
  }
}
process.exit(s.fail + s.blocked === 0 ? 0 : 1);
