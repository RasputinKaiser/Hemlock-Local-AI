# Hemlock .optimize ledger

## 2026-09-22 — Maple decode/prefill speed episode (SPEED swarm agent + integration)

Workspace: /Users/ianzvirbulis/Code/Hemlock (dirty tree, multi-agent pass).
Baseline receipt: .optimize/runs/speed-baseline.json (2026-09-21, live maple-2bit-mlx :8081).
After receipts: .optimize/runs/speed-after-{decode,prefill,score}.json (2026-09-22, same server config).

Probes (dream-chat/scripts/maple_bench.py, live server, same flags both sides):
- decode:    30.65 tok/s -> ~64 tok/s (median 58.9-67.8 across runs)  ~+2.0x
- ttft:      392.7ms    -> ~140ms (short prompt, warm)               ~-60%
- prefill:   182.6 t/s  -> ~419 t/s (3165-token prompt, cold)        ~+2.3x
- score:     318ms/cand -> ~125ms/cand (/v1/score, 8 candidates)     ~-60%
- kv-bits:   57.1 t/s exact vs 72.8 t/s kv-bits=8 at 2455-tok ctx    ~+27% (opt-in)

Changes: mlx_lm/models/maple.py — one shared (pos,eps) array per decode step
instead of ~24 per-layer mx.array dispatches (float(offset) on an mx.array
forced a GPU sync every layer of every token); fused qk norm+rope path
retained. generate.py maybe_quantize_kv_cache — only true KVCache converts
(RotatingKVCache.to_quantized raised NotImplementedError and aborted the
Metal command buffer — observed server kill; sliding layers now safely skip).
server.py --kv-bits/--quantized-kv-start plumbing; lora.py os._exit(0) GIL
finalization fix. main.cjs serverArgs: HEMLOCK_KV_BITS (default 0=off),
HEMLOCK_KV_QUANT_START (default 5000), kvBits runtime setting (next-launch).

Gates: 50/50 test_server.py, 485/485 electron, 288/291 UI (3 skip), build clean.
Identical greedy completion between exact and kv-quant configs on same prompt.
Negative/deferred: n-gram speculative still incompatible with SWA-512 (unchanged);
kv-bits opt-in, 8-bit recommended over 4.

## 2026-09-22 — PERF2 decode audit (continuation pass)

Receipts: .optimize/runs/perf2-before.json (72.12 tok/s decode on stale
checkpoint maple.py), perf2-after.json (88.49 tok/s; post-sync reference
run hit 90.78 tok/s — same code, run-to-run noise band ~3%).

BIG finding — checkpoint/runtime skew: the live model loads
~/Models/Hemlock/maple-2bit-mlx/maple.py (config.json model_file +
--trust-remote-code), NOT the repo copy. The checkpoint file predated the
prior optimization pass, so the shared (pos,eps) fix was dormant in live
serving. Copying the repo file into the checkpoint moved decode
72.1 -> ~90 tok/s with no repo diff. The checkpoint is a build artifact;
the durable fix is regenerating it through the normal packaging flow.
Backup of the pre-sync file: maple-2bit-mlx/maple.py.bak-perf2.

Decode floor analysis (standalone, plain caches, flash-head):
~1005 graph nodes/step, ~470 real kernels. eval = 11.6ms/step.
Breakdown: MoE block 7.25ms (gather_qmm pair dominant), attention 2.55ms,
rest ~1.7ms. CPU build 1.4ms standalone (~7ms server-side with batch
caches). View nodes (reshape/slice) cost ~0.85us each — not the
bottleneck. Per-kernel dispatch ~14-30us is.

Attempted, measured, REVERTED:
- Custom fused-expert Metal kernels (2-bit dequant gemv + swiglu + weighted
  down, simdgroup-cooperative, register-staged x, uint4 loads): correct
  (maxdiff 0.004) but ~0.7ms vs ~0.5ms eager gather_qmm chain per layer.
  gather_qmm is already well-tuned; a naive scalar dequant-gemv cannot beat
  it. Would need simdgroup_matrix (tensor-core) kernels — deferred.
- mx.compile over the whole expert block: router kernel mutates a device
  atomic counter (last-block-finish trick) — unsafe/incorrect inside a
  compile trace (maxdiff 0.58). Compiling only switch_mlp+aggregate works
  and is correct but measurably neutral — not retained.
- mx.compile replay of non-fusible op chains only saves ~11% eval time;
  whole-step compile is blocked by Python-int cache slice indices (would
  recompile every step).

Kept (neutral-to-small, zero-risk):
- _add_rms_norm: dropped input reshapes (kernel reads flat anyway).
- _qk_fused: consumes the flat fused qkv row, derives grid from head
  counts; saves a slice+reshape per layer.
- generate.py GenerationBatch._step: B==1 sampler fast path skips the
  per-row slice+concatenate when the batch has one request.

Sampler/logit audit: make_sampler(temp=0) already returns argmax lambda;
sampling ~0.01ms — no win available. Cache deepcopy for score forks:
~0.04ms per 8MB — not a hot spot. Prompt cache/trie path already skips
re-prefill on hits.

Gates: 50/50 test_server.py; py_compile clean on touched files.
Greedy equivalence: temp-0 completion for a fixed prompt is IDENTICAL
between the pre-perf2 checkpoint maple.py and the synced repo version.

## moe3 — fused MoE decode kernels (retained)

Replaced the single-token MoE path (gather_qmm up/gate + SwiGLU +
gather_qmm down + score-weighted aggregate, ~6 dispatches/layer) with two
custom Metal kernels in maple.py (`MapleSwitchGLU.fused_decode`):

- `maple_moe_upgate`: all 8 selected experts' fused up+gate projection,
  2-bit affine dequant in registers (grouped `s*sum(q*x)+b*sum(x)`),
  packed uint4 activation reads, clamped SwiGLU -> expert intermediates.
- `maple_moe_down`: 8 experts' down projection + router-score weighted
  accumulation -> final (1,1,2048) output in one dispatch.
- One-time `_matches` probe per layer vs the reference path; falls back to
  gather_qmm on any mismatch/failure or non-decode shape.

Correctness: fused=True on all 24 layers, maxdiff <= 0.03125 bf16,
greedy (temp-0) completion IDENTICAL fused vs reference.

Measured wins:
- in-process A/B (alternating, same session): eager eval 15.29-15.37ms vs
  fused 14.97-15.02ms -> ~0.35ms/step saved (~2.3%).
- live A/B back-to-back on :8081 (checkpoint maple.py swapped, 8-rep
  decode medians): reference 72.4 tok/s -> fused 75.7 tok/s (+3.3, ~4.6%);
  ttft ~159ms both.
- prefill unaffected (multi-token path untouched): 385.5 -> 404.6 tok/s.
- score: 128.1 -> 124.2 ms/candidate.
- standalone fused_decode 244us vs reference switch+agg 264-341us/layer.
Receipts: .optimize/runs/moe-{before,after}-{decode,prefill,score}.json
(+ an 8-rep fused decode taken pre-swap). prof_gpu: build 1.38ms,
eval 15.22ms (thermally drifted session; A/B is the arbiter).

Attempted, measured, REVERTED:
- Generic dequant-GEMV (`maple_qgemv`) for attention qkv_proj/o_proj
  M==1 calls. First version (1 row/simdgroup) lost to qmm (58 vs 45us);
  x-amortized 4-rows/simdgroup version reached parity (~49 vs 47us qkv,
  ~39 vs 33us o_proj) — never a win; MLX's tiled qmm already handles
  these shapes. Reverted; no diff remains.
- Earlier same-session fused-kernel draft (threadgroup-staged x, scalar
  dequant): eval 15.09ms vs 13.27ms baseline — slower; reworked into the
  register/uint4/grouped-affine version that was retained.

Why the win is smaller than the 7.25ms MoE line suggests: gather_qmm's
~250-340us/layer is only ~2-3x above the ~90us packed-weight read floor;
dequant fma is the wall for scalar kernels, not dispatch overhead. A
simdgroup_matrix path would still pay the same per-element unpack cost.

Gates: tests/test_server.py 63/63; py_compile clean; repo and checkpoint
maple.py byte-identical. Checkpoint backup: maple.py.bak-moe3.
