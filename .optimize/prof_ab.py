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
inner = model.model


def measure(tag, fused):
    cache = make_prompt_cache(model)
    logits = model(prompt[None, :-1], cache=cache)
    mx.eval(logits)
    y = prompt[-1:]
    for _ in range(8):
        logits = model(y[None], cache=cache)
        mx.eval(logits)
        y = mx.argmax(logits[:, -1, :], axis=-1)
    for l in inner.layers:
        l.mlp.switch_mlp._fused_decode = fused
    build_t = eval_t = 0.0
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
    print(f"{tag}: build {build_t/N*1e3:.2f}ms eval {eval_t/N*1e3:.2f}ms")


measure("eager (fused off)", False)
measure("fused moe", True)
measure("eager again", False)
measure("fused again", True)
