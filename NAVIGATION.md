# Conversational navigation

Moving around a form by saying so - "go back", "go back two fields", "take me
back to my email", "the one before that", "I want to change what I entered for
my phone number" - including while a read-back is outstanding and while the
assistant is still speaking.

Built on the layers that already exist. Nothing here is a second state machine:

```
USER SPEECH → STT → PERSONALIZATION → CONVERSATIONAL INTENT → STRUCTURED INTENT
            → DETERMINISTIC VALIDATOR → VOICEFILL STATE MACHINE → DOM
```

The model interprets. It never picks a field.

## What decides where you land

Three functions in `extension/shared/session-core.js`, all pure, all testable
in Node, all reachable only through the session:

| | |
|---|---|
| `parseNavigation(text)` | transcript → a structured navigation intent, or null. Narrow on purpose: the obvious requests resolve here with no model and no latency; everything contextual falls through to null, which is what routes it to the layer. |
| `matchFieldReference(phrase, fields)` | a spoken name → the fields it could mean. Returns every near-tie, which is what makes "my name" on a form with a first and a last name a question rather than a coin flip. |
| `resolveNav(nav, ctx)` | intent × session state → the field to move to, or the reason it will not. |

`resolveNav` is given the session's own truth and nothing else: the fields
reachable right now, where the pointer is, the **trail** (the field ids in the
order the user actually met them), what has been answered, and the label of
every field seen this session.

**"The previous field" is the previous field in the trail, not `index - 1`.**
A field that was skipped, shown conditionally, inserted by the page behind the
pointer, or removed with a wizard step is not somewhere the user has been, and
`index - 1` says otherwise. The trail is recorded in `player.js` by `visit()`
on every move, on session start, and on every DOM rescan.

Forward is form order: "move forward one field" means the next field on the
page, which is what a person means by it.

## The structured intent

The existing schema, extended - not a second one. `backend/intent.mjs` adds
five values to the same enum and four arguments to the same object:

```json
{ "intent": "NAVIGATE_RELATIVE",
  "arguments": { "direction": "backward", "count": 2 },
  "confidence": 0.96, "needs_clarification": false }

{ "intent": "NAVIGATE_TO_FIELD",
  "arguments": { "field_reference": "phone number" },
  "confidence": 0.94, "needs_clarification": false }
```

`NAVIGATE_PREVIOUS`, `NAVIGATE_NEXT`, `NAVIGATE_RELATIVE`,
`NAVIGATE_TO_FIELD`, `NAVIGATE_TO_REFERENCED_FIELD`.

A reference is **the words the person used**. There is no field id, no index,
no selector and no script anywhere in the reachable output, and
`validateIntent` rejects anything that is not the shape above before the
session sees it. `field_id`, if a model echoes one on a navigation, is ignored
outright - naming another field is what a move IS, and the target still comes
only from the reference, resolved against the session's own fields. (Measured:
qwen3:8b puts the target's label there. Rejecting those threw away correct
readings; obeying them was never on the table.)

## Routing

Deterministic first. Over the browser suite, 15 navigation turns resolved with
no model call and 2 reached the provider - the two whose phrasing the parser
could not resolve. A named target the matcher finds is the fast path; one it
cannot find is sent to the layer, because the words may be a phrasing the
matcher missed rather than a field the form lacks. An **ambiguous** one is
never sent: two fields matching equally well is a question for the person.

## The rules that do not bend

- **Navigation outranks the confirmation flow.** "No, go back to the previous
  field" into a read-back is a request to move, not a rejection. The value was
  written to the page before it was ever read back, so it stays there.
- **Going back never erases.** The field is spoken back with what is in it -
  "Email address currently has..." - and only an ordinary answer replaces it.
- **A move can carry a change.** "Take me back to my name - it's actually
  Arnav" moves, then applies the value **to the field it lands on**, shaped by
  the same check a spoken value gets, and read back before it counts. A clause
  that names no value ("the last digit is wrong") just moves.
- **It refuses rather than guesses.** Ambiguous, unknown, out of bounds, or on
  a step that is no longer on the page: it says so and moves nothing.
- **Barge-in is untouched.** Navigation is decided after the transcript
  exists, which is after audio has already stopped; nothing on the interrupt
  path waits for a model. Two navigations in one breath are processed in
  capture order and the last one wins.

## Running it

```
npm run test:navigation        # parser, matcher, resolver, simulated session
npm run test:navigation-form   # real Chrome, real Rime, real DOM
```

Measured, 2026-09-06: `test:navigation` 157/157. `test:navigation-form` 53/53
against a live ollama provider, with no stale audio, no illegal state
transitions and no capture left hanging. The integration pass on the same day
re-ran the neighbouring suites unchanged: barge-in 46/46 (real speech, stop p50
26 ms), memory-on-a-form 53/53, delayed-frame plumbing 16/16, the intent layer
on a form 31/31, and the Phase 2 voice fill 34/34.

## Limitations

- **Multi-step forms are met halfway.** VoiceFill has no step controller (F4.x
  is unbuilt), so it cannot press a wizard's Back button. A field on a step
  that is no longer in the DOM is named and refused - "Email address is not on
  this part of the form any more. Which field did you mean?" - and the same
  request resolves, with its value intact, the moment the page shows that step
  again. `resolveNav` returns `reason: 'off-step'` with the label, which is the
  seam a step controller would use.
- Field-name matching is over labels, `name` attributes and a table of
  synonyms. A form that labels a field in a way none of those covers is
  reachable through the model, and unreachable by name if the provider is off.
- "Go back to the one before that" is read as two fields back. It is genuinely
  ambiguous in English; the reading is documented rather than guessed at each
  time.
