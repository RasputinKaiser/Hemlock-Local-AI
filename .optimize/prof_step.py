import cProfile, pstats, io, sys, time
import mlx.core as mx
from mlx_lm.utils import load
from mlx_lm.generate import generate_step

model, tokenizer = load(
    "/Users/ianzvirbulis/Models/Hemlock/maple-2bit-mlx",
    tokenizer_config={"trust_remote_code": True},
    model_config={"use_flash_head": True, "trust_remote_code": True},
)
prompt = mx.array(tokenizer.encode("List the first six prime numbers."))
cache = None

def run(n=64):
    from mlx_lm.models.cache import make_prompt_cache
    c = make_prompt_cache(model)
    g = generate_step(prompt, model, max_tokens=n, prompt_cache=c)
    out = [t for t, _ in g]
    return out

run(8)  # warmup
pr = cProfile.Profile()
pr.enable()
t0 = time.perf_counter()
run(96)
dt = time.perf_counter() - t0
pr.disable()
print(f"96 tokens in {dt:.2f}s -> {96/dt:.1f} tok/s")
s = io.StringIO()
pstats.Stats(pr, stream=s).sort_stats("cumulative").print_stats(40)
print(s.getvalue()[:8000])
s2 = io.StringIO()
pstats.Stats(pr, stream=s2).sort_stats("tottime").print_stats(40)
print(s2.getvalue()[:8000])
