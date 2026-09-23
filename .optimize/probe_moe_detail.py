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
logits = model(prompt[None, :-1], cache=cache)
mx.eval(logits)

inner = model.model if hasattr(model, "model") else model
layer = inner.layers[0]
mlp = layer.mlp
sw = mlp.switch_mlp
ug = sw.up_gate_proj
dn = sw.down_proj

x = mx.random.normal((1, 1, 2048), dtype=mx.bfloat16, key=mx.random.key(0))
inds, scores = mlp.gate(x)
mx.eval(inds, scores)
xe = mx.expand_dims(x, (-2, -3))
h = mx.random.normal((1, 1, 1, 8, 512), dtype=mx.bfloat16)


def timeit(name, fn, n=300):
    """Throughput: issue n calls, one eval -> amortized GPU cost per call."""
    for _ in range(10):
        r = fn()
    mx.eval(r)
    t0 = time.perf_counter()
    rs = [fn() for _ in range(n)]
    mx.eval(rs)
    dt = (time.perf_counter() - t0) / n * 1e3
    print(f"{name:44s} {dt*1e3:9.1f} us")
    return dt


timeit("mlp block (gate+switch+agg)", lambda: mlp(x))
timeit("  gate (fused router)", lambda: mlp.gate(x))
timeit("  up_gate gather_qmm 8e", lambda: ug(xe, inds))
timeit("  down gather_qmm 8e", lambda: dn(h, inds))
timeit("  switch_mlp total", lambda: sw(x, inds))
yo = sw(x, inds)
timeit(
    "  aggregate",
    lambda: (yo.astype(mx.float32) * scores[..., None])
    .sum(axis=-2)
    .astype(yo.dtype),
)

# comparisons
one_idx = mx.zeros((1, 1, 1, 1), dtype=mx.int32)
timeit("  up_gate qmm 1 expert", lambda: ug(xe, one_idx))
idx16 = mx.concatenate([inds, inds], axis=-1)  # 16 rows, 8 unique
timeit("  up_gate qmm 16 rows", lambda: ug(mx.broadcast_to(xe, (1,1,2,8,2048)) if False else mx.concatenate([xe, xe], axis=2), idx16))

# attention
attn = layer.self_attn
from mlx_lm.models.cache import RotatingKVCache
c2 = RotatingKVCache(max_size=512)
xa = mx.random.normal((1, 20, 2048), dtype=mx.bfloat16)
attn(xa, cache=c2)
mx.eval(c2.keys)
timeit("attention L=1 ctx~20", lambda: attn(x[:, :1], cache=c2))

c_all = make_prompt_cache(model)
model(prompt[None, :-1], cache=c_all)
mx.eval([c.keys for c in c_all if c is not None])
y = mx.array([1])
timeit("full decode step", lambda: model(y[None], cache=c_all), n=100)
