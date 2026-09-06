# The conversational intent layer

VoiceFill used to require the user to know VoiceFill. "Yes", "no", "repeat",
"skip", "go back", and an option label near enough to match. This layer lets a
person talk the way they would to a human helping them with a form — "the first
two", "actually just the headache", "no no, it's Arnav", "the last digit is
two" — without giving a model any power over the browser.

## The shape of it

```
USER
  ↓
STT                       whisper, or the Web Speech API
  ↓
BARGE-IN                  Phase 3. Synchronous. Runs at VAD ONSET, before a
  ↓                       transcript exists at all.
CONVERSATIONAL INTENT     this layer: interpretation only
  ↓
STRICT INTENT SCHEMA      one of ten intents, machine-validatable
  ↓
DETERMINISTIC VALIDATOR   checked against the core's own state
  ↓
VOICEFILL STATE MACHINE   unchanged
  ↓
DOM
```

**AI interprets. The deterministic core executes.** The reason for the split is
not taste, it is failure modes. A model that is wrong about what someone meant
costs a clarifying question. A model that is wrong about what to *do* costs a
wrong value in a medical form, or a click nobody asked for. So the model is
never given anything to be wrong about except meaning.

Concretely: the layer's entire output vocabulary is the set of decisions
`resumePolicy` already produces, and which `processTranscript`'s switch already
knows how to run — `answer`, `correction`, `accept`, `reject`, `command`,
`clarify`, `drop`. There is no code path from a model response to a selector, a
script, a click, or a state transition, because nothing downstream reads one.
`tools/test_intent.mjs` asserts this by construction: every intent that can pass
validation maps to an action in that fixed set.

### The layer is never on the audio-stop path

This matters more than anything else here. Phase 3's stop latency comes from a
chain that completes before a transcript exists:

```
mic block over threshold  →  bargeIn()  →  sources stopped, S.contextId = null
                             (synchronous, ~24-32 ms measured)
```

`consultIntent` is called from `processTranscript`, which runs *after* whisper
has returned. By then the audio has been stopped for seconds. The provider
cannot slow the stop down because it has not been asked yet, and there is no
arrangement of provider latency that changes the figure. This is verified in
`PHASE3_RESULTS.md`, which is regenerated from the same harness after this
change.

## Where it plugs in

One place, `extension/offscreen/player.js`, inside `processTranscript`:

```js
let decision = C.resumePolicy(deps, policyCtx);      // the table, unchanged
const conversational = await consultIntent(decision, policyCtx, binding);
if (conversational) decision = conversational;       // same vocabulary
switch (decision.action) { ... }                     // unchanged
```

## Hybrid routing — deterministic first

The provider is asked only when the deterministic table has either failed or
succeeded *suspiciously*. `VFIntent.shouldConsult` decides:

| Situation | Route | Why |
|---|---|---|
| `yes` / `no` / `repeat` / `skip` / `go back` / `next` | deterministic | already correct, and instant |
| a clean option match by label | deterministic | `matchOption` handles it |
| ordinals and quantities over a list | **ordinal resolver** | arithmetic, not interpretation |
| the table said `unusable` / `ambiguous` / `reconfirm` / `options-remaining` | **provider** | it could not use the utterance |
| a `correction` shorter than the value it replaces, on a digit field | **provider** | the fragment bug, below |
| a `correction` into a read-back with no correction marker | **provider** | "Perfect." is agreement, not a name |
| relative language on a choice list | **provider** | "the other one", "those two" |
| a letter run, or a casing instruction | **spelling/casing resolver** | assembling letters and changing case is arithmetic — VOICE_MEMORY.md |
| an utterance this person has already corrected | **personal memory** | a confirmed correction, in this kind of field |
| the table said `accept` but the utterance names a change | **provider** | "everything is right except the last digit" contains no negation |
| the field is a password | **never** | see Privacy |
| the transcript was already dropped as stale | **never** | acting on it later is the failure |

Three things turned out to be arithmetic rather than interpretation, and all
three are done locally with no model and no network:

| Resolver | Covers | Why not the model |
|---|---|---|
| `resolveRelative` | `first`, `the first two`, `the first couple`, `first and third`, `one and three`, `all four`, `all of them`, `the last two`, `the first one and the last one`, `none of them`, `option three` | positional arithmetic over a list |
| `resolveExclusion` | `everything except the fever`, `all but the cough`, `anything other than nausea`, `all except fever and cough`, `none of them except headache` | set arithmetic. Also a **bug fix**: the deterministic matcher has no notion of negation and scored the excluded label as the answer, so "not the fever" *selected Fever* |
| `editByPosition` | `the last digit is two`, `the second digit should be a five`, `make the third one a nine`, `the first letter is A`, `the last two digits should be 42` | counting characters. Measured: qwen3:8b asked for the **second** digit of 160071 returned `160075`, having changed the last |
| `resolveUtterance` | `spell it A R N A V`, `Arnav is A R N A V and Garg is G A R G`, `all caps`, `lowercase that`, `first name normal case, last name all caps` | assembling letters and changing case. See VOICE_MEMORY.md |
| `lookupCorrection` | an utterance identical to one this person has corrected and confirmed before, in the same kind of field | a lookup, not an inference |

`resolveRelative` deliberately declines anything not *purely* positional — "give
me the first one and headache" mixes a position with a label, so the whole
utterance goes to the provider rather than having half of it silently dropped.

The exclusion path carries one rule the others do not: when it cannot resolve,
the deterministic decision is not a safe fallback, because that decision *is*
the excluded option. Exclusion and referential utterances fall back to a
clarifying question instead. A plainly unparseable answer keeps the existing
bounded error path, so a user saying nothing useful is still moved along.

## The intent schema

`backend/intent.mjs` enforces it as a JSON schema through
`output_config.format`, so the model cannot return prose.

```json
{
  "intent": "SELECT_OPTIONS",
  "field_id": "checkboxgroup/symptoms",
  "arguments": { "option_indices": [1, 3], "by": "position" },
  "confidence": 0.97,
  "needs_clarification": false
}
```

| Intent | Arguments | Becomes |
|---|---|---|
| `ANSWER_FIELD` | `value` | `answer` |
| `SELECT_OPTIONS` | `option_indices`, `by` | `answer` (value or array of values) |
| `CORRECT_VALUE` | `value` | `correction` (or `answer` with no pending) |
| `ACCEPT_CONFIRMATION` | — | `accept` |
| `REJECT_CONFIRMATION` | — | `reject` |
| `REPEAT` / `SKIP` / `GO_BACK` / `NEXT` | — | `command` |
| `REQUEST_CLARIFICATION` | `question` | `clarify` |

There is no `MODIFY_VALUE`. An edit-operation intent would need an edit DSL, and
an edit DSL is a second thing to validate and get wrong. Instead a partial
correction returns the **complete resulting value**: with `160071` pending, "the
last digit is two" is `CORRECT_VALUE` with `value: "160072"`. The validator then
checks the whole value against the field's shape, which it could not do with an
edit instruction.

`ANSWER_FIELD` and `CORRECT_VALUE` carry two further arguments, `spelling` and
`case`, and they are the exception that proves the rule: the model names WHICH
letters were said and WHICH of five closed casing operations was asked for, and
a deterministic function — the same one the local resolver uses — produces the
string. That is not an edit DSL, because nothing in it describes an edit; it is
evidence about a value, validated against the field afterwards like any other.
VOICE_MEMORY.md has the whole of it.

In practice that intent is rarely needed: `editByPosition` resolves the common
positional edits before the provider is reached, so the headline example works
with the provider down.

## The context object

`VFIntent.buildContext` produces exactly these keys and nothing else:

```json
{
  "state": "CONFIRMING",
  "turn_id": 7,
  "epoch": 1,
  "field": { "id": "...", "label": "...", "type": "...", "intent": "postal",
             "current_value": "160071" },
  "options": [ { "index": 1, "label": "Email", "heard": true }, ... ],
  "heard_option_indices": [1, 2],
  "list_was_interrupted": true,
  "pending_confirmation": { "value": "160071", "spoken": "one six zero zero seven one" },
  "recent_conversation": [ { "kind": "options", "said": "Email, Phone,— [interrupted]", "status": "interrupted" } ],
  "user_transcript": "the first and third"
}
```

One optional key, `known_values`, is added when — and only when — this person
has confirmed vocabulary for this kind of field. It is a hint; the value that
comes back is validated exactly as any other, and an empty profile leaves the
context byte-identical to the shape above.

### The heard ledger stays authoritative

If the user cut off "Email, Phone, SMS, WhatsApp" after *Phone*, the provider is
shown two options, not four. `heard_option_indices` says which, and the
validator rejects any `by: "position"` pick outside that set — so "the third
one" cannot resolve to SMS, because the user was not counting SMS. It asks
instead.

Naming an unheard option is different and still works: someone who knows the
form can say "WhatsApp" over the top of the list. Phase 3 already accepted that
with a forced confirmation, and that behaviour is unchanged.

## Validation

Deterministic, in the extension, against the core's own state — never against
anything the model asserted about itself:

- the intent is one of the ten
- `field_id`, if present, is the active field
- `turn_id`, if present, is the current turn
- option indices are integers inside the current list
- positional picks are inside the heard set when the list was interrupted
- a single-select rejects multiple indices
- a choice field's value must be an existing option — a free-typed one is a
  hallucination
- digit fields take digits, dates are `YYYY-MM-DD`, emails contain an `@`
- values are ≤ 200 chars and contain no `<`, `>`, `{`, `}`
- `ACCEPT`/`REJECT` require a pending confirmation to accept or reject
- a clarification must carry a question

After the round trip, before anything runs, the turn is re-checked: a different
epoch, a different field, or a different pending confirmation means the world
moved on and the intent is **dropped**, not executed. That is the double-
interrupt case, using Phase 3's existing turn machinery rather than a new one.

**`confidence` is a log field.** It routes nothing and permits nothing. An
invalid intent at confidence 1.0 is rejected exactly as hard as one at 0.2 —
`tools/test_intent.mjs` asserts this.

## Fallback

If the provider is unavailable, slow, rate-limited, returns unparseable output,
or returns something the validator rejects, `consult` returns `null` and **the
deterministic decision stands**. The layer is additive, never load-bearing.
`/health` and `/provider` report `intent: false` / `provider: "none"` so the
state is visible rather than guessed at.

Set `VF_INTENT_PROVIDER=none` to disable it deliberately. With no
`ANTHROPIC_API_KEY` it is off by default and VoiceFill behaves exactly as it did
before this change.

## Ambiguity

Asking is a successful outcome, not a failure. `clarify` speaks one short
question and writes nothing — but it **counts against the same `MAX_ATTEMPTS`
cap** that `failAttempt` enforces, and skips the field at the limit.

That was a bug first, and it is worth stating plainly: clarify originally spent
no attempt, which sounded generous and meant a question with no end. Two turns
of gibberish on one field ("purple monkey dishwasher") produced two reasonable
clarification requests and no progress, forever. A question the user cannot
satisfy has to terminate like any other failure.
The ordinal resolver produces its own clarifications for the two cases it can
detect without a model ("the fifth" of four; "all of them" on a single-select).

## Security

| Concern | Handling |
|---|---|
| API key leakage | the key lives in `backend/intent.mjs` and never leaves the backend, exactly as the Rime key does. `/intent` is gated by `PROXY_TOKEN`. |
| prompt injection via form content | field and option labels are untrusted text. The system prompt says so; more importantly the schema has no field that could carry an instruction, so a successful injection can at best cause a wrong option index — which is read back to the user before it counts. Tested with hostile labels in `tools/test_intent.mjs`. |
| arbitrary model output | rejected by `output_config.format`, then rejected again by the validator. Malformed JSON, arrays, bare strings, unknown intents, and missing arguments are all covered by the corpus. |
| DOM instructions | not representable. The output vocabulary is seven decision actions. |
| stale intent execution | epoch, field, and pending-confirmation are re-checked after the round trip. |
| a semantically inverted answer | a model reply that selects an option the user explicitly excluded is rejected deterministically. "Fever" is a *structurally valid* answer to "not the fever", so validation alone cannot catch it. |
| request size | `/intent` caps the body at 256 KB; labels are truncated to 120 chars, the field label to 200, the transcript to 500. |

## Privacy and logging

- **Password fields never reach the provider.** The router refuses before a
  context is built. Deterministic handling only.
- The context carries the current field and, when a read-back is pending, the
  value being confirmed — a correction cannot be resolved without it. It carries
  no other field's value and no form contents.
- The backend logs the intent name, confidence, and latency. It does **not** log
  the transcript, the value, the field label, or the context. `VF_INTENT_DEBUG=1`
  adds the intent name and confidence only; there is no setting that logs values.
- The extension keeps rejection *reasons* in metrics, not rejected values.

## Latency

Measured separately from everything else, because they are separate problems:

| Stage | Where measured |
|---|---|
| VAD onset → audio stopped | `metrics.stopSamples[].stopLatencyMs` (Phase 3) |
| STT | `lastSttMs` |
| intent provider | `metrics.intent.providerMs` |
| validation | in-process, sub-millisecond |
| write + read-back | existing Phase 2 timings |

The provider has a 2.5 s timeout in the backend and a 4 s outer bound in the
extension. Both expire into the fallback path.

## Files

| File | Role |
|---|---|
| `extension/shared/intent.js` | the layer: ordinal resolver, router, context builder, validator, orchestrator. Pure — no DOM, no `chrome.*`, no network. |
| `backend/intent.mjs` | the provider: system prompt, JSON schema, Anthropic call, timeout. |
| `backend/server.mjs` | `POST /intent`, token-gated |
| `extension/offscreen/player.js` | `consultIntent` — wires the pure layer to this session's ledger and proxy |
| `tools/test_intent.mjs` | corpus + adversarial, pure; `INTENT_LIVE=1` also scores the live model |
| `tools/test_intent_form.mjs` | the eight demonstrations, real browser, real DOM |
| `eval/fixtures/13_intent.html` | the PRD's own examples as a form |
| `extension/shared/memory.js` | spelling assembly, casing operations, the personal profile — VOICE_MEMORY.md |

## Providers

Two implementations behind one `interpret(context)`, chosen by config. Both get
the same system prompt and the same JSON schema, and both are distrusted equally
afterwards — swapping providers cannot widen what a model is able to do, because
the boundary is in the extension, not the backend.

| | `ollama` (default) | `anthropic` |
|---|---|---|
| Key | none | `ANTHROPIC_API_KEY` |
| Runs | locally, offline | hosted |
| Cost | none | per token |
| Default model | `qwen3:8b` | `claude-opus-5` |
| Structured output | `format: <schema>` (grammar-constrained) | `output_config.format` |
| Measured latency | p50 2.1 s / p95 2.9 s (M5, warm) | not measured — no key available |

Ollama is the default when no key is set. The model is **pre-warmed at backend
boot** and held resident (`keep_alive`): a cold call measured 5.8 s against 2.1 s
warm, past the timeout, so without pre-warming the first conversational
utterance of every session would have fallen back and looked broken.

```bash
brew install ollama && ollama serve
ollama pull qwen3:8b
```

### Memory, measured the hard way

`qwen3:8b` is ~5 GB and `keep_alive` holds it resident. On a 16 GB machine that
is fine in normal use and **not** fine alongside Chrome and whisper-medium: the
Phase 3 harness, which spawns a backend per suite, starved to the point where
Chrome could not create targets and its fake audio device stopped delivering.
Nothing was wrong with the code; the machine was out of memory.

If VoiceFill and a browser are competing on a 16 GB machine:

| Lever | Effect |
|---|---|
| `VF_OLLAMA_KEEPALIVE=0` | model unloads between turns; every turn pays ~1.5 s cold start |
| `VF_OLLAMA_MODEL=qwen3:4b` | ~2.5 GB instead of ~5 GB, at a real accuracy cost — measured 4 live-corpus failures against 0 for 8b, including selections it turned into clarifications |
| `VF_INTENT_PROVIDER=none` | the layer is off; arithmetic and deterministic paths are unaffected |

The last row is what the barge-in suites now use: they measure audio-stop
latency and never call the layer, so loading a model to not use it bought
nothing and cost the run.

`GET /health` reports `intent` as **reachability**, not configuration — a
configured-but-unreachable provider is the failure that otherwise just looks
like the feature not working.

## Configuration

```
# Provider: ollama (default when no key is set) | anthropic | none
VF_INTENT_PROVIDER=ollama
VF_OLLAMA_MODEL=qwen3:8b
VF_OLLAMA_URL=http://127.0.0.1:11434
VF_OLLAMA_KEEPALIVE=30m

ANTHROPIC_API_KEY=...          # presence selects the hosted provider
VF_INTENT_MODEL=claude-opus-5  # anthropic only; ollama ignores it

VF_INTENT_TIMEOUT_MS=8000      # local inference needs room; expires into fallback
VF_INTENT_DEBUG=1              # logs intent name + latency, never values
```

One model variable per provider, deliberately: a single `VF_INTENT_MODEL` was
handed to whichever provider was active, so a leftover `claude-opus-5` was asked
of ollama and the layer reported itself unreachable for a reason nothing named.

**Read env lazily.** `loadEnv()` runs in the server's module body, but ES imports
are hoisted and evaluated first — anything captured at import time sees the shell
environment and never `.env`. That silently pinned the timeout at its default and
made every slower turn look like the model failing. Every setting here is read
through a function.
