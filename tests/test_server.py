# Copyright © 2024 Apple Inc.

import http
import io
import json
import os
import tempfile
import threading
import unittest
import unittest.mock

import mlx.core as mx
import requests

from mlx_lm.generate import TextStateMachine
from mlx_lm.models.cache import (
    KVCache,
    RotatingKVCache,
    load_prompt_cache,
    save_prompt_cache,
)
from mlx_lm.server import (
    APIHandler,
    LRUPromptCache,
    Response,
    ResponseGenerator,
    SamplingArguments,
    _make_sampler,
)
from mlx_lm.utils import load


class DummyModelProvider:
    def __init__(self, with_draft=False):
        HF_MODEL_PATH = "mlx-community/Qwen1.5-0.5B-Chat-4bit"
        self.model, self.tokenizer = load(HF_MODEL_PATH)
        self.model_key = (HF_MODEL_PATH, None)
        self.is_batchable = True

        # Add draft model support
        self.draft_model = None
        self.draft_model_key = None
        self.cli_args = type(
            "obj",
            (object,),
            {
                "adapter_path": None,
                "chat_template": None,
                "use_default_chat_template": False,
                "trust_remote_code": False,
                "draft_model": None,
                "num_draft_tokens": 3,
                "temp": 0.0,
                "top_p": 1.0,
                "top_k": 0,
                "min_p": 0.0,
                "max_tokens": 512,
                "chat_template_args": {},
                "model": None,
                "decode_concurrency": 32,
                "prompt_concurrency": 8,
                "prefill_step_size": 2048,
                "prompt_cache_size": 10,
                "prompt_cache_bytes": 1 << 63,
                "prompt_cache_total_bytes": None,
                "prompt_cache_file": None,
                "kv_bits": None,
                "kv_group_size": 64,
                "quantized_kv_start": 5000,
                "ngram_draft": False,
                "ngram_window": 1024,
                "ngram_depth": 12,
                "allowed_origins": ["*"],
            },
        )

        if with_draft:
            # Use the same model as the draft model for testing
            self.draft_model, _ = load(HF_MODEL_PATH)
            self.draft_model_key = HF_MODEL_PATH
            self.cli_args.draft_model = HF_MODEL_PATH

    def load(self, model, adapter=None, draft_model=None):
        assert model in ["default_model", "chat_model"]
        return self.model, self.tokenizer

    def load_default(self):
        return self.load("default_model", None, "default_model")


class MockCache:
    def __init__(self, value, is_trimmable: bool = True):
        self.value = value
        self._is_trimmable = is_trimmable

    @property
    def nbytes(self):
        return len(self.value)

    def __eq__(self, other):
        return other.value == self.value

    def is_trimmable(self):
        return self._is_trimmable

    def trim(self, n):
        assert self._is_trimmable
        return n


class TestTextStateMachine(unittest.TestCase):
    """Test the TextStateMachine buffering and stripping behavior."""

    def test_strips_control_sequences(self):
        sm = TextStateMachine(
            {
                "normal": [("<tool_call>", "tool")],
                "tool": [("</tool_call>", "normal")],
            }
        )
        state = sm.make_state()
        state, text, s = sm.step(state, "hi <tool_call>body</tool_call> bye")
        state, rest, s = sm.flush(state)
        full = text + rest
        self.assertEqual(full, "hi body bye")

    def test_back_to_back_tool_calls(self):
        sm = TextStateMachine(
            {
                "normal": [("<tool_call>", "tool")],
                "tool": [("</tool_call>", "normal")],
            }
        )
        state = sm.make_state()
        state, t1, s = sm.step(state, "<tool_call>call1</tool_call>")
        state, t2, s = sm.step(state, "<tool_call>call2</tool_call>")
        state, rest, s = sm.flush(state)
        full = t1 + t2 + rest
        self.assertEqual(full, "call1call2")

    def test_partial_match_buffered_then_flushed(self):
        sm = TextStateMachine(
            {
                "normal": [("<tool_call>", "tool")],
                "tool": [("</tool_call>", "normal")],
            }
        )
        # First enter tool state
        state = sm.make_state()
        state, text, s = sm.step(state, "<tool_call>body</")
        self.assertEqual(s, "tool")
        # 'body' is emitted, '</' is buffered (partial match of '</tool_call>')
        self.assertEqual(text, "body")
        # flush releases the buffered text
        state, rest, s = sm.flush(state)
        self.assertEqual(rest, "</")

    def test_discard_drops_buffer(self):
        sm = TextStateMachine(
            {
                "normal": [("STOP", "normal")],
            }
        )
        state = sm.make_state()
        state, text, s = sm.step(state, "hello ST")
        self.assertEqual(text, "hello ")
        # discard drops the buffered 'ST'
        state, s = sm.discard(state)
        self.assertEqual(s, "normal")

    def test_stop_words_stripped(self):
        sm = TextStateMachine(
            {
                "normal": [("STOP", "normal")],
            }
        )
        state = sm.make_state()
        state, text, s = sm.step(state, "hello STOP world")
        state, rest, s = sm.flush(state)
        self.assertEqual(text + rest, "hello  world")

    def test_reasoning_to_tool_transition(self):
        # A tool call started inside a reasoning block must enter "tool".
        sm = TextStateMachine(
            {
                "normal": [("<think>", "reasoning"), ("<tool>", "tool")],
                "reasoning": [("</think>", "normal"), ("<tool>", "tool")],
                "tool": [("</tool>", "normal")],
            }
        )
        state = sm.make_state()
        state, _, s = sm.step(state, "<think>hmm")
        self.assertEqual(s, "reasoning")
        state, _, s = sm.step(state, "<tool>")
        self.assertEqual(s, "tool")
        state, _, s = sm.step(state, "</tool>")
        self.assertEqual(s, "normal")

    def test_empty_end_marker_stays_in_tool_on_discard(self):
        # Models with an empty tool_call_end (e.g. Mistral) never leave "tool";
        # discard on stop must preserve the state so the tool call is flushed.
        sm = TextStateMachine(
            {
                "normal": [("[TOOL_CALLS]", "tool")],
                "tool": [],
            }
        )
        state = sm.make_state()
        state, text, s = sm.step(state, "[TOOL_CALLS]f[ARGS]{}")
        self.assertEqual(s, "tool")
        self.assertEqual(text, "f[ARGS]{}")
        state, s = sm.discard(state)
        self.assertEqual(s, "tool")


class TestServer(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.response_generator = ResponseGenerator(
            DummyModelProvider(), LRUPromptCache()
        )
        cls.server_address = ("localhost", 0)
        cls.httpd = http.server.HTTPServer(
            cls.server_address,
            lambda *args, **kwargs: APIHandler(cls.response_generator, *args, **kwargs),
        )
        cls.port = cls.httpd.server_port
        cls.server_thread = threading.Thread(target=cls.httpd.serve_forever)
        cls.server_thread.daemon = True
        cls.server_thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.server_thread.join()
        cls.response_generator.stop_and_join()

    def test_handle_completions(self):
        url = f"http://localhost:{self.port}/v1/completions"

        post_data = {
            "model": "default_model",
            "prompt": "Once upon a time",
            "max_tokens": 10,
            "temperature": 0.5,
            "top_p": 0.9,
            "repetition_penalty": 1.1,
            "repetition_context_size": 20,
            "seed": 999,
            "stop": "stop sequence",
        }

        response = requests.post(url, json=post_data)

        response_body = json.loads(response.text)

        self.assertIn("id", response_body)
        self.assertIn("choices", response_body)
        first_text = response_body["choices"][0]["text"]
        self.assertEqual(
            first_text,
            json.loads(requests.post(url, json=post_data).text)["choices"][0]["text"],
        )

    def test_handle_chat_completions(self):
        url = f"http://localhost:{self.port}/v1/chat/completions"
        chat_post_data = {
            "model": "chat_model",
            "max_tokens": 10,
            "temperature": 0.7,
            "top_p": 0.85,
            "repetition_penalty": 1.2,
            "messages": [
                {"role": "system", "content": "You are a helpful assistant."},
                {"role": "user", "content": "Hello!"},
            ],
        }
        response = requests.post(url, json=chat_post_data)
        response_body = response.text
        self.assertIn("id", response_body)
        self.assertIn("choices", response_body)

    def test_handle_chat_completions_with_content_fragments(self):
        url = f"http://localhost:{self.port}/v1/chat/completions"
        chat_post_data = {
            "model": "chat_model",
            "max_tokens": 10,
            "temperature": 0.7,
            "top_p": 0.85,
            "repetition_penalty": 1.2,
            "messages": [
                {
                    "role": "system",
                    "content": [
                        {"type": "text", "text": "You are a helpful assistant."}
                    ],
                },
                {"role": "user", "content": [{"type": "text", "text": "Hello!"}]},
            ],
        }
        response = requests.post(url, json=chat_post_data)
        response_body = response.text
        self.assertIn("id", response_body)
        self.assertIn("choices", response_body)

    def test_handle_chat_completions_with_null_tool_content(self):
        url = f"http://localhost:{self.port}/v1/chat/completions"
        chat_post_data = {
            "model": "chat_model",
            "max_tokens": 10,
            "temperature": 0.7,
            "top_p": 0.85,
            "repetition_penalty": 1.2,
            "messages": [
                {"role": "user", "content": "what is 2+3?"},
                {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {
                            "type": "function",
                            "id": "123",
                            "function": {
                                "name": "add",
                                "arguments": '{"a": 2, "b": 3}',
                            },
                        }
                    ],
                },
                {"role": "tool", "content": "5", "tool_call_id": "123"},
            ],
        }
        response = requests.post(url, json=chat_post_data)
        response_body = response.text
        self.assertIn("id", response_body)
        self.assertIn("choices", response_body)

    def test_make_state_machine_empty_tool_call_end(self):
        class FakeTokenizer:
            has_thinking = False
            has_tool_calling = True
            tool_call_start = "[TOOL_CALLS]"
            tool_call_end = ""
            tool_call_start_tokens = (100,)
            tool_call_end_tokens = ()
            eos_token_ids = [2]

            def convert_ids_to_tokens(self, t):
                return f"<eos{t}>"

            def encode(self, text, add_special_tokens=False):
                return []

        stop_matcher, text_sm = self.response_generator._make_state_machine(
            ("fake-empty-end", None, None),
            FakeTokenizer(),
            stop_words=[],
        )

        # Verify the text state machine strips tool call markers
        text_state = text_sm.make_state()
        text_state, clean_text, s = text_sm.step(text_state, "hello[TOOL_CALLS]body")
        self.assertEqual(s, "tool")
        # 'hello' is before the match, 'body' flows through (no tool_call_end)
        self.assertEqual(clean_text, "hellobody")

        # Verify EOS stops via the stop matcher
        stop_state = stop_matcher.make_state()
        stop_state, matched = stop_matcher.match(stop_state, stop_matcher._trie, 2)
        self.assertTrue(matched)

    def test_handle_models(self):
        url = f"http://localhost:{self.port}/v1/models"
        response = requests.get(url)
        self.assertEqual(response.status_code, 200)
        response_body = json.loads(response.text)
        self.assertEqual(response_body["object"], "list")
        self.assertIsInstance(response_body["data"], list)
        self.assertGreater(len(response_body["data"]), 0)
        model = response_body["data"][0]
        self.assertIn("id", model)
        self.assertEqual(model["object"], "model")
        self.assertIn("created", model)

    # ── Request-validation guards ────────────────────────────
    # Every malformed request must produce an honest 4xx JSON error rather
    # than a dropped connection, a 500, or a generation-thread exception.

    def _assert_bad_request(self, url, post_data=None, raw=None, headers=None):
        if raw is not None:
            response = requests.post(
                url,
                data=raw,
                headers={"Content-Type": "application/json", **(headers or {})},
            )
        else:
            response = requests.post(url, json=post_data)
        self.assertEqual(response.status_code, 400, response.text)
        self.assertIn("error", response.json())

    def test_malformed_json_is_400(self):
        url = f"http://localhost:{self.port}/v1/completions"
        self._assert_bad_request(url, raw='{"prompt": "hi", ')
        self._assert_bad_request(url, raw="")
        self._assert_bad_request(url, raw="not json at all")

    def test_non_utf8_body_is_400(self):
        url = f"http://localhost:{self.port}/v1/completions"
        self._assert_bad_request(url, raw=b"\xff\xfe{")

    def test_non_dict_body_is_400(self):
        url = f"http://localhost:{self.port}/v1/completions"
        self._assert_bad_request(url, post_data=[1, 2, 3])
        self._assert_bad_request(url, post_data="a string")

    def test_missing_prompt_is_400(self):
        url = f"http://localhost:{self.port}/v1/completions"
        self._assert_bad_request(url, {"model": "default_model", "max_tokens": 4})

    def test_missing_messages_is_400(self):
        url = f"http://localhost:{self.port}/v1/chat/completions"
        self._assert_bad_request(url, {"model": "chat_model", "max_tokens": 4})

    def test_bad_messages_shape_is_400(self):
        url = f"http://localhost:{self.port}/v1/chat/completions"
        base = {"model": "chat_model", "max_tokens": 4}
        self._assert_bad_request(url, {**base, "messages": []})
        self._assert_bad_request(url, {**base, "messages": "hello"})
        self._assert_bad_request(url, {**base, "messages": [{"role": 7}]})
        self._assert_bad_request(url, {**base, "messages": ["user: hi"]})

    def test_bad_prompt_shape_is_400(self):
        url = f"http://localhost:{self.port}/v1/completions"
        base = {"model": "default_model", "max_tokens": 4}
        self._assert_bad_request(url, {**base, "prompt": 42})
        self._assert_bad_request(url, {**base, "prompt": ["a", "b"]})

    def test_insane_sampling_params_are_400(self):
        url = f"http://localhost:{self.port}/v1/completions"
        base = {"model": "default_model", "prompt": "hi", "max_tokens": 4}
        self._assert_bad_request(url, {**base, "max_tokens": -1})
        self._assert_bad_request(url, {**base, "max_tokens": 10**9})
        self._assert_bad_request(url, {**base, "max_tokens": "ten"})
        self._assert_bad_request(url, {**base, "max_tokens": True})
        self._assert_bad_request(url, {**base, "top_k": -1})
        self._assert_bad_request(url, {**base, "top_k": 1.5})
        self._assert_bad_request(url, {**base, "temperature": "hot"})
        self._assert_bad_request(url, {**base, "temperature": -0.5})
        self._assert_bad_request(url, {**base, "top_p": 2.0})
        self._assert_bad_request(url, {**base, "num_draft_tokens": -2})
        self._assert_bad_request(url, {**base, "ngram_window": "abc"})
        self._assert_bad_request(url, {**base, "stop": 5})
        self._assert_bad_request(url, {**base, "stop": ["ok", 7]})
        self._assert_bad_request(url, {**base, "stream_options": "yes"})
        self._assert_bad_request(url, {**base, "chat_template_kwargs": [1]})
        self._assert_bad_request(url, {**base, "logit_bias": "nope"})
        self._assert_bad_request(url, {**base, "logit_bias": {"1": "x"}})

    def test_non_finite_params_are_400(self):
        # Python's json module accepts NaN/Infinity literals; neither is a
        # usable sampling value and both slip past < / > range checks.
        url = f"http://localhost:{self.port}/v1/completions"
        raw = '{"model": "default_model", "prompt": "hi", "temperature": NaN}'
        self._assert_bad_request(url, raw=raw)
        raw = '{"model": "default_model", "prompt": "hi", "top_p": Infinity}'
        self._assert_bad_request(url, raw=raw)

    def test_oversized_prompt_is_400(self):
        url = f"http://localhost:{self.port}/v1/completions"
        generator = self.response_generator
        original = getattr(generator.cli_args, "max_prompt_tokens", None)
        generator.cli_args.max_prompt_tokens = 64
        try:
            long_prompt = "word " * 200  # well past the 64-token cap
            response = requests.post(
                url,
                json={
                    "model": "default_model",
                    "prompt": long_prompt,
                    "max_tokens": 4,
                },
            )
            self.assertEqual(response.status_code, 400, response.text)
            self.assertIn("token", response.json()["error"].lower())
        finally:
            generator.cli_args.max_prompt_tokens = original

    def test_prompt_within_cap_still_serves(self):
        url = f"http://localhost:{self.port}/v1/completions"
        generator = self.response_generator
        original = getattr(generator.cli_args, "max_prompt_tokens", None)
        generator.cli_args.max_prompt_tokens = 64
        try:
            response = requests.post(
                url,
                json={
                    "model": "default_model",
                    "prompt": "hello there",
                    "max_tokens": 4,
                },
            )
            self.assertEqual(response.status_code, 200, response.text)
        finally:
            generator.cli_args.max_prompt_tokens = original

    def test_score_validation_is_400(self):
        url = f"http://localhost:{self.port}/v1/score"
        base = {"model": "default_model"}
        self._assert_bad_request(url, {**base, "prompt": "hi"})  # no candidates
        self._assert_bad_request(
            url, {**base, "prompt": "hi", "candidates": []}
        )
        self._assert_bad_request(
            url, {**base, "prompt": "hi", "candidates": [1, 2]}
        )
        self._assert_bad_request(
            url, {**base, "candidates": ["a", "b"]}  # no prompt/messages
        )
        self._assert_bad_request(
            url, {**base, "prompt": "", "candidates": ["a"]}
        )
        self._assert_bad_request(
            url, {**base, "prompt": "hi", "messages": [], "candidates": ["a"]}
        )

    def test_bad_content_length_is_400(self):
        # requests/http.client cannot emit a negative Content-Length, so
        # drive the socket at the HTTP level.
        import http.client

        conn = http.client.HTTPConnection("localhost", self.port)
        try:
            conn.putrequest("POST", "/v1/completions")
            conn.putheader("Content-Length", "not-a-number")
            conn.endheaders()
            response = conn.getresponse()
            response.read()
            self.assertEqual(response.status, 400)
        finally:
            conn.close()


class TestServerWithDraftModel(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.response_generator = ResponseGenerator(
            DummyModelProvider(with_draft=True), LRUPromptCache()
        )
        cls.server_address = ("localhost", 0)
        cls.httpd = http.server.HTTPServer(
            cls.server_address,
            lambda *args, **kwargs: APIHandler(cls.response_generator, *args, **kwargs),
        )
        cls.port = cls.httpd.server_port
        cls.server_thread = threading.Thread(target=cls.httpd.serve_forever)
        cls.server_thread.daemon = True
        cls.server_thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.server_thread.join()
        cls.response_generator.stop_and_join()

    def test_handle_completions_with_draft_model(self):
        url = f"http://localhost:{self.port}/v1/completions"

        post_data = {
            "model": "default_model",
            "prompt": "Once upon a time",
            "max_tokens": 10,
            "temperature": 0.0,
            "top_p": 1.0,
        }

        response = requests.post(url, json=post_data)
        self.assertEqual(response.status_code, 200)

        response_body = json.loads(response.text)
        self.assertIn("id", response_body)
        self.assertIn("choices", response_body)
        self.assertIn("usage", response_body)

        # Check that tokens were generated
        self.assertTrue(response_body["usage"]["completion_tokens"] > 0)

    def test_handle_chat_completions_with_draft_model(self):
        url = f"http://localhost:{self.port}/v1/chat/completions"

        chat_post_data = {
            "model": "chat_model",
            "max_tokens": 10,
            "temperature": 0.0,
            "messages": [
                {"role": "system", "content": "You are a helpful assistant."},
                {"role": "user", "content": "Hello!"},
            ],
        }

        response = requests.post(url, json=chat_post_data)
        self.assertEqual(response.status_code, 200)

        response_body = json.loads(response.text)
        self.assertIn("id", response_body)
        self.assertIn("choices", response_body)
        self.assertIn("usage", response_body)

        # Check that tokens were generated
        self.assertTrue(response_body["usage"]["completion_tokens"] > 0)

    def test_streaming_with_draft_model(self):
        url = f"http://localhost:{self.port}/v1/chat/completions"

        chat_post_data = {
            "model": "chat_model",
            "max_tokens": 10,
            "temperature": 0.0,
            "stream": True,
            "messages": [
                {"role": "system", "content": "You are a helpful assistant."},
                {"role": "user", "content": "Hello!"},
            ],
        }

        response = requests.post(url, json=chat_post_data, stream=True)
        self.assertEqual(response.status_code, 200)

        chunk_count = 0
        for chunk in response.iter_lines():
            if chunk:
                data = chunk.decode("utf-8")
                if data.startswith("data: ") and data != "data: [DONE]":
                    chunk_data = json.loads(data[6:])  # Skip the "data: " prefix
                    self.assertIn("choices", chunk_data)
                    self.assertEqual(len(chunk_data["choices"]), 1)
                    self.assertIn("delta", chunk_data["choices"][0])
                    chunk_count += 1

        # Make sure we got some streaming chunks
        self.assertGreater(chunk_count, 0)

    def test_prompt_cache_with_draft_model(self):
        url = f"http://localhost:{self.port}/v1/chat/completions"

        # First request to initialize cache
        chat_post_data = {
            "model": "chat_model",
            "max_tokens": 5,
            "temperature": 0.0,
            "messages": [
                {"role": "system", "content": "You are a helpful assistant."},
                {"role": "user", "content": "Tell me a story about"},
            ],
        }

        first_response = requests.post(url, json=chat_post_data)
        self.assertEqual(first_response.status_code, 200)

        # Second request with same prefix should use cache
        chat_post_data = {
            "model": "chat_model",
            "max_tokens": 5,
            "temperature": 0.0,
            "messages": [
                {"role": "system", "content": "You are a helpful assistant."},
                {"role": "user", "content": "Tell me a story about dragons."},
            ],
        }

        second_response = requests.post(url, json=chat_post_data)
        self.assertEqual(second_response.status_code, 200)

        # Both responses should have content
        first_response_body = json.loads(first_response.text)
        second_response_body = json.loads(second_response.text)

        self.assertIn("choices", first_response_body)
        self.assertIn("choices", second_response_body)
        self.assertIn("message", first_response_body["choices"][0])
        self.assertIn("message", second_response_body["choices"][0])
        self.assertIn("content", first_response_body["choices"][0]["message"])
        self.assertIn("content", second_response_body["choices"][0]["message"])

        # Ensure both generated content
        self.assertIsNotNone(first_response_body["choices"][0]["message"]["content"])
        self.assertIsNotNone(second_response_body["choices"][0]["message"]["content"])


class TestKeepalive(unittest.TestCase):
    def test_keepalive_callback(self):
        """Test keepalive callback sends SSE comments and handles errors"""
        from unittest.mock import Mock

        # Mock handler
        mock_wfile = io.BytesIO()
        handler = Mock()
        handler.wfile = mock_wfile

        # Test callback logic (same as in server.py)
        def keepalive_callback(processed_tokens, total_tokens):
            if handler.stream:
                try:
                    handler.wfile.write(
                        f": keepalive {processed_tokens}/{total_tokens}\n\n".encode()
                    )
                    handler.wfile.flush()
                except (BrokenPipeError, ConnectionResetError, OSError):
                    pass

        # Test streaming enabled
        handler.stream = True
        keepalive_callback(1024, 4096)

        output = mock_wfile.getvalue().decode("utf-8")
        self.assertEqual(output, ": keepalive 1024/4096\n\n")

        # Test streaming disabled
        handler.stream = False
        mock_wfile.seek(0)
        mock_wfile.truncate(0)
        keepalive_callback(2048, 4096)

        output = mock_wfile.getvalue().decode("utf-8")
        self.assertEqual(output, "")

        # Test error handling
        handler.stream = True
        handler.wfile = Mock()
        handler.wfile.write.side_effect = BrokenPipeError("Connection broken")

        # Should not raise exception
        try:
            keepalive_callback(3072, 4096)
        except Exception as e:
            self.fail(f"Callback should handle BrokenPipeError: {e}")


class TestLRUPromptCache(unittest.TestCase):
    def test_caching(self):
        cache = LRUPromptCache(max_size=10)

        def get_kv(n):
            keys = mx.arange(n).reshape(1, 1, n, 1)
            return keys, keys

        model = ("test", None, None)
        tokens = [10] * 24

        c, t = cache.fetch_nearest_cache(model, tokens)
        self.assertTrue(c is None)
        self.assertEqual(t, tokens)

        c = [KVCache()]
        c[0].update_and_fetch(*get_kv(24))
        cache.insert_cache(model, t, c)

        # Fetching a cache that is strictly a prefix doesn't remove it from the
        # lru cache
        tokens = tokens + [20] * 5
        c, t = cache.fetch_nearest_cache(model, tokens)
        k, v = c[0].state
        self.assertTrue((k == v).all().item())
        self.assertTrue((k.flatten() == mx.arange(24)).all().item())
        self.assertEqual(t, [20] * 5)
        self.assertEqual(len(cache), 1)

        # Inserting a trimmable cache with shared prefix removes the prefixes
        tokens = tokens + [30] * 3
        c[0].update_and_fetch(*get_kv(8))
        cache.insert_cache(model, tokens, c)
        self.assertEqual(len(cache), 1)

        # Fetching a cache with a shared prefix doesn't remove it either
        tokens = tokens[:26] + [40] * 8
        c, t = cache.fetch_nearest_cache(model, tokens)
        k, v = c[0].state
        self.assertTrue((k == v).all().item())
        self.assertTrue(
            (k.flatten() == mx.concatenate([mx.arange(24), mx.arange(2)])).all().item()
        )
        self.assertEqual(t, [40] * 8)
        self.assertEqual(len(cache), 1)

        # Inserting a diverged cache actually creates another entry
        c[0].update_and_fetch(*get_kv(8))
        cache.insert_cache(model, tokens, c)
        self.assertEqual(len(cache), 2)

    def test_lru(self):
        cache = LRUPromptCache(max_size=2)
        model = ("test", None, None)
        cache.insert_cache(model, [1, 2], [MockCache("test1")])
        cache.insert_cache(model, [2, 3], [MockCache("test2")])

        c, t = cache.fetch_nearest_cache(model, [1, 2])
        self.assertEqual(c, [MockCache("test1")])
        self.assertEqual(t, [])
        c, t = cache.fetch_nearest_cache(model, [1])
        self.assertEqual(c, [MockCache("test1")])
        self.assertEqual(t, [1])
        c, t = cache.fetch_nearest_cache(model, [1, 3, 4])
        self.assertEqual(c, [MockCache("test1")])
        self.assertEqual(t, [3, 4])
        c, t = cache.fetch_nearest_cache(model, [2, 3, 4])
        self.assertEqual(c, [MockCache("test2")])
        self.assertEqual(t, [4])
        c, t = cache.fetch_nearest_cache(model, [2, 4, 5])
        self.assertEqual(c, [MockCache("test2")])
        self.assertEqual(t, [4, 5])

        cache.insert_cache(model, [1, 2], [MockCache("test1")])
        cache.insert_cache(model, [2, 3], [MockCache("test2")])
        cache.insert_cache(model, [3, 4], [MockCache("test3")])

        c, t = cache.fetch_nearest_cache(model, [1, 2])
        self.assertEqual(c, None)
        self.assertEqual(t, [1, 2])
        c, t = cache.fetch_nearest_cache(model, [2, 3])
        self.assertEqual(c, [MockCache("test2")])
        self.assertEqual(t, [])
        c, t = cache.fetch_nearest_cache(model, [3, 4])
        self.assertEqual(c, [MockCache("test3")])
        self.assertEqual(t, [])

        cache.insert_cache(model, [4, 5], [MockCache("test4")], cache_type="user")
        c, t = cache.fetch_nearest_cache(model, [2, 3])
        self.assertEqual(c, None)
        self.assertEqual(t, [2, 3])
        c, t = cache.fetch_nearest_cache(model, [3, 4])
        self.assertEqual(c, [MockCache("test3")])
        self.assertEqual(t, [])
        c, t = cache.fetch_nearest_cache(model, [4, 5])
        self.assertEqual(c, [MockCache("test4")])
        self.assertEqual(t, [])

        cache.insert_cache(model, [5, 6], [MockCache("test5")])
        cache.insert_cache(model, [6, 7], [MockCache("test6")])
        c, t = cache.fetch_nearest_cache(model, [5, 6])
        self.assertEqual(c, None)
        self.assertEqual(t, [5, 6])
        c, t = cache.fetch_nearest_cache(model, [6, 7])
        self.assertEqual(c, [MockCache("test6")])
        self.assertEqual(t, [])
        c, t = cache.fetch_nearest_cache(model, [4, 5])
        self.assertEqual(c, [MockCache("test4")])
        self.assertEqual(t, [])

    def test_insert_trimmable_cache_removes_immediate_prefix(self):
        cache = LRUPromptCache(max_size=10)
        model = ("test", None, None)

        cache.insert_cache(model, [1, 2], [MockCache("ab")])
        self.assertEqual(len(cache), 1)
        self.assertEqual(cache.nbytes, 2)

        cache.insert_cache(model, [1, 2, 3], [MockCache("abc")])
        self.assertEqual(len(cache), 1)
        self.assertEqual(cache.nbytes, 3)

    def test_insert_empty_tokens_does_not_self_destruct(self):
        cache = LRUPromptCache(max_size=10)
        model = ("test", None, None)

        cache.insert_cache(model, [], [MockCache("root")])
        self.assertEqual(len(cache), 1)
        self.assertEqual(cache.nbytes, 4)

        c, t = cache.fetch_nearest_cache(model, [])
        self.assertIsNotNone(c)
        self.assertEqual(t, [])

    def test_fetch_empty_tokens_after_root_eviction(self):
        cache = LRUPromptCache(max_size=10)
        model = ("test", None, None)

        cache.insert_cache(model, [], [MockCache("root")])
        cache.insert_cache(model, [1], [MockCache("a")])

        c, t = cache.fetch_nearest_cache(model, [])
        self.assertIsNone(c)
        self.assertEqual(t, [])

    def test_lru_bytes(self):
        cache = LRUPromptCache(max_size=100, max_bytes=10)
        model = ("test", None, None)

        cache.insert_cache(model, [1, 2], [MockCache("aaa")])
        cache.insert_cache(model, [3, 4], [MockCache("bbb")])
        cache.insert_cache(model, [4, 5], [MockCache("ccc")])
        cache.insert_cache(model, [6, 7], [MockCache("ddd")])

        self.assertEqual(len(cache), 3)
        self.assertEqual(cache.nbytes, 9)

        cache.trim_to(n_bytes=7)
        self.assertEqual(len(cache), 2)
        self.assertEqual(cache.nbytes, 6)

        c, t = cache.fetch_nearest_cache(model, [1, 2])
        self.assertEqual(c, None)
        self.assertEqual(t, [1, 2])
        c, t = cache.fetch_nearest_cache(model, [3, 4])
        self.assertEqual(c, None)
        self.assertEqual(t, [3, 4])


class TestNullPromptCache(unittest.TestCase):
    def test_null_prompt_cache(self):
        # HEMLOCK_NO_PREFIX_CACHE selects this shim — every request must
        # cold-prefill and inserts are dropped without touching the caller's
        # cache object.
        from mlx_lm.server import _NullPromptCache

        cache = _NullPromptCache()
        model = ("test", None, None)
        entry = [MockCache("keep")]

        c, t = cache.fetch_nearest_cache(model, [1, 2, 3])
        self.assertIsNone(c)
        self.assertEqual(t, [1, 2, 3])

        cache.insert_cache(model, [1, 2, 3], entry)
        self.assertEqual(entry, [MockCache("keep")], "caller keeps its cache")
        self.assertEqual(len(cache), 0)
        self.assertEqual(cache.nbytes, 0)
        cache.trim_to(n_bytes=0)

        c, t = cache.fetch_nearest_cache(model, [1, 2, 3])
        self.assertIsNone(c)
        self.assertEqual(t, [1, 2, 3])


class TestMakeSampler(unittest.TestCase):
    def test_xtc_special_tokens(self):
        class FakeTokenizer:
            eos_token_ids = [0, 1, 9]

            def encode(self, text, add_special_tokens=False):
                return [3]

        sampling = SamplingArguments(
            temperature=0.6,
            top_p=1.0,
            top_k=0,
            min_p=0.0,
            xtc_probability=1.0,
            xtc_threshold=0.1,
        )
        args = type("obj", (object,), {"sampling": sampling})
        sampler = _make_sampler(args, FakeTokenizer())
        logits = mx.log(
            mx.array([[0.4, 0.2, 0.1, 0.1, 0.05, 0.05, 0.03, 0.03, 0.02, 0.02]])
        )
        token = sampler(logits)
        mx.eval(token)
        self.assertEqual(token.shape, (1,))


class TestDecide(unittest.TestCase):
    """End-to-end /v1/decide coverage against the real model."""

    @classmethod
    def setUpClass(cls):
        cls.provider = DummyModelProvider()
        cls.prompt_cache = LRUPromptCache()
        cls.response_generator = ResponseGenerator(cls.provider, cls.prompt_cache)
        cls.server_address = ("localhost", 0)
        cls.httpd = http.server.HTTPServer(
            cls.server_address,
            lambda *args, **kwargs: APIHandler(cls.response_generator, *args, **kwargs),
        )
        cls.port = cls.httpd.server_port
        cls.server_thread = threading.Thread(target=cls.httpd.serve_forever)
        cls.server_thread.daemon = True
        cls.server_thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.server_thread.join()
        cls.response_generator.stop_and_join()

    def _decide(self, post_data):
        url = f"http://localhost:{self.port}/v1/decide"
        return requests.post(url, json=post_data)

    @staticmethod
    def _payload(**overrides):
        payload = {
            "model": "default_model",
            "prompt": "You are deciding what happens next in a text game.",
            "state": {"location": "kitchen", "door": "open"},
            "questions": {
                "move": {
                    "type": "choice",
                    "instructions": "Where should the player go?",
                    "criteria": {
                        "north": "through the open door",
                        "south": "back to the hall",
                    },
                }
            },
        }
        payload.update(overrides)
        return payload

    def test_request_validation(self):
        bad = [
            {},  # no questions
            {"questions": []},  # not an object
            {"questions": {}},  # empty
            # more than 32 questions
            {"questions": {f"q{i}": {"type": "noul"} for i in range(33)}},
            {"questions": {"q": {"type": "bogus"}}},
            {"questions": {"q": 42}},  # question not an object
            # choice needs 1-255 options
            {"questions": {"q": {"type": "choice", "criteria": {}}}},
            {
                "questions": {
                    "q": {
                        "type": "choice",
                        "criteria": {str(i): None for i in range(256)},
                    }
                }
            },
            {"questions": {"q": {"type": "choice", "criteria": {"": None}}}},
            {
                "questions": {
                    "q": {"type": "choice", "criteria": {"a": {"label": ""}}}
                }
            },
            # score needs 2-255 levels
            {"questions": {"q": {"type": "score", "criteria": ["only"]}}},
            {"questions": {"q": {"type": "score", "criteria": "high"}}},
            {"questions": {"q": {"type": "noul"}}, "state": 42},
            {"questions": {"q": {"type": "noul"}}, "commit": True},
            {
                "questions": {"q": {"type": "noul"}},
                "commitQuestion": "nope",
            },
        ]
        for body in bad:
            body.setdefault("model", "default_model")
            body.setdefault("prompt", "hi")
            body.setdefault("state", "x")
            response = self._decide(body)
            self.assertEqual(response.status_code, 400, body)
            self.assertIn("error", json.loads(response.text))

    def test_answer_shapes(self):
        payload = self._payload(
            questions={
                "open": {
                    "type": "noul",
                    "instructions": "Is the door open?",
                    "criteria": {
                        "true": "the door stands open",
                        "false": "the door is shut",
                    },
                },
                "move": {
                    "type": "choice",
                    "instructions": "Where should the player go?",
                    "criteria": {
                        "north": "through the open door",
                        "south": "back to the hall",
                        "east": {
                            "description": "toward the window",
                            "label": "E",
                            "continuation": "go east",
                        },
                    },
                },
                "urgency": {
                    "type": "score",
                    "instructions": "How urgent is moving?",
                    "criteria": ["not urgent", "somewhat", "very urgent"],
                },
            }
        )
        response = self._decide(payload)
        self.assertEqual(response.status_code, 200, response.text)
        body = json.loads(response.text)
        self.assertEqual(body["schema"], "hemlock.decide.v1")
        self.assertTrue(body["id"].startswith("decide-"))
        self.assertEqual(body["model"], "default_model")
        self.assertIsNone(body["committedQuestion"])
        self.assertIsNone(body["committedKey"])
        self.assertIsNone(body["committedText"])
        self.assertGreater(body["usage"]["promptTokens"], 0)
        self.assertGreater(body["usage"]["decisionTokens"], 0)
        self.assertGreaterEqual(body["usage"]["cachedTokens"], 0)
        self.assertIn("latencyMs", body)

        answers = body["answers"]
        self.assertEqual(set(answers), {"open", "move", "urgency"})

        noul = answers["open"]
        self.assertEqual(noul["type"], "noul")
        self.assertGreaterEqual(noul["noul"], 0.0)
        self.assertLessEqual(noul["noul"], 1.0)
        self.assertAlmostEqual(
            noul["probabilities"]["true"] + noul["probabilities"]["false"], 1.0
        )
        self.assertEqual(noul["probabilities"]["true"], noul["noul"])

        choice = answers["move"]
        self.assertEqual(choice["type"], "choice")
        self.assertIn(choice["choice"], ("north", "south", "east"))
        probs = choice["probabilities"]
        self.assertEqual(set(probs), {"north", "south", "east"})
        self.assertAlmostEqual(sum(probs.values()), 1.0)
        self.assertEqual(set(choice["logprobs"]), {"north", "south", "east"})
        # confidence = (pmax - 1/K) / (1 - 1/K)
        pmax = max(probs.values())
        expected_conf = (pmax - 1.0 / 3) / (1.0 - 1.0 / 3)
        self.assertAlmostEqual(choice["confidence"], expected_conf)

        score = answers["urgency"]
        self.assertEqual(score["type"], "score")
        sprobs = score["probabilities"]
        self.assertEqual(set(sprobs), {"0", "1", "2"})
        self.assertAlmostEqual(sum(sprobs.values()), 1.0)
        expected_score = sum(int(k) * p for k, p in sprobs.items())
        self.assertAlmostEqual(score["score"], expected_score)
        self.assertEqual(
            score["legend"],
            {"0": "not urgent", "1": "somewhat", "2": "very urgent"},
        )
        self.assertGreaterEqual(score["confidence"], 0.0)
        self.assertLessEqual(score["confidence"], 1.0)

    def test_chat_prompt_and_suffix(self):
        payload = self._payload()
        payload.pop("prompt")
        payload["messages"] = [
            {"role": "user", "content": "Judge this tiny scene."}
        ]
        payload["prompt_suffix"] = "\n\n"
        response = self._decide(payload)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn("move", json.loads(response.text)["answers"])

    def test_question_isolation(self):
        # Questions fork the state cache: nothing served for question A may
        # contain question B's instructions or criteria. Wrap the model and
        # inspect every forwarded batch.
        inner = self.provider.model
        tokenizer = self.provider.tokenizer
        forwarded = []

        class Recorder:
            def __call__(self, x, cache=None):
                forwarded.append(tokenizer.decode(x[0].tolist()))
                return inner(x, cache=cache)

            def __getattr__(self, name):
                return getattr(inner, name)

        self.provider.model = Recorder()
        try:
            response = self._decide(
                self._payload(
                    questions={
                        "qa": {
                            "type": "choice",
                            "instructions": "ALPHA_UNIQUE_MARKER pick one",
                            "criteria": {
                                "a1": "ALPHA_UNIQUE option one",
                                "a2": "ALPHA_UNIQUE option two",
                            },
                        },
                        "qb": {
                            "type": "noul",
                            "instructions": "BETA_UNIQUE_MARKER check",
                            "criteria": {
                                "true": "BETA_UNIQUE yes",
                                "false": "BETA_UNIQUE no",
                            },
                        },
                    }
                )
            )
        finally:
            self.provider.model = inner
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(any("ALPHA_UNIQUE_MARKER" in s for s in forwarded))
        self.assertTrue(any("BETA_UNIQUE_MARKER" in s for s in forwarded))
        for s in forwarded:
            self.assertFalse(
                "ALPHA_UNIQUE_MARKER" in s and "BETA_UNIQUE_MARKER" in s,
                "questions leaked into each other's fork",
            )

    def test_commit_writes_strict_prefix(self):
        prompt_text = "You are deciding what happens next."
        payload = self._payload(
            prompt=prompt_text,
            state="the room is dark",
            questions={
                "act": {
                    "type": "choice",
                    "instructions": "What should the player do?",
                    "criteria": {
                        "wait": {
                            "description": "stay still",
                            "continuation": "WAIT",
                        },
                        "run": "sprint for the door",
                    },
                }
            },
            commit=True,
            commitQuestion="act",
        )
        response = self._decide(payload)
        self.assertEqual(response.status_code, 200, response.text)
        body = json.loads(response.text)
        self.assertEqual(body["committedQuestion"], "act")
        self.assertIn(body["committedKey"], ("wait", "run"))
        expected = {"wait": "WAIT", "run": "run"}
        self.assertEqual(body["committedText"], expected[body["committedKey"]])

        # The committed cache key must be a strict prefix of the replayed
        # assistant turn: prompt + continuation + <|im_end|>.
        tokenizer = self.provider.tokenizer
        prompt_tokens = tokenizer.encode(prompt_text)
        replay = prompt_text + body["committedText"] + "<|im_end|>"
        replay_tokens = tokenizer.encode(replay)
        fused = tokenizer.encode(
            tokenizer.decode(prompt_tokens) + body["committedText"] + "<|im_end|>",
            add_special_tokens=False,
        )
        # The committed key is always the fused re-encode: when BPE merges
        # across the prompt/continuation boundary the server rebuilds the
        # cache under `fused` rather than storing an unreachable key.
        expected_key = fused

        # The stored entry exists under exactly that key...
        cache, rest = self.prompt_cache.fetch_nearest_cache(
            self.provider.model_key, expected_key
        )
        self.assertIsNotNone(cache)
        self.assertEqual(rest, [], "no cache entry at the committed key")

        # ...and the committed key is a strict token prefix of the replay.
        self.assertEqual(
            replay_tokens[: len(expected_key)],
            expected_key,
            "committed key is not a strict prefix of the replayed turn",
        )

        # A follow-up decide on the replayed turn is a full cache hit.
        follow = self._decide(
            self._payload(
                prompt=replay,
                state="",
                questions={
                    "ok": {"type": "noul", "instructions": "Did that happen?"}
                },
            )
        )
        self.assertEqual(follow.status_code, 200, follow.text)
        fbody = json.loads(follow.text)
        self.assertEqual(
            fbody["usage"]["cachedTokens"], fbody["usage"]["promptTokens"]
        )

    def test_state_serialization(self):
        from mlx_lm.server import _serialize_state

        self.assertEqual(_serialize_state("raw text"), "raw text")
        self.assertEqual(_serialize_state({}), "")
        out = _serialize_state({"b": 2, "a": {"z": 1, "y": [True, "x"]}, "c": []})
        # Stable across key orderings; dict keys sorted, arrays labeled.
        self.assertEqual(
            out, _serialize_state({"b": 2, "a": {"y": [True, "x"], "z": 1}, "c": []})
        )
        self.assertEqual(
            out.split("\n"),
            ["a:", "  y:", "    [0]: true", "    [1]: x", "  z: 1", "b: 2", "c: []"],
        )
        out = _serialize_state([{"k": "v"}, 3])
        self.assertEqual(out.split("\n"), ["[0]:", "  k: v", "[1]: 3"])


class TestAssistantPrefix(unittest.TestCase):
    """End-to-end assistant_prefix coverage on /v1/chat/completions."""

    @classmethod
    def setUpClass(cls):
        cls.provider = DummyModelProvider()
        cls.prompt_cache = LRUPromptCache()
        cls.response_generator = ResponseGenerator(cls.provider, cls.prompt_cache)
        cls.server_address = ("localhost", 0)
        cls.httpd = http.server.HTTPServer(
            cls.server_address,
            lambda *args, **kwargs: APIHandler(cls.response_generator, *args, **kwargs),
        )
        cls.port = cls.httpd.server_port
        cls.server_thread = threading.Thread(target=cls.httpd.serve_forever)
        cls.server_thread.daemon = True
        cls.server_thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.server_thread.join()
        cls.response_generator.stop_and_join()

    def _chat(self, post_data):
        url = f"http://localhost:{self.port}/v1/chat/completions"
        return requests.post(url, json=post_data)

    def _prompt_tokens(self, messages, prefix=None):
        """The exact prompt the server builds: template + prefix tokens."""
        tok = self.provider.tokenizer
        prompt = tok.apply_chat_template(
            messages, add_generation_prompt=True, tokenize=True, tools=None
        )
        if prefix is not None:
            prompt = prompt + tok.encode(prefix, add_special_tokens=False)
        return prompt

    def test_prefix_echoed_in_content(self):
        prefix = '{"command":'
        messages = [{"role": "user", "content": "Reply with a JSON command."}]
        response = self._chat(
            {
                "model": "chat_model",
                "max_tokens": 8,
                "temperature": 0.0,
                "messages": messages,
                "assistant_prefix": prefix,
            }
        )
        self.assertEqual(response.status_code, 200, response.text)
        body = json.loads(response.text)
        content = body["choices"][0]["message"]["content"]
        self.assertTrue(content.startswith(prefix), content)

        # The prefix is part of the prompt: usage counts it.
        expected = self._prompt_tokens(messages, prefix)
        self.assertEqual(body["usage"]["prompt_tokens"], len(expected))

    def test_prefix_participates_in_cache_key(self):
        messages = [{"role": "user", "content": "Count to three."}]
        base = {
            "model": "chat_model",
            "max_tokens": 4,
            "temperature": 0.0,
            "messages": messages,
        }
        prefix = '{"command":'
        r1 = self._chat({**base, "assistant_prefix": prefix})
        self.assertEqual(r1.status_code, 200, r1.text)
        p_tokens = len(self._prompt_tokens(messages, prefix))

        # Same request again: the stored key covers prompt+generated, so the
        # refetch serves everything but the re-forwarded last prompt token.
        r2 = self._chat({**base, "assistant_prefix": prefix})
        self.assertEqual(r2.status_code, 200, r2.text)
        cached = json.loads(r2.text)["usage"]["prompt_tokens_details"][
            "cached_tokens"
        ]
        self.assertEqual(cached, p_tokens - 1)

        # The stored key literally extends prompt+prefix: one more token
        # is all that is left uncached.
        prompt_with_prefix = self._prompt_tokens(messages, prefix)
        _, rest = self.prompt_cache.fetch_nearest_cache(
            self.provider.model_key, prompt_with_prefix + [0]
        )
        self.assertEqual(rest, [0])

        # A different prefix diverges inside the prefix region — the shared
        # chat-template head may hit, but the full prompt can't.
        other = self._prompt_tokens(messages, '{"other":')
        _, rest = self.prompt_cache.fetch_nearest_cache(
            self.provider.model_key, other
        )
        self.assertGreater(len(rest), 1)

    def test_prefix_oversize_rejected(self):
        prefix = "the quick brown fox jumps over the lazy dog " * 20
        self.assertGreater(
            len(
                self.provider.tokenizer.encode(
                    prefix, add_special_tokens=False
                )
            ),
            64,
        )
        response = self._chat(
            {
                "model": "chat_model",
                "messages": [{"role": "user", "content": "hi"}],
                "assistant_prefix": prefix,
            }
        )
        self.assertEqual(response.status_code, 400, response.text)
        self.assertIn("assistant_prefix", json.loads(response.text)["error"])

    def test_prefix_non_string_rejected(self):
        response = self._chat(
            {
                "model": "chat_model",
                "messages": [{"role": "user", "content": "hi"}],
                "assistant_prefix": 42,
            }
        )
        self.assertEqual(response.status_code, 400, response.text)

    def test_prefix_rejected_on_raw_prompt(self):
        url = f"http://localhost:{self.port}/v1/completions"
        response = requests.post(
            url,
            json={
                "model": "default_model",
                "prompt": "Once upon a time",
                "assistant_prefix": "x",
            },
        )
        self.assertEqual(response.status_code, 400, response.text)
        self.assertIn("assistant_prefix", json.loads(response.text)["error"])

    def test_prefix_rejected_on_score(self):
        url = f"http://localhost:{self.port}/v1/score"
        response = requests.post(
            url,
            json={
                "model": "default_model",
                "prompt": "hi",
                "candidates": ["a", "b"],
                "assistant_prefix": "x",
            },
        )
        self.assertEqual(response.status_code, 400, response.text)


class TestPromptCacheFile(unittest.TestCase):
    """--prompt-cache-file persistence: round-trip, guards, interval."""

    @classmethod
    def setUpClass(cls):
        cls.provider = DummyModelProvider()
        cls.response_generator = ResponseGenerator(cls.provider, LRUPromptCache())

    @classmethod
    def tearDownClass(cls):
        cls.response_generator.stop_and_join()

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self._tmp.name, "prompt-cache.safetensors")
        self.provider.cli_args.prompt_cache_file = self.path
        self.response_generator.prompt_cache = LRUPromptCache()
        # The legacy tests below exercise the single-entry file; the
        # multi-entry tests pin their own slot count via _with_slots.
        self._slots = unittest.mock.patch.dict(
            os.environ, {"HEMLOCK_PROMPT_CACHE_SLOTS": "1"}
        )
        self._slots.start()

    def tearDown(self):
        self._slots.stop()
        self.provider.cli_args.prompt_cache_file = None
        self.response_generator.prompt_cache = LRUPromptCache()
        self.response_generator._cache_save_interval = 32
        self.response_generator._prefills_since_save = 0
        self._tmp.cleanup()

    def _with_slots(self, n):
        return unittest.mock.patch.dict(
            os.environ, {"HEMLOCK_PROMPT_CACHE_SLOTS": str(n)}
        )

    def _rotating_entry(self, n_tokens=6):
        rot = RotatingKVCache(max_size=16, keep=4)
        k = mx.random.normal((1, 2, n_tokens, 4))
        v = mx.random.normal((1, 2, n_tokens, 4))
        rot.update_and_fetch(k, v)
        mx.eval(rot.keys, rot.values)
        return rot

    def test_save_load_round_trip(self):
        rot = self._rotating_entry()
        key_tokens = [11, 22, 33]
        self.response_generator.prompt_cache.insert_cache(
            self.provider.model_key, key_tokens, [rot]
        )
        self.response_generator.save_prompt_cache_file()
        self.assertTrue(os.path.exists(self.path))

        # A cold cache picks the entry back up under the exact key.
        self.response_generator.prompt_cache = LRUPromptCache()
        self.response_generator.load_prompt_cache_file()
        cache, rest = self.response_generator.prompt_cache.fetch_nearest_cache(
            self.provider.model_key, key_tokens
        )
        self.assertEqual(rest, [], "no exact cache hit after restore")
        loaded = cache[0]
        self.assertIsInstance(loaded, RotatingKVCache)
        self.assertEqual(loaded.meta_state, rot.meta_state)
        lk, lv = loaded.state
        ok, ov = rot.state
        self.assertTrue((lk == ok).all().item())
        self.assertTrue((lv == ov).all().item())

    def test_mru_is_last_inserted(self):
        self.response_generator.prompt_cache.insert_cache(
            self.provider.model_key, [1, 2], [self._rotating_entry()]
        )
        self.response_generator.prompt_cache.insert_cache(
            self.provider.model_key, [3, 4, 5], [self._rotating_entry()]
        )
        self.response_generator.save_prompt_cache_file()
        _, metadata = load_prompt_cache(self.path, return_metadata=True)
        self.assertEqual(json.loads(metadata["key_tokens"]), [3, 4, 5])
        self.assertEqual(
            json.loads(metadata["model_key"]), list(self.provider.model_key)
        )
        self.assertIn("saved_at", metadata)

    def test_stale_model_key_cold_starts(self):
        save_prompt_cache(
            self.path,
            [self._rotating_entry()],
            {
                "model_key": json.dumps(["other-model", None, None]),
                "key_tokens": json.dumps([1, 2]),
                "saved_at": "0",
            },
        )
        self.response_generator.load_prompt_cache_file()
        self.assertEqual(len(self.response_generator.prompt_cache), 0)

    def test_malformed_key_tokens_cold_starts(self):
        for bad_tokens in ['"nope"', '["a", "b"]', "not-json"]:
            save_prompt_cache(
                self.path,
                [self._rotating_entry()],
                {
                    "model_key": json.dumps(list(self.provider.model_key)),
                    "key_tokens": bad_tokens,
                    "saved_at": "0",
                },
            )
            self.response_generator.prompt_cache = LRUPromptCache()
            self.response_generator.load_prompt_cache_file()
            self.assertEqual(
                len(self.response_generator.prompt_cache), 0, bad_tokens
            )

    def test_corrupt_file_cold_starts(self):
        with open(self.path, "wb") as f:
            f.write(b"this is not a safetensors file")
        self.response_generator.load_prompt_cache_file()
        self.assertEqual(len(self.response_generator.prompt_cache), 0)

    def test_env_disable(self):
        self.response_generator.prompt_cache.insert_cache(
            self.provider.model_key, [1, 2], [self._rotating_entry()]
        )
        with unittest.mock.patch.dict(
            os.environ, {"HEMLOCK_NO_CACHE_FILE": "1"}
        ):
            self.response_generator.save_prompt_cache_file()
            self.assertFalse(os.path.exists(self.path))

        # ...and a present file is ignored on load too.
        self.response_generator.save_prompt_cache_file()
        self.assertTrue(os.path.exists(self.path))
        with unittest.mock.patch.dict(
            os.environ, {"HEMLOCK_NO_CACHE_FILE": "1"}
        ):
            self.response_generator.prompt_cache = LRUPromptCache()
            self.response_generator.load_prompt_cache_file()
            self.assertEqual(len(self.response_generator.prompt_cache), 0)

    def test_periodic_save_interval(self):
        self.response_generator._cache_save_interval = 2
        key = self.provider.model_key

        def kv_entry():
            c = KVCache()
            k = mx.zeros((1, 1, 4, 1))
            c.update_and_fetch(k, k)
            return c

        self.response_generator._insert_prompt_cache(key, [1], [kv_entry()])
        self.assertFalse(os.path.exists(self.path))
        self.response_generator._insert_prompt_cache(key, [1, 2], [kv_entry()])
        self.assertTrue(os.path.exists(self.path))

    def test_multi_entry_round_trip(self):
        with self._with_slots(4):
            key = self.provider.model_key
            self.response_generator.prompt_cache.insert_cache(
                key, [1, 2], [self._rotating_entry()]
            )
            self.response_generator.prompt_cache.insert_cache(
                key, [3, 4, 5], [self._rotating_entry()]
            )
            self.response_generator.save_prompt_cache_file()

            manifest_path = f"{self.path}.manifest.json"
            self.assertTrue(os.path.exists(manifest_path))
            self.assertFalse(
                os.path.exists(self.path),
                "multi-entry saves do not write the legacy single file",
            )
            with open(manifest_path) as f:
                manifest = json.load(f)
            self.assertEqual(len(manifest["entries"]), 2)
            for item in manifest["entries"]:
                self.assertTrue(
                    os.path.exists(os.path.join(self._tmp.name, item["file"]))
                )
                self.assertIsInstance(item["key_tokens"], list)

            # A cold cache restores BOTH entries under their exact keys.
            self.response_generator.prompt_cache = LRUPromptCache()
            self.response_generator.load_prompt_cache_file()
            for tokens in ([1, 2], [3, 4, 5]):
                cache, rest = self.response_generator.prompt_cache.fetch_nearest_cache(
                    key, tokens
                )
                self.assertEqual(rest, [], f"no exact cache hit for {tokens}")
                self.assertIsNotNone(cache)
                self.assertIsInstance(cache[0], RotatingKVCache)

    def test_multi_entry_manifest_corrupt_cold_starts(self):
        with self._with_slots(4):
            with open(f"{self.path}.manifest.json", "w") as f:
                f.write("{not json")
            self.response_generator.load_prompt_cache_file()
            self.assertEqual(len(self.response_generator.prompt_cache), 0)

    def test_multi_entry_manifest_corrupt_falls_back_to_single_file(self):
        with self._with_slots(4):
            # A legacy single-entry file beside an unreadable manifest:
            # the loader falls back and still warms what it can.
            save_prompt_cache(
                self.path,
                [self._rotating_entry()],
                {
                    "model_key": json.dumps(list(self.provider.model_key)),
                    "key_tokens": json.dumps([7, 8]),
                    "saved_at": "0",
                },
            )
            with open(f"{self.path}.manifest.json", "w") as f:
                f.write("{corrupt")
            self.response_generator.load_prompt_cache_file()
            cache, rest = self.response_generator.prompt_cache.fetch_nearest_cache(
                self.provider.model_key, [7, 8]
            )
            self.assertEqual(rest, [])
            self.assertIsNotNone(cache)

    def test_multi_entry_bad_entry_file_partial_load(self):
        with self._with_slots(4):
            key = self.provider.model_key
            self.response_generator.prompt_cache.insert_cache(
                key, [1, 2], [self._rotating_entry()]
            )
            self.response_generator.prompt_cache.insert_cache(
                key, [3, 4, 5], [self._rotating_entry()]
            )
            self.response_generator.save_prompt_cache_file()
            with open(f"{self.path}.manifest.json") as f:
                manifest = json.load(f)
            # Corrupt the first entry's file; the second must still load.
            bad = os.path.join(self._tmp.name, manifest["entries"][0]["file"])
            with open(bad, "wb") as f:
                f.write(b"this is not a safetensors file")
            good_tokens = manifest["entries"][1]["key_tokens"]

            self.response_generator.prompt_cache = LRUPromptCache()
            self.response_generator.load_prompt_cache_file()
            self.assertEqual(len(self.response_generator.prompt_cache), 1)
            cache, rest = self.response_generator.prompt_cache.fetch_nearest_cache(
                key, good_tokens
            )
            self.assertEqual(rest, [])
            self.assertIsNotNone(cache)

    def test_slots_one_single_file_behavior(self):
        with self._with_slots(1):
            key = self.provider.model_key
            self.response_generator.prompt_cache.insert_cache(
                key, [1, 2], [self._rotating_entry()]
            )
            self.response_generator.prompt_cache.insert_cache(
                key, [3, 4, 5], [self._rotating_entry()]
            )
            self.response_generator.save_prompt_cache_file()
            self.assertTrue(os.path.exists(self.path))
            self.assertFalse(os.path.exists(f"{self.path}.manifest.json"))
            self.assertFalse(os.path.exists(f"{self.path}.0.safetensors"))
            _, metadata = load_prompt_cache(self.path, return_metadata=True)
            self.assertEqual(json.loads(metadata["key_tokens"]), [3, 4, 5])


if __name__ == "__main__":
    unittest.main()
