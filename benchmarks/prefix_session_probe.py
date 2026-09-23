"""Continuous-KV session probe for the Hemlock Maple server.

Simulates the agent loop's per-step prompts two ways against a running server:

  session  - prior steps replayed verbatim as chat turns (user request +
             assistant reply), so each rendered prompt is a strict token
             prefix extension of the server's committed cache entry.
  rebuilt  - the classic shape: system + one user message whose JSON embeds
             the growing history (prompt diverges mid-body from every stored
             key, so reuse stops at the last shared prefix boundary).

/v1/score is called with commit=true and the fixed reasoning suffix so the
server stores prompt+suffix+winner+eos; the assistant turn replays as
{reasoning_content, content}, which the chat template renders byte-identical.

Usage: python benchmarks/prefix_session_probe.py [base_url]
"""

import json
import sys
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8080"
RC = "Deciding next action."
SYSTEM = (
    "You are Maple-Preview operating inside Hemlock. Return exactly one "
    "compact JSON action: "
    '{"kind":"tool","commandId":"<id>","input":{},"shortRationale":"..."}. '
    "Choose the next best command from request.allowedNextCommands."
)
CANDIDATES = [
    '{"kind":"tool","commandId":"repo-map","input":{},"shortRationale":"Map the repo."}',
    '{"kind":"tool","commandId":"repo.inspect","input":{},"shortRationale":"Inspect the repo."}',
    '{"kind":"tool","commandId":"file.read","input":',
]
# Pad the system prompt so the shared prefix is a realistic size (~1k tok).
SYSTEM += "\n" + "\n".join(f"Rule {i}: keep actions scoped and receipted." for i in range(120))


def post(path, body):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    return json.loads(urllib.request.urlopen(req, timeout=600).read())


def step_user(step, history):
    return json.dumps(
        {
            "task": {"id": "probe", "objective": "inspect the project"},
            "context": {"note": f"observation for step {step}: files scanned ok"},
            "nextStep": {"commandId": ["repo-map", "repo.inspect", "file.read"][step - 1]},
            "allowedNextCommands": [{"commandId": c} for c in ["repo-map", "repo.inspect", "file.read"]],
            "progress": {"planProgress": f"step {step} of 3"},
            "completed": {"actions": history},
        }
    )


def completions(messages):
    body = {
        "model": "default_model",
        "messages": messages,
        "max_tokens": 8,
        "temperature": 0,
        "stream": False,
    }
    out = post("/v1/chat/completions", body)
    usage = out.get("usage") or {}
    return (
        usage.get("prompt_tokens"),
        (usage.get("prompt_tokens_details") or {}).get("cached_tokens"),
    )


def score(messages):
    body = {
        "model": "default_model",
        "messages": messages,
        "prompt_suffix": RC + "\n</think>\n\n",
        "candidates": CANDIDATES,
        "commit": True,
    }
    return post("/v1/score", body)


def run_session():
    print("\n=== session mode (verbatim turn replay) ===")
    turns = []
    history = []
    for step in (1, 2, 3):
        user = step_user(step, history[-1:])
        messages = [{"role": "system", "content": SYSTEM}, *turns, {"role": "user", "content": user}]
        r = score(messages)
        winner = r["candidates"][r["committedIndex"] if r.get("committedIndex") is not None else 0]
        print(
            f"step {step}: prompt={r['promptTokens']:>5} cached={r['cachedTokens']:>5} "
            f"committed={r.get('committedIndex')}"
        )
        turns.append({"role": "user", "content": user})
        turns.append(
            {
                "role": "assistant",
                "content": r.get("committedText") or winner["text"],
                "reasoning_content": RC,
            }
        )
        history.append({"commandId": winner["text"]})
        # And the generative continuation for the same step.
        gen_messages = messages + [
            turns[-1],
            {"role": "user", "content": '{"instruction":"Emit the complete JSON action."}'},
        ]
        pt, ct = completions(gen_messages)
        print(f"  infer after commit: prompt={pt} cached={ct}")


def run_rebuilt():
    print("\n=== rebuilt mode (single user message, growing history) ===")
    history = []
    for step in (1, 2, 3):
        history.append({"commandId": f"cmd{step}", "status": "completed"})
        user = step_user(step, history)
        messages = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": user}]
        r = score(messages)
        print(f"step {step}: prompt={r['promptTokens']:>5} cached={r['cachedTokens']:>5}")


if __name__ == "__main__":
    run_session()
    run_rebuilt()
