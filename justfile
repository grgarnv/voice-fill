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
