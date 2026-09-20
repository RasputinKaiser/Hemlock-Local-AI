import mlx.core as mx, time, sys
from mlx_lm.utils import load
from mlx_lm.generate import generate_step, speculative_generate_step
from mlx_lm.speculative import optimized_speculative_generate
from mlx_lm.sample_utils import make_sampler

TARGET="/Users/ianzvirbulis/Models/Hemlock/maple-2bit-mlx"
DRAFT="/Users/ianzvirbulis/Models/Hemlock/qwen25-0.5b-draft-4bit"
tt=load(TARGET, return_config=True, trust_remote_code=True)[1]
sampler=make_sampler(temp=0.0)
EOS=set(tt.eos_token_ids)

prompts={
 "factual":"What is the capital of France? Explain briefly.",
 "code":"Write a Python function for binary search on a sorted list.",
 "long":"The Industrial Revolution changed European society. Explain its impact in the 19th century.",
 "conv":"I'm planning a trip to Japan in the spring. What should I see?",
 "struct":"Extract from text: 'Apple reported Q3 revenue of $85.4B, up 5% YoY.' Give company and revenue.",
}

# Verify all three methods agree (each gets FRESH model loads inside)
for name,pt in prompts.items():
    p=mx.array(tt.encode(pt))
    # serial
    s=[int(t) for t,_ in generate_step(p, load(TARGET,trust_remote_code=True)[0], max_tokens=120, sampler=sampler)]
    # stock speculative
    sp=[int(t) for t,_,_ in speculative_generate_step(p, load(TARGET,trust_remote_code=True)[0], load(DRAFT,trust_remote_code=True)[0], num_draft_tokens=4, max_tokens=120, sampler=sampler)]
    # optimized
    r=optimized_speculative_generate(prompt=p, model=load(TARGET,trust_remote_code=True)[0], draft_model=load(DRAFT,trust_remote_code=True)[0], max_tokens=120, sampler=sampler, max_depth=4)
    print(f"{name:8s} serial={len(s)} stock={len(sp)} opt={len(r.tokens)} | stock==serial:{s==sp} opt==serial:{s==r.tokens}")
