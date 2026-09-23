import test from "node:test";
import assert from "node:assert/strict";
import {
  FALLBACK_SETTING_FIELDS,
  SETTINGS_FIELD_ORDER,
  appliesBadge,
  coerceSettingValue,
  depsRows,
  depsSummary,
  fieldsForGroup,
  formatBytes,
  normalizeSettingFields,
  promptCacheInfo,
} from "./settingsModel.js";

const hostPayload = {
  schema: "hemlock.settings.v1",
  status: "ok",
  settings: { promptCacheSlots: 8, fallbackLane: "codex" },
  fields: [
    { key: "promptCacheSlots", label: "Prompt cache slots", kind: "number", group: "runtime", appliesOn: "next-launch", min: 1, max: 16, default: 4, value: 8, env: "HEMLOCK_PROMPT_CACHE_SLOTS", help: "host help" },
    { key: "fallbackLane", label: "Fallback lane", kind: "select", group: "runtime", appliesOn: "live", default: "none", value: "codex", options: [{ value: "none" }, { value: "codex" }, { value: "claude" }] },
    { key: "customKnob", label: "Custom", kind: "number", group: "agent", appliesOn: "next-launch", default: 1, value: 2 },
  ],
};

test("normalizeSettingFields merges host fields over fallbacks in stable order", () => {
  const fields = normalizeSettingFields(hostPayload);
  const keys = fields.map((field) => field.key);
  assert.deepEqual(keys.slice(0, SETTINGS_FIELD_ORDER.length), SETTINGS_FIELD_ORDER);
  assert.equal(keys.at(-1), "customKnob", "unknown host keys append after the known order");
  const slots = fields.find((field) => field.key === "promptCacheSlots");
  assert.equal(slots.value, 8, "settings value wins over field default");
  assert.equal(slots.help, "host help");
  const lane = fields.find((field) => field.key === "fallbackLane");
  assert.equal(lane.value, "codex");
  assert.equal(lane.kind, "select");
  assert.equal(lane.options.length, 3);
});

test("normalizeSettingFields renders fallbacks with defaults on an empty payload", () => {
  const fields = normalizeSettingFields(null);
  assert.equal(fields.length, SETTINGS_FIELD_ORDER.length);
  const slots = fields.find((field) => field.key === "promptCacheSlots");
  assert.equal(slots.value, 4);
  assert.equal(slots.appliesOn, "next-launch");
  const autonomy = fields.find((field) => field.key === "autonomyDefault");
  assert.equal(autonomy.group, "agent");
  assert.equal(autonomy.options.length, 3);
});

test("fieldsForGroup splits runtime knobs from agent defaults", () => {
  const fields = normalizeSettingFields(null);
  assert.deepEqual(fieldsForGroup(fields, "runtime").map((field) => field.key), ["promptCacheSlots", "prefillStepSize", "kvBits", "contextMaxTokens", "fallbackLane", "warmCooldownMs"]);
  assert.deepEqual(fieldsForGroup(fields, "agent").map((field) => field.key), ["autonomyDefault", "reasoningLevel"]);
});

test("appliesBadge states the honest apply timing", () => {
  assert.deepEqual(appliesBadge("next-launch"), { label: "applies on next launch", tone: "deferred" });
  assert.deepEqual(appliesBadge("live"), { label: "applies now", tone: "live" });
  assert.equal(appliesBadge("weird").tone, "muted");
});

test("coerceSettingValue validates numbers against bounds", () => {
  const field = FALLBACK_SETTING_FIELDS.promptCacheSlots;
  assert.deepEqual(coerceSettingValue(field, "8"), { ok: true, value: 8 });
  assert.equal(coerceSettingValue(field, "0").ok, false);
  assert.equal(coerceSettingValue(field, "999").ok, false);
  assert.equal(coerceSettingValue(field, "abc").ok, false);
  assert.deepEqual(coerceSettingValue(field, ""), { ok: true, value: null, cleared: true }, "empty clears back to default");
});

test("coerceSettingValue validates select membership", () => {
  const field = FALLBACK_SETTING_FIELDS.fallbackLane;
  assert.deepEqual(coerceSettingValue(field, "claude"), { ok: true, value: "claude" });
  assert.equal(coerceSettingValue(field, "pytorch").ok, false, "bogus lanes are rejected before the wire");
});

test("depsRows keeps only honest statuses and shapes rows", () => {
  const rows = depsRows({
    checks: [
      { name: "python3", status: "ok", detail: "3.13.0" },
      { name: "mlx", status: "missing", detail: "not importable" },
      { name: "transformers", status: "sparkly", detail: "weird" },
      { status: "ok" },
      "junk",
    ],
  });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { name: "python3", status: "ok", detail: "3.13.0" });
  assert.equal(rows[1].status, "missing");
  assert.equal(rows[2].status, "degraded", "unexpected host statuses degrade, never fake ok");
  assert.match(rows[2].detail, /unexpected status/);
  assert.deepEqual(depsRows(null), []);
  assert.deepEqual(depsRows({}), []);
});

test("depsSummary reports the worst honest state", () => {
  assert.deepEqual(depsSummary([]), { status: "unknown", label: "not checked" });
  assert.deepEqual(depsSummary([{ status: "ok" }, { status: "ok" }]).status, "ok");
  assert.deepEqual(depsSummary([{ status: "ok" }, { status: "degraded" }]).status, "degraded");
  assert.deepEqual(depsSummary([{ status: "degraded" }, { status: "missing" }]).status, "missing");
});

test("promptCacheInfo normalizes the danger-zone readout", () => {
  assert.deepEqual(promptCacheInfo(null), { path: "", bytes: 0, files: 0, present: false, serverMayRewrite: false });
  const info = promptCacheInfo({ promptCache: { path: "/data/maple-prompt-cache.safetensors", bytes: 2048, files: 3, present: true } });
  assert.equal(info.present, true);
  assert.equal(info.bytes, 2048);
  assert.equal(info.files, 3);
});

test("formatBytes keeps sizes human readable", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(2048), "2 KiB");
  assert.equal(formatBytes(5 * 1024 ** 2), "5.0 MiB");
  assert.equal(formatBytes(2 * 1024 ** 3), "2.0 GiB");
});
