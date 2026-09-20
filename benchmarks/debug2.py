import mlx.core as mx, functools
from mlx_lm.utils import load
from mlx_lm.models.cache import make_prompt_cache
from mlx_lm.generate import generation_stream, maybe_quantize_kv_cache, generate_step

TARGET="/Users/ianzvirbulis/Models/Hemlock/maple-2bit-mlx"
mt,tt,_=load(TARGET, return_config=True, trust_remote_code=True)
prompt=mx.array(tt.encode("What is the capital of France? Explain briefly."))
qfn=functools.partial(maybe_quantize_kv_cache, quantized_kv_start=0, kv_group_size=64, kv_bits=None)

# generate_step token1
g=generate_step(prompt, mt, max_tokens=2, sampler=lambda x: mx.argmax(x,axis=-1))
first=None
for tok,_ in g:
    first=int(tok); break
print("generate_step token1:", first)

# fresh model, my prefill
mt2,_,_=load(TARGET, return_config=True, trust_remote_code=True)
mc=make_prompt_cache(mt2)
y=prompt.astype(mx.uint32)
while y.size>1:
    n=min(512,y.size-1)
    with mx.stream(generation_stream):
        mt2(y[:n][None], cache=mc)
    qfn(mc); mx.eval([c.state for c in mc])
    y=y[n:]; mx.clear_cache()
print("prefill done, y=", int(y.tolist()[0]), "offset:", [c.offset for c in mc][:1])
with mx.stream(generation_stream):
    lg=mt2(y[None], cache=mc)
qfn(mc)
t=mx.argmax(lg[:,-1:,:],axis=-1); mx.eval(t)
print("my prefill model([y]) ->", int(t.tolist()[0][0]), "(want 304)")
print("offsets match generate_step? compare generates 304 means it's right")
