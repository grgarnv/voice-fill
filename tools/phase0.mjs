// One command: check the checkout, run the full preflight, write PHASE0_RESULTS.md.
// The ear checks stay manual by design - a byte difference is not a pronunciation.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const run = (args) => spawnSync('node', args, { stdio: 'inherit' });

console.log('\n─── 1/3  checkout state ───');
if (run(['tools/doctor.mjs']).status !== 0) {
  console.error('\nFix the items above, then re-run:  npm run phase0\n');
  process.exit(1);
}

console.log('\n─── 2/3  preflight against real Rime ───');
run(['scripts/probe/run_all.mjs']);

console.log('\n─── 3/3  results ───');
const p = 'artifacts/preflight/preflight.json';
if (!fs.existsSync(p)) { console.error('No preflight.json produced.'); process.exit(1); }
const r = JSON.parse(fs.readFileSync(p, 'utf8'));
const by = id => r.results.find(x => x.id === id);
const cell = x => x ? `${x.status} — ${String(x.detail.note || '').replace(/\s+/g, ' ').slice(0, 300)}` : 'not run';

const clips = fs.existsSync('artifacts/preflight')
  ? fs.readdirSync('artifacts/preflight').filter(f => f.endsWith('.mp3')).sort() : [];

const p04 = by('04')?.detail || {};
const ttfa = p04.pcm ? `cold ${p04.pcm.ttfaColdMs?.toFixed(0)}ms / warm ${p04.pcm.ttfaWarmMs?.toFixed(0) ?? 'n/a'}ms (pcm)` : 'not measured';

const doc = `# Phase 0 results

Generated ${new Date().toISOString()} by \`npm run phase0\`.
Speaker \`${process.env.RIME_SPEAKER || by('00')?.detail?.chosen || '?'}\`, model \`${process.env.RIME_MODEL_ID || 'mistv2'}\`, lang \`eng\`.

## Probe results

| Probe | Result |
|---|---|
| 0A Credential accepted | ${cell(by('0A'))} |
| 00 Catalog / speaker | ${cell(by('00'))} |
| 01 REST synthesis | ${cell(by('01'))} |
| 02 phonemizeBetweenBrackets | ${cell(by('02'))} |
| 03 pause + phoneme combined | ${cell(by('03'))} |
| 04 /ws3 chunks + timestamps | ${cell(by('04'))} |
| 05 clear cancels queued synthesis | ${cell(by('05'))} |
| 06 contextId echoed on chunks | ${cell(by('06'))} |

Totals: **${r.pass} PASS, ${r.fail} FAIL, ${r.blocked} BLOCKED**

Time to first audio: ${ttfa}

## Ear checks — REQUIRED, still outstanding

A passing probe means the bytes differed. It does not mean the pronunciation is
right; \`phonemizeBetweenBrackets\` is silently ignored on the wrong model and
still returns 200 with audio. Listen to these and tick them off by hand:

${clips.length ? clips.map(c => `- [ ] \`artifacts/preflight/${c}\``).join('\n') : '- (no clips produced)'}

What to listen for:
- \`02_flagON_bracketed.mp3\` — the invented word spoken as speech, no bracket characters read aloud.
- \`02_flagOFF_bracketed.mp3\` — same text, flag off. Must sound clearly WORSE. If identical, the flag is being ignored.
- \`03_pause_plus_phoneme.mp3\` — a real gap after "one six zero", a spoken name, no literal "300".

## Exit criteria

| # | Criterion | Status |
|---|---|---|
| E1 | test.mp3 plays on a strict-CSP page | manual — RUNBOOK step 11 |
| E2 | Rime says a phonemized word correctly | ${by('02')?.status === 'PASS' ? 'probe green, EAR CHECK OUTSTANDING' : 'FAILED'} |
| E3 | /ws3 returns timestamps | ${by('04')?.status ?? 'not run'} |
| E4 | Preflight green | ${r.fail === 0 && r.blocked === 0 ? 'PASS' : `${r.fail} FAIL, ${r.blocked} BLOCKED`} |

**Phase 0 verdict: ${r.fail === 0 && r.blocked === 0 ? 'probes green — pending ear checks and E1' : 'NOT COMPLETE'}**
`;

fs.writeFileSync('PHASE0_RESULTS.md', doc);
console.log(`\nWrote PHASE0_RESULTS.md  (${r.pass} PASS, ${r.fail} FAIL, ${r.blocked} BLOCKED)`);
console.log(`Now do the ear checks:  open artifacts/preflight/`);
console.log(`Then RUNBOOK step 9-11 for the Chrome half.\n`);
