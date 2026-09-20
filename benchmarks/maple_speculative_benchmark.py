"""
Automatic benchmark harness for Maple-Preview speculative decoding optimization.

Runs the same prompts repeatedly and reports:

  baseline tokens/sec         (serial greedy via generate_step)
  original spec tokens/sec     (original speculative_generate_step, depth=2)
  optimized tokens/sec        (optimized_speculative_generate, adaptive depth)
  speedup                     (optimized / baseline)
  mean draft depth
  mean accepted tokens
  acceptance rate by position
  target-forward latency
  draft-forward latency
  rollback frequency
  peak memory
  memory growth
  time spent synchronizing
  time spent sampling

Prompt types tested:
  - short factual text
  - long-context continuation
  - code
  - conversational text
  - structured output
"""

import time
import json
import gc
import argparse
from dataclasses import dataclass, field, asdict
from typing import List, Dict, Any

import mlx.core as mx

from mlx_lm.utils import load
from mlx_lm.generate import generate_step, speculative_generate_step
from mlx_lm.speculative import optimized_speculative_generate
from mlx_lm.sample_utils import make_sampler


PROMPTS = {
    "short_factual": "What is the capital of France?",
    "long_context": """
The Industrial Revolution was a period of major industrialization that began in Great Britain in the late 18th century. It marked a major turning point in history; the change was felt in a number of sizes including artificial processes, population growth, and the adoption of agriculture. The Industrial Revolution changed systems of production, and began the modern free market economy by empowering individuals to make purchases as opposed to relying solely on bartering. The transition lasted several years.

Explain the impact of the Industrial Revolution on European society in the 19th century.
""",
    "code": "Write a Python function that implements binary search on a sorted list. Include error handling for edge cases.",
    "conversational": "I'm planning a trip to Japan in the spring. What are the must-see places and what should I expect weather-wise?",
    "structured_output": "Extract the following information from the text below as structured JSON:\nText: \"Apple Inc. reported Q3 fiscal 2024 revenue of $85.4 billion, up 5% year-over-year, driven by iPhone sales of 44.5 million units.\"\nExtract: company name, quarter, year, revenue, revenue_currency, yoy_growth, drivers, product, units_sold.",
}


@dataclass
class BaselineResult:
    tokens: List[int]
    tokens_per_sec: float
    peak_memory_gb: float
    total_time: float


@dataclass
class OptimizedResult:
    tokens: List[int]
    tokens_per_sec: float
    peak_memory_gb: float
    total_time: float
    metrics: dict = field(default_factory=dict)
    spec_state: dict = field(default_factory=dict)


def run_baseline(model_path, eos_ids, prompt, max_tokens):
    """Run serial greedy generation as the baseline."""
    model = load(model_path, trust_remote_code=True)[0]
    sampler = make_sampler(temp=0.0)

    # Warmup
    for token, _ in generate_step(prompt, model, max_tokens=1, sampler=sampler):
        break

    mx.reset_peak_memory()
    t0 = time.perf_counter()
    tokens = []
    for token, logprobs in generate_step(prompt, model, max_tokens=max_tokens, sampler=sampler):
        tokens.append(int(token))
        mx.eval(logprobs)
        if int(token) in eos_ids:
            break
    t1 = time.perf_counter()

    del model
    gc.collect()
    mx.clear_cache()

    return BaselineResult(
        tokens=tokens,
        tokens_per_sec=len(tokens) / (t1 - t0),
        peak_memory_gb=mx.get_peak_memory() / 1e9,
        total_time=t1 - t0,
    )


def run_original_spec(model_path, eos_ids, prompt, max_tokens, num_draft=2):
    """Run original speculative_generate_step for comparison."""
    model = load(model_path, trust_remote_code=True)[0]
    sampler = make_sampler(temp=0.0)

    # Warmup
    for token, _, _ in speculative_generate_step(
        prompt, model, model, num_draft_tokens=2, max_tokens=1, sampler=sampler
    ):
        break

    mx.reset_peak_memory()
    t0 = time.perf_counter()
    tokens = []
    for token, _, _ in speculative_generate_step(
        prompt, model, model, num_draft_tokens=num_draft, max_tokens=max_tokens, sampler=sampler
    ):
        tokens.append(int(token))
    t1 = time.perf_counter()

    del model
    gc.collect()
    mx.clear_cache()

    return BaselineResult(
        tokens=tokens,
        tokens_per_sec=len(tokens) / (t1 - t0),
        peak_memory_gb=mx.get_peak_memory() / 1e9,
        total_time=t1 - t0,
    )


def run_optimized(model_path, draft_path, eos_ids, prompt, max_tokens, max_depth):
    """Run optimized speculative generation."""
    model = load(model_path, trust_remote_code=True)[0]
    if draft_path == model_path:
        draft_model = model
    else:
        draft_model = load(draft_path, trust_remote_code=True)[0]
    sampler = make_sampler(temp=0.0)

    t0 = time.perf_counter()
    result = optimized_speculative_generate(
        prompt=prompt,
        model=model,
        draft_model=draft_model,
        max_tokens=max_tokens,
        sampler=sampler,
        max_depth=max_depth,
    )
    t1 = time.perf_counter()

    is_same_model = draft_model is model
    del model
    if not is_same_model:
        del draft_model
    gc.collect()
    mx.clear_cache()

    return OptimizedResult(
        tokens=result.tokens,
        tokens_per_sec=len(result.tokens) / (t1 - t0),
        peak_memory_gb=mx.get_peak_memory() / 1e9,
        total_time=t1 - t0,
        metrics=asdict(result.metrics),
        spec_state={
            "max_depth": result.spec_state.max_depth,
            "best_depth_seen": result.spec_state.best_depth_seen,
            "round_count": result.spec_state.round_count,
            "pos_accept_ema": list(result.spec_state.pos_accept_ema),
            "pos_count": list(result.spec_state.pos_count),
            "draft_forward_per_token": result.spec_state.draft_forward_per_token,
            "target_forward_per_round": result.spec_state.target_forward_per_round,
        },
    )


def verify_correctness(baseline_tokens, optimized_tokens):
    """Compare optimized output against serial baseline."""
    match = baseline_tokens == optimized_tokens
    first_div = -1
    if not match:
        for i, (a, b) in enumerate(zip(baseline_tokens, optimized_tokens)):
            if a != b:
                first_div = i
                break
    return {
        "exact_match": match,
        "baseline_length": len(baseline_tokens),
        "optimized_length": len(optimized_tokens),
        "first_divergence_idx": first_div,
    }


def run_benchmark(
    model_path, draft_model_path, max_tokens=128, max_depth=4, verbose=True
):
    """Run the full benchmark suite."""
    _, tokenizer, _ = load(model_path, return_config=True, trust_remote_code=True)
    eos_ids = set(tokenizer.eos_token_ids)

    # Warmup GPU
    print("Warming up GPU...")
    model = load(model_path, trust_remote_code=True)[0]
    _ = model(mx.array([[0]]), cache=None)
    mx.eval(model(mx.array([[0]], dtype=mx.uint32)))
    del model
    gc.collect()
    mx.clear_cache()

    results = {}

    for prompt_name, prompt_text in PROMPTS.items():
        if verbose:
            print(f"\n{'='*60}")
            print(f"Benchmarking: {prompt_name}")
            print(f"{'='*60}")

        prompt = mx.array(tokenizer.encode(prompt_text))

        # Baseline (serial)
        if verbose:
            print("  Running baseline (serial)...")
        baseline = run_baseline(model_path, eos_ids, prompt, max_tokens)

        # Original speculative (for correctness reference)
        if verbose:
            print("  Running original speculative (depth=2)...")
        orig = run_original_spec(model_path, eos_ids, prompt, max_tokens, num_draft=2)

        # Optimized (depth=4) — should match original spec exactly
        if verbose:
            print("  Running optimized (adaptive depth, max=4)...")
        opt = run_optimized(model_path, draft_model_path, eos_ids, prompt, max_tokens, max_depth)

        # Correctness: compare optimized (depth=4) against original spec (depth=2)
        # These should match since same model is used as draft
        correctness = verify_correctness(orig.tokens, opt.tokens)

        results[prompt_name] = {
            "prompt_tokens": len(prompt),
            "baseline": {
                "tokens_generated": len(baseline.tokens),
                "tokens_per_sec": baseline.tokens_per_sec,
                "total_time_s": baseline.total_time,
                "peak_memory_gb": baseline.peak_memory_gb,
            },
            "original_spec": {
                "tokens_generated": len(orig.tokens),
                "tokens_per_sec": orig.tokens_per_sec,
                "total_time_s": orig.total_time,
                "peak_memory_gb": orig.peak_memory_gb,
                "speedup_vs_baseline": orig.tokens_per_sec / baseline.tokens_per_sec if baseline.tokens_per_sec > 0 else 0,
            },
            "optimized": {
                "tokens_generated": len(opt.tokens),
                "tokens_per_sec": opt.tokens_per_sec,
                "total_time_s": opt.total_time,
                "peak_memory_gb": opt.peak_memory_gb,
                "speedup_vs_baseline": opt.tokens_per_sec / baseline.tokens_per_sec if baseline.tokens_per_sec > 0 else 0,
                "speedup_vs_original": opt.tokens_per_sec / orig.tokens_per_sec if orig.tokens_per_sec > 0 else 0,
                "metrics": opt.metrics,
                "spec_state": opt.spec_state,
            },
            "correctness_optimized_vs_original": correctness,
        }

        if verbose:
            b = results[prompt_name]["baseline"]
            o = results[prompt_name]["original_spec"]
            opt_r = results[prompt_name]["optimized"]
            c = results[prompt_name]["correctness_optimized_vs_original"]
            print(f"  Baseline:      {b['tokens_per_sec']:.2f} tok/s, "
                  f"{b['peak_memory_gb']:.2f} GB, {b['tokens_generated']} toks")
            print(f"  Original spec: {o['tokens_per_sec']:.2f} tok/s, "
                  f"{o['peak_memory_gb']:.2f} GB, {o['tokens_generated']} toks")
            print(f"  Optimized:     {opt_r['tokens_per_sec']:.2f} tok/s, "
                  f"{opt_r['peak_memory_gb']:.2f} GB, {opt_r['tokens_generated']} toks")
            print(f"  Speedup vs baseline:   {opt_r['speedup_vs_baseline']:.2f}x")
            print(f"  Speedup vs original:   {opt_r['speedup_vs_original']:.2f}x")
            m = opt_r["metrics"]
            print(f"  Rounds: {m.get('rounds', '?')}, "
                  f"Accepted: {m.get('accepted_tokens', '?')}, "
                  f"Rollbacks: {m.get('rollback_count', '?')}")
            print(f"  Correctness vs original: {'PASS' if c['exact_match'] else 'FAIL'}")

    if verbose:
        print(f"\n{'='*60}")
        print("SUMMARY")
        print(f"{'='*60}")
        for name, r in results.items():
            b_tps = r["baseline"]["tokens_per_sec"]
            o_tps = r["original_spec"]["tokens_per_sec"]
            opt_tps = r["optimized"]["tokens_per_sec"]
            speedup = r["optimized"]["speedup_vs_baseline"]
            correct = "PASS" if r["correctness_optimized_vs_original"]["exact_match"] else "FAIL"
            print(f"  {name:20s}  baseline={b_tps:6.2f}  orig_spec={o_tps:6.2f}  "
                  f"optimized={opt_tps:6.2f}  speedup={speedup:5.2f}x  correct={correct}")

    return results


def main():
    parser = argparse.ArgumentParser(description="Maple-Preview speculative decoding benchmark")
    parser.add_argument("--model", type=str,
                        default="/Users/ianzvirbulis/Models/Hemlock/maple-2bit-mlx")
    parser.add_argument("--draft-model", type=str, default=None)
    parser.add_argument("--max-tokens", type=int, default=128)
    parser.add_argument("--max-depth", type=int, default=4)
    parser.add_argument("--output", type=str, default=None)
    args = parser.parse_args()

    draft_path = args.draft_model or args.model

    results = run_benchmark(
        model_path=args.model,
        draft_model_path=draft_path,
        max_tokens=args.max_tokens,
        max_depth=args.max_depth,
        verbose=True,
    )

    if args.output:
        with open(args.output, 'w') as f:
            json.dump(results, f, indent=2, default=str)
        print(f"\nResults saved to {args.output}")

    # Detailed metrics
    print(f"\n{'='*60}")
    print("DETAILED METRICS")
    print(f"{'='*60}")
    for name, r in results.items():
        m = r["optimized"]["metrics"]
        s = r["optimized"]["spec_state"]
        print(f"\n  {name}:")
        print(f"    Target forward time:  {m.get('target_forward_time', 0):.3f}s total")
        print(f"    Draft forward time:   {m.get('draft_forward_time', 0):.3f}s total")
        print(f"    Sync time:            {m.get('sync_time', 0):.3f}s")
        print(f"    Rounds:               {m.get('rounds', '?')}")
        print(f"    Rollbacks:            {m.get('rollback_count', '?')}")
        print(f"    Accepted tokens:      {m.get('accepted_tokens', '?')}")
        print(f"    Best depth seen:      {s.get('best_depth_seen', '?')}")
        emas = s.get("pos_accept_ema", [])
        counts = s.get("pos_count", [])
        if emas and counts:
            print(f"    Acceptance by position:")
            for i, (ema, cnt) in enumerate(zip(emas, counts)):
                if cnt > 0:
                    print(f"      pos {i}: ema={ema:.4f}, n={cnt}")


if __name__ == "__main__":
    main()
