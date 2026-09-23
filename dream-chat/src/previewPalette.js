// Preview interact palette — declarative descriptors for the host-registered
// preview actions (electron/preview_policy.cjs REGISTERED_ACTIONS) plus result
// summarising. Pure; the component owns ctx.runArtifact + postMessage wiring.

// The in-page harness (previewDocument in main.jsx) handles these directly via
// postMessage; screenshot/pause/stop are host-side only.
export const HARNESS_ACTIONS = new Set(["inspect", "accessibility", "resize", "click", "hover", "focus", "type", "key", "scroll", "wait"]);

const TARGET_FIELD = { name: "target", label: "Target", placeholder: "#id or [data-preview-id=…]", required: true };

export const PALETTE_ACTIONS = [
  { id: "click", label: "Click", fields: [TARGET_FIELD] },
  { id: "type", label: "Type", fields: [TARGET_FIELD, { name: "text", label: "Text", placeholder: "text to enter", required: true }] },
  { id: "key", label: "Key", fields: [{ name: "key", label: "Key", placeholder: "Enter", required: true }, { name: "target", label: "Target", placeholder: "optional" }] },
  { id: "scroll", label: "Scroll", fields: [{ name: "top", label: "Top", placeholder: "±px, e.g. 400" }, { name: "left", label: "Left", placeholder: "±px" }, { name: "target", label: "Target", placeholder: "optional" }] },
  { id: "hover", label: "Hover", fields: [TARGET_FIELD] },
  { id: "focus", label: "Focus", fields: [TARGET_FIELD] },
  { id: "wait", label: "Wait", fields: [{ name: "ms", label: "Milliseconds", placeholder: "250" }] },
  { id: "screenshot", label: "Screenshot", fields: [] },
  { id: "inspect", label: "Inspect DOM", fields: [], harnessOnly: true },
  { id: "accessibility", label: "A11y tree", fields: [], harnessOnly: true },
  { id: "resize", label: "Resize", fields: [{ name: "width", label: "Width", placeholder: "800" }, { name: "height", label: "Height", placeholder: "600" }] },
  { id: "pause", label: "Pause", fields: [], hostCommand: "preview.stop", reason: "agent_input_paused" },
  { id: "stop", label: "Stop", fields: [], hostCommand: "preview.stop", reason: "user_stopped" },
];

const NUMERIC_FIELDS = new Set(["top", "left", "ms", "width", "height"]);

export function paletteAction(id) {
  return PALETTE_ACTIONS.find((action) => action.id === id) || null;
}

// Build the { previewAction, ...input } payload for preview.interact. Throws
// on a missing required field so the form surfaces the problem, not the host.
export function buildInteractInput(actionId, values = {}) {
  const spec = paletteAction(actionId);
  if (!spec) throw new Error(`Unknown preview action: ${actionId}`);
  const input = { previewAction: actionId };
  for (const field of spec.fields) {
    const raw = String(values[field.name] ?? "").trim();
    if (!raw) {
      if (field.required) throw new Error(`${spec.label} needs ${field.label.toLowerCase()} (${field.name}).`);
      continue;
    }
    if (NUMERIC_FIELDS.has(field.name)) {
      const number = Number(raw);
      if (!Number.isFinite(number)) throw new Error(`${field.label} must be a number, got "${raw}".`);
      input[field.name] = number;
    } else {
      input[field.name] = raw;
    }
  }
  return input;
}

// One-line summary of a preview.interact result for the notice stack and the
// inline result strip. The host echoes postDigest/consoleErrors/screenshotRef
// back on the interaction record when the caller supplies them.
export function summarizeInteraction(actionId, result) {
  if (!result) return `${actionId}: no response from the preview host.`;
  const status = result.status || result.interaction?.result || "unknown";
  if (status === "blocked" || result.allowed === false) {
    return `${actionId} blocked: ${result.reason || result.interaction?.result || "host declined the action"}.`;
  }
  const interaction = result.interaction || {};
  const parts = [`${actionId} ${status}`];
  if (interaction.target) parts.push(`target ${interaction.target}`);
  if (interaction.postDigest) parts.push(`digest ${String(interaction.postDigest).replace(/^sha256:/, "").slice(0, 10)}`);
  if (Array.isArray(interaction.consoleErrors) && interaction.consoleErrors.length) {
    parts.push(`${interaction.consoleErrors.length} console error${interaction.consoleErrors.length === 1 ? "" : "s"}`);
  }
  if (interaction.screenshotRef) parts.push("screenshot captured");
  if (Number.isFinite(interaction.elapsedMs) && interaction.elapsedMs > 0) parts.push(`${interaction.elapsedMs}ms`);
  return parts.join(" · ");
}

// Only render references the sandboxed preview can actually display.
export function isRenderableScreenshotRef(ref) {
  const value = String(ref || "");
  return /^data:image\//.test(value) || value.startsWith("blob:") || value.startsWith("file:");
}
