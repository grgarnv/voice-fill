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
