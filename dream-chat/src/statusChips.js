// Status chips: one quiet line of honest runtime readouts for the Command
// Center heartbeat (and any other thin status bar). Every chip is a pure
// projection of fields that already exist on the ctx bag — a chip that has
// nothing true to say returns null instead of guessing. Host-provided fields
// that may not exist yet (warm-cache telemetry) are read defensively.

// Process readiness and inference readiness are separate probes. A live
// process whose inference is unverified is "warming", never "ready".
export function runtimeChip({ serverProcessReady = null, inferenceReady = null, serverState = null } = {}) {
  if (serverProcessReady === false || serverState === "down") {
    return { id: "runtime", label: "runtime down", tone: "warn", title: "The local Maple process is not reachable." };
  }
  if (serverProcessReady === true) {
    if (inferenceReady === true) {
      return { id: "runtime", label: "runtime ready", tone: "ok", title: "Maple process is up and inference is verified." };
    }
    return { id: "runtime", label: "runtime warming", tone: "amber", title: "Maple process is up; inference is not verified yet." };
  }
  return { id: "runtime", label: "runtime cold", tone: "muted", title: "The local runtime has not been started or probed this session." };
}

// Exactly one active job can hold the floor: Dream > SIPS > task lifecycle.
export function activeJobChip({ isDreaming = false, dreamProgress = 0, sipsCycleState = "idle", sipsProgress = 0, task = null } = {}) {
  if (isDreaming) return { id: "job", label: `dream ${Math.round(dreamProgress)}%`, tone: "violet", title: "A Dream training run is in progress." };
  if (sipsCycleState === "running") return { id: "job", label: `sips ${Math.round(sipsProgress)}%`, tone: "ok", title: "A bounded SIPS cycle is in progress." };
  const status = task?.status || "";
  if (status === "blocked") return { id: "job", label: "task blocked", tone: "warn", title: task.blockedReason || "The task needs attention before it can continue." };
  if (status === "waiting_for_approval") return { id: "job", label: "approval wait", tone: "amber", title: "The task is parked on your approval." };
  if (status === "paused") return { id: "job", label: "task paused", tone: "muted", title: "Paused tasks still hold the queue slot." };
  if (["accepted", "planning", "running", "verifying", "waiting_for_user"].includes(status)) {
    return { id: "job", label: "task active", tone: "ok", title: `Task is ${status.replaceAll("_", " ")}.` };
  }
  return null;
}

export function queueChip(queueState = null) {
  const pending = Array.isArray(queueState?.pending) ? queueState.pending.length : 0;
  if (!pending) return null;
  return { id: "queue", label: `${pending} queued`, tone: "amber", title: "Queued intents hold position until the active task reaches a terminal receipt." };
}

// Live output rate from the newest non-terminal stream frame. Streams that
// never reported usage still earn an honest "streaming" chip — never a rate.
export function liveRateChip({ liveStream = false, streamFrames = [] } = {}, now = Date.now()) {
  if (!liveStream) return null;
  const frames = Array.isArray(streamFrames) ? streamFrames : [];
  const live = [...frames].reverse().find((frame) => frame && frame.terminal !== true) || null;
  const tokens = Number(live?.usage?.completion_tokens ?? live?.usage?.output_tokens ?? live?.usage?.completionTokens);
  const startedAt = Date.parse(live?.startedAt || "");
  const elapsed = Number.isFinite(startedAt) ? (now - startedAt) / 1000 : NaN;
  if (Number.isFinite(tokens) && tokens > 0 && Number.isFinite(elapsed) && elapsed > 0) {
    const rate = Math.round((tokens / elapsed) * 10) / 10;
    const approx = live?.usage?.completionTokensApproximate ? "~" : "";
    return { id: "live", label: `tok/s ${approx}${rate}`, tone: "ok", title: "Live model output rate." };
  }
  return { id: "live", label: "streaming", tone: "ok", title: "A model stream is in progress." };
}

function shortAge(ageMs) {
  if (!Number.isFinite(ageMs) || ageMs < 0) return null;
  if (ageMs < 60000) return `${Math.round(ageMs / 1000)}s`;
  if (ageMs < 3600000) return `${Math.round(ageMs / 60000)}m`;
  return `${Math.round(ageMs / 3600000)}h`;
}

// Prompt-cache warmth rides the host's agent projection — fields may not exist
// yet (another lane is adding them), so this reads `|| null` throughout and
// stays silent rather than assert a cache state we do not have.
export function warmCacheChip(agentProjection = null, now = Date.now()) {
  const warmTokens = Number(agentProjection?.runtime?.warmCachedTokens ?? agentProjection?.warmCachedTokens) || null;
  const warmAt = agentProjection?.runtime?.lastWarmAt || agentProjection?.lastWarmAt || null;
  if (!warmTokens && !warmAt) return null;
  const age = warmAt ? shortAge(now - Date.parse(warmAt)) : null;
  const parts = [warmTokens ? `${warmTokens} tok` : null, age ? `${age} ago` : null].filter(Boolean);
  return { id: "cache", label: `warm ${parts.join(" · ") || "—"}`, tone: "muted", title: "Prompt-cache warm state recorded by the host." };
}

export function heartbeatChips(input = {}, now = Date.now()) {
  return [
    runtimeChip(input),
    activeJobChip(input),
    queueChip(input.queueState),
    liveRateChip(input, now),
    warmCacheChip(input.agentProjection, now),
  ].filter(Boolean);
}
