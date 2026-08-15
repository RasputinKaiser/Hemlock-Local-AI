# Hemlock optimization ledger

This ledger records measured, behavior-preserving optimization passes. The
repository was already dirty when this first baseline was created; existing
user work remains un-staged and uncommitted.

## Run 1 — 2026-08-15 (full pass, dirty)

- Applied: explicit Maple/Dream runtime launch command, fail-fast child readiness, single-flight launch handling, launch receipt tests, lazy closed/minimized surface rendering, and deferred provider CLI status checks.
- Verification: 43 agent tests, 10 UI tests, production build, syntax, YAML, browser preview, and Electron startup passed.
- Measured dev-loop medians from this machine:
  - build `0.462s -> 0.478s`
  - agent tests `0.389s -> 0.479s` (the after probe includes two new receipt tests)
  - UI tests `0.284s -> 0.274s`
  - syntax `0.111s -> 0.102s`
- Interpretation: all probes stayed green, but no wall-clock result cleared the optimization acceptance threshold (>5% or >2s). No timed speedup is claimed. The renderer work is a structural reduction in hidden-surface construction, and the runtime work is stability-oriented.
- Commits: baseline harness committed as `fb8e262`; application changes remain mixed with pre-existing user WIP and were not staged.
- Next run: add a focused renderer/runtime benchmark so UI work can be accepted or rejected with a direct runtime measurement rather than build timing.
