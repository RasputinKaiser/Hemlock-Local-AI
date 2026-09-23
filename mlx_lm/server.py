# Copyright © 2023-2024 Apple Inc.

import argparse
import copy
import glob
import json
import logging
import math
import os
import pickle
import platform
import signal
import socket
import sys
import threading
import time
import uuid
import warnings
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from queue import Empty as QueueEmpty
from queue import Queue
from threading import Thread
from typing import (
    Any,
    Callable,
    Dict,
    List,
    Literal,
    NamedTuple,
    Optional,
    Sequence,
    Tuple,
    Union,
)

import mlx.core as mx
from huggingface_hub import scan_cache_dir

from ._version import __version__
from .generate import (
    BatchGenerator,
    StopSequenceMatcher,
    TextStateMachine,
    make_stop_matcher,
    make_text_state_machine,
    stream_generate,
)
from .models.cache import (
    LRUPromptCache,
    load_prompt_cache,
    make_prompt_cache,
    save_prompt_cache,
)
from mlx.utils import tree_flatten
from .sample_utils import make_logits_processors, make_sampler
from .utils import _parse_size, load, sharded_load


def get_system_fingerprint():
    gpu_arch = mx.device_info()["architecture"]
    return f"{__version__}-{mx.__version__}-{platform.platform()}-{gpu_arch}"


class ToolCallFormatter:
    def __init__(self, tool_parser, tools, streaming=False):
        self._idx = 0
        self._tool_parser = tool_parser
        self._tools = tools
        self._streaming = streaming

    def _format(self, tc):
        tc_id = tc.pop("id", None) or str(uuid.uuid4())
        tc["arguments"] = json.dumps(tc["arguments"], ensure_ascii=False)
        out = {
            "function": tc,
            "type": "function",
            "id": tc_id,
        }
        if self._streaming:
            out["index"] = self._idx
            self._idx += 1
        return out

    def __call__(self, tool_calls):
        if not tool_calls:
            return []

        result = []
        for tool_text in tool_calls:
            try:
                parsed = self._tool_parser(tool_text, self._tools)
            except (ValueError, json.JSONDecodeError) as e:
                logging.warning(
                    f"Failed to parse tool call ({type(e).__name__}: {e}) — "
                    f"tool text was likely truncated mid-generation."
                )
                continue
            if not isinstance(parsed, list):
                parsed = [parsed]
            result.extend(self._format(tc) for tc in parsed)
        return result


def convert_chat(messages: List[dict], role_mapping: Optional[dict] = None):
    default_role_mapping = {
        "system_prompt": (
            "A chat between a curious user and an artificial intelligence "
            "assistant. The assistant follows the given rules no matter what."
        ),
        "system": "ASSISTANT's RULE: ",
        "user": "USER: ",
        "assistant": "ASSISTANT: ",
        "stop": "\n",
    }
    role_mapping = role_mapping or default_role_mapping

    prompt = ""
    for line in messages:
        role_prefix = role_mapping.get(line["role"], "")
        stop = role_mapping.get("stop", "")
        content = line.get("content", "")
        prompt += f"{role_prefix}{content}{stop}"

    prompt += role_mapping.get("assistant", "")
    return prompt.rstrip()


def process_message_content(messages):
    """
    Convert message content to a format suitable for `apply_chat_template`.

    The function operates on messages in place. It converts the 'content' field
    to a string instead of a list of text fragments.

    Args:
        message_list (list): A list of dictionaries, where each dictionary may
          have a 'content' key containing a list of dictionaries with 'type' and
          'text' keys.

    Raises:
        ValueError: If the 'content' type is not supported or if 'text' is missing.

    """
    for message in messages:
        content = message.get("content")
        if isinstance(content, list):
            text_fragments = [
                fragment["text"] for fragment in content if fragment["type"] == "text"
            ]
            if len(text_fragments) != len(content):
                raise ValueError("Only 'text' content type is supported.")
            message["content"] = "".join(text_fragments)
        elif content is None:
            message["content"] = ""

        if tool_calls := message.get("tool_calls"):
            for tool_call in tool_calls:
                if func := tool_call.get("function"):
                    if args := func.get("arguments"):
                        func["arguments"] = json.loads(args)


_DECIDE_MAX_QUESTIONS = 32
_DECIDE_MAX_OPTIONS = 255

# Request-surface resource guards. A request body beyond this bound is a 413,
# and a generated response beyond _MAX_TOKENS_LIMIT is a 400 — neither should
# be allowed to pin the generation thread or the GPU.
_MAX_REQUEST_BODY_BYTES = 64 * 1024 * 1024
_MAX_TOKENS_LIMIT = 131072

# `assistant_prefix` is appended to the templated chat prompt so the model
# continues a partially-written assistant turn. Keep it small: it exists to
# force an envelope (e.g. `{"command":`), not to inject content.
_ASSISTANT_PREFIX_MAX_TOKENS = 64

# Persist the hottest prompt-cache entry to --prompt-cache-file after every
# Nth cache insert.
_PROMPT_CACHE_SAVE_INTERVAL = 32

# How many prompt-cache entries --prompt-cache-file persists per save.
# HEMLOCK_PROMPT_CACHE_SLOTS tunes it; <= 1 selects the legacy single-entry
# file (one safetensors at the exact --prompt-cache-file path).
_PROMPT_CACHE_DEFAULT_SLOTS = 4

# Sentinel pushed into the requests queue when a caller needs the prompt
# cache saved. The KV arrays were produced on the generation thread's Metal
# stream, so the save must run there — evaluating them on another thread
# fails with "There is no Stream(gpu, 0) in current thread".
_PROMPT_CACHE_SAVE_REQUEST = "__hemlock_save_prompt_cache__"


def _decide_desc(value):
    """Criteria descriptions: strings verbatim, other JSON values rendered."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def _serialize_state(state):
    """Render a JSON-ish state object/array as stable labeled text.

    Dicts render `key:` lines with keys sorted (deterministic across calls
    so identical states share a prompt-cache prefix); nested values are
    indented and arrays use `[i]` labels. Scalars get their JSON rendering.
    """
    if isinstance(state, str):
        return state
    if not isinstance(state, (dict, list)):
        return json.dumps(state, ensure_ascii=False, sort_keys=True)

    lines = []

    def emit(label, value, indent):
        pad = "  " * indent
        if isinstance(value, dict):
            if not value:
                lines.append(f"{pad}{label}: {{}}")
                return
            lines.append(f"{pad}{label}:")
            for k in sorted(value, key=str):
                emit(str(k), value[k], indent + 1)
        elif isinstance(value, list):
            if not value:
                lines.append(f"{pad}{label}: []")
                return
            lines.append(f"{pad}{label}:")
            for i, item in enumerate(value):
                emit(f"[{i}]", item, indent + 1)
        elif isinstance(value, str):
            lines.append(f"{pad}{label}: {value}")
        else:
            lines.append(
                f"{pad}{label}: {json.dumps(value, ensure_ascii=False, sort_keys=True)}"
            )

    if isinstance(state, dict):
        for k in sorted(state, key=str):
            emit(str(k), state[k], 0)
    else:
        for i, item in enumerate(state):
            emit(f"[{i}]", item, 0)
    return "\n".join(lines)


def _parse_decide_question(qid, spec):
    """Validate one decide question and normalize its options.

    Every option becomes {key, desc, label, resp_key, continuation}:
    `key`/`desc` fill the ``<opt> {key}: {desc}`` line, `label` is the
    teacher-forced text, `resp_key` is the key under `probabilities` in
    the response, and `continuation` is what gets committed if the option
    wins (defaults to the label).
    """
    if not isinstance(spec, dict):
        raise ValueError(f"question {qid!r} must be an object")
    qtype = spec.get("type")
    if qtype not in ("noul", "choice", "score"):
        raise ValueError(
            f"question {qid!r} has invalid type {qtype!r}; "
            "expected 'noul', 'choice', or 'score'"
        )
    instructions = spec.get("instructions", "")
    if not isinstance(instructions, str):
        raise ValueError(f"question {qid!r} 'instructions' must be a string")
    criteria = spec.get("criteria")

    if qtype == "noul":
        if criteria is not None and not isinstance(criteria, dict):
            raise ValueError(f"question {qid!r} 'criteria' must be an object")
        criteria = criteria or {}
        options = [
            {
                "key": "yes",
                "desc": _decide_desc(criteria.get("true")),
                "label": "yes",
                "resp_key": "true",
                "continuation": "yes",
            },
            {
                "key": "no",
                "desc": _decide_desc(criteria.get("false")),
                "label": "no",
                "resp_key": "false",
                "continuation": "no",
            },
        ]
    elif qtype == "choice":
        if not isinstance(criteria, dict) or not criteria:
            raise ValueError(
                f"question {qid!r} needs a non-empty 'criteria' object of options"
            )
        if len(criteria) > _DECIDE_MAX_OPTIONS:
            raise ValueError(
                f"question {qid!r} has more than {_DECIDE_MAX_OPTIONS} options"
            )
        options = []
        for raw_key, crit in criteria.items():
            key = str(raw_key)
            if not key:
                raise ValueError(f"question {qid!r} has an empty option key")
            if crit is None:
                desc, label, continuation = "", key, None
            elif isinstance(crit, str):
                desc, label, continuation = crit, key, None
            elif isinstance(crit, dict):
                desc = _decide_desc(crit.get("description"))
                label = crit.get("label")
                label = key if label is None else str(label)
                continuation = crit.get("continuation")
            else:
                raise ValueError(
                    f"question {qid!r} option {key!r} must be null, a string, "
                    "or an object"
                )
            if not label:
                raise ValueError(
                    f"question {qid!r} option {key!r} has an empty label"
                )
            options.append(
                {
                    "key": key,
                    "desc": desc or label,
                    "label": label,
                    "resp_key": key,
                    "continuation": label
                    if continuation is None
                    else str(continuation),
                }
            )
    else:  # score
        if not isinstance(criteria, list) or not (
            2 <= len(criteria) <= _DECIDE_MAX_OPTIONS
        ):
            raise ValueError(
                f"question {qid!r} needs a 'criteria' array of "
                f"2-{_DECIDE_MAX_OPTIONS} level descriptions"
            )
        options = [
            {
                "key": str(i),
                "desc": _decide_desc(level),
                "label": str(i),
                "resp_key": str(i),
                "continuation": str(i),
            }
            for i, level in enumerate(criteria)
        ]
    return {"type": qtype, "instructions": instructions, "options": options}


def _decide_answer(question, probs, logprobs):
    """Shape the per-question answer object for a decide response."""
    options = question["options"]
    qtype = question["type"]
    if qtype == "noul":
        # Options are fixed: index 0 is "yes" (reported as "true").
        return {
            "type": "noul",
            "noul": probs[0],
            "probabilities": {"true": probs[0], "false": probs[1]},
        }
    if qtype == "choice":
        k = len(probs)
        win = max(range(k), key=lambda i: probs[i])
        # Margin over the uniform prior, normalized to [0, 1]: 0 when the
        # distribution is uniform, 1 when it is a point mass.
        confidence = (
            1.0 if k == 1 else (probs[win] - 1.0 / k) / (1.0 - 1.0 / k)
        )
        return {
            "type": "choice",
            "choice": options[win]["resp_key"],
            "confidence": confidence,
            "probabilities": {
                o["resp_key"]: p for o, p in zip(options, probs)
            },
            "logprobs": {
                o["resp_key"]: lp for o, lp in zip(options, logprobs)
            },
        }
    # score: expected level index; confidence is 1 - normalized entropy
    # (0 at a uniform distribution, 1 at a point mass).
    k = len(probs)
    expected = sum(i * p for i, p in enumerate(probs))
    entropy = -sum(p * math.log(p) for p in probs if p > 0)
    return {
        "type": "score",
        "score": expected,
        "confidence": 1.0 - entropy / math.log(k),
        "legend": {o["resp_key"]: o["desc"] for o in options},
        "probabilities": {o["resp_key"]: p for o, p in zip(options, probs)},
    }


@dataclass
class ModelDescription:
    model: str
    draft: str
    adapter: str


@dataclass
class SamplingArguments:
    temperature: float
    top_p: float
    top_k: int
    min_p: float
    xtc_probability: float
    xtc_threshold: float


@dataclass
class LogitsProcessorArguments:
    logit_bias: Optional[Dict[int, float]]
    repetition_penalty: float
    repetition_context_size: int
    presence_penalty: float
    presence_context_size: int
    frequency_penalty: float
    frequency_context_size: int


@dataclass
class GenerationArguments:
    model: ModelDescription
    sampling: SamplingArguments
    logits: LogitsProcessorArguments

    stop_words: List[str]

    max_tokens: int
    num_draft_tokens: int
    logprobs: bool
    top_logprobs: int
    seed: Optional[int]
    chat_template_kwargs: Optional[Dict[str, Any]]
    ngram_draft: bool = False
    ngram_window: int = 1024


@dataclass
class CompletionRequest:
    request_type: Literal["chat", "text"]

    prompt: str

    messages: List[Any]
    tools: Optional[List[Any]]
    role_mapping: Optional[Dict[str, Any]]

    prompt_suffix: Optional[str] = None
    candidates: Optional[List[str]] = None
    # /v1/score only: teacher-force the winning candidate into the prompt
    # cache under key prompt+candidate+eos so the next request continues the
    # sequence as a strict prefix (continuous KV session across agent steps).
    commit: bool = False

    # /v1/decide only: `state` is the evaluated content and `questions` the
    # normalized question set (see _parse_decide_question). `commit` +
    # `commit_question` teacher-force the winning option's continuation into
    # the prompt cache under prompt+continuation+eos, like /v1/score.
    state: Any = None
    questions: Optional[Dict[str, Any]] = None
    commit_question: Optional[str] = None

    # /v1/chat/completions only: encoded (no special tokens) and appended to
    # the prompt right after the generation prompt, so the model continues a
    # partially-written assistant turn. The raw text is prepended to the
    # returned content so callers see the complete envelope.
    assistant_prefix: Optional[str] = None


@dataclass
class GenerationContext:
    has_tool_calling: bool
    has_thinking: bool
    tool_parser: Callable[[str, Any], Dict]

    text_sm: TextStateMachine
    initial_state: str

    prompt: List[int]
    prompt_cache_count: int = -1

    _should_stop: bool = False

    def stop(self):
        self._should_stop = True


@dataclass
class Response:
    text: str
    token: int
    logprob: float
    finish_reason: Optional[str]
    top_tokens: Tuple[Dict[str, Any]]


class TimeBudget:
    def __init__(self, budget=0.5, iterations=25, sync_frequency=10):
        self._is_distributed = mx.distributed.init().size() > 1
        self._budget = budget
        self._iterations = iterations
        self._sync_frequency = sync_frequency
        self._start = None
        self._current_iterations = None
        self._loops = 0
        self._time_spent = 0

    def __iter__(self):
        self._start = time.time()
        self._current_iterations = 0
        return self

    def __next__(self):
        if not self._is_distributed:
            if time.time() - self._start > self._budget:
                raise StopIteration()
            return None

        self._current_iterations += 1
        if self._current_iterations <= self._iterations:
            return None

        self._loops += 1
        self._time_spent += time.time() - self._start
        if self._loops % self._sync_frequency == 0:
            loop_time = mx.distributed.all_sum(self._time_spent).item()
            avg_loop_time = loop_time / (
                mx.distributed.init().size() * self._sync_frequency
            )
            factor = self._budget / avg_loop_time
            self._iterations = max(round(self._iterations * factor), 1)
            self._loops = 0
            self._time_spent = 0
        raise StopIteration()


class ModelProvider:
    def __init__(self, cli_args: argparse.Namespace):
        """Load models on demand and persist them across the whole process."""
        self.cli_args = cli_args
        self.model_key = None
        self.model = None
        self.tokenizer = None
        self.draft_model = None
        self.is_batchable = False

        group = mx.distributed.init()
        self.pipeline_group = group if group.size() > 1 and cli_args.pipeline else None
        self.tensor_group = (
            group if group.size() > 1 and not cli_args.pipeline else None
        )
        self.is_distributed = group.size() > 1

        # Maps model and adapter paths the actual paths to be used. Used to
        # map 'default_model' to the provided model by cli argument but could
        # be used for more in the future.
        self._model_map = {}
        self._adapter_map = {}
        self._draft_model_map = {}
        self._model_map["default_model"] = self.cli_args.model
        self._adapter_map["default_model"] = self.cli_args.adapter_path
        self._draft_model_map["default_model"] = self.cli_args.draft_model
        # Requests that name the default model by its resolved path (rather
        # than the "default_model" alias) must resolve to the same
        # (model, adapter, draft) key — otherwise omitting `adapters` silently
        # drops the launch-time adapter and flips model_key, paying a full
        # reload on every alternating request.
        if self.cli_args.model is not None:
            self._model_map.setdefault(self.cli_args.model, self.cli_args.model)
            self._adapter_map.setdefault(self.cli_args.model, self.cli_args.adapter_path)
            self._draft_model_map.setdefault(
                self.cli_args.model, self.cli_args.draft_model
            )

        # Build the tokenizer config for later use in load
        self._tokenizer_config = {"trust_remote_code": cli_args.trust_remote_code}
        if cli_args.chat_template:
            self._tokenizer_config["chat_template"] = cli_args.chat_template

    def _load(self, model_path, adapter_path=None, draft_model_path=None):
        if self.is_distributed and (
            adapter_path is not None or draft_model_path is not None
        ):
            raise ValueError(
                "Loading with adapters or draft models not supported in distributed mode"
            )

        # Remove the old model if it exists. Drop references FIRST, then clear
        # the MLX memory + Metal cache: on 16 GB Macs two resident models (e.g.
        # maple-2bit ~6 GB + LFM2.5-4bit ~5 GB) exceed the GPU wired limit and
        # Metal aborts the whole server (GPU Timeout -> SIGABRT) on the next
        # forward pass. Clearing here makes model switching actually free the
        # previous model's memory before the new one is allocated.
        self.model_key = None
        self.model = None
        self.tokenizer = None
        self.draft_model = None
        try:
            mx.clear_cache()
            mx.metal.clear_cache()
        except Exception:
            pass

        # Load the model and tokenizer
        if self.is_distributed:
            model, tokenizer = sharded_load(
                model_path,
                pipeline_group=self.pipeline_group,
                tensor_group=self.tensor_group,
                tokenizer_config=self._tokenizer_config,
                trust_remote_code=self.cli_args.trust_remote_code,
            )
        else:
            model_config = {}
            if getattr(self.cli_args, "flash_head", None) is not None:
                model_config["use_flash_head"] = self.cli_args.flash_head
            model, tokenizer = load(
                model_path,
                adapter_path=adapter_path,
                tokenizer_config=self._tokenizer_config,
                model_config=model_config,
                trust_remote_code=self.cli_args.trust_remote_code,
            )

        # Use the default chat template if needed
        if self.cli_args.use_default_chat_template:
            if tokenizer.chat_template is None:
                tokenizer.chat_template = tokenizer.default_chat_template

        # Load the draft model for speculative decoding
        draft_model = None
        if draft_model_path is not None:
            draft_model, draft_tokenizer = load(draft_model_path)
            if draft_tokenizer.vocab_size != tokenizer.vocab_size:
                logging.warning(
                    "Draft model tokenizer does not match model tokenizer. "
                    "Speculative decoding may not work as expected."
                )

        # Compute batchability
        is_batchable = draft_model is None
        is_batchable = is_batchable and all(
            hasattr(c, "merge") for c in make_prompt_cache(model)
        )

        # Update the member variables
        self.model_key = (model_path, adapter_path, draft_model_path)
        self.model = model
        self.tokenizer = tokenizer
        self.draft_model = draft_model
        self.is_batchable = is_batchable

    def load_default(self):
        if self._model_map["default_model"] is not None:
            self.load("default_model", None, "default_model")

    def load(self, model_path, adapter_path=None, draft_model_path=None):
        model_path = self._model_map.get(model_path, model_path)
        if adapter_path is None:
            # `adapters` omitted means "the configured default", not "no
            # adapter": an explicit empty string still selects the base model.
            adapter_path = self._adapter_map.get(model_path)
        draft_model_path = self._draft_model_map.get(draft_model_path, draft_model_path)

        model_key = (model_path, adapter_path, draft_model_path)
        if self.model_key != model_key:
            self._load(*model_key)

        return self.model, self.tokenizer


def _make_sampler(args, tokenizer):
    return make_sampler(
        args.sampling.temperature,
        top_p=args.sampling.top_p,
        top_k=args.sampling.top_k,
        min_p=args.sampling.min_p,
        xtc_probability=args.sampling.xtc_probability,
        xtc_threshold=args.sampling.xtc_threshold,
        xtc_special_tokens=tokenizer.encode("\n") + list(tokenizer.eos_token_ids),
    )


def _make_logits_processors(args):
    return make_logits_processors(
        args.logits.logit_bias,
        args.logits.repetition_penalty,
        args.logits.repetition_context_size,
        args.logits.presence_penalty,
        args.logits.presence_context_size,
        args.logits.frequency_penalty,
        args.logits.frequency_context_size,
    )


def _format_top_logprobs(logprobs, top_n, tokenizer) -> Tuple[Dict[str, Any]]:
    """Returns info dicts for the top `top_n` tokens from `logprobs`"""
    if top_n <= 0:
        return ()
    sorted_indices = mx.argpartition(-logprobs, kth=top_n - 1)
    top_indices = sorted_indices[:top_n].tolist()
    top_probs = logprobs[top_indices].tolist()
    txts = tokenizer.convert_ids_to_tokens(top_indices)
    return tuple(
        {"id": i, "token": s, "logprob": g}
        for i, s, g in zip(top_indices, txts, top_probs)
    )


class ResponseGenerator:
    def __init__(self, model_provider: ModelProvider, prompt_cache: LRUPromptCache):
        self.model_provider = model_provider
        self.prompt_cache = prompt_cache
        self.requests = Queue()
        self._state_machine_cache = {}

        self._time_budget = TimeBudget()
        self._is_distributed = mx.distributed.init().size() > 1
        self._rank = mx.distributed.init().rank()
        self._stop = False
        self._prefills_since_save = 0
        self._cache_save_interval = _PROMPT_CACHE_SAVE_INTERVAL
        self._cache_save_done = threading.Event()
        self._generation_thread = Thread(target=self._generate)
        self._generation_thread.start()

    def stop_and_join(self, timeout=None):
        self._stop = True
        # Bounded join: a generation thread blocked on an empty requests queue
        # never wakes to observe _stop, and an unbounded join during teardown
        # hits the same PyThreadState_Get finalization crash fixed in lora.py.
        self._generation_thread.join(timeout=timeout)

    def join(self):
        self._generation_thread.join()

    def _log_cache_stats(self):
        n_sequences = len(self.prompt_cache)
        n_bytes = self.prompt_cache.nbytes
        logging.info(f"Prompt Cache: {n_sequences} sequences, {n_bytes / 1e9:.2f} GB")
        for cache_type, stats in self.prompt_cache.stats_by_type().items():
            n_sequences = stats["n_sequences"]
            n_bytes = stats["n_bytes"]
            logging.info(
                f"- {cache_type}: {n_sequences} sequences, {n_bytes / 1e9:.2f} GB"
            )

    def _prompt_cache_file_path(self):
        """The --prompt-cache-file path, or None when unset/disabled."""
        if os.environ.get("HEMLOCK_NO_CACHE_FILE"):
            return None
        return getattr(self.model_provider.cli_args, "prompt_cache_file", None)

    def _expected_model_key(self):
        """The model_key the default model will have once loaded.

        Mirrors `ModelProvider.load`: the default model resolves to
        (cli model, cli adapter, cli draft)."""
        if self.model_provider.model_key is not None:
            return self.model_provider.model_key
        args = self.model_provider.cli_args
        return (
            args.model,
            getattr(args, "adapter_path", None),
            getattr(args, "draft_model", None),
        )

    def _insert_prompt_cache(self, model_key, tokens, cache, **kwargs):
        """insert_cache + periodic --prompt-cache-file persistence."""
        self.prompt_cache.insert_cache(model_key, tokens, cache, **kwargs)
        self._prefills_since_save += 1
        if self._prefills_since_save >= self._cache_save_interval:
            self._prefills_since_save = 0
            self.save_prompt_cache_file()

    def _prompt_cache_slots(self):
        """HEMLOCK_PROMPT_CACHE_SLOTS: entries persisted per save.

        ``<= 1`` selects the legacy single-entry file."""
        try:
            return int(os.environ.get("HEMLOCK_PROMPT_CACHE_SLOTS", ""))
        except ValueError:
            return _PROMPT_CACHE_DEFAULT_SLOTS

    def _recent_cache_entries(self, limit):
        """Up to ``limit`` most-recent prompt-cache entries, hottest first.

        ``[(model_key, key_tokens, cache), ...]``. Prefers the trie-aware
        ``recent_entries`` (LRUPromptCache) and falls back to ``mru_entry``
        for cache shims that only expose the hottest entry."""
        recent = getattr(self.prompt_cache, "recent_entries", None)
        if recent is not None:
            return recent(limit)
        mru = getattr(self.prompt_cache, "mru_entry", None)
        if mru is None:
            return []
        entry = mru()
        return [entry] if entry is not None else []

    def _write_prompt_cache_entry(self, path, entry, saved_at=None):
        """Write one ``(model_key, key_tokens, cache)`` entry to ``path``.

        Write-tmp-then-rename keeps the on-disk file whole on crash.
        Returns True on success."""
        model_key, key_tokens, cache = entry
        metadata = {
            "model_key": json.dumps(list(model_key)),
            "key_tokens": json.dumps(list(key_tokens)),
            "saved_at": str(saved_at or time.time()),
        }
        # mx.save_safetensors appends ".safetensors" to any name that lacks
        # it, so the tmp name must already carry the extension.
        tmp_path = f"{path}.{os.getpid()}.tmp.safetensors"
        try:
            save_prompt_cache(tmp_path, cache, metadata)
            os.replace(tmp_path, path)
            logging.debug(
                f"Saved prompt cache ({len(key_tokens)} tokens) to {path}"
            )
            return True
        except Exception as e:
            logging.warning(f"Failed to save prompt cache to {path}: {e}")
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
            return False

    def _write_prompt_cache_manifest(self, path, entries):
        """Multi-entry format: ``{path}.<index>.safetensors`` per entry plus
        an atomic ``{path}.manifest.json`` index.

        The manifest is written last — it is the commit point, so a crash
        mid-save leaves entry files the loader never references."""
        saved_at = time.time()
        manifest_entries = []
        for index, entry in enumerate(entries):
            entry_path = f"{path}.{index}.safetensors"
            # A failed entry write is skipped rather than committed to the
            # manifest pointing at a missing file.
            if not self._write_prompt_cache_entry(entry_path, entry, saved_at):
                continue
            model_key, key_tokens, _cache = entry
            manifest_entries.append(
                {
                    "index": index,
                    "model_key": list(model_key),
                    "key_tokens": list(key_tokens),
                    "saved_at": saved_at,
                    "file": os.path.basename(entry_path),
                }
            )
        if not manifest_entries:
            return
        manifest = {
            "schema": "hemlock.prompt-cache-manifest.v1",
            "saved_at": saved_at,
            "entries": manifest_entries,
        }
        manifest_path = f"{path}.manifest.json"
        tmp_path = f"{manifest_path}.{os.getpid()}.tmp"
        try:
            with open(tmp_path, "w") as f:
                json.dump(manifest, f)
            os.replace(tmp_path, manifest_path)
            logging.debug(
                f"Saved {len(manifest_entries)} prompt cache entries "
                f"to {manifest_path}"
            )
        except Exception as e:
            logging.warning(
                f"Failed to write prompt cache manifest {manifest_path}: {e}"
            )
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
            return
        # Drop entry files from earlier saves that this manifest no longer
        # references so slots do not accumulate on disk.
        keep = {item["file"] for item in manifest_entries}
        for stale in glob.glob(f"{glob.escape(path)}.*.safetensors"):
            if os.path.basename(stale) not in keep:
                try:
                    os.unlink(stale)
                except OSError:
                    pass

    def save_prompt_cache_file(self):
        """Persist the hottest prompt-cache entries to --prompt-cache-file.

        With HEMLOCK_PROMPT_CACHE_SLOTS > 1 (default 4) the K most-recent
        entries are written as ``{path}.<index>.safetensors`` plus a
        manifest; otherwise the legacy single-entry file holds the MRU
        entry's cache state plus {model_key, key_tokens, saved_at}
        metadata."""
        path = self._prompt_cache_file_path()
        if path is None:
            return
        slots = self._prompt_cache_slots()
        entries = self._recent_cache_entries(max(1, slots))
        if not entries:
            return
        if slots <= 1:
            self._write_prompt_cache_entry(path, entries[0])
            return
        self._write_prompt_cache_manifest(path, entries[:slots])

    def save_prompt_cache_file_async(self, wait_timeout=8.0):
        """Ask the generation thread to persist the prompt cache.

        The KV arrays were produced on that thread's Metal stream; saving
        them from any other thread fails with "no Stream(gpu, 0)". Returns
        after the save completes or wait_timeout elapses — the tmp+rename
        write makes an interrupted save harmless."""
        if self._prompt_cache_file_path() is None or self._stop:
            return
        self._cache_save_done.clear()
        self.requests.put((None, _PROMPT_CACHE_SAVE_REQUEST, None))
        self._cache_save_done.wait(timeout=wait_timeout)

    def _load_prompt_cache_entry(self, path, model_key, item):
        """Load one manifest-listed entry; returns 1 when installed, else 0.

        Per-entry failures (missing file, stale model_key, malformed
        key_tokens) skip only that entry — a partial warm is still a warm."""
        try:
            index = int(item.get("index"))
        except (TypeError, ValueError, AttributeError):
            index = None
        file_name = item.get("file") if isinstance(item, dict) else None
        if isinstance(file_name, str) and file_name:
            # Basename only: the manifest stays a directory-local index and
            # can never point the loader outside the cache directory.
            entry_path = os.path.join(
                os.path.dirname(path) or ".", os.path.basename(file_name)
            )
        elif index is not None:
            entry_path = f"{path}.{index}.safetensors"
        else:
            logging.warning(
                f"Prompt cache manifest entry {item!r} has no usable file "
                "or index; skipping it."
            )
            return 0
        try:
            cache, metadata = load_prompt_cache(entry_path, return_metadata=True)
            # mx.load is lazy: the arrays only materialize on first eval,
            # which would happen on the generation thread — it has no cpu
            # stream bound and dies with "no Stream(cpu, 1)". Materialize
            # here, on the loading thread, before the cache crosses over.
            mx.eval(*[v for _, v in tree_flatten([c.state for c in cache])])
            saved_key = json.loads(metadata.get("model_key") or "null")
            if saved_key != list(model_key):
                logging.warning(
                    f"Prompt cache entry {entry_path} was saved for model "
                    f"{saved_key}, not {list(model_key)}; skipping it."
                )
                return 0
            key_tokens = json.loads(metadata.get("key_tokens") or "null")
            if not (
                isinstance(key_tokens, list)
                and all(isinstance(t, int) for t in key_tokens)
            ):
                logging.warning(
                    f"Prompt cache entry {entry_path} has malformed "
                    "key_tokens; skipping it."
                )
                return 0
        except Exception as e:
            logging.warning(
                f"Could not load prompt cache entry {entry_path} ({e}); "
                "skipping it."
            )
            return 0
        try:
            self.prompt_cache.insert_cache(model_key, key_tokens, cache)
        except Exception as e:
            logging.warning(
                f"Could not install prompt cache entry {entry_path} ({e}); "
                "skipping it."
            )
            return 0
        return 1

    def _load_prompt_cache_manifest(self, path, manifest_path):
        """Load every valid entry listed in a multi-entry manifest.

        Returns True when the manifest parsed — even if every entry then
        failed (entry files are validated individually) — and False when
        the manifest itself is unusable, so the caller can fall back to
        the legacy single-entry file."""
        try:
            with open(manifest_path) as f:
                manifest = json.load(f)
            entries = manifest.get("entries")
            if not isinstance(entries, list):
                raise ValueError("manifest has no entries list")
        except Exception as e:
            logging.warning(
                f"Prompt cache manifest {manifest_path} is unreadable "
                f"({e}); falling back to the single-file cache."
            )
            return False
        model_key = self._expected_model_key()
        limit = getattr(self.prompt_cache, "max_size", None)
        if not isinstance(limit, int) or limit <= 0:
            limit = len(entries)
        # Oldest first: insertions become the LRU order, and a prefix entry
        # inserted after a longer one is not immediately popped as a
        # redundant prefix by insert_cache.
        loaded = 0
        for item in reversed(entries):
            if loaded >= limit:
                break
            loaded += self._load_prompt_cache_entry(path, model_key, item)
        if loaded:
            logging.info(
                f"Loaded {loaded} prompt cache entries from {manifest_path}"
            )
        return True

    def load_prompt_cache_file(self):
        """Warm the prompt cache from --prompt-cache-file at startup.

        Multi-entry manifests (``{path}.manifest.json``) load each listed
        entry; a missing/corrupt manifest or a legacy single-entry file
        uses the single-file path. Any inconsistency — unreadable file,
        stale model_key, malformed key_tokens — logs a warning and
        cold-starts; never raises."""
        path = self._prompt_cache_file_path()
        if path is None:
            return
        manifest_path = f"{path}.manifest.json"
        if self._prompt_cache_slots() > 1 and os.path.exists(manifest_path):
            if self._load_prompt_cache_manifest(path, manifest_path):
                return
            # Manifest unusable: fall through so a legacy single-entry
            # file still warms what it can.
        if not os.path.exists(path):
            return
        model_key = self._expected_model_key()
        try:
            cache, metadata = load_prompt_cache(path, return_metadata=True)
            # mx.load is lazy: the arrays only materialize on first eval,
            # which would happen on the generation thread — it has no cpu
            # stream bound and dies with "no Stream(cpu, 1)". Materialize
            # here, on the loading thread, before the cache crosses over.
            mx.eval(*[v for _, v in tree_flatten([c.state for c in cache])])
            saved_key = json.loads(metadata.get("model_key") or "null")
            if saved_key != list(model_key):
                logging.warning(
                    f"Prompt cache file {path} was saved for model "
                    f"{saved_key}, not {list(model_key)}; cold-starting."
                )
                return
            key_tokens = json.loads(metadata.get("key_tokens") or "null")
            if not (
                isinstance(key_tokens, list)
                and all(isinstance(t, int) for t in key_tokens)
            ):
                logging.warning(
                    f"Prompt cache file {path} has malformed key_tokens; "
                    "cold-starting."
                )
                return
        except Exception as e:
            logging.warning(
                f"Could not load prompt cache file {path} ({e}); cold-starting."
            )
            return
        try:
            self.prompt_cache.insert_cache(model_key, key_tokens, cache)
        except Exception as e:
            logging.warning(
                f"Could not install prompt cache from {path} ({e}); "
                "cold-starting."
            )
            return
        logging.info(
            f"Loaded prompt cache from {path}: {len(key_tokens)} tokens"
        )

    def _next_request(self, timeout=None):
        request = None
        if not self._is_distributed or self._rank == 0:
            try:
                if timeout is not None:
                    request = self.requests.get(timeout=timeout)
                else:
                    request = self.requests.get_nowait()
            except QueueEmpty:
                pass
        return self._share_request(request)

    def _share_object(self, obj):
        if not self._is_distributed:
            return obj

        if self._rank == 0:
            if obj is None:
                mx.eval(mx.distributed.all_sum(0))
                return None
            data = mx.array(pickle.dumps(obj))
            mx.eval(mx.distributed.all_sum(data.size))
            mx.eval(mx.distributed.all_sum(data))
            return obj
        else:
            size = mx.distributed.all_sum(0).item()
            if size == 0:
                return None
            data = mx.zeros(size, dtype=mx.uint8)
            data = mx.distributed.all_sum(data)
            return pickle.loads(data)

    def _share_request(self, request):
        if not self._is_distributed:
            return request

        shareable = request[1:] if request is not None else None
        shareable = self._share_object(shareable)
        if shareable is None:
            return None

        rq = request[0] if request is not None else Queue()
        return rq, *shareable

    @staticmethod
    def _append_assistant_prefix(tokenizer, request, prompt):
        """Append `assistant_prefix` tokens so generation continues a
        partially-written assistant turn. The tokens become part of the
        prompt, so they join the prompt-cache key like any other prefix."""
        prefix = getattr(request, "assistant_prefix", None)
        if prefix is None:
            return prompt
        prefix_tokens = tokenizer.encode(prefix, add_special_tokens=False)
        if len(prefix_tokens) > _ASSISTANT_PREFIX_MAX_TOKENS:
            raise ValueError(
                f"'assistant_prefix' encodes to {len(prefix_tokens)} tokens; "
                f"the maximum is {_ASSISTANT_PREFIX_MAX_TOKENS}"
            )
        return prompt + prefix_tokens

    def _prompt_token_limit(self):
        """Effective prompt ceiling in tokens.

        An explicit ``--max-prompt-tokens`` cap wins when configured;
        otherwise the loaded model's ``max_position_embeddings`` bounds the
        prompt (RoPE models cannot serve positions past it — a longer prompt
        degrades or OOMs the generation thread instead of answering).
        Unknowable means unbounded, not crash.
        """
        explicit = getattr(self.cli_args, "max_prompt_tokens", None)
        model_limit = getattr(
            getattr(self.model_provider.model, "args", None),
            "max_position_embeddings",
            None,
        )
        limits = []
        for value in (explicit, model_limit):
            if isinstance(value, bool):
                continue
            if isinstance(value, (int, float)) and math.isfinite(value) and value > 0:
                limits.append(int(value))
        return min(limits) if limits else None

    def _check_prompt_tokens(self, tokens, label="prompt"):
        limit = self._prompt_token_limit()
        if limit is not None and len(tokens) > limit:
            raise ValueError(
                f"{label} is {len(tokens)} tokens, which exceeds the "
                f"maximum of {limit} tokens this server can serve"
            )

    def _tokenize(self, tokenizer, request, args):
        """Tokenize a request and split the prompt into segments.

        Returns a tuple

          * prompt - Full list of tokens
          * segments - A list of lists of tokens. Up to 3 segments that
            correspond to system prompt, context, thinking tail.
          * segment_types - A string per segment indicating if the segment is a
            system prompt or a user prompt or nothing special.
          * initial state - A string that contains the initial state of the
            state machine (normal or thinking depending on whether we have tail
            or not)
        """
        if request.request_type == "chat":
            messages = request.messages
            tools = request.tools
            role_mapping = request.role_mapping

            if tokenizer.has_chat_template:
                process_message_content(messages)
                if tools and not tokenizer.has_tool_calling:
                    logging.warning(
                        "Received tools but model does not support tool calling. "
                        "If you think this is an error, file an issue here: "
                        "https://github.com/ml-explore/mlx-lm/issues"
                    )

                chat_template_args = self.model_provider.cli_args.chat_template_args
                if args.chat_template_kwargs:
                    chat_template_args = chat_template_args.copy()
                    chat_template_args.update(args.chat_template_kwargs)
                template_kwargs = dict(
                    tools=tools,
                    tokenize=True,
                    **chat_template_args,
                )
                prompt = tokenizer.apply_chat_template(
                    messages,
                    add_generation_prompt=True,
                    **template_kwargs,
                )
                # Appended before segmentation so the prefix lands inside the
                # last ("assistant") segment and the prompt-cache key.
                prompt = self._append_assistant_prefix(
                    tokenizer, request, prompt
                )
            else:
                prompt = tokenizer.encode(convert_chat(messages, role_mapping))
                prompt = self._append_assistant_prefix(
                    tokenizer, request, prompt
                )
                self._check_prompt_tokens(prompt)
                return prompt, [prompt], ["assistant"], "normal"
        else:
            if getattr(request, "assistant_prefix", None) is not None:
                raise ValueError(
                    "'assistant_prefix' requires a chat request ('messages'), "
                    "not a raw 'prompt'"
                )
            prompt = tokenizer.encode(request.prompt)
            self._check_prompt_tokens(prompt)
            return prompt, [prompt], ["assistant"], "normal"

        # If we are here it means we have a chat request so we need to search
        # for segments for better cache management.

        # Choose the initial state among only reasoning or normal
        initial_state = "normal"
        if tokenizer.has_thinking:
            think_start = tokenizer.rfind_think_start(prompt)
            think_end = tokenizer.rfind_think_end(prompt)
            if think_start > think_end:
                initial_state = "reasoning"

        # It is not a user message so no segmentation needed.
        if messages[-1]["role"] != "user":
            self._check_prompt_tokens(prompt)
            return prompt, [prompt], ["assistant"], initial_state

        segments = []
        segment_types = []

        # Find where the system prompt ends and add it as a segment.
        num_system = 0
        sys_end = 0
        for m in messages:
            if m["role"] == "system":
                num_system += 1
            else:
                break
        if num_system > 0:
            sys_tokens = tokenizer.apply_chat_template(
                messages[:num_system] + [{"role": "user", "content": ""}],
                add_generation_prompt=False,
                **template_kwargs,
            )
            for i, (a, b) in enumerate(zip(sys_tokens, prompt)):
                if a != b:
                    sys_end = i
                    break
            if sys_end > 0 and sys_end < len(prompt):
                segments.append(prompt[:sys_end])
                segment_types.append("system")

        # Find a tail segment that contains thinking tokens (small up to 11
        # tokens)
        tail_start = len(prompt)
        if tokenizer.has_thinking:
            think_start = tokenizer.rfind_think_start(prompt, start=tail_start - 11)
            if think_start >= 0:
                tail_start = think_start

        # Finalize the segments and return
        if sys_end < tail_start:
            segments.append(prompt[sys_end:tail_start])
            segment_types.append("user")
        if tail_start < len(prompt):
            segments.append(prompt[tail_start:])
            segment_types.append("assistant")
        if not segments:
            segments = [prompt]
            segment_types = ["assistant"]

        self._check_prompt_tokens(prompt)
        return prompt, segments, segment_types, initial_state

    def _make_state_machine(self, model_key, tokenizer, stop_words):
        """Make (and cache) a StopSequenceMatcher and TextStateMachine."""
        cache_key = (model_key, tuple(stop_words))
        rs = self._state_machine_cache.get(cache_key)
        if rs is not None:
            return rs

        stop_matcher = make_stop_matcher(tokenizer, stop_words)
        text_sm = make_text_state_machine(tokenizer, stop_words)

        if len(self._state_machine_cache) > 100:
            self._state_machine_cache.clear()
        self._state_machine_cache[cache_key] = (stop_matcher, text_sm)

        return stop_matcher, text_sm

    def _is_batchable(self, args):
        # n-gram speculative decoding and KV cache quantization are only
        # implemented on the single-request path (`_serve_single` →
        # `stream_generate` → `generate_step`). The continuous-batching
        # `BatchGenerator` path ignores both flags, so force the single path
        # whenever either optimization is active. With decode/prompt
        # concurrency set to 1 (the Hemlock default) this has no throughput
        # downside for a local single-user assistant.
        if getattr(args, "ngram_draft", False):
            return False
        if self.cli_args.kv_bits is not None:
            return False
        return self.model_provider.is_batchable and args.seed is None

    def _generate(self):
        # Local thread stream that we 'll pass to the BatchGenerator to make
        # sure that all generation runs in the same stream as the
        # synchronization messages.
        generation_stream = mx.default_stream(mx.default_device())

        # Load the default model if it is given
        self.model_provider.load_default()

        current_model = None
        current_sampling = None
        current_tokenizer = None
        current_model_key = None
        batch_generator = None
        drain_batch = False
        batch_results = {}

        unprocessed_requests = []

        def get_next_request(timeout=None):
            if unprocessed_requests:
                return unprocessed_requests.pop()
            else:
                return self._next_request(timeout)

        if self._is_distributed:
            seed = mx.distributed.all_sum(mx.random.state[0]).view(mx.uint64).item()
            mx.random.seed(seed)

        while not self._stop:
            request = None
            if not drain_batch:
                timeout = (
                    None
                    if (batch_generator is not None and len(batch_results) > 0)
                    else 0.1
                )
                request = get_next_request(timeout=timeout)

            # We got a request
            if request is not None:
                # Cache-save sentinel: run the save on this thread, whose
                # Metal stream produced the KV arrays.
                if request[1] == _PROMPT_CACHE_SAVE_REQUEST:
                    self.save_prompt_cache_file()
                    self._cache_save_done.set()
                    continue
                rqueue, request, args = request

                # Scoring requests never join a generation batch: they run
                # a prefill plus one teacher-forced forward per candidate.
                if getattr(request, "candidates", None) is not None:
                    if batch_generator is not None:
                        drain_batch = True
                        unprocessed_requests.append((rqueue, request, args))
                        continue
                    try:
                        self.model_provider.load(
                            args.model.model, args.model.adapter, args.model.draft
                        )
                    except Exception as e:
                        rqueue.put(e)
                        continue
                    self._serve_score((rqueue, request, args))
                    continue

                # Decide requests reuse the scoring machinery (cache-aware
                # prefill plus teacher-forced option scoring on forked
                # caches) and likewise never join a generation batch.
                if getattr(request, "questions", None) is not None:
                    if batch_generator is not None:
                        drain_batch = True
                        unprocessed_requests.append((rqueue, request, args))
                        continue
                    try:
                        self.model_provider.load(
                            args.model.model, args.model.adapter, args.model.draft
                        )
                    except Exception as e:
                        rqueue.put(e)
                        continue
                    self._serve_decide((rqueue, request, args))
                    continue

                # Can it be added to the current batch?
                if (
                    batch_generator is not None
                    and current_model == args.model
                    and self._is_batchable(args)
                ):
                    try:
                        prompt, segments, segment_types, initial_state = self._tokenize(
                            current_tokenizer, request, args
                        )
                    except Exception as e:
                        rqueue.put(e)
                        continue

                    stop_matcher, text_sm = self._make_state_machine(
                        self.model_provider.model_key,
                        tokenizer,
                        args.stop_words,
                    )

                    self._log_cache_stats()
                    cache, rest = self.prompt_cache.fetch_nearest_cache(
                        current_model_key, prompt
                    )
                    prompt_cache_count = len(prompt) - len(rest)
                    N = prompt_cache_count
                    while N > 0:
                        if N >= len(segments[0]):
                            N -= len(segments.pop(0))
                            segment_types.pop(0)
                        else:
                            segments[0] = segments[0][N:]
                            break

                    ctx = GenerationContext(
                        has_tool_calling=tokenizer.has_tool_calling,
                        has_thinking=tokenizer.has_thinking,
                        tool_parser=tokenizer.tool_parser,
                        text_sm=text_sm,
                        initial_state=initial_state,
                        prompt=prompt,
                        prompt_cache_count=prompt_cache_count,
                    )
                    rqueue.put(ctx)

                    (uid,) = batch_generator.insert_segments(
                        segments=[segments],
                        max_tokens=[args.max_tokens],
                        caches=[cache],
                        all_tokens=[prompt[:prompt_cache_count]],
                        samplers=[_make_sampler(args, tokenizer)],
                        logits_processors=[_make_logits_processors(args)],
                        stop_matchers=[stop_matcher],
                    )
                    batch_results[uid] = {
                        "ctx": ctx,
                        "rqueue": rqueue,
                        "detokenizer": tokenizer.detokenizer,
                        "segment_types": segment_types[::-1],
                        "top_logprobs": args.top_logprobs,
                        "want_logprobs": bool(args.logprobs or args.top_logprobs > 0),
                    }
                    # just making sure we don't leave a reference around
                    del cache

                    if self.model_provider.cli_args.prompt_cache_bytes is not None:
                        total = self.model_provider.cli_args.prompt_cache_bytes
                        active = batch_generator.prompt_cache_nbytes
                        self.prompt_cache.trim_to(n_bytes=total - active)
                    continue

                # No batch generator. Load the model and if it's not
                # batchable serve sequential, o/w make a batch generaotr and
                # serve batched
                elif batch_generator is None:
                    try:
                        model, tokenizer = self.model_provider.load(
                            args.model.model, args.model.adapter, args.model.draft
                        )
                    except Exception as e:
                        rqueue.put(e)
                        continue

                    if not self._is_batchable(args):
                        self._serve_single((rqueue, request, args))
                        continue

                    current_model = args.model
                    current_tokenizer = tokenizer
                    current_model_key = self.model_provider.model_key
                    batch_results = {}
                    batch_generator = BatchGenerator(
                        model,
                        completion_batch_size=self.cli_args.decode_concurrency,
                        prefill_batch_size=self.cli_args.prompt_concurrency,
                        prefill_step_size=self.cli_args.prefill_step_size,
                        stream=generation_stream,
                    )
                    unprocessed_requests.append((rqueue, request, args))
                    continue

                # We have a batch but this request cannot be added to the
                # batch so drain it to process the request.
                else:
                    drain_batch = True
                    unprocessed_requests.append((rqueue, request, args))
                    continue

            # No request so serve from the current batch
            elif batch_generator is not None:
                if len(batch_results) == 0:
                    if drain_batch:
                        current_model = None
                        current_sampling = None
                        current_tokenizer = None
                        current_model_key = None
                        batch_generator.close()
                        batch_generator = None
                        drain_batch = False
                    continue

                uids_to_remove = []
                for _ in self._time_budget:
                    prompt_responses, gen_responses = batch_generator.next()
                    if not prompt_responses and not gen_responses:
                        break

                    # Progress report for prompt processing
                    for r in prompt_responses:
                        result = batch_results[r.uid]
                        result["rqueue"].put(r.progress)
                        if result["ctx"]._should_stop:
                            uids_to_remove.append(r.uid)

                    # Save the caches at end of segments
                    eos_ids = [
                        r.uid
                        for r in prompt_responses
                        if r.end_of_segment
                        and not r.end_of_prompt
                        and batch_results[r.uid]["segment_types"]
                    ]
                    caches = batch_generator.extract_cache(eos_ids)
                    for uid, (cache, cache_key) in caches.items():
                        self._insert_prompt_cache(
                            self.model_provider.model_key,
                            cache_key[:],
                            cache,
                            cache_type=batch_results[uid]["segment_types"].pop(),
                        )
                    del caches

                    for r in gen_responses:
                        result = batch_results[r.uid]

                        # Don't decode the final stop token
                        if r.finish_reason == "stop":
                            result["detokenizer"].finalize()
                            text = result["detokenizer"].last_segment
                        elif r.finish_reason == "length":
                            result["detokenizer"].add_token(r.token)
                            result["detokenizer"].finalize()
                            text = result["detokenizer"].last_segment
                        else:
                            result["detokenizer"].add_token(r.token)
                            text = result["detokenizer"].last_segment

                        result["rqueue"].put(
                            Response(
                                text,
                                r.token,
                                (
                                    r.logprobs[r.token].item()
                                    if result["want_logprobs"]
                                    else 0.0
                                ),
                                r.finish_reason,
                                _format_top_logprobs(
                                    r.logprobs,
                                    result["top_logprobs"],
                                    current_tokenizer,
                                ),
                            )
                        )

                        if r.finish_reason is not None:
                            result["rqueue"].put(None)
                            self._insert_prompt_cache(
                                current_model_key,
                                r.all_tokens[:],
                                r.prompt_cache,
                                cache_type="assistant",
                            )
                            del batch_results[r.uid]

                        if result["ctx"]._should_stop:
                            uids_to_remove.append(r.uid)

                uids_to_remove = self._share_object(uids_to_remove)
                if uids_to_remove:
                    batch_generator.remove(uids_to_remove)
                    for uid in uids_to_remove:
                        # It may have already been removed during
                        # generation
                        batch_results.pop(uid, None)

    def _serve_single(self, request):
        rqueue, request, args = request

        # Define the progress callback
        def progress(tokens_processed, tokens_total):
            rqueue.put((tokens_processed, tokens_total))

        try:
            # Load the model and tokenizer
            model = self.model_provider.model
            tokenizer = self.model_provider.tokenizer
            draft_model = self.model_provider.draft_model

            # Prepare the prompt and state machine
            prompt, _, _, initial_state = self._tokenize(tokenizer, request, args)
            stop_matcher, text_sm = self._make_state_machine(
                self.model_provider.model_key,
                tokenizer,
                args.stop_words,
            )

            # Start the generation context
            ctx = GenerationContext(
                has_thinking=tokenizer.has_thinking,
                has_tool_calling=tokenizer.has_tool_calling,
                tool_parser=tokenizer.tool_parser,
                text_sm=text_sm,
                initial_state=initial_state,
                prompt=prompt,
            )
            rqueue.put(ctx)

            # Seed if requested
            if args.seed is not None:
                mx.random.seed(args.seed)

            # Make the sampler and logit processor
            sampler = _make_sampler(args, tokenizer)
            logits_processors = _make_logits_processors(args)
            # gen.logprob costs a GPU->CPU readback per token; only the
            # OpenAI `logprobs` field consumes it, so skip when unrequested.
            want_logprobs = bool(args.logprobs or args.top_logprobs > 0)

            # Load the KV cache
            self._log_cache_stats()
            cache, rest = self.prompt_cache.fetch_nearest_cache(
                self.model_provider.model_key, prompt
            )
            ctx.prompt_cache_count = len(prompt) - len(rest)
            cache_key = prompt[:]
            if cache is None:
                cache = make_prompt_cache(self.model_provider.model)
                if self.model_provider.draft_model is not None:
                    cache += make_prompt_cache(self.model_provider.draft_model)

            # Process the prompt and generate tokens
            stop_state = stop_matcher.make_state()
            ngram_draft = getattr(args, "ngram_draft", False)
            for gen in stream_generate(
                model=model,
                tokenizer=tokenizer,
                prompt=rest,
                max_tokens=args.max_tokens,
                sampler=sampler,
                logits_processors=logits_processors,
                prompt_cache=cache,
                draft_model=draft_model,
                # n-gram drafting uses its own depth ceiling (default 12);
                # --num-draft-tokens only governs model-based speculation.
                num_draft_tokens=(
                    self.cli_args.ngram_depth
                    if ngram_draft and hasattr(self.cli_args, "ngram_depth")
                    else args.num_draft_tokens
                ),
                ngram_draft=ngram_draft,
                ngram_window=getattr(args, "ngram_window", 1024),
                prompt_progress_callback=progress,
                prefill_step_size=self.cli_args.prefill_step_size,
                kv_bits=self.cli_args.kv_bits,
                kv_group_size=self.cli_args.kv_group_size,
                quantized_kv_start=self.cli_args.quantized_kv_start,
            ):
                finish_reason = gen.finish_reason

                # Token-level stop word detection
                stop_state, matched = StopSequenceMatcher.match(
                    stop_state, stop_matcher._trie, gen.token
                )
                if matched:
                    finish_reason = "stop"

                rqueue.put(
                    Response(
                        gen.text,
                        gen.token,
                        (
                            0.0
                            if gen.logprobs is None or not want_logprobs
                            else gen.logprobs[gen.token].item()
                        ),
                        finish_reason,
                        ()
                        if gen.logprobs is None
                        else _format_top_logprobs(
                            gen.logprobs, args.top_logprobs, tokenizer
                        ),
                    )
                )
                cache_key.append(gen.token)

                if ctx._should_stop:
                    if self._is_distributed:
                        raise NotImplementedError()
                    break

                if finish_reason is not None:
                    break

            rqueue.put(None)

            # Save the KV cache again
            self._insert_prompt_cache(
                self.model_provider.model_key, cache_key, cache
            )

        except Exception as e:
            rqueue.put(e)

    @staticmethod
    def _seam_extend(tokenizer, prefix, text):
        """Tokens for `text` appended after the token sequence `prefix`.

        BPE merges can cross the boundary (the rendered text would tokenize
        the seam fused). Re-encode the whole text when the round-trip is
        exact so the result stays a strict token prefix of a later rendered
        prompt that replays this continuation; otherwise fall back to a
        naive concatenation.
        """
        fused = tokenizer.encode(
            tokenizer.decode(prefix) + text, add_special_tokens=False
        )
        if fused[: len(prefix)] == prefix:
            return fused
        return prefix + tokenizer.encode(text, add_special_tokens=False)

    def _prefill_tokens(self, model, tokens, keep_logits=False):
        """Prompt-cache-aware prefill of a token sequence.

        Returns (cache, last_logprobs, cached_count): `cache` covers all of
        `tokens` and `cached_count` is how many leading tokens were served
        from the LRU prompt cache. With `keep_logits` the fetch covers all
        but the last token, so the final position is always forwarded and
        its normalized logprobs are returned — they score the first token
        of any teacher-forced continuation.
        """
        if not tokens:
            return make_prompt_cache(model), None, 0
        if keep_logits:
            cache, rest = self.prompt_cache.fetch_nearest_cache(
                self.model_provider.model_key, tokens[:-1]
            )
            cached_count = len(tokens) - 1 - len(rest)
        else:
            cache, rest = self.prompt_cache.fetch_nearest_cache(
                self.model_provider.model_key, tokens
            )
            cached_count = len(tokens) - len(rest)
        if cache is None:
            cache = make_prompt_cache(model)

        # Prefill the uncached remainder exactly like chunked prefill,
        # keeping the last-position logprobs when requested.
        step_size = self.cli_args.prefill_step_size or 2048
        logits = None
        for i in range(cached_count, len(tokens), step_size):
            logits = model(mx.array(tokens[i : i + step_size])[None], cache=cache)
            mx.eval([c.state for c in cache])
        last_logprobs = None
        if logits is not None:
            last_logprobs = logits[:, -1, :] - mx.logsumexp(
                logits[:, -1, :].astype(mx.float32), axis=-1, keepdims=True
            )
            mx.eval(last_logprobs)
            del logits
        return cache, last_logprobs, cached_count

    def _score_continuations(self, model, tokenizer, cache, last_logprobs, texts):
        """Teacher-forced total logprob of each text against `cache`.

        `last_logprobs` are the normalized logprobs at the last prefilled
        position and score each continuation's first token; the rest are
        forwarded on a fresh deepcopy per continuation so the shared cache
        is never mutated by the appends. Returns one dict per text with the
        token list and total `logprob` (None when the text encodes to no
        tokens).
        """
        results = []
        for text in texts:
            cand = tokenizer.encode(text, add_special_tokens=False)
            if not cand:
                results.append({"text": text, "tokens": [], "logprob": None})
                continue
            c_cache = copy.deepcopy(cache)
            score = last_logprobs[0, cand[0]]
            if len(cand) > 1:
                inp = mx.array(cand[:-1])[None]
                cand_logits = model(inp, cache=c_cache)
                log_probs = cand_logits.astype(mx.float32) - mx.logsumexp(
                    cand_logits.astype(mx.float32), axis=-1, keepdims=True
                )
                targets = mx.array(cand[1:])[None, :, mx.newaxis]
                score = score + mx.take_along_axis(
                    log_probs, targets, axis=-1
                ).sum()
            mx.eval(score)
            del c_cache
            results.append(
                {"text": text, "tokens": cand, "logprob": float(score.item())}
            )
        return results

    def _commit_continuation(
        self, model, tokenizer, prompt, committed_text, base_cache
    ):
        """Teacher-force `committed_text` + <|im_end|> onto a deepcopy of
        `base_cache` (which must cover exactly `prompt`) and store it in the
        prompt cache, so a follow-up request that replays this step as an
        assistant turn starts from a strict-prefix cache hit instead of
        re-prefilling. Returns the committed token key."""
        step_size = self.cli_args.prefill_step_size or 2048
        # Tokenize the continuation in context so the committed key stays a
        # strict token prefix of the replayed turn.
        fused = tokenizer.encode(
            tokenizer.decode(prompt) + committed_text + "<|im_end|>",
            add_special_tokens=False,
        )
        if fused[: len(prompt)] == prompt:
            commit_tokens = fused[len(prompt) :]
            commit_cache = copy.deepcopy(base_cache)
            for i in range(0, len(commit_tokens), step_size):
                model(
                    mx.array(commit_tokens[i : i + step_size])[None],
                    cache=commit_cache,
                )
            mx.eval([c.state for c in commit_cache])
            cache_key = prompt + commit_tokens
        else:
            # BPE merged across the prompt/continuation boundary: the replayed
            # turn tokenizes as `fused`, so a key built from
            # prompt+encode(continuation) would never be hit. Rotating caches
            # can't rewind, so rebuild the state by prefilling `fused` fresh —
            # a bounded one-off cost paid only on seam merges.
            commit_cache = make_prompt_cache(model)
            for i in range(0, len(fused), step_size):
                model(mx.array(fused[i : i + step_size])[None], cache=commit_cache)
            mx.eval([c.state for c in commit_cache])
            cache_key = fused
        self._insert_prompt_cache(
            self.model_provider.model_key, cache_key, commit_cache
        )
        del commit_cache
        return cache_key

    def _serve_score(self, request):
        """Teacher-forced logprob scoring of candidate continuations.

        Prefills the prompt once (reusing the LRU prompt cache for the
        shared prefix), then scores each candidate against a deepcopy of
        the prefilled cache — the parallel-constrained-decision pattern,
        so hosts can pick an action by calibrated argmax instead of
        autoregressive JSON generation.
        """
        rqueue, request, args = request
        try:
            model = self.model_provider.model
            tokenizer = self.model_provider.tokenizer
            model_key = self.model_provider.model_key

            prompt, _, _, _ = self._tokenize(tokenizer, request, args)
            if request.prompt_suffix:
                prompt = self._seam_extend(
                    tokenizer, prompt, request.prompt_suffix
                )
            self._check_prompt_tokens(prompt)
            if not prompt:
                rqueue.put(ValueError("score request has an empty prompt"))
                return

            self._log_cache_stats()
            cache, last_logprobs, prompt_cache_count = self._prefill_tokens(
                model, prompt, keep_logits=True
            )

            results = []
            for r in self._score_continuations(
                model, tokenizer, cache, last_logprobs, request.candidates
            ):
                total = r["logprob"]
                results.append(
                    {
                        "index": len(results),
                        "text": r["text"],
                        "logprob": total,
                        "avgLogprob": (
                            None if total is None else total / len(r["tokens"])
                        ),
                        "tokens": len(r["tokens"]),
                    }
                )

            self._insert_prompt_cache(model_key, prompt, cache)

            # Optionally commit the winning continuation under
            # prompt+candidate+eos so a follow-up request that replays this
            # step as an assistant turn starts from a strict-prefix cache hit
            # instead of re-prefilling.
            committed_index = None
            committed_text = None
            if request.commit:
                valid = [r for r in results if r["avgLogprob"] is not None]
                if valid:
                    best = max(valid, key=lambda r: r["avgLogprob"])
                    committed_index = best["index"]
                    committed_text = request.candidates[committed_index]
                    self._commit_continuation(
                        model, tokenizer, prompt, committed_text, cache
                    )

            rqueue.put(
                {
                    "schema": "hemlock.score.v1",
                    "promptTokens": len(prompt),
                    "cachedTokens": prompt_cache_count,
                    "candidates": results,
                    "committedIndex": committed_index,
                    "committedText": committed_text,
                }
            )
            rqueue.put(None)
        except Exception as e:
            rqueue.put(e)

    def _serve_decide(self, request):
        """Kev-style packed decision request.

        The state is prefilled once on top of the (prompt-cache aware) base
        prompt. Each question then forks the state cache, appends a
        ``\\n<q> {instructions}\\n<opt> {key}: {desc}…\\n<decide>`` block and
        teacher-forces every option's label — first token from the
        decide-position logits, the rest forwarded on a per-option
        deepcopy. Questions never see each other: isolation is by cache
        fork, not attention mask, which also suits Maple's rotating
        (untrimmable) KV cache.
        """
        rqueue, request, args = request
        try:
            started = time.time()
            model = self.model_provider.model
            tokenizer = self.model_provider.tokenizer
            model_key = self.model_provider.model_key

            prompt, _, _, _ = self._tokenize(tokenizer, request, args)
            if request.prompt_suffix:
                prompt = self._seam_extend(
                    tokenizer, prompt, request.prompt_suffix
                )
            if not prompt:
                rqueue.put(ValueError("decide request has an empty prompt"))
                return

            state_text = _serialize_state(request.state)
            state_seq = (
                self._seam_extend(tokenizer, prompt, state_text)
                if state_text
                else list(prompt)
            )
            self._check_prompt_tokens(state_seq, "decide state")

            self._log_cache_stats()
            state_cache, rest = self.prompt_cache.fetch_nearest_cache(
                model_key, state_seq
            )
            state_cached = len(state_seq) - len(rest)
            if state_cache is None:
                state_cache = make_prompt_cache(model)

            step_size = self.cli_args.prefill_step_size or 2048
            # Feed the uncached tail, pausing at the prompt/state boundary
            # to snapshot a prompt-level cache (it backs the `prompt` LRU
            # entry and the optional commit). A prefix hit landing inside
            # the state region can't be rewound to the boundary — rotating
            # caches only ever feed forward.
            prompt_snapshot = None
            boundaries = (
                (state_cached, len(prompt), len(state_seq))
                if state_cached <= len(prompt)
                else (state_cached, len(state_seq))
            )
            for a, b in zip(boundaries, boundaries[1:]):
                for i in range(a, b, step_size):
                    # Clamp to the stage end so the prompt-level snapshot
                    # covers exactly `prompt`, never a token of state.
                    model(
                        mx.array(state_seq[i : min(i + step_size, b)])[None],
                        cache=state_cache,
                    )
                    mx.eval([c.state for c in state_cache])
                if b == len(prompt):
                    prompt_snapshot = copy.deepcopy(state_cache)
                    self._insert_prompt_cache(
                        model_key, prompt, prompt_snapshot
                    )
            self._insert_prompt_cache(model_key, state_seq, state_cache)

            answers = {}
            probs_by_qid = {}
            decision_tokens = 0
            for qid, q in request.questions.items():
                block = f"\n<q> {q['instructions']}"
                for opt in q["options"]:
                    block += f"\n<opt> {opt['key']}: {opt['desc']}"
                block += "\n<decide>"
                q_tokens = self._seam_extend(tokenizer, state_seq, block)[
                    len(state_seq) :
                ]

                q_cache = copy.deepcopy(state_cache)
                logits = None
                for i in range(0, len(q_tokens), step_size):
                    logits = model(
                        mx.array(q_tokens[i : i + step_size])[None],
                        cache=q_cache,
                    )
                    mx.eval([c.state for c in q_cache])
                decision_tokens += len(q_tokens)
                last_logprobs = logits[:, -1, :] - mx.logsumexp(
                    logits[:, -1, :].astype(mx.float32), axis=-1, keepdims=True
                )
                mx.eval(last_logprobs)
                del logits

                scored = self._score_continuations(
                    model,
                    tokenizer,
                    q_cache,
                    last_logprobs,
                    [o["label"] for o in q["options"]],
                )
                del q_cache
                # Forwarded tokens only: each option's first token is scored
                # from the decide-position logits.
                decision_tokens += sum(
                    max(0, len(s["tokens"]) - 1) for s in scored
                )
                logprobs = [s["logprob"] for s in scored]
                if any(lp is None for lp in logprobs):
                    raise ValueError(
                        f"question {qid!r} has an option label that encodes "
                        "to no tokens"
                    )
                top = max(logprobs)
                exps = [math.exp(lp - top) for lp in logprobs]
                norm = sum(exps)
                probs = [e / norm for e in exps]
                probs_by_qid[qid] = probs
                answers[qid] = _decide_answer(q, probs, logprobs)

            committed_question = None
            committed_key = None
            committed_text = None
            if request.commit:
                cq = request.commit_question
                opts = request.questions[cq]["options"]
                probs = probs_by_qid[cq]
                win = max(range(len(opts)), key=lambda i: probs[i])
                committed_question = cq
                committed_key = opts[win]["key"]
                committed_text = opts[win]["continuation"]
                base_cache = prompt_snapshot
                if base_cache is None:
                    # The prefix hit landed inside the state region — build
                    # a fresh prompt-level cache for the commit base.
                    base_cache, _, _ = self._prefill_tokens(model, prompt)
                cache_key = self._commit_continuation(
                    model, tokenizer, prompt, committed_text, base_cache
                )
                decision_tokens += len(cache_key) - len(prompt)

            rqueue.put(
                {
                    "schema": "hemlock.decide.v1",
                    "answers": answers,
                    "usage": {
                        "promptTokens": len(state_seq),
                        "cachedTokens": state_cached,
                        "decisionTokens": decision_tokens,
                    },
                    "committedQuestion": committed_question,
                    "committedKey": committed_key,
                    "committedText": committed_text,
                    "latencyMs": int(round((time.time() - started) * 1000)),
                }
            )
            rqueue.put(None)
        except Exception as e:
            rqueue.put(e)

    def generate(
        self,
        request: CompletionRequest,
        generation_args: GenerationArguments,
        progress_callback: Optional[Callable[[int, int], None]] = None,
    ):
        response_queue = Queue()
        self.requests.put((response_queue, request, generation_args))

        def _inner():
            while True:
                response = response_queue.get()
                if response is None:
                    break
                if isinstance(response, Exception):
                    raise response
                if isinstance(response, tuple):
                    if progress_callback is not None:
                        progress_callback(*response)
                    continue
                yield response

        ctx = response_queue.get()
        if isinstance(ctx, Exception):
            raise ctx

        return ctx, _inner()

    @property
    def cli_args(self):
        return self.model_provider.cli_args


class APIHandler(BaseHTTPRequestHandler):
    def __init__(
        self,
        response_generator: ResponseGenerator,
        *args,
        system_fingerprint: Optional[str] = None,
        **kwargs,
    ):
        """
        Create static request specific metadata
        """
        self.created = int(time.time())
        self.response_generator = response_generator
        self.system_fingerprint = system_fingerprint or get_system_fingerprint()
        super().__init__(*args, **kwargs)

    def _set_cors_headers(self):
        allowed_origins = self.response_generator.cli_args.allowed_origins
        origin = self.headers.get("Origin")
        if "*" in allowed_origins:
            self.send_header("Access-Control-Allow-Origin", "*")
        elif origin in allowed_origins:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "*")
        self.send_header("Access-Control-Allow-Headers", "*")

    def _respond_error(self, status_code: int, message: str):
        """Send a JSON error body for a request that fails validation."""
        self._set_completion_headers(status_code)
        self.end_headers()
        self.wfile.write(json.dumps({"error": message}).encode())

    def _set_completion_headers(self, status_code: int = 200):
        self.send_response(status_code)
        self.send_header("Content-type", "application/json")
        self._set_cors_headers()

    def _set_stream_headers(self, status_code: int = 200):
        self.send_response(status_code)
        self.send_header("Content-type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self._set_cors_headers()

    def do_OPTIONS(self):
        self._set_completion_headers(204)
        self.end_headers()

    def do_POST(self):
        """
        Respond to a POST request from a client.
        """
        request_factories = {
            "/v1/completions": self.handle_text_completions,
            "/v1/chat/completions": self.handle_chat_completions,
            "/chat/completions": self.handle_chat_completions,
            "/v1/score": self.handle_score_request,
            "/v1/decide": self.handle_decide_request,
        }

        if self.path not in request_factories:
            self._set_completion_headers(404)
            self.end_headers()
            self.wfile.write(b"Not Found")
            return

        # Fetch and parse request body
        content_length = self.headers.get("Content-Length")
        if content_length is None:
            self._set_completion_headers(411)
            self.end_headers()
            self.wfile.write(
                json.dumps({"error": "Content-Length header is required"}).encode()
            )
            return
        try:
            content_length = int(content_length)
        except ValueError:
            self._respond_error(400, "Invalid Content-Length header")
            return
        if content_length < 0:
            self._respond_error(400, "Invalid Content-Length header")
            return
        if content_length > _MAX_REQUEST_BODY_BYTES:
            self._respond_error(
                413,
                f"Request body exceeds the {_MAX_REQUEST_BODY_BYTES}-byte limit",
            )
            return
        raw_body = self.rfile.read(content_length)
        try:
            self.body = json.loads(raw_body.decode("utf-8"))
        except UnicodeDecodeError as e:
            logging.error(f"UnicodeDecodeError: {e}")
            self._respond_error(400, f"Request body is not valid UTF-8: {e}")
            return
        except json.JSONDecodeError as e:
            logging.error(f"JSONDecodeError: {e} - Raw body: {raw_body[:200]!r}")
            self._respond_error(400, f"Invalid JSON in request body: {e}")
            return

        if logging.getLogger().isEnabledFor(logging.DEBUG):
            debug_body = json.dumps(self.body, indent="\t")
            logging.debug(f"Incoming Request Body: {debug_body}")
        if not isinstance(self.body, dict):
            debug_body = json.dumps(self.body, indent="\t")
            logging.error(f"Invalid Request Body: {debug_body}")
            self._set_completion_headers(400)
            self.end_headers()
            self.wfile.write(
                json.dumps({"error": "Request should be a JSON dictionary"}).encode()
            )
            return

        # Extract request parameters from the body
        self.stream = self.body.get("stream", False)
        self.stream_options = self.body.get("stream_options", None)
        self.requested_model = self.body.get("model", "default_model")
        self.requested_draft_model = self.body.get("draft_model", "default_model")
        self.num_draft_tokens = self.body.get(
            "num_draft_tokens", self.response_generator.cli_args.num_draft_tokens
        )
        self.ngram_draft = self.body.get(
            "ngram_draft",
            self.response_generator.cli_args.ngram_draft
            if hasattr(self.response_generator.cli_args, "ngram_draft")
            else False,
        )
        try:
            self.ngram_window = int(
                self.body.get(
                    "ngram_window",
                    self.response_generator.cli_args.ngram_window
                    if hasattr(self.response_generator.cli_args, "ngram_window")
                    else 1024,
                )
            )
        except (TypeError, ValueError):
            self._respond_error(400, "'ngram_window' must be an integer")
            return
        self.adapter = self.body.get("adapters", None)
        self.max_tokens = self.body.get("max_completion_tokens", None)
        if self.max_tokens is None:
            self.max_tokens = self.body.get(
                "max_tokens", self.response_generator.cli_args.max_tokens
            )
        self.temperature = self.body.get(
            "temperature", self.response_generator.cli_args.temp
        )
        self.top_p = self.body.get("top_p", self.response_generator.cli_args.top_p)
        self.top_k = self.body.get("top_k", self.response_generator.cli_args.top_k)
        self.min_p = self.body.get("min_p", self.response_generator.cli_args.min_p)
        self.repetition_penalty = self.body.get("repetition_penalty", 0.0)
        self.repetition_context_size = self.body.get("repetition_context_size", 20)
        self.presence_penalty = self.body.get("presence_penalty", 0.0)
        self.presence_context_size = self.body.get("presence_context_size", 20)
        self.frequency_penalty = self.body.get("frequency_penalty", 0.0)
        self.frequency_context_size = self.body.get("frequency_context_size", 20)
        self.xtc_probability = self.body.get("xtc_probability", 0.0)
        self.xtc_threshold = self.body.get("xtc_threshold", 0.0)
        self.logit_bias = self.body.get("logit_bias", None)
        self.logprobs = self.body.get("logprobs", False)
        self.top_logprobs = self.body.get("top_logprobs", -1)
        self.seed = self.body.get("seed", None)
        self.chat_template_kwargs = self.body.get("chat_template_kwargs")
        try:
            self.validate_model_parameters()
        except (TypeError, ValueError) as e:
            self._respond_error(400, str(e))
            return
        if self.stream_options is not None and not isinstance(
            self.stream_options, dict
        ):
            self._respond_error(400, "'stream_options' must be an object")
            return
        if self.chat_template_kwargs is not None and not isinstance(
            self.chat_template_kwargs, dict
        ):
            self._respond_error(400, "'chat_template_kwargs' must be an object")
            return

        # Get stop sequences
        stop_words = self.body.get("stop")
        stop_words = stop_words or []
        stop_words = [stop_words] if isinstance(stop_words, str) else stop_words
        if not isinstance(stop_words, list) or not all(
            isinstance(word, str) for word in stop_words
        ):
            self._respond_error(400, "'stop' must be a string or a list of strings")
            return

        # Create the completion request
        try:
            request = request_factories[self.path]()
        except (AssertionError, TypeError, ValueError) as e:
            self._respond_error(400, str(e))
            return
        # Score and decide requests share the same single-shot JSON
        # response path.
        try:
            if request.candidates is not None or request.questions is not None:
                self.handle_score(request, stop_words)
            else:
                self.handle_completion(request, stop_words)
        except (BrokenPipeError, ConnectionResetError):
            raise  # the client left; there is no error response to send
        except Exception as e:
            # Last-resort honesty: an unexpected failure must still produce a
            # 5xx JSON body when the response headers have not been committed.
            logging.error(f"Unhandled request failure: {e}", exc_info=True)
            if getattr(self, "_headers_buffer", None):
                try:
                    # Drop any staged status line before writing the real one.
                    self._headers_buffer.clear()
                    self._set_completion_headers(500)
                    self.end_headers()
                    self.wfile.write(
                        json.dumps({"error": f"Internal server error: {e}"}).encode()
                    )
                except (BrokenPipeError, ConnectionResetError, OSError):
                    pass

    @staticmethod
    def _valid_messages(messages) -> bool:
        """A chat `messages` payload the chat template can actually consume:
        a non-empty list of objects, each carrying a string role."""
        return (
            isinstance(messages, list)
            and len(messages) > 0
            and all(
                isinstance(message, dict) and isinstance(message.get("role"), str)
                for message in messages
            )
        )

    def _validate(
        self,
        name,
        expected_type,
        min_val=None,
        max_val=None,
        optional=False,
        whitelist=None,
    ):
        value = getattr(self, name)
        if optional and value is None:
            return
        # bool is a subclass of int — JSON true/false is not a number here.
        if isinstance(value, bool) and expected_type != bool:
            try:
                allowed = tuple(et.__name__ for et in expected_type)
            except TypeError:
                allowed = expected_type.__name__
            raise ValueError(f"{name} must be of type {allowed}")
        if not isinstance(value, expected_type):
            try:
                allowed = tuple(et.__name__ for et in expected_type)
            except TypeError:
                allowed = expected_type.__name__
            raise ValueError(f"{name} must be of type {allowed}")
        # JSON parses NaN/Infinity literals into floats; neither is a sane
        # sampling parameter and both pass < / > comparisons silently.
        if isinstance(value, (int, float)) and not math.isfinite(value):
            raise ValueError(f"{name} must be a finite number")
        if whitelist is not None and value in whitelist:
            return
        if min_val is not None and value < min_val:
            raise ValueError(f"{name} must be at least {min_val}")
        if max_val is not None and value > max_val:
            raise ValueError(f"{name} must be at most {max_val}")

    def validate_model_parameters(self):
        """Validate that the passed model parameters have correct types and values."""
        self._validate("stream", bool)
        self._validate("ngram_draft", bool)
        self._validate("max_tokens", int, min_val=0, max_val=_MAX_TOKENS_LIMIT)
        self._validate("temperature", (float, int), min_val=0)
        self._validate("top_p", (float, int), min_val=0, max_val=1)
        self._validate("top_k", int, min_val=0)
        self._validate("min_p", (float, int), min_val=0, max_val=1)
        self._validate("num_draft_tokens", int, min_val=0)
        self._validate("repetition_penalty", (float, int), min_val=0)
        self._validate("repetition_context_size", int, min_val=0)
        self._validate("presence_penalty", (float, int))
        self._validate("presence_context_size", int, min_val=0)
        self._validate("frequency_penalty", (float, int))
        self._validate("frequency_context_size", int, min_val=0)
        self._validate("logprobs", bool)
        self._validate("top_logprobs", int, min_val=0, max_val=11, whitelist=[-1])
        self._validate("xtc_probability", float, min_val=0, max_val=1)
        self._validate("xtc_threshold", float, min_val=0, max_val=1)
        self._validate("requested_model", str)
        self._validate("adapter", str, optional=True)
        self._validate("seed", int, optional=True)
        self._validate("logit_bias", dict, optional=True)

        if self.logit_bias is not None:
            try:
                self.logit_bias = {int(k): float(v) for k, v in self.logit_bias.items()}
            except (TypeError, ValueError):
                raise ValueError("logit_bias must be a dict of int to float")
            if not all(math.isfinite(v) for v in self.logit_bias.values()):
                raise ValueError("logit_bias values must be finite numbers")

    def generate_response(
        self,
        text: str,
        finish_reason: Union[Literal["length", "stop"], None],
        prompt_token_count: Optional[int] = None,
        completion_token_count: Optional[int] = None,
        prompt_cache_count: Optional[int] = None,
        token_logprobs: Optional[List[float]] = None,
        top_tokens: Optional[List[Tuple[Dict[str, Any]]]] = None,
        tokens: Optional[List[int]] = None,
        tool_calls: Optional[List[str]] = None,
        reasoning_text: Optional[str] = None,
    ) -> dict:
        """
        Generate a single response packet based on response type (stream or
        not), completion type and parameters.

        Args:
            text (str): Text generated by model
            finish_reason (Union[Literal["length", "stop"], None]): The reason the
              response is being sent: "length", "stop" or `None`.
            prompt_token_count (Optional[int]): The number of tokens in the prompt,
              used to populate the "usage" field (not used when stream).
            completion_token_count (Optional[int]): The number of tokens in the
              response, used to populate the "usage" field (not used when stream).
            prompt_cache_count (Optional[int]): The portion of prompt_token_count
              that was found in the cache when servicing the request.
            token_logprobs (Optional[List[float]]): The log probabilities per token,
              in token order.
            top_tokens (Optional[List[Tuple[Dict[str, Any]]]]): List of outputs from
              _format_top_logprobs, giving info on the top N tokens at each token position.
            tokens (Optional[List[int]]): List of tokens to return with logprobs structure
            tool_calls (Optional[List[str]]): List of tool calls.
            reasoning_text (Optional[str]): The reasoning text generated by the model.

        Returns:
            dict: A dictionary containing the response, in the same format as
              OpenAI's API.
        """
        token_logprobs = token_logprobs or []
        top_logprobs = top_tokens or []
        tool_calls = tool_calls or []

        # Static response
        response = {
            "id": self.request_id,
            "system_fingerprint": self.system_fingerprint,
            "object": self.object_type,
            "model": self.requested_model,
            "created": self.created,
            "choices": [
                {
                    "index": 0,
                    "finish_reason": finish_reason,
                },
            ],
        }

        if top_logprobs:
            response["choices"][0]["logprobs"] = {
                "content": [
                    dict(i[0], top_logprobs=i) if i else {} for i in top_logprobs
                ]
            }
        elif token_logprobs:
            response["choices"][0]["logprobs"] = {
                "content": [
                    dict(id=i, logprob=g) for i, g in zip(tokens, token_logprobs)
                ]
            }

        if not self.stream:
            if not (
                isinstance(prompt_token_count, int)
                and isinstance(completion_token_count, int)
            ):
                raise ValueError(
                    "Response type is complete, but token counts not provided"
                )

            response["usage"] = {
                "prompt_tokens": prompt_token_count,
                "completion_tokens": completion_token_count,
                "total_tokens": prompt_token_count + completion_token_count,
            }
            if prompt_cache_count is not None and prompt_cache_count >= 0:
                response["usage"]["prompt_tokens_details"] = {
                    "cached_tokens": prompt_cache_count,
                }

        choice = response["choices"][0]

        # Add dynamic response
        if self.object_type.startswith("chat.completion"):
            key_name = "delta" if self.stream else "message"
            choice[key_name] = {"role": "assistant"}
            if text:
                choice[key_name]["content"] = text
            if reasoning_text:
                choice[key_name]["reasoning"] = reasoning_text
            if tool_calls:
                choice[key_name]["tool_calls"] = tool_calls
        elif self.object_type == "text_completion":
            choice.update(text=text)
        else:
            raise ValueError(f"Unsupported response type: {self.object_type}")

        return response

    def handle_completion(self, request: CompletionRequest, stop_words: List[str]):
        """
        Generate a response to a prompt and send it to the client in a single batch.

        Args:
            prompt (List[int]): The tokenized prompt.
            stop_words (List[str]): A list of stop words
        """
        args = GenerationArguments(
            model=ModelDescription(
                model=self.requested_model,
                draft=self.requested_draft_model,
                adapter=self.adapter,
            ),
            sampling=SamplingArguments(
                temperature=self.temperature,
                top_p=self.top_p,
                top_k=self.top_k,
                min_p=self.min_p,
                xtc_probability=self.xtc_probability,
                xtc_threshold=self.xtc_threshold,
            ),
            logits=LogitsProcessorArguments(
                logit_bias=self.logit_bias,
                repetition_penalty=self.repetition_penalty,
                repetition_context_size=self.repetition_context_size,
                presence_penalty=self.presence_penalty,
                presence_context_size=self.presence_context_size,
                frequency_penalty=self.frequency_penalty,
                frequency_context_size=self.frequency_context_size,
            ),
            stop_words=stop_words,
            max_tokens=self.max_tokens,
            num_draft_tokens=self.num_draft_tokens,
            logprobs=self.logprobs,
            top_logprobs=self.top_logprobs,
            seed=self.seed,
            chat_template_kwargs=self.chat_template_kwargs,
            ngram_draft=bool(self.ngram_draft),
            ngram_window=int(self.ngram_window),
        )

        # Keep connection allive during long prompt processing (and also log
        # the progress)
        def keepalive_callback(processed, total):
            logging.info(f"Prompt processing progress: {processed}/{total}")
            if self.stream:
                msg = f": keepalive {processed}/{total}\n\n".encode()
                self.wfile.write(msg)
                self.wfile.flush()

        # Create the token generator
        try:
            ctx, response = self.response_generator.generate(
                request,
                args,
                progress_callback=keepalive_callback,
            )
        except Exception as e:
            # Request-shape problems (e.g. an oversized assistant_prefix
            # caught in _tokenize) are 400s; load failures stay 404s.
            self._set_completion_headers(
                400 if isinstance(e, ValueError) else 404
            )
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode())
            return

        # Prepare the headers
        if self.stream:
            self._set_stream_headers(200)
            self.end_headers()
            logging.debug("Starting stream:")
        else:
            self._set_completion_headers(200)
            logging.debug("Starting completion:")

        # Tool call formatter
        tool_formatter = ToolCallFormatter(ctx.tool_parser, request.tools, self.stream)

        # Initialize the text state machine
        sm_state = ctx.text_sm.make_state(ctx.initial_state)

        # Variables to save the generated text, tokens, logprobs, tools etc
        prev_state = ctx.initial_state
        finish_reason = "stop"
        reasoning_text = ""
        made_tool_call = False
        tool_text = ""
        tool_calls = []
        # The assistant prefix was already committed to the prompt; echo it
        # back so `content` shows the complete assistant turn (streaming
        # emits it with the first chunk, non-streaming in the message).
        text = request.assistant_prefix or ""
        tokens = []
        token_logprobs = []
        top_tokens = []

        try:
            for gen in response:
                logging.debug(gen.text)

                # Advance the text state machine to strip control sequences
                if gen.finish_reason == "stop":
                    sm_state, current_state = TextStateMachine.discard(sm_state)
                    clean_text = ""
                elif gen.finish_reason == "length":
                    sm_state, clean_text, current_state = TextStateMachine.step(
                        sm_state, gen.text
                    )
                    sm_state, flushed, current_state = TextStateMachine.flush(sm_state)
                    clean_text += flushed
                else:
                    sm_state, clean_text, current_state = TextStateMachine.step(
                        sm_state, gen.text
                    )

                # Collect the clean text by state: reasoning, tool, or normal
                if current_state == "reasoning":
                    reasoning_text += clean_text
                elif current_state == "tool":
                    tool_text += clean_text
                elif current_state == "normal":
                    if prev_state == "tool":
                        tool_calls.append(tool_text)
                        tool_text = ""
                        made_tool_call = True
                    text += clean_text

                # Add the tokens and logprobs to the vars.
                tokens.append(gen.token)
                if args.logprobs:
                    token_logprobs.append(gen.logprob)
                if args.top_logprobs > 0:
                    top_tokens.append(gen.top_tokens)

                if (
                    self.stream
                    and current_state != "tool"
                    and (text or tool_calls or reasoning_text)
                ):
                    resp = self.generate_response(
                        text,
                        None,
                        tool_calls=tool_formatter(tool_calls),
                        reasoning_text=reasoning_text,
                    )
                    self.wfile.write(f"data: {json.dumps(resp)}\n\n".encode())
                    self.wfile.flush()
                    reasoning_text = ""
                    text = ""
                    tool_calls = []

                if gen.finish_reason is not None:
                    finish_reason = gen.finish_reason

                prev_state = current_state

            if prev_state == "tool" and tool_text:
                tool_calls.append(tool_text)
                made_tool_call = True

            if finish_reason == "stop" and made_tool_call:
                finish_reason = "tool_calls"

            if self.stream:
                resp = self.generate_response(
                    text,
                    finish_reason,
                    tool_calls=tool_formatter(tool_calls),
                    reasoning_text=reasoning_text,
                )
                self.wfile.write(f"data: {json.dumps(resp)}\n\n".encode())
                self.wfile.flush()
                if (
                    self.stream_options is not None
                    and self.stream_options["include_usage"]
                ):
                    resp = self.completion_usage_response(
                        len(ctx.prompt),
                        len(tokens),
                        ctx.prompt_cache_count,
                    )
                    self.wfile.write(f"data: {json.dumps(resp)}\n\n".encode())
                    self.wfile.flush()
                self.wfile.write("data: [DONE]\n\n".encode())
                self.wfile.flush()
            else:
                resp = self.generate_response(
                    text,
                    finish_reason,
                    len(ctx.prompt),
                    len(tokens),
                    ctx.prompt_cache_count,
                    token_logprobs=token_logprobs,
                    top_tokens=top_tokens,
                    tokens=tokens,
                    reasoning_text=reasoning_text,
                    tool_calls=tool_formatter(tool_calls),
                )
                if logging.getLogger().isEnabledFor(logging.DEBUG):
                    response_debug = json.dumps(resp, indent="\t")
                    logging.debug(f"Outgoing Response: {response_debug}")

                response_json = json.dumps(resp).encode()
                self.send_header("Content-Length", str(len(response_json)))
                self.end_headers()
                self.wfile.write(response_json)
                self.wfile.flush()
        finally:
            ctx.stop()

    def completion_usage_response(
        self,
        prompt_token_count: Optional[int] = None,
        completion_token_count: Optional[int] = None,
        prompt_cache_count: Optional[int] = None,
    ):
        response = {
            "id": self.request_id,
            "system_fingerprint": self.system_fingerprint,
            "object": "chat.completion",
            "model": self.requested_model,
            "created": self.created,
            "choices": [],
            "usage": {
                "prompt_tokens": prompt_token_count,
                "completion_tokens": completion_token_count,
                "total_tokens": prompt_token_count + completion_token_count,
            },
        }
        if prompt_cache_count is not None and prompt_cache_count >= 0:
            response["usage"]["prompt_tokens_details"] = {
                "cached_tokens": prompt_cache_count,
            }
        return response

    def handle_chat_completions(self) -> CompletionRequest:
        """
        Handle a chat completion request.

        Returns:
            mx.array: A mx.array of the tokenized prompt from the request body
        """
        body = self.body
        assert "messages" in body, "Request did not contain messages"
        if not self._valid_messages(body["messages"]):
            raise ValueError(
                "'messages' must be a non-empty list of objects, "
                "each with a string 'role'"
            )

        assistant_prefix = body.get("assistant_prefix")
        if assistant_prefix is not None:
            if not isinstance(assistant_prefix, str):
                raise ValueError("'assistant_prefix' must be a string")
            # Cheap early 400 when the tokenizer is already loaded; the
            # same bound is re-checked in _tokenize regardless.
            tokenizer = getattr(
                self.response_generator.model_provider, "tokenizer", None
            )
            if tokenizer is not None:
                n_prefix = len(
                    tokenizer.encode(assistant_prefix, add_special_tokens=False)
                )
                if n_prefix > _ASSISTANT_PREFIX_MAX_TOKENS:
                    raise ValueError(
                        f"'assistant_prefix' encodes to {n_prefix} tokens; "
                        f"the maximum is {_ASSISTANT_PREFIX_MAX_TOKENS}"
                    )

        # Determine response type
        self.request_id = f"chatcmpl-{uuid.uuid4()}"
        self.object_type = "chat.completion.chunk" if self.stream else "chat.completion"

        return CompletionRequest(
            "chat",
            "",
            body["messages"],
            body.get("tools") or None,
            body.get("role_mapping"),
            assistant_prefix=assistant_prefix,
        )

    def handle_score_request(self) -> CompletionRequest:
        """
        Build a scoring request: a chat/text prompt plus candidate
        continuations whose conditional logprobs are compared host-side.
        """
        body = self.body
        if body.get("assistant_prefix") is not None:
            raise ValueError(
                "'assistant_prefix' is only supported on /v1/chat/completions"
            )
        candidates = body.get("candidates")
        if (
            not isinstance(candidates, list)
            or not candidates
            or len(candidates) > 256
            or not all(isinstance(c, str) for c in candidates)
        ):
            raise ValueError(
                "score requests need a non-empty 'candidates' list of strings (max 256)"
            )
        # A score with no state to score against is a client error, not a
        # generation job — fail fast instead of prefilling an empty prompt.
        if "prompt" in body and not isinstance(body["prompt"], str):
            raise ValueError("'prompt' must be a string")
        if "messages" in body and not self._valid_messages(body["messages"]):
            raise ValueError(
                "'messages' must be a non-empty list of objects, "
                "each with a string 'role'"
            )
        if not body.get("prompt") and not body.get("messages"):
            raise ValueError(
                "score requests need a non-empty 'prompt' or 'messages' state"
            )
        self.request_id = f"score-{uuid.uuid4()}"
        self.object_type = "score.result"
        request = CompletionRequest(
            "chat" if "messages" in body else "text",
            body.get("prompt", ""),
            body.get("messages") or [],
            None,
            body.get("role_mapping"),
            body.get("prompt_suffix"),
            candidates,
            bool(body.get("commit")),
        )
        return request

    def handle_decide_request(self) -> CompletionRequest:
        """Build a kev-style packed decision request: a `state` plus a set
        of typed `questions` answered by teacher-forced option-label
        scoring on forks of the prefilled state cache."""
        body = self.body
        if body.get("assistant_prefix") is not None:
            raise ValueError(
                "'assistant_prefix' is only supported on /v1/chat/completions"
            )
        questions = body.get("questions")
        if not isinstance(questions, dict) or not questions:
            raise ValueError(
                "decide requests need a non-empty 'questions' object"
            )
        if len(questions) > _DECIDE_MAX_QUESTIONS:
            raise ValueError(
                f"decide requests support at most {_DECIDE_MAX_QUESTIONS} "
                "questions"
            )
        normalized = {}
        for qid, spec in questions.items():
            normalized[str(qid)] = _parse_decide_question(qid, spec)

        state = body.get("state", "")
        if not isinstance(state, (str, dict, list)):
            raise ValueError("'state' must be a string, object, or array")
        if "prompt" in body and not isinstance(body["prompt"], str):
            raise ValueError("'prompt' must be a string")
        if "messages" in body and not self._valid_messages(body["messages"]):
            raise ValueError(
                "'messages' must be a non-empty list of objects, "
                "each with a string 'role'"
            )

        commit = bool(body.get("commit"))
        commit_question = body.get("commitQuestion", body.get("commit_question"))
        if commit_question is not None:
            commit_question = str(commit_question)
            if commit_question not in normalized:
                raise ValueError("'commitQuestion' must name a question")
            commit = True
        elif commit:
            raise ValueError("'commit' requires a 'commitQuestion'")

        self.request_id = f"decide-{uuid.uuid4()}"
        self.object_type = "decide.result"
        return CompletionRequest(
            "chat" if "messages" in body else "text",
            body.get("prompt", ""),
            body.get("messages") or [],
            None,
            body.get("role_mapping"),
            prompt_suffix=body.get("prompt_suffix"),
            state=state,
            questions=normalized,
            commit=commit,
            commit_question=commit_question,
        )

    def handle_score(self, request: CompletionRequest, stop_words: List[str]):
        """Run candidate scoring and return the result as a single JSON body."""
        args = GenerationArguments(
            model=ModelDescription(
                model=self.requested_model,
                draft=self.requested_draft_model,
                adapter=self.adapter,
            ),
            sampling=SamplingArguments(
                temperature=self.temperature,
                top_p=self.top_p,
                top_k=self.top_k,
                min_p=self.min_p,
                xtc_probability=self.xtc_probability,
                xtc_threshold=self.xtc_threshold,
            ),
            logits=LogitsProcessorArguments(
                logit_bias=self.logit_bias,
                repetition_penalty=self.repetition_penalty,
                repetition_context_size=self.repetition_context_size,
                presence_penalty=self.presence_penalty,
                presence_context_size=self.presence_context_size,
                frequency_penalty=self.frequency_penalty,
                frequency_context_size=self.frequency_context_size,
            ),
            stop_words=stop_words,
            max_tokens=self.max_tokens,
            num_draft_tokens=self.num_draft_tokens,
            logprobs=self.logprobs,
            top_logprobs=self.top_logprobs,
            seed=self.seed,
            chat_template_kwargs=self.chat_template_kwargs,
            ngram_draft=bool(self.ngram_draft),
            ngram_window=int(self.ngram_window),
        )

        try:
            ctx, _ = self.response_generator.generate(request, args)
        except Exception as e:
            self._set_completion_headers(400)
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode())
            return

        self._set_completion_headers(200)
        self.end_headers()
        self.wfile.write(
            json.dumps(
                {
                    "id": self.request_id,
                    "object": self.object_type,
                    "model": self.requested_model,
                    **ctx,
                }
            ).encode()
        )

    def handle_text_completions(self) -> CompletionRequest:
        """
        Handle a text completion request.

        Returns:
            mx.array: A mx.array of the tokenized prompt from the request body
        """
        # Determine response type
        self.request_id = f"cmpl-{uuid.uuid4()}"
        self.object_type = "text_completion"
        if self.body.get("assistant_prefix") is not None:
            raise ValueError(
                "'assistant_prefix' is only supported on /v1/chat/completions; "
                "raw 'prompt' requests cannot take an assistant prefix"
            )
        assert "prompt" in self.body, "Request did not contain a prompt"
        if not isinstance(self.body["prompt"], str):
            raise ValueError("'prompt' must be a string")
        return CompletionRequest(
            "text",
            self.body["prompt"],
            [],
            None,
            None,
        )

    def do_GET(self):
        """
        Respond to a GET request from a client.
        """
        if self.path.startswith("/v1/models"):
            self.handle_models_request()
        elif self.path == "/health":
            self.handle_health_check()
        else:
            self._set_completion_headers(404)
            self.end_headers()
            self.wfile.write(b"Not Found")

    def handle_health_check(self):
        """
        Handle a GET request for the /health endpoint.
        """
        self._set_completion_headers(200)
        self.end_headers()

        self.wfile.write('{"status": "ok"}'.encode())
        self.wfile.flush()

    def handle_models_request(self):
        """
        Handle a GET request for the /v1/models endpoint.
        """
        self._set_completion_headers(200)
        self.end_headers()

        files = ["config.json", "model.safetensors.index.json", "tokenizer_config.json"]

        parts = self.path.split("/")
        filter_repo_id = None
        if len(parts) > 3:
            filter_repo_id = "/".join(parts[3:])

        def probably_mlx_lm(repo):
            if repo.repo_type != "model":
                return False
            if "main" not in repo.refs:
                return False
            if filter_repo_id is not None and repo.repo_id != filter_repo_id:
                return False
            file_names = {f.file_path.name for f in repo.refs["main"].files}
            return all(f in file_names for f in files)

        # Scan the cache directory for downloaded mlx models
        hf_cache_info = scan_cache_dir()
        downloaded_models = [
            repo for repo in hf_cache_info.repos if probably_mlx_lm(repo)
        ]

        # Create a list of available models
        models = [
            {
                "id": repo.repo_id,
                "object": "model",
                "created": self.created,
            }
            for repo in downloaded_models
        ]

        if self.response_generator.cli_args.model:
            model_path = Path(self.response_generator.cli_args.model)
            if model_path.exists():
                model_id = str(model_path.resolve())
                models.append(
                    {
                        "id": model_id,
                        "object": "model",
                        "created": self.created,
                    }
                )

        response = {"object": "list", "data": models}

        response_json = json.dumps(response).encode()
        self.wfile.write(response_json)
        self.wfile.flush()


def _run_http_server(
    host: str,
    port: int,
    response_generator,
    server_class=ThreadingHTTPServer,
    handler_class=APIHandler,
):
    server_address = (host, port)
    infos = socket.getaddrinfo(
        *server_address, type=socket.SOCK_STREAM, flags=socket.AI_PASSIVE
    )
    server_class.address_family, _, _, _, server_address = next(iter(infos))
    httpd = server_class(
        server_address,
        lambda *args, **kwargs: handler_class(
            response_generator,
            system_fingerprint=get_system_fingerprint(),
            *args,
            **kwargs,
        ),
    )
    warnings.warn(
        "mlx_lm.server is not recommended for production as "
        "it only implements basic security checks."
    )
    logging.info(f"Starting httpd at {host} on port {port}...")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        # Save BEFORE touching teardown: worker-thread finalization during
        # httpd.shutdown()/join can trip the PyThreadState_Get crash class
        # (same as lora.py), and the file must exist before any of that runs.
        # The save rides the request queue so it executes on the generation
        # thread — the KV arrays' Metal stream only exists there.
        response_generator.save_prompt_cache_file_async()
        httpd.shutdown()
        # Signal the generation thread and STOP — do not join. Any blocking
        # join here reliably trips PyThreadState_Get as Metal/MLX worker
        # threads lose their thread state during teardown (the lora.py crash
        # class). os._exit below reaps everything anyway.
        response_generator._stop = True
        # Skip interpreter finalization entirely — Metal/MLX worker threads
        # calling into Python during teardown is what crashes shutdown.
        sys.stdout.flush()
        sys.stderr.flush()
        os._exit(0)


class _NullPromptCache:
    """Drop-in replacement for LRUPromptCache that stores nothing.

    HEMLOCK_NO_PREFIX_CACHE=1 selects this so every request cold-prefills —
    a debug/bisect switch for prefix-cache behavior.
    """

    def __len__(self):
        return 0

    @property
    def nbytes(self):
        return 0

    def fetch_nearest_cache(self, model, tokens):
        return None, tokens

    def insert_cache(self, model, tokens, prompt_cache, *, cache_type="assistant"):
        del prompt_cache

    def mru_entry(self):
        return None

    def recent_entries(self, n):
        return []

    def trim_to(self, **kwargs):
        pass

    def stats_by_type(self):
        return {}


def run(
    host: str,
    port: int,
    model_provider: ModelProvider,
    server_class=ThreadingHTTPServer,
    handler_class=APIHandler,
):
    group = mx.distributed.init()
    if os.environ.get("HEMLOCK_NO_PREFIX_CACHE"):
        logging.info(
            "HEMLOCK_NO_PREFIX_CACHE set: prompt prefix cache disabled, "
            "every request cold-prefills."
        )
        prompt_cache = _NullPromptCache()
    else:
        prompt_cache = LRUPromptCache(
            model_provider.cli_args.prompt_cache_size,
            model_provider.cli_args.prompt_cache_bytes or (1 << 63),
        )
    response_generator = ResponseGenerator(model_provider, prompt_cache)
    response_generator.load_prompt_cache_file()
    if group.rank() == 0:
        # SIGTERM normally kills the process outright; turn it into the
        # KeyboardInterrupt path so the prompt cache is persisted on the
        # way out. SIGINT already raises KeyboardInterrupt.
        if (
            threading.current_thread() is threading.main_thread()
            and signal.getsignal(signal.SIGTERM) == signal.SIG_DFL
        ):

            def _sigterm(signum, frame):
                raise KeyboardInterrupt()

            signal.signal(signal.SIGTERM, _sigterm)
        _run_http_server(host, port, response_generator)
    else:
        response_generator.join()


def main():
    parser = argparse.ArgumentParser(description="MLX Http Server.")
    parser.add_argument(
        "--model",
        type=str,
        help="The path to the MLX model weights, tokenizer, and config",
    )
    parser.add_argument(
        "--adapter-path",
        type=str,
        help="Optional path for the trained adapter weights and config.",
    )
    parser.add_argument(
        "--host",
        type=str,
        default="127.0.0.1",
        help="Host for the HTTP server (default: 127.0.0.1)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=8080,
        help="Port for the HTTP server (default: 8080)",
    )
    parser.add_argument(
        "--allowed-origins",
        type=lambda x: x.split(","),
        default="*",
        help="Allowed origins (default: *)",
    )
    parser.add_argument(
        "--draft-model",
        type=str,
        help="A model to be used for speculative decoding.",
        default=None,
    )
    parser.add_argument(
        "--num-draft-tokens",
        type=int,
        help="Number of tokens to draft when using speculative decoding.",
        default=3,
    )
    parser.add_argument(
        "--ngram-draft",
        action="store_true",
        help=(
            "Use zero-cost n-gram (prompt-lookup) speculative decoding. No second "
            "model is loaded, so memory stays at the target's footprint. Best for "
            "repetitive / code / templated output. Output is identical to greedy."
        ),
    )
    parser.add_argument(
        "--ngram-window",
        type=int,
        help="Context window size for n-gram draft lookup.",
        default=1024,
    )
    parser.add_argument(
        "--ngram-depth",
        type=int,
        help="Maximum speculative depth for n-gram drafting (default: 12).",
        default=12,
    )
    parser.add_argument(
        "--trust-remote-code",
        action="store_true",
        help="Enable trusting remote code for tokenizer",
    )
    parser.add_argument(
        "--log-level",
        type=str,
        default="INFO",
        choices=["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"],
        help="Set the logging level (default: INFO)",
    )
    parser.add_argument(
        "--chat-template",
        type=str,
        default="",
        help="Specify a chat template for the tokenizer",
        required=False,
    )
    parser.add_argument(
        "--use-default-chat-template",
        action="store_true",
        help="Use the default chat template",
    )
    parser.add_argument(
        "--temp",
        type=float,
        default=0.0,
        help="Default sampling temperature (default: 0.0)",
    )
    parser.add_argument(
        "--top-p",
        type=float,
        default=1.0,
        help="Default nucleus sampling top-p (default: 1.0)",
    )
    parser.add_argument(
        "--top-k",
        type=int,
        default=0,
        help="Default top-k sampling (default: 0, disables top-k)",
    )
    parser.add_argument(
        "--min-p",
        type=float,
        default=0.0,
        help="Default min-p sampling (default: 0.0, disables min-p)",
    )
    parser.add_argument(
        "--max-tokens",
        type=int,
        default=512,
        help="Default maximum number of tokens to generate (default: 512)",
    )
    parser.add_argument(
        "--chat-template-args",
        type=json.loads,
        help="""A JSON formatted string of arguments for the tokenizer's apply_chat_template, e.g. '{"enable_thinking":false}'""",
        default='{"enable_thinking": true}',
    )
    parser.add_argument(
        "--decode-concurrency",
        type=int,
        default=32,
        help="When a request is batchable then decode that many requests in parallel",
    )
    parser.add_argument(
        "--prompt-concurrency",
        type=int,
        default=8,
        help="When a request is batchable then process that many prompts in parallel",
    )
    parser.add_argument(
        "--prefill-step-size",
        type=int,
        default=2048,
        help="Step size for prefill processing (default: 2048)",
    )
    parser.add_argument(
        "--kv-bits",
        type=int,
        default=None,
        help="Number of bits for KV cache quantization, 2-8 (default: no quantization). 4-bit saves ~75% KV memory.",
    )
    parser.add_argument(
        "--kv-group-size",
        type=int,
        choices=(32, 64, 128),
        default=64,
        help="Group size for KV cache quantization (default: 64)",
    )
    parser.add_argument(
        "--quantized-kv-start",
        type=int,
        default=5000,
        help="Step at which to start quantizing the KV cache (default: 5000)",
    )
    parser.add_argument(
        "--max-prompt-tokens",
        type=int,
        default=None,
        help="Reject requests whose prompt exceeds this many tokens with a "
        "4xx instead of attempting prefill (default: the model's "
        "max_position_embeddings when known, else unbounded)",
    )
    parser.add_argument(
        "--prompt-cache-size",
        type=int,
        default=10,
        help="Maximum number of distinct KV caches to hold in the prompt cache",
    )
    parser.add_argument(
        "--prompt-cache-bytes",
        type=_parse_size,
        help="Maximum size in bytes of the KV caches",
    )
    parser.add_argument(
        "--prompt-cache-file",
        type=str,
        default=None,
        help=(
            "Persist the hottest prompt-cache entry to this safetensors file "
            "on shutdown and every 32nd prefill, and warm the cache from it "
            "on startup when it was saved for the same model+adapter. "
            "HEMLOCK_NO_CACHE_FILE=1 disables."
        ),
    )
    parser.add_argument(
        "--pipeline",
        action="store_true",
        help="Use pipelining instead of tensor parallelism",
    )
    parser.add_argument(
        "--flash-head",
        action=argparse.BooleanOptionalAction,
        default=None,
        help="Maple only: use the approximate FlashHead output layer. Faster "
        "decode, approximate token stream. Omit to follow the checkpoint config.",
    )
    args = parser.parse_args()
    if args.kv_bits is not None and not 2 <= args.kv_bits <= 8:
        parser.error("--kv-bits must be between 2 and 8")
    if args.quantized_kv_start < 0:
        parser.error("--quantized-kv-start must be >= 0")
    if args.max_prompt_tokens is not None and args.max_prompt_tokens <= 0:
        parser.error("--max-prompt-tokens must be > 0")
    if args.prefill_step_size <= 0:
        parser.error("--prefill-step-size must be > 0")
    if args.prompt_concurrency <= 0 or args.decode_concurrency <= 0:
        parser.error("--prompt-concurrency and --decode-concurrency must be > 0")
    if args.prompt_cache_bytes is not None and args.prompt_cache_bytes < 0:
        parser.error("--prompt-cache-bytes must be >= 0")
    if args.prompt_cache_size < 0:
        parser.error("--prompt-cache-size must be >= 0")
    if mx.metal.is_available():
        wired_limit = mx.device_info()["max_recommended_working_set_size"]
        mx.set_wired_limit(wired_limit)

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), None),
        format="%(asctime)s - %(levelname)s - %(message)s",
    )
    run(args.host, args.port, ModelProvider(args))


if __name__ == "__main__":
    print(
        "Calling `python -m mlx_lm.server...` directly is deprecated."
        " Use `mlx_lm.server...` or `python -m mlx_lm server ...` instead."
    )
    main()
