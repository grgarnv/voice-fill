# VoiceFill

A Chrome extension that adds a spoken layer to form-based websites that never
built voice in. It reads each field aloud, takes the answer by voice, writes it
into the DOM, and reads back what it entered before moving on.

**Current state: Phase 2 complete — it fills a form by voice and reads back
what it entered.** No barge-in yet; push-to-talk. Verified by hand in stock
Chrome on 2026-09-05 as well as by the harness. See [PHASE0.md](./PHASE0.md),
[PHASE1.md](./PHASE1.md) and [PHASE2.md](./PHASE2.md) for what is verified and
what is not.

## Rime's role

Rime produces 100% of spoken output. Text in, audio and word timestamps out.
DOM parsing, STT, value extraction and session state are ours.

| | |
|---|---|
| Model | `mistv2` |
| Speaker | locked by preflight probe 00 from the live catalog |
| Language | `eng` |
| Endpoint | `wss://users-ws.rime.ai/ws3` |
| Audio format | `pcm` (24 kHz) — see PHASE0.md for why not mp3 |
| Transport | WebSocket via backend proxy |

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

## Commands

| Command | What it does |
|---|---|
| `npm run preflight` | Seven probes against real Rime. No mocks, no fallbacks. |
| `npm run selftest` | Local checks only. Proves nothing about Rime. |
| `npm run backend` | Proxy on :8787. Holds the API key. |
| `just stub` | Loopback WebSocket stub. Plumbing only. |

## Layout

```
extension/    MV3: content script, background router, offscreen audio, popup,
              one-time microphone permission page
backend/      proxy holding RIME_API_KEY; /speak WS relay, /provider, /health
scripts/probe 00 catalog · 01 REST · 02 phonemes · 03 pause+phoneme
              04 /ws3 timestamps · 05 clear · 06 contextId echo
tools/        manifest validator, contract checker, self-test, loopback stub
eval/         Phase 5 harness (scaffold only)
```

## Security

The API key lives in the backend and is never shipped to the extension. The
`/speak` upgrade requires `PROXY_TOKEN`; without it the proxy is an open relay.
`.env` is gitignored and the self-test scans for committed keys.

## Out of scope

Cross-origin iframes, closed shadow roots, CAPTCHA, payment card entry (card
numbers are never voice-filled), non-English judged flow, custom dropdown widgets
beyond native `<select>`, mobile browsers.
