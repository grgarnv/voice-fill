# Phase 2 — answer by voice, fill, read back

**COMPLETE.** Both exit criteria met, 2026-09-05. Phase 1 was re-verified green
first (136/136).

> *"one full form filled end-to-end by voice with every high-risk field
> confirmed; a 20-item read-back round-trip (Rime → STT) ≥ 90% exact match."*

Five suites. `PHASE2_RESULTS.md` carries the numbers from the last
`npm run phase2`; this file records what was learned.

---

## The read-back metric, honestly

This is the number the PRD cares about, and getting it was not a straight line.
Every figure below is a real measurement: real Rime synthesis of the exact
utterance the product speaks, real speech-to-text (whisper.cpp), exact-match
extraction against the original value. Nothing is simulated and nothing is
estimated. Clips are in `eval/clips/{naive,tuned}/`.

### How it went

| Run | Change | naive | tuned |
|---|---|---|---|
| 1 | first cut, base.en | 15/20 | **12/20** — tuned *worse* than naive |
| 2 | parser trusts NATO anchors over the misheard letter; small.en | 14/20 | 16/20 |
| 3 | month-first dates; digit grouping by measurement | 15/20 | 17/20 |
| 4 | measure the shipped carrier phrase, not the bare value | 15/20 | 17/20 |
| 5 | "Let me read that back" carrier; bare-A-is-eight rule | 15/20 | **20/20** |

### Final, on identical audio, three recognisers, two independent runs

Each run synthesises fresh clips; each row rescored those same clips with all
three models. The spread between runs is the honest error bar.

| STT model | run A naive | run A tuned | run B naive | run B tuned | 90% bar |
|---|---|---|---|---|---|
| base.en | 13/20 (65%) | 19/20 (95%) | 15/20 (75%) | 18/20 (90%) | PASS, PASS |
| small.en | 13/20 (65%) | 18/20 (90%) | 14/20 (70%) | 18/20 (90%) | PASS, PASS |
| medium.en | 15/20 (75%) | 20/20 (100%) | 15/20 (75%) | 19/20 (95%) | PASS, PASS |

Tuned beats naive by 15–35 points on every model on both runs, and clears the
bar on every model on both runs. That robustness matters more than any single
headline: the result is not a property of having picked a flattering instrument
or a lucky run. Run B is the one `PHASE2_RESULTS.md` was generated from.

### What moved it, each measured before it was adopted

**Trust the anchor, discard the letter.** The single largest gain. Real clips
came back as *"Hugo is in Quebec, Ke is in Kilo, 5-2, T is in Tango"* for
`QK52TG`: every letter mangled, every NATO word intact. The first parser
required the anchor to follow a single-letter token, so it threw that
redundancy away and scored 0/5 on identifiers. The anchor *is* the redundancy;
the letter before it is the fragile part.

**Month first for dates.** Five forms synthesised and transcribed. Leading with
the ordinal lost three of five — "first January" came back as *"for
streaming"*, "second March" as *"Succomage"* — because an unstressed ordinal at
the start of an utterance has nothing to disambiguate it. "December 31st, 1999"
transcribed cleanly on all five.

**Pairs for short codes, 3-3-4 for phones.** Across all ten digit items, pairs
scored 10/10 against 9/10 for triples and 8/10 ungrouped. But on phones alone,
two samples each, 3-3-4 and triples scored 10/10 against pairs 9/10. Short
values and long ones want different groupings, and the measured answer for
phones is also the natural one. Pause *length* made no difference at 300, 500
or 800 ms — grouping is what carries it.

**Measure the utterance the product speaks.** The bare value is something no
user ever hears. Synthesised alone, an utterance-initial letter gets clipped
("M as in Mike" → *"And as of"*); inside the real carrier phrase it does not.
Bare 3/5 on identifiers, in-context 5/5. Both arms carry the same phrase, so
the comparison still isolates the value rendering.

**"Let me read that back", not "Got it".** 10/10 against 6/10. A short carrier
leaves the recogniser to pluralise the first digits — "zero zero" → *"zeros"*
— which silently loses one, and on one run "Got it" itself was transcribed as
the digit 5. The longer phrase also tells a user who cannot see the screen what
is about to happen.

**A bare A among anchored letters is the digit eight.** The one digit name that
collides with a letter name; measured twice on `BD8PM3 → BDAPM3`. Every real
letter in this form arrives anchored, so an *un*anchored A is the digit. Scoped
to transcripts that contain anchors, so ordinary spelling is untouched.

### What did not help, also measured

Wider pauses around digits (400 ms): no better. "Number eight" / "the digit
eight": no better than a bare digit. Saying each digit twice: 0/10, it
duplicates every one of them.

### Where the instrument ends

The residual misses at base/small are the recogniser dropping or doubling a
digit in a long run — `9000001` for `900001`, `800550199` for `8005550199` —
with different items failing on different runs. The parser cannot invent a
digit the audio lost. A stronger model recovers them from the same audio, which
is why the per-model table is the honest presentation and a single headline
figure is not.

---

## Speech-to-text: two providers, one that a harness can drive

`VFStt` exposes the same result shape for both:

- **webspeech** — the browser's `SpeechRecognition`. The PRD's option A and the
  default for the judged demo.
- **backend** — microphone PCM from an `AudioWorklet` → `POST /stt` →
  whisper.cpp. The PRD's option B.

The second exists for a reason the PRD anticipated ("use backend STT for the
harness and say so"). Chrome's Web Speech API returns **no transcript at all**
in an automated browser here. Measured: on headful Chrome stable the entire
audio chain fires — `audiostart`, `soundstart`, `speechstart`, `speechend` — so
the speech is reaching the recogniser, and no result ever comes back; headless
reports `no-speech` outright; Chrome for Testing, a Chromium build without
Google's speech keys, returns the page's own body text. A metric built on it
would be built on nothing.

Audio goes to `/stt` as raw 16-bit PCM, produced directly by the worklet, so
there is no webm/opus transcode step and no ffmpeg dependency.

---

## Bugs found by trying to break it

**A duplicate `type:` key in a message literal.** `{ type: 'VF_WRITE_FIELD',
…, type: msg.fieldType }` — the second silently wins, the content script
receives `{ type: 'text' }`, no handler matches, and every write returns null.
The session recorded a failed attempt on each field and the form stayed empty.
`tools/check_contracts.mjs` now rejects any message literal with two `type:`
keys; verified against the original bug.

**Validation attributed the page's own error banner to a valid field.** The
error finder walked up the ancestors and took the first error-shaped node, which
on any flat form is `<body>` and the site's notice. A conforming postcode was
reported invalid because of an unrelated message elsewhere on the page, which
would send good data into the retry-then-skip path. Ownership is now by
document order: an error node belongs to the last control preceding it.

**`el.value = x` does not reach React.** Confirmed with a control case: a naive
write updated the pixels and left React's state stale, which is worse than
failing because the form submits the old value. The writer goes through the
prototype setter and resets React's `_valueTracker` first; every React
assertion checks `window.__reactState`, not the DOM.

**"two hundred and fifty" extracted as 20050.** The digit-sequence reader
concatenates; an amount is arithmetic. They are now different functions.

**"the fourteenth of June two thousand twenty six" extracted as the 22nd.** The
day and the year were read as one number. The year is now identified and
removed before the day is read.

**Spoken names written with their lead-in.** *"My Name Is Alexandra
Whitfield."* — conversation, not data. Stripped.

**"seven kilo" read as an anchored letter.** Zero connectives between a token
and a NATO word is not an anchor; `SF7K` came out as `SFK`.

**"three" heard as "free", "4X" as one token.** Both dropped whole characters.
The digit table now carries the manglings a recogniser actually returns, and a
run-together digit+letter token is split before parsing.

---

## Harness findings

**The sandboxed audio service cannot read the fake-capture file.** With
`--use-file-for-fake-audio-capture`, `getUserMedia` delivered a peak of exactly
0 — from a page and from the offscreen document, headless and headful, on Chrome
for Testing and on stable. `--disable-features=AudioServiceOutOfProcess,AudioServiceSandbox`
takes it to full scale. An earlier reading of "1% amplitude" was resampling
noise on top of silence, and a detour into headful mode was a wrong turn.

**`%noloop` plays the file once, at launch.** Seconds before the test presses
to talk, so capture only ever caught silence. The file loops now, and the
mic-path assertion is about chain integrity — what STT heard is what landed —
because the surname depends on where the loop was when capture opened.

**Two things the harness did for itself that a person cannot.** Found on the
first manual run in stock Chrome, after the suites were green. The proxy token
was injected into `chrome.storage.local` over CDP, so the popup never needed a
way to enter it — and had none; every `/speak` upgrade 401'd, which the browser
reports as a bare websocket error. The microphone was granted by
`--use-fake-ui-for-media-stream`; without it, `getUserMedia` in the offscreen
document fails outright, because Chrome does not show permission prompts for
offscreen documents. The popup now has a token field, and
`extension/permission/permission.html` asks for the microphone once from a
visible tab. A green harness proves the chain, not the onboarding.

**Losing `WHISPER_MODEL` turned every answer into "I didn't catch that".** The
backend fell back to reporting `browser-webspeech` while the extension kept
posting to `/stt`, and the error was only visible in the JSON body. `stt.mjs`
now discovers a model in `.cache/whisper/` when the env line is missing.

**The full-form walk navigates by label.** A forward-only walk sat on the last
field and ran every command test against it; four assertions failed for one
reason. `gotoField` turns around at an edge.

---

## Decisions

**Confirm every high-risk field, every time.** PIN, postal, phone, ID, date,
email, amount. That is where the read-back claim lives. Free text is confirmed
when extraction was uncertain.

**Read back what is in the field, not what was meant.** A masked or coercing
input may have changed the value; the user must hear the truth.

**A correction spoken into a confirmation is a correction.** "no" clears and
re-asks; "160072" without the "no" is taken as the new value and re-confirmed;
"yes" advances. Anything else asks again.

**Two failures on a field, then skip.** Repeating the question a third time is
a trap, not help. The field is left for the user to return to.

**A command is the whole utterance.** "skip" is a command; "Skipper Jones" is a
name. Anchored to the start and bounded by length.

**Ambiguity asks.** Two options within 0.08 of each other is a coin flip the
user cannot see. "Did you mean Dermatology, or Neurology?"

---

## Limitations, declared

| Limitation | Why |
|---|---|
| Web Speech is untested end to end here | It returns nothing in an automated browser. Both providers share one interface and the backend path proves the rest of the chain; the browser path needs a human at a real microphone. |
| Read-back numbers are single-sample and vary run to run | ±1–2 items between runs on the weaker models. The per-model table on identical clips is the stable presentation. |
| The name phoneme dictionary is empty | `speakName` wraps known names in braces for `phonemizeBetweenBrackets` and falls back to the raw word. `tools/build_names.mjs` (Phase 5) fills it from `/phonemize`. |
| Manual run verified on one machine | Stock Chrome, macOS, 2026-09-05, one user. The token and microphone onboarding was found and fixed there; other profiles and OSes have not been tried. |
| Confusable letters on the STT side | The read-back anchors them; a user spelling *back* is covered ("B as in Bravo", "B for Bravo", bare NATO), but a bare "B" over a poor microphone is still a bare B. |

---

## Carried into Phase 3

1. **Push-to-talk keeps the mic shut while Rime speaks.** The echo problem does
   not arise in this mode. Open-mic barge-in is exactly where it will, and
   `echoCancellation: true` is already set on the capture constraints for it.
2. **`listenStart` / `listenStop` are the barge-in seam.** Detection replaces
   the key press; everything downstream is unchanged.
3. **The utterance queue, `abortWaits`, `stopAudio` and the contextId stale-drop**
   are all exercised by every "no" in the confirmation flow.
4. **Word timestamps are cached per contextId** and `playedSeconds()` is live.
   The heard ledger has both inputs.
