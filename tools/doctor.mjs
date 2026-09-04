// Environment doctor. Answers "what state is this checkout in and what do I do
// next" in one command, with no dependencies.
//
// This exists because replacing the folder from the archive silently removes
// .env and node_modules - both gitignored, neither ever in the zip - and the
// resulting failures surface far from the cause.
import fs from 'node:fs';
import path from 'node:path';
import { loadEnv, parseEnvFile } from '../scripts/probe/lib/env.mjs';

const rows = [];
const add = (name, ok, detail, fix, optional = false) => rows.push({ name, ok, detail, fix, optional });

// Are we in the right directory at all?
const nested = path.basename(process.cwd()) === 'voicefill' &&
               path.basename(path.dirname(process.cwd())) === 'voicefill';
add('Working directory', !nested, nested ? `${process.cwd()} - NESTED` : process.cwd(),
    nested ? 'cd .. and work from the outer copy; unzip from the PARENT directory next time' : null);

const hasManifest = fs.existsSync('extension/manifest.json') && fs.existsSync('package.json');
add('Repo files present', hasManifest, hasManifest ? 'extension/ backend/ scripts/ tools/ found' : 'missing core files',
    hasManifest ? null : 'You are not in the repo root. cd into the folder containing package.json');

// .env
const hasEnv = fs.existsSync('.env');
add('.env exists', hasEnv, hasEnv ? '.env found' : 'no .env (it is gitignored and never in the archive)',
    hasEnv ? null : 'cp .env.example .env   then set RIME_API_KEY');

let parsed = {};
if (hasEnv) parsed = parseEnvFile(fs.readFileSync('.env', 'utf8'));
loadEnv({ quiet: true });

const key = process.env.RIME_API_KEY || '';
const keyState = !key ? 'not set'
  : key.includes('xxxx') ? 'still the placeholder'
  : `set (${key.length} chars, ends ${JSON.stringify(key.slice(-4))})`;
add('RIME_API_KEY', !!key && !key.includes('xxxx'), keyState,
    (!key || key.includes('xxxx')) ? 'Get a token at https://app.rime.ai/tokens and put it in .env' : null);

// Shell shadowing
const shadowed = Object.keys(parsed).filter(k => {
  const shellHas = process.env[k] !== undefined && process.env[k] !== parsed[k];
  return shellHas;
});
add('Shell not shadowing .env', shadowed.length === 0,
    shadowed.length ? `SHELL overrides: ${shadowed.join(', ')}` : 'clean',
    shadowed.length ? `unset ${shadowed.join(' ')}` : null);

const speaker = process.env.RIME_SPEAKER || '';
add('RIME_SPEAKER', !!speaker, speaker || 'not set - probes resolve one from the catalog automatically',
    null, true);

// Dependencies
const hasNM = fs.existsSync('node_modules/ws');
add('Dependencies installed', hasNM, hasNM ? 'ws present' : 'node_modules missing or incomplete',
    hasNM ? null : 'npm install   (auth diagnostics work without it; /ws3 probes do not)');

// Artifacts from a previous run
const art = 'artifacts/preflight';
const clips = fs.existsSync(art) ? fs.readdirSync(art).filter(f => f.endsWith('.mp3')) : [];
add('Preflight artifacts', true, clips.length ? `${clips.length} clips in ${art}` : 'none yet (run npm run preflight)', null);

// Report
const w = Math.max(...rows.map(r => r.name.length));
console.log('\nVoiceFill doctor\n');
for (const r of rows) {
  const tag = r.ok ? 'ok  ' : r.optional ? '--  ' : 'FIX ';
  console.log(`  ${tag} ${r.name.padEnd(w)}  ${r.detail}`);
  if (r.fix) console.log(`       ${' '.repeat(w)}  -> ${r.fix}`);
}

const blockers = rows.filter(r => !r.ok && !r.optional);
console.log('');
if (!blockers.length) {
  console.log('  Ready. Next:  npm run auth   then   npm run preflight\n');
} else {
  console.log(`  ${blockers.length} thing(s) to fix, in order:\n`);
  blockers.forEach((b, i) => console.log(`    ${i + 1}. ${b.fix || b.detail}`));
  console.log('');
}
process.exit(blockers.length ? 1 : 0);
