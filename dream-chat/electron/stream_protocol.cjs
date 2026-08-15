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
    .filter(([, text]) => typeof text === "string" && text.length > 0)
    .map(([name, text]) => ({ name, text }));
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

module.exports = { Utf8SseParser, parseSsePayload, extractModelChannels, extractModelDelta, createStreamId, digest };
