// Run a single probe: npm run probe 05
import { loadEnv } from './lib/env.mjs';
import { flush, record } from './lib/report.mjs';
import { checkAuth } from './lib/authcheck.mjs';
loadEnv();

const id = (process.argv[2] || '').replace(/^0*/, '').padStart(2, '0');
const files = {
  '00': '00_catalog.mjs', '01': '01_tts_rest.mjs', '02': '02_phonemize_brackets.mjs',
  '03': '03_pause_plus_phoneme.mjs', '04': '04_ws3_timestamps.mjs',
  '05': '05_clear.mjs', '06': '06_context_tagging.mjs',
};
if (!files[id]) {
  console.error(`Usage: npm run probe <id>\nAvailable: ${Object.keys(files).join(' ')}`);
  process.exit(2);
}

const auth = await checkAuth();
if (!auth.ok) { record('0A', 'Credential accepted by Rime', auth.status, { note: auth.note }); flush(`preflight-${id}.json`); process.exit(2); }

const state = { speaker: process.env.RIME_SPEAKER || '' };

// If no speaker is configured, resolve one from the live catalog instead of
// dead-ending. Telling someone to go run another command, when this command
// could just run it, is a bad tool.
if (!state.speaker && id !== '00') {
  console.log('RIME_SPEAKER not set - resolving from the live catalog first.\n');
  const { results } = await import('./lib/report.mjs');
  await (await import('./00_catalog.mjs')).default(state);
  const c0 = results.find(r => r.id === '00');
  if (c0?.status === 'PASS' && c0.detail.chosen) {
    state.speaker = c0.detail.chosen;
    state.fallback = c0.detail.fallback ?? null;
    console.log(`        -> using speaker: ${state.speaker}`);
    console.log(`        (add to .env to skip this step:  RIME_SPEAKER=${state.speaker}` +
                (state.fallback ? `   RIME_SPEAKER_FALLBACK=${state.fallback}` : '') + ')\n');
  } else {
    console.error('Could not resolve a speaker from the catalog. Set RIME_SPEAKER in .env manually.');
    flush(`preflight-${id}.json`); process.exit(2);
  }
}
await (await import(`./${files[id]}`)).default(state);
flush(`preflight-${id}.json`);
