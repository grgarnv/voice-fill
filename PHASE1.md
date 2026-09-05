# Phase 1 — read the form aloud

**COMPLETE.** All exit criteria met, 2026-09-05.
136 automated checks across five suites: 19 self-test, 70 FieldGraph, 7 real
forms, 22 end-to-end, 18 exit criterion. 0 fail, 0 blocked.

Phase 0 was re-verified green before starting: 8/8 probes against real Rime,
speaker `abbie` still present in the live catalog.

---

## Exit criteria

> *"on 3 different real forms, the extension reads the first 5 fields aloud with
> sensible questions, popup shows Rime as active provider."*

Verified on **four** real, unmodified third-party forms, with Chrome running
**without** `--autoplay-policy=no-user-gesture-required` so the offscreen
document has to earn its playback the way it will on camera.

| Form | Fields found | Read aloud | Audio |
|---|---|---|---|
| selenium.dev web-form | 11 | 5 | 2.0–4.9 s each |
| httpbin.org pizza order | 7 | 5 | 1.6–7.2 s each |
| demoqa practice form (React) | 11 | 5 | 1.7–4.7 s each |
| github.com/login (strict CSP) | 2 | 2 | 2.1 / 3.2 s |

"Read aloud" is a measurement, not a claim: every field records its contextId,
chunk count and synthesised duration. `artifacts/phase1_exit.json` has the full
transcript of what was spoken.

Provider disclosure is read back off the rendered popup and compared against
what the proxy actually opened the socket with, so a hardcoded badge string
cannot pass.

---

## Protocol findings

Three facts about `/ws3` that are **not** interchangeable with the REST API's
shape. Each was measured, and each would have shipped a broken demo.

### `pauseBetweenBrackets` is a query param only

Prompts emit Rime pause tokens (`Choose one: <300> Small, <400> Medium`). Sent
the way REST accepts it — as a per-message field — the flag is silently ignored
and every token is read out as *"less than four hundred greater than"*.

| How the flag was sent | Audio for the same text |
|---|---|
| absent | 2.17 s |
| **query param** | **4.17 s** |
| per-message field | 2.17 s |

Set once on the URL in `backend/rime.mjs`. `VFPrompts.setPauseEnabled()` is the
belt-and-braces guard: if the proxy ever reports the flag off, the tokens are
dropped from the text rather than spoken.

### `segment=never` is honoured, and probe 05 never actually tested it

Verified directly: `segment=never` with no flush produces **0 chunks**; with an
explicit flush, 86. So Phase 0's design constraint 1 is sound.

But `openWs3()` in `scripts/probe/lib/rime.mjs` destructured only
`{speaker, modelId, audioFormat, samplingRate}` — it never forwarded `segment`.
Probe 05 passed `segment: 'never'` and it was dropped on the floor, meaning its
headline result (83% of buffered audio cancellable) was measured under **default
segmentation**. The conclusion survives, but it was not evidence for the
mechanism it was cited for. Fixed; the parameter now reaches the URL.

### Back-to-back utterances cancel each other

The one that actually broke the product. Three `text`+`flush` pairs on one
socket, sent with no gap:

| Spacing | Audio produced per contextId |
|---|---|
| back-to-back | `{"C-prompt": 3.38}` |
| 250 ms apart | `{"A-prewarm": 0.64, "B-summary": 1.71, "C-prompt": 1.96}` |
| 1500 ms apart | `{"A-prewarm": 0.58, "B-summary": 1.75, "C-prompt": 2.09}` |

A later send discards whatever is pending — no chunks, no `done`, no error. The
end-to-end run caught it as `contexts={"turn-3": 18}`: the spoken form summary
was being synthesised and thrown away every single time, and nobody would have
noticed until the demo.

Fixed with a **serialised utterance queue** in the offscreen document that waits
for each `done` before sending the next. Interrupting stays immediate — when the
user presses Next, replacing the in-flight utterance is precisely what should
happen — so the queue has two modes and Next/Previous/Repeat use the interrupt
path.

---

## Bugs found by trying to break it

Every one of these was found by an adversarial fixture or a real site, and every
one produced *plausible-looking wrong speech* rather than an error.

**A field was announced with the previous field's label.** `preceding-text`
walked into a sibling container that already labelled another control. For a
user who cannot see the screen, being asked the wrong question is the worst
failure this product has. Candidates that contain a form control, that are a
`<label>`, or that are already some other field's `aria-labelledby` target are
now rejected, and the walk stops at the form boundary instead of climbing out to
adopt the page's `<h1>`.

**Radio groups were named after their first option.** A radio's own `<label>` is
its *option* text, so running the normal chain on a group with no `<fieldset>`
produced `"Yes. Choose one: Yes, No."` Groups now resolve through legend →
`role=radiogroup` → the group container's leading text, and never through the
per-control rules. The original test asserted only that *a* label existed, which
is how it passed while saying that out loud.

**Wikipedia's navigation was read as form fields.** `Main menu?` and
`Appearance?` are `<input type=checkbox role=button aria-haspopup=true>`
dropdown toggles. Real checkboxes in the DOM, pure chrome to a user. The radio/
checkbox exemption from the opacity rule — correct, because custom-styled
controls are genuinely `opacity:0` with a visible label — is what let them
through. The discriminator is the role, not the styling. Wikipedia went from 7
"fields" to 4 real ones.

**Disabled and readonly fields were being asked as questions.** `.disabled`
reflects the *attribute* only, so a control inside `<fieldset disabled>` reports
`false`; `:disabled` accounts for the ancestor.

**Example-value placeholders were spoken as labels.** demoqa's email field asked
*"What's your name@example.com?"*. Placeholders shaped like sample values —
emails, `DD/MM/YYYY`, phone patterns, URLs, `e.g. …` — are rejected, and the
chain falls through to the humanised `name`, which then classifies correctly as
an email field.

**`opacity:0` on a parent was invisible to the check.** opacity does not
inherit, so an input inside an `opacity:0` wrapper reports `1` on itself. Same
for the 1px `overflow:hidden` sr-only/honeypot wrapper, which leaves the input's
own border box at full size. Both need an ancestor walk.

**`<option value="">Please choose…</option>` was offered as an answer** — and
so was selenium's `<option selected>Open this select menu</option>`, which has no
`value` attribute to give it away. That one needs three signals together (first,
selected, no explicit value, placeholder wording) so a genuine first option
reading "Select Committee" survives.

**`position: fixed` controls were dropped.** `offsetParent === null` is true for
every fixed element, visible or not — a sticky header search box would vanish
from the graph.

**`chrome.storage` does not exist in an offscreen document.** Its API surface is
limited to `chrome.runtime`; reading storage throws and the session died before
the socket opened. Config is now resolved in the background and passed down with
the message that needs it. `tools/check_contracts.mjs` now fails the build on
`chrome.storage` or `chrome.tabs` in offscreen code.

---

## Tooling finding: Chrome no longer loads unpacked extensions

`--load-extension` is silently ignored by Chrome stable 137+. Verified on
**Chrome 152**, headless *and* headful, with `--enable-unsafe-extension-debugging`
and with `--disable-features=DisableLoadExtensionCommandLineSwitch`. No target
for the extension ever appears and nothing is logged.

Chrome for Testing keeps the flag working. Every suite that needs the extension
actually loaded uses that binary:

```bash
npm run browser     # npx @puppeteer/browsers install chrome@stable --path .cache/browsers
```

Two related traps, both hit and both now handled: Chrome's own component
extensions also expose a service worker named `background.js`, so "the first
extension target" resolves to the wrong extension — the id is derived from the
extension path instead (SHA-256, first 16 bytes, nibbles mapped to `a`–`p`). And
the self-test looked for Chrome on `PATH` only, reporting BLOCKED on a machine
with Chrome installed, because macOS keeps it in an `.app` bundle. A false
BLOCKED reads as "environment problem, not my code" and gets skipped.

---

## Decisions

**The scanner is tested against real Chrome, never a DOM shim.** Every
interesting case here is a DOM-semantics edge — `offsetParent` under
`position:fixed`, ancestor opacity, `:disabled` through a fieldset, open vs
closed shadow roots, `label[for]` with a CSS-special id. A shim would be testing
its author's beliefs about those rules. The harness injects the exact files the
extension ships and scans through CDP.

**The extension asks for `activeTab`, not `<all_urls>`.** The user's click on
the action grants access to the tab they are on, which is all a session needs.
The test harness runs a *copy* of the extension with a broader host permission,
because a harness cannot produce that click; the only difference from what ships
is the permission the click would grant anyway.

**Pre-warm happens when the popup opens, not when Start is pressed.** Queued
ahead of the summary it would simply move the same 1.5 s in front of the first
prompt. Its audio is addressed to a contextId that is never current, so every
chunk it produces takes the same stale-drop path a Phase 3 barge-in will use —
the mechanism is exercised on every single session before it is ever needed.

**Stale chunks are dropped before decode, at the enqueue boundary.** Phase 0
constraint 2, now load-bearing rather than aspirational.

---

## Limitations, declared

| Limitation | Why |
|---|---|
| Fields inside iframes are not read | The content script is injected in all frames, but a session addresses frame 0 only. Cross-origin frames are a wall by construction; same-origin ones would need per-frame field ids and frame-relative ring positioning. PRD lists this as a Phase 1 limitation. |
| Closed shadow roots are unreachable | By construction. Open roots, including nested ones, are scanned. |
| Custom dropdown widgets (react-select etc.) | Have no native `<option>` list. Native `<select>`, `<datalist>`, radio and checkbox groups are covered. |
| A field hidden mid-animation may be missed | The `opacity:0` ancestor rule cannot distinguish a fade-in from a hidden element. The MutationObserver rescans on style and class changes, so it self-corrects. |
| `activeTab` is revoked on navigation | Fine for a single-page session; a multi-step wizard (F4.2) will need to re-establish it. |

---

## Carried into Phase 2 and 3

1. **The utterance queue is the barge-in seam.** Phase 3 interrupts by clearing
   the queue, aborting the pending wait, advancing `turn_id` and cutting local
   audio — all four already exist and are exercised by Next/Previous/Repeat.
2. **Word timestamps arrive and are cached** (`S.lastWordTimestamps`), tagged
   with their contextId. The heard ledger has its input.
3. **`playedSeconds()` is live**, measured against an `AudioContext` running at
   Rime's exact 24 kHz so no resampling sits between the clock and the
   timestamps.
4. **`contextsSeen` and `rawChunkFrames`** are in the state snapshot. When audio
   fails to stop in Phase 3, that is the first thing worth looking at.
5. **Confirmation read-back (F2.5) has no normaliser yet.** `extension/shared/`
   is where `normalize.js` goes, shared with the eval harness as the PRD intends.

---

## What is NOT done

Phase 2 and Phase 3 were explicitly out of scope: no microphone, no STT, no
value extraction, no DOM writing, no barge-in, no heard ledger. The plumbing
those need is in place and instrumented, but none of it is implemented.
