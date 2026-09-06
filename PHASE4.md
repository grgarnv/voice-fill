# Phase 4 — Robustness

What a form does when it is not a flat list of text inputs: fields that
depend on each other, forms that replace themselves, values the page refuses,
widgets built out of divs, and inputs that own their own formatting.

Everything here is built on the Phase 3 session. Barge-in, the heard ledger,
turn invalidation, the Rime integration, the conversational intent layer,
spelling and correction, personal voice memory and conversational navigation
are unchanged; Phase 4 adds to what the session can be pointed at, not to how
it listens.

## Where the model still is not

```
USER -> STT -> personalisation -> conversational intent -> structured intent
     -> deterministic validator -> the VoiceFill state machine -> the DOM
```

Nothing in Phase 4 widens the model's reach. It gained no new verbs and no new
nouns:

- **It cannot execute anything.** No new code path takes a string from the
  model and runs it, evaluates it, or passes it to the DOM.
- **It cannot name a selector.** A custom control is located by the FieldGraph
  and written by matching the *option text the page itself published*, in
  `domwrite.js`. The model never sees an id, a class or a path, and could not
  use one if it did.
- **It cannot bypass validation.** Every value still goes through
  `valueShapeError` and `matchAllOptions` before it reaches a writer. A date is
  still refused unless it is ISO; a choice is still refused unless it is one of
  the options the user could have heard.
- **It cannot bypass turn invalidation.** The Phase 3 frame filter, playback
  clock and transcript ordering run before a transcript exists and were not
  touched.
- **It cannot decide where to go.** The form-wide validation sweep (F4.3) is
  the page reporting and `resolveNav` deciding. The model is not consulted.

Mask translation, date formatting, dependency detection and stale-selection
invalidation are all arithmetic and table lookups. There is no provider call
anywhere in Phase 4.

## What was built

### F4.1 Dependent fields — country → state → city

`fieldgraph.js` gives every field a `dependsOn`, from two signals and no
guesses: an explicit `data-depends-on` naming an earlier field, or the
country → state → city cascade matched over both the label and the `name`
attribute (half of these forms label the field "Region" and name it `state`).
Each rung binds to the *nearest earlier* field one rung up, so a city binds to
the state rather than jumping to the country.

When a field with dependents is written, the content script waits for the page
to rebuild those lists — real cascades fetch — and hands the refreshed options
back with the write result. The session folds them in *before* it asks the next
question, so a dependent field is never asked with the empty option list it had
a moment earlier.

Two kinds of stale answer are dropped, and both are recorded in `snapshot().stale`:

- an answer that is no longer among the field's options, and
- every answer hanging *transitively* off a parent whose value changed — the
  case a membership check cannot see, because the page has already emptied the
  `<select>` it would have been checked against.

A dropped field becomes unanswered and is asked again. It is not a re-ask
failure: the answer genuinely no longer exists.

### F4.2 Multi-step / wizard forms

`updateFields` is the whole of it. The pointer is kept by stable id; when the
field the session was on is gone, the form replaced itself, and the pointer
goes to the **first field of the new shape with no answer yet** — never to
whatever happens to sit at the old index.

`filled`, `answered`, `labels` and `trail` are *not* cleared. They are the
session's logical state; the DOM is only where it is currently displayed. Step
1's answers survive step 2 and are still there when the user goes back, and the
session still knows what step 1's fields were called — which is what lets
`resolveNav` answer "take me back to my phone number" with *"Phone number is
not on this part of the form any more"* instead of moving to something nearby.

VoiceFill still does not press the wizard's own Back button. That remains the
limitation Phase 3 recorded; what changed is that the session no longer loses
its place when the page presses it.

### F4.3 Validation errors

Detection was already there (F2.7: constraint validation, `aria-invalid`, and a
visible error node owned by document order). Phase 4 adds what happens next:

- **Explaining.** `explainRejection` turns Chrome's screen-shaped messages into
  something a person can act on — *"Please match the requested format."* becomes
  *"The page wants your postal code in a particular format."* Where the page
  supplied its own message it is used verbatim; it is usually the better one.
- **A ceiling that survives navigation.** `MAX_ATTEMPTS` resets on an explicit
  return, so a user who says "go back to my postcode" and repeats a rejected
  value was in a loop with no end. The session now remembers *which values the
  page refused*, per field: the same value refused twice is not offered a third
  time, and the field is left with an explanation.
- **A form-wide sweep.** `VF_CHECK_FORM` asks the page for everything it is
  currently complaining about — the case constraint validation cannot cover, a
  submit that comes back with errors on fields the session left several
  questions ago — names the first one and navigates there through the same
  resolver every other move uses.

### F4.4 Date inputs

`parseRelativeDate` adds today, tomorrow, yesterday, the day after tomorrow, "in
three days", "two weeks from now", "in a month", and "next / last / this
Friday", anchored on a caller-supplied date so the tests are not a race against
midnight.

It is deliberately narrow. Three things are **refused rather than guessed**:

| Said | Why it is refused |
|---|---|
| "Friday" | Which side of today? Genuinely ambiguous. |
| "next week" | Names a week, not a day. ("A week from today" names a day, and is accepted.) |
| "sometime next week", "maybe tomorrow" | A hedge is the user saying they have not picked a day. |

"March the fifth" — a day and a month with no year — is reported as a *missing
year* rather than as unintelligible, and the session asks *"Which year?"*
instead of asking for the whole date again.

Formats are translated at the last possible moment, in the writer. The session
holds one canonical shape per intent (ISO for dates, because that is what the
read-back speaks and what the validator checks); `formatForField` turns it into
what *this element* takes — `YYYY-MM` for `type=month`, an ISO week for
`type=week`, `…T00:00` for `datetime-local`, and whatever order a masked text
field advertises.

### F4.5 Masked inputs

`maskOf` reads the format the page states, from `data-mask`/`data-format` or a
placeholder — but only when the placeholder is unambiguously a *format*.
`(555) 555-5555`, `MM/DD/YYYY` and `___-__-____` are; `Your phone number`,
`SW1A 2AA` and `name@example.com` are not, and treating a hint as a mask would
silently mangle the value into something plausible.

`applyMask` is all-or-nothing. A half-filled mask (`(555) 12`) is a
plausible-looking wrong value, and a wrong value that reads back as if it were
right is this product's one unrecoverable failure. A value that does not fit
goes in raw and the page's own validation refuses it.

Widgets that reformat what they are given — the near-universal phone-field
idiom — used to defeat the writer's `el.value === what I wrote` check. The
comparison is now over *significant characters*, so a correct write is not
reported as a failure because the field added its own punctuation. A widget
that accepts only keystrokes gets the significant characters typed into it and
inserts its own separators.

### F4.6 Checkbox and radio groups

Already collapsed into one question by the Phase 1 scanner. Phase 4 adds "all
of them" / "everything" and "none of the above" over a group, and fixes a comma
that never worked: the list splitter used `\b,\b`, which matches nothing,
because a comma has no word boundary on either side — so "Insurance, Tracking"
was scored as one long unmatched string and selected nothing.

A selection of nothing is still read back before it counts.

### F4.7 Custom form controls

`[role=combobox]`, `[role=listbox]`, `[role=radiogroup]`, and a `[role=group]`
of `[role=checkbox]`, are scanned as fields with the types `combobox`,
`aria-radiogroup` and `aria-checkboxgroup`. Their members are options of one
question, not one yes/no field each.

They are written by clicking and *verifying*: a combobox is opened, its option
matched by the text the page published, clicked, and confirmed against
`aria-selected` / `aria-activedescendant` / the trigger's own label before it
counts. An option the widget does not offer fails; it is never approximated.

A closed listbox has no options in the DOM to read. The scanner reports **no
options** rather than inventing them; the writer opens the control and matches
against what is really there.

This also fixed a latent bug: a `[role=radiogroup]` div previously got the type
`radiogroup`, which is the type a collapsed group of *native* radios gets, and
the writer dispatched both to `writeRadio()` — which reads `.value` and
`.labels` off elements that are divs. A div-built radio group was scanned and
could never be filled.

### F4.8 React / controlled inputs

The prototype-setter write and the `_valueTracker` invalidation were already
there. What was missing was the check: **a controlled input does not revert
synchronously.** React schedules its re-render, so comparing `el.value` on the
same tick sees the pixels just written and reports success for a write React is
about to throw away.

`write()` is async now and settles one macrotask before it verifies. That is
the difference between "it looked like it worked" and knowing.

### F4.9 Dynamic DOM

The mutation observer compared *field ids* to decide whether anything had
happened. A dependent `<select>` being populated with 51 states changes no id,
so the session went on holding an empty option list and read out a question
with no answers.

The signature is now ids, types, option counts, labels and requiredness —
`VFFieldGraph.signatureOf`. The observed attribute list grew to cover what a
cascade, a wizard step and a custom control actually change (`aria-expanded`,
`aria-checked`, `aria-selected`, `required`, `value`, `role`, …), and
`VF_RESCAN` is available for a caller that knows the DOM moved and will not
wait for the 250 ms debounce.

## Running it

```bash
npm run test:phase4        # the rules in Node: dates, masks, groups. No browser.
npm run test:phase4-dom    # the scanner and the writer against the fixtures.
npm run test:phase4-form   # the whole session, real Chrome, real Rime.
npm run phase4             # all three, plus the Phase 1/2 regressions, -> PHASE4_RESULTS.md
```

`eval/fixtures/16_phase4.html` is deliberately unfriendly: the cascade
repopulates asynchronously the way a real one fetches, the phone field rewrites
whatever is typed into it, the custom select keeps its options out of the DOM
until it is opened, and the coupon field rejects a value and says why.

## Limitations

- **No step controller.** VoiceFill still cannot press a wizard's own Next or
  Back button. It follows the page; it does not drive it.
- **Dependency detection is two rules, not a model.** An explicit
  `data-depends-on`, and country → state → city. A form that cascades
  department → team, or makes → models, is not detected — the fields still fill,
  they are just not refreshed or invalidated automatically.
- **Closed custom dropdowns cannot be read aloud.** A widget that builds its
  options only when open is asked without its choices being spoken. The answer
  still resolves against the real list at write time, but a user who wanted to
  hear the options has to open the control.
- **`aria-multiselectable` listboxes are handled; roving-tabindex
  keyboard-only widgets are not.** A control that responds to arrow keys but not
  to a click on the option is out of reach, and fails rather than guessing.
- **Masks are read, never inferred.** A field that formats itself but advertises
  nothing gets the raw value and relies on its own reformatting, which is the
  case the significant-character comparison exists for. A field that neither
  advertises a mask nor reformats will be refused by its own validation, and the
  session will explain and move on rather than trying shapes.
- **Relative dates are anchored on the browser's clock and local timezone.** A
  user in a different timezone from the form's server can be a day out on
  "today"; nothing here reads the form's timezone.
- **The two-strike rule is per value, not per meaning.** Two spellings of the
  same rejected value count as two different attempts.
