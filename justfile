set dotenv-load := true

# Phase 0: real external-dependency verification. Requires network to *.rime.ai + RIME_API_KEY.
preflight:
    node scripts/probe/run_all.mjs

# Local checks only. No network. Proves nothing about Rime.
selftest:
    node tools/selftest.mjs

backend:
    node backend/server.mjs

# Loopback /ws3 stub. PLUMBING ONLY - never counts as Rime verification.
stub:
    node tools/loopback_ws_stub.mjs

secrets:
    gitleaks detect --no-banner --redact

# Print the shape of the saved voice catalog.
catalog:
    node tools/inspect_catalog.mjs

# Diagnose a 401 without printing the key.
auth:
    node tools/diagnose_auth.mjs

# What state is this checkout in?
doctor:
    node tools/doctor.mjs

# Run everything and write PHASE0_RESULTS.md
phase0:
    node tools/phase0.mjs

# --- Phase 1 -----------------------------------------------------------------

# Chrome stable 137+ ignores --load-extension; the E2E suites need this binary.
browser:
    npx @puppeteer/browsers install chrome@stable --path .cache/browsers

# FieldGraph + prompt generation against real Chrome. No network, no Rime.
test-fieldgraph:
    node tools/test_fieldgraph.mjs

# Scan real third-party forms. Network, but no Rime.
test-forms:
    node tools/test_real_forms.mjs

# Full path through the extension to real Rime. Needs the API key.
test-e2e:
    node tools/test_e2e.mjs

# The PRD Phase 1 exit criterion, on real forms with real audio.
test-exit:
    node tools/test_phase1_exit.mjs

# Everything for Phase 1, in order, writing PHASE1_RESULTS.md
phase1:
    node tools/phase1.mjs

# --- Phase 2 -----------------------------------------------------------------

# Local STT for the harness. Web Speech returns no transcript in an automated
# Chrome here (measured), and the PRD sanctions backend STT for the harness.
stt-install:
    brew install whisper-cpp
    mkdir -p .cache/whisper
    curl -fL -C - -o .cache/whisper/ggml-medium.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.en.bin

# Normalisation + extraction, pure functions. No browser, no network.
test-normalize:
    node tools/test_normalize.mjs

# DOM writing against real React. Chrome, network for the React CDN.
test-domwrite:
    node tools/test_domwrite.mjs

# The PRD's 20-item read-back round trip: real Rime -> real STT.
test-readback:
    node tools/test_readback.mjs

# One full form by voice: real mic path, real STT, real DOM.
test-voicefill:
    node tools/test_voicefill.mjs

# Everything for Phase 2, in order, writing PHASE2_RESULTS.md
phase2:
    node tools/phase2.mjs

# --- Phase 3 -----------------------------------------------------------------

# The barge-in core (state machine, clock, ledger, frame filter, resume table)
# attacked in Node. No browser, no network.
test-core:
    node tools/test_session_core.mjs

# The real thing: 20+ interruptions by speech at the microphone, real Rime,
# real VAD, real stop, real ledger, real STT. Writes artifacts/phase3_bargein.json.
test-bargein:
    node tools/test_bargein.mjs

# Delayed frames, stale tails after clear, late timestamps, slow delivery -
# through the real extension against the loopback stub. PLUMBING, labelled so.
test-bargein-stub:
    node tools/test_bargein_stub.mjs

# Everything for Phase 3, in order, writing PHASE3_RESULTS.md
phase3:
    node tools/phase3.mjs

# --- Personal voice memory ---------------------------------------------------

# Spelling assembly, casing operations, the learning gate and the profile,
# attacked in Node. No browser, no network.
test-memory:
    node tools/test_memory.mjs

# The thirteen demonstrations on a real form: real Chrome, real extension, real
# Rime audio, real chrome.storage. Writes artifacts/memory_form.json.
test-memory-form:
    node tools/test_memory_form.mjs

# --- Conversational navigation -----------------------------------------------

# The parser, the field matcher and the resolver, attacked in Node over a
# simulated session. No browser, no network.
test-navigation:
    node tools/test_navigation.mjs

# The same requests on a real form: real Chrome, real extension, real Rime
# audio, a conditional field, an inserted field and a wizard step.
# Writes artifacts/navigation_form.json.
test-navigation-form:
    node tools/test_navigation_form.mjs
