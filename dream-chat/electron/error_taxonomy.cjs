// T9-H2: unified error taxonomy for local inference failures. One pure
// classifier so maple_runtime, stream recovery, and IPC surfaces agree on
// what died, whether retrying can help, and what to tell the user.
const TRANSPORT_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "EPIPE", "UND_ERR_SOCKET", "ETIMEDOUT",
]);

const RETRYABLE_KINDS = new Set(["transport-death", "stall", "gpu-server-error"]);

const USER_MESSAGES = {
  "transport-death": "The connection to the local model dropped mid-request.",
  "stall": "The local model accepted the request but never produced output.",
  "gpu-server-error": "The local model server hit a GPU error.",
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
    || /fetch failed|socket|connection refused|other side closed|network/i.test(message)
    || /^terminated$|terminated\b.*undici|premature close/i.test(message)
  ) kind = "transport-death";
  // mlx >=0.32.1 surfaces Metal CommandBuffer failures as HTTP 500 bodies
  // naming the GPU error instead of aborting the server process.
  else if (error?.status >= 500 && /metal|commandbuffer|gpu/i.test(message)) kind = "gpu-server-error";
  else if (error?.reason === "cancelled" || code === "CANCELLED" || message === "cancelled") kind = "cancelled-by-user";
  else if (/not a valid MLX checkpoint/i.test(message)) kind = "model-invalid";
  else if (/did not become ready|exited before becoming ready/i.test(message)) kind = "server-not-ready";
  return {
    kind,
    retryable: RETRYABLE_KINDS.has(kind),
    userMessage: USER_MESSAGES[kind],
  };
}

module.exports = { classifyInferenceError, RETRYABLE_KINDS };
