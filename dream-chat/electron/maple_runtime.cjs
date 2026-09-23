const MAPLE_LAUNCH_SCHEMA = "hemlock.maple.launch.v1";
const { classifyInferenceError } = require("./error_taxonomy.cjs");

const DEFAULT_CONVERSATION_MESSAGE_LIMIT = 32;
const DEFAULT_CONVERSATION_CHAR_LIMIT = 48000;

function normalizeInferenceMessage(message) {
  const role = ["system", "user", "assistant"].includes(String(message?.role)) ? String(message.role) : null;
  const content = typeof message?.content === "string" ? message.content.trim() : "";
  return role && content ? { role, content } : null;
}

// Keep the visible transcript complete in Hemlock, but keep the prompt sent to
// Maple bounded. The host owns this boundary so a renderer replay or a stale
// thread cannot accidentally grow a local MLX prompt without limit.
function compactInferenceMessages(messages, {
  maxMessages = DEFAULT_CONVERSATION_MESSAGE_LIMIT,
  maxChars = DEFAULT_CONVERSATION_CHAR_LIMIT,
} = {}) {
  const normalized = (Array.isArray(messages) ? messages : []).map(normalizeInferenceMessage).filter(Boolean);
  if (!normalized.length) return [];
  const firstSystem = normalized.find((message) => message.role === "system") || null;
  const tail = normalized.filter((message) => message !== firstSystem).slice(-Math.max(1, maxMessages - (firstSystem ? 1 : 0)));
  const selected = firstSystem ? [firstSystem, ...tail] : tail;
  const latestUserIndex = [...selected].map((message) => message.role).lastIndexOf("user");
  if (latestUserIndex < 0) {
    let remaining = maxChars;
    const history = [];
    for (const message of selected.slice().reverse()) {
      if (message.role === "system") continue;
      if (message.content.length <= remaining) {
        history.unshift(message);
        remaining -= message.content.length;
      } else if (remaining >= 256) {
        history.unshift({ ...message, content: message.content.slice(0, remaining) });
        remaining = 0;
      }
    }
    return firstSystem ? [firstSystem, ...history] : history;
  }

  const latestUser = selected[latestUserIndex];
  // If the latest user request itself is larger than the budget, preserve its
  // complete text. Build/artifact requests are user intent, not disposable
  // history; the separate authoring contract owns source-size validation.
  // Messages AFTER the latest user (a trailing assistant reply) belong to that
  // exchange and are kept with it — dropping them would orphan the answer to
  // the question the prompt still contains.
  const trailingAfterLatestUser = selected.slice(latestUserIndex + 1);
  let remaining = Math.max(0, maxChars - (firstSystem?.content.length || 0) - latestUser.content.length - trailingAfterLatestUser.reduce((sum, message) => sum + message.content.length, 0));
  const history = [];
  for (const message of selected.slice(0, latestUserIndex).reverse()) {
    if (message.role === "system") continue;
    if (message.content.length <= remaining) {
      history.unshift(message);
      remaining -= message.content.length;
    } else if (remaining >= 256) {
      history.unshift({ ...message, content: message.content.slice(0, remaining) });
      remaining = 0;
    }
  }
  return [...(firstSystem ? [firstSystem] : []), ...history, latestUser, ...trailingAfterLatestUser];
}

// T9-H2: delegates to the shared taxonomy. Same verdicts as the old inline
// ladder — transport-death, stall, and gpu-server-error are the retryable
// inference-failure classes; everything else (HTTP 400, cancellation,
// invalid checkpoint) is not.
const RETRYABLE_TRANSPORT_KINDS = new Set(["transport-death", "stall", "gpu-server-error"]);

function isMapleTransportError(error) {
  return RETRYABLE_TRANSPORT_KINDS.has(classifyInferenceError(error).kind);
}

function createMapleLaunchResult({ server = {}, startedAt = null, error = null } = {}) {
  const processReady = server.processReady === true;
  const inferenceReady = server.inferenceReady === true;
  return {
    schema: MAPLE_LAUNCH_SCHEMA,
    status: error ? "failed" : processReady ? "ready" : "blocked",
    processReady,
    inferenceReady,
    server: { ...server, processReady, inferenceReady },
    elapsedMs: Number.isFinite(startedAt) ? Math.max(0, Date.now() - startedAt) : null,
    ...(error ? { error: String(error.message || error) } : {}),
    ...(error?.code ? { errorCode: String(error.code) } : {}),
    ...(error?.signal ? { errorSignal: String(error.signal) } : {}),
    claimBoundary: "This action starts the local Maple runtime and verifies HTTP health only. It does not run an inference request, Dream training, or prove model quality.",
  };
}

module.exports = {
  MAPLE_LAUNCH_SCHEMA,
  DEFAULT_CONVERSATION_MESSAGE_LIMIT,
  DEFAULT_CONVERSATION_CHAR_LIMIT,
  compactInferenceMessages,
  normalizeInferenceMessage,
  isMapleTransportError,
  createMapleLaunchResult,
};
