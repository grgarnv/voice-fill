# Phase 0 — setup and preflight

**COMPLETE.** All four exit criteria met, 2026-09-05.
Preflight 8 PASS / 0 FAIL / 0 BLOCKED against real Rime.
Speaker `abbie`, fallback `allison`, model `mistv2`, lang `eng`, format `pcm`.

---

## Measured results

| Probe | Result |
|---|---|
| 0A Credential | Accepted, HTTP 200 |
| 00 Catalog | 123 mistv2/English voices, strict confidence. `abbie` + `allison` fallback |
| 01 REST synthesis | 36,720 B, `audio/mpeg`, valid MP3 sync |
| 02 phonemizeBetweenBrackets | Flag honoured: same text, flag toggled → 30,960 B vs 48,240 B |
| 03 pause + phoneme combined | Both accepted in one request: 87,120 B vs 127,440 B unflagged |
| 04 /ws3 chunks + timestamps | 12 word timestamps; latencies below |
| 05 clear | Buffered cancel works, in-flight does not; detail below |
| 06 contextId | Echoed **on chunk frames**; two contexts coexist on one socket |

### Time to first audio

| Format | Cold | Warm |
|---|---|---|
| pcm | 1475 ms | 513 ms |
| mp3 | 1430 ms | 516 ms |

Cold = first utterance on a new WebSocket. Warm = a later utterance on the same
open socket, identified by echoed contextId.

Two consequences. **Pre-warm the socket before the demo** — 1.5 s of silence
after someone clicks Start reads as a broken product on camera, and the fix is
free. And **format has no measurable effect on latency**, which removes the only
argument that ever favoured mp3.

---

## Decisions, now evidence-backed

**pcm, not mp3.** Chosen in planning because chunked mp3 decode inserts
frame-boundary padding that drifts against Rime's word timestamps, and the heard
ledger is precisely that comparison. Probe 04 shows the choice costs nothing:
warm 513 ms vs 516 ms. Free accuracy.

**Barge-in is local-first, and that is not a compromise.** Probe 05, the
important result of this phase:

- `clear` sent before `flush` under `segment=never` cancelled **81%** of queued
  audio (1.5 s vs 7.78 s). Buffered text is genuinely cancellable.
- `clear` sent 267 ms after audio started saved **7%**. Once synthesis is
  committed, it cannot be stopped.
- The post-cancel tail is **192 chunks / 7.41 s of audio, delivered in 811 ms**.

So: upstream cancel cannot produce silence. Local flush is the mechanism, not the
fallback. The client must discard roughly 7.4 s of audio arriving as a sub-second
burst, and that drop has to happen **at the enqueue boundary before decode** —
decoding audio you are about to throw away spends the 300 ms budget on nothing.
Probe 06 confirms `contextId` is present on chunk frames, so F3.3's design works
as written.

Prompts should therefore be sent under `segment=never` in short explicit flushes.
That keeps `clear` useful and bounds wasted synthesis. It also aligns with the
PRD's existing rule of one short question per utterance.

**Offscreen owns the WebSocket, state machine, playback clock and turn_id.**
Service workers idle out around 30 s; a form session runs for minutes. And every
`chrome.runtime` hop is 5–20 ms charged against the barge-in budget, which would
turn the ledger into a cross-context consistency problem. `background.js` routes
messages and nothing else.

**The proxy authenticates.** A shared token on the `/speak` upgrade. Without it
the backend is an open relay to the Rime key while running during a public demo.

---

## Finding that contradicts the documentation

Probe 02 tested `phonemizeBetweenBrackets` on **mistv3** with a valid mistv3
speaker (`alexis`) and found flag-ON and flag-OFF renders **differ**, suggesting
mistv3 honours the flag. Rime's phonetic-alphabet doc states Mist v1/v2 only;
LiveKit's plugin doc lists mistv3. This evidence favours LiveKit's version.

Not acted on. A byte difference is not correct pronunciation, and mistv2 is
locked for the judged flow. Confirm by ear before putting it in the README.

---

## Probe bugs found and fixed during this phase

Recorded because each produced a *confident wrong answer*, which is worse than a
failure.

**Probe 00 passed on a dead key.** The catalog endpoint does not authenticate, so
a green catalog said nothing about credentials — one credential fault presented
as six downstream failures with a PASS on top. Fixed with an auth gate (`0A`)
that runs first and stops the run.

**Probe 00's parser found zero voices in a valid catalog.** It only recorded
objects carrying a `name` field, so a catalog nesting arrays of name strings
yielded nothing, reported as "no mistv2 English voice". Rewritten to infer model
and language from the path to each leaf; seven catalog shapes now covered by a
regression test.

**Probe 02 was not a valid experiment.** It compared bracketed text *with* the
flag against different plain text *without* it — two variables at once. Rewritten
to hold text constant and toggle only the flag, which is what makes an identical
render meaningful.

**Probe 02 misread a 400 as evidence.** The mistv3 error was `Speaker 'abbie' not
found in any backend speaker map for language 'en'` — a wrong-speaker error, not
a statement about phonemes. Now resolves a real mistv3 speaker first.

**Probe 05 failed three times without ever testing `clear`.** v1 fired the cancel
on a 900 ms timer when TTFA is ~1450 ms, so it landed before any audio existed.
v2 armed correctly but sent one sentence ending in `.`, which under the default
`segment=bySentence` is dispatched on arrival — no buffer to cancel. v3 sent four
sentences but all in the same tick, so all four dispatched immediately. Only v4,
using `segment=never` with an explicit flush, made the buffer observable.

**Probe 06's verdict contradicted its own evidence.** It saw the first contextId
echoed, then concluded contextIds are not echoed. The real failure was an
under-run collection window. Rewritten to separate "is it echoed at all" from
"can two contexts interleave", and to check specifically whether the id appears
on *chunk* frames, since that is what F3.3 filters.

**Probe 04 reported warm latency as n/a twice.** First it required warm audio
before completing, so a socket that closed after the cold utterance hung until
timeout. Then it exited on the cold utterance's `done` event. Both fixed by
sending the warm utterance after cold completes and identifying its audio by
contextId — necessary because the 7.4 s cold tail would otherwise be
misidentified as warm audio.

---

## Exit criteria

| # | Criterion | Status |
|---|---|---|
| E1 | test.mp3 plays on a strict-CSP page | **PASS** — 8 ms start latency, 703 ms played, on `myaccount.google.com` |
| E2 | Rime says a phonemized word correctly | **PASS** — verified by ear |
| E3 | `/ws3` returns timestamps | **PASS** — 12 word timestamps |
| E4 | Preflight green | **PASS** — 8/8 probes |

E2 was closed by listening, not by a probe. `phonemizeBetweenBrackets` is
silently ignored on the wrong model and still returns 200 with audio, so a
passing probe only establishes that the bytes differed. The clips are committed
under `artifacts/preflight/` as evidence.

E1's audio path is independent of page CSP by construction: the offscreen
document is an extension-owned context, so a page's `script-src` cannot reach it.
Measured start latency on a hardened Google property was 8 ms.

**Phase 0 verdict: PASS. Cleared to begin Phase 1.**

## Risks carried into Phase 1

| Risk | Status |
|---|---|
| Cold TTFA 1.5 s | Confirmed. Pre-warm the socket; label warm and cold separately in evidence |
| 7.4 s stale-audio burst after barge-in | Confirmed. Drop by contextId at enqueue, before decode |
| No usable in-flight upstream cancel | Confirmed. Interrupted prompts are synthesised and billed in full |
| AEC at demo speaker volume | **Untested and now the top open risk.** Decides whether barge-in is genuinely open-mic or degrades to push-to-talk on camera. Test on demo hardware before Phase 3 |
| Only one fallback speaker configured | `allison`. Risk register rates a missing speaker Fatal; re-check the catalog at submission |

---

## Carried into Phase 1 as design constraints

These are settled by measurement, not preference:

1. **`segment=never` with short explicit flushes.** `clear` cancels buffered text
   (81% saved) but not committed synthesis (7%). Short flushes are what keep the
   cancel useful.
2. **Drop stale frames by `contextId` at the enqueue boundary, before decode.**
   The post-cancel tail is 192 chunks / 7.4 s arriving in 811 ms. Decoding audio
   that is about to be discarded spends the 300 ms budget on nothing.
3. **Pre-warm the socket.** Cold 1475 ms vs warm 513 ms. Free fix, and 1.5 s of
   silence after Start reads as a broken product on camera.
4. **pcm, 24 kHz.** No latency cost (513 vs 516 ms), and it gives the
   sample-accurate playback clock the heard ledger depends on.
5. **Offscreen owns the WebSocket, state machine, playback clock and turn_id.**
   `background.js` routes and nothing else.
