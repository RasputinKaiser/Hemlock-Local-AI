# Maple speed sweep prep (2026-08-22)

## Findings
- `--prompt-cache-file` is NOT supported by mlx_lm server (in-memory only). Closed.
- Bounded second retry on double-empty content shipped in runInference (metric: mapleDoubleEmptyRetry).
- n-gram depth already env-tunable: HEMLOCK_NGRAM_DEPTH (2..32, default 12).

## Sweep procedure (when ready to tune)
1. Ensure server healthy: curl 127.0.0.1:8080/health
2. For depth in [8, 12, 16, 24]:
   - HEMLOCK_NGRAM_DEPTH=$depth relaunch app (scripts/launch-hemlock.zsh --app)
   - Run benchmarks/maple_speculative_benchmark.py against 127.0.0.1:8080
   - Record tok/s + accept-rate for a code-heavy prompt and a prose prompt
3. Pick winner; set HEMLOCK_NGRAM_DEPTH in launch env or keep default if <5% gain.

Watch: mapleDoubleEmptyRetry metric — if it fires often, the model needs the retry;
if it's rare, the buffered fallback alone was nearly sufficient.
