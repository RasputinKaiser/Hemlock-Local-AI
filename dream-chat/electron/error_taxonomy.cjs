// T9-H2: unified error taxonomy for local inference failures. One pure
// classifier so maple_runtime, stream recovery, and IPC surfaces agree on
// what died, whether retrying can help, and what to tell the user.
const TRANSPORT_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "EPIPE", "UND_ERR_SOCKET", "ETIMEDOUT",
  // T11-B gap sweep: unreachable-host and DNS-resolution failures surface with
  // these codes (undici wraps them under "fetch failed") and previously fell
  // through to "unknown" even though they are plain transport deaths.
  "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN",
]);

const RETRYABLE_KINDS = new Set(["transport-death", "stall", "gpu-server-error", "server-error"]);

const USER_MESSAGES = {
  "transport-death": "The connection to the local model dropped mid-request.",
  "stall": "The local model accepted the request but never produced output.",
  "gpu-server-error": "The local model server hit a GPU error.",
  "server-error": "The local model server hit an internal error.",
  "endpoint-not-found": "The local model server does not expose that endpoint.",
  "action-envelope-invalid": "The model returned a malformed action payload.",
  "cancelled-by-user": "Cancelled.",
  "model-invalid": "That model checkpoint could not be loaded.",
  "server-not-ready": "The local model server is not ready yet.",
  "unknown": "Something went wrong talking to the local model.",
};

function classifyInferenceError(error) {
  const code = String(error?.code || error?.cause?.code || "");
  const message = String(error?.message || error?.cause?.message || error || "");
  let kind = "unknown";
  if (code === "MAPLE_FIRST_TOKEN_STALL") kind = "stall";
  // undici throws bare "TypeError: terminated" when the server dies
  // mid-stream and the SSE connection severs before the response completes.
  else if (
    TRANSPORT_CODES.has(code)
    || /fetch failed|socket|connection refused|other side closed|network|host unreachable|getaddrinfo|ehostunreach|enetunreach|eai_again/i.test(message)
    || /^terminated$|terminated\b.*undici|premature close/i.test(message)
  ) kind = "transport-death";
  // mlx >=0.32.1 surfaces Metal CommandBuffer failures as HTTP 500 bodies
  // naming the GPU error instead of aborting the server process.
  else if (error?.status >= 500 && /metal|commandbuffer|gpu/i.test(message)) kind = "gpu-server-error";
  // T11-B: non-GPU HTTP 5xx — often a transient server-side fault, but the
  // retry gate in maple_runtime deliberately keeps its own narrower set, so
  // this flag informs UI copy without changing host retry behavior.
  else if (error?.status >= 500 || /\bhttp 5\d\d\b/i.test(message)) kind = "server-error";
  // T11-B: HTTP 404 means the route/model path does not exist on the local
  // server; retrying the same request cannot help.
  else if (error?.status === 404 || /\bhttp 404\b/i.test(message)) kind = "endpoint-not-found";
  else if (error?.reason === "cancelled" || code === "CANCELLED" || message === "cancelled") kind = "cancelled-by-user";
  // T11-B: structured-action envelopes that fail JSON/validation after the
  // orchestrator's built-in repair loop already retried once — re-retrying is
  // not offered because the loop above has already had its second chance.
  else if (["INVALID_ACTION_OUTPUT", "EMPTY_ACTION_OUTPUT"].includes(code) || /invalid action envelope|no structured action content|two invalid action envelopes/i.test(message)) kind = "action-envelope-invalid";
  else if (/not a valid MLX checkpoint/i.test(message)) kind = "model-invalid";
  else if (/did not become ready|exited before becoming ready/i.test(message)) kind = "server-not-ready";
  return {
    kind,
    retryable: RETRYABLE_KINDS.has(kind),
    userMessage: USER_MESSAGES[kind],
  };
}

module.exports = { classifyInferenceError, RETRYABLE_KINDS };
