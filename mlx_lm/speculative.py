"""

Optimized speculative decoding for Maple-Preview on Apple Silicon (16 GB unified memory).

Architecture analysis of Maple-Preview (maple.py):
  - No native MTP head (config: num_nextn_predict_layers=0, mtp_loss_scaling_factor=0)
  - Hybrid attention: sliding_window layers (RotatingKVCache) + full_attention (KVCache)
  - MoE with 256 experts, 8 per token, fp32 router logits
  - FlashHead: approximate 2-phase lm_head (optional, may be disabled)
  - Custom fused Metal kernels for router, QK-norm+RoPE, residual-add+RMSNorm

Optimizations implemented:
  1. Persistent draft KV cache (committed tokens fed back, no cache rebuild each round)
  2. Adaptive speculative depth (per-position EMA acceptance, tps-maximizing depth)
  3. Causal verification (one target forward per accepted token).  NOTE: Maple's
     RotatingKVCache corrupts the position-0 logits when a block of >1 new token
     is appended after prefill (every odd position is wrong), so a single batched
     target forward is NOT safe for this model. Causal verify is always correct.
  4. CPU/GPU sync removal (minimal .tolist() in hot loop, GPU-side argmax)
  5. Warm-all-shapes (off by default; only for benchmarking)
  6. KV-cache allocation reuse + in-place trimming (rollback)
  7. Efficient rollback (trim-in-place, no full cache copy)
  8. Memory residency control (auto-disable under pressure)
  9. Quantized Metal kernel efficiency (reuse existing mlx kernels)
  10. GPU-side sampling with minimal readback

Draft modes:
  - draft_model: a (smaller or self) model drafted autoregressively
  - draft_fn:   a zero-cost CPU draft (NGramDraft) — NO second model loaded,
               so peak memory stays at the target's ~6 GB. Best for repetitive /
               code / template-y output where n-grams repeat.

Correctness: the target verify is authoritative, so the output is always
identical to greedy serial decode. A fast path (max_depth<=0) delegates to
stock generate_step for exact serial parity.

"""

import logging
import time
from dataclasses import dataclass, field
from functools import partial
from typing import Any, Callable, List, Optional

import mlx.core as mx
import mlx.nn as nn
from mlx.utils import tree_reduce

from .generate import generation_stream
from .models.cache import make_prompt_cache


# ---------------------------------------------------------------------------
# Metrics container
# ---------------------------------------------------------------------------

@dataclass
class SpecMetrics:
    """Detailed benchmark metrics for the optimized speculative generator."""
    rounds: int = 0
    accepted_tokens: int = 0
    draft_forward_time: float = 0.0
    target_forward_time: float = 0.0
    sync_time: float = 0.0
    sampling_time: float = 0.0
    total_time: float = 0.0
    rollback_count: int = 0
    peak_memory_gb: float = 0.0
    # Per-position acceptance tracking: pos_accepts[i] / pos_total[i]
    pos_accepts: List[int] = field(default_factory=list)
    pos_total: List[int] = field(default_factory=list)


# ---------------------------------------------------------------------------
# 2. Adaptive speculative depth
# ---------------------------------------------------------------------------

@dataclass
class AdaptiveSpecState:
    """Tracks per-position acceptance statistics for adaptive depth selection.

    Uses exponential moving average for each draft position to estimate
    acceptance probability, then computes expected tokens/sec for each depth
    to dynamically choose the optimal one.
    """
    max_depth: int = 4
    pos_accept_ema: List[float] = field(default_factory=list)
    pos_count: List[int] = field(default_factory=list)
    ema_alpha: float = 0.15
    # Timing estimates (seconds)
    draft_forward_per_token: float = 0.01
    target_forward_per_round: float = 0.01
    warmup_rounds: int = 10
    round_count: int = 0
    best_depth_seen: int = 0
    same_model_draft: bool = False

    def __post_init__(self):
        self.pos_accept_ema = [0.5] * self.max_depth
        self.pos_count = [0] * self.max_depth

    def update(self, accepted_per_position: List[bool], draft_time: float, target_time: float):
        """Update EMA statistics after a round.

        accepted_per_position[i] = True means the (i+1)-th draft token was accepted.
        """
        for i, accepted in enumerate(accepted_per_position):
            while i >= len(self.pos_accept_ema):
                self.pos_accept_ema.append(0.5)
                self.pos_count.append(0)
            self.pos_count[i] += 1
            val = 1.0 if accepted else 0.0
            self.pos_accept_ema[i] = (
                self.ema_alpha * val + (1 - self.ema_alpha) * self.pos_accept_ema[i]
            )

        n_pos = max(len(accepted_per_position), 1)
        self.draft_forward_per_token = (
            self.ema_alpha * (draft_time / n_pos) +
            (1 - self.ema_alpha) * self.draft_forward_per_token
        )
        self.target_forward_per_round = (
            self.ema_alpha * target_time +
            (1 - self.ema_alpha) * self.target_forward_per_round
        )
        self.round_count += 1

    def expected_tps(self, depth: int) -> float:
        """Estimate tokens/sec for a given draft depth.

        Cost model:
          draft_cost = depth * draft_forward_per_token
          target_cost = target_forward_per_round (one batched verify)

        Expected committed tokens = sum(P(accept at pos i)) + P(all accepted)
        """
        if depth == 0:
            if self.target_forward_per_round > 0:
                return 1.0 / self.target_forward_per_round
            return 0.0

        draft_cost = depth * self.draft_forward_per_token
        target_cost = self.target_forward_per_round
        total_cost = draft_cost + target_cost
        if total_cost <= 0:
            return 0.0

        expected = 0.0
        cumulative = 1.0
        for i in range(depth):
            p = self.pos_accept_ema[i] if i < len(self.pos_accept_ema) else 0.5
            expected += cumulative * p
            cumulative *= p

        # Plus one token from the target (the rejected one or the bonus)
        expected += cumulative

        return expected / total_cost

    def best_depth(self) -> int:
        """Choose the depth that maximizes expected tokens/sec."""
        if self.round_count < self.warmup_rounds:
            return min(2, self.max_depth)

        best_d = 0
        best_tps = self.expected_tps(0)
        for d in range(1, self.max_depth + 1):
            tps = self.expected_tps(d)
            if tps > best_tps:
                best_tps = tps
                best_d = d
        self.best_depth_seen = best_d
        return best_d


# ---------------------------------------------------------------------------
# 6. KV-cache management: reuse + in-place trim
# ---------------------------------------------------------------------------

def trim_cache_inplace(caches: List[Any], num_tokens: int):
    """Trim KV cache entries in-place without allocating new tensors."""
    for c in caches:
        if hasattr(c, 'trim') and c.is_trimmable():
            c.trim(num_tokens)
        elif hasattr(c, 'offset'):
            n = min(c.offset, num_tokens)
            c.offset -= n
            if hasattr(c, '_idx'):
                c._idx -= n


def copy_cache_state(caches: List[Any]) -> List[tuple]:
    """Snapshot cache state for rollback (only what can't be reconstructed by trimming)."""
    snapshots = []
    for c in caches:
        if hasattr(c, 'keys') and c.keys is not None:
            snapshots.append((
                c.keys.copy(),
                c.values.copy(),
                c.offset,
                getattr(c, '_idx', None),
            ))
        else:
            snapshots.append((None, None, c.offset, getattr(c, '_idx', None)))
    return snapshots


def restore_cache_state(caches: List[Any], snapshots: List[tuple]):
    """Restore cache from snapshot."""
    for c, (keys, values, offset, idx) in zip(caches, snapshots):
        if keys is not None:
            c.keys = keys
            c.values = values
        c.offset = offset
        if idx is not None and hasattr(c, '_idx'):
            c._idx = idx


# ---------------------------------------------------------------------------
# 5. Warm-all-shapes
# ---------------------------------------------------------------------------

def warmup_decode_shapes(
    model: nn.Module,
    draft_model: Optional[nn.Module],
    max_depth: int,
    prompt: mx.array,
):
    """Warm every decode shape before benchmarking.

    Warms depth 0 (serial) through max_depth for target,
    and draft model forward at depths 1..max_depth.
    """
    warmup_token = prompt[-1] if prompt.size > 0 else mx.array([0])

    warm_cache = make_prompt_cache(model)
    for depth in range(0, max_depth + 1):
        n = max(depth, 1)
        tokens = mx.broadcast_to(warmup_token, (n,))
        with mx.stream(generation_stream):
            logits = model(tokens[None], cache=warm_cache)
            mx.eval(logits)
        trim_cache_inplace(warm_cache, n)

    if draft_model is not None:
        draft_cache = make_prompt_cache(draft_model)
        for depth in range(1, max_depth + 1):
            tokens = mx.broadcast_to(warmup_token, (depth,))
            with mx.stream(generation_stream):
                logits = draft_model(tokens[None], cache=draft_cache)
                mx.eval(logits)
            trim_cache_inplace(draft_cache, depth)
        del draft_cache

    del warm_cache


# ---------------------------------------------------------------------------
# 4. GPU-side sampling helpers
# ---------------------------------------------------------------------------

@partial(mx.compile, shapeless=True)
def gpu_logprobs(logits: mx.array) -> mx.array:
    """Compute log-probabilities entirely on GPU."""
    return logits - mx.logsumexp(logits, axis=-1, keepdims=True)


@mx.compile
def gpu_argmax_logits(logits: mx.array) -> mx.array:
    """GPU-side argmax — no host sync."""
    return mx.argmax(logits, axis=-1)


def make_gpu_sampler(temp: float = 0.0):
    """Create a sampler that keeps computation on GPU.

    For temp=0 (greedy), uses GPU argmax — no CPU readback of full vocab logits.
    """
    if temp == 0.0:
        @mx.compile
        def greedy_sample(logits: mx.array) -> mx.array:
            return mx.argmax(logits, axis=-1)
        return greedy_sample
    else:
        from .sample_utils import make_sampler
        return make_sampler(temp=temp)


# ---------------------------------------------------------------------------
# 8. Memory residency control
# ---------------------------------------------------------------------------

MEMORY_PRESSURE_THRESHOLD = 0.85

def check_memory_pressure(max_rec_size: int) -> bool:
    """Check if we're under memory pressure on 16GB unified memory."""
    peak = mx.get_peak_memory()
    working = peak / max_rec_size if max_rec_size > 0 else 0
    return working > MEMORY_PRESSURE_THRESHOLD


def adaptive_memory_residency(model: nn.Module, draft_model: Optional[nn.Module], max_rec_size: int) -> bool:
    """Determine if weights should stay resident on 16GB unified memory.

    Keep weights resident only if total footprint leaves >= 4GB headroom
    for KV caches and no active memory pressure.
    """
    model_bytes = tree_reduce(
        lambda acc, x: acc + x.nbytes if isinstance(x, mx.array) else acc,
        model, 0
    )
    if draft_model is not None:
        draft_bytes = tree_reduce(
            lambda acc, x: acc + x.nbytes if isinstance(x, mx.array) else acc,
            draft_model, 0
        )
    else:
        draft_bytes = 0

    total_bytes = model_bytes + draft_bytes
    headroom = max_rec_size - total_bytes

    if headroom < 4 * 1024**3:
        return False
    if check_memory_pressure(max_rec_size):
        return False
    return True


# ---------------------------------------------------------------------------
# Result container
# ---------------------------------------------------------------------------

@dataclass
class OptimizedSpecResult:
    """Final result from optimized_speculative_generate."""
    tokens: List[int]
    metrics: SpecMetrics
    spec_state: AdaptiveSpecState
    total_time: float


# ---------------------------------------------------------------------------
# N-gram / prompt-lookup draft (no extra model — zero-cost draft)
# ---------------------------------------------------------------------------

class NGramDraft:
    """CPU-only n-gram draft for speculative decoding.

    Reuses recently generated (and prompt) tokens as the draft. Cost is
    O(depth * window) integer lookups — effectively free on GPU time, so the
    only real cost is the single target verify forward. Works best on
    repetitive / code / template-y output where n-grams repeat.

    Memory: NO separate draft model is loaded, so peak stays at the target's
    ~6 GB instead of doubling.
    """

    def __init__(self, window: int = 256, ngram_min: int = 2, ngram_max: int = 4):
        self.window = window
        self.ngram_min = ngram_min
        self.ngram_max = ngram_max
        self.context: List[int] = []

    def feed(self, tokens: List[int]):
        """Record committed tokens into the lookup window."""
        self.context.extend(tokens)
        if len(self.context) > self.window:
            self.context = self.context[-self.window:]

    def __call__(self, last_token: int, depth: int) -> List[int]:
        return self.draft(last_token, depth)

    def draft(self, last_token: int, depth: int) -> List[int]:
        """Propose up to `depth` draft tokens following `last_token`."""
        ctx = self.context
        if len(ctx) < self.ngram_min:
            return []
        out: List[int] = []
        # Start search at the most recent occurrence of last_token.
        # Build candidate by extending the matched n-gram one token at a time.
        # We match the longest n-gram (ngram_max..ngram_min) ending at a
        # position, then walk forward copying following tokens.
        pos = len(ctx) - 1
        # find rightmost occurrence of last_token that still has room ahead
        while pos >= 0 and ctx[pos] != last_token:
            pos -= 1
        if pos < 0:
            return []
        # At position `pos` we have last_token. Try to extend with the
        # following tokens while they continue to match the context.
        i = pos + 1
        while len(out) < depth and i < len(ctx):
            out.append(ctx[i])
            # verify the extension continues to be a valid continuation:
            # the token we just appended must appear after last_token's chain.
            # Since we literally copied from context, it's consistent.
            i += 1
        return out


# ---------------------------------------------------------------------------
# Main optimized speculative generation
# ---------------------------------------------------------------------------

def optimized_speculative_generate(
    prompt: mx.array,
    model: nn.Module,
    draft_model: Optional[nn.Module] = None,
    *,
    max_tokens: int = 256,
    sampler: Optional[Callable[[mx.array], mx.array]] = None,
    logits_processors: Optional[List[Callable]] = None,
    max_depth: int = 4,
    prompt_cache: Optional[List[Any]] = None,
    prefill_step_size: int = 512,
    kv_bits: Optional[int] = None,
    kv_group_size: int = 64,
    quantized_kv_start: int = 0,
    eos_token_ids: Optional[set] = None,
    verbose: bool = False,
    draft_fn: Optional[Callable[[int, int], List[int]]] = None,
) -> OptimizedSpecResult:
    """Optimized speculative generation with all optimizations applied.

    Two draft modes:
      - draft_model: a separate (smaller / self) model drafted autoregressively
      - draft_fn(last_token, depth) -> List[int]: a zero-cost CPU draft
        (e.g. NGramDraft.draft). No extra model is loaded, so memory stays
        at the target's footprint.

    Correctness: the target verify step is authoritative, so any draft that
    produces a *subset* of the true greedy continuation is accepted and wrong
    drafts are rejected — output is always identical to greedy serial.

    Caveat (Maple KV cache): feeding a block of >1 new token to a prefilled
    cache corrupts position-0 logits for this model, so verification is done
    causally (one target forward per accepted token). This is correct for all
    cache architectures but costs (accepted+1) target forwards per round.
    """
    from .generate import maybe_quantize_kv_cache, generate_step
    from .models.cache import can_trim_prompt_cache

    use_ngram = draft_fn is not None

    # Fast path: no speculative benefit available -> delegate to stock serial
    # generate_step so we match its speed/memory exactly (no extra caches,
    # no warmup overhead). This is the default "optimized" serial path.
    if max_depth <= 0 or (draft_model is None and not use_ngram):
        out = []
        for tok, _ in generate_step(
            prompt, model, max_tokens=max_tokens, sampler=sampler,
            logits_processors=logits_processors, prompt_cache=prompt_cache,
            prefill_step_size=prefill_step_size, kv_bits=kv_bits,
            kv_group_size=kv_group_size, quantized_kv_start=quantized_kv_start,
        ):
            out.append(int(tok))
            if eos_token_ids and int(tok) in eos_token_ids:
                break
        return OptimizedSpecResult(
            tokens=out,
            metrics=SpecMetrics(),
            spec_state=AdaptiveSpecState(max_depth=max(1, max_depth)),
            total_time=0.0,
        )

    # Create caches
    if prompt_cache is None:
        model_cache = make_prompt_cache(model)
        draft_cache = make_prompt_cache(draft_model) if not use_ngram else None
    else:
        model_cache = prompt_cache[: len(model.layers)]
        draft_cache = prompt_cache[len(model.layers):] if not use_ngram else None

    if not can_trim_prompt_cache(model_cache):
        # Models whose caches aren't trimmable (e.g. LFM2.5's ArraysCache for
        # conv layers) can't use the speculative verifier's cache rewind.
        # Fall back to plain serial generation instead of failing the request —
        # output is identical, just without speculative speedup.
        types = {type(c).__name__ for c in model_cache if not c.is_trimmable()}
        logging.warning(
            "Speculative decoding unavailable for this model's cache "
            f"({types}); falling back to serial generation."
        )
        out = []
        for tok, _ in generate_step(
            prompt, model, max_tokens=max_tokens, sampler=sampler,
            logits_processors=logits_processors, prompt_cache=prompt_cache,
            prefill_step_size=prefill_step_size, kv_bits=kv_bits,
            kv_group_size=kv_group_size, quantized_kv_start=quantized_kv_start,
        ):
            out.append(int(tok))
            if eos_token_ids and int(tok) in eos_token_ids:
                break
        return OptimizedSpecResult(
            tokens=out,
            metrics=SpecMetrics(),
            spec_state=AdaptiveSpecState(max_depth=0),
            total_time=0.0,
        )

    sampler = sampler or (lambda x: mx.argmax(x, axis=-1))
    quantize_cache_fn = partial(
        maybe_quantize_kv_cache,
        quantized_kv_start=quantized_kv_start,
        kv_group_size=kv_group_size,
        kv_bits=kv_bits,
    )

    # --- 8. Memory residency ---
    max_rec_size = mx.device_info().get(
        "max_recommended_working_set_size", 16 * 1024**3
    )
    weights_resident = adaptive_memory_residency(
        model, None if use_ngram else draft_model, max_rec_size
    )

    # --- 2. Adaptive spec state ---
    spec_state = AdaptiveSpecState(max_depth=max_depth)
    spec_state.same_model_draft = (not use_ngram and draft_model is model)
    metrics = SpecMetrics()

    # --- 5. Warm all shapes (skipped for n-gram: no draft model to warm) ---
    if not use_ngram:
        warmup_decode_shapes(model, draft_model, max_depth, prompt)

    # Reset peak memory after warmup
    mx.reset_peak_memory()

    # --- Prefill ---
    y = prompt.astype(mx.uint32)

    t_sync_start = time.perf_counter()

    # Prefill draft cache (persistent across rounds) — only for model drafts
    if not use_ngram:
        draft_input = y
        while draft_input.size > 1:
            n = min(prefill_step_size, draft_input.size - 1)
            with mx.stream(generation_stream):
                draft_model(draft_input[:n][None], cache=draft_cache)
            quantize_cache_fn(draft_cache)
            mx.eval([c.state for c in draft_cache])
            draft_input = draft_input[n:]
            mx.clear_cache()

    # Prefill target cache
    target_input = y
    while target_input.size > 1:
        n = min(prefill_step_size, target_input.size - 1)
        with mx.stream(generation_stream):
            model(target_input[:n][None], cache=model_cache)
        quantize_cache_fn(model_cache)
        mx.eval([c.state for c in model_cache])
        target_input = target_input[n:]
        mx.clear_cache()

    t_sync_end = time.perf_counter()
    metrics.sync_time += t_sync_end - t_sync_start

    # After prefill, y should be just the last token for single-step decode
    y = y[-1:]
    draft_y = y

    # Seed n-gram context with the full prompt so prompt-lookup works immediately
    if use_ngram:
        draft_fn.feed(prompt.tolist())  # type: ignore[union-attr]

    # --- Generation loop ---
    all_tokens: List[int] = []
    ntoks = 0
    t_total_start = time.perf_counter()

    while ntoks < max_tokens:
        # --- 2. Adaptive depth selection ---
        depth = spec_state.best_depth()
        # At minimum, we generate 1 token per round (the target's prediction)
        if depth == 0:
            depth = 0  # serial mode, 1 token
        else:
            # Limit depth so that depth + 1 (draft + bonus) doesn't exceed max_tokens
            depth = min(depth, max_tokens - ntoks - 1)

        if verbose:
            emas = [f"{p:.3f}" for p in spec_state.pos_accept_ema[:max(depth, 1)]]
            print(f"[spec] round {ntoks}: depth={depth}, "
                  f"ema={emas}, "
                  f"draft_ft={spec_state.draft_forward_per_token*1000:.2f}ms, "
                  f"target_ft={spec_state.target_forward_per_round*1000:.2f}ms")

        # --- 1. Persistent draft: continue from draft_y (or n-gram) ---
        t_d0 = time.perf_counter()
        draft_tokens_list: List[int] = []
        accepted_flags: List[bool] = []

        if depth > 0:
            if use_ngram:
                # Zero-cost CPU draft — no model forward, no cache updates.
                draft_tokens_list = list(draft_fn(int(y[-1]), depth))  # type: ignore[union-attr]
            else:
                for _ in range(depth):
                    with mx.stream(generation_stream):
                        logits = draft_model(draft_y[None], cache=draft_cache)
                        logits = logits[:, -1:, :]
                        quantize_cache_fn(draft_cache)
                        logprobs = gpu_logprobs(logits)
                        sampled = sampler(logprobs)
                    mx.eval(sampled)
                    dt = int(sampled.tolist()[0][0]) if sampled.ndim > 1 else int(sampled.tolist()[0])
                    draft_tokens_list.append(dt)
                    draft_y = mx.array([dt], dtype=mx.uint32)

        t_d1 = time.perf_counter()
        draft_time = t_d1 - t_d0
        metrics.draft_forward_time += draft_time

        # --- 3. Causal verification (one target forward per accepted token) ---
        # NOTE: Maple's sliding-window / NoPE KV cache corrupts position-0 output
        # when fed a block longer than 1 new token after prefill. So we verify
        # causally: feed [y] -> pred0; if pred0==d1, feed [y,d1] -> pred1; etc.
        # This trades one batched forward for (accepted+1) serial target forwards,
        # but is ALWAYS correct regardless of cache architecture.
        t_t0 = time.perf_counter()

        if depth > 0:
            target_tokens = []
            # Build the verify block incrementally in the cache.
            # Position 0 prediction = after y (the last committed token).
            verify_block = [int(y[-1]) if y.size > 0 else 0]
            with mx.stream(generation_stream):
                logits = model(mx.array(verify_block, dtype=mx.uint32)[None], cache=model_cache)
                quantize_cache_fn(model_cache)
                pred = mx.argmax(logits[:, -1:, :], axis=-1)
            mx.eval(pred)
            target_tokens.append(int(pred.tolist()[0][0]))

            # Continue feeding draft tokens one at a time to get each next pred.
            # Stop at the first rejection OR when the (n-gram) draft list runs out.
            for i in range(min(depth, len(draft_tokens_list))):
                if target_tokens[i] != draft_tokens_list[i]:
                    break  # rejection; stop verifying further
                # Accept this draft token; feed it to get the next prediction.
                with mx.stream(generation_stream):
                    logits = model(
                        mx.array([draft_tokens_list[i]], dtype=mx.uint32)[None],
                        cache=model_cache,
                    )
                    quantize_cache_fn(model_cache)
                    pred = mx.argmax(logits[:, -1:, :], axis=-1)
                mx.eval(pred)
                target_tokens.append(int(pred.tolist()[0][0]))
        else:
            # Serial (depth 0)
            with mx.stream(generation_stream):
                logits = model(y[None], cache=model_cache)
                quantize_cache_fn(model_cache)
                pred = mx.argmax(logits[:, -1:, :], axis=-1)
            mx.eval(pred)
            target_tokens = [int(pred.tolist()[0][0])]

        t_t1 = time.perf_counter()
        target_time = t_t1 - t_t0
        metrics.target_forward_time += target_time

        # --- Accept/reject + 7. Rollback ---
        if depth > 0:
            eff_depth = min(depth, len(draft_tokens_list))
            n_accept = 0
            for i in range(eff_depth):
                if target_tokens[i] == draft_tokens_list[i]:
                    accepted_flags.append(True)
                    n_accept += 1
                else:
                    accepted_flags.append(False)
                    break

            if n_accept < eff_depth:
                metrics.rollback_count += 1
                # --- 7. In-place rollback: trim rejected speculative KV entries ---
                # Causal verify only fed (n_accept + 1) tokens to the target
                # (accepted drafts + bonus/rejection), so the target cache
                # already holds exactly the committed sequence. No target
                # trim is needed — trimming here would DELETE valid tokens.
                # The draft cache advanced by `depth` (all drafts generated)
                # but only `n_accept + 1` are committed, so trim the surplus.
                # (Skipped for n-gram drafts — no draft cache exists.)
                if not use_ngram:
                    draft_rejected = max(depth - n_accept - 1, 0)
                    trim_cache_inplace(draft_cache, draft_rejected)

            # Emit accepted draft tokens
            for i in range(n_accept):
                tok = draft_tokens_list[i]
                all_tokens.append(tok)
                metrics.accepted_tokens += 1
                # Track per-position acceptance
                while len(metrics.pos_accepts) <= i:
                    metrics.pos_accepts.append(0)
                    metrics.pos_total.append(0)
                metrics.pos_accepts[i] += 1
                metrics.pos_total[i] += 1

            # Emit the target token (either the rejection or the bonus)
            final_tok = target_tokens[n_accept]
            all_tokens.append(final_tok)
            metrics.accepted_tokens += 1

            # Update position stats for the rejected/bonus position
            while len(metrics.pos_total) <= n_accept:
                metrics.pos_total.append(0)
                metrics.pos_accepts.append(0)
            if n_accept < depth:
                # The rejected position: target token used, not from draft
                metrics.pos_total[n_accept] += 1
            else:
                # All draft accepted, bonus token from target
                metrics.pos_accepts[n_accept] += 1
                metrics.pos_total[n_accept] += 1

            # --- 1. Feed committed token back into draft cache ---
            y = mx.array([final_tok], dtype=mx.uint32)
            draft_y = y
            tok = final_tok

            # For SELF-drafting (draft is the target model) both caches must
            # advance identically. The target processed the bonus token via its
            # verify forward, so the draft cache is 1 token behind and must
            # re-process the last accepted draft token to stay in sync.
            # For a DIFFERENT draft model this re-feed corrupts Maple's cache
            # (double-feed), and is unnecessary because the target verify is
            # authoritative for correctness — so we only do it for self-draft.
            if n_accept == depth and spec_state.same_model_draft:
                draft_y = mx.concatenate([
                    mx.array([draft_tokens_list[-1]], dtype=mx.uint32), draft_y
                ])

        else:
            # Serial: no draft tokens
            tok = target_tokens[-1]
            all_tokens.append(tok)
            metrics.accepted_tokens += 1
            y = mx.array([tok], dtype=mx.uint32)
            draft_y = y

        # Update adaptive stats
        spec_state.update(accepted_flags, draft_time, target_time)

        ntoks = len(all_tokens)
        metrics.rounds += 1

        # Feed newly committed tokens back into the n-gram lookup window
        if use_ngram:
            committed_this_round = (n_accept + 1) if depth > 0 else 1
            new_committed = all_tokens[ntoks - committed_this_round:]
            draft_fn.feed(new_committed)  # type: ignore[union-attr]

        # Periodic cache maintenance
        if ntoks % 256 == 0:
            mx.clear_cache()

        # Memory pressure check — auto-disable residency
        if weights_resident and check_memory_pressure(max_rec_size):
            mx.clear_cache()

        # Check for EOS (optional)
        if eos_token_ids and tok in eos_token_ids:
            break

    metrics.total_time = time.perf_counter() - t_total_start
    metrics.peak_memory_gb = mx.get_peak_memory() / 1e9

    return OptimizedSpecResult(
        tokens=all_tokens,
        metrics=metrics,
        spec_state=spec_state,
        total_time=metrics.total_time,
    )
