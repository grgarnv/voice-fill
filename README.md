# VoiceFill

A Chrome extension that adds a spoken layer to form-based websites that never
built voice in. It reads each field aloud, takes the answer by voice, writes it
into the DOM, and reads back what it entered before moving on.

**Current state: Phase 3 complete — talk over it and it stops, knows exactly
which words you heard, and never asks again for something you already
answered.** Push-to-talk by default; an open-microphone mode for barge-in by
voice. See [PHASE0.md](./PHASE0.md), [PHASE1.md](./PHASE1.md),
[PHASE2.md](./PHASE2.md) and [PHASE3.md](./PHASE3.md) for what is verified and
what is not; every number is in the matching `PHASE<N>_RESULTS.md`, generated
by the harness.

## Where the AI is, and where it is not

VoiceFill also understands ordinary conversational speech — "the first two",
"actually just the headache", "no no, it's Arnav", "no, the last digit is two" —
rather than a command language the user has to learn. A model interprets that
speech; it never executes anything.

```
STT → conversational intent layer → strict intent schema → deterministic
      validator → the existing state machine → the DOM
```

The model's entire reachable output is the set of decisions the deterministic
resume table already produces, and the validator checks every one of them
against the session's own state before it runs. It cannot name a field that is
not active, an option that was not offered, an option the user could not have
heard, or a value the field cannot hold — and a claimed confidence of 1.0 buys
none of that. Barge-in, audio cancellation, turn invalidation and the heard
ledger stay entirely deterministic and run before a transcript exists, so the
model is structurally incapable of slowing the stop down.

The model runs **locally by default** — ollama on `localhost`, no key, no
account, no per-turn cost, nothing leaving the machine — and most conversational
speech never reaches it at all: positional selection, exclusion, and positional
digit edits are arithmetic, resolved exactly and instantly. With no provider at
all VoiceFill still works on its deterministic rules.

Full design, schema, validation rules, security and privacy: [INTENT.md](./INTENT.md).

## Spelling, casing, and remembering the person

Understanding natural speech is not enough on its own: a recogniser that keeps
mishearing the same name will keep mishearing it. So a person can spell a value
("no, it's Arnav — spell it A R N A V"), spell one component of a longer one
("Arnav is A R N A V and Garg is G A R G"), ask for capitalisation in words
("all caps", "capitalize both words", "last name uppercase"), or fix a single
character ("the last digit is two") — and VoiceFill assembles the result with a
function, never by asking a model to retype a string.

Once a correction has been **confirmed**, it is remembered: the next time the
recogniser produces the same mistake in the same kind of field, the right value
is offered straight away. It is contextual, so "How much is enough?" in a
comment box stays exactly that; it is confirmation-gated, so an uncertain
correction teaches nothing; and it holds names and places only — never digits,
addresses, emails, ids or form answers. Nothing about it trains a speech model,
and it claims nothing of the sort.

Full design, the learning gate, the privacy rules and what is stored:
[VOICE_MEMORY.md](./VOICE_MEMORY.md). Measurements and the acceptance audit:
[VOICE_MEMORY_RESULTS.md](./VOICE_MEMORY_RESULTS.md).

## Moving around the form by saying so

A form is not a queue. People go back, change their minds mid-read-back, and
name the field they want: "go back two fields", "take me back to my email",
"the one before that", "I want to change what I entered for my phone number",
"no, go back to the previous field" spoken over a confirmation.

VoiceFill resolves these against **where the user has actually been**, not
against DOM order — a field that was skipped, shown conditionally, inserted
behind the pointer or removed with a wizard step is not "the previous field".
The model interprets the request and returns a direction or the words the
person used; a deterministic resolver decides which field that is, or refuses
and asks. Going back never erases: the field is spoken back with its value
still in it, and only an ordinary answer replaces it.

Full design, the structured intents, the rules and the limitations:
[NAVIGATION.md](./NAVIGATION.md).

## Rime's role

Rime produces 100% of spoken output. Text in, audio and word timestamps out.
DOM parsing, STT, value extraction and session state are ours.

| | |
|---|---|
| Model | `coda` (Rime's flagship; switched from `mistv2` on 2026-09-06, see below) |
| Speaker | `astra`, fallback `luna` — verified against the live catalog by preflight probe 00 |
| Language | `eng` |
| Endpoint | `wss://users-ws.rime.ai/ws3` |
| Audio format | `pcm` (24 kHz) — see PHASE0.md for why not mp3 |
| Transport | WebSocket via backend proxy |

### Model

Phases 0–3 were built and verified on `mistv2`, which the PRD locked because
only Mist v1/v2 honour `phonemizeBetweenBrackets`. The product was switched to
`coda` and re-verified on it. Measured on `/ws3` (`tools/probe_coda.mjs`):

| | `mistv2` | `coda` |
|---|---|---|
| Word timestamps with contextId, after first chunk | ~1 ms | 0–3 ms |
| Warm time-to-first-audio | ~510 ms | ~370 ms |
| `clear` mid-utterance | tail still delivered, `done` arrives | same |
| `<300>` pause token | 300 ms, needs the query flag | fixed ~0.9 s whatever the number, flag ignored |
| `phonemizeBetweenBrackets` | yes | **no** |

Consequences: prompts and read-backs use commas instead of pause tokens on
Coda (the proxy reports `pauseBetweenBrackets:false` and the extension strips
them; Phase 2 measured grouping, not pause length, as what carries the
read-back), and inline pronunciation control is unavailable. The name phoneme
dictionary was never populated, so nothing shipped depends on it; a Coda
deployment that needs it would have to spell names instead. Preflight probes
02 and 03 still exercise phonemes on `mistv2` with `RIME_MIST_SPEAKER`
(default `abbie`) to record what Mist can do.

## Setup

```bash
cp .env.example .env      # add RIME_API_KEY
npm install
npm run preflight         # real Rime; must be green before Phase 1
npm run stt:install       # whisper.cpp + model into .cache/whisper (backend STT)
npm run backend
# chrome://extensions -> Developer mode -> Load unpacked -> ./extension
```

### First run by hand

Two things the automated harness does for itself that a person has to do once:

1. **Proxy token.** The popup shows a token field under the provider badge
   until one is saved. Paste the `PROXY_TOKEN` from `.env`. Without it the
   proxy answers every `/speak` and `/stt` request with 401, which Chrome
   surfaces only as "websocket error".
2. **Microphone.** Click **Allow microphone** in the popup. It opens
   `extension/permission/permission.html` in a tab, because recording happens
   in an offscreen document and Chrome never shows a permission prompt for
   those. Accept once; the grant is remembered.

Then open a form, press **Start**, and hold **Hold to speak** (or the spacebar)
while you answer. The backend must report `"stt":"backend-whisper"` at
`/provider`; if it says `browser-webspeech` the whisper model was not found.

**Barge-in.** Pressing to talk while Rime speaks stops it on the press. Click
**Open mic (barge-in)** to let speech itself do that: an energy detector in the
capture worklet stops playback, sends Rime a `clear`, drops every chunk still
in flight for that turn, and records what was audible (`heard: "What's your
PIN—" [interrupted]`) from the word timestamps and the playback clock. What you
said is then interpreted against what was being said: an answer to a prompt, an
early *yes* or a correction to a read-back, an option from a list that was cut
off. The detector has not been tested against real acoustic echo here (the
harness's fake microphone cannot hear the speaker); use headphones or
push-to-talk on camera, as the PRD's risk register anticipates.

## Commands

| Command | What it does |
|---|---|
| `npm run preflight` | Seven probes against real Rime. No mocks, no fallbacks. |
| `npm run selftest` | Local checks only. Proves nothing about Rime. |
| `npm run backend` | Proxy on :8787. Holds the API key. |
| `npm run phase1` / `phase2` / `phase3` | Each phase's suites in order; writes `PHASE<N>_RESULTS.md`. |
| `npm run test:bargein` | 20+ real interruptions and the barge-in scenarios; the Phase 3 exit criterion. |
| `npm run test:intent` | The conversational intent corpus and its adversarial half, pure Node. `INTENT_LIVE=1` also scores the live model. |
| `npm run test:intent-form` | The eight conversational demonstrations on a real form in a real browser. |
| `npm run test:navigation` | Conversational navigation: parser, field matcher, resolver, over a simulated session. Pure Node. |
| `npm run test:navigation-form` | The same requests on a real form: a conditional field, an inserted field, and a wizard step. |
| `npm run test:core` | The barge-in core attacked in Node: state machine, clock, ledger, frame filter, resume table. |
| `just stub` | Loopback WebSocket stub. Plumbing only. |

## Layout

```
extension/    MV3: content script, background router, offscreen audio + session
              (offscreen/player.js), VAD recorder + output-monitor worklets,
              popup, one-time microphone permission page
  shared/     fieldgraph, prompts, normalize, domwrite, stt, session-core,
              and intent (the conversational layer - see INTENT.md)
              (dialog machine, playback clock, heard ledger, frame filter,
              in-order transcripts, resume table - pure, tested in Node)
backend/      proxy holding RIME_API_KEY; /speak WS relay, /stt, /provider, /health
scripts/probe 00 catalog · 01 REST · 02 phonemes · 03 pause+phoneme
              04 /ws3 timestamps · 05 clear · 06 contextId echo
tools/        per-phase suites (test_*.mjs, phase<N>.mjs), manifest validator,
              contract checker, self-test, loopback stub
eval/         fixtures (10 intake form, 11/12 barge-in forms), read-back clips
```

## Failure behaviour

If the Rime socket drops mid-session the badge border turns red, the utterance
in flight is recorded as failed (not left half-playing), and the proxy is
re-dialled with backoff. On recovery the pending read-back is spoken again, or
"Connection restored."; the field is not re-asked. The proxy logs the upstream
close code.

## Security

The API key lives in the backend and is never shipped to the extension. The
`/speak` upgrade requires `PROXY_TOKEN`; without it the proxy is an open relay.
`.env` is gitignored and the self-test scans for committed keys.

## Out of scope

Cross-origin iframes, closed shadow roots, CAPTCHA, payment card entry (card
numbers are never voice-filled), non-English judged flow, custom dropdown widgets
beyond native `<select>`, mobile browsers.
