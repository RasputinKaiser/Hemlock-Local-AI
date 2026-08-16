# Hemlock optimization ledger

This ledger records measured, behavior-preserving optimization passes. The
repository was already dirty when this first baseline was created; existing
user work remains un-staged and uncommitted.

## Run 1 — 2026-08-15 (full pass, dirty)

- Applied: explicit Maple/Dream runtime launch command, fail-fast child readiness, single-flight launch handling, launch receipt tests, lazy closed/minimized surface rendering, and deferred provider CLI status checks.
- Verification: 44 agent tests, 10 UI tests, production build, syntax, YAML, browser preview, and Electron startup passed.
- Measured dev-loop medians from this machine:
  - build `0.462s -> 0.403s`
  - agent tests `0.389s -> 0.384s` (the after probe includes three new host/receipt tests)
  - UI tests `0.284s -> 0.243s`
  - syntax `0.111s -> 0.092s`
- Interpretation: all probes stayed green, but no wall-clock result cleared the optimization acceptance threshold (>5% or >2s). No timed speedup is claimed. The renderer work is a structural reduction in hidden-surface construction, and the runtime work is stability-oriented.
- Commits: baseline harness committed as `fb8e262`; application changes remain mixed with pre-existing user WIP and were not staged.
- Next run: add a focused renderer/runtime benchmark so UI work can be accepted or rejected with a direct runtime measurement rather than build timing.

## Run 2 — 2026-08-15 (Maple runtime pass, dirty)

- Applied: Maple stream-frame coalescing at a 16 ms host-to-renderer boundary, synchronous terminal flushes, and child-process error/pre-readiness-exit receipts.
- Verification: 47 agent tests, 10 UI tests, production build, syntax, YAML, diff check, and Electron desktop startup passed. Desktop startup was stopped cleanly; no Maple inference request was sent.
- Maple health baseline: `.optimize/runs/20260815T-maple-baseline.json` measured `5.228s` to local `/health`; `.optimize/runs/20260815T-maple-after.json` measured `3.264s`. The faster after sample is recorded but not attributed because the one-shot model-load probe is cache/system-state sensitive.
- Stream probe: 4,000 synthetic source deltas reduced to 2 IPC frames across two channels (`99.95%` fewer host-to-renderer sends); this is a dispatch-count result, not a claim about Maple generation throughput.
- Full regression probe: build `0.366s`, agent tests `0.577s`, UI tests `0.301s`, syntax `0.118s`, Maple health `4.040s`, and stream dispatch `0.047s`; every probe passed.
- Commits: application changes remain mixed with pre-existing user WIP and were not staged. The new measurement artifacts are present under `.optimize/` for the next focused pass.
- Next run: if a true model-throughput claim is needed, add a bounded Maple inference benchmark only with explicit approval to invoke local inference; otherwise keep the IPC and launch receipts as the accepted host-side improvements.

## Run 3 — 2026-08-15 (Maple agent reliability and artifact autopilot, dirty)

- Applied: Explore/Build interaction mode, host-owned action compilation, artifact receipts, renderer preview-report handshake, static artifact verification, complete-source/patch repair inputs, bounded two-pass repair state, rollback, and retry/use-last-good UI actions.
- Verification: 54 agent tests, 10 UI tests, production build, syntax, diff check, and the deterministic artifact autopilot fixture passed.
- Deterministic fixture result: `completed=true`, `inferenceCalls=7`, `terminalInferenceCalls=0`, `repairCalls=2`, `repairAttempts=2`, `previewInspectionCalls=2`, `artifactRevisionCount=2`, `repositoryTouched=false`, `falseSuccess=false`.
- Measured dev-loop medians from `.optimize/runs/20260815T171003.json`: build `0.367s`, agent tests `0.371s`, UI tests `0.235s`, syntax `0.087s`, Maple health `5.003s`, stream dispatch `0.036s`, artifact autopilot `0.183s`. All probes passed; no timed speedup is claimed because this pass is primarily a correctness/false-success reduction.
- Commits: none; the repository contains pre-existing user WIP and the implementation remains unstaged/uncommitted.
- Final affected-probe verification: `.optimize/runs/20260815T-final-verify.json`; build `0.364s`, agent tests `0.406s`, UI tests `0.241s`, syntax `0.089s`, artifact autopilot `0.177s`, all green. The agent-test sample moved `0.035s` on a sub-second probe, below the skill's absolute `2s` acceptance threshold, so it is not treated as a performance regression.
- Final post-compatibility verification: `.optimize/runs/20260815T-final-verify-2.json`; build `0.428s`, agent tests `0.372s`, UI tests `0.236s`, syntax `0.090s`, artifact autopilot `0.174s`, all green. Build variance was `+0.064s` versus the prior affected run, below the absolute `2s` threshold; no timed speedup or regression is claimed.
- Next run: exercise one real Electron preview report in the desktop runtime if a visual proof is needed; keep live Maple inference optional and measure it separately from deterministic host reliability.
