"""Build a small Maple-architecture draft model for speculative decoding.

Maple-Preview has no native MTP head, so we use a *truncated-layer* draft:
load the same 2-bit Maple checkpoint but keep only the first N transformer
layers. This shares the exact vocabulary, token embeddings, and LM head with
the full target, so it is a genuine Maple-distribution draft (unlike a
foreign Qwen model) and accepts far more often.

The draft is a SEPARATE model instance so its KV cache does not collide with
the target's. Weights are the real first-N-layer weights from the 2-bit file,
so no retraining is required and quality is as good as layer-truncation allows.
"""
import mlx.core as mx
import mlx.nn as nn

from mlx_lm.utils import load


def make_maple_layer_draft(model_path: str, num_layers: int = 4, trust_remote_code=True):
    """Return a truncated Maple model to use as a speculative draft.

    Args:
        model_path: path to a Maple MLX checkpoint (e.g. maple-2bit-mlx)
        num_layers: number of leading transformer layers to keep (default 4)
    Returns:
        (draft_model, tokenizer, config) compatible with speculative_generate_step
        / optimized_speculative_generate.
    """
    model, tokenizer, config = load(
        model_path, return_config=True, trust_remote_code=trust_remote_code
    )
    full = len(model.model.layers)
    if num_layers >= full:
        # Nothing to truncate; the draft is the target itself (self-draft).
        return model, tokenizer, config

    # Truncate leading layers. Keep layer_types aligned so attention masks match.
    model.model.layers = model.model.layers[:num_layers]
    model.model.layer_types = model.model.layer_types[:num_layers]
    try:
        model.model.args.num_hidden_layers = num_layers
    except Exception:
        pass
    return model, tokenizer, config


if __name__ == "__main__":
    import sys
    mp = sys.argv[1] if len(sys.argv) > 1 else "/Users/ianzvirbulis/Models/Hemlock/maple-2bit-mlx"
    nl = int(sys.argv[2]) if len(sys.argv) > 2 else 4
    d, tok, cfg = make_maple_layer_draft(mp, nl)
    print(f"Draft: {len(d.model.layers)} layers (from {len(cfg.get('layer_types', [])) or 24})")
    p = mx.array(tok.encode("What is the capital of France?"))
    c = __import__("mlx_lm.models.cache", fromlist=["make_prompt_cache"]).make_prompt_cache(d)
    o = d(p[None], cache=c)
    print("forward OK:", o.shape)
