// Deterministic physics sandbox — the world Maple lives in and studies.
//
// Every experiment is host-owned: bounded parameter ranges, fixed timestep,
// seeded noise only where stated, and measured results returned beside the
// closed-form expectation so a finding is verifiable rather than asserted.
// Same input always produces the same output — dataset rows built from these
// results are reproducible evidence, not generated claims.

const EXPERIMENT_SCHEMA = "hemlock.experiment.result.v1";
const MAX_STEPS = 240000;
const DT = 1 / 240;
// Trails are the replayable evidence the world scene animates: a bounded,
// evenly-thinned sample of the real integration — never a drawn curve.
const TRAIL_POINTS = 96;

const EXPERIMENTS = ["projectile", "pendulum", "spring", "orbit", "collision", "terminal"];

function thinTrail(points, limit = TRAIL_POINTS) {
  if (points.length <= limit) return points;
  const stride = points.length / limit;
  const out = [];
  for (let i = 0; i < limit; i += 1) out.push(points[Math.floor(i * stride)]);
  out[out.length - 1] = points.at(-1);
  return out;
}

const BOUNDS = {
  projectile: { velocity: [0.5, 60], angleDeg: [5, 85], gravity: [1, 25], mass: [0.05, 50], drag: [0, 0.5] },
  pendulum: { length: [0.1, 10], gravity: [1, 25], releaseDeg: [2, 60], damping: [0, 0.5] },
  spring: { mass: [0.05, 50], stiffness: [0.5, 500], displacement: [0.01, 2], damping: [0, 2] },
  orbit: { altitude: [160000, 40000000], centralMass: [1e22, 2e30], tangentialFactor: [0.7, 1.3] },
  collision: { massA: [0.05, 100], massB: [0.05, 100], velocityA: [-30, 30], velocityB: [-30, 30], restitution: [0, 1] },
  terminal: { mass: [0.05, 200], dragCoefficient: [0.1, 2], area: [0.01, 3], gravity: [1, 25], height: [10, 5000] },
};

// Omitted inputs default to the undisturbed case (no drag/damping, elastic),
// never the range midpoint — midpoint defaults would silently inject friction
// into an experiment the model did not ask for.
const DEFAULTS = {
  projectile: { velocity: 12, angleDeg: 45, gravity: 9.81, mass: 1, drag: 0 },
  pendulum: { length: 1, gravity: 9.81, releaseDeg: 12, damping: 0 },
  spring: { mass: 1, stiffness: 40, displacement: 0.3, damping: 0 },
  orbit: { altitude: 400000, centralMass: 5.972e24, tangentialFactor: 1 },
  collision: { massA: 2, massB: 1, velocityA: 5, velocityB: 0, restitution: 1 },
  terminal: { mass: 80, dragCoefficient: 1, area: 0.7, gravity: 9.81, height: 2000 },
};

function invalidInput(message) {
  const error = new Error(message);
  error.code = "INVALID_EXPERIMENT_INPUT";
  return error;
}

function clampInputs(experiment, input = {}) {
  const bounds = BOUNDS[experiment];
  if (!bounds) return { input: {}, notes: [`unknown experiment: ${experiment}`] };
  const defaults = DEFAULTS[experiment];
  const notes = [];
  const normalized = {};
  if (input == null) input = {};
  // A finite out-of-range number clamps with an honest note, but a typo'd key
  // or a non-numeric value would silently run defaults — those fail loudly
  // naming what the world actually accepts.
  if (typeof input !== "object" || Array.isArray(input)) {
    throw invalidInput(`${experiment} input must be an object of bounded parameters (${Object.keys(bounds).join(", ")}) — got ${JSON.stringify(input)}.`);
  }
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(bounds, key)) {
      throw invalidInput(`${experiment} has no input "${key}". Valid inputs: ${Object.keys(bounds).join(", ")}.`);
    }
  }
  for (const [key, [min, max]] of Object.entries(bounds)) {
    const provided = input[key];
    if (provided === undefined || provided === null) {
      notes.push(`${key} defaulted to ${defaults[key]}`);
      normalized[key] = defaults[key];
      continue;
    }
    const raw = Number(provided);
    if (!Number.isFinite(raw)) {
      throw invalidInput(`${experiment}.${key} must be a finite number in [${min}, ${max}] — got ${JSON.stringify(provided)}.`);
    }
    const value = Math.min(max, Math.max(min, raw));
    if (value !== raw) notes.push(`${key} clamped to [${min}, ${max}]`);
    normalized[key] = value;
  }
  return { input: normalized, notes };
}

function simulateProjectile({ velocity, angleDeg, gravity, mass, drag }) {
  const angle = (angleDeg * Math.PI) / 180;
  let x = 0, y = 0, vx = velocity * Math.cos(angle), vy = velocity * Math.sin(angle);
  let apex = 0, time = 0, steps = 0;
  const trail = [];
  while (y >= 0 && steps < MAX_STEPS) {
    const speed = Math.hypot(vx, vy);
    const dragAccel = drag > 0 && speed > 0 ? (drag * speed * speed) / mass : 0;
    vx -= dragAccel * (vx / (speed || 1)) * DT;
    vy -= (gravity + dragAccel * (vy / (speed || 1))) * DT;
    x += vx * DT;
    y += vy * DT;
    apex = Math.max(apex, y);
    time += DT;
    steps += 1;
    if (steps % 4 === 0) trail.push({ t: time, x, y });
  }
  const theory = { range: (velocity * velocity * Math.sin(2 * angle)) / gravity, apex: (velocity * velocity * Math.sin(angle) ** 2) / (2 * gravity), flightTime: (2 * velocity * Math.sin(angle)) / gravity };
  const measured = { range: x, apex, flightTime: time, impactSpeed: Math.hypot(vx, vy) };
  return { measured, theory, steps, trail: { axes: ["x", "y"], points: thinTrail(trail) }, energyCheck: drag === 0 ? Math.abs(measured.impactSpeed - velocity) / velocity : null };
}

function simulatePendulum({ length, gravity, releaseDeg, damping }) {
  const release = (releaseDeg * Math.PI) / 180;
  let theta = release, omega = 0, time = 0, steps = 0;
  let crossings = [];
  let lastSign = Math.sign(theta);
  const trail = [];
  while (steps < MAX_STEPS && crossings.length < 4) {
    const accel = -(gravity / length) * Math.sin(theta) - damping * omega;
    omega += accel * DT;
    theta += omega * DT;
    time += DT;
    steps += 1;
    const sign = Math.sign(theta);
    if (sign !== 0 && sign !== lastSign) { crossings.push(time); lastSign = sign; }
    if (steps % 6 === 0) trail.push({ t: time, theta });
  }
  // Crossings 0 and 2 are same-direction passes through the bottom: that gap is
  // already the full period. Two crossings only span half a swing.
  const measuredPeriod = crossings.length >= 3 ? crossings[2] - crossings[0] : crossings.length >= 2 ? 2 * (crossings[1] - crossings[0]) : null;
  const theory = { period: 2 * Math.PI * Math.sqrt(length / gravity) };
  return { measured: { period: measuredPeriod, swingsObserved: Math.max(0, crossings.length - 1) }, theory, steps, trail: { axes: ["theta"], length, points: thinTrail(trail) } };
}

function simulateSpring({ mass, stiffness, displacement, damping }) {
  let x = displacement, v = 0, time = 0, steps = 0;
  let maxSpeed = 0, crossings = [];
  const trail = [];
  while (steps < MAX_STEPS && crossings.length < 4) {
    const accel = (-(stiffness * x) - damping * v) / mass;
    v += accel * DT;
    x += v * DT;
    maxSpeed = Math.max(maxSpeed, Math.abs(v));
    time += DT;
    steps += 1;
    if (v * (v - accel * DT) < 0) crossings.push(time); // velocity sign flip = extreme
    if (steps % 6 === 0) trail.push({ t: time, x });
  }
  const halfPeriod = crossings.length >= 2 ? crossings[1] - crossings[0] : null;
  const theory = { period: 2 * Math.PI * Math.sqrt(mass / stiffness), maxSpeed: displacement * Math.sqrt(stiffness / mass) };
  return { measured: { period: halfPeriod ? 2 * halfPeriod : null, maxSpeed }, theory, steps, trail: { axes: ["x"], points: thinTrail(trail) } };
}

function simulateOrbit({ altitude, centralMass, tangentialFactor }) {
  const G = 6.674e-11;
  const radius = 6371000 + altitude; // Earth-like body reference frame
  const circular = Math.sqrt((G * centralMass) / radius);
  const dt = 0.25; // orbital timescales are long; quarter-second ticks suffice
  let x = radius, y = 0, vx = 0, vy = circular * tangentialFactor;
  let minR = radius, maxR = radius, time = 0, steps = 0;
  const maxT = 2 * Math.PI * Math.sqrt(radius ** 3 / (G * centralMass)) * 2;
  let period = null;
  let prevY = y;
  const trail = [];
  while (time < maxT && steps < MAX_STEPS) {
    const r = Math.hypot(x, y);
    const accel = -(G * centralMass) / (r * r);
    vx += accel * (x / r) * dt;
    vy += accel * (y / r) * dt;
    x += vx * dt;
    y += vy * dt;
    const distance = Math.hypot(x, y);
    minR = Math.min(minR, distance);
    maxR = Math.max(maxR, distance);
    time += dt;
    steps += 1;
    if (prevY < 0 && y >= 0 && x > 0) { period = time; break; } // one full revolution
    prevY = y;
    if (steps % 16 === 0) trail.push({ t: time, x: x - radius, y }); // recentered so the scene sees the shape, not the orbital radius
  }
  const semiMajor = (minR + maxR) / 2;
  const measured = { period, periapsis: minR - 6371000, apoapsis: maxR - 6371000, eccentricity: semiMajor > 0 ? (maxR - minR) / (maxR + minR) : 0 };
  const theory = { circularVelocity: circular, period: 2 * Math.PI * Math.sqrt(radius ** 3 / (G * centralMass)) };
  return { measured, theory, steps, trail: { axes: ["x", "y"], points: thinTrail(trail) } };
}

function simulateCollision({ massA, massB, velocityA, velocityB, restitution }) {
  const vA = (restitution * massB * (velocityB - velocityA) + massA * velocityA + massB * velocityB) / (massA + massB);
  const vB = (restitution * massA * (velocityA - velocityB) + massA * velocityA + massB * velocityB) / (massA + massB);
  const momentumBefore = massA * velocityA + massB * velocityB;
  const momentumAfter = massA * vA + massB * vB;
  const energyBefore = 0.5 * massA * velocityA ** 2 + 0.5 * massB * velocityB ** 2;
  const energyAfter = 0.5 * massA * vA ** 2 + 0.5 * massB * vB ** 2;
  // Analytic sim still yields an honest trail: bodies converge on the contact
  // point (x=0) at their input velocities and leave at the resolved ones.
  const window_ = 2 / Math.max(0.01, Math.abs(velocityA) + Math.abs(velocityB) + Math.abs(vA) + Math.abs(vB));
  const points = [];
  for (let i = 0; i < TRAIL_POINTS; i += 1) {
    const t = -window_ + (2 * window_ * i) / (TRAIL_POINTS - 1);
    points.push({ t, xa: t < 0 ? velocityA * t : vA * t, xb: t < 0 ? 1 + velocityB * t : vB * t });
  }
  return {
    measured: { velocityA: vA, velocityB: vB, momentumBefore, momentumAfter, energyBefore, energyAfter },
    theory: { momentumConserved: true },
    steps: 1,
    trail: { axes: ["xa", "xb"], points },
    energyCheck: (momentumAfter - momentumBefore) / Math.max(1e-9, Math.abs(momentumBefore)),
  };
}

function simulateTerminal({ mass, dragCoefficient, area, gravity, height }) {
  const rho = 1.225;
  const terminalTheory = Math.sqrt((2 * mass * gravity) / (rho * dragCoefficient * area));
  let v = 0, y = height, time = 0, steps = 0;
  let peakSpeed = 0;
  const trail = [];
  while (y > 0 && steps < MAX_STEPS) {
    const drag = (0.5 * rho * dragCoefficient * area * v * v) / mass;
    v += (gravity - drag) * DT;
    y -= v * DT;
    peakSpeed = Math.max(peakSpeed, v);
    time += DT;
    steps += 1;
    if (steps % 32 === 0) trail.push({ t: time, y, v });
  }
  return { measured: { terminalVelocity: v, peakSpeed, fallTime: time }, theory: { terminalVelocity: terminalTheory }, steps, trail: { axes: ["y", "v"], points: thinTrail(trail) } };
}

const SIMULATORS = { projectile: simulateProjectile, pendulum: simulatePendulum, spring: simulateSpring, orbit: simulateOrbit, collision: simulateCollision, terminal: simulateTerminal };

function divergence(measured, theory) {
  const deltas = {};
  for (const [key, expected] of Object.entries(theory || {})) {
    const got = measured?.[key];
    if (!Number.isFinite(got) || !Number.isFinite(expected)) continue;
    deltas[key] = expected === 0 ? Math.abs(got) : Math.abs(got - expected) / Math.abs(expected);
  }
  const values = Object.values(deltas);
  return { fields: deltas, worst: values.length ? Math.max(...values) : null };
}

// One bounded experiment run. Pure: no IO, no clock, no randomness.
function runExperiment(spec = {}) {
  const experiment = String(spec.experiment || "").toLowerCase();
  if (!SIMULATORS[experiment]) {
    const error = new Error(`Unknown experiment "${spec.experiment}". Available: ${EXPERIMENTS.join(", ")}.`);
    error.code = "UNKNOWN_EXPERIMENT";
    throw error;
  }
  const { input, notes } = clampInputs(experiment, spec.input);
  const started = process.hrtime.bigint();
  const result = SIMULATORS[experiment](input);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const diff = divergence(result.measured, result.theory);
  return {
    schema: EXPERIMENT_SCHEMA,
    experiment,
    input,
    measured: result.measured,
    theory: result.theory,
    divergence: diff,
    steps: result.steps,
    clampNotes: notes,
    energyCheck: result.energyCheck ?? null,
    computeMs: Math.round(elapsedMs * 100) / 100,
    trail: result.trail ? { ...result.trail, points: thinTrail(result.trail.points) } : null,
  };
}

// --- Coverage suggestions ----------------------------------------------------
// experiment.suggest reads only recorded run receipts and finding rows, so the
// same history always ranks the same gaps — a suggestion is derived evidence,
// never a model guess.
//
// Hypothesis semantics: a declared hypothesis starts "open" on the receipt and
// becomes "addressed" only when a hemlock.world.finding.v1 row cites that run's
// id (or the receipt was already marked addressed). The host cannot judge a
// natural-language claim, so confirmed/refuted is never a host-computed
// outcome — "addressed" only means a finding exists.

function experimentCoverage(receipts = [], findings = []) {
  const addressed = new Set(findings.map((row) => row?.experimentId).filter(Boolean));
  const summary = {};
  for (const kind of EXPERIMENTS) summary[kind] = { runs: 0, findings: 0, hypothesesTested: 0, hypothesesOpen: 0 };
  for (const row of findings) {
    const kind = String(row?.experiment || "").toLowerCase();
    if (summary[kind]) summary[kind].findings += 1;
  }
  for (const receipt of receipts) {
    const kind = String(receipt?.experiment || "").toLowerCase();
    if (!summary[kind]) continue;
    summary[kind].runs += 1;
    if (receipt.hypothesis) {
      if (addressed.has(receipt.id) || receipt.hypothesisOutcome === "addressed") summary[kind].hypothesesTested += 1;
      else summary[kind].hypothesesOpen += 1;
    }
  }
  return summary;
}

// The least-explored bounded parameter of a run history: smallest fraction of
// its valid range covered, ties broken by fewer distinct values then BOUNDS
// order (deterministic).
function leastExploredParam(kind, runs) {
  const bounds = BOUNDS[kind];
  if (!bounds) return null;
  let worst = null;
  for (const [param, [min, max]] of Object.entries(bounds)) {
    const used = runs.map((run) => Number(run?.input?.[param])).filter(Number.isFinite);
    if (!used.length || !(max > min)) continue;
    const distinct = new Set(used).size;
    const span = (Math.max(...used) - Math.min(...used)) / (max - min);
    if (!worst || span < worst.span || (span === worst.span && distinct < worst.distinct)) {
      worst = { param, min, max, used, distinct, span };
    }
  }
  return worst;
}

// The range endpoint farthest from every recorded value — pushing to an
// extreme is the deterministic choice, never a midpoint guess.
function farthestEndpoint({ min, max, used }) {
  const span = max - min;
  const distance = (point) => Math.min(...used.map((value) => Math.abs((value - min) / span - point)));
  return distance(1) >= distance(0) ? max : min;
}

function suggestExperiments({ receipts = [], findings = [], limit = 12 } = {}) {
  const coverageSummary = experimentCoverage(receipts, findings);
  const addressed = new Set(findings.map((row) => row?.experimentId).filter(Boolean));
  const suggestions = [];
  // Never-run kinds first — zero evidence outranks every refinement.
  for (const kind of EXPERIMENTS) {
    const coverage = coverageSummary[kind];
    if (coverage.runs === 0) {
      suggestions.push({ rank: 0, experiment: kind, reason: `${kind} has never been run — no receipts exist`, suggestedInput: { ...DEFAULTS[kind] }, coverage });
    }
  }
  // Hypotheses declared on a run that no finding ever cited.
  for (const receipt of receipts) {
    const kind = String(receipt?.experiment || "").toLowerCase();
    if (!receipt?.hypothesis || !coverageSummary[kind]) continue;
    if (addressed.has(receipt.id) || receipt.hypothesisOutcome === "addressed") continue;
    suggestions.push({
      rank: 1,
      experiment: kind,
      reason: `hypothesis still open — "${String(receipt.hypothesis).slice(0, 140)}" was declared on ${receipt.id} but no experiment.note cites it`,
      ...(receipt.input && typeof receipt.input === "object" ? { suggestedInput: { ...receipt.input } } : {}),
      coverage: coverageSummary[kind],
    });
  }
  // Kinds that ran but only explored a corner of their bounded input space.
  for (const kind of EXPERIMENTS) {
    const coverage = coverageSummary[kind];
    if (coverage.runs === 0) continue;
    const runs = receipts.filter((receipt) => String(receipt?.experiment || "").toLowerCase() === kind);
    const gap = leastExploredParam(kind, runs);
    if (!gap || !(gap.span < 0.25 || gap.distinct <= 1)) continue;
    const value = farthestEndpoint(gap);
    suggestions.push({
      rank: 2,
      experiment: kind,
      reason: `input region unexplored — ${gap.param} stayed within [${Math.min(...gap.used)}, ${Math.max(...gap.used)}] of the valid [${gap.min}, ${gap.max}] across ${coverage.runs} run(s)`,
      suggestedInput: { ...DEFAULTS[kind], [gap.param]: value },
      coverage,
    });
  }
  const ordered = suggestions
    .sort((a, b) => a.rank - b.rank || a.coverage.runs - b.coverage.runs || a.experiment.localeCompare(b.experiment) || a.reason.localeCompare(b.reason))
    .slice(0, Math.max(1, Math.min(48, Math.round(limit) || 12)))
    .map(({ rank, ...entry }) => entry);
  return { suggestions: ordered, coverageSummary };
}

module.exports = { EXPERIMENT_SCHEMA, EXPERIMENTS, BOUNDS, DEFAULTS, runExperiment, experimentCoverage, suggestExperiments };
