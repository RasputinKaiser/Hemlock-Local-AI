# LFM2.5-DSpark Draft Model — LiquidAI speculative decoding architecture
# https://huggingface.co/LiquidAI/LFM2.5-8B-A1B-DSpark
#
# DSpark (blog: huggingface.co/blog/LiquidAI/lfm25-dspark) combines:
#   - DFlash-style parallel backbone (5 attention layers) conditioned on the
#     target model's context features (hidden states from target_layer_ids)
#   - a lightweight sequential Markov head (rank-256 factorized token
#     transition) adding inter-token dependency
#   - a confidence-scheduled verifier head pruning low-confidence suffixes
#
# The draft has NO embeddings and NO lm_head of its own: it consumes the
# target model's hidden states, projected by `fc` from
# num_draft_input_layers * hidden_size -> hidden_size.
#
# NOTE: day-one DSpark runtimes are llama.cpp and SGLang. mlx-lm has no
# DSpark speculative loop; this wrapper exists so the checkpoint loads and
# its components are inspectable/testable under mlx-lm.

from __future__ import annotations

import inspect
from dataclasses import dataclass, field
from typing import Any, Dict, Optional

import mlx.core as mx
import mlx.nn as nn

from .qwen3 import (
    ModelArgs as Qwen3ModelArgs,
    TransformerBlock,
    create_attention_mask,
)


# ── Model args ──────────────────────────────────────────────────────────────

@dataclass
class ModelArgs(Qwen3ModelArgs):
    # Draft has no embeddings/lm_head; config omits this field.
    tie_word_embeddings: bool = True
    markov_rank: int = 256
    block_size: int = 9
    dflash_config: dict = field(default_factory=dict)
    enable_confidence_head: bool = True
    markov_head_type: str = "vanilla"

    @classmethod
    def from_dict(cls, params):
        # Qwen3's from_dict filters unknown keys; capture draft-specific ones.
        known = {k: v for k, v in params.items()
                 if k in inspect.signature(cls).parameters}
        known.setdefault("dflash_config", {})
        return cls(**known)

    @property
    def num_draft_input_layers(self) -> int:
        ids = self.dflash_config.get("target_layer_ids", [])
        return len(ids) if ids else 1


# ── DSpark heads ───────────────────────────────────────────────────────────

class MarkovHead(nn.Module):
    """Rank-256 factorized token Markov transition.

    P(next | prev) ≈ markov_w1[prev] @ markov_w2.T — both weights are
    (vocab_size, markov_rank), factorizing the vocab×vocab transition.
    """

    def __init__(self, vocab_size: int, rank: int):
        super().__init__()
        self.markov_w1 = nn.Linear(rank, vocab_size, bias=False)
        self.markov_w2 = nn.Linear(rank, vocab_size, bias=False)

    def __call__(self, prev_tokens: mx.array):
        """prev_tokens: (B, L) int token ids -> (state (B,L,rank), logits (B,L,vocab))"""
        state = self.markov_w1.weight[prev_tokens]
        logits = state @ self.markov_w2.weight.T
        return state, logits


class ConfidenceHead(nn.Module):
    """Predicts each draft token's survival probability.

    Input is [hidden_state (hidden_size) ; markov_state (markov_rank)].
    """

    def __init__(self, in_dim: int):
        super().__init__()
        self.proj = nn.Linear(in_dim, 1, bias=True)

    def __call__(self, x: mx.array) -> mx.array:
        return self.proj(x).squeeze(-1)


# ── DSpark draft model ─────────────────────────────────────────────────────

class DSparkBackbone(nn.Module):
    """5-layer attention-only draft stack + DSpark heads.

    Parameter names intentionally match the bare safetensors keys
    (layers.*, norm.weight, hidden_norm.weight, fc.weight,
    markov_head.*, confidence_head.*).
    """

    def __init__(self, args: ModelArgs):
        super().__init__()
        self.args = args
        self.vocab_size = args.vocab_size

        # Projects concat(target hidden states) -> draft hidden size
        self.fc = nn.Linear(
            args.num_draft_input_layers * args.hidden_size,
            args.hidden_size,
            bias=False,
        )
        self.layers = [
            TransformerBlock(args=args) for _ in range(args.num_hidden_layers)
        ]
        self.norm = nn.RMSNorm(args.hidden_size, eps=args.rms_norm_eps)
        self.hidden_norm = nn.RMSNorm(args.hidden_size, eps=args.rms_norm_eps)
        self.markov_head = MarkovHead(args.vocab_size, args.markov_rank)
        self.confidence_head = ConfidenceHead(
            args.hidden_size + args.markov_rank
        )

    def __call__(
        self,
        target_hidden: mx.array,
        cache=None,
    ) -> mx.array:
        """target_hidden: (B, L, num_draft_input_layers * hidden_size)
        concatenated hidden states from the target model's target_layer_ids.
        Returns final draft hidden states (post-norm).
        """
        h = self.fc(target_hidden)
        if cache is None:
            cache = [None] * len(self.layers)
        mask = create_attention_mask(h, cache[0])
        for layer, c in zip(self.layers, cache):
            h = layer(h, mask, c)
        return self.norm(h)

    def draft(self, h: mx.array, prev_tokens: mx.array):
        """Draft hidden states + previous token ids -> (logits, confidence)."""
        hn = self.hidden_norm(h)
        prev_state, m_logits = self.markov_head(prev_tokens)
        conf_in = mx.concatenate([hn, mx.tanh(prev_state)], axis=-1)
        confidence = self.confidence_head(conf_in)
        return m_logits, confidence


# ── Top-level Model (model. prefix wrapper for mlx-lm) ─────────────────────

class Model(nn.Module):
    """DSpark draft model with model.<param> convention for mlx-lm."""

    def __init__(self, args: ModelArgs):
        super().__init__()
        self.args = args
        self.model_type = args.model_type
        self.model = DSparkBackbone(args)

    def __call__(
        self,
        inputs: Optional[mx.array] = None,
        cache=None,
        input_embeddings: Optional[mx.array] = None,
    ) -> mx.array:
        # The draft consumes projected target hidden states, not tokens.
        # input_embeddings here carries the concatenated target hidden states.
        return self.model(input_embeddings, cache)

    def draft(self, h: mx.array, prev_tokens: mx.array):
        return self.model.draft(h, prev_tokens)

    @property
    def layers(self):
        return self.model.layers

    def sanitize(self, weights: Dict[str, mx.array]) -> Dict[str, mx.array]:
        return weights

    def make_cache(self):
        from .cache import KVCache
        return [KVCache() for _ in range(self.args.num_hidden_layers)]

    def load_weights(self, file_or_weights, strict=True):
        """Remap bare safetensors names to model.<name> convention.

        Parameters
        ----------
        file_or_weights : str or list of (name, array) pairs
            Either a path to a .safetensors/.npz file, or a list of
            (name, mx.array) pairs.
        """
        if isinstance(file_or_weights, str):
            items = list(mx.load(file_or_weights).items())
        else:
            items = list(file_or_weights)

        remapped = []
        for k, v in items:
            if k.startswith("model."):
                remapped.append((k, v))
            else:
                remapped.append((f"model.{k}", v))

        return super().load_weights(remapped, strict=strict)
