const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Utf8SseParser, parseSsePayload, extractModelDelta, extractModelChannels, digest } = require("./stream_protocol.cjs");
const { extractJsonObject } = require("./agent_contracts.cjs");
const { responseBudget } = require("./response_budget.cjs");

const base = String(process.env.HEMLOCK_MAPLE_BASE || "http://127.0.0.1:8080").replace(/\/$/, "");
const maxMs = Number(process.env.HEMLOCK_MAPLE_MAX_MS || 600000);
const startedAt = Date.now();
const receiptDir = path.join(os.homedir(), "Library", "Application Support", "Hemlock", "e2e", "maple");

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function remainingMs() { return Math.max(1000, maxMs - (Date.now() - startedAt)); }

async function requestCompletion(body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("maple-e2e-budget"), remainingMs());
  try {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: body.stream ? "text/event-stream" : "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const contentType = response.headers.get("content-type") || "";
    if (!response.ok) {
      const raw = await response.text();
      throw new Error(`Maple HTTP ${response.status}: ${raw.slice(0, 500)}`);
    }
    if (body.stream && response.body && contentType.toLowerCase().includes("text/event-stream")) {
      const parser = new Utf8SseParser();
      const reader = response.body.getReader();
      const channels = {};
      const rawPayloads = [];
      let usage = null;
      let finishReason = null;
      for (;;) {
        const result = await reader.read();
        for (const event of parser.push(result.value || new Uint8Array(), { final: result.done })) {
          const parsed = parseSsePayload(event);
          if (parsed.done || !parsed.payload) continue;
          rawPayloads.push(parsed.payload);
          const delta = extractModelDelta(parsed.payload);
          for (const channel of delta.channels) channels[channel.name] = `${channels[channel.name] || ""}${channel.text}`;
          usage = delta.usage || usage;
          finishReason = delta.finishReason || finishReason;
        }
        if (result.done) break;
      }
      return { channels, rawPayloads, usage, finishReason, streaming: true };
    }
    const payload = await response.json();
    const message = payload?.choices?.[0]?.message || {};
    return { channels: Object.fromEntries(extractModelChannels(message).map((channel) => [channel.name, channel.text])), rawPayloads: [payload], usage: payload.usage || null, finishReason: payload?.choices?.[0]?.finish_reason || null, streaming: false };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const receipt = {
    schema: "hemlock.e2e.artistic-maple.v1",
    lane: "real-maple",
    status: "blocked",
    base,
    startedAt: new Date(startedAt).toISOString(),
    requests: [],
    claimBoundary: "This lane reports the actual local Maple endpoint state. It is complete only after conversation, plan, artifact, preview, revision, repair, and final receipt all complete.",
  };
  try {
    const conversationBody = { model: "default_model", messages: [{ role: "user", content: "Hey Maple, how are you? I want to make something beautiful together." }], temperature: 0.7, top_p: 0.95, top_k: 20, max_tokens: responseBudget("Hey Maple, how are you? I want to make something beautiful together."), stream: true };
    const conversation = await requestCompletion(conversationBody);
    receipt.requests.push({ kind: "conversation", status: "completed", max_tokens: conversationBody.max_tokens, streaming: conversation.streaming, channels: Object.keys(conversation.channels), contentDigest: digest(conversation.channels.content || ""), outputDigest: digest(JSON.stringify(conversation.channels)), rawPayloads: conversation.rawPayloads });
    const actionBody = { model: "default_model", messages: [{ role: "system", content: "You are Maple operating inside Hemlock. Return exactly one concise hemlock.agent.action.v1 JSON envelope in the content channel; any reasoning channel remains model output and is recorded separately. Use kind=tool, commandId=artifact.create, approval=plan, and status=proposed. Do not include prose in the content channel." }, { role: "user", content: "Create a bounded task-local HTML animation artifact for a watchable Eastern Hemlock night-garden scene with a moon, tree sway, mist, and fireflies. Return the registered action envelope only." }], temperature: 0, top_p: 1, top_k: 0, max_tokens: 4096, stream: false, response_format: { type: "json_object" } };
    const action = await requestCompletion(actionBody);
    const rawContent = action.channels.content || "";
    let parseStatus = "empty";
    let parsedAction = null;
    if (rawContent.trim()) {
      try { parsedAction = extractJsonObject(rawContent); parseStatus = "parsed"; } catch (error) { parseStatus = `invalid:${error.message}`; }
    }
    receipt.requests.push({ kind: "structured-action", status: parsedAction ? "parsed" : "failed", max_tokens: actionBody.max_tokens, streaming: action.streaming, channels: Object.keys(action.channels), outputDigest: digest(JSON.stringify(action.channels)), parseStatus, parsedAction, rawPayloads: action.rawPayloads });
    if (!parsedAction) throw new Error(`Real Maple lane stopped after structured-action output was ${parseStatus}.`);
    receipt.status = "blocked";
    receipt.stopReason = "This runner intentionally does not fabricate host artifact execution from a model envelope; full artifact/preview/revision proof requires the Electron live bridge and remains unclaimed here.";
  } catch (error) {
    receipt.stopReason = error.name === "AbortError" ? "maple_wall_clock_budget_exhausted" : error.message;
    receipt.elapsedMs = Date.now() - startedAt;
  }
  receipt.elapsedMs ||= Date.now() - startedAt;
  receipt.finishedAt = new Date().toISOString();
  const receiptPath = path.join(receiptDir, `artistic-maple-${Date.now()}.json`);
  writeJson(receiptPath, receipt);
  process.stdout.write(`${JSON.stringify({ ...receipt, receiptPath })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
