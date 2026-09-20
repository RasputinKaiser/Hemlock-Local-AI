const assert = require("node:assert/strict");
const test = require("node:test");
const { runExperiment, EXPERIMENTS, BOUNDS } = require("./physics_sandbox.cjs");

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
