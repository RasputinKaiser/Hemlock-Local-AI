const { app, BrowserWindow, ipcMain, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { ContextBroker } = require("./context_broker.cjs");
const { AgentKernel } = require("./agent_kernel.cjs");
const { AgentOrchestrator } = require("./agent_orchestrator.cjs");
const { AgentIntentQueue, isActiveTask } = require("./agent_queue.cjs");
const { DEFAULT_BUDGET, mergeBudget, compactObservation } = require("./agent_contracts.cjs");
const { ThreadManager, DEFAULT_PROVIDER_CAPS, workspaceFingerprint } = require("./thread_manager.cjs");
const { CodingWorkspace } = require("./coding_workspace.cjs");
const { CodingAutopilot } = require("./coding_autopilot.cjs");
const { ContextSourceRegistry } = require("./context_sources.cjs");
const { ArtifactRegistry } = require("./artifact_registry.cjs");
const { PreviewSessionManager } = require("./preview_policy.cjs");
const { Utf8SseParser, parseSsePayload, extractModelChannels, extractModelDelta, compactModelPayload, selectStructuredActionText, streamStateSnapshot, createStreamId, digest: streamDigest } = require("./stream_protocol.cjs");
const { createStreamFrameCoalescer } = require("./stream_dispatcher.cjs");
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
const { verifyArtifactSource, verifyPreviewReport } = require("./artifact_verifier.cjs");

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
const modelPath = modelCandidates.find((candidate) => fs.existsSync(candidate)) || modelCandidates[0];
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
  fs.writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`, "utf-8");
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
      `Dream is blocked by storage pressure: ${Math.round(storage.freeBytes / 1024 ** 3)} GiB free, ` +
      `but Hemlock requires at least ${Math.round(minimumDreamFreeBytes / 1024 ** 3)} GiB. ` +
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
  ? Math.max(4096, requestedMapleMaxTokens)
  : 16384;
const maplePromptCacheSize = Number.isInteger(Number(process.env.HEMLOCK_MAPLE_PROMPT_CACHE_SIZE))
  ? Math.max(1, Math.min(10, Number(process.env.HEMLOCK_MAPLE_PROMPT_CACHE_SIZE)))
  : 4;
const maplePromptCacheBytes = String(process.env.HEMLOCK_MAPLE_PROMPT_CACHE_BYTES || "512M");
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
];
const serverUrl = "http://127.0.0.1:8080";
const readinessTimeoutMs = 180000;
const inferenceProbeTimeoutMs = 180000;
// Maple can spend several minutes on a short visible response because its
// reasoning channel is emitted before content. Do not mistake that honest
// latency for an empty response; cancellation and steering still abort the
// active request immediately.
const inferenceTimeoutMs = Math.max(30000, Number(process.env.HEMLOCK_INFERENCE_TIMEOUT_MS || 600000));

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

  const url = isDev
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
}

let serverProcess = null;
let mainWindow = null;
let serverProcessError = null;
let dreamProcess = null;
let sipsCycleActive = false;
const activeChildren = new Set();
let serverState = { processReady: false, inferenceReady: false, adapterPath: "" };
let serverLaunchPromise = null;
let agentInferenceEndpoint = serverUrl;
const providerStatusCache = new Map();
const activeStreams = new Map();
const streamRing = new Map();
const STREAM_RING_LIMIT = 240;
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
const readJsonFile = (filePath, fallback) => {
  try { return JSON.parse(fs.readFileSync(filePath, "utf-8")); } catch { return fallback; }
};
const readEventLog = (filePath) => {
  if (!filePath) return [];
  try {
    return fs.readFileSync(filePath, "utf-8").split(/\r?\n/).filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  } catch { return []; }
};
const previousTask = previousStatePath ? readJsonFile(previousStatePath, {}).task : null;
const shouldResumeTask = previousTask && ["accepted", "planning", "running", "waiting_for_approval", "verifying", "blocked"].includes(previousTask.status);
const threadManager = new ThreadManager({ root: runtimeDataRoot, defaultWorkspaceRoot: previousTask?.workspaceRoot || repoRoot, providerCaps: DEFAULT_PROVIDER_CAPS });
const restoredThread = previousTask?.threadId ? threadManager.thread(previousTask.threadId) : null;
const defaultThread = restoredThread || threadManager.ensureDefaultThread({ workspaceRoot: previousTask?.workspaceRoot || repoRoot, task: previousTask });
const sessionId = `session-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
const sessionDir = path.join(sessionsDir, sessionId);
const sessionEventsPath = path.join(sessionDir, "events.jsonl");
const sessionStatePath = path.join(sessionDir, "state.json");
const agentEvents = readEventLog(previousEventsPath).slice(-120);
const agentEventIds = new Set(agentEvents.map((event) => event.id).filter(Boolean));
let sessionClosed = false;
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
  blockedReason: shouldResumeTask ? `Hemlock restarted during the previous ${previousSessionId} session; no operation was resumed automatically.` : null,
  artifactRepair: shouldResumeTask ? (previousTask.artifactRepair || { attempt: 0, maxAttempts: 2, baseRevision: null, candidateRevision: null, lastGoodRevision: null, issues: [], status: "idle" }) : { attempt: 0, maxAttempts: 2, baseRevision: null, candidateRevision: null, lastGoodRevision: null, issues: [], status: "idle" },
  codeRepair: shouldResumeTask ? (previousTask.codeRepair || { attempt: 0, maxAttempts: 2, baseChangeSetId: null, candidateChangeSetId: null, lastGoodChangeSetId: null, issues: [], status: "idle" }) : { attempt: 0, maxAttempts: 2, baseChangeSetId: null, candidateChangeSetId: null, lastGoodChangeSetId: null, issues: [], status: "idle" },
  metrics: shouldResumeTask ? (previousTask.metrics || { inferenceCalls: 0, repairCalls: 0, previewWaitMs: 0, artifactRevisionCount: 0 }) : { inferenceCalls: 0, repairCalls: 0, previewWaitMs: 0, artifactRevisionCount: 0 },
  startedAt: shouldResumeTask ? (previousTask.startedAt || new Date().toISOString()) : new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

fs.mkdirSync(sessionDir, { recursive: true });

let agentKernel = new AgentKernel({ root: runtimeDataRoot, repoRoot, task: agentTask });
let agentOrchestrator = null;
let agentIntentQueue = null;

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
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
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

function awaitPreviewReport(session, timeoutMs = 8000) {
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
  const tempPath = `${sessionStatePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(agentTask, null, 2)}\n`, "utf-8");
  fs.renameSync(tempPath, sessionStatePath);
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
  agentEvents.push(event);
  if (agentEvents.length > 160) agentEvents.shift();
  fs.appendFileSync(sessionEventsPath, `${JSON.stringify(event)}\n`, "utf-8");
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
      });
    } catch (checkpointError) {
      console.warn(`[hemlock] checkpoint skipped: ${checkpointError.message}`);
    }
  }
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send("agent:event", event);
  return event;
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
  const bytes = Buffer.byteLength(JSON.stringify(stream.channels), "utf8");
  if (!force && now - stream.lastCheckpointAt < 750 && bytes - stream.lastCheckpointBytes < 2048) return;
  stream.lastCheckpointAt = now;
  stream.lastCheckpointBytes = bytes;
  appendAgentEvent(stream.kind === "model_text" ? "inference.stream.checkpoint" : "operation.output.checkpoint", "checkpoint", {
    streamId: stream.streamId,
    operationId: stream.operationId,
    kind: stream.kind,
    sequence: stream.sequence - 1,
    digest: streamDigest(JSON.stringify(stream.channels)),
    bytes,
    channels: streamChannelRecords(stream).map(({ name, digest, text }) => ({ name, digest, tail: text.slice(-2400) })),
  }, { reversible: true });
}

function startStream({ taskId = agentTask.id, operationId = null, kind = "model_text", provider = "maple" } = {}) {
  const stream = { streamId: createStreamId(kind), taskId, operationId, kind, provider, sequence: 0, text: "", channels: {}, terminal: false, startedAt: Date.now(), lastCheckpointAt: Date.now(), lastCheckpointBytes: 0, controller: null, abortReason: null, frameCoalescer: null };
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
  agentTask = { ...agentTask, ...patch, updatedAt: new Date().toISOString() };
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
    events: agentEvents.slice(-80),
    commands: Object.entries(agentCommands).map(([id, descriptor]) => ({ id, ...descriptor })),
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
    objective: text.slice(0, 1000),
    intent,
    interactionMode,
    threadId: thread?.id || null,
    projectId: thread?.projectId || null,
    workspaceRoot: thread?.workspaceRoot || repoRoot,
    autonomy: payload.autonomy || thread?.autonomy || "bounded-local",
    phase: "recall",
    status: "accepted",
    foregroundStep: "Recall scoped context and prepare a bounded plan",
    budget: mergeBudget(DEFAULT_BUDGET),
    steering: [],
    provider: selection.provider,
    model: selection.model || null,
    reasoning: selection.reasoning,
    evidenceRefs: [],
    blockedReason: null,
    artifactRepair: { attempt: 0, maxAttempts: 2, baseRevision: null, candidateRevision: null, lastGoodRevision: null, issues: [], status: "idle" },
    codeRepair: { attempt: 0, maxAttempts: 2, baseChangeSetId: null, candidateChangeSetId: null, lastGoodChangeSetId: null, issues: [], status: "idle" },
    metrics: { inferenceCalls: 0, repairCalls: 0, previewWaitMs: 0, artifactRevisionCount: 0 },
    startedAt: new Date().toISOString(),
  });
  threadManager.checkpoint(agentTask.threadId, { taskId: taskId, phase: "conversation", status: "accepted", reason: "intent-accepted", provider: selection.provider, model: selection.model, reasoning: selection.reasoning, autonomyPolicy: agentTask.autonomy });
  appendAgentEvent("task.created", "accepted", { task: agentTask, source: payload.source || "command-center" });
  appendAgentEvent("prompt.submitted", "received", { content: text.slice(0, 500), intent, interactionMode, source: payload.source || "command-center" });
  threadManager.appendConversation(agentTask.threadId, { role: "user", content: text, provider: selection.provider, model: selection.model, reasoning: selection.reasoning });

  let context = null;
  try {
    context = await contextBroker.refresh({ reason: "intent", task: agentTask });
  } catch (error) {
    appendAgentEvent("context.refresh.failed", "degraded", { error: error.message, reason: "intent" }, { reversible: true });
  }

  let recall = { schema: "hemlock.agent.recall.v1", status: "unavailable", records: [], reason: "SIPS memory was not queried." };
  try {
    recall = await runSipsRuntime({ action: "recall", query: text, limit: 6 });
    appendAgentEvent("memory.recalled", "passed", { query: text, count: recall.records?.length || 0, records: recall.records || [] }, { evidenceRefs: [path.join(sipsDir, "memory.jsonl")] });
  } catch (error) {
    appendAgentEvent("memory.recall.failed", "degraded", { query: text, error: error.message }, { reversible: true });
  }

  updateAgentTask({
    phase: intent === "conversation" ? "work" : "plan",
    status: intent === "conversation" ? "running" : "planning",
    foregroundStep: intent === "conversation" ? `${selection.label} is answering from the selected Hemlock lane` : "Choose the next bounded action from context and evidence",
    evidenceRefs: [...new Set([...(agentTask.evidenceRefs || []), ...(context?.evidenceRefs || []), ...(recall?.evidenceRefs || [])])],
  });

  // Casual conversation is a first-class local interaction, not a coding plan.
  // It still receives a durable task and command receipt, but it should not
  // force the user through a plan-approval ceremony for “hey, how are ya?”.
  if (intent === "conversation" && payload.directChat !== false) {
    const messages = Array.isArray(payload.messages) && payload.messages.length
      ? payload.messages.map((message) => ({ role: message.role, content: String(message.content || "") })).filter((message) => ["system", "user", "assistant"].includes(message.role) && message.content)
      : [{ role: "user", content: text }];
    const inference = await runInference({
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
    const choice = inference.payload?.choices?.[0]?.message || {};
    // Streaming responses carry text in ordered deltas, not in the final SSE
    // chunk's `message` field. Use the durable inference answer assembled by
    // the host so a successful live response is not rendered as empty.
    const answer = String(inference.answer || choice.content || "").trim();
    const conversation = {
      schema: "hemlock.agent.conversation.response.v1",
      requestId: payload.requestId || null,
      taskId: agentTask.id,
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
    content: content.slice(0, 1000),
    source: payload.source || "command-center",
    createdAt: new Date().toISOString(),
    status: "accepted",
  };
  const history = [...(agentTask.steering || []), steering].slice(-12);
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
  if (selection.provider === "maple" && taskId === agentTask.id && agentTask.threadId) {
    const existing = threadManager.listSuggestions({ threadId: agentTask.threadId, status: "unread" }).find((item) => item.kind === "provider-escalation");
    if (!existing) {
      const suggestion = threadManager.createSuggestion({
        threadId: agentTask.threadId,
        projectId: agentTask.projectId,
        kind: "provider-escalation",
        title: "Maple-Preview needs a provider decision",
        summary: "The selected local Maple lane did not produce a usable response.",
        reason: detail,
        evidenceRefs: rawOutputRef ? [rawOutputRef] : [],
        recommendedAction: { command: "task.escalate-provider", providers: ["codex", "claude"], requiresUserAction: true },
      });
      appendAgentEvent("suggestion.created", "candidate", { suggestion }, { evidenceRefs: suggestion.evidenceRefs, reversible: true });
    }
  }
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
    const rawOutputRef = persistModelOutput({ taskId, operationId: payload.operationId || null, streamId: stream.streamId, mode: `${mode}-failed`, provider: selection.provider, channels: stream.channels, rawPayload: { stderr: stderr.slice(-4000), exitCode: processResult.exitCode } });
    finishStream(stream, { status: "failed", stopReason: error.message, rawOutputRef });
    error.rawOutputRef = rawOutputRef;
    recordCliInferenceFailure(error, { taskId, selection, mode, startedAt, rawOutputRef, streamId: stream.streamId, channels: stream.channels });
    throw error;
  }
  if (!stream.text.trim()) {
    const error = new Error(`${selection.label} returned no final response.`);
    const rawOutputRef = persistModelOutput({ taskId, operationId: payload.operationId || null, streamId: stream.streamId, mode: `${mode}-empty`, provider: selection.provider, channels: stream.channels, rawPayload: { stderr: stderr.slice(-4000), exitCode: processResult.exitCode } });
    finishStream(stream, { status: "failed", stopReason: error.message, rawOutputRef });
    error.rawOutputRef = rawOutputRef;
    recordCliInferenceFailure(error, { taskId, selection, mode, startedAt, rawOutputRef, streamId: stream.streamId, channels: stream.channels });
    throw error;
  }
  const rawOutputRef = persistModelOutput({ taskId, operationId: payload.operationId || null, streamId: stream.streamId, mode, provider: selection.provider, channels: stream.channels, rawPayload: { stderr: stderr.slice(-4000), exitCode: processResult.exitCode, usage } });
  finishStream(stream, { status: "completed", stopReason: "provider_cli_completed", usage, rawOutputRef });
  const answer = stream.text.trim();
  const channels = modelChannelRecords(stream.channels, selection.provider);
  const telemetry = {
    provider: selection.provider,
    model: selection.model || "provider-default",
    reasoning: selection.reasoning,
    elapsedMs: Date.now() - startedAt,
    finishReason: "provider_cli_completed",
    promptTokens: usage?.input_tokens ?? usage?.prompt_tokens ?? null,
    completionTokens: usage?.output_tokens ?? usage?.completion_tokens ?? null,
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

async function runInference(payload = {}) {
  const initialMessages = compactInferenceMessages(payload.messages);
  const selection = normalizeSelection({ provider: payload.provider || payload.modelProvider || agentTask.provider, model: payload.model || agentTask.model, reasoning: payload.reasoning || agentTask.reasoning });
  if (!payload.__providerLease) {
    return threadManager.withProvider(selection.provider, payload.threadId || payload.taskId || agentTask.threadId || agentTask.id, (lease) => runInference({ ...payload, __providerLease: true }, { __providerLease: true }).then((result) => {
      if (lease.queuedMs) bumpAgentMetrics({ providerWaitMs: lease.queuedMs });
      return result;
    }));
  }
  if (selection.provider !== "maple") return runCliInference({ ...payload, messages: initialMessages }, selection, { mode: "conversation" });
  const requestedAdapter = String(payload.adapterPath || "");
  const endpoint = String(payload.apiBase || serverUrl).replace(/\/$/, "");
  const startedAt = Date.now();
  let messages = initialMessages;
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
  while (true) {
    const controller = new AbortController();
    stream.controller = controller;
    const timeoutHandle = setTimeout(() => controller.abort("timeout"), inferenceTimeoutMs);
    try {
      const base = {
        model: "default_model",
        messages,
        temperature: Number.isFinite(payload.temperature) ? payload.temperature : 0.7,
        top_p: Number.isFinite(payload.top_p) ? payload.top_p : 0.95,
        top_k: Number.isFinite(payload.top_k) ? payload.top_k : 20,
        max_tokens: Number.isFinite(payload.max_tokens) ? payload.max_tokens : mapleMaxTokens,
        stream: true,
        chat_template_kwargs: { enable_thinking: true },
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
      if (!bufferedFallback && !stream.text.trim()) {
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
      const channels = modelChannelRecords(stream.channels);
      const answerText = String(stream.channels.content || responsePayload?.choices?.[0]?.message?.content || "").trim();
      const choice = responsePayload?.choices?.[0] || {};
      const rawOutputRef = persistModelOutput({ taskId: payload.taskId || agentTask.id, operationId: payload.operationId || null, streamId: stream.streamId, mode: "conversation", channels: stream.channels, rawPayload: rawPayloads.length ? rawPayloads : responsePayload });
      finishStream(stream, { status: "completed", stopReason: finishReason, usage, rawOutputRef });
      const telemetry = {
        provider: "maple",
        model: "default_model",
        reasoning: "native",
        elapsedMs: Date.now() - startedAt,
        finishReason,
        promptTokens: usage?.prompt_tokens ?? responsePayload.usage?.prompt_tokens ?? null,
        completionTokens: usage?.completion_tokens ?? responsePayload.usage?.completion_tokens ?? null,
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
      if (!reason && isMapleTransportError(error) && mapleTransportRetries < 1 && !stream.text.trim()) {
        mapleTransportRetries += 1;
        finishStream(stream, { status: "restarting", stopReason: error.message, rawOutputRef: interruptedRawOutputRef });
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
        finishStream(stream, { status: "cancelled", stopReason: reason, rawOutputRef: interruptedRawOutputRef });
        const cancellation = new Error("Inference was cancelled before completion.");
        cancellation.code = "CANCELLED";
        throw cancellation;
      }
      finishStream(stream, { status: "failed", stopReason: error.message, rawOutputRef: interruptedRawOutputRef });
      serverState = { ...serverState, inferenceReady: false };
      updateAgentTask({ phase: "blocked", status: "blocked", blockedReason: error.message, foregroundStep: "Inference blocked; inspect the command trace" });
      appendAgentEvent("inference.failed", "failed", { error: error.message, adapterPath: requestedAdapter || null, elapsedMs: Date.now() - startedAt, streamId: stream.streamId, rawOutputRef: interruptedRawOutputRef, channels: modelChannelRecords(stream.channels) });
      throw error;
    } finally {
      clearTimeout(timeoutHandle);
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
  const receipts = files.slice(-80).reverse().map((filePath) => ({
    path: filePath,
    relativePath: path.relative(runtimeDataRoot, filePath),
    receipt: readJsonFile(filePath, null),
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
  fs.writeFileSync(patchPath, patch, "utf-8");
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
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

async function transitionChangeSet(payload = {}, transition) {
  const changeSetId = String(payload.changeSetId || "");
  const root = changeSetPath(changeSetId);
  const manifestPath = path.join(root, "manifest.json");
  const manifest = readJsonFile(manifestPath, null);
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
  fs.writeFileSync(trainPath, trainingRows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf-8");
  if (holdoutRows.length) fs.writeFileSync(validationPath, holdoutRows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf-8");
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
    return walkFiles(absolute, () => true).slice(0, 80).map((filePath) => path.relative(workspaceRoot, filePath));
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
  const maxBytes = Math.min(Math.max(Number(payload.maxBytes || 20000), 256), 50000);
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
  const result = await runChild("rg", ["--line-number", "--hidden", "--glob", "!.git", "--glob", "!node_modules", "--max-count", "40", query, target], { cwd: workspaceRoot, timeoutMs: 30000 });
  if (result.exitCode !== 0 && result.exitCode !== 1) throw new Error(result.stderr || `file.search failed with exit code ${result.exitCode}`);
  return { schema: "hemlock.agent.file.search.v1", status: "passed", query, path: path.relative(workspaceRoot, target) || ".", matches: result.stdout.split(/\r?\n/).filter(Boolean).slice(0, 120), matchCount: result.stdout.split(/\r?\n/).filter(Boolean).length, summary: `Search completed for ${JSON.stringify(query)}.`, evidenceRefs: [`repo://${workspaceRoot}`] };
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
  return { schema: "hemlock.agent.git.diff.v1", status: result.exitCode === 0 ? "passed" : "failed", diff: result.stdout.slice(0, 30000), truncated: result.stdout.length > 30000, paths, exitCode: result.exitCode, summary: result.exitCode === 0 ? "The scoped diff was read without mutation." : result.stderr || "Git diff failed.", evidenceRefs: [`git://${workspaceRoot}/diff`] };
}

function testDiscover() {
  const packageJson = readJsonFile(path.join(repoRoot, "dream-chat", "package.json"), {});
  const testFiles = walkFiles(repoRoot, (filePath) => /(?:test|spec)\.(?:cjs|js|mjs|py|tsx?|jsx?)$/i.test(filePath)).slice(0, 120).map((filePath) => path.relative(repoRoot, filePath));
  return { schema: "hemlock.agent.test.discovery.v1", status: "passed", scripts: packageJson.scripts || {}, testFiles, summary: `Discovered ${testFiles.length} local test files and ${Object.keys(packageJson.scripts || {}).length} npm scripts.`, evidenceRefs: [`repo://${repoRoot}`] };
}

function verificationList() {
  return { schema: "hemlock.agent.verification.list.v1", status: "passed", profiles: Object.entries(verificationProfiles).map(([id, profile]) => ({ id, label: profile.label, command: profile.command, timeoutMs: profile.timeoutMs })), summary: "Allowlisted verification profiles are available.", evidenceRefs: ["verification://profiles"] };
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
  const receipt = readJsonFile(absolute, null);
  if (!receipt) throw new Error(`Receipt was not found or was not valid JSON: ${requested}`);
  return { schema: "hemlock.agent.receipt.inspection.v1", status: "passed", path: absolute, receipt, summary: `Inspected local receipt ${path.relative(runtimeDataRoot, absolute)}.`, evidenceRefs: [absolute] };
}

const agentCommands = {
  status: { label: "System status", capability: "read", auto: true, approval: "none", timeoutMs: 30000, countsAgainstBudget: false },
  "context.refresh": { label: "Refresh awareness context", capability: "context", auto: true, approval: "none", timeoutMs: 15000, countsAgainstBudget: false },
  "context.search": { label: "Search awareness context", capability: "context", auto: true, approval: "none", timeoutMs: 15000, countsAgainstBudget: false },
  "context.query": { label: "Query awareness context", capability: "context", auto: true, approval: "none", timeoutMs: 15000, countsAgainstBudget: false },
  "sources.get": { label: "Inspect context sources", capability: "context", auto: true, approval: "none", timeoutMs: 15000, countsAgainstBudget: false },
  "sources.policy": { label: "Change context source policy", capability: "context", auto: false, approval: "explicit", timeoutMs: 15000, countsAgainstBudget: false, reversible: true },
  routes: { label: "Discover routes", capability: "read", auto: true, approval: "none", timeoutMs: 30000, countsAgainstBudget: false },
  "repo-map": { label: "Project map", capability: "read", auto: true, approval: "none", timeoutMs: 30000, countsAgainstBudget: false },
  "repo.inspect": { label: "Inspect repository surface", capability: "read", auto: true, approval: "none", timeoutMs: 30000 },
  "file.read": { label: "Read a scoped file", capability: "read", auto: true, approval: "none", timeoutMs: 30000 },
  "file.search": { label: "Search scoped files", capability: "read", auto: true, approval: "none", timeoutMs: 30000 },
  "git.status": { label: "Inspect git status", capability: "read", auto: true, approval: "none", timeoutMs: 30000 },
  "git.diff": { label: "Inspect git diff", capability: "read", auto: true, approval: "none", timeoutMs: 30000 },
  "test.discover": { label: "Discover local tests", capability: "read", auto: true, approval: "none", timeoutMs: 30000 },
  "verification.list": { label: "List verification profiles", capability: "read", auto: true, approval: "none", timeoutMs: 15000, countsAgainstBudget: false },
  "receipt.inspect": { label: "Inspect a local receipt", capability: "read", auto: true, approval: "none", timeoutMs: 15000 },
  recall: { label: "Recall memory", capability: "read", auto: true, approval: "none", timeoutMs: 30000, countsAgainstBudget: false },
  "receipts.query": { label: "Query local receipts", capability: "read", auto: true, approval: "none", timeoutMs: 30000, countsAgainstBudget: false },
  "intent.submit": { label: "Accept a Hemlock intent", capability: "task", auto: true, approval: "none", timeoutMs: 90000, countsAgainstBudget: false },
  "thread.list": { label: "List Hemlock threads", capability: "task", auto: true, approval: "none", timeoutMs: 15000, countsAgainstBudget: false },
  "provider.capacity": { label: "Set provider concurrency caps", capability: "task", auto: false, approval: "explicit", timeoutMs: 15000, countsAgainstBudget: false, reversible: true },
  "thread.create": { label: "Create Hemlock thread", capability: "task", auto: false, approval: "explicit", timeoutMs: 30000, countsAgainstBudget: false, reversible: true },
  "thread.switch": { label: "Switch Hemlock thread", capability: "task", auto: false, approval: "explicit", timeoutMs: 30000, countsAgainstBudget: false, reversible: true },
  "thread.rename": { label: "Rename Hemlock thread", capability: "task", auto: false, approval: "explicit", timeoutMs: 15000, countsAgainstBudget: false, reversible: true },
  "thread.pause": { label: "Pause Hemlock thread", capability: "task", auto: false, approval: "explicit", timeoutMs: 15000, countsAgainstBudget: false, reversible: true },
  "thread.resume": { label: "Resume Hemlock thread", capability: "task", auto: false, approval: "explicit", timeoutMs: 30000, countsAgainstBudget: false, reversible: true },
  "thread.archive": { label: "Archive Hemlock thread", capability: "task", auto: false, approval: "explicit", timeoutMs: 15000, countsAgainstBudget: false, reversible: true },
  "thread.cancel": { label: "Cancel Hemlock thread", capability: "task", auto: false, approval: "explicit", timeoutMs: 15000, countsAgainstBudget: false, reversible: true },
  "project.list": { label: "List Hemlock projects", capability: "context", auto: true, approval: "none", timeoutMs: 15000, countsAgainstBudget: false },
  "project.register": { label: "Register project directory", capability: "context", auto: false, approval: "explicit", timeoutMs: 30000, countsAgainstBudget: false, reversible: true },
  "project.select": { label: "Select project directory", capability: "context", auto: false, approval: "explicit", timeoutMs: 30000, countsAgainstBudget: false, reversible: true },
  "context.compile": { label: "Compile compact thread context", capability: "context", auto: true, approval: "none", timeoutMs: 15000, countsAgainstBudget: false },
  "task.checkpoint": { label: "Record task checkpoint", capability: "task", auto: true, approval: "none", timeoutMs: 15000, countsAgainstBudget: false },
  "task.escalate-provider": { label: "Escalate task provider", capability: "task", auto: false, approval: "explicit", timeoutMs: 30000, countsAgainstBudget: false, reversible: true },
  "suggestion.list": { label: "List Hemlock suggestions", capability: "context", auto: true, approval: "none", timeoutMs: 15000, countsAgainstBudget: false },
  "suggestion.accept": { label: "Accept Hemlock suggestion", capability: "task", auto: false, approval: "explicit", timeoutMs: 30000, countsAgainstBudget: false, reversible: true },
  "suggestion.dismiss": { label: "Dismiss Hemlock suggestion", capability: "context", auto: false, approval: "explicit", timeoutMs: 15000, countsAgainstBudget: false, reversible: true },
  "suggestion.snooze": { label: "Snooze Hemlock suggestion", capability: "context", auto: false, approval: "explicit", timeoutMs: 15000, countsAgainstBudget: false, reversible: true },
  "inference.respond": { label: "Run selected provider inference", capability: "inference", auto: true, approval: "none", timeoutMs: inferenceTimeoutMs, countsAgainstBudget: false },
  "plan.propose": { label: "Propose bounded plan", capability: "task", auto: true, approval: "none", timeoutMs: 30000, countsAgainstBudget: false, reversible: true },
  "plan.approve": { label: "Approve bounded plan", capability: "task", auto: false, approval: "explicit", timeoutMs: 30000, countsAgainstBudget: false, reversible: true },
  "plan.reject": { label: "Reject bounded plan", capability: "task", auto: false, approval: "explicit", timeoutMs: 30000, countsAgainstBudget: false, reversible: true },
  "task.resume": { label: "Resume approved task", capability: "task", auto: false, approval: "explicit", timeoutMs: 30000, countsAgainstBudget: false, reversible: true },
  "action.accept": { label: "Accept proposed action", capability: "task", auto: false, approval: "explicit", timeoutMs: 30000, countsAgainstBudget: false, reversible: true },
  "action.reject": { label: "Reject proposed action", capability: "task", auto: false, approval: "explicit", timeoutMs: 30000, countsAgainstBudget: false, reversible: true },
  "task.ask": { label: "Ask the user for a decision", capability: "task", auto: true, approval: "none", timeoutMs: 15000, countsAgainstBudget: false, reversible: true },
  "task.complete": { label: "Complete task", capability: "task", auto: false, approval: "explicit", timeoutMs: 15000, countsAgainstBudget: false, reversible: true },
  "task.block": { label: "Block task", capability: "task", auto: false, approval: "explicit", timeoutMs: 15000, countsAgainstBudget: false, reversible: true },
  "training.prepare": { label: "Prepare Dream dataset", capability: "training-preparation", auto: true, approval: "none", timeoutMs: 30000, countsAgainstBudget: false, reversible: true },
  "training.start": { label: "Start explicit Dream training", capability: "train", auto: false, approval: "explicit", timeoutMs: 900000 },
  "maple.launch": { label: "Launch Maple/Dream runtime", capability: "runtime", auto: false, approval: "explicit", timeoutMs: readinessTimeoutMs, countsAgainstBudget: false, reversible: true },
  verify: { label: "Run verification", capability: "verify", auto: true, approval: "none", timeoutMs: 300000 },
  "change.prepare": { label: "Prepare isolated change set", capability: "write-preparation", auto: true, approval: "none", timeoutMs: 30000, reversible: true },
  "code.inspect": { label: "Inspect assigned coding workspace", capability: "read", auto: true, approval: "none", timeoutMs: 30000 },
  "code.apply": { label: "Apply scoped coding edit", capability: "write", auto: true, approval: "plan", timeoutMs: 30000, reversible: true },
  "code.rollback": { label: "Roll back coding change set", capability: "write", auto: false, approval: "explicit", timeoutMs: 30000, reversible: true },
  "change.apply": { label: "Apply plan-approved change set", capability: "write", auto: false, approval: "plan", timeoutMs: 30000, reversible: true },
  "change.approve": { label: "Apply approved change set", capability: "write", auto: false, approval: "explicit", timeoutMs: 30000, reversible: true },
  "change.reject": { label: "Reject prepared change set", capability: "write-preparation", auto: false, approval: "explicit", timeoutMs: 30000, countsAgainstBudget: false, reversible: true },
  "candidate.create": { label: "Create review candidate", capability: "context", auto: true, approval: "none", timeoutMs: 15000, countsAgainstBudget: false, reversible: true },
  "candidate.accept": { label: "Accept review candidate", capability: "task", auto: false, approval: "explicit", timeoutMs: 15000, countsAgainstBudget: false, reversible: true },
  "candidate.dismiss": { label: "Dismiss review candidate", capability: "context", auto: false, approval: "explicit", timeoutMs: 15000, countsAgainstBudget: false, reversible: true },
  cycle: { label: "Run one SIPS cycle", capability: "train", auto: false, approval: "explicit", timeoutMs: 900000 },
  dream: { label: "Run Dream", capability: "train", auto: false, approval: "explicit", timeoutMs: 900000 },
  selfloop: { label: "Control self-loop", capability: "train", auto: false, approval: "explicit", timeoutMs: 30000 },
  "selfloop.start": { label: "Start self-loop", capability: "train", auto: false, approval: "explicit", timeoutMs: 30000 },
  "selfloop.pause": { label: "Pause self-loop", capability: "train", auto: false, approval: "explicit", timeoutMs: 30000 },
  "selfloop.resume": { label: "Resume self-loop", capability: "train", auto: false, approval: "explicit", timeoutMs: 30000 },
  "selfloop.complete": { label: "Complete self-loop", capability: "train", auto: false, approval: "explicit", timeoutMs: 30000 },
  remember: { label: "Record project lesson", capability: "memory", auto: true, approval: "none", timeoutMs: 30000 },
  "memory.promote": { label: "Promote memory candidate", capability: "memory", auto: false, approval: "explicit", timeoutMs: 30000 },
  "memory.demote": { label: "Demote project lesson", capability: "memory", auto: false, approval: "explicit", timeoutMs: 30000 },
  "memory.rollback": { label: "Rollback memory promotion", capability: "memory", auto: false, approval: "explicit", timeoutMs: 30000 },
  "artifact.create": { label: "Create task artifact", capability: "artifact", auto: true, approval: "none", timeoutMs: 30000, countsAgainstBudget: false },
  "artifact.author": { label: "Author task artifact", capability: "artifact", auto: false, approval: "explicit", timeoutMs: 30000 },
  "artifact.update": { label: "Update task artifact", capability: "artifact", auto: false, approval: "explicit", timeoutMs: 30000 },
  "artifact.restore": { label: "Restore a verified artifact revision", capability: "artifact", auto: true, approval: "none", timeoutMs: 30000, countsAgainstBudget: false },
  "artifact.repair.retry": { label: "Retry artifact repair", capability: "artifact", auto: false, approval: "explicit", timeoutMs: 120000, countsAgainstBudget: false },
  "artifact.repair.use-last-good": { label: "Use last good artifact revision", capability: "artifact", auto: false, approval: "explicit", timeoutMs: 30000, countsAgainstBudget: false },
  "artifact.inspect": { label: "Inspect task artifact", capability: "artifact", auto: true, approval: "none", timeoutMs: 30000, countsAgainstBudget: false },
  "artifact.compare": { label: "Compare artifact revisions", capability: "artifact", auto: true, approval: "none", timeoutMs: 30000, countsAgainstBudget: false },
  "artifact.freeze": { label: "Freeze artifact revision", capability: "artifact", auto: false, approval: "explicit", timeoutMs: 30000 },
  "artifact.export": { label: "Export artifact change set", capability: "artifact", auto: false, approval: "explicit", timeoutMs: 30000 },
  "artifact.preview.open": { label: "Open isolated artifact preview", capability: "preview", auto: true, approval: "none", timeoutMs: 30000, countsAgainstBudget: false },
  "artifact.preview.inspect": { label: "Inspect isolated artifact preview", capability: "preview", auto: true, approval: "none", timeoutMs: 30000, countsAgainstBudget: false },
  "artifact.preview.interact": { label: "Interact with isolated artifact preview", capability: "preview", auto: true, approval: "none", timeoutMs: 30000, countsAgainstBudget: false },
  "artifact.preview.stop": { label: "Stop isolated artifact preview", capability: "preview", auto: false, approval: "explicit", timeoutMs: 30000, countsAgainstBudget: false },
};

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
    operation = agentKernel.startOperation({ taskId: agentTask.id, command, capability: descriptor.capability, payload, descriptor });
  } catch (budgetError) {
    appendAgentEvent("command.blocked", "blocked", { command, reason: budgetError.message, code: budgetError.code || "COMMAND_BUDGET" }, { reversible: true });
    throw budgetError;
  }
  appendAgentEvent("command.started", "running", { command, capability: descriptor.capability, operationId: operation.id });
  try {
    let result;
    if (command === "intent.submit") result = await submitAgentIntent({ ...payload, operationId: payload.operationId || operation.id });
    else if (command === "thread.list") result = threadManager.snapshot();
    else if (command === "provider.capacity") result = { schema: "hemlock.agent.provider.capacity.v1", status: "updated", providerCaps: threadManager.setProviderCaps(payload.caps || payload) };
    else if (command === "thread.create") {
      const thread = threadManager.createThread(payload);
      result = { schema: "hemlock.agent.thread.result.v1", status: "created", thread, threads: threadManager.snapshot().threads };
    }
    else if (command === "thread.switch") {
      const thread = threadManager.switchThread(String(payload.threadId || ""));
      if (thread.taskSnapshot && typeof thread.taskSnapshot === "object") {
        agentTask = { ...thread.taskSnapshot, threadId: thread.id, projectId: thread.projectId, workspaceRoot: thread.workspaceRoot, provider: thread.provider, model: thread.model, reasoning: thread.reasoning, autonomy: thread.autonomy };
      } else {
        agentTask = { ...agentTask, id: thread.taskId || `task-${thread.id}`, threadId: thread.id, projectId: thread.projectId, workspaceRoot: thread.workspaceRoot, objective: thread.title, provider: thread.provider, model: thread.model, reasoning: thread.reasoning, autonomy: thread.autonomy, phase: thread.phase || "conversation", status: thread.status || "ready", blockedReason: thread.blockedReason || null };
      }
      writeAgentState();
      agentKernel.syncTask(agentTask);
      appendAgentEvent("thread.switched", "accepted", { threadId: thread.id, projectId: thread.projectId, workspaceRoot: thread.workspaceRoot }, { reversible: true });
      result = { schema: "hemlock.agent.thread.result.v1", status: "switched", thread, task: agentTask, context: compileThreadContext(thread.id), conversation: threadManager.readConversation(thread.id) };
    }
    else if (command === "thread.rename") result = { schema: "hemlock.agent.thread.result.v1", status: "renamed", thread: threadManager.updateThread(String(payload.threadId || agentTask.threadId), { title: String(payload.title || payload.name || "Hemlock thread") }) };
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
    else if (command === "thread.cancel") result = { schema: "hemlock.agent.thread.result.v1", status: "cancelled", thread: threadManager.cancelThread(String(payload.threadId || agentTask.threadId)) };
    else if (command === "project.list") result = { schema: "hemlock.agent.project.result.v1", status: "ready", projects: threadManager.snapshot().projects };
    else if (command === "project.register") result = { schema: "hemlock.agent.project.result.v1", status: "registered", project: threadManager.registerProject(payload) };
    else if (command === "project.select") {
      const project = threadManager.project(String(payload.projectId || "")) || threadManager.registerProject(payload);
      result = { schema: "hemlock.agent.project.result.v1", status: "selected", project, threads: threadManager.snapshot().threads.filter((item) => item.projectId === project.id) };
    }
    else if (command === "context.compile") result = compileThreadContext(String(payload.threadId || agentTask.threadId));
    else if (command === "task.checkpoint") result = threadManager.checkpoint(String(payload.threadId || agentTask.threadId), { ...payload, taskId: payload.taskId || agentTask.id, phase: payload.phase || agentTask.phase, status: payload.status || agentTask.status, evidenceRefs: payload.evidenceRefs || agentTask.evidenceRefs, artifactRepair: payload.artifactRepair || agentTask.artifactRepair, autonomyPolicy: payload.autonomy || agentTask.autonomy });
    else if (command === "task.escalate-provider") {
      const provider = String(payload.provider || "");
      if (!["maple", "codex", "claude"].includes(provider)) throw new Error(`Unsupported provider escalation target: ${provider}`);
      const threadId = String(payload.threadId || agentTask.threadId);
      const thread = threadManager.updateThread(threadId, { provider, model: payload.model || null, reasoning: payload.reasoning || null, status: "paused", phase: "paused", blockedReason: null });
      updateAgentTask({ provider, model: payload.model || null, reasoning: payload.reasoning || null, status: "paused", phase: "paused", foregroundStep: `Provider changed to ${provider}; resume explicitly to continue` });
      result = { schema: "hemlock.agent.provider.escalation.v1", status: "escalated", provider, thread };
    }
    else if (command === "suggestion.list") result = { schema: "hemlock.agent.suggestion.result.v1", status: "ready", suggestions: threadManager.listSuggestions({ threadId: payload.threadId || agentTask.threadId, status: payload.status }) };
    else if (["suggestion.accept", "suggestion.dismiss", "suggestion.snooze"].includes(command)) {
      const status = command.split(".")[1] === "accept" ? "accepted" : command.split(".")[1] === "dismiss" ? "dismissed" : "snoozed";
      const suggestion = threadManager.transitionSuggestion(String(payload.suggestionId || ""), status);
      result = { schema: "hemlock.agent.suggestion.result.v1", status, suggestion };
    }
    else if (command === "inference.respond") result = await runInference(payload);
    else if (command === "training.prepare") result = prepareTrainingDataset(payload);
    else if (command === "training.start") result = await runDream(payload);
    else if (command === "maple.launch") result = await launchMapleRuntime();
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
    }
    else if (command === "code.rollback") result = codingWorkspace.rollback({ threadId: payload.threadId || agentTask.threadId, changeSetId: payload.changeSetId });
    else if (command === "git.status") result = await gitStatusTool(payload);
    else if (command === "git.diff") result = await gitDiffTool(payload);
    else if (command === "test.discover") result = testDiscover();
    else if (command === "verification.list") result = verificationList();
    else if (command === "receipt.inspect") result = inspectReceipt(payload);
    else if (command === "receipts.query") result = queryReceipts(payload);
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
      const session = previewSessions.get(payload.sessionId);
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
      const authorization = previewSessions.authorize(payload.sessionId, String(payload.previewAction || payload.action || ""), payload);
      if (!authorization.allowed) {
        appendAgentEvent("artifact.interaction.blocked", "blocked", { sessionId: payload.sessionId, reason: authorization.reason, previewOnly: true }, { reversible: true });
        result = { schema: "hemlock.agent.preview.interact.v1", status: "blocked", ...authorization };
      } else {
        const interaction = previewSessions.complete(payload.sessionId, payload);
        result = { schema: "hemlock.agent.preview.interact.v1", status: "passed", authorization, interaction };
      }
    }
    else if (command === "artifact.preview.stop") result = { schema: "hemlock.agent.preview.stop.v1", status: "stopped", session: previewSessions.stop(payload.sessionId, payload.reason || "user_stopped").session };
    else if (command === "recall") {
      result = await runSipsRuntime({ action: "recall", query: payload.query, limit: payload.limit });
      appendAgentEvent("memory.recalled", "passed", { query: payload.query || "", count: result.records?.length || 0, records: result.records || [] }, { evidenceRefs: [path.join(sipsDir, "memory.jsonl")] });
    }
    else if (command === "verify") result = await runVerification(String(payload.profile || "app-build"), emitSipsProgress, { operationId: operation.id, workspaceRoot: payload.workspaceRoot || agentTask.workspaceRoot });
    else if (command === "change.prepare") result = await prepareChangeSet(payload);
    else if (command === "change.apply") {
      if (!approvedPlanAction) throw new Error("Applying a change set requires an approved Hemlock plan action.");
      result = await transitionChangeSet({ ...payload, confirm: true }, "approve");
    }
    else if (command === "change.approve") result = await transitionChangeSet(payload, "approve");
    else if (command === "change.reject") result = await transitionChangeSet(payload, "reject");
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
    else if (command === "cycle") result = await runSipsCycle(payload);
    else if (command === "dream") result = await runDream(payload);
    else if (command === "selfloop" || command.startsWith("selfloop.")) result = await runSipsRuntime({ action: "selfloop", selfloopAction: command.startsWith("selfloop.") ? command.split(".")[1] : payload.selfloopAction, focus: payload.focus, outcome: payload.outcome, receiptPath: payload.receiptPath });
    else if (command === "remember") result = await recordAgentMemory(payload);
    else if (command.startsWith("memory.")) {
      result = await runSipsRuntime({ action: "memory-transition", transition: command.split(".")[1], targetId: payload.targetId, note: payload.note, evidencePath: sessionEventsPath, provenance: `Hemlock memory command ${command}` });
      appendAgentEvent(`memory.${command.split(".")[1]}`, "recorded", { targetId: payload.targetId, record: result.record }, { evidenceRefs: [result.memoryPath], reversible: true });
    }
    else if (command === "plan.propose") result = agentOrchestrator.proposePlan(agentTask, payload);
    else if (command === "plan.approve") result = await agentOrchestrator.approvePlan(String(payload.taskId || agentTask.id), String(payload.planId || agentTask.activePlanId || ""));
    else if (command === "plan.reject") result = agentOrchestrator.rejectPlan(String(payload.taskId || agentTask.id), String(payload.planId || agentTask.activePlanId || ""), String(payload.reason || "Rejected by user"));
    else if (command === "task.resume") result = await agentOrchestrator.resumeTask(String(payload.taskId || agentTask.id));
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
  const selection = normalizeSelection({ provider: agentTask.provider, model: agentTask.model, reasoning: agentTask.reasoning });
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
  };
  const compactContext = compileThreadContext(task.threadId || agentTask.threadId, { compact: true });
  const actionRequest = {
    task: compactTask,
    context: compactContext,
    nextStep: prompt.nextPlannedStep || null,
    completed: prompt.history || { actions: [], observations: [], operations: [] },
    repair: prompt.repair || null,
  };
  const messages = [
    { role: "system", content: prompt.system },
    { role: "user", content: JSON.stringify(actionRequest) },
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
    return { content, channels: external.channels, rawOutputRef: external.rawOutputRef, provider: selection.provider };
  }
  const actionStream = startStream({ taskId: task.id, operationId: null, kind: "agent_action", provider: "maple" });
  const response = await fetchMapleWithRecovery(`${endpoint}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({
      model: "default_model",
      messages,
      temperature: 0,
      top_p: 1,
      top_k: 0,
      // Maple's reasoning channel is model output, not a discardable hidden
      // preamble. Keep reasoning enabled and let the model decide when it is
      // done; mapleMaxTokens is only the transport/server ceiling.
      max_tokens: mapleMaxTokens,
      stream: true,
      response_format: { type: "json_object" },
      chat_template_kwargs: { enable_thinking: true },
    }),
  }, inferenceTimeoutMs);
  if (!response.ok) {
    const payload = await readResponse(response);
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
      const result = await reader.read();
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
      tokensPerSecond: tokensPerSecond(payload.usage, Date.now() - startedAt),
      outputDigest: digestText(content),
      modelChannels: channels.map((channel) => ({ name: channel.name, digest: digestText(channel.text) })),
    },
  });
  return { content, channels: modelChannelRecords(Object.fromEntries(channels.map((channel) => [channel.name, channel.text]))), rawOutputRef, streamId: actionStream.streamId, actionChannel: selectedActionText.channel, reasoning: message.reasoning || message.reasoning_content || message.thought || "" };
}

let codingAutopilot = null;
agentOrchestrator = new AgentOrchestrator({
  kernel: agentKernel,
  commandRegistry: agentCommands,
  getTask: () => agentTask,
  setTask: (patch) => updateAgentTask(patch),
  emit: (type, status, payload, options) => appendAgentEvent(type, status, payload, options),
  executeCommand: (command, payload) => runAgentCommand(command, payload),
  inferAction: inferStructuredAction,
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
});

codingAutopilot = new CodingAutopilot({
  maxAttempts: 2,
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
    appendAgentEvent("task.queue.updated", "observed", { queue }, { reversible: true });
  },
  emit: (type, status, payload) => appendAgentEvent(type, status, payload, { reversible: true }),
});

writeAgentState();
appendAgentEvent("session.started", "ready", { sessionId, taskId: agentTask.id });
void contextBroker.refresh({ reason: shouldResumeTask ? "session-resume" : "session-start" }).catch((error) => {
  appendAgentEvent("context.refresh.failed", "failed", { error: error.message }, { reversible: true });
});
if (shouldResumeTask) {
  appendAgentEvent("session.resumed", "blocked", {
    previousSessionId,
    previousTaskId: previousTask.id,
    reason: agentTask.blockedReason,
  }, { evidenceRefs: previousEventsPath ? [previousEventsPath] : [], reversible: true });
}

function closeAgentSession() {
  if (sessionClosed) return;
  sessionClosed = true;
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

function runChild(command, args, { cwd = repoRoot, timeoutMs = 120000, operationId = null } = {}) {
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
    child.stdout.on("data", (chunk) => { stdout = appendOutput(stdout, chunk); if (stdoutStream) { publishStreamFrame(stdoutStream, { delta: String(chunk) }); checkpointStream(stdoutStream); } });
    child.stderr.on("data", (chunk) => { stderr = appendOutput(stderr, chunk); if (stderrStream) { publishStreamFrame(stderrStream, { delta: String(chunk) }); checkpointStream(stderrStream); } });
    child.on("error", (error) => {
      clearTimeout(timer);
      activeChildren.delete(child);
      finishStream(stdoutStream, { status: "failed", stopReason: error.message });
      finishStream(stderrStream, { status: "failed", stopReason: error.message });
      resolve({ command: [command, ...args], cwd, exitCode: null, signal: null, timedOut, stdout, stderr: appendOutput(stderr, error.message), elapsed: Math.round((Date.now() - startedAt) / 1000) });
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      activeChildren.delete(child);
      finishStream(stdoutStream, { status: exitCode === 0 ? "completed" : "failed", stopReason: signal || (exitCode === 0 ? "exit_0" : `exit_${exitCode}`) });
      finishStream(stderrStream, { status: exitCode === 0 ? "completed" : "failed", stopReason: signal || (exitCode === 0 ? "exit_0" : `exit_${exitCode}`) });
      resolve({ command: [command, ...args], cwd, exitCode, signal, timedOut, stdout, stderr, elapsed: Math.round((Date.now() - startedAt) / 1000) });
    });
  });
}

async function runSipsRuntime(payload) {
  const result = await runChild(python, [...pythonFlags, sipsRuntimeScript, JSON.stringify({ root: repoRoot, sipsDir, ...payload })], { cwd: repoRoot, timeoutMs: 30000 });
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
    timeoutMs: 180000,
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
};

async function runVerification(profileId, emit = null, options = {}) {
  const profile = verificationProfiles[profileId] || verificationProfiles["app-build"];
  const workspaceRoot = options.workspaceRoot && fs.existsSync(path.join(options.workspaceRoot, "package.json")) ? path.resolve(options.workspaceRoot) : profile.cwd;
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

async function repoMap(payload = {}) {
  const workspaceRoot = path.resolve(payload.workspaceRoot || agentTask.workspaceRoot || repoRoot);
  const [branch, status, files] = await Promise.all([
    runChild("git", ["branch", "--show-current"], { cwd: workspaceRoot, timeoutMs: 15000 }),
    runChild("git", ["status", "--short"], { cwd: workspaceRoot, timeoutMs: 15000 }),
    runChild("git", ["ls-files"], { cwd: workspaceRoot, timeoutMs: 15000 }),
  ]);
  return {
    schema: "hemlock.sips.repo-map.v1",
    status: "ready",
    root: workspaceRoot,
    branch: branch.stdout.trim(),
    dirty: Boolean(status.stdout.trim()),
    statusShort: status.stdout.trim(),
    files: files.stdout.split(/\r?\n/).filter(Boolean).slice(0, 160),
    receipts: { branch, status, files },
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

function startServer(adapterPath = "") {
  if (serverProcess && !serverProcess.killed) return;
  if (!fs.existsSync(modelPath)) {
    throw new Error(`Maple-Preview model was not found at ${modelPath}. Set HEMLOCK_MODEL_PATH to a local MLX model directory.`);
  }
  const args = [...serverArgs];
  if (adapterPath) args.push("--adapter-path", adapterPath);
  serverProcessError = null;
  serverState = { processReady: false, inferenceReady: false, adapterPath };
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
      serverState = { processReady: false, inferenceReady: false, adapterPath: "" };
    }
  });
}

function stopServer() {
  return new Promise((resolve) => {
    if (!serverProcess || serverProcess.killed) {
      serverProcess = null;
      resolve();
      return;
    }
    const child = serverProcess;
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

async function waitForServer(timeoutMs = 180000, { preserveInference = false } = {}) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    if (serverProcessError) {
      const error = new Error(`The local Maple-Preview server failed before becoming ready: ${serverProcessError.message}`);
      Object.assign(error, serverProcessError);
      throw error;
    }
    if (!serverProcess || serverProcess.killed) {
      throw new Error("The local Maple-Preview server process exited before becoming ready.");
    }
    try {
      const response = await fetchWithTimeout(`${serverUrl}/health`, {}, 5000);
      if (response.ok) {
        serverState = { ...serverState, processReady: true, inferenceReady: preserveInference ? serverState.inferenceReady === true : false };
        return { processReady: true, inferenceReady: serverState.inferenceReady };
      }
      lastError = new Error(`Maple-Preview health returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(1000, Math.max(50, timeoutMs - (Date.now() - startedAt)))));
  }
  throw new Error(`The local Maple-Preview server process did not become ready: ${lastError?.message || "timeout"}.`);
}

async function launchMapleRuntime() {
  if (serverLaunchPromise) return serverLaunchPromise;
  serverLaunchPromise = (async () => {
    const startedAt = Date.now();
    try {
      if (!serverProcess || serverProcess.killed) startServer();
      await waitForServer(readinessTimeoutMs, { preserveInference: true });
      const result = createMapleLaunchResult({ server: serverState, startedAt });
      appendAgentEvent("maple.launch.completed", "passed", result, { reversible: true });
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
  }
  return restartMapleRuntime("Maple health check failed before inference.");
}

async function restartMapleRuntime(reason = "Maple runtime recovery requested.") {
  appendAgentEvent("maple.runtime.restarting", "running", { reason, cachePolicy: { size: maplePromptCacheSize, bytes: maplePromptCacheBytes, promptConcurrency: maplePromptConcurrency, decodeConcurrency: mapleDecodeConcurrency } }, { reversible: true });
  await stopServer();
  serverProcessError = null;
  serverState = { processReady: false, inferenceReady: false, adapterPath: "" };
  const result = await launchMapleRuntime();
  appendAgentEvent("maple.runtime.restarted", "passed", { reason, processReady: result.processReady, inferenceReady: result.inferenceReady }, { reversible: true });
  return result;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
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
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await probeInference(adapterPath);
    } catch (error) {
      lastError = error;
      // A rejected adapter is a deterministic failure. Retrying it would not
      // repair the adapter and would only keep the UI looking busy.
      if (adapterPath && error.status >= 400) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(1000, Math.max(50, timeoutMs - (Date.now() - startedAt)))));
  }
  throw new Error(`Maple-Preview inference did not become ready: ${lastError?.message || "timeout"}.`);
}

async function recoverBaseServer() {
  emitDreamProgress({ stage: "recovering Maple-Preview base server", progress: 96, elapsed: 0, log: "existing adapters and base weights are preserved" });
  await stopServer();
  startServer();
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

function runDream(payload) {
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
    examples: Array.isArray(payload?.examples) ? payload.examples : [],
    profile,
    iters: Number.isFinite(payload?.iters) ? payload.iters : profileIters,
    numLayers: Number.isFinite(payload?.numLayers) ? payload.numLayers : 1,
  };

  appendAgentEvent("dream.started", "running", {
    runId,
    runDir,
    profile,
    datasetRows: input.examples.length + input.facts.length + input.conversation.length,
    baseModel: modelPath,
  });
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
          startServer();
          waitForServer(readinessTimeoutMs).then(async (processStatus) => {
            emitDreamProgress({ stage: "server process ready — verifying adapter inference", progress: 95, elapsed: Math.round((Date.now() - startedAt) / 1000), log: "HTTP liveness is not an inference result", serverProcessReady: processStatus.processReady, inferenceReady: false });
            try {
              const inferenceStatus = await waitForInference(adapterPath, inferenceProbeTimeoutMs);
              emitDreamProgress({ stage: "Dream complete — adapter inference verified", progress: 100, elapsed: Math.round((Date.now() - startedAt) / 1000), log: "the base Maple-Preview weights remain unchanged", serverProcessReady: true, inferenceReady: true });
              settled = true;
              const result = { adapterPath, runDir, elapsed: Math.round((Date.now() - startedAt) / 1000), processReady: processStatus.processReady, inferenceReady: inferenceStatus.inferenceReady, trainingReceipt, trainingReceiptPath };
              appendAgentEvent("dream.completed", "passed", { runId, ...result, baseWeightsUnchanged: trainingReceipt.baseWeightsUnchanged === true }, { evidenceRefs: [trainingReceiptPath || runDir], reversible: false });
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
    startServer();
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
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf-8");
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
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf-8");
    try {
      await runSipsRuntime({ action: "record", title: `SIPS cycle failed · ${objective.slice(0, 72)}`, body: `SIPS cycle failed: ${error.message}`, tags: "sips,cycle,failure", status: "candidate", verifyBeforeUse: true, evidencePath: receiptPath, provenance: `Hemlock local SIPS failure receipt ${runId}` });
    } catch (recordError) {
      console.error(`[sips] failure receipt could not be recorded: ${recordError.message}`);
    }
    emitSipsProgress({ stage: "SIPS cycle failed", progress: 100, elapsed: receipt.elapsed, log: error.message, receiptPath, status: "failed" });
    appendAgentEvent("sips.cycle.failed", "failed", { runId, error: error.message, receiptPath }, { evidenceRefs: [receiptPath], reversible: true });
    throw error;
  } finally {
    sipsCycleActive = false;
  }
}

ipcMain.handle("providers:status", () => inspectProviders());
ipcMain.handle("providers:login", (_event, provider) => openProviderLogin(String(provider || ""), "login"));
ipcMain.handle("providers:logout", (_event, provider) => openProviderLogin(String(provider || ""), "logout"));
ipcMain.handle("maple:launch", () => runAgentCommand("maple.launch"));
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
  return getAgentState();
});
ipcMain.handle("dream:start", (_event, payload) => runAgentCommand("dream", payload));
ipcMain.handle("sips:cycle", (_event, payload) => runAgentCommand("cycle", payload));
ipcMain.handle("sips:command", async (_event, payload) => {
  const action = String(payload?.action || "status");
  return runAgentCommand(action, payload);
});

if (hasSingleInstanceLock) {
  app.whenReady().then(() => {
    if (app.isPackaged || process.env.MAPLE_AUTOSTART_SERVER === "1") {
      try {
        startServer();
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
