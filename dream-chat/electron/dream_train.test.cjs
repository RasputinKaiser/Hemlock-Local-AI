// Dream dataset + guard policy tests. dream_train.py has no training run here
// (no model weights in CI) — these exercise the pure dataset curation,
// divergence detection, and resume helpers via python3 -c, the same way
// memory_feedback.test.cjs drives sips_runtime.py.
const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PYTHON = process.env.HEMLOCK_TEST_PYTHON || "python3";
const ELECTRON = __dirname;

function py(snippet) {
  const script = `import sys, json; sys.path.insert(0, ${JSON.stringify(ELECTRON)}); import dream_train; ${snippet}`;
  const stdout = execFileSync(PYTHON, ["-c", script], { encoding: "utf8", timeout: 30000 });
  return JSON.parse(stdout.trim().split(/\r?\n/).filter(Boolean).at(-1));
}

function tempRunDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hemlock-dream-"));
}

test("write_dataset dedups exact and near-duplicate facts", () => {
  const runDir = tempRunDir();
  const result = py(`
import json
data_dir, train, valid, manifest = dream_train.write_dataset(
    ${JSON.stringify(runDir)},
    ["Ian prefers tea", "Ian prefers tea", "Ian prefers tea."],
    [],
    [],
    tokenizer=None,
)
print(json.dumps({"manifest": manifest, "train": train, "valid": valid}))
`);
  // Three facts x 3 templates = 9 source rows: the second identical fact's 3
  // rows are exact dupes, the punctuation-variant fact's 3 rows are near-dupes.
  assert.equal(result.manifest.sourceRows, 3);
  assert.equal(result.manifest.exactDuplicatesRemoved, 3);
  assert.equal(result.manifest.nearDuplicatesRemoved, 3);
  assert.equal(result.manifest.trainRows + result.manifest.validRows, 3);
});

test("write_dataset drops rows without supervised assistant content", () => {
  const runDir = tempRunDir();
  const result = py(`
import json
examples = [
    {"messages": [{"role": "user", "content": "hello"}, {"role": "user", "content": "again"}], "metadata": {"source": "chat"}},
    {"messages": [{"role": "user", "content": "q"}, {"role": "assistant", "content": "ok"}], "metadata": {"source": "chat"}},
    {"messages": [{"role": "user", "content": "q"}, {"role": "assistant", "content": "A real substantive answer."}], "metadata": {"source": "chat"}},
]
data_dir, train, valid, manifest = dream_train.write_dataset(${JSON.stringify(runDir)}, [], [], examples, tokenizer=None)
print(json.dumps(manifest))
`);
  assert.equal(result.qualityDropped, 2);
  assert.equal(result.sourceRows, 1);
});

test("write_dataset caps a dominant source at the share limit", () => {
  const runDir = tempRunDir();
  const result = py(`
import json
chat = [{"messages": [{"role": "user", "content": f"q{i}"}, {"role": "assistant", "content": f"answer number {i} with substance"}], "metadata": {"source": "chat"}} for i in range(10)]
exp = [{"messages": [{"role": "user", "content": "experiment q"}, {"role": "assistant", "content": "experiment result with substance"}], "metadata": {"source": "experiment"}}]
data_dir, train, valid, manifest = dream_train.write_dataset(${JSON.stringify(runDir)}, [], [], chat + exp, tokenizer=None)
print(json.dumps(manifest))
`);
  // 11 rows, 60% cap -> at most 7 chat rows; the experiment row survives.
  assert.ok(result.sources.chat <= 7, `chat capped at 60%: ${JSON.stringify(result.sources)}`);
  assert.equal(result.sources.experiment, 1);
  assert.ok(result.balanceDropped >= 3);
});

test("write_dataset stamps provenance (source + rowHash) and a dataset digest", () => {
  const runDir = tempRunDir();
  const result = py(`
import json, pathlib
data_dir, train, valid, manifest = dream_train.write_dataset(${JSON.stringify(runDir)}, ["Ian likes rust"], [], [], tokenizer=None)
rows = [json.loads(line) for line in pathlib.Path(data_dir, "train.jsonl").read_text().splitlines() if line.strip()]
print(json.dumps({"manifest": manifest, "rows": rows}))
`);
  assert.ok(result.manifest.datasetDigest && result.manifest.datasetDigest.length === 64);
  assert.equal(result.manifest.sources["personal-fact"], 3);
  assert.ok(result.rows.every((row) => row.metadata.source === "personal-fact" && /^[0-9a-f]{16}$/.test(row.metadata.rowHash)));
  assert.ok(result.manifest.validationRowHash);
});

test("detect_divergence trips on non-finite and runaway loss only", () => {
  const result = py(`
import json
metrics = [{"step": 1, "loss": 2.0}, {"step": 2, "loss": 1.9}, {"step": 3, "loss": 12.0}]
print(json.dumps({
    "ok": dream_train.detect_divergence(metrics),
    "nan": dream_train.detect_divergence([{"step": 1, "loss": 2.0}, {"step": 2, "loss": float("nan")}]),
    "inf_val": dream_train.detect_divergence([{"step": 1, "loss": 2.0}, {"step": 2, "valLoss": float("inf")}]),
    "baseline_step1": dream_train.detect_divergence([{"step": 1, "loss": 99.0}]),
}))
`);
  assert.equal(result.ok, null);
  assert.match(result.nan, /non-finite/);
  assert.match(result.inf_val, /non-finite/);
  assert.equal(result.baseline_step1, null, "first observed loss is the baseline, not a trip");
  const runaway = py(`
import json
print(json.dumps(dream_train.detect_divergence([{"step": 1, "loss": 1.0}, {"step": 3, "loss": 15.0}])))
`);
  assert.match(runaway, /exceeded/);
});

test("find_resume_checkpoint picks the highest numbered checkpoint", () => {
  const runDir = tempRunDir();
  fs.mkdirSync(path.join(runDir, "adapters"), { recursive: true });
  fs.writeFileSync(path.join(runDir, "adapters", "0000002_adapters.safetensors"), "a");
  fs.writeFileSync(path.join(runDir, "adapters", "0000004_adapters.safetensors"), "b");
  fs.writeFileSync(path.join(runDir, "adapters", "adapters.safetensors"), "final");
  const result = py(`
import json, pathlib
found = dream_train.find_resume_checkpoint(pathlib.Path(${JSON.stringify(runDir)}))
print(json.dumps({"file": str(found[0]) if found else None, "step": found[1] if found else None}))
`);
  assert.equal(result.step, 4);
  assert.match(result.file, /0000004_adapters\.safetensors$/);
});

test("resolve_resume_source scopes resumeFrom inside the run dir", () => {
  const runDir = tempRunDir();
  fs.mkdirSync(path.join(runDir, "adapters"), { recursive: true });
  const ckpt = path.join(runDir, "adapters", "0000002_adapters.safetensors");
  fs.writeFileSync(ckpt, "weights");
  const inside = py(`
import json, pathlib
print(json.dumps(dream_train.resolve_resume_source(pathlib.Path(${JSON.stringify(runDir)}), {"resumeFrom": ${JSON.stringify(ckpt)}})))
`);
  assert.equal(inside.applied, true);
  assert.equal(inside.step, 2);
  assert.equal(inside.mode, "explicit");
  // Outside the run dir is rejected — resume provenance stays in one place.
  assert.throws(() => py(`
import json, pathlib
print(json.dumps(dream_train.resolve_resume_source(pathlib.Path(${JSON.stringify(runDir)}), {"resumeFrom": "/tmp/elsewhere.safetensors"})))
`));
  // auto mode with no checkpoint trains fresh and says so.
  const fresh = py(`
import json, pathlib
empty = pathlib.Path(${JSON.stringify(runDir)}) / "empty"
empty.mkdir()
print(json.dumps(dream_train.resolve_resume_source(empty, {"resume": True})))
`);
  assert.equal(fresh.applied, false);
  assert.match(fresh.reason, /no prior checkpoint/);
});
