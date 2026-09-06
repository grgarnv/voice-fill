# Phase 0 runbook

Twelve steps, roughly 20 minutes. Steps 1–8 are the Rime half, 9–12 the Chrome
half. Do them in order; each one gates the next.

---

## 0. Prerequisites

This runbook supports a completely new macOS or Windows machine. Ollama is
optional: VoiceFill's deterministic commands work without it, and the
conversational intent layer can be explicitly disabled with
`VF_INTENT_PROVIDER=none`.

You need:

- Node.js `20.6` or newer
- Google Chrome `116` or newer
- A Rime API key from https://app.rime.ai/tokens
- Git, or an extracted copy of this repository
- Whisper.cpp and the English model for reliable local speech-to-text

### macOS

Install Apple's command-line tools, then install Homebrew from
https://brew.sh. In Terminal:

```bash
xcode-select --install
brew install node
node --version     # need v20.6 or newer
```

Install Google Chrome from https://www.google.com/chrome/.

### Windows

Install Node.js LTS and Chrome. In PowerShell, Node.js can be installed with:

```powershell
winget install OpenJS.NodeJS.LTS
winget install Google.Chrome
```

Restart PowerShell, then verify:

```powershell
node --version     # need v20.6 or newer
npm --version
```

Install Git from https://git-scm.com/download/win, or extract the project ZIP
instead. Windows does not have Homebrew, so do not run the macOS Whisper
install command there; follow the Windows Whisper setup in Step 5.

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

Open `.env` and set `RIME_API_KEY` and a private `PROXY_TOKEN`. The token can be
any locally generated random string; it protects the proxy from becoming an
open relay to Rime. Keep the other values from `.env.example` unless a later
step tells you to change them.

```
RIME_API_KEY=your_actual_token_here
PROXY_TOKEN=replace_with_a_random_local_token
```

No quotes, no `Bearer ` prefix, no trailing spaces. The token goes in raw.

For a setup with no Ollama, also set:

```
VF_INTENT_PROVIDER=none
```

This keeps the deterministic form-filling path enabled while turning off the
optional conversational model. To use the default local model instead, leave
this unset and complete Step 11d.

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

## 5. Install dependencies and local speech-to-text

```bash
npm install
```

This installs the Node dependencies. For reliable speech recognition, install
Whisper as well.

### macOS Whisper setup

```bash
npm run stt:install
```

This installs `whisper.cpp` with Homebrew and downloads
`ggml-medium.en.bin` into `.cache/whisper`.

### Windows Whisper setup

`npm run stt:install` is macOS-only because it calls Homebrew. On Windows:

1. Download a Windows build of `whisper-cli.exe` from the whisper.cpp releases.
2. Download the `ggml-medium.en.bin` English model.
3. Put both files somewhere such as:

   ```text
   C:\voicefill\whisper\whisper-cli.exe
   C:\voicefill\whisper\ggml-medium.en.bin
   ```

4. Add these lines to `.env`:

   ```
   WHISPER_BIN=C:/voicefill/whisper/whisper-cli.exe
   WHISPER_MODEL=C:/voicefill/whisper/ggml-medium.en.bin
   ```

Forward slashes are safest in `.env` paths. The backend does not require
ffmpeg; it sends raw PCM directly to Whisper.

If Whisper is omitted, Chrome's browser speech recognition remains available,
but it is less reliable and `/provider` will report `browser-webspeech`.

### Optional Ollama setup

Ollama is not needed for basic operation. To enable natural conversational
requests such as “go back to my email”:

macOS:

```bash
brew install ollama
ollama serve
ollama pull qwen3:8b
```

Windows PowerShell:

```powershell
winget install Ollama.Ollama
ollama pull qwen3:8b
```

Set this in `.env` on either platform:

```
VF_INTENT_PROVIDER=ollama
VF_OLLAMA_MODEL=qwen3:8b
```

If Ollama is not installed, set `VF_INTENT_PROVIDER=none` instead of leaving
the default provider pointing at an unavailable local service.

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

## 11d. Talk to it like a person (the conversational intent layer)

This is the layer from [INTENT.md](./INTENT.md). Half of it works with no extra
setup; the other half needs a model key.

**`https://httpbin.org/forms/post` is the right page to try it on.** It is a
real page on a real site, and its *Toppings* field is a four-way checkbox group
— bacon, extra cheese, onion, mushroom — which is exactly the shape every
option-selection example needs.

### The local model (default, no key)

Install Ollama using the macOS or Windows commands in Step 5, set
`VF_INTENT_PROVIDER=ollama`, and restart the backend. `curl
localhost:8787/health` should show `"intent":true`, and the backend log a line
like `[intent] ollama qwen3:8b warm in 249ms`.

### The arithmetic path — works even with ollama stopped

No configuration, no network round trip, no model. Open the form,
**Start**, and navigate to Toppings (say `next` until you hear it).

| Say | Expect |
|---|---|
| `the first two` | Bacon + extra cheese, read back |
| `the first and third` | Bacon + onion |
| `all four` / `all of them` | every topping |
| `the last two` | onion + mushroom |
| `bacon and onion` | the same two, matched by name |
| `everything except the bacon` | the other three. Before this layer, "not the bacon" *selected bacon* |
| `all but the onion` | the other three |
| `the fifth one` | **"I only have 4 options so far. Which one did you mean?"** — it asks, it does not clamp to the fourth |

On *Size* (a three-way radio, single-select), say `all of them`: it should
answer "This one takes a single answer. Which one would you like?" rather than
picking one.

### The model path — phrasings that need context rather than arithmetic

These are the ones that actually reach ollama (or Anthropic, if you set
`ANTHROPIC_API_KEY`). Expect roughly 2 s on an M-series Mac.

| Say | Expect |
|---|---|
| `the other one` (after picking one) | the remaining one, if it is unambiguous |
| `actually just the onion` | onion only, replacing the earlier pick |
| `not that one` | a clarifying question, or the alternative if there is only one |
| on a name read-back: `no no, it's Arnav` | corrected to Arnav |
| on a phone read-back: `no, the last digit is two` | the **whole** number with its last digit changed (arithmetic — works with the model off) |

---

## 11e. Spell it, shout it, and be remembered

This is the layer from [VOICE_MEMORY.md](./VOICE_MEMORY.md). All of it works
with the model off — it is arithmetic — and the profile lives in
`chrome.storage.local` on your own machine.

`https://httpbin.org/forms/post` again: its *Customer name* field is the one to
use.

| Say, on the name field | Expect |
|---|---|
| `spell it A R N A V` | **Arnav** — not `A-R-N-A-V`, not `A R N A V` |
| `My full name is Arnav Garg. Arnav is spelled A R N A V and Garg is G A R G.` | **Arnav Garg** — once, not twice |
| `Arnav Garg, all uppercase` | **ARNAV GARG** |
| `Arnav Garg, first name normal case, last name all caps` | **Arnav GARG** |
| then, on the value already there: `make it all lowercase` | **arnav garg** |
| `Arnav Garg. Arnav is A R N A V and Arnav is A R N O V` | it asks which spelling — it does not pick one |

On the *Telephone* field, with a number read back:

| Say | Expect |
|---|---|
| `no, the last digit is two` | the whole number, last digit changed |
| `the last two digits should be 42` | the whole number, last two changed |
| `change the third digit` | **"What should it be instead?"** |
| `everything is right except the last digit` | the same question — and NOT "Got it" |
| `the seventh letter is A` | **"There are only N letters in that…"** |
| `make it all caps` | it asks rather than mangling a phone number |

### Watching it learn

The interesting one needs two turns and a confirmation.

1. On the name field, say something the recogniser will get wrong — or just say
   a word you will then correct, e.g. `Enough`.
2. It reads back *Enough*. Say `No, it's Arnav. Spell it A R N A V.`
3. It reads back *Arnav*. Say `yes`.
4. **Now say `Enough` on a name field again.** It should offer *Arnav*
   immediately, and still read it back before writing it.

To see what was stored, open the extension's service-worker console and run:

```js
chrome.storage.local.get('voiceProfile').then(d => console.log(d.voiceProfile))
```

You should see one correction (`observed: "enough"`, `canonical: "Arnav"`,
`context: "name"`) and one vocabulary entry. You should **not** see any phone
number, postcode, email or free text you entered during the same session — those
contexts cannot be learned at all. `chrome.storage.local.remove('voiceProfile')`
clears it.

Two things that should NOT happen, and are worth checking on purpose:

- In a comment or notes field, say `How much is enough?` — it must stay exactly
  that sentence. A learned name is matched against the whole utterance, not
  against a substring.
- In a *City* field, say `Enough` — it must not become Arnav. The association is
  keyed to the kind of field it was learned on.
| `the second digit should be a five` | likewise, and exactly: the local model gets this one wrong on its own |
| on any read-back: `perfect` / `looks good` / `that's fine` | accepted — not written into the field as a value |

The last row is the one worth checking deliberately. Without this layer,
"Perfect." on a free-text read-back is taken as the new value and overwrites
what you just approved.

### Watching it work

The popup's Diagnostics panel and `VF_STATE` carry an `intent` block:

```
consulted   how many turns the layer looked at
byOrdinal   resolved by arithmetic, no model call
byProvider  resolved by the model
clarify     times it asked instead of guessing
rejected    model answers the validator threw out, with the reason
skipped     turns the deterministic core kept, by why
providerMs  model latency samples
```

`byOrdinal` should be much larger than `byProvider` in ordinary use. If
`providerFailures` climbs, the key or the backend is wrong — and VoiceFill
keeps working, because a failed lookup falls back to the deterministic rules.

### Kill the model mid-session

Worth doing once. `pkill ollama` and carry on talking. Ordinals, exclusion,
positional digit edits, labels, `yes`/`no`, and every command still work,
because none of them were using it. Only the genuinely contextual phrasings
degrade — and they degrade to a clarifying question, not to a wrong answer.
That is the intended failure mode, not an outage.

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
| `npm run stt:install` | macOS only | whisper.cpp via Homebrew + medium.en model into `.cache/whisper`; Windows uses the manual setup in Step 5 |

---

## If something fails

Send me the terminal output. For `npm run auth` it's safe to paste directly —
the key is redacted throughout. For the preflight, `artifacts/preflight/preflight.json`
has the full detail for every probe.
