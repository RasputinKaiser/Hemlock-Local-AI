import sys, time
import mlx.core as mx

sys.path.insert(0, "/Users/ianzvirbulis/Code/Hemlock")
from mlx_lm.utils import load
from mlx_lm.models.cache import make_prompt_cache
from mlx_lm.models.maple import aggregate_expert_outputs

model, tokenizer = load(
    "/Users/ianzvirbulis/Models/Hemlock/maple-2bit-mlx",
    tokenizer_config={"trust_remote_code": True},
    model_config={"use_flash_head": True},
    trust_remote_code=True,
)
inner = model.model
layers = inner.layers

# Force probe on a real decode-shaped input
x = mx.random.normal((1, 1, 2048), dtype=mx.bfloat16, key=mx.random.key(0))
blk = layers[0].mlp
inds, scores = blk.gate(x)
mx.eval(inds, scores)

ref = aggregate_expert_outputs(blk.switch_mlp(x, inds), scores)
got = blk.switch_mlp.fused_decode(x, inds, scores)
mx.eval(ref, got)
diff = mx.abs(ref.astype(mx.float32) - got.astype(mx.float32)).max()
print("fused_decode flag:", blk.switch_mlp._fused_decode, "maxdiff:", float(diff))

# compare across all layers on same x
bad = []
for i, l in enumerate(layers):
    sw = l.mlp.switch_mlp
    inds, scores = l.mlp.gate(x)
    ref = aggregate_expert_outputs(sw(x, inds), scores)
    got = sw.fused_decode(x, inds, scores)
    mx.eval(ref, got)
    d = float(mx.abs(ref.astype(mx.float32) - got.astype(mx.float32)).max())
    if sw._fused_decode is not True or d > 0.02:
        bad.append((i, sw._fused_decode, d))
    print(f"layer {i}: fused={sw._fused_decode} maxdiff={d:.5f}")
print("bad:", bad)

# throughput: fused vs reference per layer
sw = layers[0].mlp.switch_mlp
inds, scores = layers[0].mlp.gate(x)
mx.eval(inds, scores)


def timeit(name, fn, n=300):
    for _ in range(10):
        r = fn()
    mx.eval(r)
    t0 = time.perf_counter()
    rs = [fn() for _ in range(n)]
    mx.eval(rs)
    print(f"{name:44s} {(time.perf_counter()-t0)/n*1e6:9.1f} us")


timeit("reference switch+agg", lambda: aggregate_expert_outputs(sw(x, inds), scores))
timeit("fused_decode", lambda: sw.fused_decode(x, inds, scores))

# greedy-equivalence smoke: generate 32 tokens each way
from mlx_lm.generate import generate_step

prompt = mx.array(tokenizer.encode("List the first six prime numbers."))
c1 = make_prompt_cache(model)
g = generate_step(prompt, model, max_tokens=32, prompt_cache=c1)
seq1 = [t for t, _ in g]

# disable fused and regenerate
for l in layers:
    l.mlp.switch_mlp._fused_decode = False
c2 = make_prompt_cache(model)
g = generate_step(prompt, model, max_tokens=32, prompt_cache=c2)
seq2 = [t for t, _ in g]
print("greedy identical:", seq1 == seq2)
print(tokenizer.decode(seq1)[:200])
