const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

// WORLD/EXPERIMENT host tests. Same harness as host_ux_ipc.test.cjs: main.cjs
// is loaded once with a mocked "electron" module and HEMLOCK_DATA_DIR pointed
// at a throwaway directory; the agent:command handler is captured and invoked
// directly.

const ipcHandlers = new Map();

class FakeNotification {
  constructor(options) {
    this.options = options;
  }
  show() {}
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hemlock-experiment-test-"));
process.env.HEMLOCK_DATA_DIR = dataDir;

const electronMock = {
  app: {
    name: "Hemlock",
    isPackaged: true,
    requestSingleInstanceLock: () => true,
    on() {},
    quit() {},
    whenReady: () => new Promise(() => {}), // never resolve: no window is created
    commandLine: { appendSwitch() {} },
  },
  BrowserWindow: class {
    static getAllWindows() {
      return [];
    }
  },
  Notification: FakeNotification,
  ipcMain: {
    handle(channel, handler) {
      ipcHandlers.set(channel, handler);
    },
  },
  shell: { openExternal: async () => {}, showItemInFolder: () => {} },
  dialog: {
    showMessageBox: async () => ({ response: 1 }),
    showOpenDialog: async () => ({ canceled: true }),
  },
};

const originalLoad = Module._load;
Module._load = function mockedLoad(request, parent, isMain) {
  if (request === "electron") return electronMock;
  return originalLoad.call(this, request, parent, isMain);
};
const mainPath = path.resolve(__dirname, "main.cjs");
delete require.cache[mainPath];
try {
  require(mainPath);
} finally {
  Module._load = originalLoad;
}

// The throwaway HEMLOCK_DATA_DIR is intentionally not deleted: deferred journal
// writers may still flush into it after this file exits.

const command = (payload) => ipcHandlers.get("agent:command")({}, payload);

test("experiment.run records the hypothesis outcome as open on the receipt", async () => {
  const run = await command({ action: "experiment.run", experiment: "pendulum", input: { length: 1.5 }, hypothesis: "longer pendulums swing slower" });
  assert.equal(run.status, "completed");
  assert.equal(run.experiment.schema, "hemlock.world.experiment.receipt.v1");
  assert.equal(run.experiment.hypothesis, "longer pendulums swing slower");
  assert.equal(run.experiment.hypothesisOutcome, "open");
  const onDisk = JSON.parse(fs.readFileSync(run.receiptPath, "utf8"));
  assert.equal(onDisk.hypothesisOutcome, "open");
});

test("experiment.note citing a run flips its receipt hypothesisOutcome to addressed", async () => {
  const run = await command({ action: "experiment.run", experiment: "spring", input: { mass: 2, stiffness: 80 }, hypothesis: "stiffer springs oscillate faster" });
  const noted = await command({ action: "experiment.note", experimentId: run.experiment.id, claim: "the period shrank as stiffness rose" });
  assert.equal(noted.status, "recorded");
  const reread = JSON.parse(fs.readFileSync(run.receiptPath, "utf8"));
  assert.equal(reread.hypothesisOutcome, "addressed");
  assert.equal(reread.addressedByFindingId, noted.finding.id);
});

test("experiment.suggest returns ranked gaps and per-kind coverage", async () => {
  const result = await command({ action: "experiment.suggest" });
  assert.equal(result.schema, "hemlock.world.suggest.v1");
  assert.equal(result.status, "read");
  assert.ok(Array.isArray(result.suggestions));
  assert.equal(typeof result.markerCount, "number");
  for (const kind of ["projectile", "pendulum", "spring", "orbit", "collision", "terminal"]) {
    const coverage = result.coverageSummary[kind];
    assert.ok(coverage, `coverageSummary.${kind}`);
    for (const key of ["runs", "findings", "hypothesesTested", "hypothesesOpen"]) {
      assert.equal(typeof coverage[key], "number", `${kind}.${key}`);
    }
  }
  // The runs above leave pendulum's hypothesis open (no note cited it) and
  // spring's addressed; kinds never run (e.g. collision) surface as never-run.
  assert.equal(result.coverageSummary.pendulum.runs, 1);
  assert.equal(result.coverageSummary.pendulum.hypothesesOpen, 1);
  assert.equal(result.coverageSummary.spring.hypothesesTested, 1);
  assert.ok(result.suggestions.some((s) => s.experiment === "pendulum" && /hypothesis still open/.test(s.reason)));
  assert.ok(result.suggestions.some((s) => s.experiment === "collision" && /never been run/.test(s.reason)));
  for (const suggestion of result.suggestions) {
    assert.equal(typeof suggestion.experiment, "string");
    assert.equal(typeof suggestion.reason, "string");
    assert.ok(suggestion.coverage && typeof suggestion.coverage.runs === "number");
  }
});

test("experiment.suggest emits a world.suggest event on the spine", async () => {
  await command({ action: "experiment.suggest" });
  const state = await ipcHandlers.get("agent:state")();
  assert.ok(state.events.some((event) => event.type === "world.suggest"), "world.suggest event recorded");
});

test("experiment.run rejects invalid inputs with the valid range named", async () => {
  await assert.rejects(
    () => command({ action: "experiment.run", experiment: "pendulum", input: { length: "huge" } }),
    /pendulum\.length must be a finite number in \[0\.1, 10\]/,
  );
  await assert.rejects(
    () => command({ action: "experiment.run", experiment: "pendulum", input: { warp: 3 } }),
    /pendulum has no input "warp"\. Valid inputs: length, gravity, releaseDeg, damping\./,
  );
});

test("experiment.run tolerates envelope keys in the payload without polluting sim input", async () => {
  const run = await command({ action: "experiment.run", experiment: "pendulum", length: 2 });
  assert.equal(run.status, "completed");
  assert.equal(run.experiment.input.length, 2);
  assert.equal(run.experiment.input.gravity, 9.81);
  assert.ok(!("action" in run.experiment.input));
});

test("experiment.dataset reports markerCount alongside the finding rows", async () => {
  const result = await command({ action: "experiment.dataset" });
  assert.equal(result.schema, "hemlock.world.dataset.v1");
  assert.equal(typeof result.markerCount, "number");
  assert.ok(result.count >= 1, "the note recorded above is in the dataset");
});
