# Phase 0 runbook

Twelve steps, roughly 20 minutes. Steps 1–8 are the Rime half, 9–12 the Chrome
half. Do them in order; each one gates the next.

---

## 0. Prerequisites

```bash
node --version     # need v20.6 or newer
```

You also need a Rime API key from https://app.rime.ai/tokens and Google Chrome
(version 116+, for the offscreen document API).

---

## 1. Get a clean copy

Extract the zip somewhere fresh. If you extract over an existing folder you can
end up with a half-old tree, which is how `node_modules` disappeared last time.

Run this from the PARENT directory. `unzip` from inside `voicefill/` creates a
nested `voicefill/voicefill/`, and the nested copy has no `.env` — it is
gitignored and never in the archive.

```bash
cd ~/Desktop          # parent, NOT inside voicefill
unzip -o voicefill-phase0.zip
cd voicefill
pwd                   # sanity check: must not end in voicefill/voicefill
ls          # expect: README.md PHASE0.md RUNBOOK.md package.json justfile
            #         extension/ backend/ scripts/ tools/ eval/
```

---

## 2. Create your .env

```bash
cp .env.example .env
```

Open `.env` and set **only** `RIME_API_KEY`. Leave `RIME_SPEAKER` empty — step 6
fills it in for you.

```
RIME_API_KEY=your_actual_token_here
```

No quotes, no `Bearer ` prefix, no trailing spaces. The token goes in raw.

---

## 3. Check nothing in your shell is shadowing .env

```bash
env | grep RIME
```

**Expect no output.** If anything appears, your shell environment overrides
`.env` — you would edit the file, see no change, and blame the API. Clear it:

```bash
unset RIME_API_KEY RIME_SPEAKER
```

The loader also warns about this automatically, but checking first saves a cycle.

---

## 4. Verify the credential

```bash
npm run auth
```

This needs no dependencies installed. It prints key metadata with the value
redacted — length, first 6 characters, last 4, whitespace, wrapping quotes,
embedded "Bearer", non-ASCII, placeholder detection — then runs a live three-way
test: no header, raw token, and `Bearer` + token.

**Looking for:** `Bearer + token (what we send)   200  <N bytes of audio>`

If it 401s, the verdict block names the cause. Rime's documented bodies are
`missing headers` (no Authorization header sent) and `invalid api key` (token
unrecognised, or sent without the Bearer scheme). If the no-header control
returns "missing headers" while yours returns "invalid api key", the header is
correct and the token value is being rejected — regenerate it at
https://app.rime.ai/tokens.

**Do not continue until this returns 200.** Everything downstream depends on it.

---

## 5. Install dependencies

```bash
npm install
```

One dependency, `ws`. Takes a few seconds.

---

## 6. Run the preflight

```bash
npm run preflight
```

Eight checks against real Rime. No mocks, no fallbacks.

| | Check |
|---|---|
| 0A | Credential accepted — gates everything else |
| 00 | Live catalog, locks an English speaker for `RIME_MODEL_ID` (coda) + fallback |
| 01 | REST synthesis on the configured model |
| 02 | `phonemizeBetweenBrackets` |
| 03 | `pauseBetweenBrackets` + `phonemizeBetweenBrackets` together |
| 04 | `/ws3` chunks and word timestamps, pcm and mp3 |
| 05 | `clear` stops in-flight synthesis |
| 06 | Inbound frames echo `contextId` |

The last line prints the speaker to paste into `.env`.

**If a probe fails**, its note says what to do. Two matter most:

- **06 FAIL** — chunks don't echo `contextId`. Feature F3.3's stale-drop design
  doesn't work as specified and must move to a local generation counter. This is
  an architecture change, so it gates Phase 1. Tell me if it fails.
- **03 FAIL** — the pause and phoneme flags don't combine. Phase 2 read-back
  normalization gets redesigned. Also gates Phase 1.

---

## 7. Listen to the audio

**This is a required step, not a nicety.** `phonemizeBetweenBrackets` is silently
ignored on the wrong model — audio still comes back and the HTTP status is still
200. A green probe means the bytes differed, not that the pronunciation is right.

```bash
open artifacts/preflight/          # macOS
```

| File | Must sound like |
|---|---|
| `02_mistv2_phonemes_ON.mp3` | "actually, GLOR-bee-oo-lets is made up" — a pronounced word, not spelled letters, and no bracket characters read aloud |
| `02_mistv2_phonemes_OFF.mp3` | The same sentence unphonemized. Compare the two; they must differ audibly |
| `03_pause_plus_phoneme.mp3` | A real gap after "one six zero", then a spoken name. No literal "300", no brackets |
| `02_mistv3_phonemes_ON.mp3` | For the README note on the mistv2-vs-mistv3 doc discrepancy. Whatever it does, record it |

---

## 8. Record the speaker

Paste the values the preflight printed into `.env`:

```
RIME_SPEAKER=astra
RIME_SPEAKER_FALLBACK=luna
```

The fallback matters: your risk register lists "speaker missing from mistv2 at
submission" as Low likelihood but **Fatal** impact. A configured second voice is
the whole mitigation.

---

## 9. Start the backend

In its own terminal, left running:

```bash
npm run backend
```

Expect `VoiceFill proxy on :8787  (key loaded)`. If it says `key MISSING`, the
`.env` isn't being read.

Check it in a second terminal:

```bash
curl localhost:8787/health
curl localhost:8787/provider
```

`/provider` should report `rime` / `coda` / your speaker / `pcm`. That endpoint
feeds the popup's required active-provider badge.

---

## 10. Load the extension

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `extension/` folder — the one containing `manifest.json`, not the
   repo root

It should appear as "VoiceFill 0.1.0" with no errors. If Chrome refuses to load
it, run `node tools/validate_manifest.mjs` and send me the output.

---

## 11. The strict-CSP audio test

This is exit criterion E1, and the site choice is the point — a locked-down page
is what proves the offscreen document plays audio independently of page CSP.

1. Open a bank login page, or any site with a strict Content-Security-Policy
2. Click the VoiceFill icon in the toolbar
3. Check the status rows: content script, service worker, offscreen document
4. Click **Play test tone on this page**

**Expect three ascending beeps** and the Audio playback row turning green with a
start latency in milliseconds.

The click is what satisfies Chrome's autoplay policy — a suspended AudioContext
has to be resumed inside the gesture's call stack, which is why the test is a
button and not automatic.

If nothing plays, open the offscreen document's console:
`chrome://extensions` → VoiceFill → **service worker** → Console.

---

## 11b. Fill a form by voice (Phase 2, by hand)

The harness sets these two things through DevTools and a fake-media flag. A
person has to do them once per Chrome profile.

1. Restart the backend if you added `WHISPER_MODEL` to `.env` after starting
   it, then check `curl localhost:8787/provider` reports `"stt":"backend-whisper"`.
   `browser-webspeech` means no model was found; run `npm run stt:install`.
2. Open a form — `https://httpbin.org/forms/post` is a good first one — and
   click the VoiceFill icon.
3. Under the provider badge, paste the `PROXY_TOKEN` from `.env` and click
   **Save**. The Rime socket row goes green and the badge shows the speaker.
   Until this is done every request is a 401, which the popup can only show as
   "websocket error – is the backend running on :8787?"
4. Click **Allow microphone**. A tab opens with one button; click it, accept
   Chrome's prompt, close the tab. Offscreen documents cannot prompt, so the
   grant has to come from a visible extension page.
5. Press **Start**. Hold **Hold to speak** or the spacebar while you answer,
   release, and watch the `heard:` line. The value is written, read back, and
   you say yes or no.

If holding to speak fails, the line under the button now says why (`mic: …`).

---

## 11c. Talk over it (Phase 3, by hand)

Push-to-talk already barges in: press **Hold to speak** while Rime is talking
and the audio stops on the press. The open microphone is what the PRD's hard
problem is about, and it needs a working echo path, which the harness could
not test (its fake device does not hear the speaker).

1. Use headphones, or keep the speaker quiet enough that the microphone does
   not hear Rime. Chrome's echo cancellation is on for the capture; whether it
   is enough on your hardware is exactly what this step finds out.
2. Click **Open mic (barge-in)**. The `Hold to speak` button hides; the mic is
   live for the rest of the session.
3. Press **Start**, and start answering before the question finishes. The audio
   stops within a few tens of milliseconds; the line under the mic buttons
   shows `heard: "Field 1 of 4. What's your—" [interrupted]` - the words that
   were actually audible, from Rime's word timestamps and the playback clock.
4. Let it read a PIN back and say **yes** before it finishes. It accepts.
   Say **no, it's …** with a new number: the new number is read back instead.
   Interrupt that read-back too: the last thing you said wins.
5. The Diagnostics panel shows the running p50/p95 stop latency, and
   `RE-ASKS` / `STALE AUDIO` counters that should stay at zero. The **State
   machine** row shows the dialog state and any illegal transition.

If Rime's voice fires the detector on your hardware (the audio stops itself
mid-sentence with nobody speaking), click **Push-to-talk** and use the key for
the demo, as the PRD's risk register anticipates.

---

## 12. Verify the exit criteria

| # | Criterion | How you confirmed it |
|---|---|---|
| E1 | test.mp3 plays on a strict-CSP page | Step 11, three beeps heard |
| E2 | Rime says a phonemized word correctly | Step 7, ear check on 02 |
| E3 | `/ws3` returns timestamps | Step 6, probe 04 PASS |
| E4 | Preflight green | Step 6, 8/8 PASS |

All four, plus both ear checks, and Phase 0 is genuinely done.

---

## Command reference

| Command | Needs install? | What it does |
|---|---|---|
| `npm run auth` | no | Diagnose a credential, key never printed |
| `npm run preflight` | yes | Eight probes against real Rime |
| `npm run catalog` | no | Print the voice catalog's structure |
| `npm run selftest` | yes | Local checks only; proves nothing about Rime |
| `npm run backend` | yes | Proxy on :8787, holds the API key |
| `npm run stt:install` | no | whisper.cpp via Homebrew + medium.en model into `.cache/whisper` |

---

## If something fails

Send me the terminal output. For `npm run auth` it's safe to paste directly —
the key is redacted throughout. For the preflight, `artifacts/preflight/preflight.json`
has the full detail for every probe.
