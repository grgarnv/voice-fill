# Personal voice memory + natural correction — results

Generated 2026-09-06. Design: [VOICE_MEMORY.md](./VOICE_MEMORY.md).

**Verdict: PASS.**

Every figure below is from a run on this machine, serialized (two browser
harnesses running at once share port 8787 and the audio device, and the numbers
from a contended run are worthless — that mistake is recorded in §Bugs).

## Suites

| Suite | What it is | Result |
|---|---|---|
| `npm run selftest` | manifest, contracts, secrets, plumbing | **19 / 0** |
| `npm run test:normalize` | normalisation + extraction, pure | **123 / 0** |
| `npm run test:fieldgraph` | FieldGraph + prompts, real Chrome | **70 / 0** |
| `npm run test:domwrite` | DOM writing against real React | **22 / 0** |
| `npm run test:readback` | 20-item read-back, real Rime → real whisper | **naive 15/20, tuned 20/20** (bar ≥ 90%) |
| `npm run test:voicefill` | a whole form by voice | **34 / 0** |
| `npm run test:e2e` | Phase 1 end-to-end, real Rime | **22 / 0** |
| `npm run test:exit` | Phase 1 exit criterion, four live third-party sites | **18 / 0** |
| `npm run test:core` | Phase 3 core, pure | **96 / 0** |
| `npm run test:bargein-stub` | delayed frames, stale tails, loopback stub | **16 / 0** |
| `npm run test:bargein` | **Phase 3, real speech at the microphone** | **46 / 0** |
| `npm run test:intent` | conversational corpus + adversarial, pure | **219 / 0** |
| `npm run test:intent-form` | the intent demonstrations, real browser | **31 / 0** |
| `npm run test:memory` | **new** — spelling, casing, learning, adversarial | **235 / 0** |
| `MEMORY_LIVE=1 … test:memory` | the structured schema against the real model | **4 / 4**, twice |
| `npm run test:memory-form` | **new** — the demonstrations, real browser + real storage | **53 / 0** |

## Real-form demonstrations

`tools/test_memory_form.mjs`, headless Chrome, the real extension, real Rime
audio, real `chrome.storage.local`, assertions read the DOM.

| # | Demonstration | Result |
|---|---|---|
| 1 | first-name correction through spelling | PASS — "No, it's Arnav. Spell it A R N A V." → `Arnav`, not the letters, no provider call |
| 2 | the confirmed correction is persisted | PASS — one entry, keyed to `name`, observed `enough`, and nothing else stored |
| 3 | repeated correction becomes easier | PASS — `Enough.` now resolves to `Arnav` in one turn, via the profile, still read back |
| 4 | contextual memory does not fire elsewhere | PASS — `Enough.` in a City field is not the name; "How much is enough?" stays the sentence |
| 5 | full-name multi-component spelling | PASS — `Arnav Garg`, once, not doubled, not the letters |
| 6 | natural uppercase | PASS — "Arnav Garg, all uppercase" → `ARNAV GARG` in the DOM |
| 7 | natural lowercase on a value already written | PASS — accepted, navigated back, "make it all lowercase" → `arnav garg` |
| 8 | mixed casing | PASS — "first name normal case, last name all caps" → `Arnav GARG` |
| 9 | casing refused where it has no meaning | PASS — "make that all caps" on a postcode asks, writes nothing, leaves `160071` |
| 10 | partial numeric correction | PASS — "No, the last digit is two" → `160072` in the DOM |
| 11 | ambiguous correction → clarification | PASS — "change the third digit" asks; "everything is right except the last digit" asks and is **not** accepted |
| 12 | option correction | PASS — "no, actually just the headache" replaces Fever+Cough |
| 13 | interruption + correction, double interruption + correction | PASS — a spelled correction lands over an interrupted read-back; the last spelling wins; 0 illegal transitions |
| 14 | two corrections in a row teach nothing | PASS — profile unchanged |
| 15 | Phase 3 invariants across the run | PASS — 0 stale audio, 0 illegal transitions, 0 captures left hanging |

Routing over that run: **8 turns resolved by deterministic spelling/casing, 1 by
the profile, 1 by ordinals, 1 by the provider**, 4 clarifications, and 21 turns
where the router declined to consult at all (`deterministic-answer` 13,
`deterministic-accept` 8).

## Phase 3 regression

`tools/test_bargein.mjs` — 20 interruptions by real speech at the microphone,
real Rime, real VAD, real whisper. **46 / 0**, against a recorded baseline of
45 / 1.

| | this run | PHASE3_RESULTS.md baseline |
|---|---|---|
| stop latency p50 / p95 / max | **26.3 / 34.3 / 34.5 ms** | 26 / 34 / 34 ms |
| … including this device's output sink | 61.1 / 68.1 ms | 60 / 68 ms |
| … to stop call returned, p50 / p95 | 24.3 / 32.2 ms | 24 / 32 ms |
| stale audio played | 0 | 0 |
| stale chunks dropped | 6431 | — |
| illegal transitions | 0 | 0 |
| re-asks | 0 | 0 |
| whisper median per interruption | 6628 ms | 5082 ms |
| double interrupt resolved to the last instruction | **5 / 5** | 5 / 5 |

**Personalization does not touch the stop path and the measurement says so.**
It cannot: `bargeIn()` runs at VAD onset, synchronously, before a transcript
exists; every resolver added here runs inside `processTranscript`, which is
reached after whisper returns — seconds later.

The one assertion that failed on the first run of this work (`S2c` double
interrupt, 3/5) was the **echo rejector** eating a genuine digit correction, and
it is now fixed — see Bugs #2. The suite is better than the recorded baseline,
not merely equal to it.

## Performance

The deterministic path, measured with `performance.now()` over 20 000
iterations each, warm, against a **full** profile (200 corrections + 200
vocabulary entries, both at the cap):

| Stage | p50 | p95 |
|---|---|---|
| `hasFormatting` — the router probe, on every consulted turn | 0.8 µs | 1.0 µs |
| spelling assembly, one component | 1.0 µs | 1.1 µs |
| spelling assembly, two components | 3.3 µs | 3.7 µs |
| casing, whole value | 1.2 µs | 1.3 µs |
| casing, scoped, two clauses | 1.8 µs | 2.3 µs |
| spelling + casing combined | 1.8 µs | 2.1 µs |
| personalization lookup, 200-entry profile, miss | 1.1 µs | 1.1 µs |
| personalization lookup, 200-entry profile, hit | 1.2 µs | 1.3 µs |
| positional edit | 0.6 µs | 0.7 µs |
| `validateIntent` with structured spelling + case | 1.4 µs | 1.5 µs |
| profile sanitize — once, at session start | 31.3 µs | 32.2 µs |
| `learn` — once, on an accepted correction | 39.7 µs | 42.6 µs |

Everything on the turn path is **under 4 µs**. The two once-per-event
operations are under 45 µs. For scale, the next stage in the same turn is
whisper at ~6.6 s.

The stages that are not microseconds, measured end-to-end:

| Stage | Measured |
|---|---|
| STT (whisper `ggml-medium.en.bin`, per interruption) | 6628 ms median |
| intent provider (ollama `qwen3:8b`, warm, local) | p50 3.3 s / p95 3.9 s |
| VAD onset → audio stopped | 26.3 ms p50 |
| write + read-back | Phase 2 timings, unchanged |

**The provider is rarely on the path.** Across the real-form run, 8 of 10
resolved formatting turns cost 0 ms of network because the assembler answered
them; 1 reached the model.

## Bugs found and fixed

Nine product bugs and three stale test assertions. Every one was found by
measurement, not by review.

| # | Bug | Where it came from | Fix |
|---|---|---|---|
| 1 | **"Everything is right except the last digit" was ACCEPTED.** It contains "right", contains no negation, so `parseYesNo` returned true and VoiceFill said "Got it" and moved on with the number the person had just said was wrong. | pre-existing | an `accept` whose utterance names a change is routed, not executed (`accept-with-an-edit`) |
| 2 | **The echo rejector ate genuine digit corrections.** "one six zero zero seven THREE" against a read-back of "one six zero zero seven two" is a five-word contiguous run; 2 of 5 double-interrupt trials lost the correction entirely. | pre-existing | same length + different digits is not an echo. Verbatim echo and short (digit-dropped) echo both stay rejected |
| 3 | **A model timeout replaced a correct answer with a question.** "No, actually just the headache" routes to the provider on "just the"; with the provider down, the referential fallback asked "which ones would you like?" over a correction the table had already resolved. | pre-existing | fall back to a clarification only when the deterministic decision was not itself usable |
| 4 | **A model question replaced the option-list continuation.** With a list cut off and nothing matching, `REQUEST_CLARIFICATION` overwrote the turn that would have read out the remaining options. | pre-existing | a `clarify` never replaces `options-remaining` |
| 5 | **A positional edit could write a non-option to a choice field.** "the last letter is X" on `fever` produced `feveX` into a checkbox group — `valueShapeError` says nothing about membership. | pre-existing | one `shapeValue` used by every path |
| 6 | **`PROMPTING → CONFIRMING` was an illegal transition.** A clarifying question asked over a pending read-back is spoken as a prompt, and returns to CONFIRMING when it ends — 11 violations in one run. | new (this feature makes such clarifications common) | the transition is allowed, with the reason written down |
| 7 | **An utterance settling after stop moved an unconnected session to LISTENING.** `IDLE → LISTENING` across a restart. | pre-existing race | `afterPlayback` does nothing while IDLE or CONNECTING |
| 8 | **`phonemizeBetweenBrackets` was never sent to Rime.** A populated name dictionary would have had `{ˈɑːrnəv}` read out as its characters. | pre-existing, latent (the dictionary was empty) | the proxy declares and reports it; the extension gates the braces on it, exactly as it gates pause tokens |
| 9 | **qwen3:8b returned `CAPITALIZE_FIRST` for "all caps"** — and for "put the surname in capitals". Putting the meanings in the JSON-schema `description` changed nothing. | new (the new enum) | all five spelled out in the system prompt. Fixed both |
| 10 | `tools/test_readback.mjs` hardcoded `<300>`/`<400>` in its own template while telling Coda not to interpret brackets — the tokens were **spoken**, and `482913` came back as `93004829139`. | pre-existing since the Coda switch | the same pause gate the product uses. **16/20 → 20/20** |
| 11 | `tools/test_e2e.mjs` asserted prewarm audio is discarded *by contextId*; Phase 3 discards it by turn *kind*, so the counter never moved. | pre-existing | assert what the test is about: chunks arrived, none played |
| 12 | `tools/test_phase1_exit.mjs` polled for `state === 'READY' && utterance.chunks > 0`; since Phase 3 a prompt settles in LISTENING and `S.turn` is cleared on finish, so both could never hold. All four sites reported `undefined chunks`. | pre-existing | read the ledger, which is the durable record |

Found in my own adversarial pass before shipping, and now in the corpus:

- `"Caps Lock Key"` and `"Upper Street"` read as casing instructions. A bare
  "caps" now needs a lead-in or the end of the utterance.
- `"capital letters"` parsed as a per-fragment spelling of `LETTERS`.
- `"capitalize the first letter"` reached the positional editor first, which saw
  a position with no replacement and asked a question instead of doing the
  plainly-stated thing.

## Remaining bugs

None known.

## Known limitations

1. **NATO spelling is not assembled locally on name fields.** "A as in Alpha, R
   as in Romeo" reaches the provider, which handles it correctly (measured,
   4/4 live). It is deliberately not done deterministically there, because a
   NATO word is also a name — Victor, Romeo, Oscar, Charlie — and misreading one
   would be worse than the round trip. `idnumber` fields still get NATO
   deterministically, through the existing `wordsToAlphanumeric`.
2. **Two-letter spellings need the word "spell".** Without it the floor is three
   letters, because two consecutive single letters happen by accident.
3. **No UI for the profile.** It is written by confirmed corrections and read
   automatically; inspecting or clearing it means the service-worker console or
   `VF_MEMORY_GET` / `VF_MEMORY_SET` / `VF_MEMORY_CLEAR`. There is no onboarding
   flow, deliberately: the functional path needs no setup.
4. **Nothing populates the pronunciation dictionary automatically.** The layering
   works and is tested, and an entry can be added through `VF_MEMORY_SET`, but
   there is no `/phonemize` call wired up and no UI.
5. **Phoneme pronunciations are inert on Coda.** That is the model, not the
   code — respellings work on any model, and the flag is now reported honestly
   rather than silently ignored.
6. **A learned correction is exact-match.** "Enough" fires; "Enough there" does
   not. Fuzzy matching would fire in places the person did not intend, and the
   whole-utterance rule is what keeps "How much is enough?" safe.
7. **The provider is slow on a local 8B model** (p50 3.3 s). Unchanged from the
   intent layer, and the deterministic resolvers are why it is rarely reached.

## Acceptance criteria

| Requirement | Implementation | Test | Actual | Status |
|---|---|---|---|---|
| User can naturally spell a value | `memory.js` letter runs | `test:memory` "spelling - one word, every natural phrasing" | 7 phrasings, all → `Arnav`, 0 provider calls | **PASS** |
| "A R N A V" → `Arnav`/`ARNAV` by field semantics | `fieldCase` | `test:memory` "field semantics decide the case" | name→`Arnav`, id→`ARNAV`, explicit override both ways | **PASS** |
| Spelling does not become literal "A-R-N-A-V" | letters are evidence, never text | `test:memory` + `test:memory-form` #1 | no separator survives; DOM holds `Arnav` | **PASS** |
| Full names corrected component-by-component | base vs component split | `test:memory` "a full name, component by component" | 7 phrasings → `Arnav Garg` | **PASS** |
| "Arnav is A R N A V and Garg is G A R G" → "Arnav Garg" | clause with letters contributes letters only | `test:memory`, `test:memory-form` #5 | `Arnav Garg`, 2 words, in the DOM | **PASS** |
| Partial character corrections | `editByPosition` + multi-char span | `test:memory` "partial corrections" | 6 cases incl. "the last two digits should be 42" | **PASS** |
| Ambiguous corrections request clarification | `editRefusal`, conflict detection | `test:memory`, `test:memory-form` #11 | "the seventh letter" of five, "change the third digit", two spellings | **PASS** |
| Corrections work during confirmation | the `pending` branch of every resolver | `test:memory` "letters win", `test:memory-form` #1, #10 | correction, not a fresh answer | **PASS** |
| Corrections work after barge-in | unchanged Phase 3 binding | `test:memory-form` #13 | spelled correction over an interrupted read-back | **PASS** |
| Heard-ledger semantics remain authoritative | untouched | `test:intent` (heard-ledger groups), `test:bargein` S2d/S2e/S2f | all pass | **PASS** |
| Natural uppercase | `CASE_RULES` UPPER | `test:memory` (7 phrasings), `test:memory-form` #6 | `ARNAV GARG` in the DOM | **PASS** |
| Natural lowercase | LOWER | `test:memory` (4 phrasings), `test:memory-form` #7 | `arnav garg` in the DOM | **PASS** |
| Capitalisation of specific components | scoped ops | `test:memory` "capitalisation of components", `test:memory-form` #8 | `Arnav GARG` | **PASS** |
| Casing combined with spelling | ordered pipeline | `test:memory` "spelling and casing in one utterance" | 3 PRD examples exact | **PASS** |
| Casing is deterministic after interpretation | `applyCase`, shared by both paths | `test:memory` structured-args group | model names the op, the function applies it | **PASS** |
| Casing does not corrupt email/phone/number | `caseError` | `test:memory` "field-aware", `test:memory-form` #9 | digits/choice/email-upper all ask; email LOWER applies | **PASS** |
| Personal vocabulary can be represented | `vocabulary[]` | `test:memory` "vocabulary reaches the provider as a hint" | listed for its context, empty for others | **PASS** |
| Confirmed corrections can be remembered | `learnFromAccept` | `test:memory-form` #2 | persisted to real `chrome.storage` | **PASS** |
| Learned corrections are context-sensitive | `context` = field intent | `test:memory`, `test:memory-form` #4 | City field unaffected | **PASS** |
| "enough" does NOT globally become "Arnav" | whole-utterance equality | `test:memory` negative cases, `test:memory-form` #4 | "How much is enough?" unchanged | **PASS** |
| Unrelated uses are not personalized | context + whole-utterance | same | "Enough already" does not fire either | **PASS** |
| Memory does not store arbitrary form answers | `LEARNABLE` + value rules | `test:memory` "privacy - what a profile may contain" | 14 offered, 4 kept | **PASS** |
| Sensitive data is not persisted | contexts excluded by construction | same | no digits, no `@`, no medical text, no password | **PASS** |
| Rime pronunciation integrates with the existing architecture | user dict layered over `NAME_PHONEMES` in `speakName` | `test:memory` "pronunciation" | phonemes braced when supported, respelling when not | **PASS** |
| No fake claim of acoustic training | — | VOICE_MEMORY.md "What this is NOT", README | no wizard, no recording, stated plainly | **PASS** |
| Conversational intent layer remains intact | additive resolvers | `test:intent` 219/0, `test:intent-form` 31/0 | green | **PASS** |
| Phase 3 architecture remains intact | stop path untouched | `test:bargein` 46/0, `test:bargein-stub` 16/0 | 26.3 ms p50, 0 stale, 0 illegal | **PASS** |
| Existing Phase 1/2/3 tests pass | — | all 16 suites | all green | **PASS** |
| New spelling tests pass | `test:memory` | | 235/0 | **PASS** |
| New casing tests pass | `test:memory` | | included above | **PASS** |
| New personalization tests pass | `test:memory` + `test:memory-form` | | 235/0, 53/0 | **PASS** |
| Real-form tests pass | `test:memory-form` | | 53/0, 15 demonstrations | **PASS** |
| Provider failure has a safe fallback | resolvers are local; provider optional | `test:memory` `providerFails`, `test:intent` fallback group | refusals hold with the provider down | **PASS** |
| No model output can manipulate the DOM | seven-action vocabulary | `test:memory` structural group, `test:intent` | no `document`/`chrome.*`/`fetch` in `memory.js` | **PASS** |
| No model output can bypass the state machine | validated against the core's own state | `test:memory` adversarial groups | malformed structure dropped, not repaired | **PASS** |

## Reproducing

```bash
npm run backend                 # in another shell, for the live paths
npm run test:memory             # pure: spelling, casing, learning, adversarial
MEMORY_LIVE=1 npm run test:memory   # also scores the model on the new schema
npm run test:memory-form        # the demonstrations, real browser + real storage
npm run test:bargein            # Phase 3 regression, real speech
```

Run the browser harnesses **one at a time**: each spawns its own backend on
:8787 and drives real audio. Two at once share a port and a sound device, and
the second one's numbers are noise.
