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
y = prompt[-1:]
for _ in range(4):
    logits = model(y[None], cache=cache)
    mx.eval(logits)
    y = mx.argmax(logits[:, -1, :], axis=-1)

inner = model.model if hasattr(model, "model") else model
layers = inner.layers
blk = layers[0].mlp
print("gate fused:", blk.gate._fused)
print("switch fused_decode:", blk.switch_mlp._fused_decode)
n_fused = sum(
    1
    for l in layers
    if getattr(l.mlp.switch_mlp, "_fused_decode", None) is True
)
print("layers with fused moe:", n_fused, "/", len(layers))
