import assert from "node:assert/strict";
import test from "node:test";

// groveScene keeps its world-planning pure and three-free so these tests never
// touch WebGL — determinism of the ambient layout is what is being proven.
import { hashSeed, mulberry32, planGatherSpots, planMarkerSpot, planRoute, trailKeyPoints } from "./groveScene.js";

test("mulberry32 is deterministic and stays in [0, 1)", () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  for (let i = 0; i < 32; i += 1) {
    const value = a();
    assert.equal(value, b());
    assert.ok(value >= 0 && value < 1);
  }
  assert.notEqual(mulberry32(1)(), mulberry32(2)(), "different seeds diverge");
});

test("hashSeed is stable per id and differs across residents", () => {
  assert.equal(hashSeed("maple"), hashSeed("maple"));
  assert.equal(hashSeed(""), hashSeed(null));
  assert.notEqual(hashSeed("maple"), hashSeed("lfm25"));
});

test("trailKeyPoints always includes endpoints and ignores degenerate trails", () => {
  const points = [{ t: 0, x: 0 }, { t: 1, x: 5 }, { t: 2, x: 1 }];
  const keys = trailKeyPoints(points, ["x"], "rail");
  assert.equal(keys[0], 0);
  assert.equal(keys.at(-1), 2);
  assert.equal(trailKeyPoints([], ["x"], "rail").length, 0);
  assert.equal(trailKeyPoints([{ t: 0 }], ["x"], "rail").length, 0);
});

test("trailKeyPoints finds the apex of a plane trail", () => {
  const points = [
    { t: 0, x: 0, y: 0 },
    { t: 1, x: 1, y: 9 },
    { t: 2, x: 2, y: 0 },
  ];
  assert.deepEqual(trailKeyPoints(points, ["x", "y"], "plane"), [0, 1, 2]);
});

test("trailKeyPoints marks both swing extremes of a pendulum", () => {
  const points = [
    { t: 0, theta: 0.2 },
    { t: 1, theta: 0 },
    { t: 2, theta: -0.18 },
    { t: 3, theta: 0.02 },
  ];
  const keys = trailKeyPoints(points, ["theta"], "pendulum");
  assert.ok(keys.includes(0), "release extreme");
  assert.ok(keys.includes(2), "opposite extreme");
  assert.ok(keys.includes(3), "endpoint");
});

test("trailKeyPoints marks closest approach in a collision", () => {
  const points = [
    { t: -1, xa: -5, xb: 5 },
    { t: 0, xa: 0.4, xb: 0.5 },
    { t: 1, xa: 4, xb: -3 },
  ];
  assert.ok(trailKeyPoints(points, ["xa", "xb"], "collision").includes(1));
});

test("trailKeyPoints marks peak speed in a fall", () => {
  const points = [
    { t: 0, y: 10, v: 0 },
    { t: 1, y: 6, v: 8 },
    { t: 2, y: 0, v: 9.5 },
  ];
  assert.ok(trailKeyPoints(points, ["y", "v"], "fall").includes(2));
});

test("planGatherSpots returns a deterministic arc at the requested radius", () => {
  const a = planGatherSpots(3, 2.1, 1.6, { towardX: 0, towardZ: 0 });
  const b = planGatherSpots(3, 2.1, 1.6, { towardX: 0, towardZ: 0 });
  assert.deepEqual(a, b);
  assert.equal(a.length, 3);
  for (const spot of a) {
    assert.ok(Math.abs(Math.hypot(spot.x - 2.1, spot.z - 1.6) - 2.7) < 1e-9);
  }
  assert.equal(planGatherSpots(1, 0, 0).length, 1, "a lone resident still gets a spot");
});

test("planRoute is seeded per resident and stays inside the understory", () => {
  const route = planRoute({ id: "lfm25" });
  assert.deepEqual(route, planRoute({ id: "lfm25" }), "same id, same route");
  assert.notDeepEqual(route, planRoute({ id: "qwen-draft" }), "different ids wander differently");
  for (const spot of route) {
    const radius = Math.hypot(spot.x, spot.z);
    assert.ok(radius >= 8 && radius <= 15);
    assert.ok(spot.dwellMs >= 7000 && spot.dwellMs <= 21000);
  }
});

test("planMarkerSpot honors a host-supplied position and clamps it inside the understory", () => {
  assert.deepEqual(planMarkerSpot({ id: "m1", position: { x: 6.5, z: -4 } }), { x: 6.5, z: -4 });
  const far = planMarkerSpot({ id: "m2", position: { x: 300, z: 0 } });
  assert.ok(Math.hypot(far.x, far.z) <= 30.0001, "positions beyond the lit ring clamp inward");
});

test("planMarkerSpot seeds a deterministic spot when no position was recorded", () => {
  const a = planMarkerSpot({ id: "marker-x", label: "Pendulum clearing" });
  assert.deepEqual(a, planMarkerSpot({ id: "marker-x", label: "Pendulum clearing" }), "same marker, same spot");
  assert.notDeepEqual(a, planMarkerSpot({ id: "marker-y", label: "Pendulum clearing" }), "different ids land elsewhere");
  const radius = Math.hypot(a.x, a.z);
  assert.ok(radius >= 4 && radius <= 18);
});
