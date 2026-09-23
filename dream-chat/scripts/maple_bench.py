#!/usr/bin/env python3
"""Maple-Preview speed probe against a running mlx_lm server.

Modes:
  decode  — short prompt, stream max_tokens, report decode tok/s + TTFT.
  prefill — long deterministic system prompt, max_tokens small, report
            prompt tok/s + cached_tokens.
  score   — /v1/score with ~8 candidates, report per-candidate cost.

stdlib only (urllib). Prints JSON medians; --json prints ONLY the JSON
record so it can be redirected into .optimize/runs/*.json.
"""

import argparse
import json
import statistics
import sys
import time
import urllib.error
import urllib.request

DEFAULT_URL = "http://127.0.0.1:8081"

DECODE_PROMPT = (
    "List the first six prime numbers and one sentence about why each is prime."
)

# Deterministic ~3k-token system prompt: numbered pseudo-paragraphs so the
# tokenizer sees real text, and a per-rep nonce near the START so the prefix
# cache cannot serve the bulk of the prompt (cold prefill is what we measure).
def _prefill_system(nonce, min_words=2600):
    words = (
        "orbit maple kernel window ledger cache token stride vector "
        "grove branch signal buffer thread stream sample decode prefill"
    ).split()
    chunks = []
    n = 0
    i = 0
    while n < min_words:
        chunks.append(
            f"Paragraph {i}: "
            + " ".join(words[(i * 7 + j) % len(words)] for j in range(40))
            + "."
        )
        n += 42
        i += 1
    return f"Bench session {nonce}. You are a precise assistant.\n" + "\n".join(chunks)


def _post(url, path, payload, timeout=600):
    req = urllib.request.Request(
        url + path,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    return urllib.request.urlopen(req, timeout=timeout)


def _iter_sse(resp):
    """Yield parsed JSON objects from an SSE stream until [DONE]."""
    for raw in resp:
        line = raw.decode("utf-8", "replace").strip()
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if data == "[DONE]":
            return
        try:
            yield json.loads(data)
        except json.JSONDecodeError:
            continue


def _chat_once(url, messages, max_tokens, temperature=0.0):
    """One streaming chat call -> dict of timings/usage/completion text."""
    payload = {
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "stream": True,
        "stream_options": {"include_usage": True},
    }
    t0 = time.perf_counter()
    resp = _post(url, "/v1/chat/completions", payload)
    t_first = None
    t_last = None
    usage = {}
    text_parts = []
    for chunk in _iter_sse(resp):
        now = time.perf_counter()
        if t_first is None:
            t_first = now
        t_last = now
        if chunk.get("usage"):
            usage = chunk["usage"]
        for choice in chunk.get("choices") or []:
            delta = choice.get("delta") or {}
            if delta.get("content"):
                text_parts.append(delta["content"])
    t_end = time.perf_counter()
    completion = usage.get("completion_tokens", 0)
    prompt_tokens = usage.get("prompt_tokens", 0)
    cached = (usage.get("prompt_tokens_details") or {}).get("cached_tokens", 0)
    ttft = (t_first - t0) if t_first else (t_end - t0)
    gen_span = (t_last - t_first) if (t_first and t_last and t_last > t_first) else 0
    # t_first marks the first SSE chunk; the remaining completion tokens
    # arrived over gen_span.
    decode_tps = ((completion - 1) / gen_span) if (gen_span > 0 and completion > 1) else None
    return {
        "ttft_ms": ttft * 1000,
        "decode_tps": decode_tps,
        "completion_tokens": completion,
        "prompt_tokens": prompt_tokens,
        "cached_tokens": cached,
        "total_ms": (t_end - t0) * 1000,
        "text": "".join(text_parts),
    }


def run_decode(url, reps, max_tokens, context_tokens=0, warmup=1):
    messages = []
    if context_tokens:
        # Fixed long context (no nonce): rep 2+ rides the prompt cache, so the
        # decode measurement runs at full context without re-prefilling.
        messages.append(
            {
                "role": "system",
                "content": _prefill_system("fixed-ctx", min_words=context_tokens),
            }
        )
    messages.append({"role": "user", "content": DECODE_PROMPT})
    for _ in range(warmup):
        _chat_once(url, messages, 16)
    runs = []
    for _ in range(reps):
        r = _chat_once(url, messages, max_tokens)
        runs.append(r)
        print(
            f"  rep: ttft={r['ttft_ms']:.0f}ms decode={r['decode_tps'] or 0:.1f}tok/s "
            f"completion={r['completion_tokens']} prompt={r['prompt_tokens']} "
            f"cached={r['cached_tokens']}",
            file=sys.stderr,
        )
    return {
        "mode": "decode",
        "ttft_ms": statistics.median(r["ttft_ms"] for r in runs),
        "decode_tps": statistics.median(
            r["decode_tps"] for r in runs if r["decode_tps"]
        ),
        "completion_tokens": runs[-1]["completion_tokens"],
        "prompt_tokens": runs[-1]["prompt_tokens"],
        "cached_tokens": runs[-1]["cached_tokens"],
        "context_tokens": context_tokens,
        "last_text": runs[-1]["text"],
        "reps": reps,
        "warmup": warmup,
    }


def run_prefill(url, reps):
    runs = []
    for i in range(reps):
        nonce = f"{int(time.time() * 1000)}-{i}"
        messages = [
            {"role": "system", "content": _prefill_system(nonce)},
            {"role": "user", "content": "Reply with the word ready."},
        ]
        r = _chat_once(url, messages, 8)
        r["prefill_tps"] = (
            r["prompt_tokens"] / (r["ttft_ms"] / 1000) if r["ttft_ms"] > 0 else None
        )
        runs.append(r)
        print(
            f"  rep: prompt={r['prompt_tokens']} cached={r['cached_tokens']} "
            f"ttft={r['ttft_ms']:.0f}ms prefill={r['prefill_tps'] or 0:.0f}tok/s",
            file=sys.stderr,
        )
    return {
        "mode": "prefill",
        "ttft_ms": statistics.median(r["ttft_ms"] for r in runs),
        "prefill_tps": statistics.median(
            r["prefill_tps"] for r in runs if r["prefill_tps"]
        ),
        "prompt_tokens": statistics.median(r["prompt_tokens"] for r in runs),
        "cached_tokens": statistics.median(r["cached_tokens"] for r in runs),
        "reps": reps,
    }


SCORE_CANDIDATES = [
    '{"command": "thread.list", "input": {}}',
    '{"command": "agent.self", "input": {}}',
    '{"command": "world.state", "input": {}}',
    '{"command": "memory.list", "input": {"limit": 5}}',
    '{"command": "artifact.list", "input": {}}',
    '{"command": "experiment.list", "input": {}}',
    '{"command": "plan.revise", "input": {"notes": "continue"}}',
    '{"command": "shell.exec", "input": {"command": "ls", "args": ["-la"]}}',
]


def run_score(url, reps):
    runs = []
    messages = [
        {
            "role": "system",
            "content": "You are Maple, an agent that chooses the next action.",
        },
        {
            "role": "user",
            "content": "The task is to inspect the workspace. Choose the next action.",
        },
    ]
    for _ in range(reps):
        payload = {
            "messages": messages,
            "candidates": SCORE_CANDIDATES,
            "commit": False,
        }
        t0 = time.perf_counter()
        resp = _post(url, "/v1/score", payload)
        body = json.loads(resp.read().decode())
        total_ms = (time.perf_counter() - t0) * 1000
        n = len(body.get("candidates") or [])
        runs.append(
            {
                "total_ms": total_ms,
                "per_candidate_ms": total_ms / max(n, 1),
                "prompt_tokens": body.get("promptTokens", 0),
                "cached_tokens": body.get("cachedTokens", 0),
                "candidates": n,
            }
        )
        print(
            f"  rep: total={total_ms:.0f}ms per_cand={total_ms / max(n, 1):.1f}ms "
            f"prompt={body.get('promptTokens')} cached={body.get('cachedTokens')}",
            file=sys.stderr,
        )
    return {
        "mode": "score",
        "total_ms": statistics.median(r["total_ms"] for r in runs),
        "per_candidate_ms": statistics.median(r["per_candidate_ms"] for r in runs),
        "prompt_tokens": runs[-1]["prompt_tokens"],
        "cached_tokens": statistics.median(r["cached_tokens"] for r in runs),
        "candidates": runs[-1]["candidates"],
        "reps": reps,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--url", default=DEFAULT_URL)
    ap.add_argument("--mode", choices=["decode", "prefill", "score"], required=True)
    ap.add_argument("--reps", type=int, default=3)
    ap.add_argument("--max-tokens", type=int, default=128)
    ap.add_argument(
        "--context-tokens",
        type=int,
        default=0,
        help="decode mode: prepend ~N tokens of system context before the prompt",
    )
    ap.add_argument("--json", action="store_true", help="print only the JSON record")
    ap.add_argument(
        "--warmup",
        type=int,
        default=1,
        help="uncounted warmup requests before decode reps (default 1)",
    )
    args = ap.parse_args()

    try:
        with urllib.request.urlopen(args.url + "/health", timeout=5) as r:
            health = json.loads(r.read().decode() or "{}")
    except (urllib.error.URLError, OSError, ValueError) as e:
        print(f"server not healthy at {args.url}: {e}", file=sys.stderr)
        sys.exit(2)

    runner = {"decode": run_decode, "prefill": run_prefill, "score": run_score}[
        args.mode
    ]
    if args.mode == "decode":
        record = runner(
            args.url, args.reps, args.max_tokens, args.context_tokens, args.warmup
        )
    else:
        record = runner(args.url, args.reps)
    record["url"] = args.url
    record["model"] = (health or {}).get("model")
    record["ts"] = time.strftime("%Y-%m-%dT%H:%M:%S")

    out = json.dumps(record, indent=2)
    print(out)


if __name__ == "__main__":
    main()
