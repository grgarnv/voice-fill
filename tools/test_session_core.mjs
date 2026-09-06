// Phase 3 core, attacked in Node. No browser, no Rime, no microphone.
//
// These are the pieces that must be exactly right: the dialog machine, the
// playback clock across gaps, the heard-word computation, the stale/orphan
// frame filter, in-order transcript release, late timestamps, and the resume
// table. The same file the offscreen document runs is loaded here as a classic
// script, so there is one implementation.
import fs from 'node:fs';
import vm from 'node:vm';

const ctx = vm.createContext({ console, performance, setTimeout, clearTimeout, Date, Promise });
ctx.globalThis = ctx;
for (const f of ['extension/shared/normalize.js', 'extension/shared/session-core.js']) {
  vm.runInContext(fs.readFileSync(f, 'utf8'), ctx, { filename: f });
}
const C = ctx.VFSessionCore, N = ctx.VFNormalize;
const deps = { parseCommand: N.parseCommand, parseYesNo: N.parseYesNo, fromSpeech: N.fromSpeech, matchOption: N.matchOption };

const results = [];
let group = '';
const G = (g) => { group = g; };
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); results.push({ group, name, ok, got, want }); return ok; };
const truthy = (name, got, note = '') => { results.push({ group, name, ok: !!got, got, want: `truthy ${note}` }); return !!got; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ============================== dialog machine ============================ */

G('dialog machine');
{
  const m = new C.DialogMachine();
  eq('starts IDLE', m.state, 'IDLE');
  m.go('CONNECTING').go('READY').go('PROMPTING', 'speak').go('LISTENING', 'barge-in').go('TRANSCRIBING').go('FILLING').go('CONFIRMING').go('LISTENING', 'barge-in on read-back').go('TRANSCRIBING').go('FILLING').go('CONFIRMING').go('TRANSCRIBING', 'yes').go('PROMPTING', 'next');
  eq('the PRD path is legal end to end', m.illegalCount, 0);
  m.go('IDLE', 'disconnect').go('CONNECTING').go('READY');
  eq('disconnect from any state and recovery is legal', m.illegalCount, 0);
  const rc = new C.DialogMachine(); rc.go('CONNECTING').go('READY').go('PROMPTING').go('LISTENING').go('TRANSCRIBING').go('FILLING').go('CONFIRMING').go('IDLE', 'disconnect').go('CONNECTING').go('CONFIRMING', 'ws-reopen').go('CONFIRMING', 'speak:confirm');
  eq('reconnect inside a live session resumes CONFIRMING, and re-speaking the read-back is legal', rc.illegalCount, 0);

  const bad = new C.DialogMachine();
  bad.go('PROMPTING', 'speak without connection');
  eq('IDLE -> PROMPTING is recorded as illegal', bad.illegalCount, 1);
  eq('...but still performed (never wedge the user)', bad.state, 'PROMPTING');
  bad.go('FILLING', 'write while asking');
  eq('PROMPTING -> FILLING is illegal', bad.illegalCount, 2);
  const b2 = new C.DialogMachine(); b2.go('CONNECTING').go('READY').go('LISTENING');
  eq('READY -> LISTENING (capture with no field) is illegal', b2.illegalCount, 1);
  const b3 = new C.DialogMachine(); b3.go('CONNECTING').go('READY').go('PROMPTING').go('LISTENING').go('FILLING');
  eq('LISTENING -> FILLING (write without a transcript) is illegal', b3.illegalCount, 1);
  truthy('history records why', m.history.some(h => h.why === 'barge-in'));
}

/* ============================== playback clock ============================ */

G('playback clock');
{
  const k = new C.PlaybackClock();
  // three 0.5s chunks scheduled gap-free from t=1.0
  k.add(1.0, 0.5, 0.0); k.add(1.5, 0.5, 0.5); k.add(2.0, 0.5, 1.0);
  eq('before start: 0', k.positionAt(0.9), 0);
  eq('inside first chunk', +k.positionAt(1.25).toFixed(3), 0.25);
  eq('inside third chunk', +k.positionAt(2.2).toFixed(3), 1.2);
  eq('after end: clamps to total', +k.positionAt(9).toFixed(3), 1.5);
  eq('no gaps -> no drift', +k.driftAt(2.2).toFixed(3), 0);

  // Network fell behind: the 4th chunk is scheduled 0.8s late
  k.add(3.3, 0.5, 1.5);
  eq('gap is recorded', +k.gapSec.toFixed(3), 0.8);
  eq('inside the gap the position holds at the last played sample', +k.positionAt(3.0).toFixed(3), 1.5);
  eq('after the gap the position resumes from the chunk audio', +k.positionAt(3.4).toFixed(3), 1.6);
  eq('naive clock would be 0.8s ahead (the drift the ledger avoids)', +k.driftAt(3.4).toFixed(3), 0.8);
  eq('scheduledEnd is the last chunk end', +k.scheduledEnd.toFixed(3), 3.8);
}

/* =============================== heard words ============================== */

G('heard words');
{
  // Real Rime shape from the Phase 3 timing probe: pause tokens are timed words.
  const ts = { words: ['Field', '4', 'of', '12.', '<300>', 'What', 'is', 'your', 'postal', 'code?'],
               start: [0, 0.138, 0.277, 0.415, 0.691, 1.383, 1.521, 1.659, 1.798, 1.936],
               end:   [0.138, 0.277, 0.415, 0.691, 1.383, 1.521, 1.659, 1.798, 1.936, 2.489] };
  eq('stopped at 0: nothing heard', C.heardWords(ts, 0).heardText, '');
  eq('stopped at 0.05: only the word that had started', C.heardWords(ts, 0.05).heardText, 'Field');
  const mid = C.heardWords(ts, 1.7);
  eq('mid-sentence: words that started, pause token excluded', mid.heardText, 'Field 4 of 12. What is your');
  eq('the cut word is reported as partial', mid.partial, 'your');
  eq('total counts words, not pause tokens', mid.total, 9);
  eq('inside the pause: nothing new is heard', C.heardWords(ts, 1.0).heardText, 'Field 4 of 12.');
  eq('stopped exactly at end is complete', C.heardWords(ts, 2.5).complete, true);
  eq('no timestamps yet: known=false, never a guess', C.heardWords(null, 1.0).known, false);
  eq('display string, PRD form', C.heardDisplay({ status: 'interrupted', heard: mid, playedSec: 1.7 }), 'Field 4 of 12. What is your— [interrupted]');
  eq('display when nothing heard', C.heardDisplay({ status: 'interrupted', heard: C.heardWords(ts, 0), playedSec: 0 }), '[interrupted before any word was heard]');
  eq('display when words unknown says so', C.heardDisplay({ status: 'interrupted', heard: C.heardWords(null, 0.4), playedSec: 0.4 }), '[interrupted at 0.40s - words unknown]');
}

/* ================================ ledger ================================== */

G('ledger + late timestamps');
{
  const L = new C.Ledger(5);
  L.upsert({ contextId: 'turn-1', kind: 'prompt', status: 'interrupted', playedSec: 0.3, heard: C.heardWords(null, 0.3), text: 'Field 1 of 3. What is your PIN?' });
  eq('entry stored with unknown words', L.get('turn-1').heard.known, false);
  const ts = { words: ['Field', '1', 'of', '3.', 'What', 'is', 'your', 'PIN?'], start: [0, 0.14, 0.28, 0.42, 0.7, 0.84, 0.98, 1.1], end: [0.14, 0.28, 0.42, 0.7, 0.84, 0.98, 1.1, 1.5] };
  const e = L.lateTimestamps('turn-1', ts);
  eq('late timestamps finalise the heard set retroactively', e.heard.heardText, 'Field 1 of');
  eq('...flagged as late', e.lateTimestamps, true);
  eq('...display updated', e.display, 'Field 1 of— [interrupted]');
  eq('late timestamps for an unknown context are ignored', L.lateTimestamps('turn-99', ts), null);
  for (let i = 2; i <= 8; i++) L.upsert({ contextId: `turn-${i}`, kind: 'info', status: 'played' });
  eq('bounded', L.entries.length, 5);
  eq('oldest dropped', L.get('turn-1'), null);
}

/* ============================= frame filter =============================== */

G('frame filter (stale / orphan / no turn)');
{
  const cur = { contextId: 'turn-7', status: 'playing' };
  eq('current context plays', C.chunkDecision('turn-7', cur), 'play');
  eq('previous context is stale, whatever order it arrives in', C.chunkDecision('turn-6', cur), 'stale');
  eq('a FUTURE context id is also stale (never trust ordering)', C.chunkDecision('turn-8', cur), 'stale');
  eq('untagged chunk is an orphan, dropped', C.chunkDecision(null, cur), 'orphan');
  eq('undefined contextId is an orphan too', C.chunkDecision(undefined, cur), 'orphan');
  eq('nothing playing: dropped', C.chunkDecision('turn-7', null), 'noturn');
  eq('turn already interrupted: its own late chunks are dropped', C.chunkDecision('turn-7', { contextId: 'turn-7', status: 'interrupted' }), 'noturn');
  // Phase 0 measured a 192-chunk stale tail arriving in 811ms; simulate it out of order.
  const tail = Array.from({ length: 192 }, (_, i) => `turn-6`).sort(() => Math.random() - 0.5);
  eq('192-chunk stale tail: every one dropped', tail.filter(c => C.chunkDecision(c, cur) === 'stale').length, 192);
}

/* ============================ transcript order ============================ */

G('in-order transcripts');
{
  const seen = [];
  const T = new C.TranscriptOrder();
  T.handler = async (b, text) => { seen.push(`${b.captureId}:${text}`); return { ok: true, text }; };
  const b1 = T.open({ epoch: 1, fieldId: 'f1', source: 'vad' });
  const b2 = T.open({ epoch: 1, fieldId: 'f1', source: 'vad' });
  // The SHORT second capture ("yes") transcribes first.
  const p2 = T.settle(b2.captureId, 'yes');
  await sleep(5);
  eq('the later capture is held until the earlier one settles', seen.length, 0);
  const p1 = T.settle(b1.captureId, 'no its one six zero zero seven two');
  await Promise.all([p1, p2]);
  eq('released strictly in capture order', seen, ['1:no its one six zero zero seven two', '2:yes']);

  const T2 = new C.TranscriptOrder(); const s2 = [];
  T2.handler = async (b, t) => { s2.push(t); return { ok: true }; };
  const a = T2.open({}), b = T2.open({});
  const pb = T2.settle(b.captureId, 'second');
  T2.abandon(a.captureId);
  await pb;
  eq('an abandoned capture releases the ones behind it', s2, ['second']);
  eq('nothing left in flight', T2.pendingCount, 0);
  truthy('inFlightFor reports an unsettled capture bound to a field', (() => { const T3 = new C.TranscriptOrder(); T3.open({ fieldId: 'x' }); return T3.inFlightFor('x') && !T3.inFlightFor('y'); })());

  // The wedge found by S2g: a capture whose result never arrives blocked every
  // later transcript. A stale head is swept; abandonAll clears a mode switch.
  const T4 = new C.TranscriptOrder({ maxAgeMs: 30 }); const s4 = [];
  T4.handler = async (b, t) => { s4.push(t); return { ok: true }; };
  T4.open({});                                  // never settled
  await sleep(40);
  const b4 = T4.open({});
  await T4.settle(b4.captureId, 'later');
  eq('a capture whose result never comes is swept after maxAge and releases the queue', s4, ['later']);
  eq('...and counted', T4.swept, 1);
  const T5 = new C.TranscriptOrder(); const s5 = [];
  T5.handler = async (b, t) => { s5.push(t); return { ok: true }; };
  T5.open({}); T5.open({});
  T5.abandonAll('mic-mode');
  const b5 = T5.open({});
  await T5.settle(b5.captureId, 'after-switch');
  eq('abandonAll (mic mode switch / session stop) clears everything in flight', [s5, T5.pendingCount], [['after-switch'], 0]);
  const ghost = await T5.settle(1, 'ghost');
  eq('settling an already-abandoned capture is a harmless no-op (never handled)', [ghost.ok, s5], [false, ['after-switch']]);
}

/* ============================== resume table ============================== */

G('resume table');
{
  const postal = { id: 'pc', type: 'text', label: 'Postal code', options: [] };
  const dept = { id: 'dept', type: 'select', label: 'Department', options: [
    { value: 'card', text: 'Cardiology' }, { value: 'derm', text: 'Dermatology' }, { value: 'neur', text: 'Neurology' },
    { value: 'orth', text: 'Orthopaedics' }, { value: 'paed', text: 'Paediatrics' }, { value: 'radi', text: 'Radiology' }] };
  const bind = (extra = {}) => ({ epoch: 1, fieldId: 'pc', source: 'vad', captureId: 1, ...extra });

  // Prompt interrupted: the speech is the answer.
  let d = C.resumePolicy(deps, { transcript: 'one six zero zero seven one', binding: bind({ interrupted: { kind: 'prompt', heardText: 'Field 1 of 3. What is' } }), epoch: 1, pending: null, field: postal, intent: 'postal' });
  eq('prompt interrupted -> answer', [d.action, d.ex.value], ['answer', '160071']);
  d = C.resumePolicy(deps, { transcript: 'one six zero zero seven one', binding: bind({ interrupted: { kind: 'prompt', heardText: '' } }), epoch: 1, pending: null, field: postal, intent: 'postal' });
  eq('prompt interrupted before ANY word -> still the answer', d.action, 'answer');

  // Confirmation interrupted.
  const pending = { fieldId: 'pc', value: '160071', intent: 'postal' };
  d = C.resumePolicy(deps, { transcript: 'yes', binding: bind({ interrupted: { kind: 'confirm', heardText: 'Let me read' } }), epoch: 1, pending, field: postal, intent: 'postal' });
  eq('early "yes" into the read-back accepts', d.action, 'accept');
  d = C.resumePolicy(deps, { transcript: "no, it's one six zero zero seven two", binding: bind({ interrupted: { kind: 'confirm' } }), epoch: 1, pending, field: postal, intent: 'postal' });
  eq('"no, it\'s 160072" is a correction, not a bare no', [d.action, d.ex.value], ['correction', '160072']);
  d = C.resumePolicy(deps, { transcript: 'one six zero zero seven two', binding: bind({ interrupted: { kind: 'confirm' } }), epoch: 1, pending, field: postal, intent: 'postal' });
  eq('bare new value into the read-back is a correction', [d.action, d.ex.value], ['correction', '160072']);
  d = C.resumePolicy(deps, { transcript: 'no', binding: bind(), epoch: 1, pending, field: postal, intent: 'postal' });
  eq('plain no rejects', d.action, 'reject');
  d = C.resumePolicy(deps, { transcript: 'one six zero zero seven one', binding: bind(), epoch: 1, pending, field: postal, intent: 'postal' });
  eq('repeating the same value is agreement, not a reconfirm loop', [d.action, d.sameValue], ['accept', true]);
  d = C.resumePolicy(deps, { transcript: 'purple monkey', binding: bind(), epoch: 1, pending, field: postal, intent: 'postal' });
  eq('unusable answer to a read-back -> reconfirm (never re-ask the field)', d.action, 'reconfirm');

  // Retractions: the conversation part is stripped, the rest is the value.
  const nameField = { id: 'name', type: 'text', label: 'Full name', options: [] };
  const pendingName = { fieldId: 'name', value: 'Daniel', intent: 'name' };
  const nameBind = (extra = {}) => ({ epoch: 1, fieldId: 'name', source: 'vad', captureId: 1, interrupted: { kind: 'confirm' }, ...extra });
  for (const t of ["Scratch that, it's Arnav", 'actually Arnav', 'wait, I mean Arnav', "no wait, it's Arnav", 'change that to Arnav', 'Sorry, I meant Arnav.']) {
    d = C.resumePolicy(deps, { transcript: t, binding: nameBind(), epoch: 1, pending: pendingName, field: nameField, intent: 'name' });
    eq(`"${t}" into the read-back of Daniel corrects to Arnav`, [d.action, d.ex?.value], ['correction', 'Arnav']);
  }
  d = C.resumePolicy(deps, { transcript: 'scratch that', binding: nameBind(), epoch: 1, pending: pendingName, field: nameField, intent: 'name' });
  eq('a bare "scratch that" rejects and re-asks', d.action, 'reject');
  d = C.resumePolicy(deps, { transcript: 'Actually, Daniel', binding: nameBind(), epoch: 1, pending: pendingName, field: nameField, intent: 'name' });
  eq('"actually, Daniel" (the same value) is agreement', d.action, 'accept');
  d = C.resumePolicy(deps, { transcript: "scratch that, it's one six zero zero seven two", binding: bind(), epoch: 1, pending, field: postal, intent: 'postal' });
  eq('retraction works for digits too', [d.action, d.ex.value], ['correction', '160072']);
  d = C.resumePolicy(deps, { transcript: 'Daniel', binding: nameBind({ interrupted: { kind: 'prompt' } }), epoch: 1, pending: null, field: nameField, intent: 'name' });
  eq('a plain name into the prompt is still just the answer', [d.action, d.ex.value], ['answer', 'Daniel']);
  d = C.resumePolicy(deps, { transcript: 'Actually Arnav', binding: nameBind({ interrupted: { kind: 'prompt' } }), epoch: 1, pending: null, field: nameField, intent: 'name' });
  eq('a retraction with no pending confirmation is an answer, lead-in stripped', [d.action, d.ex.value], ['answer', 'Arnav']);

  // Double interrupt: the second capture was bound to the OLD pending value.
  const pending2 = { fieldId: 'pc', value: '160072', intent: 'postal' };
  d = C.resumePolicy(deps, { transcript: 'no one six zero zero seven three', binding: bind({ pendingKey: 'pc:160071', interrupted: { kind: 'confirm' } }), epoch: 1, pending: pending2, field: postal, intent: 'postal' });
  eq('correction interrupted again resolves against the LATEST pending', [d.action, d.ex.value], ['correction', '160073']);

  // Superseded / stale.
  d = C.resumePolicy(deps, { transcript: 'one six zero zero seven one', binding: bind({ fieldId: 'pc' }), epoch: 1, pending: null, field: dept, intent: 'choice', options: dept.options });
  eq('STT for a field the user has navigated away from is dropped', [d.action, d.reason], ['drop', 'superseded']);
  d = C.resumePolicy(deps, { transcript: 'yes', binding: bind({ epoch: 0 }), epoch: 1, pending, field: postal, intent: 'postal' });
  eq('STT from a previous session epoch is dropped', [d.action, d.reason], ['drop', 'stale-epoch']);
  d = C.resumePolicy(deps, { transcript: 'repeat', binding: bind({ fieldId: 'pc' }), epoch: 1, pending: null, field: dept, intent: 'choice', options: dept.options });
  eq('a command is never superseded by navigation', d.action, 'command');

  // Options list interrupted.
  const heard = 'Department. Choose one: Cardiology, Dermatology,';
  d = C.resumePolicy(deps, { transcript: 'cardiology', binding: bind({ fieldId: 'dept', interrupted: { kind: 'prompt', heardText: heard } }), epoch: 1, pending: null, field: dept, intent: 'choice', options: dept.options, heardText: heard });
  eq('an option the user HEARD matches via the heard set, no confirmation', [d.action, d.viaHeard, d.ex.value, d.ex.needsConfirmation], ['answer', true, 'card', false]);
  d = C.resumePolicy(deps, { transcript: 'neurology', binding: bind({ fieldId: 'dept', interrupted: { kind: 'prompt', heardText: heard } }), epoch: 1, pending: null, field: dept, intent: 'choice', options: dept.options, heardText: heard });
  eq('an option NOT yet heard is accepted but confirmed', [d.action, d.viaHeard, d.ex.value, d.ex.needsConfirmation], ['answer', false, 'neur', true]);
  d = C.resumePolicy(deps, { transcript: 'purple elephants', binding: bind({ fieldId: 'dept', interrupted: { kind: 'prompt', heardText: heard } }), epoch: 1, pending: null, field: dept, intent: 'choice', options: dept.options, heardText: heard });
  eq('nothing matched -> continue the list with the UNHEARD options only', [d.action, d.remaining.map(o => o.text)], ['options-remaining', ['Neurology', 'Orthopaedics', 'Paediatrics', 'Radiology']]);
  d = C.resumePolicy(deps, { transcript: 'purple elephants', binding: bind({ fieldId: 'dept', interrupted: null }), epoch: 1, pending: null, field: dept, intent: 'choice', options: dept.options, heardText: '' });
  eq('same miss with NO interruption is unusable (normal retry path)', d.action, 'unusable');
  eq('optionsHeard matches whole labels only', C.optionsHeard(dept.options, 'Choose one: Cardiology, Derma').map(o => o.value), ['card']);
}

/* ================================ echo guard ============================== */

G('echo run');
{
  const PROMPT = 'Let me read that back. Arnav. Is that correct?';

  // The runaway this exists to stop: the microphone hears the read-back and
  // whisper returns it, whole or in pieces.
  truthy('verbatim prompt is echo', C.echoRun('let me read that back', PROMPT) >= 0.6);
  truthy('fragment of the prompt is echo', C.echoRun('read that back', PROMPT) >= 0.6);
  truthy('is that correct is echo', C.echoRun('is that correct', PROMPT) >= 0.6);
  truthy('echo with one stray word still counts',
         C.echoRun('let me read that back you', PROMPT) >= 0.6);

  // The false positive that a bag-of-words overlap would cause: these words are
  // all in the prompt, but not in that order, so they are the user speaking.
  truthy('confirmation is NOT echo', C.echoRun("yes that's correct", PROMPT) < 0.6);
  truthy('rejection is NOT echo', C.echoRun("no that's wrong", PROMPT) < 0.6);
  eq('unrelated answer is not echo', C.echoRun('john smith', PROMPT), 0);

  // Short replies are never rejected: they are the most common thing said.
  eq('single word is never echo', C.echoRun('yes', PROMPT), 0);
  eq('name alone is never echo', C.echoRun('arnav', PROMPT), 0);
  eq('empty reference is never echo', C.echoRun('let me read that back', ''), 0);
  eq('empty transcript is never echo', C.echoRun('', PROMPT), 0);

  eq('punctuation and case are ignored', C.echoRun('LET ME, READ!', 'let me read'), 1);
  // Contiguity is the whole point: same words, wrong order, not echo.
  truthy('scrambled prompt words are not echo', C.echoRun('back that read me let', PROMPT) < 0.6);
}

/* ================================= report ================================= */

const pass = results.filter(r => r.ok).length, fail = results.filter(r => !r.ok);
console.log('\nPhase 3 session core - pure, in Node\n');
let g = '';
for (const r of results) {
  if (r.group !== g) { g = r.group; console.log(`  ${g}`); }
  console.log(`    ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
  if (!r.ok) console.log(`          got  ${JSON.stringify(r.got)}\n          want ${JSON.stringify(r.want)}`);
}
console.log(`\n  PASS ${pass}   FAIL ${fail.length}\n`);
fs.mkdirSync('artifacts', { recursive: true });
fs.writeFileSync('artifacts/phase3_core.json', JSON.stringify({ results }, null, 2));
process.exit(fail.length ? 1 : 0);
