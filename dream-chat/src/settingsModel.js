// Renderer-side helpers for the Settings control surface. Pure and host-free:
// every read/write still goes through runCommand("settings.*" | "deps.check") —
// these helpers only shape the host payloads into rows, badges, and editable
// field models, and provide fallback metadata so the window renders honest,
// disabled controls before the first settings.get lands (or in the preview).

export const SETTINGS_FIELD_ORDER = [
  "promptCacheSlots",
  "prefillStepSize",
  "kvBits",
  "contextMaxTokens",
  "fallbackLane",
  "warmCooldownMs",
  "autonomyDefault",
  "reasoningLevel",
];

// Mirrored from the host's RUNTIME_SETTING_DEFS (electron/main.cjs). The host
// payload is authoritative — these only cover the no-payload case.
export const FALLBACK_SETTING_FIELDS = {
  promptCacheSlots: {
    key: "promptCacheSlots", label: "Prompt cache slots", kind: "number", group: "runtime",
    appliesOn: "next-launch", env: "HEMLOCK_PROMPT_CACHE_SLOTS", min: 1, max: 16, default: 4,
    help: "Prompt-cache entries the Maple server persists across restarts. Applies on the next server launch.",
  },
  prefillStepSize: {
    key: "prefillStepSize", label: "Prefill step size", kind: "number", group: "runtime",
    appliesOn: "next-launch", env: "HEMLOCK_PREFILL_STEP_SIZE", min: 256, max: 8192, default: 1024,
    help: "Prompt prefill chunk size — smaller values stay more responsive on long prompts. Applies on the next server launch.",
  },
  kvBits: {
    key: "kvBits", label: "KV cache bits", kind: "select", group: "runtime",
    appliesOn: "next-launch", env: "HEMLOCK_KV_BITS", default: "0",
    options: [
      { value: "0", label: "Off — exact fp16 KV (default)" },
      { value: "8", label: "8-bit — near-lossless, ~2× smaller KV" },
      { value: "4", label: "4-bit — ~4× smaller KV, quality risk" },
    ],
    help: "Quantizes the 6 full-attention layers' KV cache past the quant-start token; sliding-window layers stay exact. Applies on the next server launch.",
  },
  contextMaxTokens: {
    key: "contextMaxTokens", label: "Context budget (tokens)", kind: "number", group: "runtime",
    appliesOn: "live", env: "HEMLOCK_CONTEXT_MAX_TOKENS", min: 4096, max: 124000, default: 24000,
    help: "Per-request context ceiling — over it, the host compacts the volatile prompt region, then blocks honestly. Default scales with KV bits (24k exact, ~61k quantized).",
  },
  fallbackLane: {
    key: "fallbackLane", label: "Fallback lane", kind: "select", group: "runtime",
    appliesOn: "live", env: "HEMLOCK_FALLBACK_LANE", default: "none",
    options: [
      { value: "none", label: "None — Maple only" },
      { value: "codex", label: "Codex" },
      { value: "claude", label: "Claude" },
    ],
    help: "Subscription lane a step retries on once when Maple's transport dies. Read per task — applies immediately.",
  },
  warmCooldownMs: {
    key: "warmCooldownMs", label: "Warm cooldown (ms)", kind: "number", group: "runtime",
    appliesOn: "next-launch", env: "HEMLOCK_WARM_COOLDOWN_MS", min: 60000, max: 3600000, default: 60000,
    help: "Minimum gap between Maple prompt-cache warm prefills. Applies on the next app launch.",
  },
  autonomyDefault: {
    key: "autonomyDefault", label: "Default autonomy", kind: "select", group: "agent",
    appliesOn: "live", default: "guided",
    options: [
      { value: "bounded-local", label: "Supervised — approve every step" },
      { value: "guided", label: "Guided — plans auto-approve" },
      { value: "autonomous", label: "Autonomous — budgets still bind" },
    ],
    help: "Autonomy level offered to new work. Applied to the composer control immediately.",
  },
  reasoningLevel: {
    key: "reasoningLevel", label: "Default reasoning", kind: "select", group: "agent",
    appliesOn: "live", default: "on",
    options: ["on", "off", "low", "medium", "high", "xhigh", "max"].map((value) => ({ value, label: value })),
    help: "Reasoning level for new work; a lane falls back to its own default for levels it does not support.",
  },
};

const DEP_STATUSES = new Set(["ok", "missing", "degraded"]);

function normalizeOption(option) {
  if (option && typeof option === "object") return { value: String(option.value ?? ""), label: String(option.label ?? option.value ?? "") };
  return { value: String(option ?? ""), label: String(option ?? "") };
}

function normalizeField(key, hostField, fallback) {
  const base = fallback || FALLBACK_SETTING_FIELDS[key] || { key, label: key, kind: "string", group: "runtime" };
  const source = hostField && typeof hostField === "object" ? hostField : {};
  const options = Array.isArray(source.options) && source.options.length
    ? source.options.map(normalizeOption)
    : Array.isArray(base.options) ? base.options.map(normalizeOption) : null;
  const kind = ["number", "select"].includes(source.kind) ? source.kind : (options ? "select" : base.kind || "string");
  return {
    key,
    label: String(source.label || base.label || key),
    kind,
    group: ["agent", "runtime"].includes(source.group) ? source.group : (base.group || "runtime"),
    appliesOn: typeof source.appliesOn === "string" ? source.appliesOn : base.appliesOn || "next-launch",
    env: source.env || base.env || null,
    help: String(source.help || base.help || ""),
    min: Number.isFinite(Number(source.min)) ? Number(source.min) : base.min ?? null,
    max: Number.isFinite(Number(source.max)) ? Number(source.max) : base.max ?? null,
    options,
    default: source.default ?? base.default ?? null,
    value: source.value ?? base.default ?? null,
  };
}

/**
 * Merge a settings.get payload into an ordered, render-ready field list.
 * Host fields win over the fallback metadata; settings values win over field
 * defaults. Unknown host keys are appended after the ordered known ones.
 */
export function normalizeSettingFields(payload) {
  const hostFields = Array.isArray(payload?.fields) ? payload.fields : [];
  const byKey = new Map(hostFields.map((field) => [String(field?.key || ""), field]));
  const values = payload?.settings && typeof payload.settings === "object" ? payload.settings : {};
  const ordered = [];
  for (const key of SETTINGS_FIELD_ORDER) {
    ordered.push(normalizeField(key, byKey.get(key), FALLBACK_SETTING_FIELDS[key]));
    byKey.delete(key);
  }
  for (const [key, field] of byKey) {
    if (!key) continue;
    ordered.push(normalizeField(key, field, null));
  }
  return ordered.map((field) => ({
    ...field,
    value: values[field.key] !== undefined ? values[field.key] : field.value,
  }));
}

export function fieldsForGroup(fields, group) {
  return (Array.isArray(fields) ? fields : []).filter((field) => field.group === group);
}

/**
 * Honest "when does this take effect" badge. Anything that feeds serverArgs
 * or a boot-time constant is next-launch; live-read seams (fallback lane,
 * renderer-consumed defaults) are live.
 */
export function appliesBadge(appliesOn) {
  if (appliesOn === "live") return { label: "applies now", tone: "live" };
  if (appliesOn === "next-launch") return { label: "applies on next launch", tone: "deferred" };
  return { label: String(appliesOn || "unknown"), tone: "muted" };
}

/**
 * Validate + coerce a control edit before it goes to settings.set. The host
 * re-validates — this only keeps obviously-bad input off the wire.
 */
export function coerceSettingValue(field, raw) {
  if (!field || typeof field !== "object") return { ok: false, error: "unknown setting" };
  if (raw === null || raw === undefined || raw === "") return { ok: true, value: null, cleared: true };
  if (field.kind === "number") {
    const value = Number(raw);
    if (!Number.isFinite(value)) return { ok: false, error: `${field.label} must be a number` };
    const rounded = Math.round(value);
    if (field.min != null && rounded < field.min) return { ok: false, error: `${field.label} must be ≥ ${field.min}` };
    if (field.max != null && rounded > field.max) return { ok: false, error: `${field.label} must be ≤ ${field.max}` };
    return { ok: true, value: rounded };
  }
  if (field.kind === "select") {
    const value = String(raw);
    const allowed = (field.options || []).map((option) => option.value);
    if (allowed.length && !allowed.includes(value)) return { ok: false, error: `${field.label} must be one of: ${allowed.join(", ")}` };
    return { ok: true, value };
  }
  return { ok: true, value: String(raw) };
}

/**
 * deps.check result → render rows. Only the honest statuses survive; an
 * unexpected status degrades rather than pretending to be ok.
 */
export function depsRows(payload) {
  const checks = Array.isArray(payload?.checks) ? payload.checks : [];
  return checks
    .filter((row) => row && typeof row === "object" && row.name)
    .map((row) => ({
      name: String(row.name),
      status: DEP_STATUSES.has(row.status) ? row.status : "degraded",
      detail: DEP_STATUSES.has(row.status)
        ? String(row.detail ?? "")
        : `unexpected status: ${row.status}${row.detail ? ` — ${row.detail}` : ""}`,
    }));
}

export function depsSummary(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return { status: "unknown", label: "not checked" };
  if (list.some((row) => row.status === "missing")) return { status: "missing", label: `${list.filter((row) => row.status === "missing").length} missing` };
  if (list.some((row) => row.status === "degraded")) return { status: "degraded", label: "degraded" };
  return { status: "ok", label: "all present" };
}

export function promptCacheInfo(payload) {
  const info = payload?.promptCache && typeof payload.promptCache === "object" ? payload.promptCache : {};
  return {
    path: typeof info.path === "string" ? info.path : "",
    bytes: Number.isFinite(Number(info.bytes)) ? Number(info.bytes) : 0,
    files: Number.isFinite(Number(info.files)) ? Number(info.files) : 0,
    present: info.present === true || Number(info.files) > 0,
    serverMayRewrite: info.serverMayRewrite === true,
  };
}

export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  if (value > 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GiB`;
  if (value > 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KiB`;
  return `${Math.round(value)} B`;
}
