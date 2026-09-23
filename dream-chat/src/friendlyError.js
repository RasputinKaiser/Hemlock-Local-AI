// Maps host error strings to one plain-language line plus a hint, keeping the
// raw text for the "Details" disclosure. Mirrors electron/error_taxonomy.cjs
// on the renderer side — that module classifies structured error objects for
// the host; this one classifies the flattened message strings ctx.error
// actually carries (IPC wrapper, "Maple-Preview returned HTTP 500: …", etc.).

// Electron IPC wraps handler errors as
// `Error invoking remote method 'X': Error: <real message>` — strip the
// transport so users see the actual cause, not jargon.
const IPC_WRAPPER = /^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/;

export function stripTransportWrapper(text) {
  return String(text || "").replace(IPC_WRAPPER, "").trim();
}

// Ordered: first match wins. Cancelled and timeout beat the generic transport
// patterns (ETIMEDOUT lives in the transport set host-side) because the plain
// line is more informative; 5xx beats transport because "server error" tells
// the user more than "connection dropped".
const RULES = [
  {
    kind: "cancelled",
    re: /\bcancell?ed\b|\bCANCELLED\b/i,
    line: "That was cancelled — nothing further will run.",
    hint: "Send again whenever you are ready.",
    retryable: true,
  },
  {
    kind: "timeout",
    re: /timed? ?out|\btimeout\b|ETIMEDOUT|abort/i,
    line: "The local runtime did not answer in time.",
    hint: "First model loads can be slow — try again, or check local readiness in Settings.",
    retryable: true,
  },
  {
    kind: "server-error",
    re: /RUNTIME_UNAVAILABLE|HTTP 5\d\d|\b5\d\d server|did not become ready|exited before becoming ready/i,
    line: "The local model server hit an internal error.",
    hint: "It usually recovers on its own — retry, or open Settings → Check local readiness.",
    retryable: true,
  },
  {
    kind: "transport",
    re: /ECONNREFUSED|ECONNRESET|EPIPE|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|fetch failed|socket|connection refused|other side closed|premature close|terminated\b|network|host unreachable|getaddrinfo/i,
    line: "The connection to the local model server dropped.",
    hint: "The server may have restarted — try again, or open Settings → Check local readiness.",
    retryable: true,
  },
  {
    kind: "endpoint-not-found",
    re: /HTTP 404|endpoint not found|does not expose that endpoint/i,
    line: "The local model server does not expose that endpoint.",
    hint: "Retrying the same request will not help — the server build may be outdated.",
    retryable: false,
  },
  {
    kind: "rejected",
    re: /HTTP 4\d\d/i,
    line: "The local server rejected the request.",
    hint: "The detail below names the HTTP status the server returned.",
    retryable: false,
  },
  {
    kind: "action-envelope",
    re: /INVALID_ACTION_OUTPUT|EMPTY_ACTION_OUTPUT|invalid action envelope|no structured action content|malformed action/i,
    line: "The model's structured action was malformed, and the built-in repair pass already ran.",
    hint: "Resend the request or steer the task — do not just retry the same action.",
    retryable: true,
  },
  {
    kind: "model-invalid",
    re: /not a valid MLX checkpoint/i,
    line: "That model checkpoint could not be loaded.",
    hint: "Pick a different model or adapter in the model picker.",
    retryable: false,
  },
];

export function friendlyError(raw) {
  const detail = stripTransportWrapper(raw);
  const haystack = `${String(raw || "")}\n${detail}`;
  for (const rule of RULES) {
    if (rule.re.test(haystack)) {
      return { kind: rule.kind, line: rule.line, hint: rule.hint, detail: detail || rule.line, raw: String(raw || ""), retryable: rule.retryable };
    }
  }
  return {
    kind: "unknown",
    line: "Something went wrong while talking to the local runtime.",
    hint: detail ? "The detail below is the exact host message." : "",
    detail: detail || "No detail was recorded.",
    raw: String(raw || ""),
    retryable: true,
  };
}
