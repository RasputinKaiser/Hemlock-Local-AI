const crypto = require("node:crypto");

function digest(value) {
  return `sha256:${crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex")}`;
}

class Utf8SseParser {
  constructor() {
    this.decoder = new TextDecoder("utf-8");
    this.buffer = "";
    this.dataLines = [];
  }

  push(chunk, { final = false } = {}) {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: !final });
    if (final) this.buffer += this.decoder.decode();
    const events = [];
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() || "";
    for (const line of lines) {
      if (line === "") {
        const event = this.flushEvent();
        if (event) events.push(event);
        continue;
      }
      if (line.startsWith(":")) continue;
      const separator = line.indexOf(":");
      const field = separator < 0 ? line : line.slice(0, separator);
      const value = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /, "");
      if (field === "data") this.dataLines.push(value);
    }
    if (final && this.buffer) {
      const line = this.buffer;
      this.buffer = "";
      if (line.startsWith("data:")) this.dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    if (final) {
      const event = this.flushEvent();
      if (event) events.push(event);
    }
    return events;
  }

  flushEvent() {
    if (!this.dataLines.length) return null;
    const data = this.dataLines.join("\n");
    this.dataLines = [];
    return { data, done: data === "[DONE]" };
  }
}

function parseSsePayload(event) {
  if (!event || event.done) return { done: Boolean(event?.done), payload: null };
  try { return { done: false, payload: JSON.parse(event.data) }; }
  catch { return { done: false, payload: null, error: "invalid_json", raw: event.data }; }
}

function extractModelChannels(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value)
    // `role` is transport metadata, not a model-output channel. Some local
    // Maple templates repeat `role: "assistant"` on every streamed delta;
    // treating it as text makes the durable trace grow by megabytes and
    // produces misleading assistantassistantassistant... output in Activity.
    .filter(([name, text]) => name !== "role" && typeof text === "string" && text.length > 0)
    .map(([name, text]) => ({ name, text }));
}

function compactModelPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const choice = payload.choices?.[0];
  if (!choice || typeof choice !== "object") return payload;
  const compactChoice = {};
  if (choice.delta && typeof choice.delta === "object") {
    compactChoice.delta = Object.fromEntries(extractModelChannels(choice.delta).map(({ name, text }) => [name, text]));
  }
  if (choice.message && typeof choice.message === "object") {
    compactChoice.message = Object.fromEntries(extractModelChannels(choice.message).map(({ name, text }) => [name, text]));
  }
  if (choice.finish_reason !== undefined && choice.finish_reason !== null) compactChoice.finish_reason = choice.finish_reason;
  const compact = { choices: [compactChoice] };
  for (const key of ["id", "object", "model", "created", "system_fingerprint"]) {
    if (payload[key] !== undefined) compact[key] = payload[key];
  }
  if (payload.usage !== undefined) compact.usage = payload.usage;
  return compact;
}

function selectStructuredActionText(message) {
  const channels = extractModelChannels(message);
  const actionPattern = /hemlock\.agent\.action\.v1|["']commandId["']\s*:/i;
  const actionChannel = channels.find(({ text }) => actionPattern.test(text));
  if (actionChannel) return { text: actionChannel.text, channel: actionChannel.name };
  const content = channels.find(({ name }) => name === "content");
  return { text: content?.text || "", channel: content?.name || null };
}

function streamStateSnapshot(stream, tailLength = 2400) {
  if (!stream || typeof stream !== "object") return null;
  const boundedTail = Math.max(0, Number(tailLength) || 0);
  const tail = (text) => boundedTail > 0 ? text.slice(-boundedTail) : "";
  const channels = Object.fromEntries(Object.entries(stream.channels || {})
    .filter(([name, text]) => name !== "role" && typeof text === "string")
    .map(([name, text]) => [name, tail(text)]));
  return {
    streamId: stream.streamId || null,
    taskId: stream.taskId || null,
    operationId: stream.operationId || null,
    kind: stream.kind || null,
    provider: stream.provider || null,
    sequence: Number(stream.sequence || 0),
    text: typeof stream.text === "string" ? tail(stream.text) : "",
    channels,
    terminal: Boolean(stream.terminal),
    startedAt: stream.startedAt || null,
    lastCheckpointAt: stream.lastCheckpointAt || null,
    lastCheckpointBytes: Number(stream.lastCheckpointBytes || 0),
    abortReason: stream.abortReason || null,
  };
}

function extractModelDelta(payload) {
  const choice = payload?.choices?.[0] || {};
  const delta = choice.delta || {};
  const channels = extractModelChannels(delta);
  return {
    text: channels.find((channel) => channel.name === "content")?.text || "",
    channels,
    finishReason: choice.finish_reason || null,
    usage: payload?.usage || null,
  };
}

function createStreamId(prefix = "stream") {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

module.exports = {
  Utf8SseParser,
  parseSsePayload,
  extractModelChannels,
  extractModelDelta,
  compactModelPayload,
  selectStructuredActionText,
  streamStateSnapshot,
  createStreamId,
  digest,
};
