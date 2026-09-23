"use strict";

// T9-H1 readiness helpers for the Maple spawn/readiness loop in main.cjs.
// Pure functions only — no I/O, no Electron imports — so node --test can
// exercise the exact policy the live poll loop follows.

const BASE_DELAY_MS = 250;
const MAX_DELAY_MS = 2000;

// Poll-delay policy for readiness loops: exponential backoff capped at 2s,
// with an explicit deadline verdict instead of a silent while-condition exit.
function nextReadinessDelay(probeState) {
  const { attempt, startedAt, timeoutMs } = probeState && typeof probeState === "object" ? probeState : {};
  const attemptNum = Number(attempt);
  const startedNum = Number(startedAt);
  const timeoutNum = Number(timeoutMs);
  if (
    !Number.isInteger(attemptNum) || attemptNum < 0 ||
    !Number.isFinite(startedNum) ||
    !Number.isFinite(timeoutNum) || timeoutNum <= 0 ||
    Date.now() < startedNum
  ) {
    return { done: true, delayMs: 0, reason: "invalid probe state" };
  }
  if (Date.now() - startedNum >= timeoutNum) {
    return { done: true, delayMs: 0, reason: "readiness deadline exceeded" };
  }
  return { done: false, delayMs: Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attemptNum), reason: "poll" };
}

// Map a failed health/probe request onto one stable reason token so logs and
// final error messages stay compact. Checks the error itself and (one level
// deep) undici's `cause`, since fetch surfaces ECONNREFUSED there.
function classifyHealthFailure(error) {
  if (!error || typeof error !== "object") return "unknown";
  const status = Number(error.status);
  if (Number.isFinite(status) && status >= 400) return "http-error";
  const codes = [error.code, error.cause && error.cause.code].map((code) => String(code || ""));
  const message = String(error.message || "");
  const causeMessage = String((error.cause && error.cause.message) || "");
  const haystack = `${message} ${causeMessage}`.toLowerCase();
  if (codes.includes("ECONNREFUSED") || haystack.includes("econnrefused") || haystack.includes("refused")) return "connection-refused";
  if (
    codes.some((code) => code === "ABORT_ERR" || code === "UND_ERR_ABORTED" || code === "ETIMEDOUT") ||
    error.name === "AbortError" ||
    haystack.includes("abort") || haystack.includes("timed out") || haystack.includes("timeout")
  ) {
    return "timeout";
  }
  if (/\bhttps?\s*status|\bhttp\s*\d{3}\b/.test(haystack)) return "http-error";
  return "unknown";
}

// A directory with config+weights but no tokenizer still fails at load — the
// AutoTokenizer raises before the first request is ever served. Catching it
// here turns a confusing server 404 into a "missing tokenizer files" fix.
const TOKENIZER_MARKERS = new Set([
  "tokenizer.json",
  "tokenizer.model",
  "tokenizer_config.json",
  "vocab.json",
  "vocab.txt",
  "merges.txt",
  "special_tokens_map.json",
]);

// Given a checkpoint directory's entry names, return what is missing for it to
// be a loadable MLX conversion, or null when it looks complete. main.cjs owns
// the filesystem reads; this stays pure over the name list.
function missingCheckpointItem(fileNames) {
  const names = Array.isArray(fileNames) ? fileNames : [];
  if (!names.includes("config.json")) return "config.json";
  if (!names.some((name) => typeof name === "string" && name.endsWith(".safetensors"))) {
    return "safetensors weights";
  }
  if (!names.some((name) => typeof name === "string" && (TOKENIZER_MARKERS.has(name) || name.startsWith("tokenizer")))) {
    return "tokenizer files";
  }
  return null;
}

module.exports = { nextReadinessDelay, classifyHealthFailure, missingCheckpointItem, BASE_DELAY_MS, MAX_DELAY_MS };
