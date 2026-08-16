const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Utf8SseParser, parseSsePayload, extractModelDelta, extractModelChannels, digest } = require("./stream_protocol.cjs");
const { coerceActionPayload, extractActionEnvelope } = require("./agent_contracts.cjs");

const base = String(process.env.HEMLOCK_MAPLE_BASE || "http://127.0.0.1:8080").replace(/\/$/, "");
const maxMs = Number(process.env.HEMLOCK_MAPLE_MAX_MS || 180000);
const requestedMapleMaxTokens = Number(process.env.HEMLOCK_MAPLE_MAX_TOKENS);
const mapleMaxTokens = Number.isFinite(requestedMapleMaxTokens)
  ? Math.max(4096, requestedMapleMaxTokens)
  : 16384;
const startedAt = Date.now();
const receiptDir = path.join(os.homedir(), "Library", "Application Support", "Hemlock", "e2e", "maple");

const VARIATIONS = [
  {
    id: "css-dom",
    title: "CSS and DOM choreography",
    prompt: "Author a self-contained HTML animation variation using CSS keyframes and ordinary DOM elements: a warm window at dusk, drifting curtains, and soft moths. Favor elegant layout and readable HTML. Do not use canvas or external assets.",
  },
  {
    id: "svg-botanical",
    title: "SVG botanical motion",
    prompt: "Author a self-contained HTML animation variation built around inline SVG: a moonlit botanical illustration with leaves swaying, a moon moving behind clouds, and tiny glowing seeds. Use accessible labels and SVG animation or CSS transforms. Do not use external assets.",
  },
  {
    id: "canvas-particles",
    title: "Canvas particle field",
    prompt: "Author a self-contained HTML animation variation using one canvas: a deep-ocean bioluminescent particle field with gentle currents and a readable title overlay. Keep the JavaScript concise, bounded, and free of network calls.",
  },
  {
    id: "kinetic-cards",
    title: "Kinetic editorial cards",
    prompt: "Author a self-contained HTML animation variation using CSS and semantic HTML: three editorial cards that enter, breathe, and rearrange into a calm constellation. Use prefers-reduced-motion and keep the visual language distinct from a nature scene.",
  },
];

const requestedVariationIds = String(process.env.HEMLOCK_MAPLE_VARIATION_IDS || "").split(",").map((value) => value.trim()).filter(Boolean);
const variationPool = requestedVariationIds.length ? VARIATIONS.filter((variation) => requestedVariationIds.includes(variation.id)) : VARIATIONS;
const variationLimit = Math.max(1, Math.min(variationPool.length, Number(process.env.HEMLOCK_MAPLE_VARIATION_LIMIT || variationPool.length)));
const activeVariations = variationPool.slice(0, variationLimit);

function remainingMs() { return Math.max(1000, maxMs - (Date.now() - startedAt)); }

async function request(body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("maple_variation_budget"), remainingMs());
  try {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: body.stream ? "text/event-stream" : "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const contentType = response.headers.get("content-type") || "";
    if (body.stream && response.body && typeof response.body.getReader === "function" && contentType.toLowerCase().includes("text/event-stream")) {
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
      const payload = { choices: [{ message: channels, finish_reason: finishReason }], usage };
      return { payload, message: channels, channels, rawPayloads, finishReason };
    }
    const payload = await response.json();
    if (!response.ok) throw new Error(`Maple HTTP ${response.status}: ${JSON.stringify(payload).slice(0, 500)}`);
    const message = payload?.choices?.[0]?.message || {};
    return {
      payload,
      message,
      channels: Object.fromEntries(extractModelChannels(message).map((channel) => [channel.name, channel.text])),
      finishReason: payload?.choices?.[0]?.finish_reason || null,
    };
  } finally {
    clearTimeout(timer);
  }
}

function sourceProfile(source) {
  const files = Object.entries(source || {}).filter(([file, content]) => typeof file === "string" && typeof content === "string");
  const html = files.map(([, content]) => content).join("\n");
  const signatures = [
    html.includes("<svg") ? "svg" : null,
    html.includes("<canvas") ? "canvas" : null,
    /@keyframes|animation\s*:/.test(html) ? "css-animation" : null,
    /requestAnimationFrame/.test(html) ? "raf" : null,
    /prefers-reduced-motion/.test(html) ? "reduced-motion" : null,
    /<main\b|<article\b|<section\b/.test(html) ? "semantic-dom" : null,
  ].filter(Boolean);
  return { fileCount: files.length, chars: html.length, digest: digest(JSON.stringify(source)), signatures };
}

async function main() {
  const receipt = {
    schema: "hemlock.e2e.artistic-maple-variations.v1",
    lane: "real-maple",
    status: "blocked",
    base,
    startedAt: new Date(startedAt).toISOString(),
    expectedVariants: activeVariations.map(({ id, title }) => ({ id, title })),
    variants: [],
    claimBoundary: "This lane tests that Maple can author multiple bounded source variations. It does not claim that any variation passed renderer, accessibility, runtime, or visual-quality verification until the Electron preview handshake runs.",
  };
  for (const variation of activeVariations) {
    const variantStartedAt = Date.now();
    let response = null;
    try {
      response = await request({
        model: "default_model",
        messages: [
          {
            role: "system",
            content: "You are Maple-Preview authoring inside Hemlock. Use the reasoning channel as needed, then return one JSON object only in the content channel, with no markdown or prose. For artifact.author, provide a complete relative-file source map under input.source, or return the direct file map itself. The host will wrap the response in its action envelope. Use only task-local self-contained HTML; no external assets, network calls, or shell commands. Keep index.html compact and under 2200 characters. Preserve the requested visual concept: distinct variations are allowed and encouraged; do not substitute a fixed template.",
          },
          { role: "user", content: `${variation.prompt} Keep the complete index.html under 2200 characters. Return a compact JSON authoring payload now.` },
        ],
        temperature: 0,
        top_p: 1,
        top_k: 0,
        max_tokens: mapleMaxTokens,
        stream: true,
        response_format: { type: "json_object" },
        chat_template_kwargs: { enable_thinking: true },
      });
      const content = String(response.channels.content || response.message.content || "").trim();
      const parsed = extractActionEnvelope(content);
      const action = coerceActionPayload(parsed, { taskId: `variation-${variation.id}`, step: 1, commandId: "artifact.author", expectedEvidence: ["artifact://revision"] }) || parsed;
      const source = action?.input?.source;
      if (!source || typeof source !== "object" || Array.isArray(source) || !Object.keys(source).length) throw new Error("Maple returned no complete input.source file map.");
      const profile = sourceProfile(source);
      if (!Object.keys(source).every((file) => !file.startsWith("/") && !file.split("/").some((part) => part === ".." || part === "." || !part))) throw new Error("Maple returned an unsafe relative source path.");
      receipt.variants.push({ id: variation.id, title: variation.title, status: "passed", parseStatus: action.__coercedPayload ? "coerced-payload" : action.__recoveredTruncated ? "recovered-truncated" : "parsed", finishReason: response.finishReason, usage: response.payload?.usage || null, profile, elapsedMs: Date.now() - variantStartedAt, outputDigest: digest(JSON.stringify(response.channels)) });
    } catch (error) {
      receipt.variants.push({
        id: variation.id,
        title: variation.title,
        status: "failed",
        error: error.message,
        elapsedMs: Date.now() - variantStartedAt,
        modelOutput: response ? {
          channelNames: Object.keys(response.channels || {}),
          channelLengths: Object.fromEntries(Object.entries(response.channels || {}).map(([name, value]) => [name, String(value).length])),
          contentTail: String(response.channels?.content || "").slice(-1200),
          reasoningTail: String(response.channels?.reasoning || "").slice(-500),
          finishReason: response.finishReason || null,
        } : null,
      });
    }
  }
  const passed = receipt.variants.filter((item) => item.status === "passed");
  const uniqueDigests = new Set(passed.map((item) => item.profile.digest));
  receipt.summary = { requested: activeVariations.length, passed: passed.length, failed: activeVariations.length - passed.length, uniqueSourceCount: uniqueDigests.size, variationDiversity: passed.length >= 2 && uniqueDigests.size >= Math.min(3, passed.length) ? "varied" : "limited_or_repeated" };
  receipt.status = passed.length === activeVariations.length ? "passed" : "blocked";
  receipt.stopReason = receipt.status === "passed" ? "All requested authoring variations produced bounded source maps; renderer verification remains a separate host gate." : "One or more requested authoring variations did not produce a bounded source map.";
  receipt.elapsedMs = Date.now() - startedAt;
  receipt.finishedAt = new Date().toISOString();
  const receiptPath = path.join(receiptDir, `artistic-variations-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ ...receipt, receiptPath })}\n`);
  if (receipt.status !== "passed") process.exitCode = 1;
}

main().catch((error) => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });
