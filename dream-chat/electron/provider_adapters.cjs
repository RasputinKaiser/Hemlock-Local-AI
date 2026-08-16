const PROVIDER_IDS = Object.freeze(["maple", "codex", "claude"]);

const PROVIDER_DEFINITIONS = Object.freeze({
  maple: Object.freeze({
    id: "maple",
    label: "Maple-Preview",
    shortLabel: "MAPLE",
    kind: "local",
    defaultModel: "default_model",
    modelLabel: "Maple-Preview local MLX",
    defaultReasoning: "native",
    reasoningLevels: Object.freeze(["native"]),
  }),
  codex: Object.freeze({
    id: "codex",
    label: "Codex",
    shortLabel: "CODEX",
    kind: "subscription",
    defaultModel: "",
    modelLabel: "Codex default",
    defaultReasoning: "high",
    reasoningLevels: Object.freeze(["low", "medium", "high", "xhigh", "max"]),
  }),
  claude: Object.freeze({
    id: "claude",
    label: "Claude",
    shortLabel: "CLAUDE",
    kind: "subscription",
    defaultModel: "sonnet",
    modelLabel: "Claude Sonnet",
    defaultReasoning: "high",
    reasoningLevels: Object.freeze(["low", "medium", "high", "xhigh", "max"]),
  }),
});

function providerDefinition(provider) {
  return PROVIDER_DEFINITIONS[PROVIDER_IDS.includes(String(provider)) ? String(provider) : "maple"];
}

function normalizeSelection(input = {}) {
  const definition = providerDefinition(input.provider || input.modelProvider);
  const model = typeof input.model === "string" ? input.model.trim() : definition.defaultModel;
  const reasoning = definition.reasoningLevels.includes(input.reasoning)
    ? input.reasoning
    : definition.defaultReasoning;
  return {
    provider: definition.id,
    model,
    reasoning,
    label: definition.label,
    shortLabel: definition.shortLabel,
    kind: definition.kind,
  };
}

function parseJsonLine(line) {
  try {
    return JSON.parse(String(line || ""));
  } catch {
    return null;
  }
}

function appendFullText(state, value) {
  const text = String(value || "");
  if (!text) return "";
  const current = String(state.text || "");
  if (!current) {
    state.text = text;
    return text;
  }
  if (text === current) return "";
  if (text.startsWith(current)) {
    const delta = text.slice(current.length);
    state.text = text;
    return delta;
  }
  state.text = `${current}${text}`;
  return text;
}

function parseCodexEvent(event, state = {}) {
  if (!event || typeof event !== "object") return { delta: "" };
  if (event.type === "item.delta" && typeof event.delta === "string") {
    state.text = `${state.text || ""}${event.delta}`;
    return { delta: event.delta, usage: event.usage || null };
  }
  if (event.type === "item.completed" && event.item?.type === "agent_message") {
    return { delta: appendFullText(state, event.item.text), usage: event.usage || null };
  }
  if (event.type === "turn.completed") return { delta: "", usage: event.usage || null, done: true };
  if (event.type === "turn.failed" || event.type === "error") {
    return { delta: "", error: event.error?.message || event.message || "Codex returned an error." };
  }
  return { delta: "", usage: event.usage || null };
}

function claudeMessageText(message) {
  if (typeof message === "string") return message;
  if (!message || !Array.isArray(message.content)) return "";
  return message.content.filter((block) => block?.type === "text").map((block) => block.text).join("");
}

function parseClaudeEvent(event, state = {}) {
  if (!event || typeof event !== "object") return { delta: "" };
  if (event.type === "stream_event") {
    const nested = event.event || {};
    if (nested.type === "content_block_delta" && nested.delta?.type === "text_delta") {
      const delta = String(nested.delta.text || "");
      state.text = `${state.text || ""}${delta}`;
      return { delta, usage: event.usage || nested.usage || null };
    }
    return { delta: "", usage: event.usage || null };
  }
  if (event.type === "assistant") return { delta: appendFullText(state, claudeMessageText(event.message)), usage: event.usage || null };
  if (event.type === "result") {
    if (event.is_error === true || event.api_error_status || event.subtype === "error") {
      return { delta: "", error: event.result || event.error?.message || "Claude returned an error." };
    }
    const result = typeof event.result === "string" ? event.result : claudeMessageText(event.message);
    return { delta: appendFullText(state, result), usage: event.usage || null, done: true };
  }
  if (event.type === "error") return { delta: "", error: event.error?.message || event.message || "Claude returned an error." };
  return { delta: "", usage: event.usage || null };
}

function parseProviderLine(provider, line, state = {}) {
  const event = parseJsonLine(line);
  if (!event) return { delta: String(line || ""), event: null };
  return {
    ...((provider === "codex" ? parseCodexEvent : parseClaudeEvent)(event, state)),
    event,
  };
}

module.exports = {
  PROVIDER_IDS,
  PROVIDER_DEFINITIONS,
  providerDefinition,
  normalizeSelection,
  parseJsonLine,
  parseCodexEvent,
  parseClaudeEvent,
  parseProviderLine,
};
