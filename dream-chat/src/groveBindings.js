// Understory Grove — event bindings.
//
// Pure mapping between the durable event spine and the ambient 3D scene.
// Everything here is honest: entities come from the real local model roster,
// activity comes only from real events this session, and metrics are the same
// telemetry fields the receipts record. Nothing is invented for the scene.

export const GROVE_ROSTER = [
  {
    id: "maple",
    name: "Maple-Preview",
    role: "primary local model",
    directory: "~/Models/Hemlock/maple-2bit-mlx",
    params: "20B-A1B ternary MoE · 256 experts, top-8",
    dtype: "2-bit packed · flash-head",
    providers: ["maple", "maple-preview"],
    size: 1.0,
    hue: 0x3f7a58,
    position: [0, 0, 0],
    learnsFrom: ["dream", "inference", "sips", "experiment"],
  },
  {
    id: "lfm25",
    name: "LFM2.5-8B",
    role: "secondary local model",
    directory: "~/Models/Hemlock/LFM2.5-8B-A1B-mlx-4bit",
    params: "8B total · ~1.5B active MoE",
    dtype: "4-bit group-64",
    providers: ["lfm25-8b", "lfm"],
    size: 0.62,
    hue: 0x356a4d,
    position: [-7.5, 0, -4.5],
    learnsFrom: ["inference"],
  },
  {
    id: "dspark",
    name: "LFM DSpark draft",
    role: "speculative draft (observed only)",
    directory: "~/Models/Hemlock/LFM2.5-8B-A1B-DSpark-mlx",
    params: "327.7M draft head",
    dtype: "bf16 wrapper",
    providers: ["dspark"],
    size: 0.3,
    hue: 0x2a5a42,
    position: [-6.2, 0, -2.9],
    learnsFrom: ["inference"],
  },
  {
    id: "qwen-draft",
    name: "Qwen2.5 draft",
    role: "speculative draft (observed only)",
    directory: "~/Models/Hemlock/qwen25-0.5b-draft-4bit",
    params: "0.5B draft",
    dtype: "4-bit",
    providers: ["qwen", "qwen-draft"],
    size: 0.24,
    hue: 0x2a5a42,
    position: [4.8, 0, -3.4],
    learnsFrom: ["inference"],
  },
];

// Event families that move the world. Anything not listed stays invisible —
// the grove only animates what the host actually recorded.
const BINDINGS = [
  { match: /^inference\./, effect: "infer" },
  { match: /^dream\./, effect: "dream" },
  { match: /^experiment\./, effect: "experiment" },
  { match: /^memory\.(promoted|candidate\.created|promote|demote|rollback)/, effect: "memory" },
  { match: /^sips\./, effect: "sips" },
  { match: /^(action|command|operation)\./, effect: "work" },
  { match: /^(task|plan)\./, effect: "task" },
];

const HOT_MS = 90000; // how long an entity stays lit after its last real event
const WIND_MS = 45000;

function providerOf(event) {
  return String(event?.payload?.provider || event?.payload?.metadata?.provider || event?.provider || "maple").toLowerCase();
}

function entityFor(event, roster) {
  const provider = providerOf(event);
  if (provider.includes("lfm") || provider.includes("dspark")) {
    return roster.find((entry) => entry.id === "lfm25") || roster[0];
  }
  if (provider.includes("qwen")) return roster.find((entry) => entry.id === "qwen-draft") || roster[0];
  if (provider === "codex" || provider === "claude") return null; // external lanes are not grove residents
  return roster[0]; // maple is the default resident
}

export function effectOf(event) {
  const type = String(event?.type || "");
  const hit = BINDINGS.find((binding) => binding.match.test(type));
  return hit?.effect || null;
}

export function telemetryFor(events) {
  const latest = [...(events || [])].reverse().find((event) => event.type === "inference.completed" && event.payload?.telemetry);
  const telemetry = latest?.payload?.telemetry || null;
  if (!telemetry) return null;
  return {
    tokensPerSecond: Number.isFinite(telemetry.tokensPerSecond) ? telemetry.tokensPerSecond : null,
    cacheHitRatio: Number.isFinite(telemetry.cacheHitRatio) ? telemetry.cacheHitRatio : null,
    promptTokens: telemetry.promptTokens ?? null,
    completionTokens: telemetry.completionTokens ?? null,
    elapsedMs: telemetry.elapsedMs ?? null,
    mode: latest.payload.mode || "conversation",
    at: latest.createdAt || null,
  };
}

// Reduce the event spine into scene state. Pure and bounded: callers can render
// this without a scene, and tests can assert exactly what the world believes.
export function bindGrove(events, { roster = GROVE_ROSTER, now = Date.now() } = {}) {
  const activity = new Map(roster.map((entry) => [entry.id, { level: 0, lastType: null, lastAt: null, pulses: [] }]));
  const blooms = [];
  const grafts = new Map();
  const replays = [];
  let wind = 0;
  let windAt = null;
  let ember = null;
  let boundCount = 0;

  for (const event of events || []) {
    const effect = effectOf(event);
    if (!effect) continue;
    const at = Date.parse(event.createdAt || "") || now;
    const failed = event.status === "failed" || event.status === "blocked" || String(event.type).includes("failed") || String(event.type).includes("blocked");
    const entity = effect === "memory" ? null : entityFor(event, roster);
    boundCount += 1;

    if (effect === "infer" || effect === "work" || effect === "task") {
      if (!entity) continue;
      const slot = activity.get(entity.id);
      slot.lastType = event.type;
      slot.lastAt = at;
      const fresh = now - at < HOT_MS;
      const strength = event.type === "inference.completed" ? 0.75 : event.type.includes("started") || event.status === "running" ? 1 : 0.5;
      slot.level = Math.max(slot.level, fresh ? strength : Math.min(strength, 0.2));
      if (failed) slot.pulses.push({ kind: "ember", at, type: event.type });
      if (event.type === "inference.completed") slot.pulses.push({ kind: "bloom-ring", at, type: event.type });
    } else if (effect === "dream") {
      const slot = activity.get("maple");
      slot.lastType = event.type;
      slot.lastAt = at;
      slot.level = Math.max(slot.level, now - at < HOT_MS ? 1 : 0.25);
      if (String(event.type).includes("detached")) {
        grafts.delete("maple");
      } else if (String(event.type).includes("adapter") || String(event.type).includes("completed") || String(event.type).includes("candidate") || String(event.type).includes("fused")) {
        grafts.set("maple", { kind: String(event.type).includes("fused") ? "fused" : "graft", at, type: event.type, status: failed ? "failed" : "grown" });
      }
      if (failed) slot.pulses.push({ kind: "ember", at, type: event.type });
    } else if (effect === "experiment") {
      // World experiments are Maple's habitat work: they light Maple's lab and
      // pulse a lab flash on completion, a seed ring when a finding joins the
      // Dream dataset. Failures ember like everything else.
      const slot = activity.get("maple");
      slot.lastType = event.type;
      slot.lastAt = at;
      slot.level = Math.max(slot.level, now - at < HOT_MS ? 0.9 : 0.2);
      // experiment.started is Maple actively working — the scene walks the
      // figure to the bench on this pulse, not just the outcome flash.
      if (event.type === "experiment.started" && !failed) slot.pulses.push({ kind: "lab-work", at, type: event.type });
      if (event.type === "experiment.completed" && !failed) {
        slot.pulses.push({ kind: "lab-flash", at, type: event.type });
        // The measured trail rides the event payload so the scene can replay
        // the actual integration — the world animates evidence, not symbols.
        if (event.payload?.trail?.points?.length) {
          replays.push({
            id: event.payload.experimentId || `exp-${replays.length}`,
            experiment: event.payload.experiment,
            input: event.payload.input || null,
            trail: event.payload.trail,
            divergence: event.payload.divergence ?? null,
            at,
          });
        }
      }
      if (event.type === "experiment.note.recorded" && !failed) slot.pulses.push({ kind: "lab-seed", at, type: event.type });
      if (failed) slot.pulses.push({ kind: "ember", at, type: event.type });
    } else if (effect === "memory") {
      const promoted = String(event.type).includes("promoted") || String(event.type).includes("promote");
      blooms.push({ kind: promoted ? "bloom" : "seed", at, type: event.type, id: event.payload?.targetId || event.payload?.record?.id || `memory-${blooms.length}` });
      if (failed) ember = { at, type: event.type };
    } else if (effect === "sips") {
      if (now - at < WIND_MS) wind = Math.min(1, wind + 0.34);
      windAt = at;
    }
    if (failed && effect !== "memory") ember = { at, type: event.type, entityId: entity?.id || null };
  }

  for (const slot of activity.values()) slot.pulses = slot.pulses.slice(-6);

  return {
    activity,
    blooms: blooms.slice(-18),
    grafts,
    wind: now - (windAt || 0) < WIND_MS ? wind : 0,
    ember,
    boundCount,
    experiments: replays.slice(-6),
    telemetry: telemetryFor(events),
  };
}

// Rows for the honest bindings panel — what the world shows and why.
export function bindingRows(events, { roster = GROVE_ROSTER, now = Date.now() } = {}) {
  const bound = bindGrove(events, { roster, now });
  return roster.map((entry) => {
    const slot = bound.activity.get(entry.id);
    const last = slot?.lastAt ? { type: slot.lastType, ageMs: Math.max(0, now - slot.lastAt) } : null;
    return {
      id: entry.id,
      name: entry.name,
      role: entry.role,
      directory: entry.directory,
      params: entry.params,
      dtype: entry.dtype,
      activity: slot?.level || 0,
      lastEvent: last,
      graft: bound.grafts.get(entry.id) || null,
    };
  });
}
