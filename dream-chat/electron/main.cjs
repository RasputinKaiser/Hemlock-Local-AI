const { app, BrowserWindow, Notification, ipcMain, shell, dialog } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { ContextBroker } = require("./context_broker.cjs");
const { AgentKernel } = require("./agent_kernel.cjs");
const { AgentOrchestrator } = require("./agent_orchestrator.cjs");
const { AgentIntentQueue, isActiveTask, safePayload } = require("./agent_queue.cjs");
const { DEFAULT_BUDGET, mergeBudget, clampBudgetOverrides, compactObservation } = require("./agent_contracts.cjs");
const { ThreadManager, DEFAULT_PROVIDER_CAPS, PARKABLE_THREAD_STATUSES, workspaceFingerprint } = require("./thread_manager.cjs");
const { CodingWorkspace } = require("./coding_workspace.cjs");
const { CodingAutopilot } = require("./coding_autopilot.cjs");
const { chooseVerificationProfile, verificationSummary, skippedVerification } = require("./verification_profile.cjs");
const { assertAnswerable } = require("./task_answer.cjs");
const { ContextSourceRegistry } = require("./context_sources.cjs");
const { ArtifactRegistry } = require("./artifact_registry.cjs");
const { ChangeSetApplier } = require("./changeset_apply.cjs");
const { PreviewSessionManager } = require("./preview_policy.cjs");
const { recordCrash, sanitizeCrashHistory, shouldRespawn } = require("./crash_policy.cjs");
const { createHealthMonitor } = require("./health_monitor.cjs");
const { nextReadinessDelay, classifyHealthFailure, missingCheckpointItem } = require("./readiness_probe.cjs"); // T9-H1
const { cacheStats } = require("./prompt_cache_stats.cjs");
const { Utf8SseParser, parseSsePayload, extractModelChannels, extractModelDelta, compactModelPayload, selectStructuredActionText, streamStateSnapshot, createStreamId, shouldCheckpointStream, digest: streamDigest } = require("./stream_protocol.cjs");
const { createStreamFrameCoalescer } = require("./stream_dispatcher.cjs");
const { firstTokenWatchdog, DEFAULT_STALL_MS } = require("./stream_watchdog.cjs");
const {
  PROVIDER_DEFINITIONS,
  normalizeSelection,
  parseProviderLine,
} = require("./provider_adapters.cjs");
const {
  createMapleLaunchResult,
  compactInferenceMessages,
  isMapleTransportError,
} = require("./maple_runtime.cjs");
const { classifyIntent: classifyScopedIntent, resolveInteraction } = require("./interaction_modes.cjs");
const { shouldAutoDemote } = require("./memory_fitness.cjs");
const { buildGroundedContext } = require("./prompt_context.cjs");
const { applyDigestCompaction, insertDigestBlock } = require("./thread_digest.cjs");
const { verifyArtifactSource, verifyPreviewReport } = require("./artifact_verifier.cjs");
const { createWorkNotifier, trackChatResponseJob } = require("./work_notifications.cjs");
const { COMPARISON_SCHEMA, canRunComparison, lastUserMessage, buildComparisonRecord } = require("./comparison_lane.cjs");
const { runExperiment, EXPERIMENTS, suggestExperiments } = require("./physics_sandbox.cjs");
const { resolveExec, EXEC_OUTPUT_LIMIT } = require("./shell_exec.cjs");
const { appendJsonlLine, quarantineCorruptFile, readJsonFile: readJsonDurable, readJsonlFile, writeFileAtomic, writeJsonAtomic } = require("./durable_io.cjs");

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const [window] = BrowserWindow.getAllWindows();
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
}

const repoRoot = path.resolve(__dirname, "..", "..");
const pythonCandidates = [
  process.env.HEMLOCK_PYTHON,
  process.env.MAPLE_PYTHON,
  path.join(os.homedir(), "Models", "Hemlock", "runtime", "bin", "python"),
  path.join(repoRoot, ".venv", "bin", "python"),
].filter(Boolean).map((candidate) => path.resolve(candidate));
const python = pythonCandidates.find((candidate) => fs.existsSync(candidate)) || pythonCandidates[0];
const pythonFlags = ["-S"];
const pythonArchitecture = (() => {
  const requested = String(process.env.HEMLOCK_PYTHON_ARCH || "").trim().toLowerCase();
  if (requested === "arm64" || requested === "x86_64") return requested;
  if (process.platform !== "darwin") return null;
  return process.arch === "arm64" ? "arm64" : "x86_64";
})();
const pythonLaunch = pythonArchitecture && fs.existsSync("/usr/bin/arch")
  ? { command: "/usr/bin/arch", args: [`-${pythonArchitecture}`, python] }
  : { command: python, args: [] };

function resolveChildInvocation(command, args) {
  if (command !== python || pythonLaunch.command === python) return { command, args };
  return { command: pythonLaunch.command, args: [...pythonLaunch.args, ...args] };
}

function spawnPython(args, options = {}) {
  return spawn(pythonLaunch.command, [...pythonLaunch.args, ...args], options);
}

const legacySipsDir = path.join(repoRoot, "sips-runs");
const runtimeDataRoot = path.resolve(
  process.env.HEMLOCK_DATA_DIR || path.join(os.homedir(), "Library", "Application Support", "Hemlock"),
);
const sipsDir = path.resolve(process.env.HEMLOCK_SIPS_DIR || path.join(runtimeDataRoot, "workspace-runtime"));
const sipsRuntimeScript = path.join(__dirname, "sips_runtime.py");

function migrateLegacyRuntime() {
  if (fs.existsSync(sipsDir) || !fs.existsSync(legacySipsDir)) return;
  try {
    fs.mkdirSync(path.dirname(sipsDir), { recursive: true });
    fs.cpSync(legacySipsDir, sipsDir, { recursive: true, errorOnExist: false, force: false });
  } catch (error) {
    console.warn(`[hemlock] legacy runtime migration skipped: ${error.message}`);
  }
}

migrateLegacyRuntime();

function resolvePythonSitePackages() {
  const pythonRoot = path.dirname(path.dirname(python));
  const libRoot = path.join(pythonRoot, "lib");
  const sitePackages = [];
  try {
    const versionDirectory = fs.readdirSync(libRoot).find((name) => /^python\d+\.\d+$/.test(name));
    if (versionDirectory) sitePackages.push(path.join(libRoot, versionDirectory, "site-packages"));
  } catch {
    // The configured interpreter may be a system Python without a venv lib.
  }
  try {
    const config = fs.readFileSync(path.join(pythonRoot, "pyvenv.cfg"), "utf-8");
    const home = config.match(/^home\s*=\s*(.+)$/m)?.[1]?.trim();
    const versionDirectory = fs.readdirSync(path.join(path.dirname(home || ""), "lib"))
      .find((name) => /^python\d+\.\d+$/.test(name));
    if (home && versionDirectory) {
      const baseLibRoot = path.join(path.dirname(home), "lib");
      sitePackages.push(path.join(baseLibRoot, versionDirectory, "site-packages"));
    }
  } catch {
    // A system interpreter has already resolved its own packages.
  }
  return [...new Set(sitePackages)].filter((candidate) => fs.existsSync(candidate)).join(path.delimiter);
}

function pythonEnvironment() {
  const sitePackages = resolvePythonSitePackages();
  const pythonPath = [repoRoot, sitePackages, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
  return { ...process.env, PYTHONUNBUFFERED: "1", PYTHONPATH: pythonPath };
}

const modelCandidates = [
  process.env.HEMLOCK_MODEL_PATH,
  process.env.MAPLE_MODEL_PATH,
  path.join(os.homedir(), "Models", "Hemlock", "maple-2bit-mlx"),
  path.join(repoRoot, "maple-2bit-mlx"),
].filter(Boolean).map((candidate) => path.resolve(candidate));
// T9-H1: prefer candidates that look like real MLX checkpoints (a bogus dir
// used to spawn blindly and 404 later); fall through so startServer explains.
function mlxCheckpointProblem(dirPath) {
  let names = [];
  try {
    if (!fs.statSync(dirPath).isDirectory()) return "a readable model directory";
    names = fs.readdirSync(dirPath);
  } catch {
    return "a readable model directory";
  }
  return missingCheckpointItem(names);
}
const modelPath = modelCandidates.find((candidate) => !mlxCheckpointProblem(candidate)) || modelCandidates[0];

// Local MLX model registry for the picker. "default_model" is the Maple
// launch model; other entries are absolute model directories served by the
// same mlx_lm server, which lazy-loads whatever path a request names.
const LOCAL_MODEL_PATHS = {
  "default_model": modelPath,
  "lfm25-8b": path.join(os.homedir(), "Models", "Hemlock", "LFM2.5-8B-A1B-mlx-4bit"),
};

function resolveLocalModelPath(model) {
  const resolved = LOCAL_MODEL_PATHS[String(model || "")];
  // T9-H1: an existing-but-invalid dir would lazy-load to a 404 mid-chat;
  // fall back to the validated default instead.
  return resolved && !mlxCheckpointProblem(resolved) ? resolved : "default_model";
}
const minimumDreamFreeBytes = Number(process.env.HEMLOCK_MIN_FREE_BYTES || 10 * 1024 ** 3);

function digestText(value) {
  return `sha256:${crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex")}`;
}

function tokensPerSecond(usage, elapsedMs) {
  const completionTokens = Number(usage?.completion_tokens ?? usage?.output_tokens ?? usage?.completionTokens);
  const durationSeconds = Number(elapsedMs) / 1000;
  if (!Number.isFinite(completionTokens) || completionTokens <= 0 || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return null;
  return Math.round((completionTokens / durationSeconds) * 10) / 10;
}

function modelChannelRecords(channels = {}, source = "maple") {
  return Object.entries(channels)
    .filter(([name, text]) => name !== "role" && typeof text === "string")
    .map(([name, text]) => ({ name, text, digest: digestText(text), visible: true, source }));
}

function streamChannelRecords(stream) {
  if (stream?.kind === "model_text") return modelChannelRecords(stream.channels, stream.provider || "maple");
  return Object.entries(stream?.channels || {})
    .filter(([, text]) => typeof text === "string")
    .map(([name, text]) => ({ name, text, digest: digestText(text), visible: true, source: stream?.kind || "stream" }));
}

function persistModelOutput({ taskId, operationId = null, streamId = null, mode = "conversation", channels = {}, rawPayload = null, provider = "maple" } = {}) {
  const root = path.join(runtimeDataRoot, "events", "model-output");
  fs.mkdirSync(root, { recursive: true });
  const safeId = String(streamId || `model-${Date.now()}`).replace(/[^a-zA-Z0-9._-]/g, "-");
  const filePath = path.join(root, `${safeId}.json`);
  const record = {
    schema: "hemlock.agent.model-output.v1",
    taskId: taskId || agentTask?.id || null,
    operationId,
    streamId,
    mode,
    provider,
    channels: modelChannelRecords(channels, provider),
    outputDigest: digestText(JSON.stringify(channels)),
    rawPayload,
    createdAt: new Date().toISOString(),
  };
  writeJsonAtomic(filePath, record);
  return filePath;
}

function storageStatus(targetPath = repoRoot) {
  try {
    const stats = fs.statfsSync(targetPath);
    return {
      path: targetPath,
      freeBytes: stats.bavail * stats.bsize,
      totalBytes: stats.blocks * stats.bsize,
    };
  } catch {
    return null;
  }
}

function pathSize(targetPath) {
  try {
    const stats = fs.statSync(targetPath);
    if (stats.isFile()) return stats.size;
    if (!stats.isDirectory()) return 0;
    return fs.readdirSync(targetPath, { withFileTypes: true }).reduce((total, entry) => total + pathSize(path.join(targetPath, entry.name)), 0);
  } catch {
    return 0;
  }
}

function runtimeStorageInventory() {
  const categories = ["models", "adapters", "datasets", "receipts", "events", "context", "caches", "workspaces", "workspace-runtime"];
  const entries = categories.map((name) => ({ name, path: path.join(runtimeDataRoot, name), bytes: pathSize(path.join(runtimeDataRoot, name)) }));
  return {
    schema: "hemlock.storage.inventory.v1",
    root: runtimeDataRoot,
    freeBytes: storageStatus(runtimeDataRoot)?.freeBytes ?? null,
    modelPath,
    modelBytes: pathSize(modelPath),
    totalRuntimeBytes: entries.reduce((total, entry) => total + entry.bytes, 0),
    entries,
    claimBoundary: "Sizes describe paths visible to the local Electron runtime; they do not prove that an artifact is safe to delete.",
  };
}

function assertDreamStorage(runDir) {
  const storage = storageStatus(runDir);
  if (storage && storage.freeBytes < minimumDreamFreeBytes) {
    appendAgentEvent("dream.blocked", "blocked", {
      reason: "insufficient-free-space",
      storage,
      minimumFreeBytes: minimumDreamFreeBytes,
      modelPath,
    }, { reversible: true });
    throw new Error(
      `Dream is blocked by storage pressure: ${(storage.freeBytes / 1024 ** 3).toFixed(1)} GiB free, ` +
      `but Hemlock requires at least ${(minimumDreamFreeBytes / 1024 ** 3).toFixed(1)} GiB. ` +
      "Clear transient training data or choose a larger local volume before retrying.",
    );
  }
  return storage;
}
const serverScript = "-m";
// This is a ceiling, not a reasoning budget. Maple is allowed to stop when it
// is done; the default is intentionally high so a long reasoning trace is not
// cut off before the visible response. Lower it only when explicitly tuning a
// constrained machine with HEMLOCK_MAPLE_MAX_TOKENS.
const requestedMapleMaxTokens = Number(process.env.HEMLOCK_MAPLE_MAX_TOKENS);
const mapleMaxTokens = Number.isFinite(requestedMapleMaxTokens)
  ? Math.max(8192, requestedMapleMaxTokens)
  : 16384;
const maplePromptCacheSize = Number.isInteger(Number(process.env.HEMLOCK_MAPLE_PROMPT_CACHE_SIZE))
  ? Math.max(1, Math.min(16, Number(process.env.HEMLOCK_MAPLE_PROMPT_CACHE_SIZE)))
  : 12;

// ── Maple-Preview performance optimizations ──────────────────────────────
//
// 1. KV cache quantization (--kv-bits): opt-in via HEMLOCK_KV_BITS (0 =
//    disabled, the default). Maple mixes cache types: the 18 sliding-window
//    layers run RotatingKVCache (cannot quantize — mlx_lm leaves them exact)
//    while the 6 full-attention layers convert to QuantizedKVCache once the
//    cache grows past --quantized-kv-start tokens (HEMLOCK_KV_QUANT_START,
//    server default 5000). Below that threshold decoding is bit-exact;
//    past it, full-layer KV reads shrink ~2x at 8 bits / ~4x at 4 bits,
//    which speeds up long-context decode and raises the practical context
//    ceiling. It is a numerics change past the start point, so it stays
//    opt-in: prefer 8 (near-lossless) over 4.
//    History: an earlier revision crashed here — maybe_quantize_kv_cache
//    called to_quantized() on every cache exposing the method, and
//    RotatingKVCache's stub raises NotImplementedError which aborted the
//    GPU command buffer (SIGABRT) mid-session. The fork now quantizes only
//    true KVCache entries, so enabling this is safe.
//
// 2. Prefill step size (--prefill-step-size): smaller chunks improve
//    responsiveness on long prompts. Tune with HEMLOCK_PREFILL_STEP_SIZE.
// Persistent cross-restart prompt caching (--prompt-cache-file): the forked
// mlx_lm server saves the K most-recent prompt-cache entries (default 4,
// HEMLOCK_PROMPT_CACHE_SLOTS to tune; 1 = legacy single-entry file) as
// per-entry safetensors plus a manifest on shutdown and reloads them on
// boot (validates model_key before trusting). Wired into serverArgs below;
// HEMLOCK_NO_CACHE_FILE=1 disables.
// n-gram speculative drafting is architecturally incompatible with Maple
// (SWA-512 RotatingKVCache defeats the verifier's cache rewind —
// mlx_lm/speculative.py:476 fallback). FlashHead (checkpoint flash_head) is
// the decode-speed lever; enabled below.
const mapleKvBits = Number.isFinite(Number(process.env.HEMLOCK_KV_BITS))
  ? Math.max(0, Math.min(8, Math.round(Number(process.env.HEMLOCK_KV_BITS))))
  : 0;
const mapleKvQuantStart = Number.isInteger(Number(process.env.HEMLOCK_KV_QUANT_START))
  ? Math.max(0, Number(process.env.HEMLOCK_KV_QUANT_START))
  : 5000;
const maplePrefillStepSize = Number.isInteger(Number(process.env.HEMLOCK_PREFILL_STEP_SIZE))
  ? Math.max(256, Number(process.env.HEMLOCK_PREFILL_STEP_SIZE))
  : 1024;

// Prompt-cache byte cap — each entry persists a whole KV state. One
// ~64k-token entry is ~768MB of fp16 full-attention KV (6 layers ×
// 2KB/token/layer) plus ~18MB of exact sliding-window cache (18 layers × a
// 512-token window × 2KB/token). With --kv-bits the full layers shrink ~2x
// at 8-bit / ~4x at 4-bit — a 64k entry is ~384MB at 8 bits — so two hot
// 64k entries plus sliding overhead fit in ~800MB and the default rises to
// 1G. Exact KV stays at 768M, room for one full 64k entry.
// HEMLOCK_MAPLE_PROMPT_CACHE_BYTES always wins; applyRuntimeSettingEnv
// re-derives this default when kvBits changes live.
function defaultMaplePromptCacheBytes(kvBits) {
  return kvBits > 0 ? "1G" : "768M";
}
let maplePromptCacheBytes = String(process.env.HEMLOCK_MAPLE_PROMPT_CACHE_BYTES || defaultMaplePromptCacheBytes(mapleKvBits));

const maplePromptConcurrency = Number.isInteger(Number(process.env.HEMLOCK_MAPLE_PROMPT_CONCURRENCY))
  ? Math.max(1, Math.min(4, Number(process.env.HEMLOCK_MAPLE_PROMPT_CONCURRENCY)))
  : 1;
const mapleDecodeConcurrency = Number.isInteger(Number(process.env.HEMLOCK_MAPLE_DECODE_CONCURRENCY))
  ? Math.max(1, Math.min(4, Number(process.env.HEMLOCK_MAPLE_DECODE_CONCURRENCY)))
  : 1;

const serverArgs = [
  "mlx_lm",
  "server",
  "--model",
  modelPath,
  "--host",
  "127.0.0.1",
  "--port",
  "8080",
  "--trust-remote-code",
  "--flash-head",
  "--temp",
  "0.7",
  "--top-p",
  "0.95",
  "--top-k",
  "20",
  "--max-tokens",
  String(mapleMaxTokens),
  "--prompt-cache-size",
  String(maplePromptCacheSize),
  "--prompt-cache-bytes",
  maplePromptCacheBytes,
  "--prompt-concurrency",
  String(maplePromptConcurrency),
  "--decode-concurrency",
  String(mapleDecodeConcurrency),
  "--log-level",
  "INFO",
  // ── Performance optimizations ──────────────────────────────
  // KV cache quantization (opt-in): full-attention layers only, past
  // --quantized-kv-start; sliding layers stay exact RotatingKVCache.
  ...(mapleKvBits > 0
    ? ["--kv-bits", String(mapleKvBits), "--quantized-kv-start", String(mapleKvQuantStart)]
    : []),
  // Prefill in smaller chunks for better responsiveness
  "--prefill-step-size",
  String(maplePrefillStepSize),
  // Persist the hottest prompt-cache entry across restarts: the runtime
  // evidence shows a 3–12× first-inference penalty on a cold KV cache. The
  // server validates model_key before trusting the file; corruption or a
  // checkpoint change cold-starts cleanly. HEMLOCK_NO_CACHE_FILE=1 disables.
  "--prompt-cache-file",
  path.join(runtimeDataRoot, "maple-prompt-cache.safetensors"),
];
const serverUrl = "http://127.0.0.1:8080";
// 2-bit Maple cold loads (weights + KV cache + adapters) can exceed three
// minutes on constrained hardware; readiness waits are sized for that.
const readinessTimeoutMs = 300000;
const inferenceProbeTimeoutMs = 300000;
// Maple can spend several minutes on a short visible response because its
// reasoning channel is emitted before content. Do not mistake that honest
// latency for an empty response; cancellation and steering still abort the
// active request immediately.
const inferenceTimeoutMs = Math.max(30000, Number(process.env.HEMLOCK_INFERENCE_TIMEOUT_MS || 900000));

const isDev = !app.isPackaged;

if (isDev && process.env.MAPLE_REMOTE_DEBUG_PORT) {
  app.commandLine.appendSwitch("remote-debugging-port", process.env.MAPLE_REMOTE_DEBUG_PORT);
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 760,
    minHeight: 620,
    title: "Hemlock · local dream",
    backgroundColor: "#f2f0e8",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });
  mainWindow = window;

  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });

  const url = process.env.HEMLOCK_PROD_UI === "1"
    ? `file://${__dirname}/../dist/index.html`
    : isDev
      ? process.env.MAPLE_DEV_URL || "http://127.0.0.1:5173"
      : `file://${__dirname}/../dist/index.html`;
  window.loadURL(url);
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    // Artifact previews are sandboxed renderer documents. No preview content
    // may create or redirect an external window; explicit app navigation can
    // use a future allowlisted host command instead.
    void target;
    return { action: "deny" };
  });
  // Renderer health: record every crash durably, auto-reload at most once
  // per window per minute so a crash loop cannot reload-loop, and never
  // auto-act on "unresponsive" — a busy renderer is not a dead one.
  window.webContents.on("render-process-gone", (_event, details = {}) => {
    appendAgentEvent("renderer.crashed", "failed", { reason: String(details?.reason || "unknown"), exitCode: details?.exitCode ?? null, windowId: window.id }, { reversible: false });
    const lastReloadAt = rendererLastReloadAt.get(window.id) || 0;
    if (window.isDestroyed()) return;
    if (Date.now() - lastReloadAt >= 60000) {
      rendererLastReloadAt.set(window.id, Date.now());
      try { window.webContents.reload(); } catch { /* window may be mid-teardown */ }
    } else {
      appendAgentEvent("renderer.reload.suppressed", "degraded", { windowId: window.id, reason: "auto-reload budget exhausted (1 per 60s)" }, { reversible: false });
    }
  });
  window.webContents.on("unresponsive", () => {
    appendAgentEvent("renderer.unresponsive", "degraded", { windowId: window.id }, { reversible: false });
  });
}

let serverProcess = null;
let mainWindow = null;
let serverProcessError = null;
let dreamProcess = null;
let sipsCycleActive = false;
const activeChildren = new Set();
let serverState = { processReady: false, inferenceReady: false, adapterPath: "" };
let serverLaunchPromise = null;
let mapleCrashTimestamps = []; // bounded respawn budget (crash_policy.cjs); persisted in each session's maple-runtime.json
let mapleHealthMonitor = null; // created lazily by syncMapleHealthMonitor
let mapleWarmupPromise = null; // in-flight post-launch inference probe
let mapleRespawnPendingResume = false; // an unexpected exit happened while a task was mid-loop
const taskMapleExitCounts = new Map(); // taskId -> unexpected exits observed while that task was active
const rendererLastReloadAt = new Map(); // window.id -> last auto-reload ms (bounded renderer crash recovery)
let agentInferenceEndpoint = serverUrl;
const providerStatusCache = new Map();
const activeStreams = new Map();
const streamRing = new Map();
const STREAM_RING_LIMIT = 240;
// T11-A: bound on the appendAgentEvent dedup set (recent-window dedup only).
const AGENT_EVENT_ID_WINDOW = 4096;
let activeArtifactId = null;

const providerCommandCandidates = {
  codex: [
    process.env.HEMLOCK_CODEX_BIN,
    path.join(os.homedir(), ".hermes", "node", "bin", "codex"),
    path.join(os.homedir(), ".local", "bin", "codex"),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
  ],
  claude: [
    process.env.HEMLOCK_CLAUDE_BIN,
    path.join(os.homedir(), ".npm-global", "bin", "claude"),
    path.join(os.homedir(), ".local", "bin", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ],
};

function executableFile(candidate) {
  if (!candidate) return false;
  try {
    return fs.statSync(candidate).isFile() && (process.platform === "win32" || (fs.constants && (fs.statSync(candidate).mode & 0o111)));
  } catch {
    return false;
  }
}

function resolveProviderExecutable(provider) {
  const candidates = [...(providerCommandCandidates[provider] || [])];
  const pathEntries = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const entry of pathEntries) candidates.push(path.join(entry, provider));
  return candidates.filter(Boolean).map((candidate) => path.resolve(candidate)).find(executableFile) || null;
}

function runProcess(command, args = [], { cwd = repoRoot, timeoutMs = 15000, input = null } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      resolve({ exitCode: null, signal: null, stdout: "", stderr: error.message, error });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer = null;
    const finish = (exitCode, signal, error = null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ exitCode, signal, stdout, stderr, error });
    };
    timer = setTimeout(() => {
      if (!child.killed) child.kill("SIGTERM");
      finish(null, "SIGTERM");
    }, timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", (error) => finish(null, null, error));
    child.once("close", (exitCode, signal) => finish(exitCode, signal));
    if (input != null) child.stdin?.end(String(input));
    else child.stdin?.end();
  });
}

function providerStatusRecord(provider, patch = {}) {
  const definition = PROVIDER_DEFINITIONS[provider];
  return {
    provider,
    label: definition.label,
    shortLabel: definition.shortLabel,
    kind: definition.kind,
    status: "not_checked",
    installed: provider === "maple",
    authenticated: provider === "maple",
    executable: null,
    accountLabel: provider === "maple" ? "local MLX" : null,
    checkedAt: null,
    ...patch,
  };
}

function providerStatusSnapshot() {
  return ["maple", "codex", "claude"].map((provider) => providerStatusCache.get(provider) || providerStatusRecord(provider));
}

function parseClaudeAuthStatus(stdout) {
  const lines = String(stdout || "").trim().split(/\r?\n/).filter(Boolean);
  for (const line of lines.reverse()) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // Claude may print a small diagnostic before its JSON status object.
    }
  }
  return null;
}

async function inspectProvider(provider) {
  if (provider === "maple") {
    const record = providerStatusRecord("maple", {
      status: serverState.inferenceReady ? "ready" : serverState.processReady ? "process_ready" : "local",
      checkedAt: new Date().toISOString(),
      accountLabel: "local MLX",
    });
    providerStatusCache.set(provider, record);
    return record;
  }
  const executable = resolveProviderExecutable(provider);
  if (!executable) {
    const record = providerStatusRecord(provider, { status: "unavailable", installed: false, authenticated: false, checkedAt: new Date().toISOString() });
    providerStatusCache.set(provider, record);
    return record;
  }
  const args = provider === "codex" ? ["login", "status"] : ["auth", "status", "--json"];
  const result = await runProcess(executable, args, { timeoutMs: 20000 });
  const claudeAuth = provider === "claude" ? parseClaudeAuthStatus(result.stdout) : null;
  const authenticated = provider === "codex"
    ? result.exitCode === 0 && /logged in|authenticated/i.test(`${result.stdout}\n${result.stderr}`)
    : result.exitCode === 0 && claudeAuth?.loggedIn === true;
  const record = providerStatusRecord(provider, {
    status: authenticated ? "authenticated" : "login_required",
    installed: true,
    authenticated,
    executable,
    accountLabel: authenticated ? (provider === "codex" ? "ChatGPT subscription" : `${claudeAuth?.subscriptionType || "Claude"} subscription`) : null,
    checkedAt: new Date().toISOString(),
    detail: authenticated ? null : String(result.stderr || result.stdout || "Login status was not confirmed.").trim().slice(-320),
  });
  providerStatusCache.set(provider, record);
  return record;
}

async function inspectProviders() {
  const providers = await Promise.all(["maple", "codex", "claude"].map((provider) => inspectProvider(provider)));
  return { schema: "hemlock.provider.status.v1", providers, checkedAt: new Date().toISOString(), claimBoundary: "Subscription status is inferred from the provider CLI's local login status; Hemlock never reads or stores provider credentials." };
}

function appleScriptString(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function openProviderLogin(provider, action = "login") {
  if (!(provider === "codex" || provider === "claude")) throw new Error("Only Codex and Claude have subscription login flows.");
  const executable = resolveProviderExecutable(provider);
  if (!executable) throw new Error(`${PROVIDER_DEFINITIONS[provider].label} CLI was not found. Install it first, then retry.`);
  const commandArgs = provider === "codex"
    ? [action === "logout" ? "logout" : "login"]
    : ["auth", action === "logout" ? "logout" : "login"];
  const command = [shellQuote(executable), ...commandArgs.map(shellQuote)].join(" ");
  if (process.platform === "darwin") {
    const script = `tell application "Terminal" to do script "${appleScriptString(command)}"`;
    const terminal = spawn("osascript", ["-e", script], { detached: true, stdio: "ignore" });
    terminal.unref();
  } else {
    const child = spawn(executable, commandArgs, { cwd: repoRoot, detached: true, stdio: "ignore" });
    child.unref();
  }
  appendAgentEvent(`provider.${action}.opened`, "accepted", { provider, action, executable: path.basename(executable), claimBoundary: "The provider's own interactive terminal flow was opened; authentication completion must be checked from the provider status control." }, { reversible: true });
  return { schema: "hemlock.provider.auth.v1", status: "opened", provider, action, executable: path.basename(executable), claimBoundary: "Hemlock opened the provider CLI's own login flow; it does not claim that authentication completed." };
}

const sessionsDir = path.join(sipsDir, "sessions");
fs.mkdirSync(sessionsDir, { recursive: true });
const previousSessionId = fs.readdirSync(sessionsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()
  .at(-1) || "";
const previousSessionDir = previousSessionId ? path.join(sessionsDir, previousSessionId) : "";
const previousStatePath = previousSessionDir ? path.join(previousSessionDir, "state.json") : "";
const previousEventsPath = previousSessionDir ? path.join(previousSessionDir, "events.jsonl") : "";
// Integrity recovery journal: every corrupt durable file that gets rebuilt
// from defaults or a last-good backup is buffered here and emitted as a
// durable `integrity.recovered` event once this session's events.jsonl exists
// (early boot reads happen before sessionDir is created).
const pendingIntegrityRecoveries = [];
const integrityNotedKeys = new Set();
let integrityJournalReady = false;

function noteIntegrityRecovery(recovery = {}) {
  const key = `${recovery.file || ""}|${recovery.reason || ""}`;
  if (integrityNotedKeys.has(key)) return;
  integrityNotedKeys.add(key);
  pendingIntegrityRecoveries.push(recovery);
  flushIntegrityRecoveries();
}

function flushIntegrityRecoveries() {
  if (!integrityJournalReady) return;
  while (pendingIntegrityRecoveries.length) {
    const recovery = pendingIntegrityRecoveries.shift();
    try {
      appendAgentEvent("integrity.recovered", "degraded", {
        ...recovery,
        claimBoundary: "The corrupt file was quarantined (never deleted) and rebuilt from defaults or the last-good copy; the listed content was lost.",
      }, { evidenceRefs: [recovery.file, recovery.quarantinePath].filter(Boolean), reversible: false });
    } catch (error) {
      pendingIntegrityRecoveries.unshift(recovery);
      console.warn(`[hemlock] integrity event could not be journaled: ${error.message}`);
      break;
    }
  }
}

// readJsonFile is the shared durable-JSON reader: a file that exists but does
// not parse is quarantined (renamed, never deleted) and reported through the
// integrity journal; the caller rebuilds from `fallback` (or the optional
// `backupPath` last-good copy). Missing files return the fallback silently.
const readJsonFile = (filePath, fallback, options = {}) =>
  readJsonDurable(filePath, fallback, { ...options, onIntegrity: noteIntegrityRecovery });
const readEventLog = (filePath) => {
  if (!filePath) return [];
  return readJsonlFile(filePath, { label: "session-events", onIntegrity: noteIntegrityRecovery }).rows;
};
// A corrupt previous state.json recovers from the .bak copy writeAgentState
// rotates next to it; with no usable backup the session restores defaults and
// the integrity journal records what was lost.
const previousState = previousStatePath ? readJsonFile(previousStatePath, {}, { label: "session-state", backupPath: `${previousStatePath}.bak` }) : {};
// writeAgentState persists a BARE task snapshot ({...agentTask, pendingIntents})
// carrying schema "hemlock.agent.task.v1"; earlier builds wrapped it in an
// envelope ({task: {...}}). Accept both shapes so the restore path stays live.
const previousTask = previousState?.schema === "hemlock.agent.task.v1"
  ? previousState
  : (previousState?.task && typeof previousState.task === "object" ? previousState.task : null);
// Pending queue intents persist as a field of the session state file (see
// writeAgentState). They restore as queued — never auto-executed.
const previousPendingIntents = Array.isArray(previousState?.pendingIntents) ? previousState.pendingIntents : [];
const shouldResumeTask = previousTask && ["accepted", "planning", "running", "waiting_for_approval", "verifying", "blocked"].includes(previousTask.status);
const threadManager = new ThreadManager({ root: runtimeDataRoot, defaultWorkspaceRoot: previousTask?.workspaceRoot || repoRoot, providerCaps: DEFAULT_PROVIDER_CAPS, onIntegrity: noteIntegrityRecovery });
const restoredThread = previousTask?.threadId ? threadManager.thread(previousTask.threadId) : null;
// Never seed a fresh default thread with the dead session's live status — a
// resumable snapshot is parked blocked here exactly like agentTask below.
const defaultThread = restoredThread || threadManager.ensureDefaultThread({ workspaceRoot: previousTask?.workspaceRoot || repoRoot, task: shouldResumeTask ? { ...previousTask, status: "blocked", phase: "resume" } : previousTask });
// A crash can also leave an existing registry thread stamped with a live
// status ("running", "waiting_for_approval", ...) while no process performs
// it. Park it paused — same shape as parkForSwitch — so the restored registry
// never claims work that cannot be running. Parked threads stay resumable
// through thread.resume; terminal/archived threads are untouched.
const parkedBootThreadIds = [];
for (const thread of [...new Set([restoredThread, defaultThread].filter(Boolean))]) {
  if (!PARKABLE_THREAD_STATUSES.has(thread.status)) continue;
  try {
    threadManager.checkpoint(thread.id, { taskId: thread.taskSnapshot?.id || thread.taskId, phase: "paused", status: "paused", reason: "session-restarted-mid-task" });
  } catch { /* a missing workspace must not block the boot */ }
  const parkedSnapshot = thread.taskSnapshot && typeof thread.taskSnapshot === "object"
    ? { ...thread.taskSnapshot, status: "paused", phase: "paused", blockedReason: thread.taskSnapshot.blockedReason || "The previous session was interrupted; inspect and resume the task." }
    : null;
  threadManager.updateThread(thread.id, {
    status: "paused",
    phase: "paused",
    blockedReason: "The previous session was interrupted; inspect and resume the task.",
    ...(parkedSnapshot ? { taskSnapshot: parkedSnapshot } : {}),
  });
  parkedBootThreadIds.push(thread.id);
}
const sessionId = `session-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
const sessionDir = path.join(sessionsDir, sessionId);
const sessionEventsPath = path.join(sessionDir, "events.jsonl");
const sessionStatePath = path.join(sessionDir, "state.json");
const mapleRuntimeStatePath = path.join(sessionDir, "maple-runtime.json");
const previousMapleRuntimeStatePath = previousSessionDir ? path.join(previousSessionDir, "maple-runtime.json") : "";
// Crash-loop memory survives an app restart: load the previous session's
// persisted timestamps, pruned to the live window at load.
mapleCrashTimestamps = sanitizeCrashHistory(readJsonFile(previousMapleRuntimeStatePath, {}, { label: "maple-runtime-state" }).mapleCrashTimestamps);
// World habitat: deterministic experiment receipts and the findings dataset
// that Dream consumes. Both live beside the other SIPS artifacts so the same
// storage boundary rules apply.
const experimentDatasetPath = path.join(sipsDir, "experiment-dataset.jsonl");
const experimentReceiptsDir = path.join(sipsDir, "experiments");
const experimentRuns = new Map(); // this-session run receipts for finding citation
const agentEvents = readEventLog(previousEventsPath).slice(-240);
const agentEventIds = new Set(agentEvents.map((event) => event.id).filter(Boolean));
let sessionClosed = false;
// Declared before the first writeAgentState() call: the state writer reads
// the queue's pending list once the queue exists, and `let` would throw a
// TDZ error if a write landed before the declaration line ran.
let agentKernel = null;
let agentOrchestrator = null;
let agentIntentQueue = null;
let agentTask = {
  schema: "hemlock.agent.task.v1",
  id: shouldResumeTask ? previousTask.id : `task-${sessionId}`,
  objective: shouldResumeTask ? previousTask.objective : "Explore the Hemlock workspace",
  intent: shouldResumeTask ? previousTask.intent : "conversation",
  interactionMode: shouldResumeTask ? (previousTask.interactionMode || "explore") : "explore",
  threadId: shouldResumeTask ? (previousTask.threadId || defaultThread?.id || null) : (defaultThread?.id || null),
  projectId: shouldResumeTask ? (previousTask.projectId || defaultThread?.projectId || null) : (defaultThread?.projectId || null),
  workspaceRoot: shouldResumeTask ? (previousTask.workspaceRoot || defaultThread?.workspaceRoot || repoRoot) : (defaultThread?.workspaceRoot || repoRoot),
  autonomy: shouldResumeTask ? (previousTask.autonomy || "bounded-local") : "bounded-local",
  phase: shouldResumeTask ? "resume" : "ready",
  status: shouldResumeTask ? "blocked" : "ready",
  foregroundStep: shouldResumeTask ? "Recovered unfinished task; inspect and resume" : "Waiting for a local task",
  budget: shouldResumeTask ? mergeBudget(previousTask.budget || DEFAULT_BUDGET) : mergeBudget(DEFAULT_BUDGET),
  steering: shouldResumeTask ? (previousTask.steering || []) : [],
  evidenceRefs: shouldResumeTask ? (previousTask.evidenceRefs || []) : [],
  // Same staleness guard as thread.switch: the snapshot's sessionId belongs to
  // a dead session (boot always mints a fresh one), so a resumable previous
  // task restores as blocked — never auto-runs.
  blockedReason: shouldResumeTask ? "The previous session was interrupted; inspect and resume the task." : null,
  artifactRepair: shouldResumeTask ? (previousTask.artifactRepair || { attempt: 0, maxAttempts: DEFAULT_BUDGET.maxArtifactRepairs, baseRevision: null, candidateRevision: null, lastGoodRevision: null, issues: [], status: "idle" }) : { attempt: 0, maxAttempts: DEFAULT_BUDGET.maxArtifactRepairs, baseRevision: null, candidateRevision: null, lastGoodRevision: null, issues: [], status: "idle" },
  codeRepair: shouldResumeTask ? (previousTask.codeRepair || { attempt: 0, maxAttempts: DEFAULT_BUDGET.maxCodeRepairs, baseChangeSetId: null, candidateChangeSetId: null, lastGoodChangeSetId: null, issues: [], status: "idle" }) : { attempt: 0, maxAttempts: DEFAULT_BUDGET.maxCodeRepairs, baseChangeSetId: null, candidateChangeSetId: null, lastGoodChangeSetId: null, issues: [], status: "idle" },
  metrics: shouldResumeTask ? (previousTask.metrics || { inferenceCalls: 0, repairCalls: 0, previewWaitMs: 0, artifactRevisionCount: 0 }) : { inferenceCalls: 0, repairCalls: 0, previewWaitMs: 0, artifactRevisionCount: 0 },
  startedAt: shouldResumeTask ? (previousTask.startedAt || new Date().toISOString()) : new Date().toISOString(),
  // Which live session owns this task's action loop. A taskSnapshot restored
  // with a different sessionId belongs to a dead process — its loop can never
  // run again, so it must restore as blocked rather than "running".
  sessionId,
  updatedAt: new Date().toISOString(),
};

fs.mkdirSync(sessionDir, { recursive: true });
// The events journal is live from here: any integrity recoveries buffered by
// the boot-time reads above (state.json, registry, maple-runtime) are now
// emitted as durable integrity.recovered events.
integrityJournalReady = true;
flushIntegrityRecoveries();
// Persist the initial task state immediately. Without this, the session's
// state.json on disk can still describe the *previous* session's task (e.g.
// status "running" from a session that crashed mid-task), and a later
// restart would restore that stale task and queue every new intent behind
// an action loop that can never run.
writeAgentState();

agentKernel = new AgentKernel({ root: runtimeDataRoot, repoRoot, task: agentTask, onIntegrity: noteIntegrityRecovery });

function artifactEvent(type, status, payload, evidenceRefs = []) {
  const artifact = payload?.artifact;
  if (artifact?.id) activeArtifactId = artifact.id;
  appendAgentEvent(type, status, payload, { evidenceRefs, reversible: true });
}

const artifactRegistry = new ArtifactRegistry({
  root: runtimeDataRoot,
  workspaceId: agentKernel.workspaceId,
  onEvent: artifactEvent,
  changeSet: ({ artifact, taskId }) => prepareArtifactChangeSet({ artifact, taskId }),
});
const changesetApplier = new ChangeSetApplier({
  changesetRoot: path.join(sipsDir, "workspaces", "changesets"),
  readArtifactManifest: (taskId, artifactId) => { try { return artifactRegistry.read(taskId, artifactId); } catch { return null; } },
  onEvent: (type, status, payload, extra = {}) => appendAgentEvent(type, status, payload, { reversible: true, ...extra }),
});
const previewSessions = new PreviewSessionManager({
  emit: (type, status, payload) => appendAgentEvent(type, status, payload, { reversible: true }),
});
const previewReportCache = new Map();
const previewReportWaiters = new Map();

function previewReportKey({ taskId, artifactId, revision, sessionId } = {}) {
  return [taskId, artifactId, Number(revision), sessionId].join("|");
}

function previewReceiptPath(session) {
  return path.join(artifactRegistry.artifactRoot(session.taskId, session.artifactId), "verification-receipts", `${session.id}.json`);
}

function recordPreviewReport(report = {}) {
  const session = previewSessions.get(report.sessionId);
  const artifact = artifactRegistry.read(session.taskId, session.artifactId);
  const hasDomSummary = Boolean(report?.inspection?.dom || report?.inspection?.elements || typeof report?.inspection?.bodyText === "string");
  if (!hasDomSummary) {
    return { schema: "hemlock.agent.artifact.verification.v1", status: "pending", taskId: session.taskId, artifactId: session.artifactId, revision: session.revision, sessionId: session.id, issues: [{ code: "preview_report_incomplete", message: "The renderer report is waiting for its DOM summary." }], evidenceRefs: [artifactRegistry.manifestPath(session.taskId, session.artifactId)] };
  }
  const verification = verifyPreviewReport({ artifact, session, report });
  const receipt = {
    schema: "hemlock.agent.artifact.preview.receipt.v1",
    createdAt: new Date().toISOString(),
    report,
    verification,
  };
  const receiptPath = previewReceiptPath(session);
  writeJsonAtomic(receiptPath, receipt);
  const stored = { ...verification, receiptPath, evidenceRefs: [artifactRegistry.manifestPath(session.taskId, session.artifactId), receiptPath] };
  previewReportCache.set(previewReportKey(session), stored);
  previewSessions.recordReport(session.id, stored);
  appendAgentEvent("artifact.verification.completed", stored.status, { verification: stored, artifactId: session.artifactId, revision: session.revision, sessionId: session.id }, { evidenceRefs: stored.evidenceRefs, reversible: true });
  const waiter = previewReportWaiters.get(session.id);
  if (waiter) {
    clearTimeout(waiter.timer);
    previewReportWaiters.delete(session.id);
    bumpAgentMetrics({ previewWaitMs: Date.now() - waiter.startedAt });
    waiter.resolve(stored);
  }
  return stored;
}

function awaitPreviewReport(session, timeoutMs = 20000) {
  const cached = previewReportCache.get(previewReportKey(session));
  if (cached) return Promise.resolve(cached);
  const existing = previewReportWaiters.get(session.id);
  if (existing) return existing.promise;
  const startedAt = Date.now();
  let resolveReport;
  const promise = new Promise((resolve) => { resolveReport = resolve; });
  const timer = setTimeout(() => {
    previewReportWaiters.delete(session.id);
    bumpAgentMetrics({ previewWaitMs: Date.now() - startedAt });
    resolveReport({ schema: "hemlock.agent.artifact.verification.v1", status: "failed", taskId: session.taskId, artifactId: session.artifactId, revision: session.revision, sessionId: session.id, issues: [{ code: "preview_unavailable", message: "The renderer did not return a preview report before the bounded inspection timeout." }], consoleErrors: [], evidenceRefs: [] });
  }, timeoutMs);
  previewReportWaiters.set(session.id, { resolve: resolveReport, promise, timer, startedAt });
  return promise;
}

function artifactCommandReceipt(result, command) {
  if (!result || typeof result !== "object" || result.schema !== "hemlock.agent.artifact.v1") return result;
  const manifestPath = artifactRegistry.manifestPath(result.taskId, result.id);
  const revision = Number(result.revision || 0);
  const revisionPath = revision ? path.join(artifactRegistry.artifactRoot(result.taskId, result.id), "revisions", `r${revision}`) : null;
  if (revision) bumpAgentMetrics({ artifactRevisionCount: 1 });
  return {
    ...result,
    manifestPath,
    revisionPath,
    artifactId: result.id,
    sourceDigest: result.digest || null,
    evidenceRefs: [manifestPath, ...(revisionPath ? [revisionPath] : [])],
    summary: command === "artifact.create" ? `Created scratch artifact ${result.id}.` : `${command} recorded revision ${revision} for ${result.id}.`,
  };
}

function writeAgentState() {
  // Pending queue intents ride the session state file as an additive field,
  // so a restart restores them as queued work instead of losing them. The
  // file otherwise stays a flat task snapshot (existing readers untouched).
  const pendingIntents = agentIntentQueue?.persistablePending?.() || [];
  // Temp + fsync + rename — a crash mid-write must not produce the truncated
  // state.json a restart would then "restore". The .bak copy is the
  // last-good fallback the boot reader uses when the primary is corrupt.
  writeJsonAtomic(sessionStatePath, { ...agentTask, pendingIntents });
  try { fs.copyFileSync(sessionStatePath, `${sessionStatePath}.bak`); } catch { /* backup is best-effort */ }
}

// Persist the crash-loop budget beside the session's state.json so an app
// restart inherits it (load site: previousMapleRuntimeStatePath at boot).
function persistMapleRuntimeState() {
  try {
    writeJsonAtomic(mapleRuntimeStatePath, { schema: "hemlock.maple.runtime-state.v1", mapleCrashTimestamps, updatedAt: new Date().toISOString() });
  } catch (error) {
    console.warn(`[hemlock] maple runtime state persist skipped: ${error.message}`);
  }
}

function appendAgentEvent(type, status = "observed", payload = {}, options = {}) {
  const event = {
    schema: "hemlock.agent.event.v1",
    id: `evt-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    sessionId,
    taskId: agentTask.id,
    type,
    scope: repoRoot,
    createdAt: new Date().toISOString(),
    source: options.source || "electron",
    status,
    payload,
    evidenceRefs: options.evidenceRefs || [],
    reversible: options.reversible === true,
  };
  if (agentEventIds.has(event.id)) return event;
  agentEventIds.add(event.id);
  // T11-A: the dedup set grew one entry per event for the process lifetime
  // (agentEvents itself is capped, but this Set never was). Bound it to
  // a recent window — insertion order makes oldest ids drop first, so retry-
  // window dedup semantics are preserved while memory stays flat.
  if (agentEventIds.size > AGENT_EVENT_ID_WINDOW) {
    for (const staleId of agentEventIds) {
      agentEventIds.delete(staleId);
      if (agentEventIds.size <= AGENT_EVENT_ID_WINDOW / 2) break;
    }
  }
  agentEvents.push(event);
  if (agentEvents.length > 400) agentEvents.shift();
  // fsync'd journal append: the event is durable before this returns, and a
  // torn tail line (killed mid-append) is dropped by readEventLog's per-line
  // recovery rather than corrupting the journal.
  appendJsonlLine(sessionEventsPath, event);
  agentKernel?.ingestEvent(event);
  if (agentTask.threadId && ["plan.proposed", "plan.approved", "inference.started", "inference.completed", "command.started", "command.completed", "artifact.repair.started", "artifact.repair.completed", "task.blocked", "task.completed", "thread.switched"].includes(type)) {
    try {
      threadManager.checkpoint(agentTask.threadId, {
        taskId: agentTask.id,
        phase: agentTask.phase,
        status: agentTask.status,
        activePlanStep: agentTask.activePlanId || null,
        pendingAction: agentTask.activeActionId || null,
        evidenceRefs: [...new Set([...(agentTask.evidenceRefs || []), ...(event.evidenceRefs || [])])],
        artifactRepair: agentTask.artifactRepair || null,
        verificationIssues: agentTask.artifactRepair?.issues || agentTask.codeRepair?.issues || [],
        reason: type,
        // A bare event type ("command.started") is not a legible cause —
        // blocked checkpoints carry the model's own declared reason.
        blockedReason: type === "task.blocked"
          ? String(payload?.reason || payload?.error || agentTask.blockedReason || "unspecified").slice(0, 500)
          : null,
      });
    } catch (checkpointError) {
      console.warn(`[hemlock] checkpoint skipped: ${checkpointError.message}`);
    }
  }
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send("agent:event", event);
  return event;
}

// Fatal-error receipts: observe and persist before the process exits. The
// ~2KB stack bound keeps a pathological trace from flooding the journal.
// Never throws — a crash-time write must not mask the original failure.
function recordRuntimeError(kind, error) {
  try {
    const err = error instanceof Error ? error : new Error(String(error));
    appendAgentEvent("runtime.error", "failed", {
      kind,
      message: String(err.message || err).slice(0, 2000),
      stack: String(err.stack || "").slice(0, 2048),
    }, { reversible: false });
  } catch (recordError) {
    console.error(`[hemlock] runtime.error event failed: ${recordError.message}`);
  }
}

function emitStreamFrame(stream, { delta = "", channel = "content", terminal = false, status = "running", usage = null, stopReason = null, time = null } = {}) {
  if (!stream || stream.terminal) return;
  const frame = {
    schema: "hemlock.agent.stream.v1",
    streamId: stream.streamId,
    taskId: stream.taskId,
    operationId: stream.operationId,
    kind: stream.kind,
    provider: stream.provider || "maple",
    startedAt: stream.startedAt,
    channel: channel || "content",
    sequence: stream.sequence++,
    delta: String(delta || ""),
    time: time || new Date().toISOString(),
    terminal,
    status,
    usage,
    stopReason,
  };
  if (terminal) stream.terminal = true;
  const ring = streamRing.get(stream.streamId) || [];
  ring.push(frame);
  if (ring.length > STREAM_RING_LIMIT) ring.splice(0, ring.length - STREAM_RING_LIMIT);
  streamRing.set(stream.streamId, ring);
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send("agent:stream", frame);
  return frame;
}

function publishStreamFrame(stream, { delta = "", channel = "content", terminal = false, status = "running", usage = null, stopReason = null } = {}) {
  if (!stream || stream.terminal) return;
  const normalizedChannel = channel || "content";
  const normalizedDelta = String(delta || "");
  if (!stream.channels[normalizedChannel]) stream.channels[normalizedChannel] = "";
  stream.channels[normalizedChannel] += normalizedDelta;
  if (normalizedChannel === "content") stream.text += normalizedDelta;
  // T11-A: account raw delta bytes incrementally so the checkpoint throttle
  // never needs to serialize the full accumulated channels just to measure
  // growth (the old code JSON.stringify'd every channel on every call).
  stream.channelBytes = (stream.channelBytes || 0) + Buffer.byteLength(normalizedDelta, "utf8");
  const frame = { channel: normalizedChannel, delta: normalizedDelta, terminal, status, usage, stopReason, time: new Date().toISOString() };
  if (terminal) {
    stream.frameCoalescer?.flush();
    return emitStreamFrame(stream, frame);
  }
  if (stream.frameCoalescer) {
    stream.frameCoalescer.push(frame);
    return null;
  }
  return emitStreamFrame(stream, frame);
}

function checkpointStream(stream, { force = false } = {}) {
  if (!stream || !Object.values(stream.channels || {}).some(Boolean)) return;
  const now = Date.now();
  // T11-A: throttle decision now uses incrementally-accounted delta bytes
  // (shouldCheckpointStream) instead of serializing the entire channel map on
  // every call — the old code paid O(total-output) JSON.stringify per SSE
  // chunk even when the checkpoint was going to be skipped.
  if (!shouldCheckpointStream(stream, { force, now })) return;
  const serialized = JSON.stringify(stream.channels);
  const bytes = Buffer.byteLength(serialized, "utf8");
  stream.lastCheckpointAt = now;
  stream.lastCheckpointBytes = bytes;
  stream.lastMarkBytes = stream.channelBytes || 0;
  appendAgentEvent(stream.kind === "model_text" ? "inference.stream.checkpoint" : "operation.output.checkpoint", "checkpoint", {
    streamId: stream.streamId,
    operationId: stream.operationId,
    kind: stream.kind,
    sequence: stream.sequence - 1,
    digest: streamDigest(serialized),
    bytes,
    channels: streamChannelRecords(stream).map(({ name, digest, text }) => ({ name, digest, tail: text.slice(-2400) })),
  }, { reversible: true });
}

function startStream({ taskId = agentTask.id, operationId = null, kind = "model_text", provider = "maple" } = {}) {
  const stream = { streamId: createStreamId(kind), taskId, operationId, kind, provider, sequence: 0, text: "", channels: {}, terminal: false, startedAt: Date.now(), lastCheckpointAt: Date.now(), lastCheckpointBytes: 0, channelBytes: 0, lastMarkBytes: 0, controller: null, abortReason: null, frameCoalescer: null };
  stream.frameCoalescer = createStreamFrameCoalescer({ emit: (frame) => emitStreamFrame(stream, frame) });
  activeStreams.set(stream.streamId, stream);
  appendAgentEvent(kind === "model_text" ? "inference.stream.started" : "operation.output.started", "running", { streamId: stream.streamId, taskId, operationId, kind, provider });
  return stream;
}

function finishStream(stream, { status = "completed", stopReason = null, usage = null, rawOutputRef = null } = {}) {
  if (!stream || stream.terminal) return;
  publishStreamFrame(stream, { terminal: true, status, stopReason, usage });
  checkpointStream(stream, { force: true });
  const prefix = stream.kind === "model_text" ? "inference.stream" : "operation.output";
  const lifecycleType = status === "completed" ? `${prefix}.completed` : ["interrupted", "interrupted_by_steering", "cancelled"].includes(status) ? `${prefix}.interrupted` : `${prefix}.failed`;
  appendAgentEvent(lifecycleType, status === "completed" ? "passed" : status, {
    streamId: stream.streamId,
    taskId: stream.taskId,
    operationId: stream.operationId,
    kind: stream.kind,
    stopReason,
    usage,
    elapsedMs: Date.now() - stream.startedAt,
    digest: streamDigest(JSON.stringify(stream.channels)),
    contentDigest: streamDigest(stream.text),
    rawOutputRef,
    tail: stream.text.slice(-2400),
    channels: streamChannelRecords(stream),
  }, { reversible: true });
  activeStreams.delete(stream.streamId);
  // T11-A: the per-stream frame ring was write-only replay memory that no code
  // path ever read back; without this delete every finished stream leaked up
  // to STREAM_RING_LIMIT retained frames in streamRing for the process lifetime.
  streamRing.delete(stream.streamId);
}

function abortStreamsForTask(taskId, reason = "cancelled") {
  for (const stream of activeStreams.values()) {
    if (stream.taskId !== taskId || stream.terminal) continue;
    stream.abortReason = reason;
    stream.controller?.abort(reason);
  }
}

const contextBroker = new ContextBroker({
  repoRoot,
  sipsDir,
  getTask: () => agentTask,
  getSourcePolicy: (sourceId) => agentKernel?.source(sourceId),
  onCandidate: (input) => {
    try {
      const candidate = agentKernel.createCandidate(input);
      appendAgentEvent("candidate.created", "candidate", { candidate }, { evidenceRefs: candidate.sourceRefs || [], reversible: true });
      return candidate;
    } catch (error) {
      appendAgentEvent("candidate.create.failed", "failed", { error: error.message }, { reversible: true });
      return null;
    }
  },
  emit: (type, status, payload, options) => appendAgentEvent(type, status, payload, options),
});
contextBroker.state.sources = agentKernel.getSources();
const contextSources = new ContextSourceRegistry({ repoRoot, kernel: agentKernel, broker: contextBroker });
const codingWorkspace = new CodingWorkspace({
  runtimeRoot: runtimeDataRoot,
  threadManager,
  emit: (type, status, payload, options) => appendAgentEvent(type, status, payload, options),
});

function updateAgentTask(patch, { emit = true } = {}) {
  // A new objective landing on a non-active task is a new intent, not an
  // edit: mint a fresh task id + budget so the previous task keeps its own
  // objective, metrics, and terminal record. Observed bug: a stale task
  // resumed across a restart had its objective overwritten by "Run local
  // Dream", and its spent training budget then blocked the launch.
  const retargeted = typeof patch?.objective === "string"
    && patch.objective.trim()
    && patch.objective !== agentTask.objective
    && patch.id === undefined
    && !isActiveTask(agentTask);
  if (retargeted) {
    const previousTaskId = agentTask.id;
    const previousObjective = agentTask.objective;
    patch = {
      status: "accepted",
      phase: "ready",
      budget: mergeBudget(DEFAULT_BUDGET),
      activePlanId: null,
      activeActionId: null,
      steering: [],
      evidenceRefs: [],
      blockedReason: null,
      fallbackLane: null, // a minted task inherits no lane override; env default applies
      artifactRepair: { attempt: 0, maxAttempts: DEFAULT_BUDGET.maxArtifactRepairs, baseRevision: null, candidateRevision: null, lastGoodRevision: null, issues: [], status: "idle" },
      codeRepair: { attempt: 0, maxAttempts: DEFAULT_BUDGET.maxCodeRepairs, baseChangeSetId: null, candidateChangeSetId: null, lastGoodChangeSetId: null, issues: [], status: "idle" },
      metrics: { inferenceCalls: 0, repairCalls: 0, previewWaitMs: 0, artifactRevisionCount: 0 },
      startedAt: new Date().toISOString(),
      ...patch,
      // The minted id and the superseded-task link always win over the patch.
      id: `task-${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(16).slice(2, 7)}`,
      retargetedFromTaskId: previousTaskId,
    };
    appendAgentEvent("task.retargeted", "accepted", { previousTaskId, previousObjective, taskId: patch.id, objective: patch.objective }, { reversible: true });
  }
  // T7-S1: pin the pending question durably on the projection while the task
  // waits on the user (Chat reads task.question), and clear it the moment the
  // phase moves on so a stale question never lingers.
  if (patch.phase === "waiting_for_user" && patch.question === undefined) {
    patch = { ...patch, question: { prompt: String(patch.foregroundStep || agentTask.foregroundStep || "").trim(), askedAt: new Date().toISOString() } };
  } else if (patch.phase && patch.phase !== "waiting_for_user" && patch.question === undefined) {
    patch = { ...patch, question: null };
  }
  agentTask = { ...agentTask, sessionId, ...patch, updatedAt: new Date().toISOString() };
  writeAgentState();
  agentKernel?.syncTask(agentTask);
  const activeThread = agentTask.threadId ? threadManager.thread(agentTask.threadId) : null;
  if (activeThread) {
    threadManager.updateThread(agentTask.threadId, {
      title: agentTask.objective || activeThread.title,
      provider: agentTask.provider,
      model: agentTask.model,
      reasoning: agentTask.reasoning,
      autonomy: agentTask.autonomy,
      status: agentTask.status,
      phase: agentTask.phase,
      taskId: agentTask.id,
      activePlanId: agentTask.activePlanId || null,
      activeActionId: agentTask.activeActionId || null,
      taskSnapshot: agentTask,
      blockedReason: agentTask.blockedReason || null,
      evidenceRefs: agentTask.evidenceRefs || [],
      metrics: agentTask.metrics || {},
    });
  }
  if (emit) appendAgentEvent("task.updated", agentTask.status, { task: agentTask });
  // The /health monitor follows the task lifecycle: it polls only while a
  // task is mid-loop and a server is expected to answer.
  try { syncMapleHealthMonitor(); } catch { /* health monitor is advisory */ }
  return agentTask;
}

function bumpAgentMetrics(patch = {}) {
  const current = agentTask.metrics || { inferenceCalls: 0, repairCalls: 0, previewWaitMs: 0, artifactRevisionCount: 0 };
  const metrics = { ...current };
  for (const [key, value] of Object.entries(patch)) metrics[key] = Number(metrics[key] || 0) + Number(value || 0);
  updateAgentTask({ metrics }, { emit: false });
  return metrics;
}

function getAgentState() {
  const projection = agentKernel?.getProjection() || null;
  const artifacts = artifactRegistry.list();
  return {
    schema: "hemlock.agent.state.v1",
    sessionId,
    task: agentTask,
    server: serverState,
    dreamActive: Boolean(dreamProcess),
    sipsCycleActive,
    modelPath,
    python,
    storage: storageStatus(repoRoot),
    runtime: {
      root: runtimeDataRoot,
      sipsDir,
      legacySipsDir,
      workspace: projection ? {
        ...projection,
        artifacts,
        activeArtifactId,
        activeStreams: [...activeStreams.values()].map((stream) => streamStateSnapshot(stream)),
        previewSession: [...previewSessions.sessions.values()].at(-1) || null,
        steering: agentTask.steering || [],
      } : null,
    },
    storageInventory: runtimeStorageInventory(),
    providers: providerStatusSnapshot(),
    threads: threadManager.snapshot(),
    suggestions: threadManager.listSuggestions({ threadId: agentTask.threadId }),
    context: contextBroker.getState(),
    contextSources: contextSources.getState(),
    queue: agentIntentQueue?.snapshot() || { schema: "hemlock.agent.queue.v1", active: null, pending: [], count: 0 },
    experimentDataset: experimentDatasetSummary(),
    world: readWorldMarkers(48),
    events: agentEvents.slice(-160),
    commands: Object.entries(agentCommands).map(([id, descriptor]) => ({ id, ...descriptor })),
  };
}

// --- Understory world experiments ------------------------------------------
// Maple proposes; the host simulates deterministically and keeps the receipts.

function readExperimentRows(limit = 400) {
  return readJsonlFile(experimentDatasetPath, { tail: limit, schema: "hemlock.world.finding.v1", label: "experiment-dataset", onIntegrity: noteIntegrityRecovery });
}

function experimentDatasetSummary() {
  const { rows, count } = readExperimentRows(400);
  const latest = rows.at(-1) || null;
  return {
    schema: "hemlock.world.dataset.summary.v1",
    count,
    datasetPath: experimentDatasetPath,
    experiments: EXPERIMENTS,
    markerCount: readWorldMarkers(200).count,
    latest: latest ? { id: latest.id, experiment: latest.experiment, recordedAt: latest.recordedAt } : null,
  };
}

function experimentDatasetExamples(limit = 24) {
  return readExperimentRows(400).rows.slice(-limit)
    .map((row) => ({ messages: row.messages, metadata: row.metadata || { source: "experiment" } }))
    .filter((row) => Array.isArray(row.messages) && row.messages.length >= 2);
}

function loadExperimentReceipt(experimentId) {
  const safe = String(experimentId || "").replace(/[^a-zA-Z0-9-]/g, "");
  if (!safe) return null;
  if (experimentRuns.has(safe)) return experimentRuns.get(safe);
  const file = path.join(experimentReceiptsDir, `${safe}.json`);
  const parsed = readJsonFile(file, null, { label: "experiment-receipt" });
  return parsed?.schema === "hemlock.world.experiment.receipt.v1" ? { ...parsed, receiptPath: file } : null;
}

// Command-envelope keys that ride the payload but are not sim parameters —
// stripped before strict input validation so "action"/"hypothesis" never look
// like typo'd parameter names.
const EXPERIMENT_ENVELOPE_KEYS = new Set(["experiment", "input", "seed", "hypothesis", "action", "automatic", "operationId", "taskId", "threadId"]);

function stripExperimentEnvelope(obj = {}) {
  return Object.fromEntries(Object.entries(obj).filter(([key]) => !EXPERIMENT_ENVELOPE_KEYS.has(key) && !key.startsWith("__")));
}

async function runWorldExperiment(payload = {}) {
  const nested = payload.input && typeof payload.input === "object" ? payload.input : {};
  const hypothesis = String(payload.hypothesis || nested.hypothesis || "").trim() || null;
  appendAgentEvent("experiment.started", "running", { experiment: String(payload.experiment || nested.experiment || "").toLowerCase(), input: nested, hypothesis }, { reversible: true });
  const cleanNested = stripExperimentEnvelope(nested);
  const mergedInput = stripExperimentEnvelope({ ...nested, ...payload });
  const result = runExperiment({
    experiment: payload.experiment || nested.experiment,
    input: Object.keys(cleanNested).length && payload.experiment ? cleanNested : mergedInput,
    seed: payload.seed ?? nested.seed,
  });
  // Deterministic id: the same spec always mints the same receipt name, so a
  // repeated experiment re-verifies rather than silently multiplying evidence.
  const runId = `exp-${crypto.createHash("sha256").update(JSON.stringify({ experiment: result.experiment, input: result.input })).digest("hex").slice(0, 12)}`;
  fs.mkdirSync(experimentReceiptsDir, { recursive: true });
  const receiptPath = path.join(experimentReceiptsDir, `${runId}.json`);
  const receipt = {
    // result carries its own inner schema (hemlock.experiment.result.v1), so
    // the envelope fields must come after the spread — otherwise the receipt
    // fails the schema check every receipt reader applies.
    ...result,
    schema: "hemlock.world.experiment.receipt.v1",
    id: runId,
    hypothesis,
    // Hypothesis bookkeeping is honest bookkeeping: the host cannot verify a
    // natural-language claim, so a declared hypothesis stays "open" until a
    // hemlock.world.finding.v1 row cites this run's id — then "addressed".
    // confirmed/refuted is never a host-computed outcome.
    hypothesisOutcome: hypothesis
      ? (readExperimentRows(400).rows.some((row) => row.experimentId === runId) ? "addressed" : "open")
      : null,
    taskId: agentTask.id,
    receiptPath,
    recordedAt: new Date().toISOString(),
  };
  writeJsonAtomic(receiptPath, receipt);
  experimentRuns.set(runId, receipt);
  while (experimentRuns.size > 32) experimentRuns.delete(experimentRuns.keys().next().value);
  appendAgentEvent("experiment.completed", "passed", {
    experimentId: runId,
    experiment: result.experiment,
    divergence: result.divergence?.worst ?? null,
    steps: result.steps,
    computeMs: result.computeMs,
    input: result.input,
    trail: result.trail,
    hypothesisOutcome: receipt.hypothesisOutcome,
  }, { evidenceRefs: [receiptPath] });
  return { schema: "hemlock.world.experiment.result.v1", status: "completed", experiment: receipt, receiptPath };
}

async function recordExperimentFinding(payload = {}) {
  const input = { ...(payload.input && typeof payload.input === "object" ? payload.input : {}), ...payload };
  delete input.input;
  const receipt = loadExperimentReceipt(input.experimentId) || [...experimentRuns.values()].at(-1);
  if (!receipt) throw new Error("No world experiment receipt exists yet — run experiment.run before recording a finding.");
  const claim = String(input.claim || input.finding || "").trim();
  if (!claim) throw new Error("An experiment finding needs a claim about what the world showed.");
  const hypothesis = String(input.hypothesis || receipt.hypothesis || "").trim();
  const divergence = Number.isFinite(receipt.divergence?.worst) ? receipt.divergence.worst : null;
  const messages = [
    { role: "user", content: `In the understory world, a ${receipt.experiment} experiment ran with inputs ${JSON.stringify(receipt.input)}.${hypothesis ? ` Hypothesis: ${hypothesis}` : ""} What did the world show?` },
    { role: "assistant", content: `${claim} Measured: ${JSON.stringify(receipt.measured)}. Closed-form expectation: ${JSON.stringify(receipt.theory)}.${divergence != null ? ` Worst divergence: ${(divergence * 100).toFixed(2)}%.` : ""}` },
  ];
  const finding = {
    schema: "hemlock.world.finding.v1",
    id: `finding-${receipt.id}-${crypto.createHash("sha256").update(claim).digest("hex").slice(0, 8)}`,
    experimentId: receipt.id,
    experiment: receipt.experiment,
    hypothesis: hypothesis || null,
    claim,
    measured: receipt.measured,
    theory: receipt.theory,
    divergence: receipt.divergence || null,
    messages,
    metadata: { source: "experiment", experimentId: receipt.id, experiment: receipt.experiment, divergence },
    taskId: agentTask.id,
    recordedAt: new Date().toISOString(),
  };
  appendJsonlLine(experimentDatasetPath, finding);
  // A finding citing a hypothesized run flips its receipt to "addressed" —
  // the honest signal that an interpretation was recorded, never that the
  // claim was confirmed (the host cannot judge natural-language hypotheses).
  if (receipt.hypothesis && receipt.hypothesisOutcome !== "addressed") {
    receipt.hypothesisOutcome = "addressed";
    receipt.hypothesisAddressedAt = finding.recordedAt;
    receipt.addressedByFindingId = finding.id;
    if (experimentRuns.has(receipt.id)) experimentRuns.set(receipt.id, receipt);
    if (receipt.receiptPath) {
      try { writeJsonAtomic(receipt.receiptPath, receipt); } catch { /* the dataset row stays authoritative */ }
    }
  }
  // Mirror the finding into the Memory Garden review queue so world evidence
  // is inspectable where other candidates live — deduped by fingerprint.
  try {
    const candidate = agentKernel.createCandidate({
      kind: "experiment",
      title: `World finding: ${receipt.experiment}`,
      summary: claim,
      sourceRefs: [receipt.receiptPath, experimentDatasetPath].filter(Boolean),
      reason: "Recorded from a bounded world experiment",
      confidence: divergence != null ? (divergence < 0.02 ? 0.7 : divergence < 0.1 ? 0.55 : 0.35) : 0.5,
    });
    appendAgentEvent("candidate.created", "candidate", { candidate }, { evidenceRefs: candidate.sourceRefs, reversible: true });
  } catch { /* the dataset row is authoritative; the mirror is best-effort */ }
  appendAgentEvent("experiment.note.recorded", "recorded", {
    findingId: finding.id,
    experimentId: receipt.id,
    experiment: receipt.experiment,
    divergence,
  }, { evidenceRefs: [experimentDatasetPath, receipt.receiptPath].filter(Boolean) });
  return { schema: "hemlock.world.finding.result.v1", status: "recorded", finding, datasetPath: experimentDatasetPath, datasetRows: readExperimentRows().count };
}

const graftsPath = path.join(sipsDir, "grafts.jsonl");

function readGrafts(limit = 20) {
  const { rows, count } = readJsonlFile(graftsPath, { schema: "hemlock.dream.graft.v1", label: "graft-registry", onIntegrity: noteIntegrityRecovery });
  return { rows: rows.slice(-limit), count };
}

// Graft registry: every auto-grafted Dream adapter is recorded so the active
// graft is auditable and detachable — the base checkpoint itself is never
// touched (LoRA adapters only).
function registerGraft({ adapterPath, runId, trainingReceipt }) {
  const entry = {
    schema: "hemlock.dream.graft.v1",
    adapterPath,
    runId,
    baseModel: modelPath,
    adapterSha256: trainingReceipt?.trainingProof?.adapterArtifact?.sha256 || null,
    profile: trainingReceipt?.profile || null,
    graftedAt: new Date().toISOString(),
  };
  try {
    appendJsonlLine(graftsPath, entry);
  } catch { /* registry is best-effort; the adapter file itself is authoritative */ }
  appendAgentEvent("dream.adapter.grafted", "passed", entry, { evidenceRefs: [graftsPath, adapterPath].filter(Boolean) });
  return entry;
}

async function detachGraft() {
  const previous = serverState.adapterPath || null;
  const previousModel = serverState.modelPath && serverState.modelPath !== modelPath ? serverState.modelPath : null;
  await stopServer();
  void startServer();
  appendAgentEvent("dream.adapter.detached", "passed", { previousAdapter: previous, previousModel }, { reversible: true });
  return { schema: "hemlock.dream.graft.result.v1", status: "detached", previousAdapter: previous, previousModel, grafts: readGrafts() };
}

function runPythonCommand(args, { timeoutMs = 600000, cwd = repoRoot } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnPython([...pythonFlags, ...args], { cwd, env: pythonEnvironment(), stdio: ["ignore", "pipe", "pipe"] });
    const stderrTail = [];
    child.stderr.on("data", (chunk) => { stderrTail.push(String(chunk)); if (stderrTail.length > 12) stderrTail.shift(); });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`python ${args[0]} timed out after ${Math.round(timeoutMs / 60000)}m`)); }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`python ${args.join(" ").slice(0, 120)} exited ${code ?? signal}: ${stderrTail.join("").slice(-400)}`));
    });
  });
}

// Fuse a verified graft into a NEW checkpoint dir and serve it. The base
// checkpoint is left on disk untouched — rollback is detachGraft(), which
// restarts on the base path. Weights are mutable policy, not an invariant;
// the fuse receipt keeps the mutation auditable.
async function fuseGraft(payload = {}) {
  const adapterPath = path.resolve(String(payload.adapterPath || serverState.adapterPath || ""));
  if (!adapterPath || !fs.existsSync(adapterPath)) throw new Error("No grafted adapter to fuse — run a Dream first (or pass adapterPath).");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fusedDir = path.join(sipsDir, "fused", `maple-fused-${stamp}`);
  appendAgentEvent("dream.fuse.started", "running", { adapterPath, baseModel: modelPath, fusedDir }, { reversible: true });
  await runPythonCommand(["-m", "mlx_lm", "fuse", "--model", modelPath, "--adapter-path", adapterPath, "--save-path", fusedDir, "--trust-remote-code"]);
  const problem = mlxCheckpointProblem(fusedDir);
  if (problem) throw new Error(`Fused checkpoint at ${fusedDir} is incomplete (missing ${problem}).`);
  await stopServer();
  void startServer("", fusedDir);
  const entry = { schema: "hemlock.dream.graft.v1", kind: "fused", adapterPath, fusedModelPath: fusedDir, baseModel: modelPath, fusedAt: new Date().toISOString() };
  try { appendJsonlLine(graftsPath, entry); } catch { /* registry is best-effort */ }
  appendAgentEvent("dream.fused", "passed", entry, { evidenceRefs: [graftsPath, fusedDir], reversible: true });
  return { schema: "hemlock.dream.fuse.result.v1", status: "fused", fusedModelPath: fusedDir, adapterPath, rollback: "dream.detach returns to the base checkpoint", grafts: readGrafts() };
}

function experimentDataset(payload = {}) {
  const limit = Math.max(1, Math.min(400, Math.round(Number(payload.limit ?? payload.input?.limit) || 60)));
  const { rows, count } = readExperimentRows(limit);
  return { schema: "hemlock.world.dataset.v1", status: "read", count, rows, markerCount: readWorldMarkers(200).count, datasetPath: experimentDatasetPath, evidenceRefs: [experimentDatasetPath] };
}

// Every durable run receipt on disk, sorted by filename for a deterministic
// coverage basis — the in-memory map is only a this-session cache.
function readExperimentReceipts(limit = 400) {
  let names = [];
  try {
    names = fs.readdirSync(experimentReceiptsDir).filter((name) => name.endsWith(".json")).sort();
  } catch {
    names = [];
  }
  const receipts = [];
  for (const name of names.slice(-limit)) {
    // Corrupt receipts are quarantined + journaled by readJsonFile — a
    // malformed receipt is evidence, not noise to skip silently.
    const parsed = readJsonFile(path.join(experimentReceiptsDir, name), null, { label: "experiment-receipt" });
    if (parsed?.schema === "hemlock.world.experiment.receipt.v1") receipts.push(parsed);
  }
  return receipts;
}

// experiment.suggest — ranks coverage gaps from durable records only, so Maple
// can pick the next experiment like a scientist instead of at random.
function experimentSuggest(payload = {}) {
  const limit = Math.max(1, Math.min(48, Math.round(Number(payload.limit ?? payload.input?.limit) || 12)));
  const receipts = readExperimentReceipts(400);
  const findings = readExperimentRows(400).rows;
  const { suggestions, coverageSummary } = suggestExperiments({ receipts, findings, limit });
  appendAgentEvent("world.suggest", "suggested", {
    suggestionCount: suggestions.length,
    top: suggestions[0] ? { experiment: suggestions[0].experiment, reason: suggestions[0].reason } : null,
    coverageSummary,
  }, { evidenceRefs: [experimentDatasetPath, experimentReceiptsDir], reversible: true });
  return {
    schema: "hemlock.world.suggest.v1",
    status: "read",
    suggestions,
    coverageSummary,
    markerCount: readWorldMarkers(200).count,
    datasetPath: experimentDatasetPath,
    receiptsDir: experimentReceiptsDir,
    evidenceRefs: [experimentDatasetPath, experimentReceiptsDir],
    claimBoundary: "Suggestions rank gaps in recorded receipts and findings only; they derive from history and predict nothing about outcomes.",
    summary: suggestions.length
      ? `${suggestions.length} coverage gap(s); top: ${suggestions[0].experiment} — ${suggestions[0].reason}`
      : "No coverage gaps found across recorded experiments.",
  };
}

// --- Understory grove markers + self/world projections -----------------------
// world.place is the only command that mutates the grove; its markers persist
// beside the experiment dataset and are re-read by world.state and the
// renderer's grove bindings — no marker exists until a world.placed event does.
const worldMarkersPath = path.join(sipsDir, "world-markers.jsonl");
const WORLD_MARKER_KINDS = new Set(["marker", "monument", "sign"]);

function readWorldMarkers(limit = 200) {
  return readJsonlFile(worldMarkersPath, { tail: limit, schema: "hemlock.world.marker.v1", label: "world-markers", onIntegrity: noteIntegrityRecovery });
}

// Deterministic placement for world.place calls that omit a position: the
// marker fingerprint seeds a polar scatter inside the lit understory so the
// same label always lands in the same spot.
function seededMarkerPosition(fingerprint) {
  const digest = crypto.createHash("sha256").update(String(fingerprint)).digest();
  const angle = (digest[0] / 255) * Math.PI * 2 + (digest[1] / 255) * 0.6;
  const radius = 4 + (digest[2] / 255) * 14;
  return { x: Math.round(Math.cos(angle) * radius * 100) / 100, z: Math.round(Math.sin(angle) * radius * 100) / 100 };
}

function placeWorldMarker(payload = {}) {
  const kind = String(payload.kind || "marker").trim().toLowerCase();
  if (!WORLD_MARKER_KINDS.has(kind)) throw new Error(`world.place kind must be marker, monument, or sign — got "${kind}".`);
  const label = String(payload.label || "").trim().slice(0, 80);
  if (!label) throw new Error("world.place needs a label — the grove does not render nameless artifacts.");
  const note = String(payload.note || "").trim().slice(0, 500) || null;
  const fingerprint = crypto.createHash("sha256").update(`${kind}:${label.toLowerCase()}`).digest("hex").slice(0, 12);
  const existing = readWorldMarkers(400).rows.find((row) => row.fingerprint === fingerprint);
  if (existing) {
    return { schema: "hemlock.world.place.result.v1", status: "existing", marker: existing, markers: readWorldMarkers(200).count, markersPath: worldMarkersPath, summary: `A ${kind} labeled "${label}" already stands in the grove.` };
  }
  const raw = payload.position && typeof payload.position === "object" ? payload.position : {};
  let position = null;
  if (Number.isFinite(Number(raw.x)) && Number.isFinite(Number(raw.z))) {
    const x = Number(raw.x);
    const z = Number(raw.z);
    const radius = Math.hypot(x, z);
    const scale = radius > 30 ? 30 / radius : 1; // keep markers inside the lit understory ring
    position = { x: Math.round(x * scale * 100) / 100, z: Math.round(z * scale * 100) / 100 };
  }
  const marker = {
    schema: "hemlock.world.marker.v1",
    id: `marker-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`,
    fingerprint,
    kind,
    label,
    note,
    position: position || seededMarkerPosition(fingerprint),
    seededPosition: !position,
    taskId: agentTask.id,
    placedAt: new Date().toISOString(),
  };
  appendJsonlLine(worldMarkersPath, marker);
  appendAgentEvent("world.placed", "placed", { marker }, { evidenceRefs: [worldMarkersPath], reversible: true });
  return { schema: "hemlock.world.place.result.v1", status: "placed", marker, markers: readWorldMarkers(200).count, markersPath: worldMarkersPath, evidenceRefs: [worldMarkersPath], summary: `Placed a ${kind} labeled "${label}" in the understory grove.` };
}

// Recent experiment receipts on disk, newest first — the grove's landmarks.
function listExperimentReceipts(limit = 5) {
  let names = [];
  try {
    names = fs.readdirSync(experimentReceiptsDir).filter((name) => name.endsWith(".json"));
  } catch {
    names = [];
  }
  const entries = names.map((name) => {
    const filePath = path.join(experimentReceiptsDir, name);
    let mtime = 0;
    try { mtime = fs.statSync(filePath).mtimeMs; } catch { /* keep 0 */ }
    return { filePath, mtime };
  }).sort((a, b) => b.mtime - a.mtime);
  const recent = entries.slice(0, Math.max(1, limit)).map((entry) => {
    const parsed = readJsonFile(entry.filePath, null, { label: "experiment-receipt" });
    const receipt = parsed?.schema === "hemlock.world.experiment.receipt.v1" ? parsed : null;
    const worst = Number(receipt?.divergence?.worst);
    return {
      id: receipt?.id || path.basename(entry.filePath, ".json"),
      experiment: receipt?.experiment || null,
      verdict: Number.isFinite(worst) ? (worst < 0.05 ? "within-tolerance" : "diverged") : "recorded",
      divergenceWorst: Number.isFinite(worst) ? worst : null,
      recordedAt: receipt?.recordedAt || null,
    };
  });
  return { count: entries.length, recent };
}

// Mirrors the renderer's groveBindings ambience math on the same event spine,
// so world.state reports the grove the user would actually see.
const WORLD_BOUND_EVENT = /^inference\.|^dream\.|^experiment\.|^memory\.|^sips\.|^(action|command|operation)\.|^(task|plan)\.|^world\./;
function worldAmbience(now = Date.now()) {
  let dreamAt = null;
  let dreamHeat = 0;
  let recentFailures = 0;
  let recentBound = 0;
  for (const event of agentEvents) {
    const type = String(event?.type || "");
    if (!WORLD_BOUND_EVENT.test(type)) continue;
    const at = Date.parse(event.createdAt || "") || now;
    if (now - at < 120000) recentBound += 1;
    const failed = event.status === "failed" || event.status === "blocked" || type.includes("failed") || type.includes("blocked");
    if (failed && now - at < 300000) recentFailures += 1;
    if (/^dream\./.test(type) && (dreamAt === null || at >= dreamAt)) {
      dreamAt = at;
      dreamHeat = failed ? 0.15 : /started|running|progress|fus/i.test(type) ? 1 : 0.55;
    }
  }
  return {
    dream: dreamAt === null ? 0 : dreamHeat * Math.max(0, 1 - (now - dreamAt) / (12 * 60 * 1000)),
    alert: Math.min(1, recentFailures / 2),
    bustle: Math.min(1, recentBound / 8),
  };
}

// world.state — the model-facing grove projection. It reads the same durable
// records the renderer binds: the event spine, experiment receipts, the
// findings dataset, and the marker store.
function worldStateSnapshot() {
  const dataset = experimentDatasetSummary();
  const markers = readWorldMarkers(200);
  const landmarks = listExperimentReceipts(5);
  return {
    schema: "hemlock.world.state.v1",
    status: "read",
    landmarks: { experimentReceipts: landmarks.count, markers: markers.count },
    experiments: landmarks.recent,
    dataset: { rows: dataset.count, latest: dataset.latest, datasetPath: dataset.datasetPath },
    markers: markers.rows.slice(-48),
    ambience: worldAmbience(),
    evidenceRefs: [experimentDatasetPath, worldMarkersPath, experimentReceiptsDir],
    claimBoundary: "Reads durable local records only; ambience derives from this session's event spine and predicts nothing.",
    summary: `The grove holds ${landmarks.count} experiment receipts, ${dataset.count} findings, and ${markers.count} placed markers.`,
  };
}

// The advertised context ceiling comes from the checkpoint's own config.json
// (read once, cached) — never a hardcoded claim. The enforced budget is much
// lower (budget.contextMaxTokens): KV memory on the full-attention layers is
// the real constraint, not positions.
let cachedModelContextCeiling;
function modelContextCeiling() {
  if (cachedModelContextCeiling !== undefined) return cachedModelContextCeiling;
  try {
    const config = JSON.parse(fs.readFileSync(path.join(modelPath, "config.json"), "utf8"));
    const value = Number(config?.max_position_embeddings ?? config?.text_config?.max_position_embeddings);
    cachedModelContextCeiling = Number.isFinite(value) && value > 0 ? Math.round(value) : null;
    // Publish the real ceiling for the context-budget seam: the orchestrator
    // clamps HEMLOCK_CONTEXT_MAX_TOKENS against modelMax minus generation
    // headroom and reads this env per call. When config is unreadable the
    // seam falls back to Maple's verified 128000.
    if (cachedModelContextCeiling != null) process.env.HEMLOCK_MODEL_MAX_TOKENS = String(cachedModelContextCeiling);
  } catch {
    cachedModelContextCeiling = null;
  }
  return cachedModelContextCeiling;
}

// agent.self — the model-facing self snapshot. Everything below reads
// host-owned state; nothing is synthesized.
function agentSelfSnapshot() {
  const { classifyFailure, failureHint, resolveFailureClass } = require("./agent_contracts.cjs");
  const { classifyInferenceError } = require("./error_taxonomy.cjs");
  // Hand the registry to the kernel so its failure-observation suggestions can
  // name required inputHint fields; idempotent, and read paths stay pure.
  agentKernel?.attachCommandRegistry?.(agentCommands);
  const projection = agentKernel.getProjection();
  const kernelTask = projection?.task && typeof projection.task === "object" ? projection.task : {};
  const budget = mergeBudget({ ...(agentTask.budget || {}), ...(kernelTask.budget || {}) });
  const queue = agentIntentQueue?.snapshot() || { active: null, pending: [], count: 0 };
  const pendingEntries = Array.isArray(queue.pending) ? queue.pending : [];
  const ownPosition = pendingEntries.findIndex((entry) => entry?.payload?.taskId === agentTask.id || entry?.taskId === agentTask.id);
  const pendingApprovals = [
    ...(projection.plans || []).filter((plan) => plan.status === "proposed").map((plan) => ({ type: "plan", id: plan.id, label: String(plan.rationale || plan.title || plan.id).slice(0, 140) })),
    ...(projection.actions || []).filter((action) => ["proposed", "validated"].includes(action.status)).map((action) => ({ type: "action", id: action.id, label: String(action.commandId || action.kind || action.id).slice(0, 140) })),
    ...(agentTask.question?.prompt ? [{ type: "question", id: agentTask.question.id || agentTask.id, label: String(agentTask.question.prompt).slice(0, 140) }] : []),
  ].slice(-12);
  const dataset = experimentDatasetSummary();
  const markers = readWorldMarkers(200);
  // Failure teaching on the durable spine: the last action/inference failures
  // the host recorded, each with its class and the host-authored next step.
  const actionsById = new Map((projection.actions || []).map((action) => [action.id, action]));
  const isFailureEvent = (event) => {
    const type = String(event?.type || "");
    const failed = event?.status === "failed" || event?.status === "blocked" || type.includes("fail") || type.includes("blocked");
    return failed && (type.startsWith("action.") || type.startsWith("inference.") || type === "observation.recorded" || type === "command.blocked");
  };
  const recentFailures = agentEvents.filter(isFailureEvent).slice(-5).map((event) => {
    const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
    const action = payload.actionId ? actionsById.get(payload.actionId) : payload.action || null;
    const commandId = payload.commandId || payload.command || action?.commandId || payload.observation?.commandId || null;
    const errorClass = resolveFailureClass(
      payload.category || payload.errorClass || payload.failureCategory || action?.failureCategory || action?.errorClass || payload.observation?.errorClass
        || (event.type === "inference.failed"
          ? classifyInferenceError({ message: payload.error, code: payload.code, status: payload.status }).kind
          : classifyFailure(null, { code: payload.code, error: payload.error || payload.reason || payload.observation?.error })),
      { message: payload.error || payload.reason || payload.observation?.error },
    );
    const suggestion = payload.observation?.suggestion || action?.suggestion
      || failureHint(errorClass, { message: payload.error || payload.reason || payload.observation?.error, commandId, inputHint: agentCommands[commandId]?.inputHint });
    return { type: event.type, commandId, errorClass, suggestion, createdAt: event.createdAt };
  });
  // Current capability boundary — the same allowedNextCommands the action
  // prompt advertises, recomputed only if the orchestrator is live.
  let allowedNow = null;
  try {
    const activePlan = (projection.plans || []).find((plan) => plan.id === agentTask.activePlanId) || { steps: [] };
    const allowed = agentOrchestrator?.allowedNextCommands?.(agentTask, activePlan, agentKernel.getTaskHistory(agentTask.id));
    if (Array.isArray(allowed)) {
      allowedNow = allowed.map((entry) => ({
        commandId: entry.commandId,
        capability: entry.capability || agentCommands[entry.commandId]?.capability || null,
        source: entry.source || null,
        inputHint: entry.hint || agentCommands[entry.commandId]?.inputHint || null,
      }));
    }
  } catch { allowedNow = null; }
  // Memory ledger summary from durable records + the event spine.
  let memoryRecords = null;
  let memoryDemoted = null;
  try {
    const memoryLedgerPath = path.join(sipsDir, "memory.jsonl");
    if (fs.existsSync(memoryLedgerPath)) {
      const { rows } = readJsonlFile(memoryLedgerPath, { label: "memory-ledger", onIntegrity: noteIntegrityRecovery });
      memoryRecords = rows.length;
      memoryDemoted = rows.reduce((count, row) => (row?.status === "demoted" ? count + 1 : count), 0);
    }
  } catch { /* ledger unreadable — honest nulls below */ }
  const lastConsolidated = [...agentEvents].reverse().find((event) => event.type === "memory.consolidated");
  const memory = {
    records: memoryRecords ?? ((Number(projection?.memory?.candidates) || 0) + (Number(projection?.memory?.promoted) || 0)),
    promoted: Number(projection?.memory?.promoted) || 0,
    candidates: Number(projection?.memory?.candidates) || 0,
    demoted: memoryDemoted ?? agentEvents.filter((event) => event.type === "memory.demote" || event.type === "memory.demoted").length,
    lastConsolidatedAt: lastConsolidated?.createdAt || null,
    lastUpdatedAt: projection?.memory?.lastUpdatedAt || null,
  };
  return {
    schema: "hemlock.agent.self.v1",
    status: "ok",
    task: {
      id: agentTask.id,
      status: agentTask.status,
      phase: agentTask.phase,
      objective: agentTask.objective,
      autonomy: agentTask.autonomy,
    },
    budget: {
      agentStepsUsed: budget.agentStepsUsed,
      maxAgentSteps: budget.maxAgentSteps,
      commandsUsed: budget.commandsUsed,
      maxCommands: budget.maxCommands,
    },
    queue: {
      pending: pendingEntries.length,
      position: ownPosition >= 0 ? ownPosition + 1 : null,
    },
    pendingApprovals,
    recentFailures,
    allowedNow,
    memory,
    // Real context accounting written back by the action loop from server
    // usage. usedTokens is usage-derived (last step's prompt+completion ≈
    // committed context); estimatedTokens is the chars/4 guard heuristic and
    // stays labeled. A contextUsage from a superseded task id reports nulls
    // rather than presenting stale numbers as current.
    context: (() => {
      const usage = agentTask.contextUsage && typeof agentTask.contextUsage === "object" && (!agentTask.contextUsage.taskId || agentTask.contextUsage.taskId === agentTask.id)
        ? agentTask.contextUsage
        : {};
      const number = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
      // The enforced ceiling resolves the task's stored pin (or the live
      // env/kv-aware default when unpinned) clamped to the model ceiling
      // minus generation headroom — practicalCeiling is that enforced number,
      // the real bound Maple can use. modelContextCeiling() runs first so its
      // HEMLOCK_MODEL_MAX_TOKENS publish lands before the resolver reads it.
      const modelMax = modelContextCeiling();
      const ceiling = require("./agent_orchestrator.cjs").resolveContextMaxTokens({ budget });
      return {
        usedTokens: number(usage.usedTokens),
        promptTokens: number(usage.promptTokens),
        completionTokens: number(usage.completionTokens),
        cachedTokens: number(usage.cachedTokens),
        estimatedTokens: number(usage.estimatedTokens),
        maxTokens: ceiling.requestedMaxTokens,
        maxTokensClamped: ceiling.clamped,
        practicalCeiling: Math.min(ceiling.maxTokens, Number.isFinite(modelMax) ? modelMax : ceiling.maxTokens),
        kvBits: ceiling.kvBits,
        modelMaxTokens: modelMax,
        source: usage.source || null,
        updatedAt: usage.updatedAt || null,
      };
    })(),
    server: {
      processReady: serverState.processReady === true,
      inferenceReady: serverState.inferenceReady === true,
      adapterPath: serverState.adapterPath || null,
      lastWarmAt: serverState.lastWarmAt || null,
      warmCachedTokens: Number.isFinite(Number(serverState.warmCachedTokens)) ? Number(serverState.warmCachedTokens) : null,
    },
    counts: {
      artifacts: artifactRegistry.list().length,
      memories: {
        promoted: Number(projection?.memory?.promoted) || 0,
        candidate: Number(projection?.memory?.candidates) || 0,
      },
      experimentFindings: dataset.count,
      markers: markers.count,
    },
    recentReceipts: agentEvents.filter((event) => event.evidenceRefs?.length).slice(-5).map((event) => ({ type: event.type, status: event.status, createdAt: event.createdAt, id: event.id })),
    evidenceRefs: [sessionEventsPath],
    claimBoundary: "A read-only snapshot of host-owned state; it records what the host has already observed and predicts nothing.",
    summary: `Task ${agentTask.status}/${agentTask.phase}; ${budget.commandsUsed}/${budget.maxCommands} commands used; ${pendingApprovals.length} approvals pending.`,
  };
}

async function recordAgentMemory(payload = {}) {
  const body = String(payload.body || "").trim();
  if (!body) throw new Error("A Hemlock memory record needs a reusable lesson body.");
  const status = payload.explicitPromotion === true && payload.status === "active" ? "active" : "candidate";
  const record = await runSipsRuntime({
    action: "record",
    title: payload.title || "Hemlock project lesson",
    body,
    tags: payload.tags || "hemlock,agent,lesson",
    tier: payload.tier || "learning",
    status,
    confidence: payload.confidence || "medium",
    verifyBeforeUse: payload.verifyBeforeUse !== false,
    evidencePath: payload.evidencePath || sessionEventsPath,
    provenance: payload.provenance || `Hemlock agent session ${sessionId}`,
  });
  appendAgentEvent(status === "candidate" ? "memory.candidate.created" : "memory.promoted", "recorded", {
    title: payload.title || "Hemlock project lesson",
    memoryPath: record.memoryPath,
    record: record.record,
  }, { evidenceRefs: [sessionEventsPath], reversible: true });
  return record;
}

function classifyIntent(text) {
  return classifyScopedIntent(text);
}

function resolveThreadForIntent(payload = {}, selection = {}) {
  if (payload.threadId) {
    const thread = threadManager.switchThread(String(payload.threadId));
    if (payload.workspaceRoot && path.resolve(payload.workspaceRoot) !== path.resolve(thread.workspaceRoot || "")) {
      throw new Error("The selected thread already has a different workspace directory.");
    }
    return thread;
  }
  if (payload.workspaceRoot && path.resolve(payload.workspaceRoot) !== path.resolve(agentTask.workspaceRoot || repoRoot)) {
    return threadManager.createThread({
      workspaceRoot: payload.workspaceRoot,
      title: payload.title || payload.text || payload.objective || "New Hemlock thread",
      provider: selection.provider,
      model: selection.model,
      reasoning: selection.reasoning,
      autonomy: payload.autonomy || "bounded-local",
    });
  }
  return threadManager.thread(agentTask.threadId) || threadManager.ensureDefaultThread({ workspaceRoot: payload.workspaceRoot || repoRoot, task: agentTask });
}

function compileThreadContext(threadId = agentTask.threadId, options = {}) {
  const thread = threadManager.thread(threadId);
  if (!thread) throw new Error(`Hemlock thread was not found: ${threadId}`);
  const project = threadManager.project(thread.projectId);
  const checkpoint = threadManager.latestCheckpoint(thread.id);
  const compact = options.compact === true;
  const checkpointSummary = checkpoint && compact ? {
    schema: checkpoint.schema,
    id: checkpoint.id,
    threadId: checkpoint.threadId,
    taskId: checkpoint.taskId,
    projectId: checkpoint.projectId,
    phase: checkpoint.phase,
    status: checkpoint.status,
    activePlanStep: checkpoint.activePlanStep,
    pendingAction: checkpoint.pendingAction ? {
      id: checkpoint.pendingAction.id || null,
      step: checkpoint.pendingAction.step || null,
      kind: checkpoint.pendingAction.kind || null,
      commandId: checkpoint.pendingAction.commandId || null,
      status: checkpoint.pendingAction.status || null,
    } : null,
    completedCommandSummaries: checkpoint.completedCommandSummaries || [],
    evidenceRefs: checkpoint.evidenceRefs || [],
    currentWorkspaceDigest: checkpoint.currentWorkspaceDigest || null,
    lastGoodRevision: checkpoint.lastGoodRevision ?? null,
    artifactRepair: checkpoint.artifactRepair || null,
    verificationIssues: checkpoint.verificationIssues || [],
    autonomyPolicy: checkpoint.autonomyPolicy || thread.autonomy,
    reason: checkpoint.reason || null,
  } : checkpoint;
  return {
    schema: "hemlock.agent.context.v1",
    thread: { id: thread.id, title: thread.title, provider: thread.provider, model: thread.model, reasoning: thread.reasoning, autonomy: thread.autonomy, phase: thread.phase, status: thread.status },
    project: project ? { id: project.id, displayName: project.displayName, workspaceRoot: project.workspaceRoot, rootDigest: project.rootDigest, projectBrief: project.projectBrief || null } : null,
    checkpoint: checkpointSummary ? { ...checkpointSummary, pendingAction: checkpointSummary.pendingAction || null, completedCommandSummaries: checkpointSummary.completedCommandSummaries || [], evidenceRefs: checkpointSummary.evidenceRefs || [] } : null,
    workspace: thread.workspaceRoot ? { root: thread.workspaceRoot, digest: workspaceFingerprint(thread.workspaceRoot) } : null,
    conversation: compact ? [] : threadManager.readConversation(thread.id),
    suggestions: threadManager.listSuggestions({ threadId: thread.id, status: "unread" }).slice(-8).map((item) => compact ? ({ suggestionId: item.suggestionId, kind: item.kind, title: item.title, summary: item.summary, evidenceRefs: item.evidenceRefs }) : item),
    claimBoundary: "This is compact host-owned context. It contains scoped task state and receipts, not an assertion that any unrecorded work occurred.",
  };
}

async function processAgentIntent(payload = {}) {
  const resolved = resolveInteraction(payload);
  const text = resolved.text;
  if (!text) throw new Error("Hemlock needs an intent before it can create a task.");
  const intent = String(payload.intent || resolved.intent);
  const interactionMode = resolved.interactionMode;
  const selection = normalizeSelection({ provider: payload.provider || payload.modelProvider, model: payload.model, reasoning: payload.reasoning });
  const thread = resolveThreadForIntent(payload, selection);
  if (payload.apiBase) agentInferenceEndpoint = String(payload.apiBase).replace(/\/$/, "");
  const taskId = `task-${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(16).slice(2, 7)}`;
  updateAgentTask({
    id: taskId,
    objective: text.slice(0, 12000),
    intent,
    interactionMode,
    threadId: thread?.id || null,
    projectId: thread?.projectId || null,
    workspaceRoot: thread?.workspaceRoot || repoRoot,
    autonomy: payload.autonomy || thread?.autonomy || "bounded-local",
    phase: "recall",
    status: "accepted",
    foregroundStep: "Recall scoped context and prepare a bounded plan",
    // Wall-clock budget starts at task creation, not lazily at the first
    // action step — conversation-mode and pre-step tasks otherwise report
    // wallClockStartedAt: null forever.
    budget: { ...mergeBudget(DEFAULT_BUDGET), wallClockStartedAt: Date.now() },
    steering: [],
    provider: selection.provider,
    model: selection.model || null,
    reasoning: selection.reasoning,
    // Per-task lane fallback override (HEMLOCK_FALLBACK_LANE is the global
    // default): codex|claude pins a lane, "none" disables the fallback for
    // this task. Unset → env default. Consumed by the orchestrator's
    // lane-fallback path in agent_orchestrator.cjs.
    fallbackLane: ["codex", "claude", "none"].includes(String(payload.fallbackLane || "").toLowerCase()) ? String(payload.fallbackLane).toLowerCase() : null,
    evidenceRefs: [],
    blockedReason: null,
    artifactRepair: { attempt: 0, maxAttempts: DEFAULT_BUDGET.maxArtifactRepairs, baseRevision: null, candidateRevision: null, lastGoodRevision: null, issues: [], status: "idle" },
    codeRepair: { attempt: 0, maxAttempts: DEFAULT_BUDGET.maxCodeRepairs, baseChangeSetId: null, candidateChangeSetId: null, lastGoodChangeSetId: null, issues: [], status: "idle" },
    metrics: { inferenceCalls: 0, repairCalls: 0, previewWaitMs: 0, artifactRevisionCount: 0 },
    startedAt: new Date().toISOString(),
  });
  threadManager.checkpoint(agentTask.threadId, { taskId: taskId, phase: "conversation", status: "accepted", reason: "intent-accepted", provider: selection.provider, model: selection.model, reasoning: selection.reasoning, autonomyPolicy: agentTask.autonomy });
  appendAgentEvent("task.created", "accepted", { task: agentTask, source: payload.source || "command-center" });
  appendAgentEvent("prompt.submitted", "received", { content: text.slice(0, 1000), intent, interactionMode, source: payload.source || "command-center" });
  threadManager.appendConversation(agentTask.threadId, { role: "user", content: text, provider: selection.provider, model: selection.model, reasoning: selection.reasoning });
  // Auto-title: a thread still carrying its default title takes its name from
  // the first user message, so the picker shows recognizable identities.
  {
    const autoTitleThread = threadManager.thread(agentTask.threadId);
    if (autoTitleThread && (!autoTitleThread.title || autoTitleThread.title === "New Hemlock thread" || autoTitleThread.title === "Hemlock thread")) {
      const derivedTitle = (String(payload.title || "").replace(/\s+/g, " ").trim() || text.replace(/\s+/g, " ").trim()).slice(0, 60) || autoTitleThread.title;
      if (derivedTitle && derivedTitle !== autoTitleThread.title) {
        threadManager.updateThread(agentTask.threadId, { title: derivedTitle });
        agentTask = { ...agentTask, objective: agentTask.objective && agentTask.objective !== "New Hemlock thread" ? agentTask.objective : derivedTitle };
      }
    }
  }

  let context = null;
  try {
    context = await contextBroker.refresh({ reason: "intent", task: agentTask });
  } catch (error) {
    appendAgentEvent("context.refresh.failed", "degraded", { error: error.message, reason: "intent" }, { reversible: true });
  }

  let recall = { schema: "hemlock.agent.recall.v1", status: "unavailable", records: [], reason: "SIPS memory was not queried." };
  try {
    recall = await runSipsRuntime({ action: "recall", query: text, limit: 8 });
    appendAgentEvent("memory.recalled", "passed", { query: text, count: recall.records?.length || 0, records: recall.records || [] }, { evidenceRefs: [path.join(sipsDir, "memory.jsonl")] });
  } catch (error) {
    appendAgentEvent("memory.recall.failed", "degraded", { query: text, error: error.message }, { reversible: true });
  }

  updateAgentTask({
    phase: intent === "conversation" ? "work" : "plan",
    status: intent === "conversation" ? "running" : "planning",
    foregroundStep: intent === "conversation" ? `${selection.label} is answering from the selected Hemlock lane` : "Choose the next bounded action from context and evidence",
    evidenceRefs: [...new Set([...(agentTask.evidenceRefs || []), ...(context?.evidenceRefs || []), ...(recall?.evidenceRefs || [])])],
    recall: { ...recall },
  });

  // Casual conversation is a first-class local interaction, not a coding plan.
  // It still receives a durable task and command receipt, but it should not
  // force the user through a plan-approval ceremony for “hey, how are ya?”.
  if (intent === "conversation" && payload.directChat !== false) {
    // Thread-owned context: the authoritative transcript is the thread's
    // stored conversation, not the renderer's local state. The renderer's
    // message array can contain cross-thread bleed or stale entries; the
    // backend conversation log cannot. Fall back to the payload only if the
    // thread has no stored history yet (first message of a fresh thread).
    const storedConversation = agentTask.threadId ? threadManager.readConversation(agentTask.threadId) : [];
    const storedMessages = storedConversation
      .map((entry) => ({ role: entry.role, content: String(entry.content || "") }))
      .filter((message) => ["user", "assistant"].includes(message.role) && message.content);
    const messages = storedMessages.length
      ? [...storedMessages, { role: "user", content: text }]
      : Array.isArray(payload.messages) && payload.messages.length
        ? payload.messages.map((message) => ({ role: message.role, content: String(message.content || "") })).filter((message) => ["system", "user", "assistant"].includes(message.role) && message.content)
        : [{ role: "user", content: text }];
    let inference = await runInference({
      apiBase: payload.apiBase,
      adapterPath: payload.adapterPath,
      provider: selection.provider,
      model: selection.model,
      reasoning: selection.reasoning,
      messages,
      taskId: agentTask.id,
      threadId: agentTask.threadId,
      workspaceRoot: agentTask.workspaceRoot,
      operationId: payload.operationId || null,
      temperature: Number.isFinite(payload.temperature) ? payload.temperature : 0.7,
      top_p: Number.isFinite(payload.top_p) ? payload.top_p : 0.95,
      top_k: Number.isFinite(payload.top_k) ? payload.top_k : 20,
      max_tokens: Number.isFinite(payload.max_tokens) ? payload.max_tokens : mapleMaxTokens,
    });
    // Length-guard: if the model consumed its entire token budget on the
    // thinking channel and produced no visible answer, retry once with the
    // thinking channel disabled so the user gets a real response instead of
    // an empty transcript row. Only for local lanes that honor the flag.
    const lengthChoice = inference.payload?.choices?.[0] || {};
    const lengthMessage = lengthChoice.message || {};
    const lengthAnswer = String(inference.answer || lengthMessage.content || "").trim();
    if (lengthChoice.finish_reason === "length" && !lengthAnswer && selection.provider === "maple") {
      appendAgentEvent("inference.retrying", "running", { reason: "token budget consumed by reasoning channel; retrying without thinking", threadId: agentTask.threadId }, { reversible: true });
      inference = await runInference({
        apiBase: payload.apiBase,
        adapterPath: payload.adapterPath,
        provider: selection.provider,
        model: selection.model,
        reasoning: "off",
        messages,
        taskId: agentTask.id,
        threadId: agentTask.threadId,
        workspaceRoot: agentTask.workspaceRoot,
        operationId: payload.operationId || null,
        temperature: Number.isFinite(payload.temperature) ? payload.temperature : 0.7,
        top_p: Number.isFinite(payload.top_p) ? payload.top_p : 0.95,
        top_k: Number.isFinite(payload.top_k) ? payload.top_k : 20,
        max_tokens: Number.isFinite(payload.max_tokens) ? payload.max_tokens : mapleMaxTokens,
      });
    }
    const choice = inference.payload?.choices?.[0]?.message || {};
    // Streaming responses carry text in ordered deltas, not in the final SSE
    // chunk's `message` field. Use the durable inference answer assembled by
    // the host so a successful live response is not rendered as empty.
    const answer = String(inference.answer || choice.content || "").trim();
    const conversation = {
      schema: "hemlock.agent.conversation.response.v1",
      requestId: payload.requestId || null,
      taskId: agentTask.id,
      threadId: agentTask.threadId,
      answer,
      channels: inference.channels || [],
      rawOutputRef: inference.rawOutputRef || null,
      traceRefs: inference.rawOutputRef ? [inference.rawOutputRef] : [],
      displayMode: "model-verbatim",
      hostStatus: "completed",
      recovered: inference.recovered === true,
      usage: inference.payload?.usage || null,
      telemetry: inference.telemetry || null,
      provider: selection.provider,
      model: selection.model || null,
      reasoning: selection.reasoning,
    };
    threadManager.appendConversation(agentTask.threadId, { role: "assistant", content: answer, channels: conversation.channels, provider: selection.provider, model: selection.model, reasoning: selection.reasoning, rawOutputRef: conversation.rawOutputRef });
    appendAgentEvent("conversation.response", "passed", { conversation }, { reversible: true });
    return {
      schema: "hemlock.agent.intent.result.v1",
      status: "completed",
      task: agentTask,
      answer,
      conversation,
      inference,
      claimBoundary: `${selection.label} response backed by the selected provider inference operation; it is not a source mutation or general model-improvement claim.`,
    };
  }

  let plan = null;
  if (agentOrchestrator) {
    plan = agentOrchestrator.proposePlan(agentTask, {
      rationale: `The ${intent} intent is bounded to registered local actions. Context and memory are attached as evidence; source mutation and Dream training remain separately gated.`,
    });
  }
  // Graduated autonomy: guided/autonomous tasks (and campaign intents) skip
  // the approval park — the user opted in at submit time or via the autonomy
  // control, every step still emits receipts and events, and pause/cancel
  // stay live. Budget overrides are clamped by approvePlan itself.
  const taskAutonomy = payload.mode === "campaign" ? "bounded-campaign" : String(payload.autonomy || agentTask.autonomy || "bounded-local");
  const autoApprove = payload.autoApprove === true || payload.mode === "campaign" || ["guided", "autonomous", "bounded-campaign"].includes(taskAutonomy);
  if (plan?.plan && autoApprove) {
    if (agentTask.autonomy !== taskAutonomy) updateAgentTask({ autonomy: taskAutonomy });
    appendAgentEvent("plan.auto_approved", "passed", {
      taskId: agentTask.id,
      planId: plan.plan.id,
      autonomy: taskAutonomy,
      mode: payload.mode === "campaign" ? "campaign" : "autonomy",
      reason: "The task's autonomy level approves its own plan; budgets and the command allowlist still apply.",
    });
    const result = await agentOrchestrator.approvePlan(agentTask.id, plan.plan.id, payload.budgetOverrides || null);
    return {
      schema: "hemlock.agent.intent.result.v1",
      status: result?.status || "completed",
      task: agentTask,
      context,
      recall,
      plan: plan.plan,
      autoApproved: true,
      claimBoundary: `The plan was auto-approved under ${taskAutonomy} autonomy; the reported status is the task's terminal state, and all actions carry receipts.`,
    };
  }
  return {
    schema: "hemlock.agent.intent.result.v1",
    status: "accepted",
    task: agentTask,
    context,
    recall,
    plan: plan?.plan || null,
    nextAction: intent === "verify" ? "Run the selected verification" : intent === "inspect" ? "Map the current project" : "Continue with the bounded task",
    claimBoundary: "Intent acceptance creates a durable task and recall projection; it does not imply that source changes, external actions, or training occurred.",
  };
}

function steerActiveAgentTask(payload = {}) {
  if (!isActiveTask(agentTask)) throw new Error("There is no active Hemlock task to steer.");
  const content = String(payload.text || payload.objective || "").trim();
  if (!content) throw new Error("A steering update needs a concise instruction.");
  const steering = {
    id: `steer-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    content: content.slice(0, 2000),
    source: payload.source || "command-center",
    createdAt: new Date().toISOString(),
    status: "accepted",
  };
  const history = [...(agentTask.steering || []), steering].slice(-24);
  updateAgentTask({ steering: history, foregroundStep: `Steering received: ${steering.content.slice(0, 120)}` });
  appendAgentEvent("task.steering.received", "accepted", { taskId: agentTask.id, steering }, { reversible: true });
  abortStreamsForTask(agentTask.id, "steering");
  return steering;
}

async function submitAgentIntent(payload = {}) {
  if (payload.__bypassQueue === true) return processAgentIntent(payload);
  if (!agentIntentQueue) return processAgentIntent(payload);
  return agentIntentQueue.submit(payload);
}

function providerPrompt(messages, selection, { structured = false } = {}) {
  const transcript = (Array.isArray(messages) ? messages : [])
    .filter((message) => ["system", "user", "assistant"].includes(message?.role) && String(message?.content || "").trim())
    .map((message) => `${String(message.role).toUpperCase()}: ${String(message.content).trim()}`)
    .join("\n\n");
  const taskInstruction = structured
    ? "Return exactly one JSON object in the requested Hemlock action envelope. Do not wrap it in Markdown or add prose. If the action cannot be supported, return a JSON error object rather than pretending it happened."
    : "Answer the user's latest message directly. Keep the response useful and concise. Do not claim that a file, command, tool, deployment, login, or model operation happened unless the Hemlock host supplied that evidence.";
  return [
    `You are the ${selection.label} lane inside Hemlock.`,
    "Hemlock's Electron host owns all local actions, approvals, files, and receipts.",
    "Do not run commands, edit files, use tools, or expose private chain-of-thought in this response lane.",
    taskInstruction,
    "Conversation context:",
    transcript || "No prior context was provided.",
  ].join("\n\n");
}

function recordCliInferenceFailure(error, { taskId, selection, mode, startedAt, rawOutputRef = null, streamId = null, channels = {} } = {}) {
  const detail = String(error?.message || error || "no usable provider output");
  if (mode === "conversation" && taskId === agentTask.id) {
    updateAgentTask({
      phase: "blocked",
      status: "blocked",
      blockedReason: detail,
      foregroundStep: "Provider inference blocked; inspect the command trace",
      provider: selection.provider,
      model: selection.model || null,
      reasoning: selection.reasoning,
    });
  }
  appendAgentEvent("inference.failed", "failed", {
    taskId,
    provider: selection.provider,
    model: selection.model || null,
    reasoning: selection.reasoning,
    mode,
    error: detail,
    elapsedMs: startedAt ? Date.now() - startedAt : null,
    streamId,
    rawOutputRef,
    channels: modelChannelRecords(channels, selection.provider),
  });
  // T8-F6: provider escalation removed — Hemlock runs ONLY the selected lane.
  // A failed Maple inference surfaces through the normal failure receipts; no
  // Codex/Claude escape-hatch suggestion is created.
}

function providerCommand(provider, selection, prompt, structured = false, cwd = repoRoot) {
  const executable = resolveProviderExecutable(provider);
  if (!executable) throw new Error(`${selection.label} CLI was not found. Open Settings to check installation and login.`);
  if (provider === "codex") {
    const args = [
      "exec",
      "--json",
      "--ephemeral",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "-C",
      cwd,
      "-c",
      `model_reasoning_effort=${JSON.stringify(selection.reasoning)}`,
    ];
    if (selection.model) args.push("-m", selection.model);
    args.push(prompt);
    return { executable, args };
  }
  const args = [
    "-p",
    "--verbose",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--no-session-persistence",
    "--safe-mode",
    "--tools",
    "",
    "--effort",
    selection.reasoning,
    "--system-prompt",
    providerPrompt([], selection, { structured }),
  ];
  if (selection.model) args.push("--model", selection.model);
  args.push(prompt);
  return { executable, args };
}

async function runCliInference(payload = {}, selection, { mode = "conversation", structured = false } = {}) {
  if (!payload.__providerLease) {
    return threadManager.withProvider(selection.provider, payload.threadId || payload.taskId || agentTask.threadId || agentTask.id, (lease) => runCliInference({ ...payload, __providerLease: true }, selection, { mode, structured }).then((result) => {
      if (lease.queuedMs) bumpAgentMetrics({ providerWaitMs: lease.queuedMs });
      return result;
    }));
  }
  const taskId = payload.taskId || agentTask.id;
  const taskRoot = payload.workspaceRoot || agentTask.workspaceRoot || repoRoot;
  const startedAt = Date.now();
  let command;
  try {
    command = providerCommand(selection.provider, selection, providerPrompt(payload.messages, selection, { structured }), structured, taskRoot);
  } catch (error) {
    recordCliInferenceFailure(error, { taskId, selection, mode, startedAt });
    throw error;
  }
  const { executable, args } = command;
  const stream = startStream({ taskId, operationId: payload.operationId || null, kind: "model_text", provider: selection.provider });
  // Work-notification boundary: conversation-mode chat responses announce
  // completion when the run outlives the notifier threshold and the window is
  // unfocused; structured-action calls never notify. Settle BEFORE any risky
  // post-terminal work (persistModelOutput) so a receipt-write throw can never
  // leak the pending job; cancel() is a no-op after finish().
  const cliNotify = mode === "conversation" ? trackChatResponseJob(workNotifier, `maple-${stream.streamId}`) : null;
  const parserState = { text: "" };
  let stdoutBuffer = "";
  let stderr = "";
  let usage = null;
  let lastError = null;
  let timeoutHandle = null;
  let child;
  try {
    child = spawn(executable, args, {
      cwd: taskRoot,
      env: { ...process.env, HEMLOCK_PROVIDER_LANE: selection.provider },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const startError = new Error(`${selection.label} could not start: ${error.message}`);
    recordCliInferenceFailure(startError, { taskId, selection, mode, startedAt, streamId: stream.streamId, channels: stream.channels });
    throw startError;
  }
  activeChildren.add(child);
  stream.controller = {
    abort(reason = "cancelled") {
      stream.abortReason = reason;
      if (!child.killed) child.kill("SIGTERM");
    },
  };

  const processResult = await new Promise((resolve, reject) => {
    let settled = false;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      activeChildren.delete(child);
      callback(value);
    };
    const consume = (chunk) => {
      stdoutBuffer += String(chunk || "");
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) {
        const parsed = parseProviderLine(selection.provider, line, parserState);
        if (parsed.error) { lastError = parsed.error; continue; }
        if (parsed.usage) usage = parsed.usage;
        if (parsed.delta) publishStreamFrame(stream, { channel: "content", delta: parsed.delta, usage });
      }
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", consume);
    child.stderr?.on("data", (chunk) => { stderr += String(chunk || ""); });
    child.once("error", (error) => settle(resolve, { exitCode: null, signal: null, error }));
    child.once("close", (exitCode, signal) => {
      if (stdoutBuffer.trim()) consume("\n");
      settle(resolve, { exitCode, signal });
    });
    timeoutHandle = setTimeout(() => {
      stream.abortReason = "timeout";
      if (!child.killed) child.kill("SIGTERM");
    }, inferenceTimeoutMs);
  });

  const interrupted = stream.abortReason;
  if (interrupted) {
    cliNotify?.cancel();
    finishStream(stream, { status: interrupted === "steering" ? "interrupted_by_steering" : "cancelled", stopReason: interrupted });
    if (interrupted === "steering" && mode === "conversation") {
      const steeringStart = Number.isInteger(payload.__steeringCount) ? payload.__steeringCount : 0;
      const steering = (agentTask.steering || []).slice(steeringStart);
      if (steering.length) {
        appendAgentEvent("task.steering.restarted", "running", {
          taskId,
          provider: selection.provider,
          model: selection.model || null,
          steeringCount: steering.length,
        }, { reversible: true });
        return runCliInference({
          ...payload,
          __steeringCount: steeringStart + steering.length,
          messages: [
            ...(Array.isArray(payload.messages) ? payload.messages : []),
            ...steering.map((item) => ({ role: "user", content: `Steering update: ${item.content}` })),
          ],
        }, selection, { mode, structured });
      }
    }
    const error = new Error(`${selection.label} inference was ${interrupted}.`);
    error.code = "CANCELLED";
    throw error;
  }
  if (processResult.error || lastError || processResult.exitCode !== 0) {
    const detail = lastError || processResult.error?.message || stderr.trim().slice(-600) || `${selection.label} exited with code ${processResult.exitCode ?? "-"}.`;
    const error = new Error(`${selection.label} inference failed: ${detail}`);
    cliNotify?.finish({ ok: false, detail: error.message });
    const rawOutputRef = persistModelOutput({ taskId, operationId: payload.operationId || null, streamId: stream.streamId, mode: `${mode}-failed`, provider: selection.provider, channels: stream.channels, rawPayload: { stderr: stderr.slice(-4000), exitCode: processResult.exitCode } });
    finishStream(stream, { status: "failed", stopReason: error.message, rawOutputRef });
    error.rawOutputRef = rawOutputRef;
    recordCliInferenceFailure(error, { taskId, selection, mode, startedAt, rawOutputRef, streamId: stream.streamId, channels: stream.channels });
    throw error;
  }
  if (!stream.text.trim()) {
    const error = new Error(`${selection.label} returned no final response.`);
    cliNotify?.finish({ ok: false, detail: error.message });
    const rawOutputRef = persistModelOutput({ taskId, operationId: payload.operationId || null, streamId: stream.streamId, mode: `${mode}-empty`, provider: selection.provider, channels: stream.channels, rawPayload: { stderr: stderr.slice(-4000), exitCode: processResult.exitCode } });
    finishStream(stream, { status: "failed", stopReason: error.message, rawOutputRef });
    error.rawOutputRef = rawOutputRef;
    recordCliInferenceFailure(error, { taskId, selection, mode, startedAt, rawOutputRef, streamId: stream.streamId, channels: stream.channels });
    throw error;
  }
  cliNotify?.finish({ ok: true });
  const rawOutputRef = persistModelOutput({ taskId, operationId: payload.operationId || null, streamId: stream.streamId, mode, provider: selection.provider, channels: stream.channels, rawPayload: { stderr: stderr.slice(-4000), exitCode: processResult.exitCode, usage } });
  finishStream(stream, { status: "completed", stopReason: "provider_cli_completed", usage, rawOutputRef });
  const answer = stream.text.trim();
  const channels = modelChannelRecords(stream.channels, selection.provider);
  const cachedTokens = usage?.prompt_tokens_details?.cached_tokens ?? usage?.cached_tokens ?? null;
  const telemetry = {
    provider: selection.provider,
    model: selection.model || "provider-default",
    reasoning: selection.reasoning,
    elapsedMs: Date.now() - startedAt,
    finishReason: "provider_cli_completed",
    contextChars: (Array.isArray(payload.messages) ? payload.messages : []).reduce((sum, message) => sum + String(message?.content || "").length, 0),
    promptTokens: usage?.input_tokens ?? usage?.prompt_tokens ?? null,
    completionTokens: usage?.output_tokens ?? usage?.completion_tokens ?? null,
    cachedTokens,
    cacheHitRatio: cacheStats({ promptTokens: usage?.input_tokens ?? usage?.prompt_tokens ?? null, cachedTokens }).hitRatio,
    tokensPerSecond: tokensPerSecond(usage, Date.now() - startedAt),
    outputDigest: streamDigest(JSON.stringify(stream.channels)),
    contentDigest: digestText(answer),
    streamId: stream.streamId,
    streaming: true,
    bufferedFallback: false,
    modelChannels: channels.map(({ name, digest }) => ({ name, digest })),
  };
  appendAgentEvent("inference.completed", "passed", { provider: selection.provider, model: selection.model || null, reasoning: selection.reasoning, rawOutputRef, channels, telemetry, mode });
  if (mode === "conversation") updateAgentTask({ phase: "complete", status: "completed", foregroundStep: "Ready for the next local task", blockedReason: null, provider: selection.provider, model: selection.model || null, reasoning: selection.reasoning });
  return {
    schema: "hemlock.agent.inference.result.v1",
    status: "passed",
    provider: selection.provider,
    model: selection.model,
    reasoning: selection.reasoning,
    answer,
    channels,
    rawOutputRef,
    telemetry,
    processReady: true,
    inferenceReady: true,
    payload: { choices: [{ message: { role: "assistant", content: answer }, finish_reason: "provider_cli_completed" }], usage },
  };
}

// T6-P1: comparison lane. Re-runs ONLY the last user message on ONE alternate
// provider lane. Read-only inference — no tools run, so no plan/approval gate.
// One comparison at a time (module flag); each provider's own lease still
// serializes against normal inference on that lane via withProvider.
let comparisonInFlight = false;
async function runComparisonLane(payload = {}) {
  const currentSelection = normalizeSelection({ provider: agentTask.provider, model: agentTask.model, reasoning: agentTask.reasoning });
  const guard = canRunComparison({ inFlight: comparisonInFlight, targetProvider: payload.targetProvider, currentProvider: currentSelection.provider });
  if (!guard.ok) {
    appendAgentEvent("comparison.blocked", "blocked", { reason: guard.reason, requested: String(payload.targetProvider || "") }, { reversible: true });
    throw new Error(guard.reason);
  }
  const promptText = lastUserMessage(threadManager.readConversation(String(agentTask.threadId || "")));
  if (!promptText) throw new Error("No user message is available in this thread to compare.");
  const messages = [{ role: "user", content: promptText }];
  // T7-S4 FIX 2 (context symmetry): maple's runInference already assembles
  // injectGroundedContext internally — wrapping here too would double-inject —
  // so only the bare CLI lane wraps here. Both lanes read the same
  // agentTask.recall snapshot, so the assembled system block is identical.
  const cliMessages = await injectGroundedContext(messages);
  const contextApplied = cliMessages.length > messages.length && cliMessages[0]?.role === "system";
  // Maple's conversation bookkeeping stamps completion state onto the live
  // task; a comparison must stay read-only, so restore what it touches.
  const taskRestore = { phase: agentTask.phase, status: agentTask.status, foregroundStep: agentTask.foregroundStep, blockedReason: agentTask.blockedReason };
  comparisonInFlight = true;
  appendAgentEvent("comparison.started", "running", { targetProvider: guard.targetProvider, threadId: agentTask.threadId || null }, { reversible: true });
  try {
    let result;
    if (guard.targetProvider === "maple") {
      result = await runInference({ provider: "maple", messages, threadId: agentTask.threadId || undefined, taskId: agentTask.id });
      updateAgentTask(taskRestore, { emit: false });
    } else {
      // mode "comparison" skips conversation-mode task mutation; the CLI lane
      // runs exactly like normal inference otherwise (lease, stream, receipt).
      result = await runCliInference({ messages: cliMessages, taskId: agentTask.id, threadId: agentTask.threadId || undefined }, normalizeSelection({ provider: guard.targetProvider }), { mode: "comparison" });
    }
    const comparison = buildComparisonRecord({ targetProvider: guard.targetProvider, promptText, answer: result.answer, contextApplied, telemetry: result.telemetry || null });
    updateAgentTask({ comparison });
    appendAgentEvent("comparison.completed", "passed", { comparison }, { evidenceRefs: result.rawOutputRef ? [result.rawOutputRef] : [], reversible: true });
    return { schema: COMPARISON_SCHEMA, status: "completed", comparison, task: agentTask };
  } catch (error) {
    // A failed maple comparison still stamps the task "blocked" from inside
    // runInference's catch; restore the pre-comparison state either way so the
    // read-only contract holds on failure paths too.
    updateAgentTask(taskRestore, { emit: false });
    appendAgentEvent("comparison.failed", "failed", { error: error.message, targetProvider: guard.targetProvider }, { reversible: true });
    throw error;
  } finally {
    comparisonInFlight = false;
  }
}

// Receipt-bearing memory injection (T6-G1): prepend the labeled promoted-memory
// block as its own system-role message — host additions stay labeled, never
// blended into model output. One receipt per inference when injection happened.
// T7-S4 FIX 3: optional refreshQuery re-runs SIPS recall first so call sites
// that bypass the intent path (inference.respond) don't reuse whatever
// agentTask.recall last held. Only inference.respond passes it.
async function injectGroundedContext(messages = [], refreshQuery = "") {
  let recall = agentTask.recall;
  const query = String(refreshQuery || "").trim();
  if (query) {
    try {
      recall = await runSipsRuntime({ action: "recall", query, limit: 8 });
      updateAgentTask({ recall });
      appendAgentEvent("memory.recalled", "passed", { query, count: recall.records?.length || 0, records: recall.records || [] }, { evidenceRefs: [path.join(sipsDir, "memory.jsonl")] });
    } catch (error) {
      appendAgentEvent("memory.recall.failed", "degraded", { query, error: error.message }, { reversible: true });
    }
  }
  const grounded = buildGroundedContext({ recall });
  if (!grounded.systemBlock) return messages;
  appendAgentEvent("context.injected", "passed", { count: grounded.citations.length, citationIds: grounded.citations.map((citation) => citation.id) }, { reversible: true });
  return [{ role: "system", content: grounded.systemBlock }, ...messages];
}

// Rolling thread digest (T6-G2): compaction that admits what it drops. The
// digest block re-enters the prompt as its own system message, ahead of the
// retained tail; the receipt fires once per inference.
function compactWithDigest(payload = {}) {
  const { messages: compacted, digest } = applyDigestCompaction(payload.messages);
  if (!digest) return compacted;
  appendAgentEvent("thread.digest.created", "passed", { lines: digest.summaryLines.length, droppedCount: digest.droppedCount, chars: digest.chars, threadId: payload.threadId || agentTask.threadId || null }, { reversible: true });
  return insertDigestBlock(compacted, digest);
}

async function runInference(payload = {}) {
  const selection = normalizeSelection({ provider: payload.provider || payload.modelProvider || agentTask.provider, model: payload.model || agentTask.model, reasoning: payload.reasoning || agentTask.reasoning });
  if (!payload.__providerLease) {
    return threadManager.withProvider(selection.provider, payload.threadId || payload.taskId || agentTask.threadId || agentTask.id, (lease) => runInference({ ...payload, __providerLease: true }, { __providerLease: true }).then((result) => {
      if (lease.queuedMs) bumpAgentMetrics({ providerWaitMs: lease.queuedMs });
      return result;
    }));
  }
  // Compaction (and its digest receipt) runs once, inside the lease.
  const initialMessages = compactWithDigest(payload);
  if (selection.provider !== "maple") return runCliInference({ ...payload, messages: await injectGroundedContext(initialMessages, payload.refreshQuery) }, selection, { mode: "conversation" });
  const requestedAdapter = String(payload.adapterPath || "");
  const endpoint = String(payload.apiBase || serverUrl).replace(/\/$/, "");
  const startedAt = Date.now();
  let messages = await injectGroundedContext(initialMessages, payload.refreshQuery);
  let recovered = false;
  let stream = startStream({ taskId: payload.taskId || agentTask.id, operationId: payload.operationId, kind: "model_text", provider: "maple" });
  let responsePayload = {};
  let rawPayloads = [];
  let finishReason = null;
  let bufferedFallback = false;
  let usage = null;
  let steeringIndex = 0;
  let mapleTransportRetries = 0;
  await ensureMapleRuntime();
  // Work-notification boundary (see runCliInference): long Maple conversation
  // responses announce completion while unfocused. Settled at every terminal
  // outcome below; retry/steering paths keep the same pending job on purpose.
  const mapleNotify = trackChatResponseJob(workNotifier, `maple-${stream.streamId}`);
  while (true) {
    const controller = new AbortController();
    stream.controller = controller;
    const timeoutHandle = setTimeout(() => controller.abort("timeout"), inferenceTimeoutMs);
    // T8-S3: first-token stall watchdog — Maple can accept the request and then
    // wedge without emitting a single SSE byte; abort at DEFAULT_STALL_MS (not
    // the full inferenceTimeoutMs) so the bounded transport recovery below
    // takes over. The bound is generous because cold 2-bit prefills are slow.
    const stallStartedAt = Date.now();
    let firstByteAt = null;
    const stallHandle = setTimeout(() => {
      if (!firstTokenWatchdog({ now: Date.now(), startedAt: stallStartedAt, firstByteAt }).stalled) return;
      const stallError = new Error(`first-token stall (no SSE bytes in ${Math.round(DEFAULT_STALL_MS / 1000)}s)`);
      stallError.code = "MAPLE_FIRST_TOKEN_STALL";
      controller.abort(stallError);
    }, DEFAULT_STALL_MS);
    try {
      const base = {
        model: selection.provider === "maple" ? resolveLocalModelPath(selection.model) : "default_model",
        messages,
        temperature: Number.isFinite(payload.temperature) ? payload.temperature : 0.7,
        top_p: Number.isFinite(payload.top_p) ? payload.top_p : 0.95,
        top_k: Number.isFinite(payload.top_k) ? payload.top_k : 20,
        max_tokens: Number.isFinite(payload.max_tokens) ? payload.max_tokens : mapleMaxTokens,
        stream: true,
        // T8-F3: mlx_lm only emits a usage chunk when include_usage is set —
        // without it telemetry has no completionTokens and tok/s renders "—".
        stream_options: { include_usage: true },
        // Reasoning toggle: "off" explicitly disables the thinking channel
        // (LFM2.5 honors enable_thinking:false and skips CoT entirely — much
        // faster for casual chat). "on" leaves the flag unset: Maple emits its
        // reasoning channel regardless, so forcing the flag only added server
        // overhead (~23% slower first response, no content difference).
        ...(payload.reasoning === "off" ? { chat_template_kwargs: { enable_thinking: false } } : {}),
      };
      let response = await fetch(`${endpoint}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ ...base, ...(requestedAdapter && !recovered ? { adapters: requestedAdapter } : {}) }),
        signal: controller.signal,
      });
      if (!response.ok && requestedAdapter && !recovered && response.status >= 400 && stream.text.length === 0) {
        recovered = true;
        response = await fetch(`${endpoint}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
          body: JSON.stringify(base),
          signal: controller.signal,
        });
      }
      if (!response.ok) {
        const errorPayload = await readResponse(response);
        const detail = errorPayload?.error?.message || errorPayload?.error || errorPayload?.raw || response.statusText || `HTTP ${response.status}`;
        const error = new Error(`Maple-Preview returned HTTP ${response.status}: ${detail}`);
        error.status = response.status;
        throw error;
      }

      const contentType = response.headers.get("content-type") || "";
      if (!response.body || typeof response.body.getReader !== "function" || !contentType.toLowerCase().includes("text/event-stream")) {
        bufferedFallback = true;
        responsePayload = await readResponse(response);
        const choice = responsePayload?.choices?.[0];
        if (!choice?.message) throw new Error("Maple-Preview returned no completed inference message.");
        rawPayloads.push(responsePayload);
        for (const channel of extractModelChannels(choice.message)) publishStreamFrame(stream, { channel: channel.name, delta: channel.text, usage: responsePayload.usage || null, stopReason: choice.finish_reason || null });
        finishReason = choice.finish_reason || null;
        usage = responsePayload.usage || null;
      } else {
        const parser = new Utf8SseParser();
        const reader = response.body.getReader();
        let done = false;
        while (!done) {
          const result = await reader.read();
          if (firstByteAt === null && result.value?.length) { firstByteAt = Date.now(); clearTimeout(stallHandle); } // T8-S3: first byte disarms the stall watchdog
          const parsedEvents = parser.push(result.value || new Uint8Array(), { final: result.done === true });
          for (const event of parsedEvents) {
            const parsed = parseSsePayload(event);
            if (parsed.done) { done = true; break; }
            if (!parsed.payload) continue;
            const delta = extractModelDelta(parsed.payload);
            rawPayloads.push(compactModelPayload(parsed.payload));
            if (delta.channels.length) {
              for (const channel of delta.channels) publishStreamFrame(stream, { channel: channel.name, delta: channel.text, usage: delta.usage, stopReason: delta.finishReason });
              checkpointStream(stream);
            }
            if (delta.finishReason) finishReason = delta.finishReason;
            if (delta.usage) usage = delta.usage;
            responsePayload = parsed.payload;
          }
          if (result.done) break;
        }
      }
      // Some local chat templates expose only reasoning deltas when streamed
      // even though the identical request can return visible content in a
      // buffered response. Keep the SSE attempt and its receipt, then use one
      // bounded buffered retry instead of surfacing an empty answer.
      // Fire the buffered retry when the visible CONTENT channel is empty
      // (reasoning-only streams, or an empty delta) rather than only when the
      // whole stream text is empty. An empty content channel is what the app
      // would otherwise render as a blank "· content" block.
      const streamHasContent = Boolean(String(stream.channels.content || "").trim());
      const streamHasReasoning = Boolean(String(stream.channels.reasoning || "").trim());
      if (!bufferedFallback && !streamHasContent) {
        if (streamHasReasoning) bumpAgentMetrics({ mapleReasoningOnlyStream: 1 });
        const fallbackResponse = await fetch(`${endpoint}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...base, stream: false, ...(requestedAdapter && !recovered ? { adapters: requestedAdapter } : {}) }),
          signal: controller.signal,
        });
        if (!fallbackResponse.ok) {
          const fallbackErrorPayload = await readResponse(fallbackResponse);
          const detail = fallbackErrorPayload?.error?.message || fallbackErrorPayload?.error || fallbackErrorPayload?.raw || fallbackResponse.statusText || `HTTP ${fallbackResponse.status}`;
          throw new Error(`Maple-Preview buffered fallback returned HTTP ${fallbackResponse.status}: ${detail}`);
        }
        const fallbackPayload = await readResponse(fallbackResponse);
        const fallbackChoice = fallbackPayload?.choices?.[0];
        if (!fallbackChoice?.message) throw new Error("Maple-Preview buffered fallback returned no completed inference message.");
        rawPayloads.push(fallbackPayload);
        responsePayload = fallbackPayload;
        finishReason = fallbackChoice.finish_reason || null;
        usage = fallbackPayload.usage || null;
        bufferedFallback = true;
        for (const channel of extractModelChannels(fallbackChoice.message)) publishStreamFrame(stream, { channel: channel.name, delta: channel.text, usage, stopReason: finishReason });
      }
      // Bounded second retry: if even the buffered fallback returned an empty
      // CONTENT channel, try once more with a slightly raised temperature. This
      // contains the rare double-empty KV-warmup hiccup instead of rendering a
      // blank response. At most ONE extra request ever fires per inference.
      const fallbackContentEmpty = !String(stream.channels.content || "").trim();
      if (bufferedFallback && fallbackContentEmpty) {
        bumpAgentMetrics({ mapleDoubleEmptyRetry: 1 });
        const retryResponse = await fetch(`${endpoint}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...base, stream: false, temperature: Math.min(1, Number(base.temperature ?? 0.7) + 0.15) || 0.85 }),
          signal: controller.signal,
        });
        if (retryResponse.ok) {
          const retryPayload = await readResponse(retryResponse);
          const retryChoice = retryPayload?.choices?.[0];
          if (retryChoice?.message && String(retryChoice.message.content || "").trim()) {
            rawPayloads.push(retryPayload);
            responsePayload = retryPayload;
            finishReason = retryChoice.finish_reason || null;
            usage = retryPayload.usage || null;
            for (const channel of extractModelChannels(retryChoice.message)) publishStreamFrame(stream, { channel: channel.name, delta: channel.text, usage, stopReason: finishReason });
          }
        }
      }
      const channels = modelChannelRecords(stream.channels);
      const answerText = String(stream.channels.content || responsePayload?.choices?.[0]?.message?.content || "").trim();
      const choice = responsePayload?.choices?.[0] || {};
      mapleNotify.finish({ ok: true });
      // Guarded receipt write: if persistModelOutput throws (disk full, etc.)
      // the notification job is already settled and the error still surfaces.
      let rawOutputRef = null;
      try {
        rawOutputRef = persistModelOutput({ taskId: payload.taskId || agentTask.id, operationId: payload.operationId || null, streamId: stream.streamId, mode: "conversation", channels: stream.channels, rawPayload: rawPayloads.length ? rawPayloads : responsePayload });
      } catch (receiptError) {
        appendAgentEvent("model-output.persist.failed", "failed", { streamId: stream.streamId, error: receiptError.message }, { reversible: true });
      }
      finishStream(stream, { status: "completed", stopReason: finishReason, usage, rawOutputRef });
      const cachedTokens = usage?.prompt_tokens_details?.cached_tokens ?? usage?.cached_tokens ?? null;
      const telemetry = {
        provider: "maple",
        model: "default_model",
        reasoning: "native",
        elapsedMs: Date.now() - startedAt,
        finishReason,
        contextChars: messages.reduce((sum, message) => sum + message.content.length, 0),
        promptTokens: usage?.prompt_tokens ?? responsePayload.usage?.prompt_tokens ?? null,
        // T8-F3: honest fallback — if the server never sent a usage chunk,
        // estimate tokens from streamed output (≈4 chars/token) rather than
        // rendering "tok/s —". Marked approximate.
        completionTokens: usage?.completion_tokens ?? responsePayload.usage?.completion_tokens ?? (Math.round((String(stream.channels.content || "").length + String(stream.channels.reasoning || stream.channels.reasoning_content || "").length) / 4) || null),
        completionTokensApproximate: (usage?.completion_tokens ?? responsePayload.usage?.completion_tokens ?? null) == null,
        cachedTokens,
        cacheHitRatio: cacheStats({ promptTokens: usage?.prompt_tokens ?? responsePayload.usage?.prompt_tokens ?? null, cachedTokens }).hitRatio,
        tokensPerSecond: tokensPerSecond(usage, Date.now() - startedAt),
        outputDigest: streamDigest(JSON.stringify(stream.channels)),
        contentDigest: streamDigest(answerText),
        adapterPath: recovered ? null : requestedAdapter || null,
        streamId: stream.streamId,
        streaming: !bufferedFallback,
        bufferedFallback,
        modelChannels: channels.map(({ name, digest }) => ({ name, digest })),
        modelNotePresent: channels.some((channel) => ["work_note", "workNote"].includes(channel.name)),
      };
      serverState = { ...serverState, processReady: true, inferenceReady: true, adapterPath: recovered ? "" : requestedAdapter };
      const lastUser = [...messages].reverse().find((message) => message?.role === "user");
      const episode = {
        id: `episode-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        taskId: agentTask.id,
        createdAt: new Date().toISOString(),
        messages: [
          ...(lastUser ? [{ role: "user", content: String(lastUser.content || "") }] : []),
          { role: "assistant", content: answerText },
        ],
        metadata: { adapterPath: recovered ? null : requestedAdapter || null, recovered, usage: usage || responsePayload.usage || null, telemetry, channels, rawOutputRef, source: "hemlock-agent" },
      };
      appendAgentEvent("conversation.episode.completed", "passed", { episode }, { reversible: true });
      updateAgentTask({ phase: "complete", status: "completed", foregroundStep: "Ready for the next local task", blockedReason: null });
      bumpAgentMetrics({ inferenceLatencyMs: telemetry?.elapsedMs || 0 });
      appendAgentEvent("inference.completed", "passed", { adapterPath: recovered ? null : requestedAdapter || null, recovered, usage: usage || responsePayload.usage || null, telemetry, channels, rawOutputRef });
      return { schema: "hemlock.agent.inference.result.v1", status: "passed", provider: "maple", model: "default_model", reasoning: "native", payload: responsePayload, recovered, adapterPath: recovered ? "" : requestedAdapter, processReady: true, inferenceReady: true, telemetry, answer: answerText, channels, rawOutputRef };
    } catch (error) {
      const reason = stream.abortReason;
      const interruptedRawOutputRef = persistModelOutput({
        taskId: payload.taskId || agentTask.id,
        operationId: payload.operationId || null,
        streamId: stream.streamId,
        mode: reason ? `conversation-${reason}` : "conversation-failed",
        channels: stream.channels,
        rawPayload: rawPayloads.length ? rawPayloads : responsePayload,
      });
      if (!reason && isMapleTransportError(error) && mapleTransportRetries < 2 && !stream.text.trim()) {
        mapleTransportRetries += 1;
        finishStream(stream, { status: "restarting", stopReason: error.message, rawOutputRef: interruptedRawOutputRef });
        // T7.5-R2: recovery must be visible, not silent — the receipt rides
        // the existing HOST ACTIVITY rail via conciseAgentNote.
        appendAgentEvent("maple.recovery", "degraded", { attempt: mapleTransportRetries, reason: error.message, streamId: stream.streamId }, { reversible: true });
        await restartMapleRuntime(error.message || "Maple transport failed during inference.");
        stream = startStream({ taskId: payload.taskId || agentTask.id, operationId: payload.operationId, kind: "model_text", provider: "maple" });
        rawPayloads = [];
        responsePayload = {};
        finishReason = null;
        bufferedFallback = false;
        usage = null;
        continue;
      }
      if (reason === "steering") {
        finishStream(stream, { status: "interrupted_by_steering", stopReason: "steering", rawOutputRef: interruptedRawOutputRef });
        const steering = (agentTask.steering || []).slice(steeringIndex);
        steeringIndex = (agentTask.steering || []).length;
        messages = [...messages, ...steering.map((item) => ({ role: "user", content: `Steering update: ${item.content}` }))];
        stream = startStream({ taskId: payload.taskId || agentTask.id, operationId: payload.operationId, kind: "model_text" });
        rawPayloads = [];
        responsePayload = {};
        finishReason = null;
        bufferedFallback = false;
        usage = null;
        appendAgentEvent("task.steering.restarted", "running", { taskId: agentTask.id, streamId: stream.streamId, steeringCount: steering.length }, { reversible: true });
        continue;
      }
      if (reason === "cancelled" || reason === "interrupted") {
        mapleNotify.cancel();
        finishStream(stream, { status: "cancelled", stopReason: reason, rawOutputRef: interruptedRawOutputRef });
        // T8-F1: a cancel must not vaporize minutes of streamed output. If the
        // model produced real content before the cut, keep it in the thread as
        // an honest partial reply instead of discarding it (17K-char story
        // incident, 2026-08-24: full output existed only in raw receipts).
        const partialText = stream.text.trim();
        if (partialText) {
          threadManager.appendConversation(String(payload.threadId || agentTask.threadId || ""), {
            role: "assistant",
            content: partialText,
            channels: modelChannelRecords(stream.channels),
            provider: "maple",
            model: "default_model",
            reasoning: "native",
            rawOutputRef: interruptedRawOutputRef,
            partial: true,
            stopReason: reason,
          });
          appendAgentEvent("conversation.partial", "degraded", { taskId: agentTask.id, streamId: stream.streamId, chars: partialText.length, reason }, { reversible: true });
        }
        const cancellation = new Error("Inference was cancelled before completion.");
        cancellation.code = "CANCELLED";
        throw cancellation;
      }
      finishStream(stream, { status: "failed", stopReason: error.message, rawOutputRef: interruptedRawOutputRef });
      mapleNotify.finish({ ok: false, detail: error.message });
      serverState = { ...serverState, inferenceReady: false };
      updateAgentTask({ phase: "blocked", status: "blocked", blockedReason: error.message, foregroundStep: "Inference blocked; inspect the command trace" });
      appendAgentEvent("inference.failed", "failed", { error: error.message, adapterPath: requestedAdapter || null, elapsedMs: Date.now() - startedAt, streamId: stream.streamId, rawOutputRef: interruptedRawOutputRef, channels: modelChannelRecords(stream.channels) });
      throw error;
    } finally {
      clearTimeout(timeoutHandle);
      clearTimeout(stallHandle); // T8-S3: disarm the stall watchdog on every exit
    }
  }
}

function walkFiles(root, predicate = () => true, output = []) {
  if (!fs.existsSync(root)) return output;
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return output; }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) walkFiles(filePath, predicate, output);
    else if (predicate(filePath)) output.push(filePath);
  }
  return output;
}

function queryReceipts(payload = {}) {
  const files = walkFiles(sipsDir, (filePath) => /(?:receipt|training-receipt)\.json$/i.test(filePath));
  const receipts = files.slice(-160).reverse().map((filePath) => ({
    path: filePath,
    relativePath: path.relative(runtimeDataRoot, filePath),
    receipt: readJsonFile(filePath, null, { label: "receipt-scan" }),
  }));
  return { schema: "hemlock.agent.receipts.v1", status: "ready", receipts, count: receipts.length, evidenceRefs: receipts.map((item) => item.path) };
}

function changeSetPath(changeSetId) {
  if (!/^[A-Za-z0-9_-]+$/.test(changeSetId)) throw new Error("Invalid Hemlock change-set ID.");
  return path.join(sipsDir, "workspaces", "changesets", changeSetId);
}

async function prepareChangeSet(payload = {}) {
  const changeSetId = String(payload.changeSetId || `changeset-${Date.now()}`);
  const root = changeSetPath(changeSetId);
  fs.mkdirSync(root, { recursive: true });
  const patch = typeof payload.patch === "string" ? payload.patch : (await runChild("git", ["diff", "--binary"], { cwd: repoRoot, timeoutMs: 30000 })).stdout;
  if (!patch.trim()) throw new Error("No source diff was available to prepare.");
  const baselineStatus = await runChild("git", ["status", "--short", "--untracked-files=all"], { cwd: repoRoot, timeoutMs: 30000 });
  const touchedPaths = [...patch.matchAll(/^diff --git a\/(.+?) b\/(.+?)$/gm)].flatMap((match) => [match[1], match[2]]).filter((item, index, items) => items.indexOf(item) === index);
  const patchPath = path.join(root, "change.patch");
  writeFileAtomic(patchPath, patch);
  const manifest = {
    schema: "hemlock.agent.change-set.v1",
    id: changeSetId,
    status: "waiting_for_approval",
    repoRoot,
    patchPath,
    createdAt: new Date().toISOString(),
    patchDigest: require("./agent_kernel.cjs").digest(patch),
    baselineStatus: baselineStatus.stdout,
    baselineStatusDigest: require("./agent_kernel.cjs").digest(baselineStatus.stdout),
    touchedPaths,
    approvalRequired: true,
    claimBoundary: "This is a prepared local patch; no source mutation occurred.",
  };
  writeJsonFile(path.join(root, "manifest.json"), manifest);
  updateAgentTask({ phase: "approval", status: "waiting_for_approval", foregroundStep: `Review prepared change set ${changeSetId}` });
  appendAgentEvent("change-set.prepared", "waiting_for_approval", { changeSet: manifest }, { evidenceRefs: [patchPath, path.join(root, "manifest.json")], reversible: true });
  return manifest;
}

function prepareArtifactChangeSet({ artifact, taskId }) {
  const changeSetId = `artifact-${artifact.id}-r${artifact.revision}`;
  const root = changeSetPath(changeSetId);
  const manifest = {
    schema: "hemlock.agent.change-set.v1",
    id: changeSetId,
    status: "waiting_for_approval",
    repoRoot,
    taskId,
    artifactId: artifact.id,
    artifactRevision: artifact.revision,
    artifactDigest: artifact.digest,
    artifactSource: artifact.source,
    createdAt: new Date().toISOString(),
    approvalRequired: true,
    sourceMutation: false,
    claimBoundary: "The artifact revision is staged as an approval-gated change-set proposal; no repository source was mutated.",
  };
  writeJsonFile(path.join(root, "manifest.json"), manifest);
  appendAgentEvent("change-set.prepared", "waiting_for_approval", { changeSet: manifest }, { evidenceRefs: [path.join(root, "manifest.json")], reversible: true });
  return manifest;
}

function writeJsonFile(filePath, value) {
  // Temp + fsync + rename (durable_io): manifests, receipts, settings, and
  // scheduler state must never be observed half-written after a crash.
  writeJsonAtomic(filePath, value);
}

async function transitionChangeSet(payload = {}, transition) {
  const changeSetId = String(payload.changeSetId || "");
  const root = changeSetPath(changeSetId);
  const manifestPath = path.join(root, "manifest.json");
  const manifest = readJsonFile(manifestPath, null, { label: "change-set-manifest" });
  if (!manifest) throw new Error(`Hemlock change set was not found: ${changeSetId}`);
  if (transition === "approve") {
    if (payload.confirm !== true) throw new Error("Applying a prepared change set requires explicit confirmation.");
    const currentStatus = await runChild("git", ["status", "--short", "--untracked-files=all"], { cwd: repoRoot, timeoutMs: 30000 });
    const baselineByPath = new Map(String(manifest.baselineStatus || "").split(/\r?\n/).filter(Boolean).map((line) => [line.slice(3).trim(), line.slice(0, 2)]));
    const currentByPath = new Map(String(currentStatus.stdout || "").split(/\r?\n/).filter(Boolean).map((line) => [line.slice(3).trim(), line.slice(0, 2)]));
    const conflicts = (manifest.touchedPaths || []).filter((filePath) => currentByPath.has(filePath) && currentByPath.get(filePath) !== baselineByPath.get(filePath));
    if (conflicts.length) {
      manifest.status = "blocked";
      manifest.blockedReason = `The worktree changed after preparation in overlapping paths: ${conflicts.join(", ")}`;
      writeJsonFile(manifestPath, manifest);
      updateAgentTask({ phase: "blocked", status: "blocked", foregroundStep: `Resolve change-set conflicts: ${conflicts.join(", ")}`, blockedReason: manifest.blockedReason });
      appendAgentEvent("change-set.blocked", "blocked", { changeSet: manifest, conflicts }, { evidenceRefs: [manifestPath, manifest.patchPath], reversible: true });
      return manifest;
    }
    const check = await runChild("git", ["apply", "--check", manifest.patchPath], { cwd: repoRoot, timeoutMs: 30000 });
    if (check.exitCode !== 0) throw new Error(`Change-set check failed: ${check.stderr || check.stdout || `exit code ${check.exitCode}`}`);
    const applied = await runChild("git", ["apply", manifest.patchPath], { cwd: repoRoot, timeoutMs: 30000 });
    if (applied.exitCode !== 0) throw new Error(`Change-set apply failed: ${applied.stderr || applied.stdout || `exit code ${applied.exitCode}`}`);
    manifest.status = "applied";
    manifest.appliedAt = new Date().toISOString();
    manifest.claimBoundary = "The approved prepared patch was applied to the local worktree; verification is still required.";
    updateAgentTask({ phase: "verify", status: "verifying", foregroundStep: "Run verification after applying the approved change set" });
  } else {
    manifest.status = "rejected";
    manifest.rejectedAt = new Date().toISOString();
    manifest.rejectionNote = String(payload.note || "Rejected by user");
    updateAgentTask({ phase: "complete", status: "completed", foregroundStep: "Change set rejected; choose the next bounded action" });
  }
  writeJsonFile(manifestPath, manifest);
  appendAgentEvent(`change-set.${transition === "approve" ? "approved" : "rejected"}`, transition === "approve" ? "applied" : "rejected", { changeSet: manifest }, { evidenceRefs: [manifestPath, manifest.patchPath], reversible: transition === "approve" });
  return manifest;
}

function prepareTrainingDataset(payload = {}) {
  const datasetId = String(payload.datasetId || `dataset-${Date.now()}`);
  if (!/^[A-Za-z0-9_-]+$/.test(datasetId)) throw new Error("Invalid Hemlock dataset ID.");
  const datasetRoot = path.join(sipsDir, "datasets", datasetId);
  const examples = [
    ...(Array.isArray(payload.examples) ? payload.examples : []),
    ...(Array.isArray(payload.conversation) && payload.conversation.length ? [{ messages: payload.conversation, metadata: { source: "conversation" } }] : []),
    ...(Array.isArray(payload.facts) ? payload.facts.map((fact) => ({ messages: [{ role: "user", content: "Remember this local fact." }, { role: "assistant", content: String(fact) }], metadata: { source: "personal-fact" } })) : []),
  ].filter((item) => Array.isArray(item?.messages) && item.messages.length >= 2);
  if (!examples.length) throw new Error("Training preparation needs at least one complete example.");
  const holdoutCount = examples.length > 2 ? Math.max(1, Math.floor(examples.length * 0.2)) : 0;
  const trainingRows = examples.slice(0, examples.length - holdoutCount);
  const holdoutRows = holdoutCount ? examples.slice(-holdoutCount) : [];
  fs.mkdirSync(datasetRoot, { recursive: true });
  const trainPath = path.join(datasetRoot, "train.jsonl");
  const validationPath = path.join(datasetRoot, "validation.jsonl");
  writeFileAtomic(trainPath, trainingRows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  if (holdoutRows.length) writeFileAtomic(validationPath, holdoutRows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const manifest = {
    schema: "hemlock.agent.dataset.v1",
    datasetId,
    status: "ready_for_explicit_training",
    createdAt: new Date().toISOString(),
    sourceRows: examples.length,
    trainingRows: trainingRows.length,
    validationRows: holdoutRows.length,
    validationHoldout: holdoutRows.length > 0,
    trainPath,
    validationPath: holdoutRows.length ? validationPath : null,
    sourceRefs: Array.isArray(payload.sourceRefs) ? payload.sourceRefs : [],
    claimBoundary: "The dataset is prepared and validated locally; no model weights were changed.",
  };
  writeJsonFile(path.join(datasetRoot, "manifest.json"), manifest);
  appendAgentEvent("dataset.created", "ready", { manifest }, { evidenceRefs: [path.join(datasetRoot, "manifest.json"), trainPath, ...(holdoutRows.length ? [validationPath] : [])], reversible: true });
  return manifest;
}

function scopedRepoPath(inputPath = ".", root = agentTask.workspaceRoot || repoRoot) {
  const workspaceRoot = path.resolve(root || repoRoot);
  const candidate = path.resolve(workspaceRoot, String(inputPath || "."));
  const relative = path.relative(workspaceRoot, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    const error = new Error(`Path is outside the current Hemlock workspace: ${inputPath}`);
    error.code = "SCOPE_OUTSIDE_REPO";
    throw error;
  }
  return candidate;
}

function repoInspect(payload = {}) {
  const workspaceRoot = path.resolve(payload.workspaceRoot || agentTask.workspaceRoot || repoRoot);
  const requested = Array.isArray(payload.paths) && payload.paths.length ? payload.paths : ["dream-chat", "docs", "README.md", "state.yaml"];
  const files = requested.flatMap((item) => {
    const absolute = scopedRepoPath(item, workspaceRoot);
    if (!fs.existsSync(absolute)) return [];
    if (fs.statSync(absolute).isFile()) return [path.relative(workspaceRoot, absolute)];
    return walkFiles(absolute, () => true).slice(0, 160).map((filePath) => path.relative(workspaceRoot, filePath));
  }).slice(0, 160);
  return {
    schema: "hemlock.agent.repo.inspection.v1",
    status: "passed",
    root: workspaceRoot,
    requested,
    files,
    fileCount: files.length,
    summary: `Inspected ${files.length} scoped repository paths.`,
    evidenceRefs: [`repo://${workspaceRoot}`],
  };
}

function readFileTool(payload = {}) {
  const workspaceRoot = path.resolve(payload.workspaceRoot || agentTask.workspaceRoot || repoRoot);
  const absolute = scopedRepoPath(payload.path || "README.md", workspaceRoot);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) throw new Error(`Scoped file was not found: ${payload.path}`);
  const maxBytes = Math.min(Math.max(Number(payload.maxBytes || 64000), 256), 200000);
  const content = fs.readFileSync(absolute, "utf-8");
  const truncated = Buffer.byteLength(content) > maxBytes;
  const excerpt = truncated ? content.slice(0, maxBytes) : content;
  return { schema: "hemlock.agent.file.read.v1", status: "passed", path: path.relative(workspaceRoot, absolute), content: excerpt, truncated, bytes: Buffer.byteLength(content), summary: `Read ${path.relative(workspaceRoot, absolute)}${truncated ? " (bounded excerpt)" : ""}.`, evidenceRefs: [`file://${absolute}`] };
}

async function searchFilesTool(payload = {}) {
  const workspaceRoot = path.resolve(payload.workspaceRoot || agentTask.workspaceRoot || repoRoot);
  const query = String(payload.query || payload.pattern || "").trim();
  if (!query) throw new Error("file.search needs a query.");
  const target = scopedRepoPath(payload.path || ".", workspaceRoot);
  const result = await runChild("rg", ["--line-number", "--hidden", "--glob", "!.git", "--glob", "!node_modules", "--max-count", "120", query, target], { cwd: workspaceRoot, timeoutMs: 30000 });
  if (result.exitCode !== 0 && result.exitCode !== 1) throw new Error(result.stderr || `file.search failed with exit code ${result.exitCode}`);
  return { schema: "hemlock.agent.file.search.v1", status: "passed", query, path: path.relative(workspaceRoot, target) || ".", matches: result.stdout.split(/\r?\n/).filter(Boolean).slice(0, 320), matchCount: result.stdout.split(/\r?\n/).filter(Boolean).length, summary: `Search completed for ${JSON.stringify(query)}.`, evidenceRefs: [`repo://${workspaceRoot}`] };
}

async function gitStatusTool(payload = {}) {
  const workspaceRoot = path.resolve(payload.workspaceRoot || agentTask.workspaceRoot || repoRoot);
  const result = await runChild("git", ["status", "--short", "--branch"], { cwd: workspaceRoot, timeoutMs: 30000 });
  return { schema: "hemlock.agent.git.status.v1", status: result.exitCode === 0 ? "passed" : "failed", branch: result.stdout.split(/\r?\n/)[0] || "", statusShort: result.stdout.trim(), exitCode: result.exitCode, summary: result.exitCode === 0 ? "The worktree status was read." : result.stderr || "Git status failed.", evidenceRefs: [`git://${workspaceRoot}/status`] };
}

async function gitDiffTool(payload = {}) {
  const workspaceRoot = path.resolve(payload.workspaceRoot || agentTask.workspaceRoot || repoRoot);
  const paths = Array.isArray(payload.paths) ? payload.paths.map((item) => path.relative(workspaceRoot, scopedRepoPath(item, workspaceRoot))) : [];
  const args = ["diff", "--no-ext-diff", "--binary"];
  if (paths.length) args.push("--", ...paths);
  const result = await runChild("git", args, { cwd: workspaceRoot, timeoutMs: 30000 });
  return { schema: "hemlock.agent.git.diff.v1", status: result.exitCode === 0 ? "passed" : "failed", diff: result.stdout.slice(0, 120000), truncated: result.stdout.length > 120000, paths, exitCode: result.exitCode, summary: result.exitCode === 0 ? "The scoped diff was read without mutation." : result.stderr || "Git diff failed.", evidenceRefs: [`git://${workspaceRoot}/diff`] };
}

function testDiscover() {
  // Repo source, not durable state: never quarantine a package.json that
  // fails to parse — discovery just reports empty scripts.
  const packageJson = readJsonDurable(path.join(repoRoot, "dream-chat", "package.json"), {}, { quarantine: false });
  const testFiles = walkFiles(repoRoot, (filePath) => /(?:test|spec)\.(?:cjs|js|mjs|py|tsx?|jsx?)$/i.test(filePath)).slice(0, 240).map((filePath) => path.relative(repoRoot, filePath));
  return { schema: "hemlock.agent.test.discovery.v1", status: "passed", scripts: packageJson.scripts || {}, testFiles, summary: `Discovered ${testFiles.length} local test files and ${Object.keys(packageJson.scripts || {}).length} npm scripts.`, evidenceRefs: [`repo://${repoRoot}`] };
}

function verificationList() {
  return { schema: "hemlock.agent.verification.list.v1", status: "passed", profiles: Object.entries(verificationProfiles).map(([id, profile]) => ({ id, label: profile.label, command: profile.command, timeoutMs: profile.timeoutMs, requires: profile.requires || [] })), summary: "Allowlisted verification profiles are available.", evidenceRefs: ["verification://profiles"] };
}

function inspectReceipt(payload = {}) {
  const requested = String(payload.path || payload.receiptPath || "");
  if (!requested) throw new Error("receipt.inspect needs a receipt path.");
  const absolute = path.resolve(requested);
  const relative = path.relative(runtimeDataRoot, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    const error = new Error("Receipt inspection is limited to Hemlock application data.");
    error.code = "SCOPE_OUTSIDE_RUNTIME";
    throw error;
  }
  const receipt = readJsonFile(absolute, null, { label: "receipt-inspect" });
  if (!receipt) throw new Error(`Receipt was not found or was not valid JSON: ${requested}`);
  return { schema: "hemlock.agent.receipt.inspection.v1", status: "passed", path: absolute, receipt, summary: `Inspected local receipt ${path.relative(runtimeDataRoot, absolute)}.`, evidenceRefs: [absolute] };
}

function agentCapabilities() {
  const autonomy = String(agentTask.autonomy || "bounded-local");
  const autonomyLevel = autonomy === "autonomous" || autonomy === "bounded-campaign" ? "autonomous" : autonomy === "guided" ? "guided" : "supervised";
  // The live selection boundary — the same allowedNextCommands the action
  // prompt advertises — so the model can see what it may pick right now, not
  // just what is registered. Falls back to auto:true when no plan is live.
  let allowedNow = [];
  try {
    const activePlan = agentKernel.getProjection().plans.find((plan) => plan.id === agentTask.activePlanId) || { steps: [] };
    allowedNow = agentOrchestrator?.allowedNextCommands?.(agentTask, activePlan, agentKernel.getTaskHistory(agentTask.id)) || [];
  } catch { allowedNow = []; }
  const selectableIds = new Set(allowedNow.map((entry) => entry.commandId));
  const commands = Object.entries(agentCommands).map(([commandId, descriptor]) => ({
    commandId,
    label: descriptor.label,
    capability: descriptor.capability,
    auto: descriptor.auto === true,
    approval: descriptor.approval,
    inputHint: descriptor.inputHint || null,
    countsAgainstBudget: descriptor.countsAgainstBudget !== false,
    selectable: selectableIds.size ? selectableIds.has(commandId) : descriptor.auto === true,
  }));
  const capabilityEntry = (command) => ({ commandId: command.commandId, capability: command.capability, auto: command.auto, approval: command.approval, inputHint: command.inputHint });
  const byCapability = {};
  for (const command of commands.filter((item) => item.selectable)) {
    (byCapability[command.capability || "other"] ||= []).push(capabilityEntry(command));
  }
  const freeReads = commands
    .filter((command) => command.countsAgainstBudget === false)
    .map((command) => ({ ...capabilityEntry(command), selectable: command.selectable }));
  const selectableCount = commands.filter((command) => command.selectable).length;
  return {
    schema: "hemlock.agent.capabilities.v1",
    status: "passed",
    taskId: agentTask.id,
    autonomy,
    autonomyLevel,
    commands,
    selectable: commands.filter((command) => command.selectable).map((command) => command.commandId),
    byCapability,
    freeReads,
    summary: `${commands.length} allowlisted commands, ${selectableCount} selectable now, ${freeReads.length} free reads; autonomy ${autonomyLevel} (${autonomy}).`,
    evidenceRefs: ["registry://agent-commands"],
  };
}

// Bounded so a proposal stays a reviewable spec/patch, but large enough for a
// real multi-file change sketch rather than only a one-paragraph stub.
const MAX_PROPOSAL_CHANGE_BYTES = 32 * 1024;

function proposeImprovement(payload = {}) {
  const summary = String(payload.summary || "").trim();
  const rationale = String(payload.rationale || "").trim();
  if (!summary) throw new Error("improve.propose needs a summary of the bounded change.");
  if (!rationale) throw new Error("improve.propose needs a rationale grounded in local evidence.");
  const change = typeof payload.change === "string" ? payload.change.trim() : "";
  if (Buffer.byteLength(change, "utf8") > MAX_PROPOSAL_CHANGE_BYTES) throw new Error(`improve.propose change text exceeds the ${MAX_PROPOSAL_CHANGE_BYTES / 1024}KB bound.`);
  const thread = threadManager.thread(String(payload.threadId || agentTask.threadId || ""));
  const workspaceRoot = path.resolve(thread?.workspaceRoot || agentTask.workspaceRoot || repoRoot);
  const files = (Array.isArray(payload.files) ? payload.files : []).slice(0, 48).map((item) => {
    const absolute = thread
      ? threadManager.assertScopedPath(thread.id, path.join(workspaceRoot, String(item)))
      : scopedRepoPath(item, workspaceRoot);
    return path.relative(workspaceRoot, absolute);
  });
  const confidence = Number.isFinite(Number(payload.confidence)) ? Math.max(0, Math.min(1, Number(payload.confidence))) : null;
  const proposalId = `improve-${crypto.createHash("sha256").update(JSON.stringify({ summary, rationale, files, change })).digest("hex").slice(0, 12)}`;
  const receipt = {
    schema: "hemlock.agent.improve-proposal.v1",
    id: proposalId,
    status: "proposed",
    taskId: agentTask.id,
    threadId: thread?.id || null,
    workspaceRoot,
    summary,
    rationale,
    files,
    change: change || null,
    confidence,
    autoApplied: false,
    createdAt: new Date().toISOString(),
    claimBoundary: "This is a bounded proposal only; no repository source was mutated. Application requires code.apply under an approved plan.",
  };
  const receiptPath = path.join(sipsDir, "proposals", `${proposalId}.receipt.json`);
  writeJsonFile(receiptPath, receipt);
  appendAgentEvent("improve.proposed", "passed", { proposalId, summary, files, confidence }, { evidenceRefs: [receiptPath], reversible: true });
  return { schema: "hemlock.agent.improve-proposal.result.v1", status: "proposed", proposal: receipt, receiptPath, evidenceRefs: [receiptPath, "receipt://proposed-improvement"], summary: `Recorded bounded improvement proposal ${proposalId}; nothing was applied.` };
}

// ── Runtime settings store + dependency probe ────────────────────────────
// A persisted JSON store in the data dir for user-tunable runtime knobs.
// Each field declares appliesOn honestly: values that feed serverArgs or a
// boot-time constant only take effect on the next server/app launch; values
// read through a live seam (the orchestrator's per-call HEMLOCK_FALLBACK_LANE
// env read, or renderer-held defaults) apply immediately.
const RUNTIME_SETTINGS_PATH = path.join(runtimeDataRoot, "settings.json");
const RUNTIME_SETTING_DEFS = {
  promptCacheSlots: { label: "Prompt cache slots", kind: "number", group: "runtime", appliesOn: "next-launch", env: "HEMLOCK_PROMPT_CACHE_SLOTS", min: 1, max: 16, default: 4, help: "Prompt-cache entries the Maple server persists across restarts. Read by the Python server at spawn — applies on the next server launch." },
  prefillStepSize: { label: "Prefill step size", kind: "number", group: "runtime", appliesOn: "next-launch", env: "HEMLOCK_PREFILL_STEP_SIZE", min: 256, max: 8192, default: maplePrefillStepSize, help: "Prompt prefill chunk size; smaller values stay more responsive on long prompts. Feeds --prefill-step-size — applies on the next server launch." },
  kvBits: { label: "KV cache bits", kind: "select", group: "runtime", appliesOn: "next-launch", env: "HEMLOCK_KV_BITS", default: "0", options: [{ value: "0", label: "Off — exact fp16 KV (default)" }, { value: "8", label: "8-bit — near-lossless, ~2× smaller KV" }, { value: "4", label: "4-bit — ~4× smaller KV, quality risk" }], help: "Quantizes the 6 full-attention layers' KV cache past --quantized-kv-start tokens; sliding-window layers stay exact. Speeds up long-context decode and raises the practical context ceiling. Feeds --kv-bits — applies on the next server launch." },
  // Live seam: resolveContextMaxTokens re-reads process.env on every request
  // for tasks that never pinned a ceiling, so an env write applies
  // immediately — no relaunch. The default itself is kv-aware (24000 exact,
  // 61440 with kvBits) and resolves live too.
  contextMaxTokens: { label: "Context max tokens", kind: "number", group: "runtime", appliesOn: "live", env: "HEMLOCK_CONTEXT_MAX_TOKENS", min: 4096, max: 124000, get default() { return require("./agent_contracts.cjs").defaultContextMaxTokens(); }, help: "Per-request context budget enforced before each Maple call — over-budget requests compact, then block. Applies immediately; a task that pinned its own ceiling keeps it. Default scales with KV quantization (24000 exact / 61440 with kvBits). Values above the model ceiling minus 2048 are clamped and the clamp is receipted." },
  fallbackLane: { label: "Fallback lane", kind: "select", group: "runtime", appliesOn: "live", env: "HEMLOCK_FALLBACK_LANE", default: "none", options: [{ value: "none", label: "None — Maple only" }, { value: "codex", label: "Codex" }, { value: "claude", label: "Claude" }], help: "Subscription lane a step retries on once when Maple's transport dies. Read per task — applies immediately." },
  warmCooldownMs: { label: "Warm cooldown (ms)", kind: "number", group: "runtime", appliesOn: "next-launch", env: "HEMLOCK_WARM_COOLDOWN_MS", min: 60000, max: 3600000, default: 60000, help: "Minimum gap between Maple prompt-cache warm prefills. Read once at app boot — applies on the next app launch." },
  autonomyDefault: { label: "Default autonomy", kind: "select", group: "agent", appliesOn: "live", default: "guided", options: [{ value: "bounded-local", label: "Supervised — approve every step" }, { value: "guided", label: "Guided — plans auto-approve" }, { value: "autonomous", label: "Autonomous — budgets still bind" }], help: "Autonomy level offered to new work; the workspace applies it to the composer control immediately." },
  reasoningLevel: { label: "Default reasoning", kind: "select", group: "agent", appliesOn: "live", default: "on", options: ["on", "off", "low", "medium", "high", "xhigh", "max"].map((value) => ({ value, label: value })), help: "Reasoning level for new work; a lane falls back to its own default for levels it does not support." },
};

function coerceRuntimeSetting(key, raw) {
  const def = RUNTIME_SETTING_DEFS[key];
  if (!def) return { ok: false, error: `Unknown runtime setting: ${key}` };
  if (raw === null || raw === undefined || raw === "") return { ok: true, value: null };
  if (def.kind === "number") {
    const value = Number(raw);
    if (!Number.isFinite(value)) return { ok: false, error: `${def.label} must be a number.` };
    const rounded = Math.round(value);
    if (rounded < def.min || rounded > def.max) return { ok: false, error: `${def.label} must be between ${def.min} and ${def.max}.` };
    return { ok: true, value: rounded };
  }
  if (def.kind === "select") {
    const value = String(raw);
    const allowed = (def.options || []).map((option) => option.value);
    if (!allowed.includes(value)) return { ok: false, error: `${def.label} must be one of: ${allowed.join(", ")}.` };
    return { ok: true, value };
  }
  return { ok: true, value: String(raw) };
}

function readRuntimeSettings() {
  const stored = readJsonFile(RUNTIME_SETTINGS_PATH, {}, { label: "runtime-settings" });
  const values = {};
  for (const key of Object.keys(RUNTIME_SETTING_DEFS)) {
    const coerced = coerceRuntimeSetting(key, stored?.[key]);
    if (coerced.ok && coerced.value !== null) values[key] = coerced.value;
    else values[key] = RUNTIME_SETTING_DEFS[key].default;
  }
  return values;
}

// Push a stored value into the seam the runtime actually reads. Env-backed
// knobs go to process.env (the Python server inherits it at spawn; the
// fallback-lane read is per-call so it goes live). prefillStepSize was already
// frozen into serverArgs before this file's settings code ran, so the flag is
// patched in place — the next server spawn honors it either way.
function applyRuntimeSettingEnv(key, value) {
  const def = RUNTIME_SETTING_DEFS[key];
  if (!def?.env) return;
  if (value === null || value === undefined) delete process.env[def.env];
  else process.env[def.env] = String(value);
  if (key === "prefillStepSize") {
    const flagIndex = serverArgs.indexOf("--prefill-step-size");
    // A cleared override restores the boot-time default, not the last patch.
    if (flagIndex >= 0) serverArgs[flagIndex + 1] = String(value ?? maplePrefillStepSize);
  }
  if (key === "kvBits") {
    // --kv-bits is conditionally emitted into serverArgs at module load, so a
    // settings write must patch the flags or the stored value would never
    // reach the spawned server — leaving the context budget to believe in
    // quantization the server does not have.
    const resolvedBits = value === null || value === undefined ? mapleKvBits : Number(value);
    const bits = Number.isFinite(resolvedBits) ? Math.max(0, Math.min(8, Math.round(resolvedBits))) : 0;
    const kvIndex = serverArgs.indexOf("--kv-bits");
    const startIndex = serverArgs.indexOf("--quantized-kv-start");
    if (bits > 0) {
      if (kvIndex >= 0) serverArgs[kvIndex + 1] = String(bits);
      else serverArgs.push("--kv-bits", String(bits));
      if (startIndex >= 0) serverArgs[startIndex + 1] = String(mapleKvQuantStart);
      else serverArgs.splice(kvIndex >= 0 ? kvIndex + 2 : serverArgs.length, 0, "--quantized-kv-start", String(mapleKvQuantStart));
    } else {
      if (startIndex >= 0) serverArgs.splice(startIndex, 2);
      if (kvIndex >= 0) serverArgs.splice(kvIndex, 2);
    }
    // Keep the budget's kv signal consistent with the flags the next spawn
    // gets: a cleared override restores the boot-time value, not "0".
    if (value === null || value === undefined) process.env.HEMLOCK_KV_BITS = String(mapleKvBits);
    // The prompt-cache byte cap default scales with quantization too (see the
    // maplePromptCacheBytes math); an explicit env override always wins.
    if (!String(process.env.HEMLOCK_MAPLE_PROMPT_CACHE_BYTES || "").trim()) {
      const bytesValue = defaultMaplePromptCacheBytes(bits);
      maplePromptCacheBytes = bytesValue;
      const bytesIndex = serverArgs.indexOf("--prompt-cache-bytes");
      if (bytesIndex >= 0) serverArgs[bytesIndex + 1] = bytesValue;
    }
  }
}

function applyRuntimeSettingsEnv() {
  const stored = readJsonFile(RUNTIME_SETTINGS_PATH, {}, { label: "runtime-settings" });
  for (const key of Object.keys(RUNTIME_SETTING_DEFS)) {
    if (stored?.[key] === undefined || stored?.[key] === null) continue;
    const coerced = coerceRuntimeSetting(key, stored[key]);
    if (coerced.ok && coerced.value !== null) applyRuntimeSettingEnv(key, coerced.value);
  }
}

// Boot-time apply: stored values reach process.env (and the mutable
// serverArgs entry) before later module constants and server spawns read them.
applyRuntimeSettingsEnv();

function promptCacheFileInfo() {
  const flagIndex = serverArgs.indexOf("--prompt-cache-file");
  const filePath = flagIndex >= 0 ? String(serverArgs[flagIndex + 1]) : path.join(runtimeDataRoot, "maple-prompt-cache.safetensors");
  const base = path.basename(filePath);
  let names = [];
  try {
    names = fs.readdirSync(path.dirname(filePath)).filter((name) => name === base || name.startsWith(`${base}.`));
  } catch { names = []; }
  let bytes = 0;
  const files = [];
  for (const name of names) {
    try {
      const stat = fs.statSync(path.join(path.dirname(filePath), name));
      if (stat.isFile()) { bytes += stat.size; files.push(name); }
    } catch { /* vanished between readdir and stat — skip */ }
  }
  return { path: filePath, bytes, files: files.length, present: files.length > 0, serverMayRewrite: serverProcess != null };
}

function runtimeSettingsSnapshot(extra = {}) {
  const settings = readRuntimeSettings();
  const fields = Object.entries(RUNTIME_SETTING_DEFS).map(([key, def]) => ({ key, ...def, value: settings[key] }));
  return { schema: "hemlock.settings.v1", status: "ok", path: RUNTIME_SETTINGS_PATH, settings, fields, promptCache: promptCacheFileInfo(), summary: "Runtime settings resolved against persisted overrides and defaults.", ...extra };
}

function setRuntimeSettings(payload = {}) {
  const edits = payload.settings && typeof payload.settings === "object"
    ? Object.entries(payload.settings).map(([key, value]) => ({ key, value }))
    : [{ key: payload.key, value: payload.value }];
  const stored = readJsonFile(RUNTIME_SETTINGS_PATH, {}, { label: "runtime-settings" }) || {};
  const applied = {};
  for (const edit of edits) {
    const key = String(edit.key || "");
    if (!RUNTIME_SETTING_DEFS[key]) throw new Error(`Unknown runtime setting: ${key || "(missing key)"}`);
    const coerced = coerceRuntimeSetting(key, edit.value);
    if (!coerced.ok) throw new Error(coerced.error);
    if (coerced.value === null) delete stored[key];
    else stored[key] = coerced.value;
    applyRuntimeSettingEnv(key, coerced.value);
    applied[key] = { value: coerced.value === null ? RUNTIME_SETTING_DEFS[key].default : coerced.value, appliesOn: RUNTIME_SETTING_DEFS[key].appliesOn };
  }
  writeJsonFile(RUNTIME_SETTINGS_PATH, stored);
  appendAgentEvent("settings.updated", "accepted", { keys: Object.keys(applied) }, { evidenceRefs: [RUNTIME_SETTINGS_PATH], reversible: true });
  return runtimeSettingsSnapshot({ updated: applied, summary: `Updated ${Object.keys(applied).join(", ")}; fields marked next-launch take effect on restart.` });
}

function clearPromptCacheFiles() {
  const info = promptCacheFileInfo();
  const base = path.basename(info.path);
  let names = [];
  try {
    names = fs.readdirSync(path.dirname(info.path)).filter((name) => name === base || name.startsWith(`${base}.`));
  } catch { names = []; }
  const removed = [];
  for (const name of names) {
    try { fs.unlinkSync(path.join(path.dirname(info.path), name)); removed.push(name); } catch { /* already gone */ }
  }
  appendAgentEvent("settings.prompt-cache.cleared", "accepted", { path: info.path, removed: removed.length, freedBytes: info.bytes, serverMayRewrite: info.serverMayRewrite }, { reversible: false });
  return {
    schema: "hemlock.settings.clear-prompt-cache.v1",
    status: "cleared",
    path: info.path,
    removed: removed.length,
    freedBytes: info.bytes,
    serverMayRewrite: info.serverMayRewrite,
    summary: info.serverMayRewrite
      ? `Removed ${removed.length} prompt-cache file(s); the running server may rewrite entries on exit.`
      : `Removed ${removed.length} prompt-cache file(s).`,
  };
}

// deps.check: probe the interpreter + packages the Maple/Dream stack actually
// needs — the resolved venv python, the repo's mlx_lm fork, mlx, transformers —
// plus the served model checkpoint and the host's own Node runtime. Nothing in
// this stack uses torch; no torch probe exists by design.
function probePythonEnvironment(timeoutMs = 40000) {
  return new Promise((resolve) => {
    const script = [
      "import json, sys, platform, importlib",
      "import importlib.metadata",
      "out = {\"executable\": sys.executable, \"version\": platform.python_version()}",
      "for name, mod in ((\"mlx_lm\", \"mlx_lm\"), (\"mlx\", \"mlx.core\"), (\"transformers\", \"transformers\")):",
      "    entry = {}",
      "    try:",
      "        importlib.import_module(mod)",
      "        entry[\"ok\"] = True",
      "    except Exception as exc:",
      "        entry[\"ok\"] = False",
      "        entry[\"error\"] = \"%s: %s\" % (type(exc).__name__, exc)",
      "    try:",
      "        entry[\"version\"] = importlib.metadata.version(name)",
      "    except Exception:",
      "        entry[\"version\"] = None",
      "    out[name] = entry",
      "print(json.dumps(out))",
    ].join("\n");
    let child;
    try {
      child = spawnPython([...pythonFlags, "-c", script], { env: pythonEnvironment(), stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ error: error.message });
      return;
    }
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      finish({ error: `probe timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timer); finish({ error: error.message }); });
    child.once("close", () => {
      clearTimeout(timer);
      try {
        finish({ report: JSON.parse(String(stdout).trim().split("\n").pop()) });
      } catch {
        finish({ error: String(stderr).trim().slice(-300) || "probe produced no report" });
      }
    });
  });
}

async function checkDependencies() {
  const checks = [];
  const probe = await probePythonEnvironment();
  const report = probe.report || null;
  checks.push(report
    ? { name: "python3", status: "ok", detail: `${report.version || "unknown version"} · ${report.executable || python}` }
    : { name: "python3", status: fs.existsSync(python) ? "degraded" : "missing", detail: probe.error ? `${python} — ${probe.error}` : `not found at ${python}` });
  for (const name of ["mlx_lm", "mlx", "transformers"]) {
    const entry = report?.[name];
    if (!report) checks.push({ name, status: "missing", detail: "python probe did not run" });
    else if (entry?.ok) checks.push({ name, status: "ok", detail: `importable${entry.version ? ` · ${entry.version}` : ""}` });
    else checks.push({ name, status: "missing", detail: `not importable — ${entry?.error || "unknown error"}` });
  }
  const modelConfig = path.join(modelPath, "config.json");
  let modelCheck;
  try {
    JSON.parse(fs.readFileSync(modelConfig, "utf-8"));
    modelCheck = { name: "maple-model", status: "ok", detail: `config.json readable · ${modelPath}` };
  } catch (error) {
    modelCheck = fs.existsSync(modelPath)
      ? { name: "maple-model", status: "degraded", detail: `${modelPath} — config.json unreadable: ${error.message}` }
      : { name: "maple-model", status: "missing", detail: `no checkpoint at ${modelPath}` };
  }
  checks.push(modelCheck);
  checks.push({ name: "node", status: "ok", detail: `host runtime ${process.version}` });
  const missing = checks.filter((row) => row.status === "missing").length;
  const degraded = checks.filter((row) => row.status === "degraded").length;
  return {
    schema: "hemlock.deps.check.v1",
    status: missing ? "missing" : degraded ? "degraded" : "ok",
    checks,
    pythonPath: python,
    summary: missing ? `${missing} required piece(s) missing, ${degraded} degraded.` : degraded ? `${degraded} degraded; required pieces present.` : "All runtime dependencies present.",
  };
}

const agentCommands = {
  status: { label: "System status", capability: "read", auto: true, approval: "none", timeoutMs: 30000, countsAgainstBudget: false, inputHint: "{}" },
  "context.refresh": { label: "Refresh awareness context", capability: "context", auto: true, approval: "none", timeoutMs: 15000, countsAgainstBudget: false, inputHint: "{reason?}" },
  "context.search": { label: "Search awareness context", capability: "context", auto: true, approval: "none", timeoutMs: 15000, countsAgainstBudget: false, inputHint: "{query:\"short search string\"}" },
  "context.query": { label: "Query awareness context", capability: "context", auto: true, approval: "none", timeoutMs: 15000, countsAgainstBudget: false, inputHint: "{query:\"short question\"} or {sourceId,...}" },
  "sources.get": { label: "Inspect context sources", capability: "context", auto: true, approval: "none", timeoutMs: 15000, countsAgainstBudget: false, inputHint: "{}" },
  "sources.policy": { label: "Change context source policy", capability: "context", auto: false, approval: "explicit", timeoutMs: 15000, countsAgainstBudget: false, reversible: true, inputHint: "{sourceId, policy:{enabled?, permissionState?}}" },
  routes: { label: "Discover routes", capability: "read", auto: true, approval: "none", timeoutMs: 30000, countsAgainstBudget: false, inputHint: "{}" },
  "repo-map": { label: "Project map", capability: "read", auto: true, approval: "none", timeoutMs: 30000, countsAgainstBudget: false, inputHint: "{workspaceRoot?}" },
  "repo.inspect": { label: "Inspect repository surface", capability: "read", auto: true, approval: "none", timeoutMs: 30000, inputHint: "{paths?:[\"repo-relative\",...]}" },
  "file.read": { label: "Read a scoped file", capability: "read", auto: true, approval: "none", timeoutMs: 30000, inputHint: "{path:\"repo-relative\", maxBytes?}" },
  "file.search": { label: "Search scoped files", capability: "read", auto: true, approval: "none", timeoutMs: 30000, inputHint: "{query, path?:\"repo-relative\"}" },
  "git.status": { label: "Inspect git status", capability: "read", auto: true, approval: "none", timeoutMs: 30000, inputHint: "{workspaceRoot?}" },
  "git.diff": { label: "Inspect git diff", capability: "read", auto: true, approval: "none", timeoutMs: 30000, inputHint: "{paths?:[\"repo-relative\"], workspaceRoot?}" },
  "test.discover": { label: "Discover local tests", capability: "read", auto: true, approval: "none", timeoutMs: 30000, inputHint: "{}" },
  "verification.list": { label: "List verification profiles", capability: "read", auto: true, approval: "none", timeoutMs: 15000, countsAgainstBudget: false, inputHint: "{}" },
  "receipt.inspect": { label: "Inspect a local receipt", capability: "read", auto: true, approval: "none", timeoutMs: 15000, inputHint: "{path:\"receipt path under app data\"}" },
  recall: { label: "Recall memory", capability: "read", auto: true, approval: "none", timeoutMs: 30000, countsAgainstBudget: false, inputHint: "{query?, limit?}" },
  "receipts.query": { label: "Query local receipts", capability: "read", auto: true, approval: "none", timeoutMs: 30000, countsAgainstBudget: false, inputHint: "{}" },
  "improve.propose": { label: "Propose bounded local improvement", capability: "write", auto: false, approval: "explicit", timeoutMs: 120000, countsAgainstBudget: true, reversible: true, inputHint: "{summary, rationale, files?:[\"repo-relative\"], change?:\"patch/spec <=32KB\", confidence?:0-1}" },
  "intent.submit": { label: "Accept a Hemlock intent", capability: "task", auto: true, approval: "none", timeoutMs: 90000, countsAgainstBudget: false, inputHint: "{text|objective:\"task\", intent?, autonomy?, threadId?|workspaceRoot?, fallbackLane?:\"codex|claude|none\"}" },
  "thread.list": { label: "List Hemlock threads", capability: "task", auto: true, approval: "none", timeoutMs: 15000, countsAgainstBudget: false, inputHint: "{}" },
  "thread.search": { label: "Search Hemlock threads", capability: "task", auto: true, approval: "none", timeoutMs: 15000, countsAgainstBudget: false, inputHint: "{query, limit?<=40}" },
  "conversation.history": { label: "Read thread conversation history", capability: "read", auto: true, approval: "none", timeoutMs: 15000, countsAgainstBudget: false, inputHint: "{threadId?}" },
  "conversation.reset": { label: "Reset thread to fresh context", capability: "task", auto: false, approval: "explicit", timeoutMs: 15000, countsAgainstBudget: false, inputHint: "{threadId?}" },
  "conversation.trim": { label: "Trim thread conversation tail", capability: "task", auto: false, approval: "explicit", timeoutMs: 15000, countsAgainstBudget: false, inputHint: "{threadId?, keep?<=80, maxChars?}" },
  "provider.capacity": { label: "Set provider concurrency caps", capability: "task", auto: false, approval: "explicit", timeoutMs: 15000, countsAgainstBudget: false, reversible: true, inputHint: "{caps:{provider:maxConcurrent}}" },
  "thread.create": { label: "Create Hemlock thread", capability: "task", auto: false, approval: "explicit", timeoutMs: 30000, countsAgainstBudget: false, reversible: true, inputHint: "{title?, workspaceRoot?, projectId?|projectName?, autonomy?}" },
  "thread.switch": { label: "Switch Hemlock thread", capability: "task", auto: false, approval: "explicit", timeoutMs: 30000, countsAgainstBudget: false, reversible: true, inputHint: "{threadId}" },
  "thread.rename": { label: "Rename Hemlock thread", capability: "task", auto: false, approval: "explicit", timeoutMs: 15000, countsAgainstBudget: false, reversible: true, inputHint: "{threadId?, title}" },
  "thread.pause": { label: "Pause Hemlock thread", capability: "task", auto: false, approval: "explicit", timeoutMs: 15000, countsAgainstBudget: false, reversible: true, inputHint: "{threadId?, reason?}" },
  "thread.resume": { label: "Resume Hemlock thread", capability: "task", auto: false, approval: "explicit", timeoutMs: 30000, countsAgainstBudget: false, reversible: true, inputHint: "{threadId?}" },
  "thread.archive": { label: "Archive Hemlock thread", capability: "task", auto: false, approval: "explicit", timeoutMs: 15000, countsAgainstBudget: false, reversible: true, inputHint: "{threadId?}" },
  "thread.restore": { label: "Restore archived Hemlock thread", capability: "task", auto: false, approval: "explicit", timeoutMs: 15000, countsAgainstBudget: false, reversible: true, inputHint: "{threadId}" },
  "thread.cancel": { label: "Cancel Hemlock thread", capability: "task", auto: false, approval: "explicit", timeoutMs: 15000, countsAgainstBudget: false, reversible: true, inputHint: "{threadId?}" },
  "thread.checkpoints": { label: "List thread checkpoints", capability: "task", auto: true, approval: "none", timeoutMs: 15000, countsAgainstBudget: false, inputHint: "{threadId?}" },
  "thread.conversation": { label: "Read thread conversation tail", capability: "task", auto: true, approval: "none", timeoutMs: 15000, countsAgainstBudget: false, inputHint: "{threadId?, limit?<=200}" },
  "thread.fork": { label: "Fork Hemlock thread", capability: "task", auto: false, approval: "explicit", timeoutMs: 30000, countsAgainstBudget: false, reversible: true, inputHint: "{threadId?, title?}" },
  "thread.checkpoint.restore": { label: "Roll a thread back to a checkpoint", capability: "task", auto: false, approval: "explicit", timeoutMs: 15000, countsAgainstBudget: false, reversible: true, inputHint: "{threadId?, checkpointId}" },
  "thread.delete": { label: "Delete Hemlock thread", capability: "task", auto: false, approval: "explicit", timeoutMs: 30000, countsAgainstBudget: false, inputHint: "{threadId, force?}" },
  "project.list": { label: "List Hemlock projects", capability: "context", auto: true, approval: "none", timeoutMs: 15000, countsAgainstBudget: false, inputHint: "{}" },
  "project.register": { label: "Register project directory", capability: "context", auto: false, approval: "explicit", timeoutMs: 30000, countsAgainstBudget: false, reversible: true, inputHint: "{workspaceRoot, displayName?}" },
  "project.select": { label: "Select project directory", capability: "context", auto: false, approval: "explicit", timeoutMs: 30000, countsAgainstBudget: false, reversible: true, inputHint: "{projectId} or {workspaceRoot, projectName?}" },
  "context.compile": { label: "Compile compact thread context", capability: "context", auto: true, approval: "none", timeoutMs: 15000, countsAgainstBudget: false, inputHint: "{threadId?}" },
  "task.checkpoint": { label: "Record task checkpoint", capability: "task", auto: true, approval: "none", timeoutMs: 15000, countsAgainstBudget: false, inputHint: "{threadId?, phase?, status?, reason?}" },
  // T8-F6: task.escalate-provider removed — single-lane policy, no provider switching.
  "suggestion.list": { label: "List Hemlock suggestions", capability: "context", auto: true, approval: "none", timeoutMs: 15000, countsAgainstBudget: false, inputHint: "{status?}" },
  "suggestion.accept": { label: "Accept Hemlock suggestion", capability: "task", auto: false, approval: "explicit", timeoutMs: 30000, countsAgainstBudget: false, reversible: true, inputHint: "{suggestionId}" },
  "suggestion.dismiss": { label: "Dismiss Hemlock suggestion", capability: "context", auto: false, approval: "explicit", timeoutMs: 15000, countsAgainstBudget: false, reversible: true, inputHint: "{suggestionId}" },
  "suggestion.snooze": { label: "Snooze Hemlock suggestion", capability: "context", auto: false, approval: "explicit", timeoutMs: 15000, countsAgainstBudget: false, reversible: true, inputHint: "{suggestionId}" },
  "inference.respond": { label: "Run selected provider inference", capability: "inference", auto: true, approval: "none", timeoutMs: inferenceTimeoutMs, countsAgainstBudget: false, inputHint: "{query:\"user text\", refreshQuery?}" },
  "comparison.run": { label: "Compare last reply across lanes", capability: "read", auto: true, approval: "none", timeoutMs: inferenceTimeoutMs, countsAgainstBudget: false, inputHint: "{targetProvider?}" },
  "plan.propose": { label: "Propose bounded plan", capability: "task", auto: true, approval: "none", timeoutMs: 30000, countsAgainstBudget: false, reversible: true, inputHint: "{rationale?, steps?:[{commandId, label}]}" },
  "plan.approve": { label: "Approve bounded plan", capability: "task", auto: false, approval: "explicit", timeoutMs: 30000, countsAgainstBudget: false, reversible: true, inputHint: "{taskId?, planId?, budgetOverrides?}" },
  "plan.reject": { label: "Reject bounded plan", capability: "task", auto: false, approval: "explicit", timeoutMs: 30000, countsAgainstBudget: false, reversible: true, inputHint: "{planId?, reason?}" },
  "plan.revise": { label: "Revise remaining plan steps", capability: "task", auto: false, approval: "plan", timeoutMs: 30000, countsAgainstBudget: false, reversible: true, inputHint: "{steps:[{commandId,label,input?}|{kind:\"answer|ask_user\",label}], rationale?}" },
  "task.pause": { label: "Pause running task", capability: "task", auto: false, approval: "explicit", timeoutMs: 15000, countsAgainstBudget: false, reversible: true, inputHint: "{taskId?}" },
  "task.resume": { label: "Resume approved task", capability: "task", auto: false, approval: "explicit", timeoutMs: 30000, countsAgainstBudget: false, reversible: true, inputHint: "{taskId?}" },
  "task.answer": { label: "Answer Maple's question", capability: "task", auto: false, approval: "explicit", timeoutMs: 30000, countsAgainstBudget: false, reversible: true, inputHint: "{answer:\"the user reply\"}" },
  "action.accept": { label: "Accept proposed action", capability: "task", auto: false, approval: "explicit", timeoutMs: 30000, countsAgainstBudget: false, reversible: true, inputHint: "{actionId?}" },
  "action.reject": { label: "Reject proposed action", capability: "task", auto: false, approval: "explicit", timeoutMs: 30000, countsAgainstBudget: false, reversible: true, inputHint: "{actionId?, reason?}" },
  "task.ask": { label: "Ask the user for a decision", capability: "task", auto: true, approval: "none", timeoutMs: 15000, countsAgainstBudget: false, reversible: true, inputHint: "{question, context?}" },
  "task.complete": { label: "Complete task", capability: "task", auto: false, approval: "explicit", timeoutMs: 15000, countsAgainstBudget: false, reversible: true, inputHint: "{reason?}" },
  "task.block": { label: "Block task", capability: "task", auto: false, approval: "explicit", timeoutMs: 15000, countsAgainstBudget: false, reversible: true, inputHint: "{reason?}" },
  "training.prepare": { label: "Prepare Dream dataset", capability: "training-preparation", auto: true, approval: "none", timeoutMs: 30000, countsAgainstBudget: false, reversible: true, inputHint: "{examples?|conversation?|facts?, datasetId?}" },
  "training.start": { label: "Start explicit Dream training", capability: "train", auto: false, approval: "explicit", timeoutMs: 900000, inputHint: "{profile?:\"smoke|balanced|quality\", facts?|examples?|conversation?, iters?}" },
  "dream.detach": { label: "Detach active Dream graft", capability: "train", auto: false, approval: "explicit", timeoutMs: readinessTimeoutMs, countsAgainstBudget: false, reversible: true, inputHint: "{}" },
  "dream.fuse": { label: "Fuse a Dream graft into new served weights", capability: "train", auto: false, approval: "explicit", timeoutMs: 600000, countsAgainstBudget: false, reversible: true, inputHint: "{adapterPath?: \"defaults to the active graft\"}" },
  "dream.grafts": { label: "List Dream grafts", capability: "read", auto: true, approval: "none", timeoutMs: 15000, countsAgainstBudget: false, reversible: true, inputHint: "{}" },
  "dream.dataset.preview": { label: "Preview Dream dataset composition", capability: "read", auto: true, approval: "none", timeoutMs: 120000, countsAgainstBudget: false, reversible: true, inputHint: "{facts?|examples?|conversation?, samples?:8}" },
  "dream.eval": { label: "Compare served model vs adapter on tool-use tasks", capability: "train", auto: false, approval: "explicit", timeoutMs: 600000, countsAgainstBudget: false, reversible: true, inputHint: "{adapterPath?: \"defaults to the active graft\"}" },
  "maple.launch": { label: "Launch Maple/Dream runtime", capability: "runtime", auto: false, approval: "explicit", timeoutMs: readinessTimeoutMs, countsAgainstBudget: false, reversible: true, inputHint: "{}" },
  // Host-internal warm prefill: the ready/switch hooks call it freely (it is
  // a 1-token cache seed, never a mutation), while a model-proposed call
  // still rides the explicit-approval gate.
  "maple.warm": { label: "Warm Maple prompt cache prefix", capability: "runtime", auto: false, approval: "explicit", timeoutMs: 120000, countsAgainstBudget: false, reversible: true, inputHint: "{reason?}" },
  verify: { label: "Run verification", capability: "verify", auto: true, approval: "none", timeoutMs: 300000, inputHint: "{profile:\"app-build|diff-check|python-tests|lint|typecheck|npm-test\", workspaceRoot?}" },
  "shell.exec": { label: "Run a bounded workspace command", capability: "verify", auto: false, approval: "plan", timeoutMs: 60000, countsAgainstBudget: true, inputHint: "{command:\"git|rg|node|npm|python3|...\", args?:[...], cwd?:\"repo-relative\"}" },
  "change.prepare": { label: "Prepare isolated change set", capability: "write-preparation", auto: true, approval: "none", timeoutMs: 30000, reversible: true, inputHint: "{changeSetId?, patch?:\"unified diff\"}" },
  "code.inspect": { label: "Inspect assigned coding workspace", capability: "read", auto: true, approval: "none", timeoutMs: 30000, inputHint: "{threadId?}" },
  "code.apply": { label: "Apply scoped coding edit", capability: "write", auto: true, approval: "plan", timeoutMs: 30000, reversible: true, inputHint: "{source:{file:\"complete contents\"}|patches:[{path,content:\"complete file\"}], baseDigests?, reason?}" },
  "code.rollback": { label: "Roll back coding change set", capability: "write", auto: false, approval: "explicit", timeoutMs: 30000, reversible: true, inputHint: "{changeSetId}" },
  "change.apply": { label: "Apply plan-approved change set", capability: "write", auto: false, approval: "plan", timeoutMs: 30000, reversible: true, inputHint: "{changeSetId, confirm:true}" },
  "change.approve": { label: "Apply approved change set", capability: "write", auto: false, approval: "explicit", timeoutMs: 30000, reversible: true, inputHint: "{changeSetId}" },
  "change.reject": { label: "Reject prepared change set", capability: "write-preparation", auto: false, approval: "explicit", timeoutMs: 30000, countsAgainstBudget: false, reversible: true, inputHint: "{changeSetId, note?}" },
  "candidate.create": { label: "Create review candidate", capability: "context", auto: true, approval: "none", timeoutMs: 15000, countsAgainstBudget: false, reversible: true, inputHint: "{kind, title, summary, sourceRefs?:[], confidence?:0-1}" },
  "candidate.accept": { label: "Accept review candidate", capability: "task", auto: false, approval: "explicit", timeoutMs: 15000, countsAgainstBudget: false, reversible: true, inputHint: "{candidateId}" },
  "candidate.dismiss": { label: "Dismiss review candidate", capability: "context", auto: false, approval: "explicit", timeoutMs: 15000, countsAgainstBudget: false, reversible: true, inputHint: "{candidateId}" },
  cycle: { label: "Run one SIPS cycle", capability: "train", auto: false, approval: "explicit", timeoutMs: 900000, inputHint: "{objective, examples?:[{messages}], verifyProfile?, trainingProfile?:\"smoke|balanced|quality\"}" },
  dream: { label: "Run Dream", capability: "train", auto: false, approval: "explicit", timeoutMs: 900000, inputHint: "{profile?:\"smoke|balanced|quality\", facts?|examples?|conversation?, iters?}" },
  selfloop: { label: "Control self-loop", capability: "train", auto: false, approval: "explicit", timeoutMs: 30000, inputHint: "{selfloopAction?:\"start|pause|resume|complete|record\", focus?, outcome?, receiptPath?}" },
  "selfloop.start": { label: "Start self-loop", capability: "train", auto: false, approval: "explicit", timeoutMs: 30000, inputHint: "{focus?}" },
  "selfloop.pause": { label: "Pause self-loop", capability: "train", auto: false, approval: "explicit", timeoutMs: 30000, inputHint: "{outcome?}" },
  "selfloop.resume": { label: "Resume self-loop", capability: "train", auto: false, approval: "explicit", timeoutMs: 30000, inputHint: "{outcome?}" },
  "selfloop.complete": { label: "Complete self-loop", capability: "train", auto: false, approval: "explicit", timeoutMs: 30000, inputHint: "{outcome?, receiptPath?}" },
  remember: { label: "Record project lesson", capability: "memory", auto: true, approval: "none", timeoutMs: 30000, inputHint: "{body:\"reusable lesson\", title?, tags?, tier?}" },
  "memory.promote": { label: "Promote memory candidate", capability: "memory", auto: false, approval: "explicit", timeoutMs: 30000, inputHint: "{targetId, note?}" },
  "memory.demote": { label: "Demote project lesson", capability: "memory", auto: false, approval: "explicit", timeoutMs: 30000, inputHint: "{targetId, note?}" },
  "memory.rollback": { label: "Rollback memory promotion", capability: "memory", auto: false, approval: "explicit", timeoutMs: 30000, inputHint: "{targetId, note?}" },
  "memory.feedback": { label: "Record recall usefulness feedback", capability: "memory", auto: true, approval: "none", timeoutMs: 30000, countsAgainstBudget: false, inputHint: "{recordId, kind:\"useful|irrelevant\", query?}" },
  "memory.select": { label: "Select fit memories for training data", capability: "memory", auto: true, approval: "none", timeoutMs: 30000, countsAgainstBudget: false, inputHint: "{limit?, minFitness?, status?}" },
  "memory.list": { label: "List memory records with staleness and provenance", capability: "memory", auto: true, approval: "none", timeoutMs: 30000, countsAgainstBudget: false, inputHint: "{includeDemoted?, includeAudit?, threshold?}" },
  "memory.consolidate": { label: "Consolidate near-duplicate memories", capability: "memory", auto: false, approval: "plan", timeoutMs: 30000, countsAgainstBudget: true, reversible: true, inputHint: "{threshold?:0.7, dryRun?, note?}" },
  // memory.note is the only mint path on the agent surface — records land as
  // "candidate" so promotion still goes through memory.promote and the
  // append-only ledger semantics are preserved.
  "memory.note": { label: "Record a memory note", capability: "memory", auto: false, approval: "plan", timeoutMs: 30000, countsAgainstBudget: true, reversible: true, inputHint: "{title, body, tags?, evidenceRefs?}" },
  "artifact.create": { label: "Create task artifact", capability: "artifact", auto: true, approval: "none", timeoutMs: 30000, countsAgainstBudget: false, inputHint: "{artifactId?, title, kind?:\"html|svg|text|markdown|json\", entrypoint?, mime?}" },
  // Artifact writes land in the reversible, task-scoped artifact store — a
  // strictly safer surface than code.apply (already plan-gated), so these run
  // under plan approval instead of per-action explicit approval.
  "artifact.author": { label: "Author task artifact", capability: "artifact", auto: false, approval: "plan", timeoutMs: 30000, inputHint: "{source:\"complete self-contained HTML\"|{file:\"contents\"}, artifactId?, filename?, kind?}" },
  "artifact.update": { label: "Update task artifact", capability: "artifact", auto: false, approval: "plan", timeoutMs: 30000, inputHint: "{artifactId?, source|patches:\"complete-file map\", repairFor?}" },
  "artifact.restore": { label: "Restore a verified artifact revision", capability: "artifact", auto: true, approval: "none", timeoutMs: 30000, countsAgainstBudget: false, inputHint: "{artifactId, revision}" },
  "artifact.repair.retry": { label: "Retry artifact repair", capability: "artifact", auto: false, approval: "explicit", timeoutMs: 120000, countsAgainstBudget: false, inputHint: "{taskId?}" },
  "artifact.repair.use-last-good": { label: "Use last good artifact revision", capability: "artifact", auto: false, approval: "explicit", timeoutMs: 30000, countsAgainstBudget: false, inputHint: "{taskId?}" },
  "artifact.inspect": { label: "Inspect task artifact", capability: "artifact", auto: true, approval: "none", timeoutMs: 30000, countsAgainstBudget: false, inputHint: "{artifactId?}" },
  "artifact.compare": { label: "Compare artifact revisions", capability: "artifact", auto: true, approval: "none", timeoutMs: 30000, countsAgainstBudget: false, inputHint: "{artifactId?, from:revision, to?:revision}" },
  "artifact.freeze": { label: "Freeze artifact revision", capability: "artifact", auto: false, approval: "explicit", timeoutMs: 30000, inputHint: "{artifactId?}" },
  "artifact.export": { label: "Export artifact change set", capability: "artifact", auto: false, approval: "explicit", timeoutMs: 30000, inputHint: "{artifactId?}" },
  "changeset.apply": { label: "Apply an exported artifact change set to the thread repository", capability: "task", auto: false, approval: "explicit", timeoutMs: 60000, inputHint: "{changeSetId}" },
  "artifact.preview.open": { label: "Open isolated artifact preview", capability: "preview", auto: true, approval: "none", timeoutMs: 30000, countsAgainstBudget: false, inputHint: "{artifactId?, revision?}" },
  "artifact.preview.inspect": { label: "Inspect isolated artifact preview", capability: "preview", auto: true, approval: "none", timeoutMs: 30000, countsAgainstBudget: false, inputHint: "{sessionId?} or {inspection, digest?}" },
  "artifact.preview.interact": { label: "Interact with isolated artifact preview", capability: "preview", auto: true, approval: "none", timeoutMs: 30000, countsAgainstBudget: false, inputHint: "{sessionId?, previewAction, ...actionInput}" },
  "artifact.preview.stop": { label: "Stop isolated artifact preview", capability: "preview", auto: false, approval: "explicit", timeoutMs: 30000, countsAgainstBudget: false, inputHint: "{sessionId?, reason?}" },
  "experiment.run": { label: "Run a bounded world physics experiment", capability: "verify", auto: true, approval: "none", timeoutMs: 30000, inputHint: "{experiment:\"pendulum|projectile|orbit|spring|collision|terminal\", input?, seed?, hypothesis?}" },
  "experiment.note": { label: "Record an experiment finding into the Dream dataset", capability: "write", auto: true, approval: "none", timeoutMs: 30000, countsAgainstBudget: false, inputHint: "{claim:\"what the world showed\", experimentId?, hypothesis?}" },
  "experiment.dataset": { label: "List recorded experiment findings", capability: "read", auto: true, approval: "none", timeoutMs: 30000, countsAgainstBudget: false, inputHint: "{limit?}" },
  "experiment.suggest": { label: "Rank experiment coverage gaps", capability: "read", auto: true, approval: "none", timeoutMs: 15000, countsAgainstBudget: false, inputHint: "{limit?}" },
  "agent.capabilities": { label: "Describe my available commands", capability: "read", auto: true, approval: "none", timeoutMs: 15000, countsAgainstBudget: false, inputHint: "{}" },
  "agent.self": { label: "Read my own task snapshot", capability: "read", auto: true, approval: "none", timeoutMs: 15000, countsAgainstBudget: false, inputHint: "{}" },
  "world.state": { label: "Read the understory world state", capability: "read", auto: true, approval: "none", timeoutMs: 15000, countsAgainstBudget: false, inputHint: "{}" },
  // world.place mutates the grove (durable marker record + world.placed event)
  // so it rides the same plan gate as other world writes.
  "world.place": { label: "Place a grove marker", capability: "write", auto: false, approval: "plan", timeoutMs: 15000, countsAgainstBudget: true, reversible: true, inputHint: "{kind:\"marker|monument|sign\", label, note?, position?:{x,z}}" },
  "deps.check": { label: "Probe local runtime dependencies", capability: "read", auto: true, approval: "none", timeoutMs: 60000, countsAgainstBudget: false, inputHint: "{}" },
  "settings.get": { label: "Read runtime settings", capability: "read", auto: true, approval: "none", timeoutMs: 15000, countsAgainstBudget: false, inputHint: "{}" },
  "settings.set": { label: "Update runtime settings", capability: "task", auto: false, approval: "explicit", timeoutMs: 15000, countsAgainstBudget: false, reversible: true, inputHint: "{key, value} or {settings:{...}}" },
  "settings.clearPromptCache": { label: "Clear the persisted prompt cache", capability: "runtime", auto: false, approval: "explicit", timeoutMs: 15000, countsAgainstBudget: false, inputHint: "{}" },
};

// A user-initiated train run carries its own cycle budget, not the
// foreground task's: a resumed or long-lived task can hold
// maxTrainingCycles:0, which used to block every "Run local Dream" click
// with TRAINING_BUDGET_EXHAUSTED before the trainer spawned. The kernel
// reads the task budget synchronously inside startOperation, so a
// run-scoped task record is swapped in only for that call and the live
// task is restored immediately after. Agent-initiated runs
// (__fromAgentAction) still spend the task's own budget — the model cannot
// loop training past its granted cycles — and the explicit-approval gate
// in runAgentCommand is untouched either way.
function startCommandOperation({ command, descriptor, payload }) {
  if (descriptor.capability !== "train" || payload.__fromAgentAction === true) {
    return agentKernel.startOperation({ taskId: agentTask.id, command, capability: descriptor.capability, payload, descriptor });
  }
  const scopedTask = {
    ...agentTask,
    id: `task-train-${command}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
    objective: `Local ${command} run`,
    intent: "dream",
    budget: mergeBudget(DEFAULT_BUDGET),
  };
  agentKernel.syncTask(scopedTask);
  try {
    return agentKernel.startOperation({ taskId: scopedTask.id, command, capability: descriptor.capability, payload, descriptor });
  } finally {
    agentKernel.syncTask(agentTask);
  }
}

async function runAgentCommand(action, payload = {}) {
  const command = String(action || "status");
  if (!agentCommands[command]) throw new Error(`Hemlock command is not allowlisted: ${command}`);
  const descriptor = agentCommands[command];
  const approvedPlan = agentKernel.getProjection().plans.some((plan) => plan.id === agentTask.activePlanId && plan.status === "approved");
  const approvedPlanAction = payload.__approvedPlan === true && payload.__fromAgentAction === true && descriptor.approval === "plan" && approvedPlan;
  if (payload.automatic === true && descriptor.auto !== true && !approvedPlanAction) {
    appendAgentEvent("command.blocked", "blocked", { command, reason: "This capability requires an explicit user action." }, { reversible: true });
    throw new Error(`${command} requires an explicit user action.`);
  }
  let operation = null;
  try {
    operation = startCommandOperation({ command, descriptor, payload });
  } catch (budgetError) {
    appendAgentEvent("command.blocked", "blocked", { command, reason: budgetError.message, code: budgetError.code || "COMMAND_BUDGET" }, { reversible: true });
    throw budgetError;
  }
  // startOperation charges command/training budgets on the kernel's task
  // projection only; mirror the counters onto agentTask so state.json,
  // receipts, and the task.updated projection report real usage — and so a
  // later syncTask cannot stomp the kernel's count back to the stale value.
  try {
    const kernelBudget = agentKernel.getProjection().task?.budget || {};
    if (kernelBudget.commandsUsed !== agentTask.budget?.commandsUsed || kernelBudget.trainingCyclesUsed !== agentTask.budget?.trainingCyclesUsed) {
      updateAgentTask({ budget: { ...mergeBudget(agentTask.budget), commandsUsed: kernelBudget.commandsUsed, trainingCyclesUsed: kernelBudget.trainingCyclesUsed } }, { emit: false });
    }
  } catch { /* the budget mirror is advisory; the operation receipt is authoritative */ }
  appendAgentEvent("command.started", "running", { command, capability: descriptor.capability, operationId: operation.id, taskId: operation.taskId });
  try {
    let result;
    if (command === "intent.submit") result = await submitAgentIntent({ ...payload, operationId: payload.operationId || operation.id });
    else if (command === "thread.list") result = threadManager.snapshot();
    else if (command === "thread.search") {
      // Bounded title+body search over recent threads. Read-only; results feed
      // the palette THREADS section's content matches.
      const query = String(payload.query || "");
      const limit = Number.isFinite(Number(payload.limit)) ? Math.max(1, Math.min(40, Math.round(Number(payload.limit)))) : 6;
      result = { schema: "hemlock.agent.thread.search.v1", status: "searched", query, results: threadManager.searchThreads(query, { limit }) };
    }
    else if (command === "provider.capacity") result = { schema: "hemlock.agent.provider.capacity.v1", status: "updated", providerCaps: threadManager.setProviderCaps(payload.caps || payload) };
    else if (command === "thread.create") {
      const thread = threadManager.createThread(payload);
      result = { schema: "hemlock.agent.thread.result.v1", status: "created", thread, threads: threadManager.snapshot().threads };
    }
    else if (command === "thread.switch") {
      const thread = threadManager.switchThread(String(payload.threadId || ""));
      if (thread.taskSnapshot && typeof thread.taskSnapshot === "object") {
        // A thread's taskSnapshot may be from a previous session that
        // crashed or was closed mid-task, leaving status "running" or
        // "waiting_for_approval".  Treat that as blocked so the queue
        // does not enqueue every new intent behind a stale action loop.
        // Session identity decides: a snapshot written by a different session
        // belongs to a dead action loop no matter how young it is (the >10min
        // age check missed restarts seconds old). Snapshots predating the
        // sessionId stamp keep the age heuristic as fallback.
        const staleSnapshot = thread.taskSnapshot;
        const sessionBoundary = staleSnapshot.sessionId
          ? staleSnapshot.sessionId !== sessionId
          : staleSnapshot.startedAt
            && Date.now() - new Date(staleSnapshot.startedAt).getTime() > 600000; // 10 min
        agentTask = {
          ...staleSnapshot,
          threadId: thread.id, projectId: thread.projectId, workspaceRoot: thread.workspaceRoot,
          provider: thread.provider, model: thread.model, reasoning: thread.reasoning,
          autonomy: thread.autonomy,
          status: sessionBoundary ? "blocked" : staleSnapshot.status,
          phase: sessionBoundary ? "blocked" : staleSnapshot.phase,
          blockedReason: sessionBoundary
            ? "The previous session was interrupted; inspect and resume the task."
            : staleSnapshot.blockedReason || null,
          sessionId,
        };
      } else {
        agentTask = { ...agentTask, id: thread.taskId || `task-${thread.id}`, threadId: thread.id, projectId: thread.projectId, workspaceRoot: thread.workspaceRoot, objective: thread.title, provider: thread.provider, model: thread.model, reasoning: thread.reasoning, autonomy: thread.autonomy, phase: thread.phase || "conversation", status: thread.status || "ready", blockedReason: thread.blockedReason || null, sessionId };
      }
      writeAgentState();
      agentKernel.syncTask(agentTask);
      appendAgentEvent("thread.switched", "accepted", { threadId: thread.id, projectId: thread.projectId, workspaceRoot: thread.workspaceRoot }, { reversible: true });
      // The new thread's first step would cold-prefill if the switch cost
      // the cache its entries; a bounded warm re-seeds the shared prefix.
      void warmMaplePromptCache("thread-switch");
      result = { schema: "hemlock.agent.thread.result.v1", status: "switched", thread, task: agentTask, context: compileThreadContext(thread.id), conversation: threadManager.readConversation(thread.id) };
    }
    else if (command === "thread.rename") result = { schema: "hemlock.agent.thread.result.v1", status: "renamed", thread: threadManager.updateThread(String(payload.threadId || agentTask.threadId), { title: String(payload.title || payload.name || "Hemlock thread") }) };
    else if (command === "conversation.reset") {
      // T8-F2: fresh context. A poisoned history (refusal loops, dead-end
      // tangents) follows the model every turn; this archives the old
      // conversation file and starts clean, keeping the thread identity.
      const threadId = String(payload.threadId || agentTask.threadId);
      const reset = threadManager.resetConversation(threadId);
      appendAgentEvent("conversation.reset", "accepted", { threadId, archivedMessages: reset.archivedMessages, archivePath: reset.archivePath }, { reversible: false });
      result = { schema: "hemlock.agent.thread.result.v1", status: "reset", threadId, ...reset };
    }
    else if (command === "conversation.trim") {
      // Bounded tail trim for context-budget relief: the oldest messages
      // archive out beside the log while the recent tail stays, so the
      // thread keeps usable context. Receipted as context.compacted like
      // every other compaction — the spine records what was dropped.
      const threadId = String(payload.threadId || agentTask.threadId);
      const trimmed = threadManager.trimConversation(threadId, {
        keep: Number.isFinite(Number(payload.keep)) ? Math.max(1, Math.min(80, Math.round(Number(payload.keep)))) : 24,
        maxChars: Number.isFinite(Number(payload.maxChars)) ? Math.max(4000, Math.min(400000, Math.round(Number(payload.maxChars)))) : 48000,
      });
      appendAgentEvent("context.compacted", "degraded", { threadId, region: "thread-conversation", reason: String(payload.reason || "manual-trim"), dropped: { conversationMessages: trimmed.dropped }, kept: trimmed.kept, archivePath: trimmed.archivePath }, { reversible: false });
      result = { schema: "hemlock.agent.thread.result.v1", status: "trimmed", threadId, ...trimmed };
    }
    else if (command === "conversation.history") result = { schema: "hemlock.agent.thread.result.v1", status: "ok", threadId: String(payload.threadId || agentTask.threadId || ""), conversation: threadManager.readConversation(String(payload.threadId || agentTask.threadId || "")) };
    else if (command === "comparison.run") result = await runComparisonLane(payload);
    else if (command === "thread.pause") {
      const threadId = String(payload.threadId || agentTask.threadId);
      const checkpoint = threadManager.checkpoint(threadId, { taskId: agentTask.id, phase: "paused", status: "paused", reason: payload.reason || "paused-by-user", evidenceRefs: agentTask.evidenceRefs, artifactRepair: agentTask.artifactRepair, verificationIssues: agentTask.artifactRepair?.issues || [] });
      abortStreamsForTask(agentTask.id, "paused");
      updateAgentTask({ status: "paused", phase: "paused", foregroundStep: "Thread paused; resume explicitly to continue" });
      result = { schema: "hemlock.agent.thread.result.v1", status: "paused", thread: threadManager.pauseThread(threadId, payload.reason || "Paused by user"), checkpoint };
    }
    else if (command === "thread.resume") {
      const threadId = String(payload.threadId || agentTask.threadId);
      const thread = threadManager.resumeThread(threadId);
      result = { schema: "hemlock.agent.thread.result.v1", status: "resumable", thread, checkpoint: threadManager.latestCheckpoint(threadId), context: compileThreadContext(threadId) };
    }
    else if (command === "thread.archive") result = { schema: "hemlock.agent.thread.result.v1", status: "archived", thread: threadManager.archiveThread(String(payload.threadId || agentTask.threadId)) };
    else if (command === "thread.restore") {
      const threadId = String(payload.threadId || "");
      const thread = threadManager.updateThread(threadId, { status: "ready", phase: "conversation", archivedAt: null, blockedReason: null });
      result = { schema: "hemlock.agent.thread.result.v1", status: "restored", thread };
    }
    else if (command === "thread.cancel") result = { schema: "hemlock.agent.thread.result.v1", status: "cancelled", thread: threadManager.cancelThread(String(payload.threadId || agentTask.threadId)) };
    else if (command === "thread.checkpoints") {
      const threadId = String(payload.threadId || agentTask.threadId || "");
      result = { schema: "hemlock.agent.thread.checkpoints.v1", status: "ok", threadId, checkpoints: threadManager.checkpoints(threadId) };
    }
    else if (command === "thread.conversation") {
      const threadId = String(payload.threadId || agentTask.threadId || "");
      const limit = Number.isFinite(Number(payload.limit)) ? Math.max(1, Math.min(200, Math.round(Number(payload.limit)))) : 40;
      result = { schema: "hemlock.agent.thread.result.v1", status: "ok", threadId, conversation: threadManager.readConversation(threadId, { limit }) };
    }
    else if (command === "thread.fork") {
      // Fork is provenance, not history copy: the new thread inherits the
      // workspace/provider/autonomy, records where it came from, and the
      // active thread stays put — the fork only joins the list.
      const sourceId = String(payload.threadId || agentTask.threadId || "");
      const thread = threadManager.forkThread(sourceId, { title: payload.title });
      appendAgentEvent("thread.forked", "accepted", { threadId: sourceId, forkedThreadId: thread.id, title: thread.title }, { reversible: true });
      result = { schema: "hemlock.agent.thread.result.v1", status: "forked", thread, threads: threadManager.snapshot().threads };
    }
    else if (command === "thread.checkpoint.restore") {
      const threadId = String(payload.threadId || agentTask.threadId || "");
      const restored = threadManager.restoreCheckpoint(threadId, String(payload.checkpointId || ""));
      appendAgentEvent("thread.checkpoint.restored", "accepted", { threadId, checkpointId: restored.restoredCheckpoint?.id || null }, { reversible: true });
      result = { schema: "hemlock.agent.thread.result.v1", status: "checkpoint-restored", ...restored };
    }
    else if (command === "thread.delete") {
      const outcome = threadManager.deleteThread(String(payload.threadId || ""), { force: payload.force === true });
      appendAgentEvent("thread.deleted", "accepted", { threadId: outcome.threadId, removedFiles: outcome.removedFiles }, { reversible: false });
      result = { schema: "hemlock.agent.thread.result.v1", status: "deleted", ...outcome, threads: threadManager.snapshot().threads };
    }
    else if (command === "project.list") result = { schema: "hemlock.agent.project.result.v1", status: "ready", projects: threadManager.snapshot().projects };
    else if (command === "project.register") result = { schema: "hemlock.agent.project.result.v1", status: "registered", project: threadManager.registerProject(payload) };
    else if (command === "project.select") {
      const project = threadManager.project(String(payload.projectId || "")) || threadManager.registerProject(payload);
      result = { schema: "hemlock.agent.project.result.v1", status: "selected", project, threads: threadManager.snapshot().threads.filter((item) => item.projectId === project.id) };
    }
    else if (command === "context.compile") result = compileThreadContext(String(payload.threadId || agentTask.threadId));
    else if (command === "task.checkpoint") result = threadManager.checkpoint(String(payload.threadId || agentTask.threadId), { ...payload, taskId: payload.taskId || agentTask.id, phase: payload.phase || agentTask.phase, status: payload.status || agentTask.status, evidenceRefs: payload.evidenceRefs || agentTask.evidenceRefs, artifactRepair: payload.artifactRepair || agentTask.artifactRepair, autonomyPolicy: payload.autonomy || agentTask.autonomy });
    else if (command === "suggestion.list") result = { schema: "hemlock.agent.suggestion.result.v1", status: "ready", suggestions: threadManager.listSuggestions({ threadId: payload.threadId || agentTask.threadId, status: payload.status }) };
    else if (["suggestion.accept", "suggestion.dismiss", "suggestion.snooze"].includes(command)) {
      const status = command.split(".")[1] === "accept" ? "accepted" : command.split(".")[1] === "dismiss" ? "dismissed" : "snoozed";
      const suggestion = threadManager.transitionSuggestion(String(payload.suggestionId || ""), status);
      result = { schema: "hemlock.agent.suggestion.result.v1", status, suggestion };
    }
    else if (command === "inference.respond") {
      // T7-S4 FIX 3: this path bypasses intent, so refresh recall from the
      // live prompt before injectGroundedContext builds context.
      const recallQuery = String(payload.refreshQuery || payload.query || lastUserMessage(threadManager.readConversation(String(agentTask.threadId || ""))) || "");
      result = await runInference({ ...payload, refreshQuery: recallQuery });
    }
    else if (command === "training.prepare") result = prepareTrainingDataset(payload);
    else if (command === "training.start") result = await runDream(payload);
    else if (command === "maple.launch") result = await launchMapleRuntime({ resetCrashLoop: true });
    else if (command === "maple.warm") result = await warmMaplePromptCache(String(payload.reason || "command"));
    else if (command === "status") result = await runSipsRuntime({ action: "status" });
    else if (command === "context.refresh") result = await contextBroker.refresh({ reason: payload.reason || "command" });
    else if (command === "context.search") result = contextBroker.search(payload.query || "");
    else if (command === "context.query") result = payload.sourceId ? contextSources.query(payload) : contextBroker.search(payload.query || "");
    else if (command === "sources.get") result = { schema: "hemlock.agent.sources.v1", status: "ready", sources: agentKernel.getSources(), health: contextSources.getState() };
    else if (command === "sources.policy") {
      result = agentKernel.setSourcePolicy(String(payload.sourceId || ""), payload.policy || payload);
      contextBroker.setSourcePolicy(result.source.sourceId, result.source);
      appendAgentEvent("context.source.policy.updated", "passed", result, { reversible: true });
    }
    else if (command === "routes") result = await runSipsRuntime({ action: "routes" });
    else if (command === "repo-map") result = await repoMap(payload);
    else if (command === "repo.inspect") result = repoInspect(payload);
    else if (command === "file.read") result = readFileTool(payload);
    else if (command === "file.search") result = await searchFilesTool(payload);
    else if (command === "code.inspect") result = codingWorkspace.inspect({ threadId: payload.threadId || agentTask.threadId });
    else if (command === "code.apply") {
      if (payload.__fromAgentAction && !approvedPlanAction) throw new Error("Applying a coding edit requires an approved Hemlock plan action.");
      result = codingWorkspace.apply({ threadId: payload.threadId || agentTask.threadId, source: payload.source, patches: payload.patches, baseDigests: payload.baseDigests, reason: payload.reason || agentTask.objective });
      updateAgentTask({ evidenceRefs: [...new Set([...(agentTask.evidenceRefs || []), ...(result.evidenceRefs || [])])], foregroundStep: "Scoped coding edit applied; verification is next" });
      // Conversational Build flow: surface post-apply verification in Chat.
      // The coding repair autopilot runs its own verify loop, so stay out of
      // its way. Fire-and-forget: apply's result must not block on a long
      // verification run.
      if (!String(payload.__agentActionId || "").startsWith("code-repair")) void runPostApplyVerification(result);
    }
    else if (command === "code.rollback") result = codingWorkspace.rollback({ threadId: payload.threadId || agentTask.threadId, changeSetId: payload.changeSetId });
    else if (command === "git.status") result = await gitStatusTool(payload);
    else if (command === "git.diff") result = await gitDiffTool(payload);
    else if (command === "test.discover") result = testDiscover();
    else if (command === "verification.list") result = verificationList();
    else if (command === "receipt.inspect") result = inspectReceipt(payload);
    else if (command === "receipts.query") result = queryReceipts(payload);
    else if (command === "improve.propose") result = proposeImprovement(payload);
    else if (command === "agent.capabilities") result = agentCapabilities();
    else if (command === "agent.self") result = agentSelfSnapshot();
    else if (command === "world.state") result = worldStateSnapshot();
    else if (command === "world.place") {
      if (payload.__fromAgentAction && !approvedPlanAction) throw new Error("Placing a grove marker requires an approved Hemlock plan action.");
      result = placeWorldMarker(payload);
    }
    else if (command === "deps.check") result = await checkDependencies();
    else if (command === "settings.get") result = runtimeSettingsSnapshot();
    else if (command === "settings.set") result = setRuntimeSettings(payload);
    else if (command === "settings.clearPromptCache") result = clearPromptCacheFiles();
    else if (command === "artifact.create") result = artifactCommandReceipt(artifactRegistry.create({ ...payload, taskId: payload.taskId || agentTask.id }), command);
    else if (command === "artifact.author") result = artifactCommandReceipt(artifactRegistry.author({ ...payload, taskId: payload.taskId || agentTask.id }), command);
    else if (command === "artifact.update") result = artifactCommandReceipt(artifactRegistry.update({ ...payload, taskId: payload.taskId || agentTask.id }), command);
    else if (command === "artifact.restore") result = artifactRegistry.restore({ ...payload, taskId: payload.taskId || agentTask.id });
    else if (command === "artifact.inspect") result = artifactRegistry.inspect({ ...payload, taskId: payload.taskId || agentTask.id });
    else if (command === "artifact.compare") result = artifactRegistry.compare({ ...payload, taskId: payload.taskId || agentTask.id });
    else if (command === "artifact.freeze") result = artifactRegistry.freeze({ ...payload, taskId: payload.taskId || agentTask.id });
    else if (command === "artifact.export") result = artifactRegistry.export({ ...payload, taskId: payload.taskId || agentTask.id });
    else if (command === "artifact.preview.open") {
      const artifact = artifactRegistry.read(payload.taskId || agentTask.id, payload.artifactId);
      const session = previewSessions.open({ taskId: artifact.taskId, artifactId: artifact.id, revision: payload.revision || artifact.revision });
      const evidenceRefs = [artifactRegistry.manifestPath(artifact.taskId, artifact.id)];
      appendAgentEvent("artifact.preview.ready", "ready", { session, artifactId: artifact.id, revision: session.revision }, { evidenceRefs, reversible: true });
      appendAgentEvent("artifact.preview.inspection.requested", "running", { taskId: session.taskId, artifactId: session.artifactId, revision: session.revision, sessionId: session.id, checks: ["ready", "dom", "accessibility", "consoleErrors"] }, { evidenceRefs, reversible: true });
      result = { schema: "hemlock.agent.preview.open.v1", status: "ready", session, artifact, evidenceRefs, summary: `Opened preview session ${session.id} for revision ${session.revision}.` };
    }
    else if (command === "artifact.preview.inspect") {
      // Maple's inspect step can arrive without a resolvable sessionId (an
      // adaptive step before preview.open, or a stale model-supplied id). The
      // host resolves the newest session — or opens one from the task's
      // artifact — rather than blocking a receipt-backed plan on a missing id.
      let session = payload.sessionId ? previewSessions.get(payload.sessionId) : [...previewSessions.sessions.values()].at(-1) || null;
      if (!session) {
        const artifact = artifactRegistry.read(payload.taskId || agentTask.id, payload.artifactId);
        session = previewSessions.open({ taskId: artifact.taskId, artifactId: artifact.id, revision: payload.revision || artifact.revision });
        appendAgentEvent("artifact.preview.ready", "ready", { session, artifactId: artifact.id, revision: session.revision, reason: "inspect arrived before any preview session; host opened one" }, { evidenceRefs: [artifactRegistry.manifestPath(artifact.taskId, artifact.id)], reversible: true });
      }
      const artifact = artifactRegistry.read(session.taskId, session.artifactId);
      const staticVerification = verifyArtifactSource(artifact);
      const report = payload.report?.schema === "hemlock.agent.artifact.preview.report.v1" ? recordPreviewReport(payload.report) : payload.inspection ? recordPreviewReport({ schema: "hemlock.agent.artifact.preview.report.v1", taskId: session.taskId, artifactId: session.artifactId, revision: session.revision, sessionId: session.id, ready: true, inspection: payload.inspection, consoleErrors: payload.consoleErrors || [], inspectionDigest: payload.digest || null }) : awaitPreviewReport(session);
      const verification = report?.schema === "hemlock.agent.artifact.verification.v1" ? { ...report, static: report.static || staticVerification, issues: [...(staticVerification.issues || []), ...(report.issues || [])] } : { ...report, static: staticVerification, issues: staticVerification.issues || [] };
      const status = verification.status === "passed" && !verification.issues.length && staticVerification.status === "passed" ? "passed" : "blocked";
      const evidenceRefs = [...new Set([...(verification.evidenceRefs || []), artifactRegistry.manifestPath(session.taskId, session.artifactId), ...(verification.receiptPath ? [verification.receiptPath] : [])])];
      const finalVerification = { ...verification, schema: "hemlock.agent.artifact.verification.v1", status: status === "passed" ? "passed" : "failed", evidenceRefs };
      appendAgentEvent("artifact.inspection.completed", status, { session, verification: finalVerification, inspection: payload.inspection || report?.inspection || null, digest: payload.digest || report?.inspectionDigest || null }, { evidenceRefs, reversible: true });
      result = { schema: "hemlock.agent.preview.inspect.v1", status, session: previewSessions.inspect(session.id, { digest: finalVerification.inspectionDigest, inspection: report?.inspection || payload.inspection }), verification: finalVerification, inspectionReceiptPath: verification.receiptPath || null, evidenceRefs, summary: status === "passed" ? `Preview verification passed for revision ${session.revision}.` : `Preview verification needs repair: ${(finalVerification.issues || []).map((item) => item.message).join(" ")}` };
    }
    else if (command === "artifact.preview.interact") {
      payload = { ...payload, sessionId: payload.sessionId || [...previewSessions.sessions.values()].at(-1)?.id };
      const authorization = previewSessions.authorize(payload.sessionId, String(payload.previewAction || payload.action || ""), payload);
      if (!authorization.allowed) {
        appendAgentEvent("artifact.interaction.blocked", "blocked", { sessionId: payload.sessionId, reason: authorization.reason, previewOnly: true }, { reversible: true });
        result = { schema: "hemlock.agent.preview.interact.v1", status: "blocked", ...authorization };
      } else {
        const interaction = previewSessions.complete(payload.sessionId, payload);
        result = { schema: "hemlock.agent.preview.interact.v1", status: "passed", authorization, interaction };
      }
    }
    else if (command === "artifact.preview.stop") result = { schema: "hemlock.agent.preview.stop.v1", status: "stopped", session: previewSessions.stop(payload.sessionId || [...previewSessions.sessions.values()].at(-1)?.id, payload.reason || "user_stopped").session };
    else if (command === "recall") {
      result = await runSipsRuntime({ action: "recall", query: payload.query, limit: payload.limit });
      appendAgentEvent("memory.recalled", "passed", { query: payload.query || "", count: result.records?.length || 0, records: result.records || [] }, { evidenceRefs: [path.join(sipsDir, "memory.jsonl")] });
    }
    else if (command === "verify") result = await runVerification(String(payload.profile || "app-build"), emitSipsProgress, { operationId: operation.id, workspaceRoot: payload.workspaceRoot || agentTask.workspaceRoot });
    else if (command === "shell.exec") result = await runShellExec(payload, operation.id);
    else if (command === "change.prepare") result = await prepareChangeSet(payload);
    else if (command === "change.apply") {
      if (!approvedPlanAction) throw new Error("Applying a change set requires an approved Hemlock plan action.");
      result = await transitionChangeSet({ ...payload, confirm: true }, "approve");
    }
    else if (command === "change.approve") result = await transitionChangeSet(payload, "approve");
    else if (command === "change.reject") result = await transitionChangeSet(payload, "reject");
    else if (command === "changeset.apply") result = await changesetApplier.apply({ ...payload, threadWorkspaceRoot: agentTask.workspaceRoot || null });
    else if (command === "candidate.create") {
      const candidate = agentKernel.createCandidate(payload);
      appendAgentEvent("candidate.created", "candidate", { candidate }, { evidenceRefs: candidate.sourceRefs || [], reversible: true });
      result = { schema: "hemlock.agent.candidate.result.v1", status: "candidate", candidate };
    }
    else if (command === "candidate.accept" || command === "candidate.dismiss") {
      const transition = command.split(".")[1];
      const candidate = agentKernel.transitionCandidate(String(payload.candidateId || ""), transition);
      if (transition === "accept") updateAgentTask({ objective: candidate.title, intent: candidate.kind === "memory" ? "memory" : "inspect", phase: "plan", status: "accepted", foregroundStep: "Plan the accepted candidate", blockedReason: null });
      appendAgentEvent(`candidate.${transition}ed`, "recorded", { candidate }, { evidenceRefs: candidate.sourceRefs || [], reversible: true });
      result = { schema: "hemlock.agent.candidate.result.v1", status: candidate.status, candidate };
    }
    else if (command === "experiment.run") result = await runWorldExperiment(payload);
    else if (command === "experiment.note") result = await recordExperimentFinding(payload);
    else if (command === "experiment.dataset") result = experimentDataset(payload);
    else if (command === "experiment.suggest") result = experimentSuggest(payload);
    else if (command === "cycle") result = await runSipsCycle(payload);
    else if (command === "dream") result = await runDream(payload);
    else if (command === "dream.detach") result = await detachGraft();
    else if (command === "dream.fuse") result = await fuseGraft(payload);
    else if (command === "dream.grafts") result = { schema: "hemlock.dream.grafts.v1", ...readGrafts(), activeAdapter: serverState.adapterPath || null };
    else if (command === "dream.dataset.preview") result = await runDreamDatasetPreview(payload);
    else if (command === "dream.eval") {
      const { runAdapterComparison } = require("./tool_use_live.cjs");
      const adapterPath = String(payload.adapterPath || serverState.adapterPath || "");
      const evalsDir = path.join(sipsDir, "evals");
      try {
        const result0 = await runAdapterComparison({ endpoint: serverUrl, adapterPath });
        // The filename must end in *-receipt.json so receipts.query's
        // walkFiles pattern (receipt\.json$) surfaces it on the receipts
        // pane alongside the graft/training receipts.
        const receiptPath = path.join(evalsDir, `dream-eval-${Date.now()}-receipt.json`);
        writeJsonFile(receiptPath, { ...result0.comparison, candidateAdapterPath: adapterPath || null });
        // A dead server fails every task in both lanes — recorded per-task,
        // not thrown. That outcome is a degraded eval, never a verdict.
        const responded = (result0.base?.respondedRate ?? 0) + (result0.candidate?.respondedRate ?? 0);
        if (responded === 0) {
          appendAgentEvent("dream.eval.degraded", "degraded", { reason: "No eval task produced a response in either lane; the inference server is likely unavailable.", adapterPath: adapterPath || null, receiptPath }, { evidenceRefs: [receiptPath], reversible: true });
          result = { ...result0, status: "degraded", receiptPath };
        } else {
          appendAgentEvent("dream.eval.completed", "passed", { verdict: result0.comparison?.verdict || null, receiptPath }, { evidenceRefs: [receiptPath], reversible: true });
          result = { ...result0, receiptPath };
        }
      } catch (evalError) {
        // Even a hard failure (e.g. the benchmark file is unreadable)
        // leaves a receipt-shaped record and event instead of crashing
        // through the dispatch without an honest artifact.
        const receiptPath = path.join(evalsDir, `dream-eval-${Date.now()}-failed-receipt.json`);
        const claimBoundary = "The eval could not run; nothing is claimed about the adapter.";
        try {
          writeJsonFile(receiptPath, { schema: "hemlock.dream.eval.v1", status: "failed", error: evalError.message, candidateAdapterPath: adapterPath || null, claimBoundary });
          appendAgentEvent("dream.eval.failed", "degraded", { error: evalError.message, adapterPath: adapterPath || null, receiptPath }, { evidenceRefs: [receiptPath], reversible: true });
          result = { schema: "hemlock.dream.eval.v1", status: "degraded", error: evalError.message, receiptPath, claimBoundary };
        } catch (receiptError) {
          appendAgentEvent("dream.eval.failed", "failed", { error: evalError.message, receiptError: receiptError.message, adapterPath: adapterPath || null }, { reversible: true });
          result = { schema: "hemlock.dream.eval.v1", status: "degraded", error: evalError.message, claimBoundary };
        }
      }
    }
    else if (command === "selfloop" || command.startsWith("selfloop.")) result = await runSipsRuntime({ action: "selfloop", selfloopAction: command.startsWith("selfloop.") ? command.split(".")[1] : payload.selfloopAction, focus: payload.focus, outcome: payload.outcome, receiptPath: payload.receiptPath });
    else if (command === "remember") result = await recordAgentMemory(payload);
    else if (command === "memory.feedback") {
      // T6-M1b: recall usefulness feedback. The ledger append is additive in
      // sips_runtime.py (sidecar feedback.jsonl); the demote policy reuses
      // memory_fitness.shouldAutoDemote and the EXISTING demote transition
      // (with its rollback receipt) — no new demote path is invented here.
      result = await runSipsRuntime({ action: "memory-feedback", recordId: payload.recordId, kind: payload.kind, query: payload.query });
      const counts = { useful: Math.max(0, Math.floor(Number(result?.counts?.useful))) || 0, irrelevant: Math.max(0, Math.floor(Number(result?.counts?.irrelevant))) || 0 };
      const autoDemote = String(result?.recordStatus || "") === "active" && shouldAutoDemote(counts);
      if (autoDemote) {
        const demoted = await runSipsRuntime({ action: "memory-transition", transition: "demote", targetId: payload.recordId, note: payload.note || `Auto-demoted after ${counts.irrelevant} not-relevant recall votes vs ${counts.useful} useful votes.`, evidencePath: sessionEventsPath, provenance: "Hemlock recall usefulness auto-demote" });
        appendAgentEvent("memory.demote", "recorded", { targetId: payload.recordId, reason: "recall-feedback-auto-demote", record: demoted.record }, { evidenceRefs: [demoted.memoryPath], reversible: true });
      }
      result = { ...result, autoDemoted: autoDemote };
      appendAgentEvent("memory.feedback", "recorded", { recordId: payload.recordId, kind: payload.kind, query: payload.query || "", counts, autoDemoted: autoDemote }, { evidenceRefs: [result.feedbackPath], reversible: true });
    }
    else if (command === "memory.select") {
      result = await runSipsRuntime({ action: "memory-select", limit: payload.limit, minFitness: payload.minFitness, status: payload.status });
      // Advisory rerank: when /v1/decide is live, the model re-rates the
      // heuristic top slice against the task objective and the reorder is
      // receipted on the event. Unsupported or failed decide → heuristic
      // order stands.
      let decideRanked = false;
      const heuristicRecords = Array.isArray(result?.records) ? result.records : [];
      if (heuristicRecords.length > 1 && decideAvailable()) {
        try {
          const reranked = await decideRerankMemoryRecords(heuristicRecords.slice(0, MEMORY_RERANK_LIMIT), agentTask);
          if (Array.isArray(reranked) && reranked.length) {
            result = { ...result, records: [...reranked, ...heuristicRecords.slice(MEMORY_RERANK_LIMIT)] };
            decideRanked = true;
          }
        } catch { /* heuristic order stands */ }
      }
      appendAgentEvent("memory.select", "passed", { count: result.records?.length || 0, ...(decideRanked ? { decideRanked: true } : {}) }, { evidenceRefs: [path.join(sipsDir, "memory.jsonl")], reversible: true });
    }
    else if (command === "memory.list") {
      // Read-only annotated inventory for the Memory window: every record
      // carries effectiveStatus, feedback, fitness/rankScore, and the
      // staleness/provenance fields (ageDays, lastUsedAt, sourceRefs) plus
      // nearDuplicateOf/clusterSize dupe markers.
      result = await runSipsRuntime({ action: "memory-list", includeDemoted: payload.includeDemoted, includeAudit: payload.includeAudit, threshold: payload.threshold });
      appendAgentEvent("memory.listed", "passed", { count: result.records?.length || 0 }, { evidenceRefs: [path.join(sipsDir, "memory.jsonl")], reversible: true });
    }
    else if (command === "memory.consolidate") {
      // Append-only near-dedup: the runtime clusters candidate+active records
      // by word-set Jaccard, merges each cluster into its highest-fitness
      // record via a "consolidate" overlay note, and demotes the absorbed
      // records (reason "consolidated-into-<keptId>"). Undo = promote the
      // absorbed ids + rollback the overlay note id — nothing is deleted.
      result = await runSipsRuntime({ action: "memory-consolidate", threshold: payload.threshold, dryRun: payload.dryRun, note: payload.note, evidencePath: sessionEventsPath });
      appendAgentEvent("memory.consolidated", "recorded", { clusters: result.clusters || [], merged: result.merged || 0, keptIds: result.keptIds || [], dryRun: result.status === "preview" }, { evidenceRefs: [result.memoryPath || path.join(sipsDir, "memory.jsonl")], reversible: true });
    }
    else if (command === "memory.note") {
      // Plan-gated mint: the record is appended with status "candidate" —
      // promotion still goes through memory.promote, so this stays inside the
      // ledger's append-only semantics. The runtime owns the durable write;
      // the host only clamps input and receipts the event.
      if (payload.__fromAgentAction && !approvedPlanAction) throw new Error("Recording a memory note requires an approved Hemlock plan action.");
      if (!String(payload.body || "").trim()) throw new Error("memory.note needs a non-empty body.");
      const tags = Array.isArray(payload.tags) ? payload.tags.map((tag) => String(tag)).join(",") : payload.tags;
      const record = await runSipsRuntime({
        action: "record",
        title: String(payload.title || "").trim() || "Hemlock memory note",
        body: String(payload.body || "").slice(0, 4000),
        tags: tags || "hemlock,note",
        evidencePath: Array.isArray(payload.evidenceRefs) && payload.evidenceRefs.length ? String(payload.evidenceRefs[0]) : undefined,
        provenance: `Hemlock memory.note command ${sessionId}`,
      });
      appendAgentEvent("memory.noted", "recorded", { recordId: record.record?.id || null, title: record.record?.title || null }, { evidenceRefs: [record.memoryPath || path.join(sipsDir, "memory.jsonl")], reversible: true });
      result = { schema: "hemlock.sips.memory-note.v1", status: "recorded", record: record.record, memoryPath: record.memoryPath || null, evidenceRefs: [record.memoryPath || path.join(sipsDir, "memory.jsonl")] };
    }
    else if (command.startsWith("memory.")) {
      result = await runSipsRuntime({ action: "memory-transition", transition: command.split(".")[1], targetId: payload.targetId, note: payload.note, evidencePath: sessionEventsPath, provenance: `Hemlock memory command ${command}` });
      appendAgentEvent(`memory.${command.split(".")[1]}`, "recorded", { targetId: payload.targetId, record: result.record }, { evidenceRefs: [result.memoryPath], reversible: true });
    }
    else if (command === "plan.propose") result = agentOrchestrator.proposePlan(agentTask, payload);
    else if (command === "plan.approve") {
      // T7-S3: clamp user-granted budget overrides and pin them on the task (mergeBudget semantics) before approval resumes it.
      const overrides = clampBudgetOverrides(payload.budgetOverrides);
      if (Object.keys(overrides).length) agentOrchestrator.updateTask({ budget: mergeBudget({ ...agentOrchestrator.task().budget, ...overrides }) });
      result = await agentOrchestrator.approvePlan(String(payload.taskId || agentTask.id), String(payload.planId || agentTask.activePlanId || ""));
    }
    else if (command === "plan.reject") result = agentOrchestrator.rejectPlan(String(payload.taskId || agentTask.id), String(payload.planId || agentTask.activePlanId || ""), String(payload.reason || "Rejected by user"));
    else if (command === "plan.revise") result = agentOrchestrator.revisePlan(String(payload.taskId || agentTask.id), payload);
    else if (command === "task.pause") result = agentOrchestrator.pauseTask(String(payload.taskId || agentTask.id));
    else if (command === "task.resume") result = await agentOrchestrator.resumeTask(String(payload.taskId || agentTask.id));
    else if (command === "task.answer") {
      // T7-S1: answer-in-place. The user's reply is persisted exactly like any
      // other user message so thread history stays consistent, the pending
      // question is cleared from the projection, and the task resumes through
      // the normal resumeTask path.
      const gate = assertAnswerable(agentTask, payload.answer);
      if (!gate.ok) throw new Error(gate.reason);
      threadManager.appendConversation(agentTask.threadId, { role: "user", content: gate.text });
      updateAgentTask({ question: null, foregroundStep: `Answer received; resuming with your reply` });
      appendAgentEvent("task.answered", "passed", { taskId: agentTask.id, chars: gate.text.length }, { reversible: true });
      result = await agentOrchestrator.resumeTask(String(payload.taskId || agentTask.id));
    }
    else if (command === "action.accept") result = await agentOrchestrator.acceptAction(String(payload.taskId || agentTask.id), String(payload.actionId || agentTask.activeActionId || ""));
    else if (command === "action.reject") result = agentOrchestrator.rejectAction(String(payload.taskId || agentTask.id), String(payload.actionId || agentTask.activeActionId || ""), String(payload.reason || "Rejected by user"));
    else if (command === "task.ask") result = agentOrchestrator.askUser(String(payload.taskId || agentTask.id), String(payload.question || payload.prompt || ""), payload.context || {});
    else if (command === "task.complete") result = agentOrchestrator.completeTask(String(payload.taskId || agentTask.id), String(payload.reason || "Completed by user"));
    else if (command === "task.block") result = agentOrchestrator.blockTask(String(payload.taskId || agentTask.id), String(payload.reason || "Blocked by user"));
    else if (command === "artifact.repair.retry") result = await agentOrchestrator.retryArtifactRepair(String(payload.taskId || agentTask.id));
    else if (command === "artifact.repair.use-last-good") result = await agentOrchestrator.useLastGoodArtifact(String(payload.taskId || agentTask.id));
    const operationResult = result && typeof result === "object" ? { ...result, operationId: result.operationId || operation.id } : result;
    const completionStatus = operationResult?.status === "blocked" ? "blocked" : "passed";
    const evidenceRefs = operationResult?.receiptPath ? [operationResult.receiptPath] : operationResult?.evidenceRefs || [];
    agentKernel.finishOperation(operation.id, { status: completionStatus === "blocked" ? "blocked" : "completed", result: operationResult, evidenceRefs });
    appendAgentEvent("command.completed", completionStatus, { command, result: operationResult, operationId: operation.id }, { evidenceRefs });
    return operationResult;
  } catch (error) {
    agentKernel.finishOperation(operation?.id, { status: "failed", error: error.message });
    appendAgentEvent("command.completed", "failed", { command, error: error.message, operationId: operation?.id });
    throw error;
  }
}

async function inferStructuredAction(prompt) {
  // Lane fallback (agent_orchestrator): a retried step may pin one configured
  // external lane for exactly this call — it then runs the same
  // selection.provider !== "maple" → runCliInference path any non-maple task
  // uses, so executable resolution and the provider capacity lease still
  // gate availability. Only the CLI provider set is honored; anything else
  // falls through to the task's own lane. The Maple model path is dropped on
  // a fallback lane so provider defaults apply instead of a bogus -m flag.
  const laneOverride = ["codex", "claude"].includes(String(prompt?.fallbackProvider || "")) ? String(prompt.fallbackProvider) : null;
  const selection = normalizeSelection({ provider: laneOverride || agentTask.provider, model: laneOverride ? undefined : agentTask.model, reasoning: agentTask.reasoning });
  if (!prompt.__providerLease) {
    return threadManager.withProvider(selection.provider, agentTask.threadId || agentTask.id, (lease) => inferStructuredAction({ ...prompt, __providerLease: true }).then((result) => {
      if (lease.queuedMs) bumpAgentMetrics({ providerWaitMs: lease.queuedMs });
      return result;
    }));
  }
  const endpoint = agentInferenceEndpoint || serverUrl;
  const task = agentTask;
  const startedAt = Date.now();
  bumpAgentMetrics({ inferenceCalls: 1, repairCalls: prompt.repair?.schema === "hemlock.agent.artifact.repair.v1" ? 1 : 0 });
  const nextCommand = prompt.nextPlannedStep?.commandId || prompt.plan?.steps?.[prompt.history?.actions?.length || 0]?.commandId || "";
  const compactTask = {
    id: task.id,
    objective: task.objective,
    intent: task.intent,
    interactionMode: task.interactionMode,
    threadId: task.threadId || null,
    projectId: task.projectId || null,
    workspaceRoot: task.workspaceRoot || null,
    autonomy: task.autonomy || "bounded-local",
    // Pending steering only — the orchestrator marks items "delivered" once
    // a prompt carrying them secured a response, so stale steering does not
    // ride every later action-step prompt forever.
    steering: (task.steering || []).filter((item) => item && item.status !== "delivered").slice(-8).map((item) => String(item?.content || "").slice(0, 500)).filter(Boolean),
  };
  const compactContext = compileThreadContext(task.threadId || agentTask.threadId, { compact: true });
  const actionRequest = {
    task: compactTask,
    context: compactContext,
    nextStep: prompt.nextPlannedStep || null,
    allowedNextCommands: prompt.allowedNextCommands || null,
    progress: prompt.progress || null,
    completed: prompt.history || { actions: [], observations: [], operations: [] },
    repair: prompt.repair || null,
  };
  // Continuous KV session: the orchestrator replays prior steps verbatim as
  // chat turns so this prompt is a strict token-prefix extension of the
  // server's committed cache entry — only the trailing delta prefills.
  // sessionUserContent overrides the final user turn (used to follow a scored
  // prefix winner with a fill-in instruction).
  const sessionTurns = Array.isArray(prompt.sessionTurns) ? prompt.sessionTurns : [];
  const userContent = typeof prompt.sessionUserContent === "string" && prompt.sessionUserContent
    ? prompt.sessionUserContent
    : JSON.stringify(actionRequest);
  const messages = [
    { role: "system", content: prompt.system },
    ...sessionTurns,
    { role: "user", content: userContent },
  ];
  appendAgentEvent("inference.started", "running", {
    mode: "structured-action",
    taskId: task.id,
    provider: selection.provider,
    model: selection.model || null,
    reasoning: selection.reasoning,
    step: prompt.history?.actions?.length + 1 || 1,
  });
  if (selection.provider !== "maple") {
    const external = await runCliInference({ messages, taskId: task.id, operationId: null }, selection, { mode: "structured-action", structured: true });
    const content = String(external.answer || "").trim();
    if (!content) {
      const error = new Error(`${selection.label} returned no structured action content.`);
      error.code = "EMPTY_ACTION_OUTPUT";
      error.rawModelOutputRef = external.rawOutputRef;
      throw error;
    }
    return { content, channels: external.channels, rawOutputRef: external.rawOutputRef, provider: selection.provider, usage: external.payload?.usage || null };
  }
  const actionStream = startStream({ taskId: task.id, operationId: null, kind: "agent_action", provider: "maple" });
  // Transport option (set by the orchestrator's prompt object): a non-empty
  // prompt.assistantPrefix is forwarded as snake_case `assistant_prefix` so
  // the server can force/prefill the action turn's opening tokens. Older
  // servers reject unknown request fields with a 400 — when the error body
  // names the field, retry exactly once without it (one-shot fallback,
  // logged) rather than failing the step.
  const assistantPrefix = typeof prompt.assistantPrefix === "string" ? prompt.assistantPrefix : "";
  const actionRequestBody = (withAssistantPrefix) => JSON.stringify({
    model: resolveLocalModelPath(selection.model),
    messages,
    temperature: 0,
    top_p: 1,
    top_k: 0,
    // Maple's reasoning channel is model output, not a discardable hidden
    // preamble — it stays on by default; mapleMaxTokens is only the
    // transport/server ceiling. Same contract as conversation: "off" skips
    // CoT entirely (much faster action turns); unset leaves Maple's default
    // channel on without paying the forced enable_thinking flag overhead.
    max_tokens: mapleMaxTokens,
    stream: true,
    stream_options: { include_usage: true },
    response_format: { type: "json_object" },
    ...(selection.reasoning === "off" ? { chat_template_kwargs: { enable_thinking: false } } : {}),
    ...(withAssistantPrefix && assistantPrefix ? { assistant_prefix: assistantPrefix } : {}),
  });
  const sendActionRequest = async (withAssistantPrefix) => {
    try {
      return await fetchMapleWithRecovery(`${endpoint}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: actionRequestBody(withAssistantPrefix),
      }, inferenceTimeoutMs);
    } catch (error) {
      finishStream(actionStream, { status: "failed", stopReason: "transport_error" });
      throw error;
    }
  };
  let response = await sendActionRequest(true);
  let failedPayload = null;
  if (!response.ok) {
    failedPayload = await readResponse(response);
    const detail = failedPayload?.error?.message || failedPayload?.error || failedPayload?.raw || "";
    if (response.status === 400 && assistantPrefix && String(detail).includes("assistant_prefix")) {
      appendAgentEvent("inference.fallback", "degraded", { mode: "structured-action", field: "assistant_prefix", reason: "server rejected assistant_prefix; retrying once without it" }, { reversible: true });
      response = await sendActionRequest(false);
      failedPayload = response.ok ? null : await readResponse(response);
    }
  }
  if (!response.ok) {
    const payload = failedPayload || await readResponse(response);
    finishStream(actionStream, { status: "failed", stopReason: "http_error" });
    const detail = payload?.error?.message || payload?.error || payload?.raw || response.statusText || `HTTP ${response.status}`;
    const error = new Error(`Structured Maple action inference returned HTTP ${response.status}: ${detail}`);
    error.code = response.status >= 500 ? "RUNTIME_UNAVAILABLE" : "ACTION_INFERENCE_FAILED";
    const failedMessage = payload?.choices?.[0]?.message || {};
    const failedChannels = extractModelChannels(failedMessage);
    error.rawModelOutputRef = persistModelOutput({
      taskId: task.id,
      mode: "structured-action-failed",
      channels: Object.fromEntries(failedChannels.map((channel) => [channel.name, channel.text])),
      rawPayload: payload,
    });
    error.modelChannels = modelChannelRecords(Object.fromEntries(failedChannels.map((channel) => [channel.name, channel.text])));
    appendAgentEvent("inference.failed", "failed", {
      mode: "structured-action",
      error: error.message,
      elapsedMs: Date.now() - startedAt,
      channels: error.modelChannels,
      rawOutputRef: error.rawModelOutputRef,
      parseStatus: "http-failed",
    });
    throw error;
  }
  let payload = {};
  let rawPayloads = [];
  let finishReason = null;
  let usage = null;
  const streamedChannels = {};
  const contentType = response.headers.get("content-type") || "";
  if (response.body && typeof response.body.getReader === "function" && contentType.toLowerCase().includes("text/event-stream")) {
    const parser = new Utf8SseParser();
    const reader = response.body.getReader();
    let done = false;
    while (!done) {
      let result;
      try {
        result = await reader.read();
      } catch (error) {
        finishStream(actionStream, { status: "failed", stopReason: "stream_error" });
        throw error;
      }
      const events = parser.push(result.value || new Uint8Array(), { final: result.done === true });
      for (const event of events) {
        const parsed = parseSsePayload(event);
        if (parsed.done) { done = true; break; }
        if (!parsed.payload) continue;
        rawPayloads.push(compactModelPayload(parsed.payload));
        const delta = extractModelDelta(parsed.payload);
        if (delta.finishReason) finishReason = delta.finishReason;
        if (delta.usage) usage = delta.usage;
        for (const channel of delta.channels) {
          streamedChannels[channel.name] = `${streamedChannels[channel.name] || ""}${channel.text}`;
          publishStreamFrame(actionStream, { channel: channel.name, delta: channel.text, usage: delta.usage, stopReason: delta.finishReason });
        }
        payload = parsed.payload;
      }
      if (result.done) break;
    }
    payload = {
      ...(payload || {}),
      choices: [{ message: streamedChannels, finish_reason: finishReason }],
      usage: usage || payload?.usage || null,
    };
  } else {
    payload = await readResponse(response);
    rawPayloads = [payload];
    const bufferedMessage = payload?.choices?.[0]?.message || {};
    for (const channel of extractModelChannels(bufferedMessage)) publishStreamFrame(actionStream, { channel: channel.name, delta: channel.text, usage: payload.usage || null, stopReason: payload?.choices?.[0]?.finish_reason || null });
    finishReason = payload?.choices?.[0]?.finish_reason || null;
    usage = payload.usage || null;
  }
  const message = payload?.choices?.[0]?.message || {};
  const channels = extractModelChannels(message);
  const selectedActionText = selectStructuredActionText(message);
  const content = selectedActionText.text;
  const rawOutputRef = persistModelOutput({ taskId: task.id, operationId: null, mode: "structured-action", channels: Object.fromEntries(channels.map((channel) => [channel.name, channel.text])), rawPayload: rawPayloads.length === 1 ? rawPayloads[0] : rawPayloads });
  if (typeof content !== "string" || !content.trim()) {
    finishStream(actionStream, { status: "failed", stopReason: "empty_action_content", usage, rawOutputRef });
    const error = new Error("Maple returned no structured action content.");
    error.code = "EMPTY_ACTION_OUTPUT";
    appendAgentEvent("inference.failed", "failed", { mode: "structured-action", error: error.message, actionChannel: selectedActionText.channel, channels: modelChannelRecords(Object.fromEntries(channels.map((channel) => [channel.name, channel.text]))), rawOutputRef });
    throw error;
  }
  finishStream(actionStream, { status: "completed", stopReason: finishReason, usage, rawOutputRef });
  serverState = { ...serverState, processReady: true, inferenceReady: true };
  bumpAgentMetrics({ inferenceLatencyMs: Date.now() - startedAt });
  appendAgentEvent("inference.completed", "passed", {
    mode: "structured-action",
    usage: payload.usage || null,
    actionChannel: selectedActionText.channel,
    channels: modelChannelRecords(Object.fromEntries(channels.map((channel) => [channel.name, channel.text]))),
    rawOutputRef,
    telemetry: {
      elapsedMs: Date.now() - startedAt,
      finishReason: payload.choices?.[0]?.finish_reason || null,
      promptTokens: payload.usage?.prompt_tokens ?? null,
      completionTokens: payload.usage?.completion_tokens ?? null,
      cachedTokens: payload.usage?.prompt_tokens_details?.cached_tokens ?? payload.usage?.cached_tokens ?? null,
      cacheHitRatio: cacheStats({ promptTokens: payload.usage?.prompt_tokens ?? null, cachedTokens: payload.usage?.prompt_tokens_details?.cached_tokens ?? payload.usage?.cached_tokens ?? null }).hitRatio,
      tokensPerSecond: tokensPerSecond(payload.usage, Date.now() - startedAt),
      outputDigest: digestText(content),
      modelChannels: channels.map((channel) => ({ name: channel.name, digest: digestText(channel.text) })),
    },
  });
  return { content, channels: modelChannelRecords(Object.fromEntries(channels.map((channel) => [channel.name, channel.text]))), rawOutputRef, streamId: actionStream.streamId, actionChannel: selectedActionText.channel, reasoning: message.reasoning || message.reasoning_content || message.thought || "", requestContent: userContent, usage: payload.usage || null, promptTokens: payload.usage?.prompt_tokens ?? null, completionTokens: payload.usage?.completion_tokens ?? null, cachedTokens: payload.usage?.prompt_tokens_details?.cached_tokens ?? payload.usage?.cached_tokens ?? null };
}

// Scored-choice transport: same messages as inferStructuredAction, but the
// server prefills once and teacher-scores each candidate continuation
// (parallel constrained decoding). The forced <think> opener is closed via
// prompt_suffix so continuations are pure JSON. A server without /v1/score
// marks the path unsupported for the session instead of failing every step.
let scoreEndpointUnsupported = false;
async function scoreStructuredAction(prompt, candidates) {
  if (scoreEndpointUnsupported) return null;
  const selection = normalizeSelection({ provider: agentTask.provider, model: agentTask.model, reasoning: agentTask.reasoning });
  if (selection.provider !== "maple") return null;
  if (!prompt.__providerLease) {
    return threadManager.withProvider(selection.provider, agentTask.threadId || agentTask.id, (lease) => scoreStructuredAction({ ...prompt, __providerLease: true }, candidates).then((result) => {
      if (lease.queuedMs) bumpAgentMetrics({ providerWaitMs: lease.queuedMs });
      return result;
    }));
  }
  const endpoint = agentInferenceEndpoint || serverUrl;
  const task = agentTask;
  const startedAt = Date.now();
  const { SCORED_REASONING_PREFIX } = require("./agent_contracts.cjs");
  bumpAgentMetrics({ inferenceCalls: 1 });
  const compactTask = {
    id: task.id,
    objective: task.objective,
    intent: task.intent,
    interactionMode: task.interactionMode,
    threadId: task.threadId || null,
    projectId: task.projectId || null,
    workspaceRoot: task.workspaceRoot || null,
    autonomy: task.autonomy || "bounded-local",
    // Pending steering only — the orchestrator marks items "delivered" once
    // a prompt carrying them secured a response, so stale steering does not
    // ride every later action-step prompt forever.
    steering: (task.steering || []).filter((item) => item && item.status !== "delivered").slice(-8).map((item) => String(item?.content || "").slice(0, 500)).filter(Boolean),
  };
  const compactContext = compileThreadContext(task.threadId || agentTask.threadId, { compact: true });
  const actionRequest = {
    task: compactTask,
    context: compactContext,
    nextStep: prompt.nextPlannedStep || null,
    allowedNextCommands: prompt.allowedNextCommands || null,
    progress: prompt.progress || null,
    completed: prompt.history || { actions: [], observations: [], operations: [] },
    repair: prompt.repair || null,
  };
  const sessionTurns = Array.isArray(prompt.sessionTurns) ? prompt.sessionTurns : [];
  const userContent = JSON.stringify(actionRequest);
  appendAgentEvent("inference.started", "running", {
    mode: "scored-choice",
    taskId: task.id,
    provider: "maple",
    model: selection.model || null,
    step: prompt.history?.actions?.length + 1 || 1,
    candidateCount: candidates.length,
  });
  const response = await fetchMapleWithRecovery(`${endpoint}/v1/score`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: resolveLocalModelPath(selection.model),
      messages: [
        { role: "system", content: prompt.system },
        ...sessionTurns,
        { role: "user", content: userContent },
      ],
      // One fixed reasoning line, then close the think block: candidates are
      // scored as the action JSON itself, and the whole step replays verbatim
      // as {reasoning_content, content} on the next request. `commit` makes
      // the server store prompt+suffix+winner+eos in the prompt cache so the
      // next step (and this step's generative fill-in) starts from a strict
      // prefix hit instead of re-prefilling.
      prompt_suffix: `${SCORED_REASONING_PREFIX}\n</think>\n\n`,
      candidates,
      commit: true,
    }),
  }, inferenceTimeoutMs);
  const payload = await readResponse(response);
  if (!response.ok) {
    if (response.status === 404) {
      scoreEndpointUnsupported = true;
      return null;
    }
    const detail = payload?.error || payload?.raw || response.statusText || `HTTP ${response.status}`;
    const error = new Error(`Maple action scoring returned HTTP ${response.status}: ${detail}`);
    error.code = response.status >= 500 ? "RUNTIME_UNAVAILABLE" : "ACTION_SCORE_FAILED";
    appendAgentEvent("inference.failed", "failed", { mode: "scored-choice", error: error.message, elapsedMs: Date.now() - startedAt });
    throw error;
  }
  bumpAgentMetrics({ inferenceLatencyMs: Date.now() - startedAt });
  appendAgentEvent("inference.completed", "passed", {
    mode: "scored-choice",
    telemetry: {
      elapsedMs: Date.now() - startedAt,
      promptTokens: payload.promptTokens ?? null,
      cachedTokens: payload.cachedTokens ?? null,
      cacheHitRatio: cacheStats({ promptTokens: payload.promptTokens ?? null, cachedTokens: payload.cachedTokens ?? null }).hitRatio,
      candidateCount: Array.isArray(payload.candidates) ? payload.candidates.length : 0,
    },
  });
  return { ...payload, requestContent: userContent };
}

// /v1/decide transport: one request answers every question as a constrained
// choice/score over host-supplied criteria — the action-selection fast path
// uses it instead of N per-candidate /v1/score continuations, and
// memory.select uses it to rerank heuristic recall. Same prompt_suffix
// contract as scoring so a committed winner replays identically in the KV
// session. A 404 marks the endpoint unsupported for the session (older
// servers) and HEMLOCK_NO_DECIDE=1 disables it entirely; callers fall back.
let decideEndpointUnsupported = false;
function decideAvailable() {
  return !decideEndpointUnsupported && process.env.HEMLOCK_NO_DECIDE !== "1";
}
async function postDecideRequest({ mode, messages, questions, promptSuffix = "", state = null, commit = false, commitQuestion = null, telemetry = {} }) {
  if (!decideAvailable()) return null;
  const selection = normalizeSelection({ provider: agentTask.provider, model: agentTask.model, reasoning: agentTask.reasoning });
  if (selection.provider !== "maple") return null;
  const endpoint = agentInferenceEndpoint || serverUrl;
  const startedAt = Date.now();
  bumpAgentMetrics({ inferenceCalls: 1 });
  appendAgentEvent("inference.started", "running", {
    mode,
    taskId: agentTask.id,
    provider: "maple",
    model: selection.model || null,
    questionCount: Object.keys(questions || {}).length,
    ...telemetry,
  });
  const response = await fetchMapleWithRecovery(`${endpoint}/v1/decide`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: resolveLocalModelPath(selection.model),
      messages,
      prompt_suffix: promptSuffix,
      ...(state ? { state } : {}),
      questions,
      commit: Boolean(commit),
      ...(commitQuestion ? { commitQuestion } : {}),
    }),
  }, inferenceTimeoutMs);
  const payload = await readResponse(response);
  if (!response.ok) {
    if (response.status === 404) {
      decideEndpointUnsupported = true;
      return null;
    }
    const detail = payload?.error || payload?.raw || response.statusText || `HTTP ${response.status}`;
    const error = new Error(`Maple decide returned HTTP ${response.status}: ${detail}`);
    error.code = response.status >= 500 ? "RUNTIME_UNAVAILABLE" : "ACTION_DECIDE_FAILED";
    appendAgentEvent("inference.failed", "failed", { mode, error: error.message, elapsedMs: Date.now() - startedAt });
    throw error;
  }
  bumpAgentMetrics({ inferenceLatencyMs: Date.now() - startedAt });
  appendAgentEvent("inference.completed", "passed", {
    mode,
    telemetry: {
      elapsedMs: Date.now() - startedAt,
      promptTokens: payload?.usage?.promptTokens ?? null,
      cachedTokens: payload?.usage?.cachedTokens ?? null,
      cacheHitRatio: cacheStats({ promptTokens: payload?.usage?.promptTokens ?? null, cachedTokens: payload?.usage?.cachedTokens ?? null }).hitRatio,
      answerCount: Object.keys(payload?.answers || {}).length,
    },
  });
  return payload;
}

async function decideStructuredAction(prompt, candidates) {
  if (!decideAvailable()) return null;
  const selection = normalizeSelection({ provider: agentTask.provider, model: agentTask.model, reasoning: agentTask.reasoning });
  if (selection.provider !== "maple") return null;
  if (!prompt.__providerLease) {
    return threadManager.withProvider(selection.provider, agentTask.threadId || agentTask.id, (lease) => decideStructuredAction({ ...prompt, __providerLease: true }, candidates).then((result) => {
      if (lease.queuedMs) bumpAgentMetrics({ providerWaitMs: lease.queuedMs });
      return result;
    }));
  }
  const task = agentTask;
  const { SCORED_REASONING_PREFIX } = require("./agent_contracts.cjs");
  const compactTask = {
    id: task.id,
    objective: task.objective,
    intent: task.intent,
    interactionMode: task.interactionMode,
    threadId: task.threadId || null,
    projectId: task.projectId || null,
    workspaceRoot: task.workspaceRoot || null,
    autonomy: task.autonomy || "bounded-local",
    // Pending steering only — the orchestrator marks items "delivered" once
    // a prompt carrying them secured a response, so stale steering does not
    // ride every later action-step prompt forever.
    steering: (task.steering || []).filter((item) => item && item.status !== "delivered").slice(-8).map((item) => String(item?.content || "").slice(0, 500)).filter(Boolean),
  };
  const compactContext = compileThreadContext(task.threadId || agentTask.threadId, { compact: true });
  const actionRequest = {
    task: compactTask,
    context: compactContext,
    nextStep: prompt.nextPlannedStep || null,
    allowedNextCommands: prompt.allowedNextCommands || null,
    progress: prompt.progress || null,
    completed: prompt.history || { actions: [], observations: [], operations: [] },
    repair: prompt.repair || null,
  };
  const sessionTurns = Array.isArray(prompt.sessionTurns) ? prompt.sessionTurns : [];
  const userContent = JSON.stringify(actionRequest);
  const list = Array.isArray(candidates) ? candidates : [];
  // The model scores each candidate's label; the continuation is what the
  // server teacher-forces into the KV cache when that key wins.
  const criteria = {};
  list.forEach((candidate, index) => {
    const text = typeof candidate === "string" ? candidate : String(candidate?.text ?? "");
    criteria[`cand-${index}`] = {
      description: String(candidate?.commandId || candidate?.kind || `candidate ${index}`),
      label: text,
      continuation: text,
    };
  });
  const payload = await postDecideRequest({
    mode: "decide-choice",
    messages: [
      { role: "system", content: prompt.system },
      ...sessionTurns,
      { role: "user", content: userContent },
    ],
    promptSuffix: `${SCORED_REASONING_PREFIX}\n</think>\n\n`,
    questions: {
      "next-action": {
        type: "choice",
        instructions: "Pick the single best next-action continuation for this task step.",
        criteria,
      },
    },
    commit: true,
    commitQuestion: "next-action",
    telemetry: { step: prompt.history?.actions?.length + 1 || 1, candidateCount: list.length },
  });
  // Usage is flattened onto the payload so the orchestrator's cache-miss
  // detector sees cachedTokens exactly like a /v1/score result.
  return payload ? { ...payload, requestContent: userContent, promptTokens: payload?.usage?.promptTokens ?? null, cachedTokens: payload?.usage?.cachedTokens ?? null } : null;
}

// memory.select advisory rerank: the heuristic select orders by fitness; when
// /v1/decide is live the model re-rates the top slice against the task
// objective and the records are reordered by expected usefulness level.
// commit stays off — this is off-transcript and must not touch the action
// session's committed cache key.
const MEMORY_RERANK_LEVELS = ["not useful", "somewhat", "very useful"];
const MEMORY_RERANK_LIMIT = 12;
async function decideRerankMemoryRecords(records, task) {
  if (!decideAvailable()) return null;
  const selection = normalizeSelection({ provider: agentTask.provider, model: agentTask.model, reasoning: agentTask.reasoning });
  if (selection.provider !== "maple") return null;
  const { rerankByExpectedScore } = require("./agent_contracts.cjs");
  return threadManager.withProvider(selection.provider, agentTask.threadId || agentTask.id, async () => {
    const objective = String(task?.objective || "Hemlock task").slice(0, 300);
    const questions = {};
    records.forEach((record, index) => {
      const lesson = `${String(record?.title || record?.id || `record ${index}`)}: ${String(record?.body || record?.summary || "")}`.slice(0, 1200);
      questions[`mem-${index}`] = {
        type: "score",
        instructions: `How useful is this saved lesson as training data for the current objective "${objective}"? Lesson: ${lesson}`,
        criteria: [...MEMORY_RERANK_LEVELS],
      };
    });
    const payload = await postDecideRequest({
      mode: "memory-rerank",
      messages: [
        { role: "system", content: "You are Maple-Preview inside Hemlock rating saved lessons for Dream training-data selection. Answer every score question; no prose." },
        { role: "user", content: JSON.stringify({ task: { id: task?.id || null, objective, intent: task?.intent || null }, recordCount: records.length }) },
      ],
      state: { kind: "memory-select", taskId: task?.id || null },
      questions,
      commit: false,
    });
    if (!payload) return null;
    return rerankByExpectedScore(records, payload.answers, { prefix: "mem-", levels: MEMORY_RERANK_LEVELS });
  });
}

let codingAutopilot = null;
agentOrchestrator = new AgentOrchestrator({
  kernel: agentKernel,
  commandRegistry: agentCommands,
  getTask: () => agentTask,
  setTask: (patch) => updateAgentTask(patch),
  emit: (type, status, payload, options) => {
    appendAgentEvent(type, status, payload, options);
    // Queue drain on settled tasks: completed, cancelled (terminal — cannot be
    // resumed), and blocked (the model declared a terminal kind). Parked states
    // — waiting_for_approval, waiting_for_user, paused — still hold the queue
    // because those tasks can legitimately continue. A displaced blocked task
    // keeps its checkpoint; resuming it later goes through a fresh intent.
    // plan.rejected / action.rejected also park the task blocked without a
    // task.* event — without them queued intents stranded forever.
    if (["task.completed", "task.cancelled", "task.blocked", "plan.rejected", "action.rejected"].includes(type)) {
      if (type !== "task.completed" && agentIntentQueue?.pending?.length) {
        appendAgentEvent("queue.drained_after_settle", "degraded", { settledBy: type, pending: agentIntentQueue.pending.length }, { reversible: true });
      }
      void agentIntentQueue?.notifyTaskSettled();
      // Idle-Dream proposer: if the queue just emptied and no new task
      // started, a grown findings dataset can surface a reviewable Dream
      // candidate. Propose-only — training still requires explicit approval.
      try { maybeProposeIdleDream("task-settled"); } catch { /* advisory */ }
    }
  },
  executeCommand: (command, payload) => runAgentCommand(command, payload),
  inferAction: inferStructuredAction,
  scoreActions: { decide: decideStructuredAction, score: scoreStructuredAction },
  repairCoding: (input) => codingAutopilot?.run({
    threadId: agentTask.threadId,
    taskId: agentTask.id,
    objective: agentTask.objective,
    baseChangeSetId: input.baseChangeSetId || null,
    issues: input.failedResult?.issues || input.failedResult?.verification?.issues || [],
    context: { task: agentTask, history: input.history, plan: input.plan },
  }),
  createSuggestion: (input) => {
    const existing = threadManager.listSuggestions({ threadId: input.threadId, status: "unread" }).find((item) => item.kind === input.kind);
    if (existing) return existing;
    const suggestion = threadManager.createSuggestion(input);
    appendAgentEvent("suggestion.created", "candidate", { suggestion }, { evidenceRefs: suggestion.evidenceRefs, reversible: true });
    return suggestion;
  },
  // Recent world findings for the action prompt — compact, evidence-backed,
  // and read fresh each step so Maple sees what it just learned.
  worldContext: () => experimentDatasetSummary().count
    ? readExperimentRows(8).rows.map((row) => ({
      experiment: row.experiment,
      claim: String(row.claim || "").slice(0, 200),
      divergence: Number.isFinite(row.divergence?.worst) ? Math.round(row.divergence.worst * 10000) / 100 : null,
    }))
    : null,
});

codingAutopilot = new CodingAutopilot({
  maxAttempts: 4,
  inferRepair: (repair) => agentOrchestrator.inferCodingRepair(
    agentTask,
    agentKernel.getProjection().plans.find((item) => item.id === agentTask.activePlanId) || { steps: [] },
    agentKernel.getTaskHistory(agentTask.id),
    { issues: repair.issues || [] },
    repair.attempt,
  ),
  apply: ({ threadId, source, patches, baseDigests, reason }) => runAgentCommand("code.apply", { threadId, source, patches, baseDigests, reason, __fromAgentAction: true, __approvedPlan: true, __agentActionId: `code-repair-${Date.now()}` }),
  verify: ({ threadId }) => runAgentCommand("verify", { threadId, profile: "app-build", automatic: true }),
  rollback: ({ threadId, changeSetId }) => runAgentCommand("code.rollback", { threadId, changeSetId, __fromAgentAction: true, __approvedPlan: true }),
  emit: (type, status, payload, options) => appendAgentEvent(type, status, payload, options),
});

agentIntentQueue = new AgentIntentQueue({
  getTask: () => agentTask,
  steer: (payload) => steerActiveAgentTask(payload),
  execute: (payload) => runAgentCommand("intent.submit", { ...payload, __bypassQueue: true }),
  onChange: (queue) => {
    agentKernel?.setQueueState(queue);
    // The pending list rides session state.json so queued intents survive a
    // restart; write on every queue mutation rather than only on task updates.
    writeAgentState();
    appendAgentEvent("task.queue.updated", "observed", { queue }, { reversible: true });
  },
  emit: (type, status, payload) => appendAgentEvent(type, status, payload, { reversible: true }),
});

// Pending intents persisted in the previous session's state.json come back
// as "queued" — never auto-executed on boot — and each stays individually
// cancellable through agent:queue-cancel. restorePending dedupes by
// objective and syncs the projection itself.
const restoredIntents = agentIntentQueue.restorePending(previousPendingIntents, { restoredFromSessionId: previousSessionId || null });
if (restoredIntents.length) {
  appendAgentEvent("queue.restored", "queued", {
    count: restoredIntents.length,
    restoredFromSessionId: previousSessionId || null,
    entries: restoredIntents.map((entry) => ({ id: entry.id, requestId: entry.requestId, objective: safePayload(entry.payload).objective || safePayload(entry.payload).text || "" })),
  }, { reversible: true });
}

writeAgentState();
appendAgentEvent("session.started", "ready", { sessionId, taskId: agentTask.id });
void contextBroker.refresh({ reason: shouldResumeTask ? "session-resume" : "session-start" }).catch((error) => {
  appendAgentEvent("context.refresh.failed", "failed", { error: error.message }, { reversible: true });
});
if (shouldResumeTask) {
  appendAgentEvent("task.restored", "blocked", {
    taskId: previousTask.id,
    restoredFromSessionId: previousSessionId || null,
    snapshotSessionId: previousTask.sessionId || null,
    status: agentTask.status,
    reason: agentTask.blockedReason,
  }, { evidenceRefs: [previousStatePath, ...(previousEventsPath ? [previousEventsPath] : [])].filter(Boolean), reversible: true });
  appendAgentEvent("session.resumed", "blocked", {
    previousSessionId,
    previousTaskId: previousTask.id,
    reason: agentTask.blockedReason,
  }, { evidenceRefs: previousEventsPath ? [previousEventsPath] : [], reversible: true });
}

if (parkedBootThreadIds.length) {
  appendAgentEvent("thread.parked_on_boot", "paused", {
    threadIds: parkedBootThreadIds,
    restoredFromSessionId: previousSessionId || null,
    reason: "The previous session was interrupted; inspect and resume the task.",
  }, { evidenceRefs: [threadManager.registryPath], reversible: true });
}

// Preview sessions are in-memory only (PreviewSessionManager owns no durable
// state); a session the previous journal opened without a matching stop died
// with that process. Emit a reaped marker so the replayed journal cannot
// advertise a live preview. Verification receipts under artifact roots are
// durable evidence and stay.
const orphanedPreviewSessions = [...new Set(
  agentEvents
    .filter((event) => event.type === "artifact.preview.ready")
    .map((event) => event.payload?.session?.id)
    .filter(Boolean)
    .filter((id) => !agentEvents.some((event) => event.type === "artifact.preview.stopped" && event.payload?.session?.id === id)),
)];
if (orphanedPreviewSessions.length) {
  appendAgentEvent("preview.sessions.reaped", "completed", {
    count: orphanedPreviewSessions.length,
    sessionIds: orphanedPreviewSessions,
    restoredFromSessionId: previousSessionId || null,
  }, { evidenceRefs: previousEventsPath ? [previousEventsPath] : [], reversible: true });
}

function closeAgentSession() {
  if (sessionClosed) return;
  sessionClosed = true;
  mapleHealthMonitor?.dispose();
  for (const stream of [...activeStreams.values()]) {
    stream.abortReason = "interrupted";
    stream.controller?.abort("interrupted");
    finishStream(stream, { status: "interrupted", stopReason: "session_restart" });
  }
  appendAgentEvent("session.closed", "completed", { task: agentTask, server: serverState, dreamActive: Boolean(dreamProcess), sipsCycleActive });
  writeAgentState();
}

function emitDreamProgress(progress) {
  const status = progress.status || (progress.stage?.toLowerCase().includes("fail") ? "failed" : "running");
  appendAgentEvent("dream.progress", status, progress, { evidenceRefs: progress.receiptPath ? [progress.receiptPath] : [] });
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send("dream:progress", progress);
    if (sipsCycleActive) window.webContents.send("sips:progress", progress);
  }
}

function emitSipsProgress(progress) {
  appendAgentEvent("sips.cycle.progress", progress.status || "running", progress, { evidenceRefs: progress.receiptPath ? [progress.receiptPath] : [] });
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send("sips:progress", progress);
  }
}

function appendOutput(current, chunk, limit = 14000) {
  const next = `${current}${String(chunk)}`;
  return next.length > limit ? next.slice(next.length - limit) : next;
}

// outputLimit caps each captured stream (default 14000 chars; shell.exec
// passes 32KB). appendOutput keeps the tail, so stdoutTruncated flags when
// more output arrived than the cap could hold.
function runChild(command, args, { cwd = repoRoot, timeoutMs = 120000, operationId = null, outputLimit = 14000 } = {}) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const invocation = resolveChildInvocation(command, args);
    const child = spawn(invocation.command, invocation.args, {
      cwd,
      env: pythonEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeChildren.add(child);
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    const stdoutStream = operationId ? startStream({ taskId: agentTask.id, operationId, kind: "stdout" }) : null;
    const stderrStream = operationId ? startStream({ taskId: agentTask.id, operationId, kind: "stderr" }) : null;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 1500);
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { if (stdout.length + String(chunk).length > outputLimit) stdoutTruncated = true; stdout = appendOutput(stdout, chunk, outputLimit); if (stdoutStream) { publishStreamFrame(stdoutStream, { delta: String(chunk) }); checkpointStream(stdoutStream); } });
    child.stderr.on("data", (chunk) => { if (stderr.length + String(chunk).length > outputLimit) stderrTruncated = true; stderr = appendOutput(stderr, chunk, outputLimit); if (stderrStream) { publishStreamFrame(stderrStream, { delta: String(chunk) }); checkpointStream(stderrStream); } });
    child.on("error", (error) => {
      clearTimeout(timer);
      activeChildren.delete(child);
      finishStream(stdoutStream, { status: "failed", stopReason: error.message });
      finishStream(stderrStream, { status: "failed", stopReason: error.message });
      resolve({ command: [command, ...args], cwd, exitCode: null, signal: null, timedOut, stdout, stderr: appendOutput(stderr, error.message, outputLimit), stdoutTruncated, stderrTruncated: stderrTruncated || stderr.length + String(error.message).length > outputLimit, elapsed: Math.round((Date.now() - startedAt) / 1000) });
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      activeChildren.delete(child);
      finishStream(stdoutStream, { status: exitCode === 0 ? "completed" : "failed", stopReason: signal || (exitCode === 0 ? "exit_0" : `exit_${exitCode}`) });
      finishStream(stderrStream, { status: exitCode === 0 ? "completed" : "failed", stopReason: signal || (exitCode === 0 ? "exit_0" : `exit_${exitCode}`) });
      resolve({ command: [command, ...args], cwd, exitCode, signal, timedOut, stdout, stderr, stdoutTruncated, stderrTruncated, elapsed: Math.round((Date.now() - startedAt) / 1000) });
    });
  });
}

async function runSipsRuntime(payload) {
  const result = await runChild(python, [...pythonFlags, sipsRuntimeScript, JSON.stringify({ root: repoRoot, sipsDir, ...payload })], { cwd: repoRoot, timeoutMs: 60000 });
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  let parsed = null;
  try { parsed = lines.length ? JSON.parse(lines[lines.length - 1]) : null; } catch { parsed = null; }
  if (result.exitCode !== 0 || !parsed || parsed.status === "error") {
    throw new Error(`Hemlock SIPS runtime failed: ${parsed?.error || result.stderr || `exit code ${result.exitCode ?? "-"}`}`);
  }
  return parsed;
}

const verificationProfiles = {
  "app-build": {
    label: "Hemlock UI build",
    command: "npm run build",
    executable: "npm",
    args: ["run", "build"],
    cwd: path.join(repoRoot, "dream-chat"),
    timeoutMs: 300000,
  },
  "diff-check": {
    label: "Git diff check",
    command: "git diff --check",
    executable: "git",
    args: ["diff", "--check"],
    cwd: repoRoot,
    timeoutMs: 30000,
  },
  "python-tests": {
    label: "Focused MLX tuner tests",
    command: "python -S -m pytest -q tests/test_tuner_utils.py tests/test_tuner_trainer.py",
    executable: python,
    args: [...pythonFlags, "-m", "pytest", "-q", "tests/test_tuner_utils.py", "tests/test_tuner_trainer.py"],
    cwd: repoRoot,
    timeoutMs: 300000,
  },
  "lint": {
    label: "Workspace lint",
    command: "npm run lint --if-present",
    executable: "npm",
    args: ["run", "lint", "--if-present"],
    cwd: path.join(repoRoot, "dream-chat"),
    timeoutMs: 120000,
  },
  "typecheck": {
    label: "TypeScript typecheck",
    command: "npx tsc --noEmit",
    executable: "npx",
    args: ["tsc", "--noEmit"],
    // Honest precondition: tsc only makes sense where a tsconfig.json exists.
    // runVerification records a skipped receipt instead of a bogus failure.
    requires: ["tsconfig.json"],
    cwd: path.join(repoRoot, "dream-chat"),
    timeoutMs: 120000,
  },
  "npm-test": {
    label: "Workspace npm test",
    command: "npm test",
    executable: "npm",
    args: ["test"],
    cwd: path.join(repoRoot, "dream-chat"),
    timeoutMs: 300000,
  },
};

async function runVerification(profileId, emit = null, options = {}) {
  const profile = verificationProfiles[profileId] || verificationProfiles["app-build"];
  const workspaceRoot = options.workspaceRoot && fs.existsSync(path.join(options.workspaceRoot, "package.json")) ? path.resolve(options.workspaceRoot) : profile.cwd;
  // Profile preconditions (e.g. typecheck needs tsconfig.json): an unmet
  // precondition is a skipped receipt with evidence, not a failed run.
  const missingPreconditions = (profile.requires || []).filter((relative) => !fs.existsSync(path.join(workspaceRoot, relative)));
  if (missingPreconditions.length) {
    const receipt = { schema: "hemlock.agent.verification.v1", profile: profileId in verificationProfiles ? profileId : "app-build", label: profile.label, workspaceRoot, command: profile.command, status: "skipped", reason: `profile precondition unmet: ${missingPreconditions.join(", ")} not present under ${workspaceRoot}`, exitCode: null, signal: null, timedOut: false, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false, elapsed: 0 };
    const receiptPath = path.join(runtimeDataRoot, "receipts", "verification", `${agentTask.id}-${options.operationId || Date.now()}.json`);
    writeJsonFile(receiptPath, receipt);
    receipt.receiptPath = receiptPath;
    receipt.evidenceRefs = [receiptPath];
    appendAgentEvent("verification.completed", "skipped", { profile: receipt.profile, label: receipt.label, reason: receipt.reason, receiptPath }, { evidenceRefs: receipt.evidenceRefs });
    return receipt;
  }
  appendAgentEvent("verification.started", "running", { profile: profileId, label: profile.label, command: profile.command });
  emit?.({ stage: `verifying · ${profile.label}`, progress: 24, log: profile.command });
  try {
    const result = await runChild(profile.executable, profile.args, { cwd: workspaceRoot, timeoutMs: profile.timeoutMs, operationId: options.operationId || null });
    const receipt = { schema: "hemlock.agent.verification.v1", profile: profileId in verificationProfiles ? profileId : "app-build", label: profile.label, workspaceRoot, command: profile.command, ...result };
    const receiptPath = path.join(runtimeDataRoot, "receipts", "verification", `${agentTask.id}-${options.operationId || Date.now()}.json`);
    writeJsonFile(receiptPath, receipt);
    receipt.receiptPath = receiptPath;
    receipt.evidenceRefs = [receiptPath];
    appendAgentEvent("verification.completed", result.exitCode === 0 ? "passed" : "failed", { profile: receipt.profile, label: receipt.label, exitCode: result.exitCode, timedOut: result.timedOut, receiptPath }, { evidenceRefs: receipt.evidenceRefs });
    return receipt;
  } catch (error) {
    appendAgentEvent("verification.completed", "failed", { profile: profileId, label: profile.label, error: error.message });
    throw error;
  }
}

// shell.exec: bounded argv-form subprocess against the thread's workspaceRoot.
// resolveExec (shell_exec.cjs) is the allowlist gate — no shell strings, cwd
// pinned inside the workspace, timeout capped at 60s. runChild caps each
// captured stream at EXEC_OUTPUT_LIMIT (32KB) and flags the truncation; the
// receipt is filed under receipts/exec/ like verification receipts.
async function runShellExec(payload = {}, operationId = null) {
  const workspaceRoot = path.resolve(agentTask.workspaceRoot || repoRoot);
  const resolved = resolveExec(payload, { workspaceRoot });
  const argvDisplay = [resolved.executable, ...resolved.args].map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(" ");
  const startedAt = Date.now();
  const result = await runChild(resolved.executable, resolved.args, { cwd: resolved.cwd, timeoutMs: resolved.timeoutMs, operationId, outputLimit: EXEC_OUTPUT_LIMIT });
  const receipt = {
    schema: "hemlock.agent.exec.v1",
    status: result.exitCode === 0 && !result.timedOut ? "passed" : "failed",
    argv: argvDisplay,
    executable: resolved.executable,
    args: resolved.args,
    cwd: resolved.cwd,
    workspaceRoot,
    exitCode: result.exitCode,
    signal: result.signal || null,
    timedOut: result.timedOut === true,
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutTruncated: result.stdoutTruncated === true,
    stderrTruncated: result.stderrTruncated === true,
    truncated: result.stdoutTruncated === true || result.stderrTruncated === true,
    durationMs: Math.max(0, Date.now() - startedAt),
  };
  const receiptPath = path.join(runtimeDataRoot, "receipts", "exec", `${agentTask.id}-${operationId || Date.now()}.json`);
  writeJsonFile(receiptPath, receipt);
  receipt.receiptPath = receiptPath;
  receipt.evidenceRefs = [receiptPath];
  appendAgentEvent("shell.exec.completed", receipt.status, { argv: argvDisplay, cwd: resolved.cwd, exitCode: result.exitCode, timedOut: receipt.timedOut, truncated: receipt.truncated, receiptPath }, { evidenceRefs: receipt.evidenceRefs });
  return receipt;
}

// Conversational Build flow (T6-V1): after an approved code.apply lands a
// change set, run the matched allowlisted verification profile ONCE and pin
// the result on the task so Chat can render a VERIFICATION card. Only
// allowlisted profiles can run; with no match we record an honest skip.
async function runPostApplyVerification(changeSet) {
  const changeSetId = String(changeSet?.id || "");
  if (changeSetId && agentTask.verification?.status !== "skipped" && agentTask.verification?.schema === "hemlock.agent.verification.v1" && agentTask.verification?.changeSetId === changeSetId) return;
  const appliedPaths = (Array.isArray(changeSet?.files) ? changeSet.files : []).map((file) => file?.path).filter(Boolean);
  const profiles = Object.fromEntries(Object.entries(verificationProfiles).map(([id, profile]) => [id, { label: profile.label, command: profile.command, timeoutMs: profile.timeoutMs }]));
  const choice = chooseVerificationProfile(profiles, appliedPaths);
  if (!choice) {
    updateAgentTask({ verification: skippedVerification("no matching profile") });
    appendAgentEvent("verification.ran", "skipped", { reason: "no matching profile", changeSetId }, { reversible: true });
    return;
  }
  const startedAt = Date.now();
  try {
    const receipt = await runVerification(choice.id, null, { workspaceRoot: agentTask.workspaceRoot });
    const summary = verificationSummary({ choice, receipt, durationMs: Date.now() - startedAt, changeSetId });
    updateAgentTask({ verification: summary, evidenceRefs: [...new Set([...(agentTask.evidenceRefs || []), ...(receipt.evidenceRefs || [])])] });
    appendAgentEvent("verification.ran", summary.status, { verification: summary }, { reversible: true, evidenceRefs: receipt.evidenceRefs || [] });
  } catch (error) {
    updateAgentTask({ verification: { schema: "hemlock.agent.verification.v1", status: "failed", reason: error.message, ranAt: new Date().toISOString() } });
    appendAgentEvent("verification.ran", "failed", { error: error.message, changeSetId }, { reversible: true });
  }
}

async function repoMap(payload = {}) {
  const workspaceRoot = path.resolve(payload.workspaceRoot || agentTask.workspaceRoot || repoRoot);
  const [branch, status, files] = await Promise.all([
    runChild("git", ["branch", "--show-current"], { cwd: workspaceRoot, timeoutMs: 15000 }),
    runChild("git", ["status", "--short"], { cwd: workspaceRoot, timeoutMs: 15000 }),
    runChild("git", ["ls-files"], { cwd: workspaceRoot, timeoutMs: 15000 }),
  ]);
  let fileList = files.exitCode === 0 ? files.stdout.split(/\r?\n/).filter(Boolean) : [];
  let fileSource = "git";
  if (!fileList.length && fs.existsSync(workspaceRoot)) {
    // Non-git workspaces still map — rg respects ignore files and stays bounded.
    const listed = await runChild("rg", ["--files", "--hidden", "--glob", "!.git", "--glob", "!node_modules"], { cwd: workspaceRoot, timeoutMs: 15000 });
    fileList = listed.exitCode === 0 ? listed.stdout.split(/\r?\n/).filter(Boolean) : walkFiles(workspaceRoot, () => true).slice(0, 4000).map((filePath) => path.relative(workspaceRoot, filePath));
    fileSource = listed.exitCode === 0 ? "rg" : "walk";
  }
  const dirCounts = new Map();
  for (const file of fileList) {
    const top = file.split("/")[0];
    if (top && top !== file) dirCounts.set(top, (dirCounts.get(top) || 0) + 1);
  }
  const topDirs = [...dirCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 16).map(([dir, fileCount]) => ({ dir, fileCount }));
  const keyFiles = ["package.json", "AGENTS.md", "README.md", "state.yaml", "dream-chat/package.json", "dream-chat/electron/main.cjs"]
    .filter((name) => fs.existsSync(path.join(workspaceRoot, name)));
  return {
    schema: "hemlock.sips.repo-map.v1",
    status: "ready",
    root: workspaceRoot,
    branch: branch.stdout.trim(),
    dirty: Boolean(status.stdout.trim()),
    statusShort: status.stdout.trim(),
    files: fileList.slice(0, 320),
    fileCount: fileList.length,
    fileSource,
    topDirs,
    keyFiles,
    workspaceDigest: workspaceFingerprint(workspaceRoot),
    receipts: { branch, status, files },
    summary: `Mapped ${fileList.length} ${fileSource}-listed files under ${workspaceRoot} across ${topDirs.length} top-level directories.`,
    evidenceRefs: [`repo://${workspaceRoot}`, "repo://current-worktree"],
    claimBoundary: "Repo map is a current local worktree observation; it does not imply a patch was applied or committed.",
  };
}

async function codingInference(prompt, adapterPath = "") {
  const response = await fetchWithTimeout(
    `${serverUrl}/v1/chat/completions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "default_model",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        top_p: 0.95,
        top_k: 20,
        max_tokens: 256,
        stream: false,
        ...(adapterPath ? { adapters: adapterPath } : {}),
      }),
    },
    180000,
  );
  const payload = await readResponse(response);
  if (!response.ok) {
    const detail = payload?.error?.message || payload?.error || payload?.raw || response.statusText || `HTTP ${response.status}`;
    throw new Error(`Coding comparison returned HTTP ${response.status}: ${detail}`);
  }
  const choice = payload?.choices?.[0];
  if (!choice?.message || typeof choice.message !== "object") throw new Error("Coding comparison returned no completed choice.");
  return { content: String(choice.message.content || "").trim(), reasoning: String(choice.message.reasoning || "").trim(), usage: payload.usage || null };
}

async function startServer(adapterPath = "", modelOverride = "") {
  if (serverProcess && !serverProcess.killed) return;
  const servingModelPath = modelOverride || modelPath;
  // T9-H1: validate the checkpoint BEFORE spawning so a bad selection fails
  // with a fixable message instead of a server-side 404 after boot.
  const checkpointProblem = mlxCheckpointProblem(servingModelPath);
  if (checkpointProblem) {
    throw new Error(`Model at ${servingModelPath} is not a valid MLX checkpoint (missing ${checkpointProblem}). Open Settings → Model to fix.`);
  }
  // Adopt an already-running Maple server instead of colliding with it. A
  // leftover server from a prior launch, a crashed process, or an external
  // test can hold 127.0.0.1:8080; spawning our own would then fail with
  // EADDRINUSE and surface to the user as a misleading "Failed to fetch"
  // transport error. If a healthy server already answers on the port, reuse
  // it so chat works without a restart.
  try {
    const probe = await fetchWithTimeout(`${serverUrl}/health`, {}, 1500);
    if (probe.ok) {
      // `adopted` marks a server we did not spawn: serverProcess stays null,
      // so waitForServer's "our child exited" fail-fast must not apply to it.
      // Health already answered OK; mark the process ready so the UI
      // heartbeat reflects reality instead of showing DOWN until the first
      // inference completes.
      serverState = { processReady: true, inferenceReady: false, adapterPath, adopted: true };
      console.log(`[hemlock] adopted existing Maple-Preview server on ${serverUrl}`);
      appendAgentEvent("maple.server.ready", "passed", { adopted: true, processReady: true, inferenceReady: false }, { reversible: true });
      void warmMaplePromptCache("server-ready");
      return;
    }
  } catch {
    // No server answering yet; fall through and spawn our own.
  }
  const args = [...serverArgs];
  if (modelOverride) {
    const modelFlag = args.indexOf("--model");
    if (modelFlag >= 0) args[modelFlag + 1] = modelOverride;
  }
  if (adapterPath) args.push("--adapter-path", adapterPath);
  serverProcessError = null;
  serverState = { processReady: false, inferenceReady: false, adapterPath, modelPath: servingModelPath, adopted: false };
  console.log(`[hemlock] Maple launch python=${python} architecture=${pythonArchitecture || process.arch}`);
  const child = spawnPython([...pythonFlags, serverScript, ...args], {
    cwd: repoRoot,
    env: pythonEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverProcess = child;
  child.stdout.on("data", (chunk) => {
    const text = String(chunk).trim();
    if (text) console.log(`[maple-server] ${text}`);
  });
  child.stderr.on("data", (chunk) => {
    const text = String(chunk).trim();
    if (text) console.error(`[maple-server] ${text}`);
  });
  child.once("error", (error) => {
    serverProcessError = { message: error.message, code: error.code || null };
    console.error(`[maple-server] failed to start: ${error.message}`);
    if (serverProcess === child) serverProcess = null;
  });
  child.on("exit", (code, signal) => {
    console.log(`[maple-server] exited code=${code ?? "-"} signal=${signal ?? "-"}`);
    if (serverProcess === child) {
      if (!serverState.processReady) serverProcessError = { message: `Maple server exited before readiness (code=${code ?? "-"}, signal=${signal ?? "-"}).`, code, signal };
      serverProcess = null;
      serverState = child.mapleStopRequested === true
        ? { processReady: false, inferenceReady: false, adapterPath: "" }
        : handleUnexpectedMapleExit();
    }
  });
}

// Unexpected maple death (not our own stopServer path — e.g. MLX Metal
// GPU-timeout SIGABRT): record the crash against a bounded budget. Under
// budget, fall through to the normal lazy respawn (ensure/restart on next
// use). Over budget, stop respawning and surface an honest degraded state.
function handleUnexpectedMapleExit() {
  mapleCrashTimestamps = recordCrash(mapleCrashTimestamps, Date.now());
  persistMapleRuntimeState();
  // A mid-loop task gets one bounded auto-resume after the respawn warms
  // (settleMapleRespawnResume); a second unexpected exit under the same task
  // blocks it instead of resuming forever.
  if (["running", "verifying"].includes(agentTask?.status)) {
    taskMapleExitCounts.set(agentTask.id, (taskMapleExitCounts.get(agentTask.id) || 0) + 1);
    if (taskMapleExitCounts.size > 16) taskMapleExitCounts.delete(taskMapleExitCounts.keys().next().value);
    mapleRespawnPendingResume = true;
  }
  const verdict = shouldRespawn({ crashTimestamps: mapleCrashTimestamps });
  if (verdict.respawn) return { processReady: false, inferenceReady: false, adapterPath: "" };
  serverState = { processReady: false, inferenceReady: false, adapterPath: "", crashLooped: true, crashLoopReason: verdict.reason };
  appendAgentEvent("maple.crashloop.detected", "blocked", { reason: verdict.reason, crashes: mapleCrashTimestamps.length }, { reversible: true });
  return serverState;
}

function stopServer() {
  return new Promise((resolve) => {
    if (!serverProcess || serverProcess.killed) {
      serverProcess = null;
      resolve();
      return;
    }
    const child = serverProcess;
    // Mark OUR termination intent on the child itself so its exit handler can
    // tell a deliberate stop from a real crash (SIGABRT/SIGKILL from MLX).
    child.mapleStopRequested = true;
    const timeout = setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
      serverProcess = null;
      resolve();
    }, 3000);
    child.once("exit", () => {
      clearTimeout(timeout);
      serverProcess = null;
      resolve();
    });
    child.kill("SIGTERM");
  });
}

// ── maple.warm: bounded prompt-cache warm prefill ─────────────────────────
// Server boot and thread switches evict or strand the KV prefix cache, so
// the next agent step pays a full prefill. A 1-token request carrying the
// SAME static system block the structured-action path sends re-seeds the
// shared prefix region so the first real step is cache-hot. The system block
// is registry-derived only (buildActionSystemPrompt in
// agent_orchestrator.cjs — the same builder proposeNextAction uses); the
// volatile plan/action tail lives in the user turn and is deliberately not
// warmed. Bounded: one warm in flight, >=60s between warms, and never while
// a task, stream, Dream, or SIPS run is active. Failures emit a degraded
// maple.warm.prefill event instead of throwing into the boot/switch path.
const MAPLE_WARM_COOLDOWN_MS = Math.max(60000, Number(process.env.HEMLOCK_WARM_COOLDOWN_MS || 60000));
let mapleWarmState = { lastWarmAt: 0, warmCachedTokens: null, inFlight: null };

function mapleWarmSkipReason() {
  if (serverState.processReady !== true) return "server-not-ready";
  if (activeStreams.size) return "stream-active";
  if (isActiveTask(agentTask)) return "task-active";
  if (dreamProcess || sipsCycleActive) return "dream-sips-active";
  if (agentIntentQueue?.active) return "intent-active";
  if (mapleWarmState.inFlight) return "in-flight";
  if (Date.now() - mapleWarmState.lastWarmAt < MAPLE_WARM_COOLDOWN_MS) return "cooldown";
  return null;
}

async function warmMaplePromptCache(reason = "manual") {
  const skipped = mapleWarmSkipReason();
  if (skipped) {
    appendAgentEvent("maple.warm.prefill", "skipped", { reason, skipped }, { reversible: true });
    return { schema: "hemlock.maple.warm.v1", status: "skipped", reason, skipped };
  }
  const selection = normalizeSelection({ provider: agentTask.provider, model: agentTask.model, reasoning: agentTask.reasoning });
  const { buildActionSystemPrompt } = require("./agent_orchestrator.cjs");
  const startedAt = Date.now();
  const run = (async () => {
    try {
      const response = await fetchWithTimeout(`${serverUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: resolveLocalModelPath(selection.model),
          // The warm mirrors the structured-action message shape minus the
          // plan/action tail: same system block, minimal user turn.
          messages: [
            { role: "system", content: buildActionSystemPrompt(agentCommands) },
            { role: "user", content: "Reply with exactly OK." },
          ],
          temperature: 0,
          top_p: 1,
          top_k: 0,
          max_tokens: 1,
          stream: false,
        }),
      }, Math.min(120000, inferenceTimeoutMs));
      const payload = await readResponse(response);
      // Every completed HTTP attempt starts the cooldown — a warming loop
      // that hammers a sick server is worse than one extra cold prefill.
      mapleWarmState.lastWarmAt = Date.now();
      const elapsedMs = Date.now() - startedAt;
      if (!response.ok) {
        const detail = payload?.error?.message || payload?.error || payload?.raw || response.statusText || `HTTP ${response.status}`;
        throw new Error(`warm prefill returned HTTP ${response.status}: ${detail}`);
      }
      const usage = {
        prompt_tokens: payload?.usage?.prompt_tokens ?? null,
        cached_tokens: payload?.usage?.prompt_tokens_details?.cached_tokens ?? payload?.usage?.cached_tokens ?? null,
      };
      mapleWarmState.warmCachedTokens = usage.cached_tokens;
      serverState = { ...serverState, lastWarmAt: mapleWarmState.lastWarmAt, warmCachedTokens: usage.cached_tokens };
      appendAgentEvent("maple.warm.prefill", "passed", { reason, elapsedMs, usage }, { reversible: true });
      return { schema: "hemlock.maple.warm.v1", status: "warmed", reason, elapsedMs, usage };
    } catch (error) {
      appendAgentEvent("maple.warm.prefill", "degraded", { reason, elapsedMs: Date.now() - startedAt, error: error.message }, { reversible: true });
      return { schema: "hemlock.maple.warm.v1", status: "degraded", reason, error: error.message };
    } finally {
      mapleWarmState.inFlight = null;
    }
  })();
  mapleWarmState.inFlight = run;
  return run;
}

async function waitForServer(timeoutMs = 180000, { preserveInference = false } = {}) {
  const startedAt = Date.now();
  let lastError = null;
  let attempt = 0;
  const loggedReasons = new Set();
  // T9-H1(d): exit during readiness wakes the poll sleep and throws at once.
  const exited = new Promise((resolve) => {
    if (!serverProcess || serverProcess.killed) return resolve(serverProcessError || { code: null, signal: null });
    serverProcess.once("exit", (code, signal) => resolve({ code, signal }));
  });
  while (true) {
    // serverProcessError and the live-child checks describe only a child we
    // spawned. An adopted server has no child handle, so for it the health
    // poll below alone decides readiness — and the deadline error still
    // names the last failure classification if it goes dark.
    if (serverState.adopted !== true) {
      if (serverProcessError) {
        const error = new Error(`The local Maple-Preview server failed before becoming ready: ${serverProcessError.message}`);
        Object.assign(error, serverProcessError);
        throw error;
      }
      if (!serverProcess || serverProcess.killed) {
        throw new Error("The local Maple-Preview server process exited before becoming ready.");
      }
    }
    try {
      const response = await fetchWithTimeout(`${serverUrl}/health`, {}, 5000);
      if (response.ok) {
        const wasReady = serverState.processReady === true;
        serverState = { ...serverState, processReady: true, inferenceReady: preserveInference ? serverState.inferenceReady === true : false };
        if (!wasReady) appendAgentEvent("maple.server.ready", "passed", { processReady: true, inferenceReady: serverState.inferenceReady === true }, { reversible: true });
        // Warm the shared action prefix once the server first answers; the
        // guard inside skips while a task/stream/Dream/SIPS run is in flight.
        if (!wasReady) void warmMaplePromptCache("server-ready");
        return { processReady: true, inferenceReady: serverState.inferenceReady };
      }
      lastError = new Error(`Maple-Preview health returned HTTP ${response.status}`);
      lastError.status = response.status;
    } catch (error) {
      lastError = error;
    }
    // T9-H1(b): log each distinct failure reason once, not per-poll spam.
    const classification = classifyHealthFailure(lastError);
    if (!loggedReasons.has(classification)) {
      loggedReasons.add(classification);
      console.log(`[hemlock] Maple health check waiting: ${classification} (${lastError?.message || "unknown"})`);
    }
    // T9-H1(a): capped exponential backoff via the pure helper.
    const step = nextReadinessDelay({ attempt: attempt++, startedAt, timeoutMs });
    if (step.done) break;
    const delay = new Promise((resolve) => setTimeout(resolve, Math.min(step.delayMs, Math.max(0, timeoutMs - (Date.now() - startedAt)))));
    // The child-exit wake only exists for a child we spawned; an adopted
    // server has no handle to exit, so racing `exited` would busy-poll a
    // dead port for the whole timeout.
    await (serverState.adopted === true ? delay : Promise.race([delay, exited]));
  }
  // T9-H1(c): the deadline error names the last failure classification.
  throw new Error(`The local Maple-Preview server process did not become ready (last: ${classifyHealthFailure(lastError)}): ${lastError?.message || "timeout"}.`);
}

async function launchMapleRuntime({ resetCrashLoop = false } = {}) {
  if (serverLaunchPromise) return serverLaunchPromise;
  // A user-initiated maple.launch clears the crash-loop degraded state and
  // resets the budget — a human explicitly decided to try again. Auto-recovery
  // (restartMapleRuntime) deliberately does NOT pass this flag so crashes keep
  // accumulating toward the loop verdict.
  if (resetCrashLoop) {
    mapleCrashTimestamps = [];
    persistMapleRuntimeState();
    const { crashLooped: _clearedLooped, crashLoopReason: _clearedReason, ...rest } = serverState;
    serverState = rest;
  }
  serverLaunchPromise = (async () => {
    const startedAt = Date.now();
    try {
      if (!serverProcess || serverProcess.killed) await startServer();
      await waitForServer(readinessTimeoutMs, { preserveInference: true });
      const result = createMapleLaunchResult({ server: serverState, startedAt });
      appendAgentEvent("maple.launch.completed", "passed", result, { reversible: true });
      // Background GPU warmup: fire a 1-token inference probe to compile
      // Metal shaders before the first user message arrives. This makes the
      // first real inference ~2-5s faster. The probe is best-effort — if it
      // fails (e.g. the server is loading safetensors), the user's first
      // inference pays the normal compile cost. Probe with the adapter the
      // server is actually serving so the write into serverState keeps the
      // launch adapter instead of stomping it to "".
      const warmupAdapter = serverState.adapterPath || "";
      mapleWarmupPromise = probeInference(warmupAdapter)
        .then(() => {
          if (serverState.inferenceReady === true) {
            appendAgentEvent("maple.inference.ready", "passed", { adapterPath: warmupAdapter || null, warmed: true }, { reversible: true });
          }
        })
        .catch(() => { /* warmup is best-effort */ });
      // Bounded auto-resume: an unexpected exit while a task was mid-loop
      // gets exactly one resume attempt after the respawn is warm.
      if (mapleRespawnPendingResume) {
        mapleRespawnPendingResume = false;
        void mapleWarmupPromise.then(() => settleMapleRespawnResume());
      }
      return result;
    } catch (error) {
      serverState = { ...serverState, processReady: false, inferenceReady: false };
      const result = createMapleLaunchResult({ server: serverState, startedAt, error });
      appendAgentEvent("maple.launch.failed", "failed", result, { reversible: true });
      throw error;
    } finally {
      serverLaunchPromise = null;
    }
  })();
  return serverLaunchPromise;
}

async function ensureMapleRuntime() {
  if (serverProcess && !serverProcess.killed) {
    if (!serverState.processReady) return waitForServer(readinessTimeoutMs, { preserveInference: true });
    try {
      const response = await fetchWithTimeout(`${serverUrl}/health`, {}, 5000);
      if (response.ok) return { processReady: true, inferenceReady: serverState.inferenceReady === true };
    } catch {
      // A process can remain in the child table after MLX has lost its HTTP
      // listener. The recovery path below gives it a clean restart.
    }
  } else if (serverState.adopted === true && serverState.processReady) {
    // An adopted server has no child handle; verify it by health instead of
    // treating the missing child as a reason to spawn over it.
    try {
      const response = await fetchWithTimeout(`${serverUrl}/health`, {}, 5000);
      if (response.ok) return { processReady: true, inferenceReady: serverState.inferenceReady === true };
    } catch {
      // Adopted server went dark; the recovery path below gives a clean restart.
    }
  }
  return restartMapleRuntime("Maple health check failed before inference.");
}

async function restartMapleRuntime(reason = "Maple runtime recovery requested.") {
  // Bounded auto-respawn gate: once the crash budget is spent, refuse to
  // relaunch (a poison prompt would otherwise thrash forever) and keep the
  // degraded state visible instead.
  const crashVerdict = shouldRespawn({ crashTimestamps: mapleCrashTimestamps });
  if (!crashVerdict.respawn) {
    serverState = { processReady: false, inferenceReady: false, adapterPath: "", crashLooped: true, crashLoopReason: crashVerdict.reason };
    appendAgentEvent("maple.crashloop.detected", "blocked", { reason: crashVerdict.reason, crashes: mapleCrashTimestamps.length }, { reversible: true });
    return createMapleLaunchResult({ server: serverState });
  }
  appendAgentEvent("maple.runtime.restarting", "running", { reason, cachePolicy: { size: maplePromptCacheSize, bytes: maplePromptCacheBytes, promptConcurrency: maplePromptConcurrency, decodeConcurrency: mapleDecodeConcurrency } }, { reversible: true });
  await stopServer();
  serverProcessError = null;
  serverState = { processReady: false, inferenceReady: false, adapterPath: "" };
  const result = await launchMapleRuntime();
  appendAgentEvent("maple.runtime.restarted", "passed", { reason, processReady: result.processReady, inferenceReady: result.inferenceReady }, { reversible: true });
  return result;
}

// Bounded auto-resume after an unexpected maple exit + respawn. Deferred
// past the respawn warmup so the in-flight action loop's own recovery or
// failure lands first — a loop still driving itself is never double-driven.
// The first unexpected exit under a task resumes it once; the second blocks
// the task honestly instead of resuming forever.
async function settleMapleRespawnResume() {
  await new Promise((resolve) => {
    const settle = setTimeout(resolve, 1500);
    settle.unref?.();
  });
  const task = agentTask;
  if (!agentOrchestrator || !task?.id || !["running", "verifying"].includes(task.status)) return;
  const exits = taskMapleExitCounts.get(task.id) || 0;
  if (exits >= 2) {
    agentOrchestrator.blockTask(task.id, "server restarted twice");
    return;
  }
  const projection = agentKernel.getProjection();
  const plan = projection.plans.find((item) => item.id === task.activePlanId && item.taskId === task.id);
  const history = agentKernel.getTaskHistory(task.id);
  if (!plan || plan.status !== "approved" || !history.actions.length) return;
  if (projection.operations.some((op) => op.taskId === task.id && op.status === "running")) return;
  if ([...activeStreams.values()].some((stream) => stream.taskId === task.id && !stream.terminal)) return;
  appendAgentEvent("task.resumed_after_restart", "running", { taskId: task.id, unexpectedExits: exits }, { reversible: true });
  try {
    await agentOrchestrator.resumeTask(task.id);
  } catch (error) {
    appendAgentEvent("task.resume_after_restart.failed", "degraded", { taskId: task.id, error: error.message }, { reversible: true });
  }
}

// /health polling is scoped to mid-loop tasks with a server expected to
// answer — idle sessions are never woken for health checks. A wedged-but-
// alive server is recorded against the same crash budget as a real exit and
// goes through the bounded restart path, so monitor-driven restarts are
// capped by the crash-loop verdict too.
function mapleHealthMonitorActive() {
  return ["running", "verifying"].includes(agentTask?.status)
    && (Boolean(serverProcess && !serverProcess.killed) || serverState.processReady === true);
}

function syncMapleHealthMonitor() {
  const active = mapleHealthMonitorActive();
  if (!mapleHealthMonitor) {
    if (!active) return;
    mapleHealthMonitor = createHealthMonitor({
      healthUrl: `${serverUrl}/health`,
      isActive: mapleHealthMonitorActive,
      emit: (type, status, payload) => appendAgentEvent(type, status, payload, { reversible: true }),
      onOutage: async ({ error }) => {
        mapleCrashTimestamps = recordCrash(mapleCrashTimestamps, Date.now());
        persistMapleRuntimeState();
        await restartMapleRuntime(`Maple health monitor detected an outage (${error}).`);
      },
    });
  }
  if (active) mapleHealthMonitor.start(); else mapleHealthMonitor.stop();
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // undici's default bodyTimeout (300s) aborts a response that sends no
    // data within 5 minutes — but a local model prefilling under memory
    // pressure can legitimately exceed that before its first SSE token.
    // Our AbortController (timeoutMs, default 600s) is the real watchdog;
    // disable undici's per-read timeouts for these long local streams.
    let dispatcher;
    try {
      const { Agent } = require("undici");
      dispatcher = new Agent({ bodyTimeout: 0, headersTimeout: Math.max(timeoutMs, 600000) });
    } catch {
      dispatcher = undefined;
    }
    return await fetch(url, { ...options, signal: controller.signal, ...(dispatcher ? { dispatcher } : {}) });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchMapleWithRecovery(url, options = {}, timeoutMs = inferenceTimeoutMs) {
  await ensureMapleRuntime();
  try {
    return await fetchWithTimeout(url, options, timeoutMs);
  } catch (error) {
    if (!isMapleTransportError(error)) throw error;
    await restartMapleRuntime(error.message || "Maple transport failed.");
    return fetchWithTimeout(url, options, timeoutMs);
  }
}

async function readResponse(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

function inferenceProbePayload(adapterPath = "") {
  return {
    model: "default_model",
    messages: [{ role: "user", content: "Reply with exactly OK." }],
    temperature: 0,
    top_p: 1,
    top_k: 0,
    max_tokens: 1,
    stream: false,
    ...(adapterPath ? { adapters: adapterPath } : {}),
  };
}

async function probeInference(adapterPath = "") {
  const response = await fetchWithTimeout(
    `${serverUrl}/v1/chat/completions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(inferenceProbePayload(adapterPath)),
    },
    30000,
  );
  const payload = await readResponse(response);
  if (!response.ok) {
    const detail = payload?.error?.message || payload?.error || payload?.raw || response.statusText || `HTTP ${response.status}`;
    const error = new Error(`Inference probe returned HTTP ${response.status}: ${detail}`);
    error.status = response.status;
    error.processReady = true;
    throw error;
  }
  const choice = payload?.choices?.[0];
  const message = choice?.message;
  if (!choice || !message || typeof message !== "object" || typeof payload?.usage !== "object") {
    throw new Error("Inference probe returned no completed choice; process readiness is not inference readiness.");
  }
  serverState = { ...serverState, processReady: true, inferenceReady: true, adapterPath };
  return { processReady: true, inferenceReady: true, adapterPath };
}

async function waitForInference(adapterPath = "", timeoutMs = inferenceProbeTimeoutMs) {
  const startedAt = Date.now();
  let lastError = null;
  let attempt = 0;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await probeInference(adapterPath);
    } catch (error) {
      lastError = error;
      // A rejected adapter is a deterministic failure. Retrying it would not
      // repair the adapter and would only keep the UI looking busy.
      if (adapterPath && error.status >= 400) throw error;
    }
    const step = nextReadinessDelay({ attempt: attempt++, startedAt, timeoutMs }); // T9-H1(a)
    if (step.done) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(step.delayMs, Math.max(0, timeoutMs - (Date.now() - startedAt)))));
  }
  throw new Error(`Maple-Preview inference did not become ready (last: ${classifyHealthFailure(lastError)}): ${lastError?.message || "timeout"}.`);
}

async function recoverBaseServer() {
  emitDreamProgress({ stage: "recovering Maple-Preview base server", progress: 96, elapsed: 0, log: "existing adapters and base weights are preserved" });
  await stopServer();
  await startServer();
  let processReady = false;
  let inferenceReady = false;
  let error = null;
  try {
    await waitForServer(readinessTimeoutMs);
    processReady = true;
    await waitForInference("", inferenceProbeTimeoutMs);
    inferenceReady = true;
  } catch (recoveryError) {
    error = recoveryError;
  }
  return { processReady, inferenceReady, error };
}

function recoveryDescription(recovery) {
  const process = recovery.processReady ? "ready" : "not ready";
  const inference = recovery.inferenceReady ? "verified" : "not verified";
  const detail = recovery.error ? ` (${recovery.error.message})` : "";
  return `Base Maple-Preview recovery: server process ${process}; inference ${inference}${detail}. Existing adapter files and base weights were preserved.`;
}

// Durable agent spine → Dream input. Collects the durable journals the
// kernel + session loops already write (workspaces/*/projection.jsonl,
// sessions/*/events.jsonl) and hands them to dream_train.py together with
// the live command registry and the real structured-action system prompt.
// Python rebuilds each step's host request at its own timestamp, so the
// SFT user turn is what the model actually saw. Only executed actions with
// passed observations become rows — dream_train.py enforces that filter.
function collectAgenticSpine({ maxWorkspaces = 8, maxSessions = 24, maxSteps = 96 } = {}) {
  const journalPaths = [];
  const collect = (dir, filename, cap) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries
      .filter((e) => e.isDirectory())
      .map((e) => path.join(dir, e.name, filename))
      .filter((file) => { try { return fs.existsSync(file); } catch { return false; } })
      .map((file) => { try { return { file, mtime: fs.statSync(file).mtimeMs }; } catch { return { file, mtime: 0 }; } })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, Math.max(1, cap))
      .forEach(({ file }) => journalPaths.push(file));
  };
  collect(path.join(runtimeDataRoot, "workspaces"), "projection.jsonl", maxWorkspaces);
  collect(path.join(sipsDir, "sessions"), "events.jsonl", maxSessions);
  let systemPrompt = "";
  try {
    systemPrompt = require("./agent_orchestrator.cjs").buildActionSystemPrompt(agentCommands);
  } catch {
    systemPrompt = "";
  }
  return {
    schema: "hemlock.dream.agentic-spine.v1",
    journalPaths,
    registry: agentCommands,
    systemPrompt,
    maxSteps,
  };
}

// Read-only dataset audit: same payload shape as a Dream run plus
// datasetOnly:true so dream_train.py composes the dataset and returns the
// manifest + samples without touching a checkpoint or the running server.
async function runDreamDatasetPreview(payload = {}) {
  if (dreamProcess) throw new Error("A Dream run is already in progress; try the preview again after it finishes.");
  const runId = `preview-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const trainingRoot = path.join(sipsDir, "dream-runs");
  const runDir = path.join(trainingRoot, runId);
  if (runDir === runtimeDataRoot || !runDir.startsWith(`${runtimeDataRoot}${path.sep}`)) {
    throw new Error("Dream preview output must stay inside Hemlock's local application-data directory.");
  }
  assertDreamStorage(runDir);
  fs.mkdirSync(runDir, { recursive: true });
  const input = {
    model: fs.existsSync(modelPath) ? modelPath : undefined,
    runDir,
    facts: Array.isArray(payload?.facts) ? payload.facts : [],
    conversation: Array.isArray(payload?.conversation) ? payload.conversation : [],
    examples: [...(Array.isArray(payload?.examples) ? payload.examples : []), ...experimentDatasetExamples()],
    agentic: collectAgenticSpine(),
    datasetOnly: true,
    previewSamples: Number.isFinite(payload?.samples) ? payload.samples : 8,
  };
  const output = await new Promise((resolve, reject) => {
    const child = spawnPython([...pythonFlags, path.join(__dirname, "dream_train.py"), JSON.stringify(input)], {
      env: { ...pythonEnvironment(), PYTHONUNBUFFERED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let lastEvent = null;
    let stderrTail = "";
    let rlBuffer = "";
    child.stdout.on("data", (chunk) => {
      rlBuffer += chunk.toString();
      const lines = rlBuffer.split("\n");
      rlBuffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try { lastEvent = JSON.parse(line); } catch { /* progress noise */ }
      }
    });
    child.stderr.on("data", (chunk) => { stderrTail = (stderrTail + chunk.toString()).slice(-4000); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 && lastEvent?.preview) resolve(lastEvent.preview);
      else reject(new Error(stderrTail.trim() || `dream dataset preview exited with code ${code}`));
    });
  });
  try {
    const previewPath = path.join(runDir, "dataset-preview.json");
    return { ...output, previewPath: fs.existsSync(previewPath) ? previewPath : undefined };
  } catch {
    return output;
  }
}

async function runDream(payload) {
  if (dreamProcess) throw new Error("A Dream run is already in progress.");
  if (!fs.existsSync(modelPath)) {
    throw new Error(`Dream cannot start because the Maple-Preview model was not found at ${modelPath}. Set HEMLOCK_MODEL_PATH to a local MLX model directory.`);
  }
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const trainingRoot = path.join(sipsDir, "dream-runs");
  const requestedRunDir = payload?.runDir ? path.resolve(String(payload.runDir)) : "";
  const runDir = requestedRunDir || path.join(trainingRoot, runId);
  if (runDir === runtimeDataRoot || !runDir.startsWith(`${runtimeDataRoot}${path.sep}`)) {
    throw new Error("Dream output must stay inside Hemlock's local application-data directory.");
  }
  assertDreamStorage(runDir);
  fs.mkdirSync(runDir, { recursive: true });
  const requestedProfile = String(payload?.profile || "balanced").toLowerCase();
  const profile = ["smoke", "balanced", "quality"].includes(requestedProfile) ? requestedProfile : "balanced";
  const profileIters = { smoke: 1, balanced: 4, quality: 8 }[profile];
  const input = {
    model: modelPath,
    runDir,
    facts: Array.isArray(payload?.facts) ? payload.facts : [],
    conversation: Array.isArray(payload?.conversation) ? payload.conversation : [],
    examples: [...(Array.isArray(payload?.examples) ? payload.examples : []), ...experimentDatasetExamples()],
    agentic: collectAgenticSpine(),
    profile,
    iters: Number.isFinite(payload?.iters) ? payload.iters : profileIters,
    numLayers: Number.isFinite(payload?.numLayers) ? payload.numLayers : 1,
    resume: payload?.resume === true,
    resumeFrom: typeof payload?.resumeFrom === "string" ? payload.resumeFrom : undefined,
    divergenceGuard: payload?.divergenceGuard !== false,
    maxLossMultiple: Number.isFinite(payload?.maxLossMultiple) ? payload.maxLossMultiple : undefined,
  };

  appendAgentEvent("dream.started", "running", {
    runId,
    runDir,
    profile,
    datasetRows: input.examples.length + input.facts.length + input.conversation.length,
    baseModel: modelPath,
  });
  // Idle-Dream watermark: findings appended after this run count as "new"
  // toward the next dream.proposal candidate. Recorded at run start so a
  // failed run still consumes the rows it trained on.
  writeIdleDreamState({ datasetCountAtLastDream: experimentDatasetSummary().count, lastDreamAt: Date.now() });
  // Work-notification boundary (a): standalone Dream runs announce completion.
  // When this run is nested inside a SIPS cycle (sipsCycleActive), it stays
  // silent here — the enclosing SIPS cycle emits the single user-facing
  // notification, so the user gets one ping per long job, not two.
  const dreamJobId = `dream:${runId}`;
  const dreamNotifies = !sipsCycleActive;
  if (dreamNotifies) workNotifier.onJobStarted(dreamJobId, "Dream training");
  const notifyDreamFinished = (ok, detail) => {
    if (dreamNotifies) workNotifier.onJobFinished(dreamJobId, { ok, detail });
  };
  return new Promise((resolve, reject) => {
    emitDreamProgress({ stage: "stopping Maple-Preview server before local training", progress: 4, elapsed: 0, log: "" });
    stopServer().then(() => {
      emitDreamProgress({ stage: "starting MLX fine-tuning runtime", progress: 10, elapsed: 0, log: "" });
      dreamProcess = spawnPython([...pythonFlags, path.join(__dirname, "dream_train.py"), JSON.stringify(input)], {
        cwd: repoRoot,
        env: pythonEnvironment(),
        stdio: ["ignore", "pipe", "pipe"],
      });
      const startedAt = Date.now();
      let settled = false;
      let failureStarted = false;
      let lastProgress = 10;
      let reportedAdapterPath = "";
      let trainingReceipt = null;
      let trainingReceiptPath = "";
      let stdoutBuffer = "";
      let stderrBuffer = "";
      const consume = (chunk, isError = false) => {
        const key = isError ? "stderrBuffer" : "stdoutBuffer";
        const combined = `${isError ? stderrBuffer : stdoutBuffer}${String(chunk)}`;
        const lines = combined.split(/\r?\n/);
        if (isError) stderrBuffer = lines.pop() || "";
        else stdoutBuffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let message;
          try { message = JSON.parse(line); } catch { message = { stage: line.trim(), log: line.trim() }; }
          if (typeof message.progress === "number") lastProgress = Math.max(lastProgress, message.progress);
          if (message.adapterPath) reportedAdapterPath = String(message.adapterPath);
          if (message.trainingReceipt && typeof message.trainingReceipt === "object") trainingReceipt = message.trainingReceipt;
          if (message.trainingReceiptPath) trainingReceiptPath = String(message.trainingReceiptPath);
          emitDreamProgress({ ...message, elapsed: Math.round((Date.now() - startedAt) / 1000) });
          console[isError ? "error" : "log"](`[dream] ${line}`);
        }
      };
      const flush = () => {
        if (stdoutBuffer) consume(`${stdoutBuffer}\n`);
        if (stderrBuffer) consume(`${stderrBuffer}\n`, true);
      };
      const rejectWithRecovery = async (message) => {
        if (settled || failureStarted) return;
        failureStarted = true;
        const recovery = await recoverBaseServer();
        settled = true;
        appendAgentEvent("dream.failed", "failed", { runId, runDir, error: message, recovery: { processReady: recovery.processReady, inferenceReady: recovery.inferenceReady, error: recovery.error?.message || null } }, { evidenceRefs: [runDir], reversible: true });
        notifyDreamFinished(false, message);
        reject(new Error(`${message} ${recoveryDescription(recovery)}`));
      };
      dreamProcess.stdout.on("data", (chunk) => consume(chunk));
      dreamProcess.stderr.on("data", (chunk) => consume(chunk, true));
      const heartbeat = setInterval(() => {
        emitDreamProgress({ stage: "MLX is working locally — still alive", progress: lastProgress, elapsed: Math.round((Date.now() - startedAt) / 1000), log: "" });
      }, 5000);
      dreamProcess.on("error", (error) => {
        clearInterval(heartbeat);
        flush();
        dreamProcess = null;
        void rejectWithRecovery(`Dream training could not start: ${error.message}.`);
      });
      dreamProcess.on("exit", (code, signal) => {
        clearInterval(heartbeat);
        flush();
        dreamProcess = null;
        if (settled) return;
        if (code === 0) {
          if (!trainingReceipt || trainingReceipt.baseWeightsUnchanged !== true) {
            void rejectWithRecovery("Dream completed without a verified training receipt proving that the Maple base weights were unchanged.");
            return;
          }
          const adapterPath = reportedAdapterPath || path.join(runDir, "adapters");
          emitDreamProgress({ stage: "local adapter saved — checking server process readiness", progress: 94, elapsed: Math.round((Date.now() - startedAt) / 1000), log: "" });
          // Auto-graft: restart the server WITH the trained adapter as the
          // default (--adapter-path). A bare restart plus per-request
          // `adapters` fields would pay a full model reload on every
          // base<->adapter switch because model_key includes the adapter
          // path. SIPS nested runs pass autoGraft:false and promote after
          // their own base-vs-adapter comparison instead.
          const graft = payload?.autoGraft !== false;
          void startServer(graft ? adapterPath : undefined);
          if (graft) registerGraft({ adapterPath, runId, trainingReceipt });
          waitForServer(readinessTimeoutMs).then(async (processStatus) => {
            emitDreamProgress({ stage: "server process ready — verifying adapter inference", progress: 95, elapsed: Math.round((Date.now() - startedAt) / 1000), log: "HTTP liveness is not an inference result", serverProcessReady: processStatus.processReady, inferenceReady: false });
            try {
              const inferenceStatus = await waitForInference(adapterPath, inferenceProbeTimeoutMs);
              emitDreamProgress({ stage: "Dream complete — adapter inference verified", progress: 100, elapsed: Math.round((Date.now() - startedAt) / 1000), log: "the base Maple-Preview weights remain unchanged", serverProcessReady: true, inferenceReady: true });
              settled = true;
              const receiptSummary = summarizeTrainingReceipt(trainingReceipt, adapterPath);
              const result = { adapterPath, runDir, elapsed: Math.round((Date.now() - startedAt) / 1000), processReady: processStatus.processReady, inferenceReady: inferenceStatus.inferenceReady, trainingReceipt, trainingReceiptPath, receiptSummary };
              const evidenceRefs = [trainingReceiptPath || runDir, receiptSummary.evalReceiptPath].filter(Boolean);
              appendAgentEvent("dream.completed", "passed", { runId, ...result, baseWeightsUnchanged: trainingReceipt.baseWeightsUnchanged === true }, { evidenceRefs, reversible: false });
              notifyDreamFinished(true, adapterPath);
              resolve(result);
            } catch (adapterError) {
              await rejectWithRecovery(`Dream adapter was saved at ${adapterPath}, but its local inference probe failed: ${adapterError.message}.`);
            }
          }).catch((error) => {
            void rejectWithRecovery(`Dream adapter was saved at ${adapterPath}, but the server process did not recover: ${error.message}.`);
          });
        } else {
          void rejectWithRecovery(`Dream training exited with code ${code ?? "-"}${signal ? ` (${signal})` : ""}. See the Dream log in ${runDir}.`);
        }
      });
    });
  });
}

async function ensureBaseInference() {
  try {
    await probeInference("");
    return;
  } catch {
    await stopServer();
    await startServer();
    await waitForServer(readinessTimeoutMs);
    await waitForInference("", inferenceProbeTimeoutMs);
  }
}

async function runSipsCycle(payload) {
  if (sipsCycleActive) throw new Error("A Hemlock SIPS cycle is already in progress.");
  if (dreamProcess) throw new Error("Dream training is already in progress.");
  const objective = String(payload?.objective || "").trim();
  const profileId = String(payload?.verifyProfile || "app-build");
  const requestedTrainingProfile = String(payload?.trainingProfile || "balanced").toLowerCase();
  const trainingProfile = ["smoke", "balanced", "quality"].includes(requestedTrainingProfile) ? requestedTrainingProfile : "balanced";
  const examples = Array.isArray(payload?.examples) ? payload.examples.slice(-6) : [];
  if (!objective) throw new Error("SIPS needs a concrete improvement target.");
  if (!examples.some((example) => Array.isArray(example?.messages) && example.messages.some((message) => message?.role === "assistant" && String(message.content || "").trim()))) {
    throw new Error("SIPS needs at least one completed assistant coding example in the current chat before it can train.");
  }

  const runId = `cycle-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const runDir = path.join(sipsDir, runId);
  const startedAt = Date.now();
  sipsCycleActive = true;
  fs.mkdirSync(runDir, { recursive: true });
  appendAgentEvent("sips.cycle.started", "running", { runId, objective, verifyProfile: profileId, trainingProfile, datasetExamples: examples.length, runDir });
  // Work-notification boundary (b): the SIPS cycle is the single user-facing
  // job for this whole pipeline (baseline → dataset → nested Dream run →
  // comparison), so only the cycle itself notifies; the nested runDream() call
  // suppresses its own notification while sipsCycleActive is true.
  const sipsJobId = `sips:${runId}`;
  workNotifier.onJobStarted(sipsJobId, `SIPS cycle · ${objective.slice(0, 60)}`);

  let baselineVerification = null;
  let finalVerification = null;
  let baselineModel = null;
  let training = null;
  let adapterModel = null;
  let datasetManifest = null;
  try {
    emitSipsProgress({ stage: "SIPS baseline · checking local model", progress: 5, elapsed: 0, log: "base inference is measured before training" });
    await ensureBaseInference();
    baselineModel = await codingInference(objective, "");
    baselineVerification = await runVerification(profileId, (update) => emitSipsProgress({ ...update, elapsed: Math.round((Date.now() - startedAt) / 1000) }));
    emitSipsProgress({ stage: "SIPS dataset · capturing coding episode", progress: 31, elapsed: Math.round((Date.now() - startedAt) / 1000), log: `${examples.length} conversation example(s) · candidate until verified` });
    datasetManifest = prepareTrainingDataset({
      datasetId: runId,
      examples: examples.map((example) => ({ ...example, metadata: { ...(example.metadata || {}), objective, source: "hemlock-chat" } })),
      sourceRefs: [sessionEventsPath],
    });
    training = await runDream({
      runDir,
      facts: [],
      conversation: [],
      examples: examples.map((example) => ({ ...example, metadata: { ...(example.metadata || {}), objective, source: "hemlock-chat" } })),
      // SIPS owns promotion: it compares base-vs-adapter after training and
      // decides whether the graft stays. Auto-graft is for standalone Dreams.
      autoGraft: false,
      profile: trainingProfile,
      iters: Number.isFinite(payload?.iters) ? payload.iters : undefined,
      numLayers: Number.isFinite(payload?.numLayers) ? payload.numLayers : 1,
    });
    appendAgentEvent("dataset.bound", "passed", {
      runId,
      path: datasetManifest.trainPath,
      sourceRows: training.trainingReceipt?.dataset?.sourceRows ?? examples.length,
      validationHoldout: training.trainingReceipt?.dataset?.validationHoldout === true,
    }, { evidenceRefs: [training.trainingReceiptPath || datasetManifest.trainPath], reversible: true });
    emitSipsProgress({ stage: "SIPS comparison · probing the candidate adapter", progress: 94, elapsed: Math.round((Date.now() - startedAt) / 1000), log: "base weights remain unchanged" });
    adapterModel = await codingInference(objective, training.adapterPath);
    finalVerification = await runVerification(profileId, (update) => emitSipsProgress({ ...update, progress: Math.max(96, update.progress || 96), elapsed: Math.round((Date.now() - startedAt) / 1000) }));
    const receipt = {
      schema: "hemlock.sips.cycle.v1",
      status: finalVerification.exitCode === 0 ? "candidate-ready" : "blocked",
      objective,
      runId,
      startedAt: new Date(startedAt).toISOString(),
      elapsed: Math.round((Date.now() - startedAt) / 1000),
      dataset: { ...datasetManifest, path: path.join(runDir, "data"), examples: examples.length, ...(training.trainingReceipt?.dataset || {}) },
      training: { runDir: training.runDir, adapterPath: training.adapterPath, processReady: training.processReady, inferenceReady: training.inferenceReady, profile: training.trainingReceipt?.profile || trainingProfile, receiptPath: training.trainingReceiptPath, baseWeightsUnchanged: training.trainingReceipt?.baseWeightsUnchanged === true, metrics: training.trainingReceipt?.metrics || [] },
      modelComparison: { baseline: baselineModel, candidate: adapterModel, changed: baselineModel.content !== adapterModel.content },
      qualitySignals: {
        validationHoldout: training.trainingReceipt?.dataset?.validationHoldout === true,
        finalLoss: training.trainingReceipt?.metrics?.at(-1)?.loss ?? null,
        finalValLoss: training.trainingReceipt?.metrics?.at(-1)?.valLoss ?? null,
      },
      baselineVerification,
      finalVerification,
      claimBoundary: "This receipt proves an isolated local adapter was trained, its base weights stayed unchanged, its candidate inference was compared, and the selected command was checked. It does not claim a general model-quality gain or source-code patch.",
    };
    const receiptPath = path.join(runDir, "receipt.json");
    writeJsonAtomic(receiptPath, receipt);
    await runSipsRuntime({
      action: "record",
      title: `SIPS cycle candidate · ${objective.slice(0, 72)}`,
      body: `Baseline command exited ${baselineVerification.exitCode ?? "-"}; Dream trained ${training.adapterPath}; candidate comparison changed=${receipt.modelComparison.changed}; final command exited ${finalVerification.exitCode ?? "-"}.`,
      tags: "sips,cycle,candidate,dream",
      status: "candidate",
      verifyBeforeUse: true,
      evidencePath: receiptPath,
      provenance: `Hemlock local SIPS cycle ${runId}; exact command and model receipts are in ${receiptPath}`,
    });
    const loop = await runSipsRuntime({ action: "selfloop", selfloopAction: "status" });
    if (loop.state?.status === "active") {
      await runSipsRuntime({ action: "selfloop", selfloopAction: "record", outcome: receipt.status, receiptPath });
    }
    emitSipsProgress({ stage: receipt.status === "candidate-ready" ? "SIPS cycle complete · candidate ready for review" : "SIPS cycle complete · verification blocked", progress: 100, elapsed: receipt.elapsed, log: receiptPath, receiptPath, status: receipt.status });
    appendAgentEvent("sips.cycle.completed", receipt.status === "candidate-ready" ? "passed" : "blocked", { runId, receipt, receiptPath }, { evidenceRefs: [receiptPath], reversible: true });
    // A blocked cycle (verification failed) is not a success for the user.
    workNotifier.onJobFinished(sipsJobId, {
      ok: receipt.status === "candidate-ready",
      detail: receipt.status === "candidate-ready" ? `receipt ${receiptPath}` : `verification blocked · receipt ${receiptPath}`,
    });
    return { ...receipt, receiptPath };
  } catch (error) {
    const receipt = {
      schema: "hemlock.sips.cycle.v1",
      status: "failed",
      objective,
      runId,
      elapsed: Math.round((Date.now() - startedAt) / 1000),
      baselineVerification,
      finalVerification,
      error: error.message,
      claimBoundary: "This failure receipt records the observed local failure; it is not a proof of improvement.",
    };
    const receiptPath = path.join(runDir, "receipt.json");
    writeJsonAtomic(receiptPath, receipt);
    try {
      await runSipsRuntime({ action: "record", title: `SIPS cycle failed · ${objective.slice(0, 72)}`, body: `SIPS cycle failed: ${error.message}`, tags: "sips,cycle,failure", status: "candidate", verifyBeforeUse: true, evidencePath: receiptPath, provenance: `Hemlock local SIPS failure receipt ${runId}` });
    } catch (recordError) {
      console.error(`[sips] failure receipt could not be recorded: ${recordError.message}`);
    }
    emitSipsProgress({ stage: "SIPS cycle failed", progress: 100, elapsed: receipt.elapsed, log: error.message, receiptPath, status: "failed" });
    appendAgentEvent("sips.cycle.failed", "failed", { runId, error: error.message, receiptPath }, { evidenceRefs: [receiptPath], reversible: true });
    workNotifier.onJobFinished(sipsJobId, { ok: false, detail: error.message });
    throw error;
  } finally {
    sipsCycleActive = false;
  }
}

// --- Dream receipt surfacing + idle Dream proposer (propose-only) ---------
//
// The honest subset of training-receipt.json that the Dream window and
// activity ledger render — iters actually run, the loss trajectory, dataset
// size, and the eval verdict when a dream.eval comparison exists for this
// adapter. Everything below is derived from receipts the trainer/evaluator
// wrote; nothing is synthesized.
function latestDreamEval(adapterPath = "") {
  const evalsDir = path.join(sipsDir, "evals");
  let names = [];
  try {
    names = fs.readdirSync(evalsDir).filter((name) => /^dream-eval-.*\.json$/.test(name)).sort();
  } catch {
    return null;
  }
  for (const name of [...names].reverse()) {
    const receipt = readJsonFile(path.join(evalsDir, name), null, { label: "dream-eval-receipt" });
    if (!receipt || typeof receipt !== "object") continue;
    if (adapterPath && receipt.candidateAdapterPath && receipt.candidateAdapterPath !== adapterPath) continue;
    return {
      verdict: receipt.verdict || null,
      deltas: receipt.deltas || null,
      improvedTasks: Array.isArray(receipt.improvedTasks) ? receipt.improvedTasks.length : null,
      regressedTasks: Array.isArray(receipt.regressedTasks) ? receipt.regressedTasks.length : null,
      receiptPath: path.join(evalsDir, name),
    };
  }
  return null;
}

function summarizeTrainingReceipt(trainingReceipt, adapterPath = "") {
  const metrics = Array.isArray(trainingReceipt?.metrics) ? trainingReceipt.metrics : [];
  const summary = trainingReceipt?.metricsSummary || {};
  const losses = metrics.map((item) => item?.loss).filter((value) => Number.isFinite(value));
  const firstLoss = summary.firstLoss ?? losses[0] ?? null;
  const finalLoss = summary.finalLoss ?? losses.at(-1) ?? null;
  const evalRecord = latestDreamEval(adapterPath);
  return {
    profile: trainingReceipt?.profile || null,
    iters: Number.isFinite(trainingReceipt?.iters) ? trainingReceipt.iters : (metrics.at(-1)?.step ?? null),
    numLayers: trainingReceipt?.numLayers ?? null,
    stepsObserved: summary.stepsObserved ?? metrics.length,
    firstLoss,
    finalLoss,
    bestLoss: summary.bestLoss ?? (losses.length ? Math.min(...losses) : null),
    finalValLoss: summary.finalValLoss ?? (metrics.at(-1)?.valLoss ?? null),
    lossTrend: Number.isFinite(firstLoss) && Number.isFinite(finalLoss)
      ? (finalLoss < firstLoss ? "improving" : finalLoss > firstLoss ? "regressing" : "flat")
      : null,
    nonFiniteSteps: summary.nonFiniteSteps ?? 0,
    datasetRows: trainingReceipt?.dataset?.sourceRows ?? null,
    trainRows: trainingReceipt?.dataset?.trainRows ?? null,
    validRows: trainingReceipt?.dataset?.validRows ?? null,
    validationHoldout: trainingReceipt?.dataset?.validationHoldout === true,
    adapterPath: adapterPath || trainingReceipt?.adapterPath || null,
    adapterVersion: trainingReceipt?.adapterVersion || null,
    checkpoints: Array.isArray(trainingReceipt?.checkpoints) ? trainingReceipt.checkpoints : [],
    evalVerdict: evalRecord?.verdict || null,
    evalReceiptPath: evalRecord?.receiptPath || null,
    baseWeightsUnchanged: trainingReceipt?.baseWeightsUnchanged === true,
    elapsed: trainingReceipt?.elapsed ?? null,
  };
}

// When the workspace goes quiet and the findings dataset has grown past the
// last Dream run's watermark, file ONE reviewable candidate in the ambient
// inbox. This proposer never starts training: accepting the candidate still
// routes through the normal explicit train-approval path. Cooldowns are
// durable (sips/dream-scheduler.json plus the candidates ledger for
// dismissals) so restarts cannot re-propose immediately.
// HEMLOCK_NO_IDLE_DREAM=1 disables the proposer entirely.
const IDLE_DREAM_MIN_NEW_ROWS = Math.max(1, Number(process.env.HEMLOCK_IDLE_DREAM_MIN_ROWS) || 8);
const IDLE_DREAM_COOLDOWN_MS = Math.max(60000, Number(process.env.HEMLOCK_IDLE_DREAM_COOLDOWN_MS) || 1800000);
const IDLE_DREAM_CHECK_MS = Math.max(30000, Number(process.env.HEMLOCK_IDLE_DREAM_CHECK_MS) || 300000);
const idleDreamStatePath = path.join(sipsDir, "dream-scheduler.json");

function readIdleDreamState() {
  const stored = readJsonFile(idleDreamStatePath, null, { label: "dream-scheduler-state" });
  return {
    schema: "hemlock.dream.scheduler.v1",
    datasetCountAtLastDream: Math.max(0, Number(stored?.datasetCountAtLastDream) || 0),
    lastProposalAt: Number(stored?.lastProposalAt) || 0,
    lastDreamAt: Number(stored?.lastDreamAt) || 0,
  };
}

function writeIdleDreamState(patch = {}) {
  const next = { ...readIdleDreamState(), ...patch };
  try {
    writeJsonFile(idleDreamStatePath, next);
  } catch (error) {
    console.warn(`[dream-scheduler] state write failed: ${error.message}`);
  }
  return next;
}

function openDreamProposal() {
  const candidates = agentKernel?.getProjection?.().candidates || [];
  return candidates.find((item) => item.kind === "dream-proposal" && item.status === "candidate") || null;
}

function lastDreamProposalDismissalAt() {
  const candidates = agentKernel?.getProjection?.().candidates || [];
  return candidates
    .filter((item) => item.kind === "dream-proposal" && item.status === "dismissed")
    .reduce((latest, item) => Math.max(latest, Date.parse(item.dismissedAt || item.updatedAt || 0) || 0), 0);
}

function maybeProposeIdleDream(trigger = "idle-check") {
  if (process.env.HEMLOCK_NO_IDLE_DREAM === "1") return null;
  // Every guard must hold: empty queue (no active entry and nothing
  // pending), no live task, no Dream run, no SIPS cycle, no streaming
  // inference — proposing while work is in flight would be noise.
  const quiet = !dreamProcess
    && !sipsCycleActive
    && !activeStreams.size
    && !isActiveTask(agentTask)
    && !agentIntentQueue?.active
    && !(agentIntentQueue?.pending?.length);
  if (!quiet) return null;
  const state = readIdleDreamState();
  const newRows = Math.max(0, experimentDatasetSummary().count - state.datasetCountAtLastDream);
  if (newRows < IDLE_DREAM_MIN_NEW_ROWS) return null;
  const cooldownAnchor = Math.max(state.lastProposalAt, lastDreamProposalDismissalAt());
  if (Date.now() - cooldownAnchor < IDLE_DREAM_COOLDOWN_MS) return null;
  if (openDreamProposal()) return null; // one unreviewed proposal at a time
  try {
    const candidate = agentKernel.createCandidate({
      kind: "dream-proposal",
      title: `Dream cycle ready — ${newRows} new finding${newRows === 1 ? "" : "s"} since last dream`,
      summary: `${newRows} new experiment findings were recorded since the last local Dream run. Accept to review a bounded Dream training plan; training still requires explicit approval.`,
      sourceId: "local-project",
      sourceRefs: [experimentDatasetPath],
      reason: `Idle Dream proposer (${trigger})`,
      confidence: 0.6,
    });
    writeIdleDreamState({ lastProposalAt: Date.now() });
    appendAgentEvent("dream.proposal.created", "candidate", {
      candidateId: candidate.id,
      title: candidate.title,
      newRows,
      datasetCount: experimentDatasetSummary().count,
      trigger,
    }, { evidenceRefs: [experimentDatasetPath], reversible: true });
    return candidate;
  } catch (error) {
    appendAgentEvent("dream.proposal.failed", "degraded", { error: error.message, trigger }, { reversible: true });
    return null;
  }
}

// Bounded idle check: the interval only ever calls the proposer (which
// re-checks every guard), and unref keeps it from holding the process open.
if (process.env.HEMLOCK_NO_IDLE_DREAM !== "1") {
  const idleDreamTimer = setInterval(() => {
    try { maybeProposeIdleDream("idle-timer"); } catch { /* advisory */ }
  }, IDLE_DREAM_CHECK_MS);
  idleDreamTimer.unref?.();
  setTimeout(() => {
    try { maybeProposeIdleDream("boot"); } catch { /* advisory */ }
  }, 60000).unref?.();
}

// --- Host UX (Lane B): confirm dialog, notifications, window inventory ------
//
// Pure helpers below are exported at the bottom of this file so node:test
// files can exercise them without launching Electron.

const NOTIFICATION_TITLE_MAX_LENGTH = 80;
const NOTIFICATION_BODY_MAX_LENGTH = 240;
// The renderer owns workspace window state: it persists it to localStorage
// under WINDOWS_KEY ("hemlock-os-windows-v2") in src/main.jsx, and the
// "agent:windows" handler above already documents that boundary as
// "renderer-owned". The main process keeps no authoritative copy of that
// state, so the simplest honest path for windows:list is a read-only pull:
// executeJavaScript reads the renderer's persisted snapshot and this module
// normalizes it into {windowId,label,state,zOrder} rows. Nothing is written
// back; the renderer remains the source of truth.
const WINDOWS_STORAGE_KEY = "hemlock-os-windows-v2";
const WINDOW_LABELS = {
  center: "Command Center",
  chat: "Chat / Code",
  artifact: "Artifact Studio",
  activity: "Activity",
  receipts: "Receipts",
  sips: "SIPS Control",
  memory: "Memory Garden",
  dream: "Dream Lab",
  map: "Project Map",
  settings: "Settings",
};

function clampNotificationText(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function mapConfirmChoice(response) {
  // dialog.showMessageBox resolves with the chosen button index; index 0 is
  // the confirm button, anything else (cancel/Escape/closed) is a rejection.
  return response === 0;
}

function parseWindowListSnapshot(raw) {
  let source;
  try {
    source = JSON.parse(String(raw ?? ""));
  } catch {
    return [];
  }
  const entries = Array.isArray(source)
    ? source.map((item) => [item?.windowId, item])
    : Object.entries(source && typeof source === "object" ? source : []);
  const windows = [];
  for (const [key, item] of entries) {
    if (!item || typeof item !== "object") continue;
    const windowId = String(item.windowId || key || "");
    if (!windowId) continue;
    const state = ["normal", "minimized", "maximized"].includes(item.state) ? item.state : "closed";
    if (state === "closed") continue; // closed windows are excluded by contract
    windows.push({
      windowId,
      label: WINDOW_LABELS[windowId] || windowId,
      state,
      zOrder: Math.max(0, Math.floor(Number(item.zOrder)) || 0),
    });
  }
  return windows.sort((a, b) => a.zOrder - b.zOrder || a.windowId.localeCompare(b.windowId));
}

async function readWorkspaceWindowList(contents) {
  const empty = { schema: "hemlock.window.list.v1", source: "unavailable", windows: [] };
  if (!contents || typeof contents.executeJavaScript !== "function" || contents.isDestroyed?.()) {
    return { ...empty, error: "No renderer window is available to read workspace window state from." };
  }
  try {
    const raw = await contents.executeJavaScript(`localStorage.getItem(${JSON.stringify(WINDOWS_STORAGE_KEY)})`, true);
    return { schema: "hemlock.window.list.v1", source: "renderer-localstorage", windows: parseWindowListSnapshot(raw) };
  } catch (error) {
    return { ...empty, error: `Unable to read workspace window state: ${error.message}` };
  }
}

ipcMain.handle("providers:status", () => inspectProviders());
ipcMain.handle("providers:login", (_event, provider) => openProviderLogin(String(provider || ""), "login"));
ipcMain.handle("providers:logout", (_event, provider) => openProviderLogin(String(provider || ""), "logout"));
ipcMain.handle("maple:launch", () => runAgentCommand("maple.launch"));
ipcMain.handle("dialog:pick-directory", async () => {
  const result = await dialog.showOpenDialog({
    title: "Choose a project directory for the new thread",
    properties: ["openDirectory", "createDirectory"],
    buttonLabel: "Use this folder",
  });
  if (result.canceled || !result.filePaths?.length) return { canceled: true };
  return { canceled: false, path: result.filePaths[0] };
});
ipcMain.handle("dialog:confirm", async (_event, options = {}) => {
  const message = typeof options?.message === "string" ? options.message.trim() : "";
  if (!message) throw new Error("dialog:confirm requires a non-empty message string.");
  const tone = options.tone === "danger" ? "danger" : "default";
  const confirmLabel = typeof options.confirmLabel === "string" && options.confirmLabel.trim() ? options.confirmLabel.trim() : tone === "danger" ? "Destroy" : "Confirm";
  const cancelLabel = typeof options.cancelLabel === "string" && options.cancelLabel.trim() ? options.cancelLabel.trim() : "Cancel";
  try {
    const { response } = await dialog.showMessageBox({
      type: tone === "danger" ? "warning" : "question",
      message,
      ...(typeof options.detail === "string" && options.detail.trim() ? { detail: options.detail.trim() } : {}),
      buttons: [confirmLabel, cancelLabel],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    return mapConfirmChoice(response);
  } catch (error) {
    throw new Error(`dialog:confirm failed: ${error.message}`);
  }
});
// Shared routine behind both the renderer-facing "notification:show" IPC
// channel and main-process work notifications, so every OS notification in the
// app goes through one validation + clamping path.
function showHostNotification(payload = {}) {
  try {
    const title = clampNotificationText(payload?.title, NOTIFICATION_TITLE_MAX_LENGTH);
    const body = clampNotificationText(payload?.body, NOTIFICATION_BODY_MAX_LENGTH);
    if (!title) throw new Error("notification:show requires a non-empty title string (max 80 characters).");
    const notificationOptions = { title, body };
    // Electron stamps the host app name/icon onto notifications from the app
    // bundle; make the app name explicit on macOS via the subtitle slot.
    if (process.platform === "darwin") notificationOptions.subtitle = app.name || "Hemlock";
    new Notification(notificationOptions).show();
    return { shown: true };
  } catch (error) {
    return { shown: false, error: error.message };
  }
}

ipcMain.handle("notification:show", (_event, payload = {}) => showHostNotification(payload));

// --- Work notifications (Lane B): long-running local jobs announce completion
//
// The main process spawns and supervises Dream training and SIPS cycles, so it
// is the legitimate observer of their lifecycle. The notifier below queues job
// starts and only fires an OS notification when the job ran at least the
// configured threshold (default 30s) — short jobs stay silent.
//
// FOCUS GUARD: the simplest honest version of "don't ping someone who is
// already watching" — if the main Hemlock window is focused, the completion is
// visible in the UI and the OS notification is skipped entirely. There is no
// renderer flag involved: this is a main-process-only check on
// mainWindow.isFocused(), so it needs no renderer cooperation and can never go
// stale. (A richer "renderer says the user is watching the Dream/SIPS pane"
// signal would require renderer changes, which are out of scope here.)
const workNotifier = createWorkNotifier({
  notify: (payload) => {
    if (mainWindow && typeof mainWindow.isFocused === "function" && mainWindow.isFocused()) {
      return { shown: false, skipped: "window-focused" };
    }
    return showHostNotification(payload);
  },
  config: {
    thresholdMs: Number(process.env.HEMLOCK_WORK_NOTIFY_THRESHOLD_MS) > 0
      ? Number(process.env.HEMLOCK_WORK_NOTIFY_THRESHOLD_MS)
      : undefined, // undefined falls back to the module default (30s)
  },
});

// See the Host UX comment block above for why this reads renderer-owned
// localStorage state instead of a main-process window registry.
ipcMain.handle("windows:list", () => readWorkspaceWindowList(mainWindow?.webContents));
ipcMain.handle("agent:state", () => getAgentState());
ipcMain.handle("agent:intent", (_event, payload = {}) => runAgentCommand("intent.submit", payload));
ipcMain.handle("agent:threads", (_event, payload = {}) => {
  const action = String(payload.action || "list");
  const command = action === "create" ? "thread.create" : action === "switch" ? "thread.switch" : action === "rename" ? "thread.rename" : action === "pause" ? "thread.pause" : action === "resume" ? "thread.resume" : action === "archive" ? "thread.archive" : action === "cancel" ? "thread.cancel" : "thread.list";
  return runAgentCommand(command, payload);
});
ipcMain.handle("agent:projects", (_event, payload = {}) => runAgentCommand(payload.action === "register" ? "project.register" : payload.action === "select" ? "project.select" : "project.list", payload));
ipcMain.handle("agent:suggestions", (_event, payload = {}) => runAgentCommand(payload.action === "accept" ? "suggestion.accept" : payload.action === "dismiss" ? "suggestion.dismiss" : payload.action === "snooze" ? "suggestion.snooze" : "suggestion.list", payload));
ipcMain.handle("agent:plan", (_event, payload = {}) => {
  const action = String(payload.action || "propose");
  const command = action === "approve" ? "plan.approve" : action === "reject" ? "plan.reject" : "plan.propose";
  return runAgentCommand(command, payload);
});
ipcMain.handle("agent:candidate", (_event, payload = {}) => {
  const action = String(payload.action || "create");
  const command = action === "accept" ? "candidate.accept" : action === "dismiss" ? "candidate.dismiss" : "candidate.create";
  return runAgentCommand(command, payload);
});
ipcMain.handle("agent:receipts", (_event, payload = {}) => runAgentCommand("receipts.query", payload));
ipcMain.handle("agent:sources", (_event, payload = {}) => {
  const action = String(payload.action || "get");
  if (action === "set-policy") return runAgentCommand("sources.policy", payload);
  return runAgentCommand("sources.get", payload);
});
ipcMain.handle("agent:changeset", (_event, payload = {}) => {
  const action = String(payload.action || "prepare");
  return runAgentCommand(`change.${action}`, payload);
});
ipcMain.handle("agent:task", (_event, payload = {}) => {
  const allowed = ["objective", "intent", "interactionMode", "phase", "status", "foregroundStep", "budget", "evidenceRefs", "blockedReason", "artifactRepair", "codeRepair", "autonomy"];
  const patch = Object.fromEntries(allowed.filter((key) => Object.prototype.hasOwnProperty.call(payload, key)).map((key) => [key, payload[key]]));
  return updateAgentTask(patch);
});
ipcMain.handle("agent:event", (_event, payload = {}) => {
  const allowedTypes = new Set(["prompt.submitted", "inference.started", "inference.completed", "inference.failed", "memory.recalled", "task.created"]);
  const type = String(payload.type || "");
  if (!allowedTypes.has(type)) throw new Error(`Renderer event is not allowlisted: ${type}`);
  return appendAgentEvent(type, String(payload.status || "observed"), payload.payload || {}, { source: "renderer", evidenceRefs: payload.evidenceRefs || [] });
});
// Renderer error → receipt: WindowBoundary reports render crashes through this
// channel so they land on the event spine instead of dying in the console.
// The payload is bounded and identical reports within 60s dedupe.
const rendererErrorSeen = new Map();
function recordRendererError(payload = {}) {
  const component = String(payload.component || "unknown").slice(0, 120);
  const message = String(payload.message || "renderer error").slice(0, 1000);
  const stack = String(payload.stack || "").slice(0, 2048) || null;
  const windowId = String(payload.windowId || "").slice(0, 80) || null;
  const key = `${component}|${message}`;
  const now = Date.now();
  const last = rendererErrorSeen.get(key);
  if (last && now - last < 60000) return { schema: "hemlock.renderer.error.v1", status: "deduped", component, windowId };
  rendererErrorSeen.set(key, now);
  if (rendererErrorSeen.size > 64) rendererErrorSeen.delete(rendererErrorSeen.keys().next().value);
  const event = appendAgentEvent("renderer.error", "failed", { component, message, stack, windowId }, { source: "renderer", reversible: true });
  return { schema: "hemlock.renderer.error.v1", status: "recorded", eventId: event.id, component, windowId };
}

ipcMain.handle("hemlock:renderer-error", (_event, payload = {}) => {
  try {
    return recordRendererError(payload);
  } catch (error) {
    return { schema: "hemlock.renderer.error.v1", status: "dropped", error: String(error.message || error).slice(0, 200) };
  }
});
ipcMain.handle("agent:command", (_event, payload = {}) => runAgentCommand(payload.action, payload));
ipcMain.handle("agent:artifacts", (_event, payload = {}) => {
  const action = String(payload.action || "inspect");
  return runAgentCommand(`artifact.${action}`, { ...(payload.input || {}), taskId: payload.taskId || agentTask.id });
});
ipcMain.handle("agent:preview", (_event, payload = {}) => {
  const action = String(payload.action || "inspect");
  return runAgentCommand(`artifact.preview.${action}`, { ...(payload.input || {}), taskId: payload.taskId || agentTask.id });
});
ipcMain.handle("agent:preview-report", (_event, payload = {}) => {
  const report = payload.report || payload;
  return recordPreviewReport(report);
});
ipcMain.handle("agent:queue-cancel", (_event, requestId) => agentIntentQueue?.cancelQueued(String(requestId || "")) || { status: "not_found", queue: agentIntentQueue?.snapshot() });
ipcMain.handle("agent:memory", (_event, payload = {}) => runAgentCommand("remember", payload));
ipcMain.handle("agent:windows", (_event, payload = {}) => ({
  schema: "hemlock.window.state.v1",
  status: "renderer-owned",
  action: String(payload.action || "inspect"),
  input: payload.input || {},
  claimBoundary: "Window geometry is local renderer state, not evidence of runtime completion.",
}));
ipcMain.handle("agent:cancel", (_event, taskId) => {
  abortStreamsForTask(String(taskId || agentTask.id), "cancelled");
  if (dreamProcess && !dreamProcess.killed) dreamProcess.kill("SIGTERM");
  for (const child of activeChildren) {
    if (!child.killed) child.kill("SIGTERM");
  }
  const cancelledOperations = agentKernel.cancelOperations(String(taskId || agentTask.id));
  agentOrchestrator?.cancel(String(taskId || agentTask.id));
  appendAgentEvent("task.updated", "cancelled", { reason: "cancel requested by user" }, { reversible: true });
  updateAgentTask({ status: "cancelled", phase: "stopped", foregroundStep: "Stopped by user", blockedReason: null });
  appendAgentEvent("operation.cancelled", "cancelled", { taskId: agentTask.id, operationIds: cancelledOperations }, { reversible: true });
  try {
    // Electron structured-clones IPC returns; agent state can carry
    // non-serializable values, which historically surfaced as
    // "An object could not be cloned" on this channel (see Launch.log).
    JSON.stringify(getAgentState());
    return getAgentState();
  } catch {
    return { ok: true, taskId: String(taskId || agentTask.id), status: "cancelled", timestamp: new Date().toISOString() };
  }
});
// Stream-only stop: abort in-flight model streams without cancelling the task,
// killing dream/SIPS children, or tearing down operations. This is the
// "stop this reply" affordance in Chat.
ipcMain.handle("agent:stream-cancel", (_event, payload = {}) => {
  const reason = "stopped by user";
  let stopped = 0;
  const requestedStreamId = payload.streamId ? String(payload.streamId) : null;
  for (const stream of activeStreams.values()) {
    if (stream.terminal) continue;
    if (requestedStreamId && stream.streamId !== requestedStreamId) continue;
    if (!requestedStreamId && stream.kind !== "model_text") continue;
    stream.abortReason = reason;
    stream.controller?.abort(reason);
    finishStream(stream, { status: "cancelled", stopReason: "stopped_by_user" });
    stopped += 1;
  }
  appendAgentEvent("inference.stopped", "cancelled", { stopped, streamId: requestedStreamId, scope: requestedStreamId ? "stream" : "model_text" }, { reversible: true });
  return { stopped, state: getAgentState() };
});
ipcMain.handle("dream:start", (_event, payload) => runAgentCommand("dream", payload));
ipcMain.handle("sips:cycle", (_event, payload) => runAgentCommand("cycle", payload));
ipcMain.handle("sips:command", async (_event, payload) => {
  const action = String(payload?.action || "status");
  return runAgentCommand(action, payload);
});

if (hasSingleInstanceLock) {
  app.whenReady().then(async () => {
    // Fatal runtime errors get a durable receipt before the process dies.
    // The handlers only observe — the default semantics (print to stderr,
    // then exit) are preserved explicitly so installing them changes nothing
    // about when or how the process ends.
    process.on("uncaughtException", (error) => {
      recordRuntimeError("uncaughtException", error);
      console.error(error);
      process.exit(1);
    });
    process.on("unhandledRejection", (reason) => {
      recordRuntimeError("unhandledRejection", reason);
      console.error(reason);
      process.exit(1);
    });
    if (app.isPackaged || process.env.MAPLE_AUTOSTART_SERVER === "1") {
      try {
        await startServer();
        // Adopted/spawned server: confirm readiness now so serverState is
        // true before the renderer's first getState() hydration, and the
        // maple.server.ready event lands in THIS session's journal.
        await waitForServer(readinessTimeoutMs, { preserveInference: false });
      } catch (error) {
        serverProcessError = { message: error.message, code: error.code || null };
        console.error(`[maple-server] unable to launch: ${error.message}`);
      }
    }
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  closeAgentSession();
  if (dreamProcess && !dreamProcess.killed) dreamProcess.kill("SIGTERM");
  if (serverProcess && !serverProcess.killed) serverProcess.kill("SIGTERM");
});

// Test-only exports: pure Lane B host-UX helpers plus the constants they read.
// Requiring this module in node:test is safe only with a mocked "electron"
// module and HEMLOCK_DATA_DIR pointed at a temp directory; see
// electron/host_ux_ipc.test.cjs for the harness that does exactly that.
module.exports = {
  WINDOWS_STORAGE_KEY,
  NOTIFICATION_TITLE_MAX_LENGTH,
  NOTIFICATION_BODY_MAX_LENGTH,
  clampNotificationText,
  mapConfirmChoice,
  parseWindowListSnapshot,
  readWorkspaceWindowList,
  // Work-notification wiring (Lane B): exposed so node:test files can drive
  // job boundaries without launching Electron.
  showHostNotification,
  workNotifier,
  // maple.warm seam (maple_warm.test.cjs): hold a stream open and inspect
  // warm state without standing up a real MLX server.
  __mapleWarm: {
    startStream,
    finishStream,
    state: () => mapleWarmState,
  },
};
