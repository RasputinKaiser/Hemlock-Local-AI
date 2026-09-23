import sys, time
import mlx.core as mx

sys.path.insert(0, "/Users/ianzvirbulis/Code/Hemlock")
from mlx_lm.utils import load
from mlx_lm.models.cache import make_prompt_cache

model, tokenizer = load(
    "/Users/ianzvirbulis/Models/Hemlock/maple-2bit-mlx",
    tokenizer_config={"trust_remote_code": True},
    model_config={"use_flash_head": True},
    trust_remote_code=True,
)
prompt = mx.array(tokenizer.encode("List the first six prime numbers."))
cache = make_prompt_cache(model)

# prefill
logits = model(prompt[None, :-1], cache=cache)
mx.eval(logits)

y = prompt[-1:]
# warm
for _ in range(8):
    logits = model(y[None], cache=cache)
    mx.eval(logits)
    y = mx.argmax(logits[:, -1, :], axis=-1)

# measure: build time vs eval time per step
build_t = 0.0
eval_t = 0.0
N = 64
for _ in range(N):
    t0 = time.perf_counter()
    logits = model(y[None], cache=cache)
    ny = mx.argmax(logits[:, -1, :], axis=-1)
    t1 = time.perf_counter()
    mx.eval(ny)
    t2 = time.perf_counter()
    build_t += t1 - t0
    eval_t += t2 - t1
    y = ny
print(f"build: {build_t/N*1e3:.2f} ms/step  eval: {eval_t/N*1e3:.2f} ms/step")
