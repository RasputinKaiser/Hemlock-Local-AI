"""Standalone CLI for the optimized Maple speculative decoder.

Usage:
  # Fast serial (delegates to stock generate_step, exact parity)
  python -m mlx_lm.speculative_cli --model <path> -p "Hello" --max-tokens 200

  # N-gram (zero-cost CPU draft) — best for repetitive / code / templated output,
  # and uses NO extra model memory (~6 GB instead of doubling).
  python -m mlx_lm.speculative_cli --model <path> -p "..." --ngram-draft --max-depth 12

  # Autoregressive draft with a smaller Maple model (truncated-layer draft).
  python -m mlx_lm.speculative_cli --model <path> --draft-model <small> --max-depth 4

  # Benchmark against serial greedy
  python -m mlx_lm.speculative_cli --model <path> -p "..." --ngram-draft --benchmark
"""
import argparse
import time

import mlx.core as mx

from .speculative import NGramDraft, optimized_speculative_generate
from .utils import load
from .sample_utils import make_sampler
from .generate import generate_step


def main():
    p = argparse.ArgumentParser(description="Optimized Maple speculative decoder")
    p.add_argument("--model", required=True, help="Path to Maple MLX model")
    p.add_argument("--prompt", "-p", default="Hello, my name is")
    p.add_argument("--max-tokens", "-m", type=int, default=200)
    p.add_argument("--temp", type=float, default=0.0)
    p.add_argument("--max-depth", type=int, default=12)
    p.add_argument("--ngram-draft", action="store_true",
                   help="Use zero-cost n-gram (prompt-lookup) draft")
    p.add_argument("--ngram-window", type=int, default=1024)
    p.add_argument("--draft-model", type=str, default=None,
                   help="Path to a smaller Maple model for autoregressive draft")
    p.add_argument("--trust-remote-code", action="store_true")
    p.add_argument("--benchmark", action="store_true",
                   help="Also run stock serial and print a comparison")
    p.add_argument("--verbose", action="store_true")
    args = p.parse_args()

    model, tokenizer, _ = load(
        args.model, return_config=True, trust_remote_code=args.trust_remote_code
    )
    sampler = make_sampler(args.temp)
    prompt = mx.array(tokenizer.encode(args.prompt))
    eos = set(tokenizer.eos_token_ids)

    draft_fn = None
    draft_model = None
    if args.ngram_draft:
        ng = NGramDraft(window=args.ngram_window)
        draft_fn = ng
    elif args.draft_model:
        draft_model, _, _ = load(
            args.draft_model, return_config=True, trust_remote_code=args.trust_remote_code
        )

    # Optimized run
    t0 = time.perf_counter()
    res = optimized_speculative_generate(
        prompt=prompt,
        model=model,
        draft_model=draft_model,
        max_tokens=args.max_tokens,
        sampler=sampler,
        max_depth=args.max_depth,
        eos_token_ids=eos,
        verbose=args.verbose,
        draft_fn=draft_fn,
    )
    t1 = time.perf_counter()
    text = tokenizer.decode(res.tokens)
    print(text)
    print(f"\n[optimized] {len(res.tokens)} tokens in {t1-t0:.2f}s "
          f"= {len(res.tokens)/(t1-t0):.1f} tok/s")

    if args.benchmark:
        model2, _, _ = load(
            args.model, return_config=True, trust_remote_code=args.trust_remote_code
        )
        t0 = time.perf_counter()
        ser = [int(t) for t, _ in generate_step(
            prompt, model2, max_tokens=args.max_tokens, sampler=sampler)]
        t1 = time.perf_counter()
        print(f"[serial]    {len(ser)} tokens in {t1-t0:.2f}s "
              f"= {len(ser)/(t1-t0):.1f} tok/s")
        print(f"[match]     exact greedy match: {ser == res.tokens}")


if __name__ == "__main__":
    main()
