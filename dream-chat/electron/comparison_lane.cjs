"use strict";
// T6-P1: Model comparison lane — pure guard/record logic for re-running ONLY
// the last user prompt on ONE alternate provider lane. The host owns all I/O
// (provider leases, streams, receipts); this module stays dependency-free so
// the guard rules are testable without Electron.

const COMPARISON_SCHEMA = "hemlock.agent.comparison.v1";
const COMPARISON_PROVIDERS = ["maple", "codex", "claude"];

function canRunComparison({ inFlight = false, targetProvider = "", currentProvider = "" } = {}) {
  const target = String(targetProvider || "");
  if (!COMPARISON_PROVIDERS.includes(target)) {
    return { ok: false, reason: `Unsupported comparison lane: ${target || "(none)"}. Choose maple, codex, or claude.` };
  }
  if (target === String(currentProvider || "")) {
    return { ok: false, reason: `The comparison lane must differ from the current provider (${target}).` };
  }
  if (inFlight) {
    return { ok: false, reason: "A comparison is already running" };
  }
  return { ok: true, targetProvider: target };
}

function lastUserMessage(conversation = []) {
  const entries = Array.isArray(conversation) ? conversation : [];
  const entry = [...entries].reverse().find((message) => message?.role === "user");
  const content = String(entry?.content || "").trim();
  return content || null;
}

function buildComparisonRecord({ targetProvider = "", answer = "", telemetry = null } = {}) {
  return {
    schema: COMPARISON_SCHEMA,
    targetProvider: String(targetProvider || ""),
    answer: String(answer || ""),
    telemetry: telemetry && typeof telemetry === "object" ? telemetry : null,
    ranAt: new Date().toISOString(),
  };
}

module.exports = { COMPARISON_SCHEMA, COMPARISON_PROVIDERS, canRunComparison, lastUserMessage, buildComparisonRecord };
