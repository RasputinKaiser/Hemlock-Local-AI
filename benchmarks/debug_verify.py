import mlx.core as mx, functools
from mlx_lm.utils import load
from mlx_lm.models.cache import make_prompt_cache
from mlx_lm.generate import generation_stream, maybe_quantize_kv_cache

TARGET="/Users/ianzvirbulis/Models/Hemlock/maple-2bit-mlx"
DRAFT="/Users/ianzvirbulis/Models/Hemlock/qwen25-0.5b-draft-4bit"
mt,tt,_=load(TARGET, return_config=True, trust_remote_code=True)
md,td,_=load(DRAFT, return_config=True, trust_remote_code=True)
prompt=mx.array(tt.encode("What is the capital of France? Explain briefly."))
qfn=functools.partial(maybe_quantize_kv_cache, quantized_kv_start=0, kv_group_size=64, kv_bits=None)

def prefill(model, cache, y, step=512):
    while y.size>1:
        n=min(step,y.size-1)
        with mx.stream(generation_stream):
            model(y[:n][None], cache=cache)
        qfn(cache); mx.eval([c.state for c in cache])
        y=y[n:]; mx.clear_cache()
    return y

mc=make_prompt_cache(mt); dc=make_prompt_cache(md)
dy=prefill(md,dc,prompt); y=prefill(mt,mc,prompt)
print("after prefill: y=", int(y.tolist()[0]), "cache offsets target/draft:",
      [c.offset for c in mc][:1], [c.offset for c in dc][:1])

# DECISIVE: model([y]) right after prefill
with mx.stream(generation_stream):
    lg1=mt(y[None], cache=mc)
qfn(mc)
t1=mx.argmax(lg1[:,-1:,:],axis=-1); mx.eval(t1)
print("model([y]) after prefill ->", int(t1.tolist()[0][0]), "(want 304)")

# draft 4
ys=[]; yd=dy
for _ in range(4):
    with mx.stream(generation_stream):
        lg=md(yd[None], cache=dc); lg=lg[:,-1:,:]
    t=mx.argmax(lg,axis=-1); mx.eval(t)
    tk=int(t.tolist()[0][0]); ys.append(tk); yd=mx.array([tk],dtype=mx.uint32)
print("draft:", ys)
print("draft cache offset now:", [c.offset for c in dc][:1])

# Batched verify: [y, d1,d2,d3,d4]
block=mx.concatenate([y, mx.array(ys,dtype=mx.uint32)])[None]
with mx.stream(generation_stream):
    lg=mt(block, cache=mc)
qfn(mc)
print("target cache offset after verify:", [c.offset for c in mc][:1])
print("block len:", int(block.size))
toks=mx.argmax(lg,axis=-1); mx.eval(toks)
target=toks[0].tolist()
print("target[:5]:", target, "| want target[0]==304:", target[0]==304)
