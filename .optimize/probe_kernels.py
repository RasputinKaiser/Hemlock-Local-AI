import sys, time
import mlx.core as mx

sys.path.insert(0, "/Users/ianzvirbulis/Code/Hemlock")
from mlx_lm.utils import load
from mlx_lm.models.cache import make_prompt_cache
from mlx_lm.models.maple import (
    aggregate_expert_outputs, _moe_upgate_kernel, _moe_down_kernel,
)

model, tokenizer = load(
    "/Users/ianzvirbulis/Models/Hemlock/maple-2bit-mlx",
    tokenizer_config={"trust_remote_code": True},
    model_config={"use_flash_head": True},
    trust_remote_code=True,
)
inner = model.model
l = inner.layers[0]
blk = l.mlp
sw = blk.switch_mlp
ug, dn = sw.up_gate_proj, sw.down_proj

x = mx.random.normal((1, 1, 2048), dtype=mx.bfloat16, key=mx.random.key(0))
inds, scores = blk.gate(x)
mx.eval(inds, scores)
inds_f = inds.reshape(-1)
scores_f = scores.reshape(-1).astype(mx.float32)
xf = x.reshape(-1)
K, D, M, gs = 8, 2048, 512, 128


def k1():
    return _moe_upgate_kernel(
        inputs=[xf, ug.weight, ug.scales, ug.biases, inds_f],
        template=[("T_", x.dtype), ("DIM", D), ("MDIM", M), ("GSIZE", gs)],
        grid=(256, (K * M) // 16, 1),
        threadgroup=(256, 1, 1),
        output_shapes=[(K * M,)],
        output_dtypes=[x.dtype],
    )[0]


h = k1()


def k2():
    return _moe_down_kernel(
        inputs=[h, dn.weight, dn.scales, dn.biases, inds_f, scores_f],
        template=[("T_", x.dtype), ("KEXP", K), ("DIM", D), ("MDIM", M), ("GSIZE", dn.group_size)],
        grid=(256, D // 8, 1),
        threadgroup=(256, 1, 1),
        output_shapes=[(D,)],
        output_dtypes=[x.dtype],
    )[0]


def ref():
    return aggregate_expert_outputs(sw(x, inds), scores)


def timeit(name, fn, n=400):
    for _ in range(10):
        r = fn()
    mx.eval(r)
    # build only
    t0 = time.perf_counter()
    rs = [fn() for _ in range(n)]
    t1 = time.perf_counter()
    mx.eval(rs)
    t2 = time.perf_counter()
    print(f"{name:34s} build {(t1-t0)/n*1e6:7.1f} us  eval {(t2-t1)/n*1e6:7.1f} us")


timeit("k1 upgate+swiglu", k1)
timeit("k2 down+agg", k2)
timeit("k1+k2", lambda: (k1(), k2()))
timeit("reference switch+agg", ref)
timeit("fused_decode", lambda: sw.fused_decode(x, inds, scores))
