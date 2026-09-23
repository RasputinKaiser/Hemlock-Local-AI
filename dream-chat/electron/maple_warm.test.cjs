const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

// maple.warm host tests. Same harness as experiment_suggest.test.cjs: main.cjs
// is loaded once with a mocked "electron" module and HEMLOCK_DATA_DIR pointed
// at a throwaway directory; the agent:command handler is captured and invoked
// directly. globalThis.fetch is stubbed so the adopted-server path, the launch
// warmup probe, and the warm prefill all run without a real MLX server.

const ipcHandlers = new Map();

class FakeNotification {
  constructor(options) {
    this.options = options;
  }
  show() {}
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hemlock-maple-warm-test-"));
process.env.HEMLOCK_DATA_DIR = dataDir;

const electronMock = {
  app: {
    name: "Hemlock",
    isPackaged: true,
    requestSingleInstanceLock: () => true,
    on() {},
    quit() {},
    whenReady: () => new Promise(() => {}), // never resolve: no window is created
    commandLine: { appendSwitch() {} },
  },
  BrowserWindow: class {
    static getAllWindows() {
      return [];
    }
  },
  Notification: FakeNotification,
  ipcMain: {
    handle(channel, handler) {
      ipcHandlers.set(channel, handler);
    },
  },
  shell: { openExternal: async () => {}, showItemInFolder: () => {} },
  dialog: {
    showMessageBox: async () => ({ response: 1 }),
    showOpenDialog: async () => ({ canceled: true }),
  },
};

// Stub fetch BEFORE loading main.cjs: the adopted-server health probe, the
// launch inference probe, and maple.warm's prefill all go through it.
const warmBodies = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  const target = String(url);
  if (target.endsWith("/health")) return new Response("ok", { status: 200 });
  if (target.endsWith("/v1/chat/completions")) {
    const body = options.body ? JSON.parse(options.body) : {};
    warmBodies.push(body);
    return new Response(JSON.stringify({
      id: "chatcmpl-warm-test",
      choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "length" }],
      usage: { prompt_tokens: 640, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 0 } },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  return new Response("not found", { status: 404 });
};

const originalLoad = Module._load;
Module._load = function mockedLoad(request, parent, isMain) {
  if (request === "electron") return electronMock;
  return originalLoad.call(this, request, parent, isMain);
};
const mainPath = path.resolve(__dirname, "main.cjs");
delete require.cache[mainPath];
let hostExports;
try {
  hostExports = require(mainPath);
} finally {
  Module._load = originalLoad;
}

// The throwaway HEMLOCK_DATA_DIR is intentionally not deleted: deferred journal
// writers may still flush into it after this file exits.

const command = (payload) => ipcHandlers.get("agent:command")({}, payload);
const agentState = () => ipcHandlers.get("agent:state")();

async function waitForEvent(type, { timeoutMs = 8000, status } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = agentState().events.filter((event) => event.type === type && (!status || event.status === status));
    if (events.length) return events.at(-1);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
}

test("maple.server.ready triggers a warm prefill that emits maple.warm.prefill", async () => {
  // Adopted-server path: health already answers, so launch marks the process
  // ready, fires maple.server.ready, and the hook warms the shared prefix.
  const launched = await command({ action: "maple.launch" });
  assert.equal(launched.processReady, true);
  const event = await waitForEvent("maple.warm.prefill", { status: "passed" });
  assert.ok(event, "maple.warm.prefill passed event was emitted");
  assert.equal(event.payload.reason, "server-ready");
  assert.equal(typeof event.payload.elapsedMs, "number");
  assert.equal(event.payload.usage.prompt_tokens, 640);
  assert.equal(event.payload.usage.cached_tokens, 0);
  // The warm request carries the structured-action system block — the shared
  // prefix region the first real step needs — with a 1-token cap.
  const warm = warmBodies.find((body) => body.max_tokens === 1 && body.temperature === 0 && body.stream === false && body.messages?.[0]?.role === "system" && body.messages[0].content.includes("You are Maple-Preview operating inside Hemlock."));
  assert.ok(warm, "warm prefill posted the structured-action system prefix");
});

test("maple.warm inside the cooldown window is skipped, not sent", async () => {
  const bodiesBefore = warmBodies.length;
  const result = await command({ action: "maple.warm", reason: "test-cooldown" });
  assert.equal(result.status, "skipped");
  assert.equal(result.skipped, "cooldown");
  assert.equal(warmBodies.length, bodiesBefore, "no warm request was posted");
  const event = agentState().events.filter((item) => item.type === "maple.warm.prefill").at(-1);
  assert.equal(event.status, "skipped");
  assert.equal(event.payload.skipped, "cooldown");
  assert.equal(event.payload.reason, "test-cooldown");
});

test("maple.warm is skipped while a stream is active", async () => {
  const stream = hostExports.__mapleWarm.startStream({ kind: "model_text", provider: "maple" });
  try {
    const result = await command({ action: "maple.warm", reason: "test-stream" });
    assert.equal(result.status, "skipped");
    assert.equal(result.skipped, "stream-active");
  } finally {
    hostExports.__mapleWarm.finishStream(stream, { status: "completed" });
  }
});

test("maple.warm degrades cleanly on transport failure instead of throwing", async () => {
  // The fetch stub now fails every request; the warm must emit a degraded
  // event and return a degraded result rather than throwing into the caller.
  const stub = globalThis.fetch;
  globalThis.fetch = async () => new Response("down", { status: 500 });
  try {
    // Cooldown from the first test still applies; clear it via the state
    // seam so this test exercises the transport path itself.
    hostExports.__mapleWarm.state().lastWarmAt = 0;
    const result = await command({ action: "maple.warm", reason: "test-degraded" });
    assert.equal(result.status, "degraded");
    const event = await waitForEvent("maple.warm.prefill", { status: "degraded" });
    assert.ok(event, "degraded maple.warm.prefill event was emitted");
    assert.equal(event.payload.reason, "test-degraded");
  } finally {
    globalThis.fetch = stub;
  }
});
