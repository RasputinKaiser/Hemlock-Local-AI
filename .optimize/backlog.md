# Optimization backlog

| # | area | fix | evidence | impact | confidence | effort | score |
|---|---|---|---|---:|---:|---:|---:|
| 1 | runtime | Add a focused renderer startup/render benchmark before changing hot paths | Run 1 had only build/test/syntax timing; no direct UI runtime probe | 3 | 0.8 | 2 | 1.2 |
| 2 | devloop | Keep the verification probes as a regression guard after the Maple/Dream host action lands | Run 1: all four probes stayed green | 2 | 0.9 | 1 | 1.8 |
| 3 | model-runtime | Add an opt-in bounded inference throughput probe for Maple | Current pass intentionally measured `/health` and host IPC only; no completion request was sent | 4 | 0.7 | 3 | 0.9 |
