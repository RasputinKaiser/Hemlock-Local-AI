const assert = require("node:assert/strict");
const test = require("node:test");
const { runExperiment, EXPERIMENTS, BOUNDS, DEFAULTS, suggestExperiments, experimentCoverage } = require("./physics_sandbox.cjs");

test("every registered experiment runs and returns measured values beside theory", () => {
  for (const experiment of EXPERIMENTS) {
    const result = runExperiment({ experiment });
    assert.equal(result.schema, "hemlock.experiment.result.v1");
    assert.equal(result.experiment, experiment);
    assert.ok(result.measured && typeof result.measured === "object");
    assert.ok(result.theory && typeof result.theory === "object");
    assert.ok(Number.isFinite(result.steps) && result.steps > 0);
    assert.ok(Number.isFinite(result.computeMs));
  }
});

test("results are deterministic — identical specs produce identical measured values", () => {
  const a = runExperiment({ experiment: "pendulum", input: { length: 2, gravity: 9.81, releaseDeg: 20 } });
  const b = runExperiment({ experiment: "pendulum", input: { length: 2, gravity: 9.81, releaseDeg: 20 } });
  assert.deepEqual(a.measured, b.measured);
  assert.deepEqual(a.input, b.input);
});

test("undisturbed experiments stay within tolerance of closed-form theory", () => {
  const projectile = runExperiment({ experiment: "projectile", input: { velocity: 20, angleDeg: 45, gravity: 9.81, mass: 1 } });
  assert.ok(projectile.divergence.worst < 0.02, `projectile divergence ${projectile.divergence.worst}`);
  const pendulum = runExperiment({ experiment: "pendulum", input: { length: 1, gravity: 9.81, releaseDeg: 10 } });
  assert.ok(pendulum.divergence.worst < 0.02, `pendulum divergence ${pendulum.divergence.worst}`);
  const spring = runExperiment({ experiment: "spring", input: { mass: 1, stiffness: 40, displacement: 0.3 } });
  assert.ok(spring.divergence.worst < 0.02, `spring divergence ${spring.divergence.worst}`);
  const orbit = runExperiment({ experiment: "orbit", input: { altitude: 400000, centralMass: 5.972e24 } });
  assert.ok(orbit.divergence.worst < 0.02, `orbit divergence ${orbit.divergence.worst}`);
});

test("omitted inputs default to the undisturbed case, not the range midpoint", () => {
  const result = runExperiment({ experiment: "projectile", input: { velocity: 10, angleDeg: 45, gravity: 9.81, mass: 1 } });
  assert.equal(result.input.drag, 0);
  const spring = runExperiment({ experiment: "spring", input: { mass: 1, stiffness: 10, displacement: 0.2 } });
  assert.equal(spring.input.damping, 0);
});

test("out-of-range parameters are clamped with honest notes", () => {
  const result = runExperiment({ experiment: "projectile", input: { velocity: 5000, angleDeg: 45, gravity: 9.81, mass: 1, drag: 0 } });
  assert.equal(result.input.velocity, BOUNDS.projectile.velocity[1]);
  assert.ok(result.clampNotes.some((note) => note.includes("velocity clamped")));
});

test("unknown experiments fail loudly instead of inventing a result", () => {
  assert.throws(() => runExperiment({ experiment: "warp-drive" }), /Unknown experiment/);
});

test("non-numeric parameter values fail naming the valid range", () => {
  assert.throws(() => runExperiment({ experiment: "pendulum", input: { length: "very long" } }), /pendulum\.length must be a finite number in \[0\.1, 10\]/);
  assert.throws(() => runExperiment({ experiment: "pendulum", input: { length: "very long" } }), (error) => error.code === "INVALID_EXPERIMENT_INPUT");
});

test("unknown parameter names fail naming the valid inputs", () => {
  assert.throws(
    () => runExperiment({ experiment: "pendulum", input: { velocity: 3 } }),
    /pendulum has no input "velocity"\. Valid inputs: length, gravity, releaseDeg, damping\./,
  );
});

test("non-object input fails instead of silently running defaults", () => {
  assert.throws(() => runExperiment({ experiment: "pendulum", input: 42 }), /pendulum input must be an object/);
  assert.throws(() => runExperiment({ experiment: "pendulum", input: [1, 2] }), /pendulum input must be an object/);
});

test("absent or null parameters still fall back to the undisturbed default", () => {
  const result = runExperiment({ experiment: "pendulum", input: { length: null, gravity: 5 } });
  assert.equal(result.input.length, DEFAULTS.pendulum.length);
  assert.equal(result.input.gravity, 5);
});

test("drag changes measured projectile results away from the vacuum theory", () => {
  const clean = runExperiment({ experiment: "projectile", input: { velocity: 20, angleDeg: 45, gravity: 9.81, mass: 1, drag: 0 } });
  const dragged = runExperiment({ experiment: "projectile", input: { velocity: 20, angleDeg: 45, gravity: 9.81, mass: 1, drag: 0.1 } });
  assert.ok(dragged.measured.range < clean.measured.range);
  assert.ok(dragged.divergence.worst > clean.divergence.worst);
});

test("collision conserves momentum within float noise", () => {
  const result = runExperiment({ experiment: "collision", input: { massA: 2, massB: 1, velocityA: 5, velocityB: -1, restitution: 1 } });
  assert.ok(Math.abs(result.measured.momentumAfter - result.measured.momentumBefore) < 1e-9);
});

test("terminal velocity converges to the closed-form value", () => {
  const result = runExperiment({ experiment: "terminal", input: { mass: 80, dragCoefficient: 1, area: 0.7, gravity: 9.81, height: 2000 } });
  assert.ok(result.divergence.worst < 0.05);
});

const EXPECTED_AXES = { projectile: ["x", "y"], pendulum: ["theta"], spring: ["x"], orbit: ["x", "y"], collision: ["xa", "xb"], terminal: ["y", "v"] };

test("every experiment emits a bounded replayable trail of real samples", () => {
  for (const experiment of EXPERIMENTS) {
    const result = runExperiment({ experiment });
    assert.ok(result.trail, `${experiment} has no trail`);
    assert.deepEqual(result.trail.axes, EXPECTED_AXES[experiment]);
    assert.ok(result.trail.points.length >= 2 && result.trail.points.length <= 96, `${experiment} trail ${result.trail.points.length}pts`);
    for (const point of result.trail.points) {
      assert.ok(Number.isFinite(point.t));
      for (const axis of result.trail.axes) assert.ok(Number.isFinite(point[axis]), `${experiment} trail point missing ${axis}`);
    }
  }
});

test("trails are deterministic and strictly time-ordered", () => {
  const a = runExperiment({ experiment: "orbit", input: { altitude: 400000 } });
  const b = runExperiment({ experiment: "orbit", input: { altitude: 400000 } });
  assert.deepEqual(a.trail, b.trail);
  const times = a.trail.points.map((point) => point.t);
  assert.deepEqual(times, [...times].sort((x, y) => x - y));
});

test("suggestExperiments with no history ranks every kind as never-run", () => {
  const { suggestions, coverageSummary } = suggestExperiments({ receipts: [], findings: [] });
  assert.equal(suggestions.length, EXPERIMENTS.length);
  for (const kind of EXPERIMENTS) {
    assert.deepEqual(coverageSummary[kind], { runs: 0, findings: 0, hypothesesTested: 0, hypothesesOpen: 0 });
    assert.ok(suggestions.some((s) => s.experiment === kind && /never been run/.test(s.reason)));
    assert.ok(suggestions.find((s) => s.experiment === kind).suggestedInput);
  }
});

test("a declared hypothesis stays open until a finding cites the run id", () => {
  const receipts = [{ id: "exp-abc", experiment: "pendulum", input: { length: 1 }, hypothesis: "longer pendulums swing slower" }];
  const open = suggestExperiments({ receipts, findings: [] });
  assert.equal(open.coverageSummary.pendulum.runs, 1);
  assert.equal(open.coverageSummary.pendulum.hypothesesOpen, 1);
  const openSuggestion = open.suggestions.find((s) => /hypothesis still open/.test(s.reason));
  assert.ok(openSuggestion, "open hypothesis should be suggested");
  assert.equal(openSuggestion.experiment, "pendulum");
  assert.deepEqual(openSuggestion.suggestedInput, { length: 1 });
  const addressed = suggestExperiments({ receipts, findings: [{ experimentId: "exp-abc", experiment: "pendulum" }] });
  assert.equal(addressed.coverageSummary.pendulum.hypothesesTested, 1);
  assert.equal(addressed.coverageSummary.pendulum.hypothesesOpen, 0);
  assert.ok(!addressed.suggestions.some((s) => /hypothesis still open/.test(s.reason)));
});

test("a receipt already marked addressed counts as tested without a citing row", () => {
  const receipts = [{ id: "exp-abc", experiment: "pendulum", input: { length: 1 }, hypothesis: "h", hypothesisOutcome: "addressed" }];
  const { coverageSummary, suggestions } = suggestExperiments({ receipts, findings: [] });
  assert.equal(coverageSummary.pendulum.hypothesesTested, 1);
  assert.ok(!suggestions.some((s) => /hypothesis still open/.test(s.reason)));
});

test("a single-value input region is flagged unexplored with the far endpoint suggested", () => {
  const receipts = [{ id: "exp-abc", experiment: "pendulum", input: { length: 1, gravity: 9.81, releaseDeg: 12, damping: 0 } }];
  const { suggestions } = suggestExperiments({ receipts, findings: [] });
  const gap = suggestions.find((s) => /input region unexplored/.test(s.reason));
  assert.ok(gap, "expected an unexplored-region suggestion");
  assert.equal(gap.experiment, "pendulum");
  // First BOUNDS param (length) wins the span tie; used=1 sits near the low
  // end of [0.1, 10], so the suggestion pushes to the high endpoint.
  assert.equal(gap.suggestedInput.length, BOUNDS.pendulum.length[1]);
  assert.equal(gap.suggestedInput.gravity, DEFAULTS.pendulum.gravity);
});

test("suggestions are deterministic for the same recorded history", () => {
  const receipts = [
    { id: "exp-1", experiment: "pendulum", input: { length: 1 }, hypothesis: "h1" },
    { id: "exp-2", experiment: "projectile", input: { velocity: 10, angleDeg: 45 } },
    { id: "exp-3", experiment: "projectile", input: { velocity: 20, angleDeg: 50 } },
  ];
  const findings = [{ experimentId: "exp-1", experiment: "pendulum" }];
  assert.deepEqual(suggestExperiments({ receipts, findings }), suggestExperiments({ receipts, findings }));
});

test("experimentCoverage counts runs, findings, and hypothesis bookkeeping per kind", () => {
  const receipts = [
    { id: "exp-1", experiment: "orbit", hypothesis: "higher orbits are slower" },
    { id: "exp-2", experiment: "orbit" },
    { id: "exp-3", experiment: "spring", hypothesis: "stiffer springs are faster" },
  ];
  const findings = [
    { experimentId: "exp-1", experiment: "orbit" },
    { experimentId: "exp-2", experiment: "orbit" },
  ];
  const summary = experimentCoverage(receipts, findings);
  assert.deepEqual(summary.orbit, { runs: 2, findings: 2, hypothesesTested: 1, hypothesesOpen: 0 });
  assert.deepEqual(summary.spring, { runs: 1, findings: 0, hypothesesTested: 0, hypothesesOpen: 1 });
  assert.deepEqual(summary.terminal, { runs: 0, findings: 0, hypothesesTested: 0, hypothesesOpen: 0 });
});
