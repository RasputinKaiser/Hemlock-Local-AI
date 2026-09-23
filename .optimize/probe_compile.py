import time, sys
import mlx.core as mx
import mlx.nn as nn
from functools import partial

sys.path.insert(0, "/Users/ianzvirbulis/Code/Hemlock")
from mlx_lm.models.maple import (
    MapleSparseMoeBlock, ModelArgs, aggregate_expert_outputs,
)

args = ModelArgs(
    hidden_size=512, intermediate_size=1024, moe_intermediate_size=128,
    num_hidden_layers=4, num_attention_heads=8, num_key_value_heads=2,
    head_dim=64, num_experts=32, num_experts_per_tok=4, sliding_window=64,
)
blk = MapleSparseMoeBlock(args)
mx.eval(blk.parameters())

x = mx.random.normal((1, 1, 512), dtype=mx.bfloat16, key=mx.random.key(0))
ref = blk(x)
mx.eval(ref)

def moe_block(x):
    inds, scores = blk.gate(x)
    y = blk.switch_mlp(x, inds)
    return aggregate_expert_outputs(y, scores)

comp = mx.compile(moe_block)
try:
    out = comp(x)
    mx.eval(out)
    print("compile ok, match:", bool(mx.allclose(out.astype(mx.float32), ref.astype(mx.float32), atol=2e-2)))
except Exception as e:
    import traceback; traceback.print_exc()

for name, fn in [("ref", lambda: blk(x)), ("compiled", lambda: comp(x))]:
    for _ in range(20):
        r = fn()
        mx.eval(r)
    t = time.time()
    for _ in range(200):
        r = fn()
    mx.eval(r)
    print(name, "%.2f us/call-build" % ((time.time() - t) / 200 * 1e6))
