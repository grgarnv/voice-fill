# Personal voice memory and natural correction

The conversational intent layer made VoiceFill understandable. This makes it
correctable, and then makes it better at *this person* the more they use it.

Three problems that look different and are the same problem:

| | The person says | What must happen |
|---|---|---|
| **Spelling** | "No, it's Arnav. Spell it A R N A V." | the field gets `Arnav` — not `A-R-N-A-V`, not `A R N A V` |
| **Casing** | "make that all caps" | the value already there becomes `ARNAV GARG` |
| **Memory** | (a week later) "Arnav." → STT: "Enough." | the field offers `Arnav`, because they fixed this once already |

All three are **string arithmetic**, and all three are done by a function, not a
model. The intent layer's rule holds without exception: *AI interprets, the
deterministic core executes.*

## Spelling is not the value

This is the whole design in one line. "Spell it A R N A V" carries three
separable things, and mixing them is how you get `Arnav Garg Arnav Garg`:

```
        "My full name is Arnav Garg. Arnav is spelled A R N A V and Garg is G A R G."
                    │                        │                          │
     1. SEMANTIC VALUE              2. SPELLING EVIDENCE        (per component)
        "Arnav Garg"                   Arnav ← A,R,N,A,V
                                       Garg  ← G,A,R,G
                                              │
                                    3. deterministic assembly
                                              ▼
                                        "Arnav Garg"
```

The base value comes from the clauses that carry no letters. A clause that
spells a component contributes its **letters and nothing else** — never its
words. That single rule is why the value is not doubled, and it is asserted
against all seven phrasings of the PRD's full-name example.

**Letters win.** If the transcript says "Enough" and the person spells
`A R N A V`, the letters are the value. Spelling exists precisely for when the
recogniser is wrong, so deferring to the recogniser would defeat it.

### Recognising a spelling without a grammar

A **letter run** is three or more single-letter tokens in a row, separated by
nothing but spaces, commas, dashes or full stops. One rule covers every phrasing
the PRD lists, because STT returns all of them for the same breath:

```
"spell it A R N A V"          "that's A, R, N, A, V"        "Arnav, spelled A-R-N-A-V"
"it's spelled A R N A V"      "the spelling is A R N A V"   "no, Arnav — A R N A V"
"I'll spell that for you, A R N A V"
```

Three, not two: two consecutive single letters happen by accident ("it's a T
shirt" would spell `AT`). Two is allowed only when the word "spell" appears,
which is an explicit signal.

One ambiguity needs resolving and resolves itself. A comma inside a run may
separate two spelled *words* ("A R N A V, G A R G") or merely the *letters* of
one ("A, R, N, A, V"). The run is kept as comma-separated groups, and **a run of
single-letter groups is one word** — which is exactly the difference.

### Which parsers spelling stays out of

`normalize.js` already assembles spelled input for the fields where it matters,
and a second assembler over a working one is how both stop working:

| Intent | Owned by | What it already does |
|---|---|---|
| `idnumber` | `wordsToAlphanumeric` | letters, digits, and NATO anchors (`Q as in Quebec`) |
| `email` | `parseEmail` | `"a r n a v at gmail dot com"` → `arnav@gmail.com` |
| `postal` `pin` `phone` `number` `age` `quantity` | `wordsToDigits` | spoken digits, including the manglings STT returns |
| `date` `dob` | `parseDate` | five spoken date forms |

Spelling applies to the rest: `name`, `city`, `state`, `country`, `company`,
`jobtitle`, `address`, `comment`, `freetext`, `search`, and choice fields.

### The case an assembled word takes

Letters arrive without case, so the field decides — before any explicit
instruction, and only for the words that were actually spelled:

| Field | `A R N A V` becomes |
|---|---|
| a name, a place, an employer | `Arnav` |
| an id / reference | `ARNAV` |
| an email local part | `arnav` |

Words the person did *not* spell keep the casing they arrived with.

## Casing is a closed set of operations

The model never retypes a string. It names one of five operations, and a
function applies it:

| | Means | Said as |
|---|---|---|
| `UPPER` | every letter | "all caps", "all uppercase", "put it in capitals", "uppercase that" |
| `LOWER` | every letter | "all lowercase", "lowercase that", "make everything lowercase" |
| `TITLE` | first letter of each word | "capitalize both words", "capitalize my name", "normal case" |
| `CAPITALIZE_FIRST` | first letter of the value | "capitalize the first letter" |
| `PRESERVE` | leave it | — |

An operation carries a **scope**, so half a value can be cased differently:

```
"first name normal case, last name all caps"   Arnav Garg → Arnav GARG
"keep the surname uppercase"                   Arnav Garg → Arnav GARG
"...but keep Garg capitalized normally"        ARNAV GARG → Arnav Garg
```

A clause that carries a casing instruction names a *scope*, not a value — which
is what keeps "keep **Garg** capitalized normally" from appending a second Garg.
Unless nothing else in the utterance supplies a value, in which case that clause
is carrying it ("Arnav Garg all uppercase").

`"the first name is capital A, lowercase rnav"` is a fourth thing again — casing
given per fragment — and is assembled from its fragments. Two or more fragments
are required; one is indistinguishable from an ordinary casing instruction.

### Field-aware, and it asks rather than guessing

Silently ignoring a casing instruction leaves someone believing their value is
in caps when it is not. Silently applying one to a digit string or an option
value corrupts the field. Both are worse than a question:

| Field | "make that all caps" |
|---|---|
| name, place, employer, free text, id | applied |
| email | **asks** — an address is canonically lower, and `LOWER` is the only operation accepted |
| postcode, phone, date, amount | **asks** — there are no capital letters to change |
| a choice field | **asks** — the value must remain one of the options |

## Order of operations

Deterministic and always the same, which is what makes the combined utterances
work:

```
1. semantic value      "Arnav Garg"          from the clauses with no letters
2. spelling evidence   Arnav ← A R N A V     letters replace the word they name
3. field default case  Arnav                 applied ONLY to spelled words
4. explicit casing     ARNAV GARG            overrides the default, by scope
```

```
"My name is Arnav Garg. Arnav is spelled A R N A V, Garg is G A R G,
 and make the whole thing uppercase."                          →  ARNAV GARG
"It's Arnav, A R N A V, and make it lowercase."                →  arnav
"Arnav Garg, spell Arnav A R N A V, but keep Garg capitalized normally."
                                                               →  Arnav Garg
```

## Partial and positional corrections

Counting characters is the one correction a small model reliably gets wrong
(asked for the *second* digit of `160071`, qwen3:8b returned `160075`), so it is
arithmetic here. `editByPosition` now also covers a multi-character span:

```
"the last digit is two"                 160071      → 160072
"the second letter is A"                Brnav       → BAnav
"change the third digit to 7"           160071      → 167071
"the last two digits should be 42"      9876543210  → 9876543242
```

And it **refuses out loud** rather than falling back, because the deterministic
decision underneath is the fragment bug — it would write `2` over `160071`:

| | |
|---|---|
| "the seventh letter is A" of `Arnav` | *"There are only 5 letters in that. Which one did you mean?"* |
| "change the third digit" | *"What should it be instead?"* |
| "everything is right except the last digit" | *"What should it be instead?"* |
| two different spellings of one word | *"I heard two different spellings there. Could you spell it once more?"* |

That last row of the table is a bug this feature found: **"everything is right
except the last digit" was being ACCEPTED.** It contains "right", contains no
negation, and `parseYesNo` returned true — so VoiceFill said "Got it" and moved
on with the number the person had just told it was wrong. An acceptance that
also names a change is now routed rather than executed.

## Personal voice memory

### What is stored

One object, in `chrome.storage.local` under `voiceProfile`, on this machine
only. It is never sent to the backend or to a model.

```json
{
  "v": 1,
  "corrections":    [{ "observed": "enough", "canonical": "Arnav", "context": "name", "n": 2, "at": 0 }],
  "vocabulary":     [{ "canonical": "Arnav", "context": "name", "n": 2, "at": 0 }],
  "pronunciations": [{ "canonical": "Arnav", "phonemes": "ˈɑːrnəv", "respell": "ar nuv" }]
}
```

There is no `formatting` list, though the PRD sketches one: a casing preference
is resolved from the utterance that carries it, and a remembered one would fire
on a later turn where the person said nothing about case. A field that is only
ever sanitised is not a schema, it is a liability.

`context` is the field **intent**, not the field id. A name learned on one form
is a name on the next one; it is not a fact about `#first_name` on one site.

### Learning is confirmation-gated

A profile that is wrong is worse than one that is empty, because a wrong entry
fires silently on every later turn and the person has no way to see it. So:

```
STT: "Enough."          →  read back           →  observed  = "enough"
"No, it's Arnav.
 Spell it A R N A V."   →  one correction      →  candidate = "Arnav"
"Yes."                  →  ACCEPTED            →  LEARN
```

Exactly one correction may stand between the transcript and the acceptance. Two
in a row means the person was still deciding, and nothing is learned —
`"no, Bengaluru" … "no, actually Bengaluru City"` teaches nothing, and there is
a real-browser test that asserts it.

### What may be learned at all

| | |
|---|---|
| **Contexts** | `name` `city` `state` `country` `company` `jobtitle` `freetext` |
| **Never** | `email` `phone` `postal` `pin` `address` `idnumber` `amount` `date` `dob` `password` `comment` `search` `url`, and every choice field |
| **Value must be** | ≤ 40 chars, ≤ 4 words, no digits, no `@`, no `<>{}` |
| **Observation must be** | non-empty, ≤ 80 chars, different from the value, and not a yes/no or a command |

The value rules are shaped like the things this must never keep: account
numbers, addresses, emails, codes. A name has none of them. The last rule exists
because learning `"no" → "Arnav"` would fire on every subsequent turn.

`tools/test_memory.mjs` walks a realistic session's worth of confirmed values
past the gate — a name, a city, an employer, a postcode, a PIN, a phone number,
an email, a date of birth, an amount, an id, a street address, a password, and a
sentence about a headache — and asserts that exactly four survive.

### A learned correction is a candidate, never an override

When it fires, it produces the same thing any other interpretation produces: a
value that is shape-checked against the field and **read back before it counts**.
It cannot reach a field whose shape it does not fit, it cannot invent an option,
and it never touches a password field.

### Why "enough" does not globally become "Arnav"

Two constraints, both deterministic:

1. **Whole-utterance equality.** The transcript, minus a lead-in like "it's" or
   "my name is", must equal the stored observation. `"How much is enough?"` is
   not `"enough"`, so nothing fires. A substring rule would have produced *"How
   much is Arnav?"*, which is the failure the PRD names.
2. **Context match.** `"Enough."` in a City field is not the name learned for a
   Name field.

Both are asserted in the pure corpus and again on a real form.

### Personal vocabulary as a hint to the provider

Confirmed vocabulary for the current field's intent is added to the provider
context as `known_values` — a hint, never an instruction, and the value that
comes back is validated exactly as any other. An empty profile adds no key at
all, so the context is byte-identical to what it was before this existed.

## Rime pronunciation

The existing architecture is `speakName` + a phoneme dictionary wrapped in
braces for `phonemizeBetweenBrackets`. A **user dictionary is now layered over
the global one**, which is what the PRD asks for. Two representations, because
only one of them works on the model this product actually ships:

| | Needs | Works on |
|---|---|---|
| `phonemes` | `phonemizeBetweenBrackets` | Mist v1/v2 only |
| `respell` | nothing — it is ordinary text | any model, approximately |

**This found a latent bug.** Coda ignores `phonemizeBetweenBrackets` (PHASE0
probe 02, README "Model"), and the proxy was never sending the flag at all — so
a populated dictionary would have had Rime read `{ˈɑːrnəv}` out as its
characters. The flag is now declared by the proxy, reported in `/provider`
alongside `pauseBetweenBrackets`, and the extension gates the braces on it
exactly as it gates pause tokens. On Coda the respelling is used instead, and on
a Mist deployment the phonemes are.

This is **pronunciation control**. It is not voice cloning, it is not acoustic
adaptation, and nothing here trains a recogniser — see below.

## What this is NOT

No recording of the user's voice trains anything. Neither Web Speech nor
whisper.cpp exposes user-level acoustic adaptation, so a "read these 30 seconds
and VoiceFill will learn your accent" wizard would be a lie told with a progress
bar. What is personalised is the **interpretation of the recogniser's output**,
and it is personalised only from corrections the person explicitly confirmed.

## Where it plugs in

Two places, both inside the existing layer. The router gets one more reason to
look, and `consult` gets two more resolvers ahead of the provider:

```
resumePolicy  →  shouldConsult  →  [ordinals | spelling+casing | positional | memory]  →  provider
                                                                                            │
                                        ─────────────────────────────────────────────────────
                                        a decision in the SAME seven-action vocabulary
```

New routes:

| Route | When |
|---|---|
| `spelling-or-casing` | a letter run, or a casing instruction, is present |
| `personal-memory` | this exact utterance has been corrected before, in this kind of field |
| `accept-with-an-edit` | the table said `accept` but the utterance names a change |

Spelling and casing are checked **before** the positional editor, because
"capitalize the first letter" reads as a positional edit naming no replacement
and would otherwise have asked a question instead of doing the plainly-stated
thing.

## The model's half

`ANSWER_FIELD` / `CORRECT_VALUE` gained two arguments. Deliberately **not** a
new `MODIFY_VALUE` intent and **not** an edit DSL — the model still names WHAT,
never HOW:

```json
{
  "intent": "CORRECT_VALUE",
  "arguments": {
    "value": "Arnav Garg",
    "spelling": [{ "word": "Arnav", "letters": ["A","R","N","A","V"] },
                 { "word": "Garg",  "letters": ["G","A","R","G"] }],
    "case": "UPPER"
  }
}
```

Assembly and casing run through the **same functions** the deterministic path
uses, so a provider-resolved turn and a locally-resolved one cannot disagree
about what "all caps" means. A value may be omitted entirely for a pure
formatting change, and everything is validated against the field afterwards:
malformed structure is dropped rather than repaired, and a case operation on a
digit field is rejected outright.

In practice the model is rarely asked: the deterministic resolvers cover every
spelling and casing phrasing in the corpus. What the provider is for is the
phrasings they decline — a NATO-alphabet read-back, a two-letter spelling with
no cue — and it handles those correctly (measured, below).

### One measured prompt fix

qwen3:8b returned `CAPITALIZE_FIRST` for "make that all caps" and for "put the
surname in capitals", both of which are `UPPER`. Enum names alone were not
enough, and putting the meanings in the JSON-schema `description` changed
nothing. Spelling out all five in the **system prompt** fixed both. Recorded
because it is the kind of thing that is invisible until it is measured — and
because it is a small demonstration of why the casing operation is a closed set
applied by a function rather than a string the model retypes.

## Security and privacy

| Concern | Handling |
|---|---|
| DOM access | none. `memory.js` is pure — no `document`, no `chrome.*`, no `fetch`, no storage. Asserted by the corpus. |
| Reaching the state machine | the new paths produce only the seven existing decision actions. Asserted by the corpus. |
| Sensitive fields | passwords never reach the router; digits, emails, addresses, ids, amounts, dates and comments can never be learned. |
| A corrupted or hand-edited profile | untrusted input. `sanitize` drops anything unrecognised, caps every list at 200, and never throws — a wholly unusable profile is an empty one, and the turn still resolves. Twelve shapes of junk are in the corpus. |
| A hostile profile | an entry in a non-learnable context is dropped on load; an entry whose value the field cannot hold is rejected at validation; nothing in a profile can select an option or bypass a read-back. |
| Malformed model structure | letters that are words, markup, numbers, 500 of them, forty components, a `case` of `"DROP TABLE"` — all dropped, and the value the model also returned still stands. |
| Leaving the machine | the profile is never sent anywhere. `/intent` receives at most a list of confirmed vocabulary **strings** for the current field's intent, built in the extension. |
| Logging | the backend logs no values, as before. The profile is exposed in the extension's own state snapshot, which is local debug state containing only vocabulary the user confirmed. |

## Files

| File | Role |
|---|---|
| `extension/shared/memory.js` | **new.** Letter runs, spelling assembly, casing operations, the profile, the learning gate. Pure. |
| `extension/shared/intent.js` | two resolvers, two routes, `editRefusal`, `shapeValue`, `known_values`, structured `spelling`/`case` validation |
| `extension/shared/normalize.js` | user pronunciation dictionary, `setPhonemesEnabled` |
| `extension/shared/session-core.js` | `PROMPTING → CONFIRMING` allowed — a clarification asked over a pending read-back |
| `extension/offscreen/player.js` | profile load, the confirmation gate, persistence, the phoneme flag |
| `extension/background.js` | `voiceProfile` in `chrome.storage.local`; the offscreen document has no storage access |
| `backend/intent.mjs` | `spelling` and `case` in the schema; the casing paragraph in the system prompt |
| `backend/server.mjs` | declares and reports `phonemizeBetweenBrackets` |
| `tools/test_memory.mjs` | **new.** The pure corpus: spelling, casing, corrections, learning, adversarial. `MEMORY_LIVE=1` also scores the model. |
| `tools/test_memory_form.mjs` | **new.** The demonstrations, real browser, real DOM, real `chrome.storage`. |
| `eval/fixtures/14_memory.html` | **new.** Six fields chosen so each demonstration has somewhere to happen. |

## Results

Measurements, the acceptance audit, and every bug this found:
[VOICE_MEMORY_RESULTS.md](./VOICE_MEMORY_RESULTS.md).

## Configuration

None. There is nothing to switch on: the deterministic resolvers are always
available, the profile starts empty, and `memory.js` is optional at load time —
`intent.js` guards every use of it, so the layer still works if the file is not
loaded at all.
