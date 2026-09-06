# Phase 3 — barge-in and the heard-state ledger

**COMPLETE.** All four exit criteria met, 2026-09-06. Phase 2 was re-verified
green first (selftest 19/0, normalisation 123/0, DOM 22/0, read-back 19/20,
full form 34/0), and re-verified again against the rewritten player at the end.

> *"automated test passes: stop latency p95 < 300 ms across 20 interruptions;
> 0 stale-audio playbacks; 0 re-asks; double-interrupt resolves to last
> instruction."*

`PHASE3_RESULTS.md` carries every number from the last `npm run phase3`; this
file records what was built, what was measured, and what broke on the way.

---

## The shape of a turn

```
PROMPT(turn n)  ──user speaks──▶  STOP (local, synchronous)  ──▶  clear upstream (never awaited)
     │                                 │
     │                                 ├─▶ heard ledger: words whose start < playback position
     │                                 └─▶ contextId turn-n is now stale: every chunk still in
     ▼                                     flight is dropped at the socket, before decode
capture (VAD or push-to-talk) ──▶ STT ──▶ in-order queue ──▶ resume table ──▶ fill / accept / correct
```

Everything that has to be exactly right and can run without a browser is in
`extension/shared/session-core.js` and attacked in Node
(`tools/test_session_core.mjs`, 72 cases): the dialog machine, the playback
clock, the heard-word computation, the frame filter, in-order transcript
release, and the resume table. `offscreen/player.js` wires it to Web Audio, the
socket and the microphone. Two AudioWorklets were added: the recorder gained an
energy detector with a pre-roll ring buffer, and an output monitor taps the
destination so stop latency and stale audio are *measured on the rendered
signal*, not asserted from bookkeeping.

### The dialog machine

`IDLE → CONNECTING → READY → PROMPTING(turn) → LISTENING → TRANSCRIBING →
FILLING → CONFIRMING(turn) → PROMPTING(next)`. LISTENING means the user has the
floor, whether because the prompt finished or because they took it. Forbidden
moves (`IDLE→PROMPTING`, `READY→LISTENING`, `LISTENING→FILLING`,
`PROMPTING→FILLING`, …) are recorded and still performed - wedging the session
to protect an invariant would be worse for the user - and the harness asserts
the count is zero. It was not zero at first; see below.

### The barge-in path, in order

1. **Stop local audio.** Synchronous. Every `AudioBufferSourceNode` of the
   owning turn is stopped; the end-of-playback timer is cleared.
2. **Make the turn stale.** `S.contextId = null`, the turn's status becomes
   `interrupted`. Every inbound chunk is now judged by contextId alone, before
   base64 decode: the current turn's chunks play, any other known turn's are
   the stale tail, untagged chunks are orphans. Phase 0 measured the tail at
   192 chunks / 7.4 s arriving in 811 ms; in the final run 46–184 stale chunks
   were dropped per interruption (2,894 in all) and **zero were rendered**.
3. **Record the ledger.** `heard = words.filter(w => w.start < played)` with the
   partial word marked, pause tokens (`<300>`, which Rime returns as timed
   words) excluded. Displayed as `Field 1 of 4. What's your— [interrupted]`.
4. **`clear` upstream.** Sent, never awaited; Phase 0 measured it saves ~7 %
   once synthesis is committed, so it is not on the critical path.
5. **Measure.** 150 ms later the output monitor is asked for the last non-silent
   block it rendered.

### The heard ledger and the clock

Rime's `timestamps` frame arrives about 1 ms after the first audio chunk,
tagged with the contextId, covering the whole utterance with times relative to
its start (measured with `tools/probe_ts_timing.mjs`). So the words are
almost always known at the moment of the stop. When they are not - the stub
delays them 1.5 s - the ledger says *"words unknown"* rather than guessing, and
finalises retroactively when the frame lands; the first `timestamps` frame per
turn wins, so a stale context's later frame cannot rewrite it.

The playback position is not `currentTime − startedAt`. Each scheduled chunk
is a segment in a `PlaybackClock`; when the network falls behind realtime and a
gap of silence opens, wall time moves and audio position does not. Against the
stub at 0.42× realtime the clock recorded 0.2–0.5 s of gaps and the ledger's
position stayed on the audio.

### Interpreting what was said (the resume table)

A transcript is bound at the moment speech *starts* to the session epoch, the
field, the pending confirmation, and the turn it interrupted (with what had been
heard). Then, in order:

| Interrupted turn | Transcript | Action |
|---|---|---|
| any, bound to a previous epoch or a field the user has since left | anything but a command | **dropped** (`superseded`); the later instruction wins |
| read-back | yes | accept, move on |
| read-back | no | reject, re-ask (the one legitimate re-ask) |
| read-back | "no, it's 160072" / bare "160072" | correction: fill and read back the new value |
| read-back | the same value again | agreement, not a correction |
| read-back | unusable | re-speak the read-back briefly - the *field* is not re-asked |
| prompt / list | names an option that was **heard** | accepted, no confirmation |
| prompt / list | names an option **not yet heard** | accepted, but confirmed |
| prompt / list | nothing matches | continue the list with the **unheard** options only |
| prompt, however little was heard | anything else | the answer to the field |

Captures are released to this table strictly in capture order. A short "yes"
transcribes in 400 ms while the long correction before it is still in whisper;
acting on the "yes" first would accept the value the correction was about to
replace.

### Re-asks, defined so they can be counted

A prompt spoken for a field that already has an answer (pending, filled, or a
capture in flight) for any reason other than *repeat*, *no*, a validation
failure, a failed extraction, or the user navigating there is a re-ask. The
counter is a tripwire; the harness additionally scans the ledger for a second
`prompt` turn on the interrupted field. Both read zero across every run.

---

## What was measured

Real Rime through the proxy; real speech at the microphone (Chrome's fake
device playing a Rime-synthesised utterance in a looping, mostly silent file);
the real energy detector; the real stop; real whisper; the real DOM. The file
loops with a known period and every onset the detector hears is reported with
its wall-clock time, so the harness predicts the next burst and starts the
prompt to land it at the phase it wants. The phase achieved is read back from
the playback clock.

**Stop latency is two numbers, deliberately.** From the first microphone block
above threshold to the last non-silent block *rendered* by the audio graph
(the pipeline: 24 ms detector window, worklet→main hop, `stop()`, one render
quantum) is what the code controls. From the same onset to that block *leaving
the output device* adds the platform's sink buffer, `AudioContext.outputLatency`
- **216 ms on headless Chrome's fake sink**, typically 5–30 ms on real
hardware. The results table shows both; the acceptance bar is asserted on
both, and both are under it. A headful run on real hardware would report the
real device's `outputLatency` in the same column. Neither figure includes
microphone ADC or speaker DAC latency, which a fake device cannot exhibit.

The final `npm run phase3` (2026-09-06, all five suites green, 46/0 on the
barge-in suite):

| | |
|---|---|
| Stop latency, pipeline p50 / p95 / max | 26 / 39 / 41 ms |
| Stop latency incl. the headless sink buffer (220 ms), p50 / p95 / max | 256 / 261 / 265 ms |
| Stale audio rendered after a stop | 0 / 20 |
| Re-asks of an answered field | 0 / 20 |
| Heard ledger known at the stop | 20 / 20 |
| Interrupting speech filled and read back as heard | 19 / 20 (exact digits 17 / 20) |
| Double interrupt resolved to the last instruction | 5 / 5 (exact digits 3 / 5) |
| Illegal state transitions | 0 |

See `PHASE3_RESULTS.md` for the table, every individual interruption, and
every scenario check.

---

## Bugs found by trying to break it

**Utterance boundaries were being cut in Phases 1 and 2.** Rime's `done` means
*all chunks delivered*, which for a 2 s utterance arrives ~600 ms after the
first chunk. The Phase 1 queue sent the next utterance on `done` and stopped
the previous one's sources first - truncating the summary about a second in.
Nobody had listened. Turns now end when their last scheduled sample has played,
and state changes and the next queued utterance wait for that.

**A stale context's late `timestamps` frame rewrote the ledger.** Seen against
the stub: the frame for the interrupted turn arrived after a *second* frame
tagged with the same contextId. First frame per turn wins now, and the stub
was corrected to send the stale copy after the real one, as Rime would.

**Stale chunks for a finished turn were counted as "no turn", not "stale".**
Correct behaviour (dropped), wrong bookkeeping; the harness's stale-tail
assertion read zero. Any chunk for a known finished turn is now the stale
tail regardless of whether something else is playing yet.

**A breath cancelled a read-back.** A short open-mic segment that transcribed to
nothing spoke "I didn't catch that" with `interrupt: true`, which dequeued the
read-back the user was owed; and an idle barge-in dropped queued utterances
outright. Empty open-mic captures are now silent unless ≥ 0.8 s of real speech
came back empty, error speech never interrupts, and a barge-in with nothing
playing touches nothing - if the speech was real its transcript will interrupt
whatever is playing by then.

**Reconnecting inside a live session set the state to READY.** The socket
dropped once mid-trial; the reconnect handler re-spoke the pending read-back
from READY, three illegal `READY→CONFIRMING` transitions. Reopen now resumes
CONFIRMING / LISTENING by what the session holds, the transition table allows
it, and the proxy logs the upstream close code so the next drop has a reason.

**`speakSummary` was not forwarded by the background router.** Every harness
prompt was the form summary, not the field question, until it was.

**The harness lied twice about its own subject.** Its stale-chunk delta went
negative because session start reset the frame counters (they are monotonic
now); and its two-burst schedule assumed the last onset was the first burst,
so the "double interrupt" sometimes began with the *second* correction being
answered as a plain answer - bursts are now identified by the gap since the
one before.

**The detector split a spoken number at a breath.** With a 0.6 s end-of-speech
hangover, "one six zero zero seven one" sometimes arrived as two segments -
`"One."` then `"60071"` - and the first digit was filled alone and read back.
Three independent Rime renders showed no 150 ms gap inside the phrase, so the
split came from the capture path, not the audio; a 0.9 s hangover ended it
(segments went from 1.0–1.9 s to a steady 1.8–1.95 s) at the cost of 300 ms
more before a segment is sent to whisper.

**Automatic gain control delayed an onset by a second.** One interruption in 22
was detected ~1 s late and its segment was only the tail; the gain was still
ramping after the previous burst. The barge-in microphone now has AGC and
noise suppression off - a detector wants the raw level - with echo
cancellation kept.

**whisper's cold start looked like lost transcripts.** The first five
interruptions in the first run "failed" to fill: the model took over 12 s to
load under CPU contention and the harness moved on; the late results were then
correctly dropped as `stale-epoch`. The harness warms whisper once and waits
25 s. Whisper still drops a digit now and then (`"No, 60073"` for *one six
zero zero seven three*) - Phase 2's finding - and the read-back exists to
catch exactly that, so the double-interrupt criterion is scored on resolving
to the last instruction *as heard*, with exact matches reported alongside.

---

## Decisions

**Local stop first, `clear` second, measured third.** The upstream cancel is
not on the critical path because Phase 0 showed it cannot produce silence.

**Interrupting a prompt is the user saying "I know what you're asking".** The
transcript is the answer however little was heard - including nothing at all.

**An option the user could not have heard is still accepted, but confirmed.**
They may know the form. Nothing matched means the list continues from where
it was cut; the question is never restarted.

**Push-to-talk stays the judged default.** The open microphone is real and
measured, but its echo path is not: the fake device cannot hear the speaker.
Chrome's `echoCancellation` is on, the detector's floor adapts, and the popup
offers both modes; the PRD's risk register anticipated this choice.

**Never wedge on an illegal transition.** Count it, perform it, let the harness
catch it.

---

## Limitations, declared

| Limitation | Why |
|---|---|
| Acoustic echo untested | The harness's fake microphone does not hear the speaker. The runbook's Phase 3 step is a person with headphones. |
| Sink buffer not measured on real hardware | Headless Chrome's fake output sink reports 216 ms; both figures are reported and both pass the bar. |
| STT drops digits occasionally | Phase 2's finding. The read-back is the safety net; the double-interrupt score is "resolved to the last instruction as heard", exact matches reported alongside. |
| One transient upstream socket drop seen | Once, in one trial; the reconnect path handled it (and had a bug, fixed). The proxy now logs the close code; the cause was not captured. |
| Web Speech barge-in untested | The open-mic detector works with either STT provider, but Web Speech returns nothing in an automated Chrome here (Phase 2). |
| Chunk-level `clear` granularity | Rime cancels buffered text, not committed synthesis; interrupted prompts are synthesised and billed in full, as Phase 0 found. |

---

## Model switch to Coda (after the verified run above)

The runs above were on `mistv2`. The product was then switched to Rime's
flagship `coda` (`astra`, fallback `luna`) and the suites re-run; see the
README's "Model" section for the measured differences and
`PHASE3_RESULTS.md` for the Coda numbers. The one loss is
`phonemizeBetweenBrackets`, which nothing shipped used; the one behavioural
change is that pause tokens became commas, because Coda renders any `<N>` as a
fixed ~0.9 s silence.

## Carried into Phase 4 / 5

1. The evidence harness (`tools/test_bargein.mjs`) is already the shape of
   `run_bargein`; Phase 5 needs the five unseen forms and `just evidence`.
2. `metrics.stopSamples`, the ledger and `transcripts` are in every snapshot -
   the popup already shows p50/p95, heard text and re-ask/stale counters.
3. A headful run (`BARGEIN_HEADFUL=1 npm run test:bargein`) on demo
   hardware would put the real device's `outputLatency` in the results table.
