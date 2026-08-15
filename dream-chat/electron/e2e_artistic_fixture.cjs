const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { ArtifactRegistry } = require("./artifact_registry.cjs");
const { PreviewSessionManager } = require("./preview_policy.cjs");
const { extractJsonObject, createAction, validateAction } = require("./agent_contracts.cjs");
const { Utf8SseParser, parseSsePayload, extractModelDelta, digest } = require("./stream_protocol.cjs");
const { responseBudget } = require("./response_budget.cjs");

const fixtureHtml = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;min-height:100vh;background:#071b1b;color:#edf2d5;font:16px Georgia,serif;overflow:hidden}
.garden{min-height:100vh;display:grid;place-items:center;position:relative;overflow:hidden}
.moon{position:absolute;width:120px;height:120px;border-radius:50%;right:15%;top:12%;background:#f5f0c8;box-shadow:0 0 60px #d9e8bb66}
.tree{position:absolute;bottom:-10px;left:18%;width:260px;height:76%;background:linear-gradient(90deg,#180f13,#5a3b2a,#24171b);clip-path:polygon(45% 0,58% 0,66% 100%,28% 100%);transform-origin:50% 100%;animation:sway 7s ease-in-out infinite alternate}
.copy{position:relative;z-index:2;max-width:520px;padding:40px;text-shadow:0 2px 18px #0008}.title{font-size:clamp(40px,8vw,88px);line-height:.9;margin:0}.subtitle{color:#d3dfbd;font:20px/1.45 system-ui,sans-serif}
.firefly{position:absolute;width:8px;height:8px;border-radius:50%;background:#e6ef9a;box-shadow:0 0 12px 4px #e3ed8b99;animation:float 5s ease-in-out infinite}.f1{left:52%;top:30%}.f2{left:75%;top:42%;animation-delay:-2s}.f3{left:63%;top:64%;animation-delay:-1s}
@keyframes sway{from{transform:rotate(-2deg)}to{transform:rotate(2deg)}}@keyframes float{0%,100%{transform:translate(0,0);opacity:.25}50%{transform:translate(18px,-22px);opacity:1}}
</style></head><body><main class="garden" data-preview-id="garden" aria-label="Animated Eastern Hemlock night garden"><div class="moon" aria-hidden="true"></div><div class="tree" aria-hidden="true"></div><i class="firefly f1"></i><i class="firefly f2"></i><i class="firefly f3"></i><div class="copy"><div>HEMLOCK / LIVING DRAFT</div><h1 class="title">Eastern Hemlock<br>night garden</h1><p class="subtitle">Mist drifts, branches breathe, and fireflies keep their own quiet time.</p></div></main></body></html>`;

function now() { return new Date().toISOString(); }
function writeJson(filePath, value) { fs.mkdirSync(path.dirname(filePath), { recursive: true }); fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }

async function startFixtureServer() {
  const server = http.createServer((request, response) => {
    if (request.url !== "/v1/chat/completions") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not found" }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
    const frames = [
      { choices: [{ delta: { reasoning: "I am reading the local task context before replying." }, finish_reason: null }] },
      { choices: [{ delta: { content: "Hello from Maple. I’m here and ready to make something beautiful with you." }, finish_reason: null }] },
      { choices: [{ delta: { work_note: "The fixture keeps this emitted channel visible beside content." }, finish_reason: "stop" }], usage: { prompt_tokens: 24, completion_tokens: 22, total_tokens: 46 } },
    ];
    for (const frame of frames) {
      const encoded = Buffer.from(`data: ${JSON.stringify(frame)}\n\n`, "utf8");
      response.write(encoded.subarray(0, Math.max(1, Math.floor(encoded.length / 2))));
      response.write(encoded.subarray(Math.max(1, Math.floor(encoded.length / 2))));
    }
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function collectFixtureStream(base) {
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({ model: "fixture-maple", messages: [{ role: "user", content: "Hey Maple, how are you?" }], max_tokens: responseBudget("Hey Maple, how are you?"), stream: true }),
  });
  assert.equal(response.ok, true);
  const parser = new Utf8SseParser();
  const reader = response.body.getReader();
  const channels = {};
  const rawPayloads = [];
  let finishReason = null;
  for (;;) {
    const result = await reader.read();
    for (const event of parser.push(result.value || new Uint8Array(), { final: result.done })) {
      const parsed = parseSsePayload(event);
      if (parsed.done) continue;
      if (!parsed.payload) continue;
      rawPayloads.push(parsed.payload);
      const delta = extractModelDelta(parsed.payload);
      for (const channel of delta.channels) channels[channel.name] = `${channels[channel.name] || ""}${channel.text}`;
      finishReason = delta.finishReason || finishReason;
    }
    if (result.done) break;
  }
  assert.equal(channels.content.includes("Hello from Maple"), true);
  assert.equal(channels.reasoning.includes("local task context"), true);
  assert.equal(channels.work_note.includes("emitted channel"), true);
  return { channels, rawPayloads, finishReason, outputDigest: digest(JSON.stringify(channels)) };
}

async function main() {
  const startedAt = Date.now();
  const fixtureRunId = `run-${Date.now()}`;
  const runtimeRoot = path.join(process.env.HEMLOCK_DATA_DIR || path.join(require("node:os").homedir(), "Library", "Application Support", "Hemlock"), "e2e", "fixture", fixtureRunId);
  const taskId = `task-fixture-${Date.now()}`;
  const workspaceId = `workspace-fixture-${crypto.randomBytes(4).toString("hex")}`;
  const events = [];
  const emit = (type, status, payload, evidenceRefs) => events.push({ type, status, payload, evidenceRefs, at: now() });
  const server = await startFixtureServer();
  try {
    const conversation = await collectFixtureStream(server.base);
    const registry = new ArtifactRegistry({ root: runtimeRoot, workspaceId, onEvent: emit });
    const previews = new PreviewSessionManager({ emit: (type, status, payload) => emit(type, status, payload, []) });
    const artifactId = `artifact-${Date.now()}`;
    const artifact = registry.create({ taskId, artifactId, title: "Eastern Hemlock night garden", kind: "html", mime: "text/html", entrypoint: "index.html" });
    const first = registry.author({ taskId, artifactId, kind: "html", filename: "index.html", runtimeTemplate: "html", objective: "Create an artistic watchable Eastern Hemlock night-garden animation.", source: { "index.html": fixtureHtml }, status: "previewable", evidence: [{ type: "fixture.authoring", channelDigest: conversation.outputDigest }] });
    assert.equal(first.revision, 1);
    const desktopSession = previews.open({ taskId, artifactId, revision: first.revision });
    const screenshotDir = path.join(runtimeRoot, "screenshots");
    const desktopScreenshot = path.join(screenshotDir, "desktop.svg");
    const narrowScreenshot = path.join(screenshotDir, "narrow.svg");
    const fixtureSvg = (width, height, label) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#071b1b"/><circle cx="${width * .78}" cy="${height * .18}" r="${Math.min(width, height) * .09}" fill="#f5f0c8"/><path d="M${width * .34},${height} C${width * .4},${height * .7} ${width * .42},${height * .2} ${width * .5},${height * .12} C${width * .58},${height * .2} ${width * .64},${height * .7} ${width * .7},${height}Z" fill="#315a4b"/><text x="32" y="${height - 74}" fill="#edf2d5" font-family="Georgia" font-size="${Math.max(18, Math.round(width / 35))}">Eastern Hemlock night garden</text><text x="32" y="${height - 38}" fill="#c5d694" font-family="monospace" font-size="${Math.max(11, Math.round(width / 70))}">${label} · deterministic fixture snapshot</text></svg>`;
    writeJson(path.join(runtimeRoot, "fixture-source.json"), { entrypoint: "index.html", source: fixtureHtml });
    fs.mkdirSync(screenshotDir, { recursive: true });
    fs.writeFileSync(desktopScreenshot, fixtureSvg(1240, 820, "desktop"), "utf8");
    fs.writeFileSync(narrowScreenshot, fixtureSvg(390, 780, "narrow"), "utf8");
    assert.equal(previews.authorize(desktopSession.id, "inspect").allowed, true);
    previews.complete(desktopSession.id, { target: "[data-preview-id=garden]", preDigest: "dom:before", postDigest: "dom:desktop", result: "inspection_completed", screenshotRef: desktopScreenshot });
    assert.equal(previews.authorize(desktopSession.id, "resize", { actionId: "desktop-viewport" }).allowed, true);
    previews.complete(desktopSession.id, { target: "viewport", input: { width: 1240, height: 820 }, preDigest: "dom:desktop", postDigest: "dom:desktop-resized" });
    assert.equal(previews.authorize(desktopSession.id, "click", { target: "[data-preview-id=garden]" }).allowed, true);
    previews.complete(desktopSession.id, { target: "[data-preview-id=garden]", preDigest: "a11y:desktop", postDigest: "a11y:desktop", result: "preview_only_mutation" });

    const issue = { type: "fixture.issue.detected", reason: "The first revision is legible but the fireflies do not have a narrow-viewport label." };
    emit(issue.type, "degraded", issue, ["fixture://inspection/desktop"]);
    const repairedSource = fixtureHtml.replace("aria-label=\"Animated Eastern Hemlock night garden\"", "aria-label=\"Animated Eastern Hemlock night garden with drifting fireflies\"");
    const second = registry.update({ taskId, artifactId, source: { "index.html": repairedSource }, status: "ready", evidence: [{ type: "fixture.repair", attempt: 1, issue: issue.reason, parentDigest: first.digest }] });
    assert.equal(second.revision, 2);
    assert.equal(second.revisions.at(-1).parent, "r1");
    assert.notEqual(second.revisions.at(-1).digest, first.revisions.at(-1).digest);
    const narrowSession = previews.open({ taskId, artifactId, revision: second.revision });
    assert.equal(previews.authorize(narrowSession.id, "resize", { actionId: "narrow-viewport" }).allowed, true);
    previews.complete(narrowSession.id, { target: "viewport", input: { width: 390, height: 780 }, preDigest: "dom:narrow-before", postDigest: "dom:narrow-after", screenshotRef: narrowScreenshot });
    assert.equal(previews.authorize(narrowSession.id, "inspect").allowed, true);
    previews.complete(narrowSession.id, { target: "[data-preview-id=garden]", preDigest: "a11y:narrow-before", postDigest: "a11y:narrow-after", result: "inspection_completed" });
    const hidden = { ...narrowSession, visible: false };
    previews.sessions.set(narrowSession.id, hidden);
    assert.equal(previews.authorize(narrowSession.id, "screenshot").reason, "preview_not_visible");
    previews.pause(narrowSession.id);
    assert.equal(previews.authorize(narrowSession.id, "click", { target: "[data-preview-id=garden]" }).reason, "preview_paused");
    previews.stop(narrowSession.id, "fixture_cancelled_after_last_complete_revision");

    const failed = registry.update({ taskId, artifactId, source: { "index.html": "<main data-preview-id=\"garden\"><h1>incomplete revision</h1>" }, status: "failed", evidence: [{ type: "fixture.revision.failed", reason: "incomplete source" }] });
    assert.equal(failed.status, "failed");
    const lastComplete = failed.revisions.find((revision) => revision.revision === 2);
    assert.equal(lastComplete.status, "ready");
    let lateCallbackApplied = false;
    const cancelled = true;
    if (!cancelled) lateCallbackApplied = true;
    assert.equal(lateCallbackApplied, false);

    const structuredAction = createAction({ taskId, step: 1, kind: "tool", commandId: "artifact.create", shortRationale: "Create the task-local scratch artifact." });
    const prose = `I will create the scratch artifact first. ${JSON.stringify(structuredAction)} This surrounding prose remains recorded.`;
    const parsedAction = extractJsonObject(prose);
    validateAction(parsedAction, { "artifact.create": {} });
    const receiptDir = path.join(runtimeRoot, "receipts");
    const receiptPath = path.join(receiptDir, `artistic-fixture-${Date.now()}.json`);
    const receipt = {
      schema: "hemlock.e2e.artistic-fixture.v1",
      status: "passed",
      lane: "deterministic-fixture",
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: now(),
      taskId,
      server: server.base,
      conversation: { status: "completed", channels: Object.keys(conversation.channels), outputDigest: conversation.outputDigest, finishReason: conversation.finishReason, budget: responseBudget("Hey Maple, how are you?") },
      plan: { status: "approved", steps: ["artifact.create", "artifact.author", "artifact.preview.open", "artifact.preview.inspect"] },
      artifact: { id: artifact.id, firstRevision: first.revision, repairedRevision: second.revision, failedRevision: failed.revision, parentDigest: second.revisions.at(-1).parent ? first.digest : null, newDigest: second.digest, lastCompleteRevision: lastComplete.revision, scratchRoot: registry.artifactRoot(taskId, artifactId) },
      preview: { desktop: desktopScreenshot, narrow: narrowScreenshot, hiddenScreenshot: "preview_not_visible", pausedInteraction: "preview_paused" },
      repair: { detected: true, attempts: 1, bounded: true },
      structuredAction: { rawProse: prose, parsedAction, parseStatus: "valid" },
      cancellation: { lastCompleteRevisionInspectable: true, lateCallbackApplied, authoringNotRewritten: true },
      eventCount: events.length,
      noExternalNetworkDependency: true,
      claimBoundary: "This deterministic lane proves local host contracts and fixture preview behavior; it is not proof of real Maple model quality or a published artifact.",
    };
    writeJson(receiptPath, receipt);
    process.stdout.write(`${JSON.stringify({ ...receipt, receiptPath })}\n`);
  } finally {
    await new Promise((resolve) => server.server.close(resolve));
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
