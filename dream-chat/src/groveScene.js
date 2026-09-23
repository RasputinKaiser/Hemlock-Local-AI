// Understory Grove — ambient 3D scene.
//
// Three.js is imported lazily so the shell and node tests never pay for WebGL.
// The scene is an ambient window onto real event bindings: activity levels,
// pulses, grafts, blooms and wind all come from groveBindings. It never decides
// state by itself; callers push bound state in through applyState().

// --- deterministic helpers -------------------------------------------------
// Pure functions with no three dependency so node tests can exercise the
// world's planning without booting WebGL. Everything ambient that needs
// repeatability runs off these seeds rather than Math.random in the hot path.

export function hashSeed(text) {
  let hash = 2166136261 >>> 0;
  const input = String(text ?? "");
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// Indices into a trail's points worth marking: the endpoints always, plus a
// kind-specific landmark — apex for plane curves, both swing extremes for a
// pendulum, closest approach for a collision, peak speed for a fall, the
// largest excursion for a rail. Driven by the measured samples only.
export function trailKeyPoints(points, axes = [], kind = null) {
  const count = points?.length || 0;
  if (count < 2) return [];
  const keys = new Set([0, count - 1]);
  const num = (point, axis) => {
    const value = Number(point?.[axis]);
    return Number.isFinite(value) ? value : 0;
  };
  const argExtreme = (pick) => {
    let best = 0;
    let bestValue = -Infinity;
    for (let i = 0; i < count; i += 1) {
      const value = pick(points[i]);
      if (value > bestValue) { bestValue = value; best = i; }
    }
    return best;
  };
  if (kind === "plane" && axes.length >= 2) {
    keys.add(argExtreme((point) => num(point, axes[1]))); // apex of the flight
  } else if (kind === "pendulum") {
    keys.add(argExtreme((point) => num(point, "theta")));
    keys.add(argExtreme((point) => -num(point, "theta")));
  } else if (kind === "collision") {
    let best = 0;
    let bestGap = Infinity;
    for (let i = 0; i < count; i += 1) {
      const gap = Math.abs(num(points[i], "xa") - num(points[i], "xb"));
      if (gap < bestGap) { bestGap = gap; best = i; }
    }
    keys.add(best);
  } else if (kind === "fall" && axes.length >= 2) {
    keys.add(argExtreme((point) => num(point, axes[1]))); // peak speed
  } else if (kind === "rail" && axes.length) {
    keys.add(argExtreme((point) => Math.abs(num(point, axes[0]))));
  }
  return [...keys].sort((a, b) => a - b);
}

// Arc of spectator spots facing a rig from the clearing side. Deterministic —
// the same rig position always yields the same arc.
export function planGatherSpots(count, centerX, centerZ, { radius = 2.7, towardX = 0, towardZ = 0 } = {}) {
  const spots = [];
  const base = Math.atan2(towardX - centerX, towardZ - centerZ);
  for (let i = 0; i < count; i += 1) {
    const spread = count === 1 ? 0 : (i / (count - 1) - 0.5) * 1.9;
    const angle = base + spread;
    spots.push({ x: centerX + Math.sin(angle) * radius, z: centerZ + Math.cos(angle) * radius });
  }
  return spots;
}

// A world marker's ground spot: the host-supplied position wins (clamped to
// the lit understory); markers without one land on a deterministic seeded spot
// so the same marker id always stands in the same place.
export function planMarkerSpot(marker) {
  const x = Number(marker?.position?.x);
  const z = Number(marker?.position?.z);
  if (Number.isFinite(x) && Number.isFinite(z)) {
    const radius = Math.hypot(x, z);
    const scale = radius > 30 ? 30 / radius : 1;
    return { x: x * scale, z: z * scale };
  }
  const rng = mulberry32(hashSeed(`marker:${marker?.id || ""}:${marker?.label || ""}`));
  const angle = rng() * Math.PI * 2;
  const radius = 4 + rng() * 14;
  return { x: Math.cos(angle) * radius, z: Math.sin(angle) * radius };
}

// A resident's idle route: a couple of lookout points and dwell times, seeded
// by entity id so each figure keeps a consistent personality across frames.
export function planRoute(entry) {
  const rng = mulberry32(hashSeed(entry?.id || "resident"));
  const spots = [];
  for (let i = 0; i < 2; i += 1) {
    const angle = rng() * Math.PI * 2;
    const radius = 8 + rng() * 7;
    spots.push({ x: Math.cos(angle) * radius, z: Math.sin(angle) * radius, dwellMs: 7000 + rng() * 14000 });
  }
  return spots;
}

export async function createGroveScene(canvas, { roster, reducedMotion = false, seed = 0x8511c0de } = {}) {
  const THREE = await import("three");

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x04110e);
  scene.fog = new THREE.FogExp2(0x04110e, 0.028);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.45;

  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 220);
  const cameraState = { theta: -0.35, phi: 0.42, radius: 17, target: new THREE.Vector3(0, 1.6, 0) };

  // Moon + fill light: the forest reads as evergreen silhouettes rimmed in gold.
  const moon = new THREE.DirectionalLight(0xf0dcae, 1.9);
  moon.position.set(-14, 22, -10);
  scene.add(moon);
  scene.add(new THREE.HemisphereLight(0x2a5243, 0x04120d, 1.25));
  const clearing = new THREE.PointLight(0xdfb45f, 3.2, 34, 1.9);
  clearing.position.set(0, 5.5, 4);
  scene.add(clearing);
  const fireflyGlow = new THREE.PointLight(0xe8c57a, 0, 26, 1.8);
  fireflyGlow.position.set(0, 4, 0);
  scene.add(fireflyGlow);
  const emberGlow = new THREE.PointLight(0xd0503c, 0, 18, 2);
  scene.add(emberGlow);
  const labGlow = new THREE.PointLight(0x7ad0c0, 0, 16, 2);
  scene.add(labGlow);

  // Stars.
  {
    const positions = new Float32Array(360 * 3);
    for (let i = 0; i < 360; i += 1) {
      const radius = 90 + Math.random() * 60;
      const theta = Math.random() * Math.PI * 2;
      const y = 12 + Math.random() * 70;
      positions[i * 3] = Math.cos(theta) * radius;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = Math.sin(theta) * radius;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    scene.add(new THREE.Points(geometry, new THREE.PointsMaterial({ color: 0xcfe3d2, size: 0.22, sizeAttenuation: true, transparent: true, opacity: 0.75, fog: false })));
  }

  // All ambient scatter below is seeded — identical layouts every session.
  const ambienceRng = mulberry32(seed >>> 0);

  // Moon disc + halo: a fixed depth anchor above the treeline.
  {
    const moonDisc = new THREE.Mesh(new THREE.CircleGeometry(4.6, 28), new THREE.MeshBasicMaterial({ color: 0xf3e6c2, transparent: true, opacity: 0.85, fog: false }));
    moonDisc.position.set(-52, 46, -74);
    moonDisc.lookAt(0, 10, 0);
    const halo = new THREE.Mesh(new THREE.RingGeometry(5.0, 7.8, 40), new THREE.MeshBasicMaterial({ color: 0xe8c57a, transparent: true, opacity: 0.1, fog: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false }));
    halo.position.copy(moonDisc.position);
    halo.lookAt(0, 10, 0);
    scene.add(moonDisc, halo);
  }

  // Aurora curtains — opacity follows bound.ambience.dream, so the sky only
  // glows while real dream.* events are warm. Sway is a slow rotation, no
  // vertex churn.
  const auroras = [];
  for (const [color, y, z, tilt] of [[0x5ad0b8, 30, -46, 0.3], [0x9ec7ae, 36, -58, 0.22], [0xe8c57a, 42, -68, 0.15]]) {
    const curtain = new THREE.Mesh(new THREE.PlaneGeometry(95, 13), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }));
    curtain.position.set(0, y, z);
    curtain.rotation.x = tilt;
    scene.add(curtain);
    auroras.push(curtain);
  }

  // Foreground understory — low silhouettes between the camera orbit and the
  // clearing, giving the slow drift real parallax. Kept short so they read at
  // the frame edges rather than blocking the residents.
  {
    const bushMaterial = new THREE.MeshStandardMaterial({ color: 0x143326, roughness: 1, flatShading: true });
    const stoneMaterial = new THREE.MeshStandardMaterial({ color: 0x2a3430, roughness: 0.95, flatShading: true });
    for (let i = 0; i < 16; i += 1) {
      const angle = ambienceRng() * Math.PI * 2;
      const radius = 14 + ambienceRng() * 13;
      const size = 0.5 + ambienceRng() * 1.1;
      const bush = new THREE.Mesh(new THREE.IcosahedronGeometry(size, 0), i % 5 === 4 ? stoneMaterial : bushMaterial);
      bush.position.set(Math.cos(angle) * radius, size * 0.3, Math.sin(angle) * radius);
      bush.scale.y = 0.5 + ambienceRng() * 0.3;
      bush.rotation.y = ambienceRng() * Math.PI;
      scene.add(bush);
    }
  }

  // Low mist sheets drifting over the moss — a cheap depth cue.
  const mists = [];
  for (const [r, y, opacity, dir] of [[15, 0.34, 0.055, 1], [23, 0.66, 0.04, -1], [31, 0.95, 0.03, 1]]) {
    const mist = new THREE.Mesh(new THREE.CircleGeometry(r, 40), new THREE.MeshBasicMaterial({ color: 0x9ec7ae, transparent: true, opacity, depthWrite: false }));
    mist.rotation.x = -Math.PI / 2;
    mist.position.y = y;
    scene.add(mist);
    mists.push({ mesh: mist, dir });
  }

  // Ambient particle fields — one buffer each, updated in place per frame.
  // Spores ride the wind, loose fireflies wander the clearing, and ash drifts
  // up only while bound.ambience.alert says failures are fresh.
  const SPORE_COUNT = 240;
  const sporePositions = new Float32Array(SPORE_COUNT * 3);
  const sporeSeeds = new Float32Array(SPORE_COUNT * 4); // x, z, phase, rise
  for (let i = 0; i < SPORE_COUNT; i += 1) {
    sporeSeeds[i * 4] = (ambienceRng() - 0.5) * 52;
    sporeSeeds[i * 4 + 1] = (ambienceRng() - 0.5) * 52;
    sporeSeeds[i * 4 + 2] = ambienceRng() * Math.PI * 2;
    sporeSeeds[i * 4 + 3] = 0.14 + ambienceRng() * 0.45;
    sporePositions[i * 3 + 1] = ambienceRng() * 8.5;
  }
  const sporeGeometry = new THREE.BufferGeometry();
  sporeGeometry.setAttribute("position", new THREE.BufferAttribute(sporePositions, 3));
  const sporeMaterial = new THREE.PointsMaterial({ color: 0xcfe3b2, size: 0.09, sizeAttenuation: true, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false });
  scene.add(new THREE.Points(sporeGeometry, sporeMaterial));

  const WILD_FLY_COUNT = 60;
  const wildFlyPositions = new Float32Array(WILD_FLY_COUNT * 3);
  const wildFlySeeds = new Float32Array(WILD_FLY_COUNT * 4); // anchorX, anchorZ, phase, orbit
  for (let i = 0; i < WILD_FLY_COUNT; i += 1) {
    wildFlySeeds[i * 4] = (ambienceRng() - 0.5) * 34;
    wildFlySeeds[i * 4 + 1] = (ambienceRng() - 0.5) * 34;
    wildFlySeeds[i * 4 + 2] = ambienceRng() * Math.PI * 2;
    wildFlySeeds[i * 4 + 3] = 0.4 + ambienceRng() * 1.1;
    wildFlyPositions[i * 3 + 1] = 0.6 + ambienceRng() * 2.4;
  }
  const wildFlyGeometry = new THREE.BufferGeometry();
  wildFlyGeometry.setAttribute("position", new THREE.BufferAttribute(wildFlyPositions, 3));
  const wildFlyMaterial = new THREE.PointsMaterial({ color: 0xe8c57a, size: 0.14, sizeAttenuation: true, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false });
  scene.add(new THREE.Points(wildFlyGeometry, wildFlyMaterial));

  const ASH_COUNT = 80;
  const ashPositions = new Float32Array(ASH_COUNT * 3);
  const ashSeeds = new Float32Array(ASH_COUNT * 4); // x, z, phase, rise
  for (let i = 0; i < ASH_COUNT; i += 1) {
    ashSeeds[i * 4] = (ambienceRng() - 0.5) * 40;
    ashSeeds[i * 4 + 1] = (ambienceRng() - 0.5) * 40;
    ashSeeds[i * 4 + 2] = ambienceRng() * Math.PI * 2;
    ashSeeds[i * 4 + 3] = 0.5 + ambienceRng() * 0.9;
    ashPositions[i * 3 + 1] = ambienceRng() * 7;
  }
  const ashGeometry = new THREE.BufferGeometry();
  ashGeometry.setAttribute("position", new THREE.BufferAttribute(ashPositions, 3));
  const ashMaterial = new THREE.PointsMaterial({ color: 0xd06a4c, size: 0.11, sizeAttenuation: true, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
  scene.add(new THREE.Points(ashGeometry, ashMaterial));
  const groundGeometry = new THREE.CircleGeometry(46, 72);
  groundGeometry.rotateX(-Math.PI / 2);
  {
    const positions = groundGeometry.attributes.position;
    for (let i = 0; i < positions.count; i += 1) {
      const x = positions.getX(i);
      const z = positions.getZ(i);
      const distance = Math.hypot(x, z);
      positions.setY(i, Math.sin(x * 0.55) * Math.cos(z * 0.5) * 0.16 * Math.min(1, distance / 6));
    }
    groundGeometry.computeVertexNormals();
  }
  scene.add(new THREE.Mesh(groundGeometry, new THREE.MeshStandardMaterial({ color: 0x10301f, roughness: 0.95, metalness: 0 })));

  // Distant treeline silhouettes.
  {
    const ring = new THREE.Group();
    for (let i = 0; i < 26; i += 1) {
      const theta = (i / 26) * Math.PI * 2 + Math.random() * 0.14;
      const radius = 30 + Math.random() * 12;
      const height = 10 + Math.random() * 9;
      const cone = new THREE.Mesh(new THREE.ConeGeometry(height * 0.34, height, 7), new THREE.MeshStandardMaterial({ color: 0x0a2019, roughness: 1 }));
      cone.position.set(Math.cos(theta) * radius, height / 2 - 0.2, Math.sin(theta) * radius);
      ring.add(cone);
    }
    scene.add(ring);
  }

  const barkMaterial = new THREE.MeshStandardMaterial({ color: 0x241a12, roughness: 0.9 });
  const graftMaterial = new THREE.MeshStandardMaterial({ color: 0xf0dcae, emissive: 0xe8c57a, emissiveIntensity: 1.6, roughness: 0.4 });
  const seedMaterial = new THREE.MeshStandardMaterial({ color: 0x9ec7ae, emissive: 0x4c7d63, emissiveIntensity: 0.8, roughness: 0.6 });
  const bloomMaterial = new THREE.MeshStandardMaterial({ color: 0xf0dcae, emissive: 0xe8c57a, emissiveIntensity: 1.2, roughness: 0.5 });

  // A resident: a hooded low-poly figure — tapered robe, mantle, a dim head
  // under a cowl, and a small heartlight set into the chest. Maple stands about
  // 2.3m; drafts barely reach a metre.
  function buildFigure(entry) {
    const height = 0.45 + entry.size * 1.85;
    const group = new THREE.Group();
    const robeMaterial = new THREE.MeshStandardMaterial({ color: entry.hue, roughness: 0.85, flatShading: true });
    const headMaterial = new THREE.MeshStandardMaterial({ color: 0x0c1a14, emissive: entry.hue, emissiveIntensity: 0.35, roughness: 0.6, flatShading: true });
    const heartMaterial = new THREE.MeshStandardMaterial({ color: 0x2a2018, emissive: 0xe8c57a, emissiveIntensity: 0.25, roughness: 0.5, flatShading: true });

    const robe = new THREE.Mesh(new THREE.CylinderGeometry(height * 0.09, height * 0.22, height * 0.78, 7), robeMaterial);
    robe.position.y = height * 0.39;
    group.add(robe);

    // Everything above the waist breathes and leans as one piece.
    const upper = new THREE.Group();
    upper.position.y = height * 0.55;
    group.add(upper);
    const mantle = new THREE.Mesh(new THREE.CylinderGeometry(height * 0.05, height * 0.145, height * 0.16, 7), robeMaterial);
    mantle.position.y = height * 0.19;
    upper.add(mantle);
    const headPivot = new THREE.Group();
    headPivot.position.y = height * 0.26;
    upper.add(headPivot);
    const head = new THREE.Mesh(new THREE.SphereGeometry(height * 0.085, 8, 7), headMaterial);
    head.position.y = height * 0.05;
    const hood = new THREE.Mesh(new THREE.ConeGeometry(height * 0.105, height * 0.2, 7), robeMaterial);
    hood.position.set(0, height * 0.11, -height * 0.02);
    hood.rotation.x = -0.16;
    headPivot.add(head, hood);
    // Arms hang from shoulder pivots so the figure can raise one toward the
    // rig while it works — rotating the mesh itself would swing it around its
    // midpoint.
    const armPivots = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * height * 0.13, height * 0.16, height * 0.02);
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(height * 0.016, height * 0.02, height * 0.3, 5), robeMaterial);
      arm.position.y = -height * 0.11;
      arm.rotation.z = -side * 0.12;
      pivot.add(arm);
      upper.add(pivot);
      armPivots.push(pivot);
    }
    const heart = new THREE.Mesh(new THREE.IcosahedronGeometry(height * 0.032, 0), heartMaterial);
    heart.position.set(0, height * 0.12, height * 0.125);
    upper.add(heart);

    group.position.set(entry.position[0], 0, entry.position[2]);
    // Residents face the clearing's heart; maple faces its bench instead.
    const focus = entry.id === "maple" ? [entry.position[0] + 2.1, entry.position[2] + 1.6] : [0, 0];
    group.rotation.y = Math.atan2(focus[0] - entry.position[0], focus[1] - entry.position[2]);
    scene.add(group);

    // Fireflies orbiting the upper body — the visible signature of live inference.
    const flyCount = 42;
    const positions = new Float32Array(flyCount * 3);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const flies = new THREE.Points(geometry, new THREE.PointsMaterial({ color: 0xe8c57a, size: 0.32, sizeAttenuation: true, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    scene.add(flies);

    const rings = new THREE.Group();
    scene.add(rings);
    rings.position.copy(group.position);

    const grafts = new THREE.Group();
    group.add(grafts);

    // Per-resident temperament, seeded by id: walk speed, wander cadence and
    // idle gaze are stable per figure and never synchronized across the grove.
    const rng = mulberry32(hashSeed(entry.id));

    return {
      entry,
      group,
      upper,
      headPivot,
      headMaterial,
      heartMaterial,
      flies,
      flyPositions: positions,
      flySeeds: Array.from({ length: flyCount }, () => ({ angle: Math.random() * Math.PI * 2, speed: 0.35 + Math.random() * 0.9, radius: height * (0.24 + Math.random() * 0.3), height: height * (0.55 + Math.random() * 0.42), phase: Math.random() * Math.PI * 2 })),
      rings,
      grafts,
      armPivots,
      scale: height,
      home: { x: entry.position[0], z: entry.position[2] },
      phase: entry.position[0] * 1.3 + entry.position[2] * 2.1,
      level: 0,
      emberAt: 0,
      surgeAt: 0,
      rng,
      tempo: 0.75 + rng() * 0.5,
      walkSpeed: 1.0 + rng() * 0.5,
      wanderEvery: 16000 + rng() * 24000,
      nextWanderAt: performance.now() + 9000 + rng() * 22000,
      route: planRoute(entry),
      routeIndex: 0,
      dwellSpot: null,
      dwellUntil: 0,
      gatherUntil: 0,
      gatherSpot: null,
      reactAt: 0,
      mode: "idle",
      walking: false,
      watching: false,
      working: false,
      lookX: focus[0],
      lookZ: focus[1],
      nextLookAt: performance.now() + 3000 + rng() * 9000,
    };
  }

  const figures = new Map((roster || []).map((entry) => [entry.id, buildFigure(entry)]));

  // Maple's lab bench beside the resident — world experiments happen here.
  // It only lights up when a real experiment.* event arrives.
  const mapleFigure = figures.get("maple") || figures.values().next().value;
  let labGroup = null;
  const labOrbMaterial = new THREE.MeshStandardMaterial({ color: 0x7ad0c0, emissive: 0x7ad0c0, emissiveIntensity: 0.45, roughness: 0.3, transparent: true, opacity: 0.92 });
  const labOrb = new THREE.Mesh(new THREE.IcosahedronGeometry(0.17, 0), labOrbMaterial);
  if (mapleFigure) {
    labGroup = new THREE.Group();
    const bench = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.13, 0.66), new THREE.MeshStandardMaterial({ color: 0x4a3a28, roughness: 0.85 }));
    bench.position.y = 0.52;
    const legA = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.52, 0.5), barkMaterial);
    legA.position.set(-0.55, 0.26, 0);
    const legB = legA.clone();
    legB.position.x = 0.55;
    const flask = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.34, 6), labOrbMaterial);
    flask.position.set(-0.42, 0.76, 0.1);
    labOrb.position.set(0.34, 0.8, -0.06);
    labGroup.add(bench, legA, legB, flask, labOrb);
    labGroup.position.set(mapleFigure.group.position.x + 2.1, 0, mapleFigure.group.position.z + 1.6);
    labGroup.rotation.y = -0.5;
    scene.add(labGroup);
    labGlow.position.set(labGroup.position.x, 1.15, labGroup.position.z);
  }

  // Maple's working spot beside the bench: real experiment events walk the
  // figure over, replay holds it there reaching toward the rig, and quiet
  // sends it home. The camera drifts to the bench while evidence plays.
  const cameraHome = cameraState.target.clone();
  let mapleWorkUntil = 0;
  let mapleWorkSpot = null;
  if (mapleFigure && labGroup) {
    const dx = labGroup.position.x - mapleFigure.home.x;
    const dz = labGroup.position.z - mapleFigure.home.z;
    const distance = Math.hypot(dx, dz) || 1;
    mapleWorkSpot = { x: labGroup.position.x - (dx / distance) * 0.9, z: labGroup.position.z - (dz / distance) * 0.9 };
  }

  // Everyone except Maple gets a fixed spectator spot on an arc facing the
  // bench from the clearing side — a real experiment summons them here.
  const residents = [...figures.values()].filter((figure) => figure !== mapleFigure);
  if (labGroup) {
    const spots = planGatherSpots(Math.max(residents.length, 1), labGroup.position.x, labGroup.position.z, { radius: 2.8, towardX: 0, towardZ: 0 });
    residents.forEach((figure, i) => { figure.gatherSpot = spots[i % spots.length]; });
  }

  // Stage ring under the bench: breathes while a replay runs so the lab reads
  // as the grove's spotlight, not just a flashing lamp.
  let labRing = null;
  if (labGroup) {
    labRing = new THREE.Mesh(new THREE.RingGeometry(1.7, 1.98, 48), new THREE.MeshBasicMaterial({ color: 0x7ad0c0, transparent: true, opacity: 0, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }));
    labRing.rotation.x = -Math.PI / 2;
    labRing.position.set(labGroup.position.x, 0.07, labGroup.position.z);
    scene.add(labRing);
  }
  // A single roaming light pinned to the replay head — the trail's lantern.
  const replayGlow = new THREE.PointLight(0x7ad0c0, 0, 11, 2);
  scene.add(replayGlow);

  // Memory garden ring: seeds and blooms planted at the clearing's edge.
  const garden = new THREE.Group();
  scene.add(garden);
  const planted = new Map();

  // Persistent world markers: world.place receipts rendered as glowing
  // waypoints with labels. Each kind keeps its own silhouette — a marker is a
  // lit post, a monument a taller standing stone, a sign a small board — and
  // every mesh is keyed by marker id so state refreshes never duplicate them.
  const markersGroup = new THREE.Group();
  scene.add(markersGroup);
  const placedMarkers = new Map();
  const MARKER_HUES = { marker: 0xe8c57a, monument: 0x7ad0c0, sign: 0x9ec7ae };

  function markerLabelSprite(text) {
    const label = String(text || "").slice(0, 40);
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 96;
    const ctx2d = canvas.getContext("2d");
    ctx2d.font = '600 34px "DM Mono", monospace';
    ctx2d.textAlign = "center";
    ctx2d.textBaseline = "middle";
    ctx2d.lineWidth = 7;
    ctx2d.strokeStyle = "rgba(4, 17, 14, 0.9)";
    ctx2d.strokeText(label, 256, 48);
    ctx2d.fillStyle = "#f0ead7";
    ctx2d.fillText(label, 256, 48);
    const texture = new THREE.CanvasTexture(canvas);
    texture.anisotropy = 4;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }));
    sprite.scale.set(1.7, 0.32, 1);
    return sprite;
  }

  function buildMarker(record) {
    const hue = MARKER_HUES[record.kind] || MARKER_HUES.marker;
    const group = new THREE.Group();
    const postMaterial = new THREE.MeshStandardMaterial({ color: 0x2a2018, roughness: 0.85, flatShading: true });
    const headMaterial = new THREE.MeshStandardMaterial({ color: hue, emissive: hue, emissiveIntensity: 1.4, roughness: 0.4, flatShading: true });
    if (record.kind === "monument") {
      const stone = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.24, 1.15, 5), new THREE.MeshStandardMaterial({ color: 0x2e3f38, roughness: 0.9, flatShading: true }));
      stone.position.y = 0.58;
      const cap = new THREE.Mesh(new THREE.IcosahedronGeometry(0.12, 0), headMaterial);
      cap.position.y = 1.28;
      group.add(stone, cap);
      group.userData.head = cap;
      group.userData.labelY = 1.62;
    } else if (record.kind === "sign") {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, 0.66, 5), postMaterial);
      post.position.y = 0.33;
      const board = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.3, 0.04), new THREE.MeshStandardMaterial({ color: 0x3a4d3c, roughness: 0.8, flatShading: true }));
      board.position.y = 0.72;
      const bead = new THREE.Mesh(new THREE.SphereGeometry(0.045, 6, 5), headMaterial);
      bead.position.set(0.26, 0.86, 0);
      group.add(post, board, bead);
      group.userData.head = bead;
      group.userData.labelY = 1.06;
    } else {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.028, 0.5, 5), postMaterial);
      post.position.y = 0.25;
      const head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.085, 0), headMaterial);
      head.position.y = 0.58;
      const halo = new THREE.Mesh(new THREE.RingGeometry(0.2, 0.26, 28), new THREE.MeshBasicMaterial({ color: hue, transparent: true, opacity: 0.4, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }));
      halo.rotation.x = -Math.PI / 2;
      halo.position.y = 0.06;
      group.add(post, head, halo);
      group.userData.head = head;
      group.userData.labelY = 0.94;
    }
    group.userData.headMaterial = headMaterial;
    const label = markerLabelSprite(record.label);
    label.position.y = group.userData.labelY;
    group.add(label);
    const spot = planMarkerSpot(record);
    group.position.set(spot.x, 0, spot.z);
    group.rotation.y = Math.atan2(-spot.x, -spot.z); // boards and signs face the clearing's heart
    group.scale.setScalar(0.01);
    markersGroup.add(group);
    placedMarkers.set(record.id, { group, bornAt: performance.now(), headMaterial, phase: Math.abs(hashSeed(record.id) % 628) / 100 });
  }

  function syncMarkers(list) {
    const incoming = new Map();
    for (const record of list || []) {
      if (record?.id) incoming.set(record.id, record);
    }
    for (const [id, entry] of placedMarkers) {
      if (incoming.has(id)) continue;
      markersGroup.remove(entry.group);
      entry.group.traverse((object) => { object.geometry?.dispose?.(); object.material?.map?.dispose?.(); object.material?.dispose?.(); });
      placedMarkers.delete(id);
    }
    for (const record of incoming.values()) {
      if (!placedMarkers.has(record.id)) buildMarker(record);
    }
  }

  const state = { wind: 0, tps: null, ambience: { dream: 0, alert: 0, bustle: 0 } };
  const pendingRings = [];
  let labFlashAt = 0;

  function plantBloom(record) {
    if (planted.has(record.id)) return;
    const theta = (planted.size / 18) * Math.PI * 2 + 0.6;
    const radius = 10.5 + (planted.size % 3) * 1.4;
    const isBloom = record.kind === "bloom";
    const mesh = new THREE.Group();
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.03, 0.4, 5), seedMaterial);
    stem.position.y = 0.2;
    mesh.add(stem);
    const head = new THREE.Mesh(isBloom ? new THREE.IcosahedronGeometry(0.16, 0) : new THREE.SphereGeometry(0.07, 6, 5), isBloom ? bloomMaterial : seedMaterial);
    head.position.y = isBloom ? 0.48 : 0.38;
    mesh.add(head);
    mesh.position.set(Math.cos(theta) * radius, 0.06, Math.sin(theta) * radius);
    mesh.scale.setScalar(0.01);
    garden.add(mesh);
    planted.set(record.id, { mesh, bornAt: performance.now() });
  }

  function spawnRing(figure, color = 0xe8c57a) {
    const ring = new THREE.Mesh(new THREE.RingGeometry(figure.scale * 0.3, figure.scale * 0.34, 40), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.1;
    figure.rings.add(ring);
    pendingRings.push({ mesh: ring, bornAt: performance.now() });
  }

  // Dream growth reads as halo whorls around the figure, one per real graft event.
  function growGraft(figure, record) {
    if (figure.graftRecord === record?.type + record?.at) return;
    figure.graftRecord = record?.type + record?.at;
    const count = figure.grafts.children.length;
    if (count >= 5) {
      const old = figure.grafts.children[0];
      figure.grafts.remove(old);
      old.traverse((object) => object.geometry?.dispose?.()); // graftMaterial is shared — only geometry dies
    }
    const pivot = new THREE.Group();
    pivot.position.y = figure.scale * (0.42 + count * 0.1);
    pivot.rotation.y = count * 1.3;
    const halo = new THREE.Mesh(new THREE.TorusGeometry(figure.scale * 0.26, figure.scale * 0.018 + 0.012, 6, 22), graftMaterial);
    halo.rotation.x = Math.PI / 2 + 0.16 + count * 0.09;
    pivot.add(halo);
    figure.grafts.add(pivot);
  }

  // Trajectory replay rig: experiment.completed trails re-animate over the
  // bench, so the scene plays back measured evidence rather than decoration.
  const REPLAY_MS = 3500;
  const REPLAY_FADE_MS = 6000;
  const REPLAY_KINDS = { projectile: "plane", orbit: "plane", pendulum: "pendulum", spring: "rail", collision: "collision", terminal: "fall" };
  const REPLAY_AXES = { projectile: ["x", "y"], orbit: ["x", "y"], pendulum: ["theta"], spring: ["x"], collision: ["xa", "xb"], terminal: ["y", "v"] };
  const seenReplays = new Set();
  let activeReplay = null;

  // Min/max over the named channels combined — collision bodies share one
  // extent so their approach stays honest relative to each other.
  function axisExtent(points, axes) {
    let min = Infinity;
    let max = -Infinity;
    for (const point of points) {
      for (const axis of axes) {
        const value = Number(point?.[axis]);
        if (Number.isFinite(value)) {
          if (value < min) min = value;
          if (value > max) max = value;
        }
      }
    }
    return Number.isFinite(min) && max > min ? { min, span: max - min } : { min: 0, span: 1 };
  }

  function disposeReplay() {
    if (!activeReplay) return;
    scene.remove(activeReplay.root);
    activeReplay.root.traverse((object) => { object.geometry?.dispose?.(); object.material?.dispose?.(); });
    activeReplay = null;
  }

  function startReplay(record) {
    disposeReplay();
    if (!labGroup) return;
    const trail = record?.trail || {};
    const points = (Array.isArray(trail.points) ? trail.points : []).filter((point) => point && Number.isFinite(Number(point.t)));
    if (points.length < 2) return;
    const key = String(record.experiment || "").toLowerCase();
    const axes = Array.isArray(trail.axes) && trail.axes.length ? trail.axes : REPLAY_AXES[key] || Object.keys(points[0]).filter((name) => name !== "t" && Number.isFinite(Number(points[0][name])));
    const kind = REPLAY_KINDS[key]
      || (axes.includes("xa") && axes.includes("xb") ? "collision"
        : axes.includes("theta") ? "pendulum"
          : axes.includes("v") && axes.includes("y") ? "fall"
            : axes.includes("x") && axes.includes("y") ? "plane"
              : axes.length === 1 ? (axes[0] === "y" ? "fall" : "rail") : null);
    if (!kind) return;

    const root = new THREE.Group();
    root.position.copy(labGroup.position);
    root.rotation.y = labGroup.rotation.y;
    const fadables = [];
    const fadable = (material, base) => { fadables.push({ material, base }); return material; };
    const scaffoldMaterial = fadable(new THREE.MeshBasicMaterial({ color: 0x7ad0c0, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false }), 0.22);
    const mote = (color = 0x7ad0c0, opacity = 0.95) => {
      const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(0.05, 0), fadable(new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false }), opacity));
      root.add(mesh);
      return mesh;
    };
    const addRod = (length, x, y, z, rotZ = 0) => {
      const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, length, 5), scaffoldMaterial);
      rod.position.set(x, y, z);
      rod.rotation.z = rotZ;
      root.add(rod);
      return rod;
    };
    const channels = [];
    const ribbons = [];
    // Playback stays faithful to the sampled clock: u follows the trail's own t
    // range, so fast motion still looks fast.
    const t0 = Number(points[0].t);
    const t1 = Number(points.at(-1).t);
    const tn = Float32Array.from(points, (point, i) => (t1 > t0 ? (Number(point.t) - t0) / (t1 - t0) : i / (points.length - 1)));
    const norm = (extent) => (point, axis) => {
      const value = Number(point[axis]);
      return Number.isFinite(value) ? (value - extent.min) / extent.span : 0;
    };
    const addChannel = (place, extra, apply) => {
      const positions = new Float32Array(points.length * 3);
      const extras = extra ? new Float32Array(points.length) : null;
      for (let i = 0; i < points.length; i += 1) {
        const [x, y, z] = place(points[i]);
        positions[i * 3] = x;
        positions[i * 3 + 1] = y;
        positions[i * 3 + 2] = z;
        if (extras) extras[i] = extra(points[i]);
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      const line = new THREE.Line(geometry, fadable(new THREE.LineBasicMaterial({ color: 0x7ad0c0, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }), 0.8));
      root.add(line);
      ribbons.push(geometry);
      // A dim ghost of the whole measured path sits under the drawing ribbon —
      // the audience sees the shape's silhouette before the evidence lands.
      const ghostGeometry = new THREE.BufferGeometry();
      ghostGeometry.setAttribute("position", new THREE.BufferAttribute(positions.slice(), 3));
      root.add(new THREE.Line(ghostGeometry, fadable(new THREE.LineBasicMaterial({ color: 0x7ad0c0, transparent: true, opacity: 0.13, blending: THREE.AdditiveBlending, depthWrite: false }), 0.13)));
      channels.push({ positions, extras, cursor: 0, apply });
    };

    if (kind === "plane") {
      const frame = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.PlaneGeometry(1.6, 1.1)),
        fadable(new THREE.LineBasicMaterial({ color: 0x7ad0c0, transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending, depthWrite: false }), 0.2)
      );
      frame.position.set(0, 1.4, 0);
      root.add(frame);
      const nx = norm(axisExtent(points, [axes[0]]));
      const ny = norm(axisExtent(points, [axes[1]]));
      const marker = mote();
      addChannel((point) => [(nx(point, axes[0]) - 0.5) * 1.6, 0.85 + ny(point, axes[1]) * 1.1, 0.06], null, (x, y, z) => marker.position.set(x, y, z));
    } else if (kind === "rail" || kind === "collision") {
      addRod(1.7, 0, 1.05, 0, Math.PI / 2);
      addRod(0.46, -0.8, 0.82, 0);
      addRod(0.46, 0.8, 0.82, 0);
      if (kind === "rail") {
        const extent = axisExtent(points, [axes[0]]);
        const nx = norm(extent);
        const marker = mote();
        addChannel((point) => [(nx(point, axes[0]) - 0.5) * 1.6, 1.05, 0.06], null, (x, y, z) => marker.position.set(x, y, z));
      } else {
        const extent = axisExtent(points, ["xa", "xb"]);
        const nx = norm(extent);
        const moteA = mote();
        const moteB = mote(0xe8c57a, 0.8);
        addChannel((point) => [(nx(point, "xa") - 0.5) * 1.6, 1.05, 0.06], null, (x, y, z) => moteA.position.set(x, y, z));
        addChannel((point) => [(nx(point, "xb") - 0.5) * 1.6, 1.05, 0.1], null, (x, y, z) => moteB.position.set(x, y, z));
      }
    } else if (kind === "fall") {
      addRod(1.4, 0, 1.3, 0);
      const extent = axisExtent(points, [axes[0]]);
      const ny = norm(extent);
      const marker = mote();
      addChannel((point) => [0, 0.68 + ny(point, axes[0]) * 1.3, 0.06], null, (x, y, z) => marker.position.set(x, y, z));
    } else if (kind === "pendulum") {
      // trail.length is the real string length when present; input.length is
      // what the receipt preserves, so fall back to it before defaulting.
      const length = Number.isFinite(Number(trail.length)) ? Number(trail.length) : Number.isFinite(Number(record.input?.length)) ? Number(record.input.length) : 1;
      const arm = Math.min(0.85, 0.3 + length * 0.12);
      addRod(1.35, 0.7, 1.275, 0);
      addRod(0.78, 0.33, 1.95, 0, Math.PI / 2);
      const armPivot = new THREE.Group();
      armPivot.position.set(0, 1.95, 0.06);
      root.add(armPivot);
      const armGeometry = new THREE.CylinderGeometry(0.012, 0.018, arm, 5);
      armGeometry.translate(0, -arm / 2, 0);
      const armMesh = new THREE.Mesh(armGeometry, scaffoldMaterial);
      armPivot.add(armMesh);
      const bob = new THREE.Mesh(new THREE.IcosahedronGeometry(0.05, 0), fadable(new THREE.MeshBasicMaterial({ color: 0x7ad0c0, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }), 0.95));
      bob.position.y = -arm;
      armPivot.add(bob);
      const thetaOf = (point) => Math.max(-1.35, Math.min(1.35, Number(point.theta) || 0));
      // Rotating the pivot about z swings (0,-arm) to (sin·arm, -cos·arm) — the
      // same arc the ribbon draws from the real samples.
      addChannel((point) => { const theta = thetaOf(point); return [Math.sin(theta) * arm, 1.95 - Math.cos(theta) * arm, 0.06]; }, thetaOf, (x, y, z, theta) => { armPivot.rotation.z = theta; });
    }

    // The lead channel's head is what residents watch: apply() always receives
    // root-local coordinates, so tracking it is transform math, not guessing.
    const focus = new THREE.Vector3();
    const lead = channels[0];
    if (lead) {
      const inner = lead.apply;
      lead.apply = (x, y, z, extra) => { inner(x, y, z, extra); focus.set(x, y, z); };
    }

    // Landmark motes on the measured trail — endpoints always, plus the
    // kind-specific extremum (apex, swing extremes, contact, peak speed).
    const keyMotes = [];
    if (lead) {
      for (const index of trailKeyPoints(points, axes, kind)) {
        const marker = mote(0xe8c57a, 0.9);
        marker.scale.setScalar(0.72);
        marker.position.set(lead.positions[index * 3], lead.positions[index * 3 + 1], lead.positions[index * 3 + 2]);
        keyMotes.push(marker);
      }
    }

    scene.add(root);
    activeReplay = { root, tn, count: points.length, channels, ribbons, fadables, keyMotes, focusLocal: focus, startedAt: performance.now() };
    labFlashAt = performance.now(); // the replay is the lab event made visible
    mapleWorkUntil = performance.now() + REPLAY_MS + REPLAY_FADE_MS + 1500; // hold Maple at the bench through the whole evidence
  }

  // Pointer controls: drag to orbit, wheel to dolly. Clamped and quiet.
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  const onDown = (event) => { dragging = true; lastX = event.clientX; lastY = event.clientY; canvas.setPointerCapture?.(event.pointerId); };
  const onMove = (event) => {
    if (!dragging) return;
    cameraState.theta -= (event.clientX - lastX) * 0.005;
    cameraState.phi = Math.min(1.15, Math.max(0.15, cameraState.phi - (event.clientY - lastY) * 0.004));
    lastX = event.clientX; lastY = event.clientY;
  };
  const onUp = () => { dragging = false; };
  const onWheel = (event) => { event.preventDefault(); cameraState.radius = Math.min(40, Math.max(7, cameraState.radius + event.deltaY * 0.02)); };
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });

  let visible = true;
  const observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; }, { threshold: 0.05 });
  observer.observe(canvas);

  function resize() {
    const width = canvas.clientWidth || 1;
    const height = canvas.clientHeight || 1;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas);
  resize();

  const seenPulses = new Set();
  const seenBlooms = new Set();
  const scratchVec = new THREE.Vector3();
  const replayFocusVec = new THREE.Vector3();
  let focusFigure = null;
  let focusUntil = 0;
  let dolly = 0;
  let lastNowMs = 0;
  let raf = 0;

  function frame(nowMs) {
    raf = requestAnimationFrame(frame);
    if (!visible) return;
    const t = nowMs / 1000;
    const dt = Math.min(0.06, lastNowMs ? Math.max(0.001, (nowMs - lastNowMs) / 1000) : 0.016);
    lastNowMs = nowMs;
    const amb = state.ambience;

    if (!reducedMotion && !dragging) cameraState.theta += 0.00045;
    // Focus priority: a live replay outranks a user-picked resident, which
    // outranks the clearing's heart.
    const focusing = focusFigure && nowMs < focusUntil;
    const focusTarget = activeReplay && labGroup ? labGroup.position : focusing ? focusFigure.group.position : cameraHome;
    const lift = activeReplay ? 1.3 : focusing ? focusFigure.scale * 0.7 : 0;
    scratchVec.set(focusTarget.x, focusTarget.y + lift, focusTarget.z);
    cameraState.target.lerp(scratchVec, activeReplay ? 0.05 : focusing ? 0.04 : 0.018);
    dolly += ((activeReplay ? -3.4 : focusing ? -2 : 0) - dolly) * 0.03;
    const { theta, phi, target } = cameraState;
    const radius = clamp(cameraState.radius + dolly, 6, 42);
    camera.position.set(target.x + Math.cos(theta) * Math.cos(phi) * radius, target.y + Math.sin(phi) * radius, target.z + Math.sin(theta) * Math.cos(phi) * radius);
    camera.lookAt(target);

    // The replay head in world space — what every watcher tracks. The root
    // transform is position + yaw only, so this is manual rotation, not
    // a matrix update or allocation.
    let replayFocus = null;
    if (activeReplay?.focusLocal) {
      const cos = Math.cos(activeReplay.root.rotation.y);
      const sin = Math.sin(activeReplay.root.rotation.y);
      replayFocusVec.set(
        activeReplay.root.position.x + activeReplay.focusLocal.x * cos + activeReplay.focusLocal.z * sin,
        activeReplay.root.position.y + activeReplay.focusLocal.y,
        activeReplay.root.position.z - activeReplay.focusLocal.x * sin + activeReplay.focusLocal.z * cos
      );
      replayFocus = replayFocusVec;
    }

    let strongest = 0;
    let strongestFigure = null;
    for (const figure of figures.values()) {
      // --- locomotion: real work pins residents to posts, quiet ones stroll
      // seeded routes, and a live lab event summons the grove to the bench.
      const isMaple = figure === mapleFigure;
      const working = Boolean(isMaple && mapleWorkSpot && (nowMs < mapleWorkUntil || activeReplay));
      const summoned = Boolean(!isMaple && figure.gatherSpot && (nowMs < figure.gatherUntil || activeReplay));
      figure.working = working;
      figure.watching = Boolean((working || summoned) && activeReplay);
      let dest = figure.home;
      let focusX = null;
      let focusZ = null;
      if (working) {
        dest = mapleWorkSpot;
        focusX = labGroup.position.x;
        focusZ = labGroup.position.z;
      } else if (summoned) {
        dest = figure.gatherSpot;
        focusX = labGroup.position.x;
        focusZ = labGroup.position.z;
      } else if (figure.level < 0.55) {
        if (figure.mode === "dwell") {
          dest = figure.dwellSpot || figure.home;
          if (nowMs >= figure.dwellUntil) {
            figure.mode = "idle";
            figure.nextWanderAt = nowMs + figure.wanderEvery;
          }
        } else {
          if (figure.mode !== "stroll" && nowMs >= figure.nextWanderAt) figure.mode = "stroll";
          if (figure.mode === "stroll") {
            dest = figure.route[figure.routeIndex];
            focusX = dest.x;
            focusZ = dest.z;
          }
        }
      }
      const gx = figure.group.position.x;
      const gz = figure.group.position.z;
      const dx = dest.x - gx;
      const dz = dest.z - gz;
      const distance = Math.hypot(dx, dz);
      figure.walking = distance > 0.08;
      if (figure.walking) {
        const step = Math.min(distance, figure.walkSpeed * dt * (0.85 + figure.level * 0.35));
        figure.group.position.x = gx + (dx / distance) * step;
        figure.group.position.z = gz + (dz / distance) * step;
        if (!reducedMotion) figure.group.position.y = Math.abs(Math.sin(t * 8 * figure.tempo)) * Math.min(0.05, distance * 0.4);
        if (distance > 0.5) { focusX = gx + dx; focusZ = gz + dz; } // face the walk, not the destination
      } else {
        if (figure.mode === "stroll") {
          const spot = figure.route[figure.routeIndex];
          figure.mode = "dwell";
          figure.dwellSpot = spot;
          figure.dwellUntil = nowMs + spot.dwellMs;
          figure.routeIndex = (figure.routeIndex + 1) % figure.route.length;
        }
        figure.group.position.y *= 0.82;
        // Idle gaze drifts to a seeded point every few seconds — personality,
        // not a synchronized loop.
        if (focusX === null) {
          if (!reducedMotion && nowMs >= figure.nextLookAt) {
            figure.nextLookAt = nowMs + 3500 + figure.rng() * 8000;
            const angle = figure.rng() * Math.PI * 2;
            figure.lookX = gx + Math.sin(angle) * 6;
            figure.lookZ = gz + Math.cos(angle) * 6;
          }
          focusX = figure.lookX;
          focusZ = figure.lookZ;
        }
      }
      if (focusX !== null && focusX !== undefined) {
        const desired = Math.atan2(focusX - figure.group.position.x, focusZ - figure.group.position.z);
        const turn = Math.atan2(Math.sin(desired - figure.group.rotation.y), Math.cos(desired - figure.group.rotation.y));
        figure.group.rotation.y += turn * (figure.walking ? 0.12 : 0.045);
      }

      // --- cosmetics -------------------------------------------------------
      const surge = figure.surgeAt ? Math.max(0, 1 - (nowMs - figure.surgeAt) / 2400) : 0;
      const reactAge = figure.reactAt ? nowMs - figure.reactAt : Infinity;
      const react = reactAge < 1400 ? 1 - reactAge / 1400 : 0;
      const breathe = reducedMotion ? 0 : Math.sin(t * (0.85 + figure.level * 0.5) + figure.phase) * (0.014 + figure.level * 0.02);
      figure.upper.scale.setScalar(1 + breathe);
      figure.upper.rotation.z = reducedMotion ? 0 : Math.sin(t * 0.5 + figure.phase) * (0.006 + state.wind * 0.03);
      figure.upper.rotation.x = reducedMotion ? 0 : surge * 0.09 + (figure.walking ? 0.06 : 0);
      // Head: idle sway by default; a live replay pins watchers to the moving
      // evidence head.
      let headYaw = reducedMotion ? 0 : Math.sin(t * 0.42 + figure.phase * 1.7) * (0.06 + figure.level * 0.05);
      let headPitch = 0;
      if (figure.watching && replayFocus) {
        const hx = replayFocus.x - figure.group.position.x;
        const hz = replayFocus.z - figure.group.position.z;
        const worldYaw = Math.atan2(hx, hz) - figure.group.rotation.y;
        headYaw = clamp(Math.atan2(Math.sin(worldYaw), Math.cos(worldYaw)), -0.9, 0.9);
        headPitch = clamp(Math.atan2(replayFocus.y - figure.scale * 0.8, Math.hypot(hx, hz)) * 0.6, -0.4, 0.55);
      }
      figure.headPivot.rotation.y += (headYaw - figure.headPivot.rotation.y) * 0.09;
      figure.headPivot.rotation.x += (headPitch - figure.headPivot.rotation.x) * 0.09;
      figure.headPivot.rotation.z = reducedMotion ? 0 : Math.sin(t * 0.33 + figure.phase) * 0.03;
      // Outcome reaction: a small hop and raised arm when evidence lands.
      if (react > 0) {
        if (!reducedMotion) figure.group.position.y += Math.sin(Math.min(1, reactAge / 480) * Math.PI) * 0.06;
        const arm = figure.armPivots[0];
        arm.rotation.x += (-0.9 * react - arm.rotation.x) * 0.18;
      } else {
        figure.armPivots[0].rotation.x *= 0.92;
      }
      if (isMaple) {
        const reach = activeReplay ? -1.05 : figure.working ? -0.3 : 0;
        const arm = figure.armPivots[1];
        arm.rotation.x += (reach - arm.rotation.x) * 0.08;
      }
      // Live work lifts the ember rim on the head and the heartlight.
      figure.headMaterial.emissiveIntensity += (0.35 + figure.level * 0.9 + surge * 1.8 + react * 1.2 - figure.headMaterial.emissiveIntensity) * 0.12;
      figure.heartMaterial.emissiveIntensity += (0.25 + figure.level * 1.8 + surge * 2.2 + react * 2.6 - figure.heartMaterial.emissiveIntensity) * 0.12;

      const speed = 0.4 + figure.level * 1.1 + (state.tps ? Math.min(1.2, state.tps / 40) : 0);
      const positions = figure.flyPositions;
      for (let i = 0; i < figure.flySeeds.length; i += 1) {
        const seed = figure.flySeeds[i];
        const angle = seed.angle + t * seed.speed * speed;
        const base = figure.group.position;
        positions[i * 3] = base.x + Math.cos(angle) * seed.radius;
        positions[i * 3 + 1] = seed.height + Math.sin(t * 1.7 + seed.phase) * 0.5;
        positions[i * 3 + 2] = base.z + Math.sin(angle) * seed.radius;
      }
      figure.flies.geometry.attributes.position.needsUpdate = true;
      // Watchers dim their own fireflies — attention reads as quiet.
      figure.flies.material.opacity = Math.min(0.95, figure.level * 0.9 + 0.06) * (figure.watching && !isMaple ? 0.35 : 1);

      if (!reducedMotion) {
        const halos = figure.grafts.children;
        for (let i = 0; i < halos.length; i += 1) halos[i].rotation.y = t * (0.3 + i * 0.09);
      }

      if (figure.level > strongest) { strongest = figure.level; strongestFigure = figure; }

      const emberAge = nowMs - figure.emberAt;
      if (figure.emberAt && emberAge < 2600) {
        emberGlow.position.set(figure.group.position.x, figure.scale * 0.55, figure.group.position.z);
        emberGlow.intensity = Math.max(emberGlow.intensity, 4 * (1 - emberAge / 2600));
      }
    }
    if (strongestFigure) {
      scratchVec.set(strongestFigure.group.position.x, strongestFigure.scale * 0.65, strongestFigure.group.position.z);
      fireflyGlow.position.lerp(scratchVec, 0.05);
      fireflyGlow.intensity += (strongest * 2.4 - fireflyGlow.intensity) * 0.08;
    }
    emberGlow.intensity *= 0.92;

    const labAge = nowMs - labFlashAt;
    if (labAge < 3200) {
      const fade = 1 - labAge / 3200;
      labGlow.intensity = Math.max(labGlow.intensity, 5.5 * fade);
      labOrbMaterial.emissiveIntensity = 0.45 + 2.6 * fade;
    } else {
      labGlow.intensity *= 0.9;
      labOrbMaterial.emissiveIntensity += (0.45 - labOrbMaterial.emissiveIntensity) * 0.06;
    }
    labOrb.rotation.y = reducedMotion ? labOrb.rotation.y : t * 0.6;
    labOrb.position.y = 0.8 + (reducedMotion ? 0 : Math.sin(t * 1.3) * 0.045);
    if (labRing) {
      const ringTarget = activeReplay ? 0.3 + Math.sin(t * 3.1) * 0.08 : labAge < 3200 ? 0.2 * (1 - labAge / 3200) : 0;
      labRing.material.opacity += (ringTarget - labRing.material.opacity) * 0.1;
      if (!reducedMotion) labRing.rotation.z = t * 0.15;
    }
    // Stage lighting: the clearing dims while evidence plays.
    clearing.intensity += ((activeReplay ? 2.2 : 3.2) - clearing.intensity) * 0.04;

    // Replay playback: reveal the ribbon along real t, hold, then let the whole
    // evidence fade. Reduced motion draws the full ribbon instantly.
    if (activeReplay) {
      const replay = activeReplay;
      const elapsed = nowMs - replay.startedAt;
      const u = reducedMotion ? 1 : Math.min(1, elapsed / REPLAY_MS);
      for (const channel of replay.channels) {
        while (channel.cursor < replay.count - 2 && replay.tn[channel.cursor + 1] <= u) channel.cursor += 1;
        const i = channel.cursor;
        const a = i * 3;
        const b = a + 3;
        const span = replay.tn[i + 1] - replay.tn[i];
        const f = span > 0 ? Math.min(1, Math.max(0, (u - replay.tn[i]) / span)) : 1;
        channel.apply(
          channel.positions[a] + (channel.positions[b] - channel.positions[a]) * f,
          channel.positions[a + 1] + (channel.positions[b + 1] - channel.positions[a + 1]) * f,
          channel.positions[a + 2] + (channel.positions[b + 2] - channel.positions[a + 2]) * f,
          channel.extras ? channel.extras[i] + (channel.extras[i + 1] - channel.extras[i]) * f : 0
        );
      }
      const drawn = Math.max(2, Math.round(u * (replay.count - 1)) + 1);
      for (const geometry of replay.ribbons) geometry.setDrawRange(0, drawn);
      for (let i = 0; i < replay.keyMotes.length; i += 1) replay.keyMotes[i].scale.setScalar(0.72 + (reducedMotion ? 0 : Math.sin(t * 4.2 + i * 1.7) * 0.18));
      const fade = reducedMotion ? Math.max(0, 1 - elapsed / REPLAY_FADE_MS) : elapsed <= REPLAY_MS ? 1 : Math.max(0, 1 - (elapsed - REPLAY_MS) / REPLAY_FADE_MS);
      if (fade !== replay.fade) {
        replay.fade = fade;
        for (const { material, base } of replay.fadables) material.opacity = base * fade;
      }
      // The lantern light rides the head of the trail.
      if (replayFocus) {
        replayGlow.position.copy(replayFocus);
        replayGlow.intensity += (3.4 * fade - replayGlow.intensity) * 0.25;
      }
      if (fade <= 0) {
        // Evidence landed: watchers react, the lab flashes its verdict once.
        for (const figure of figures.values()) {
          if (figure === mapleFigure) continue;
          if (figure.watching || nowMs < figure.gatherUntil) figure.reactAt = nowMs;
        }
        labFlashAt = nowMs;
        disposeReplay();
      }
    }
    if (!activeReplay) replayGlow.intensity *= 0.85;

    for (let i = pendingRings.length - 1; i >= 0; i -= 1) {
      const ring = pendingRings[i];
      const age = (nowMs - ring.bornAt) / 2200;
      if (age >= 1) { ring.mesh.parent?.remove(ring.mesh); ring.mesh.geometry.dispose(); ring.mesh.material.dispose(); pendingRings.splice(i, 1); continue; }
      ring.mesh.scale.setScalar(1 + age * 3.2);
      ring.mesh.material.opacity = 0.85 * (1 - age);
    }
    for (const { mesh, bornAt } of planted.values()) {
      const age = Math.min(1, (nowMs - bornAt) / 1400);
      mesh.scale.setScalar(0.01 + age * 0.99);
    }
    for (const marker of placedMarkers.values()) {
      const age = Math.min(1, (nowMs - marker.bornAt) / 1600);
      marker.group.scale.setScalar(0.01 + age * 0.99);
      marker.headMaterial.emissiveIntensity = 1.2 + (reducedMotion ? 0 : Math.sin(t * 1.8 + marker.phase) * 0.45);
    }

    // Ambient field — seeded drift, bound ambience drives opacity. Ambience
    // animates; it never claims evidence.
    sporeMaterial.opacity = 0.28 + amb.bustle * 0.3;
    for (let i = 0; i < SPORE_COUNT; i += 1) {
      const si = i * 4;
      const pi = i * 3;
      const phase = sporeSeeds[si + 2];
      sporePositions[pi] = sporeSeeds[si] + Math.sin(t * 0.22 + phase) * 1.4 + state.wind * Math.sin(t * 0.5 + phase) * 3.4;
      sporePositions[pi + 1] = 0.25 + ((sporeSeeds[si + 3] * t + phase * 1.4) % 8.5);
      sporePositions[pi + 2] = sporeSeeds[si + 1] + Math.cos(t * 0.19 + phase) * 1.4;
    }
    sporeGeometry.attributes.position.needsUpdate = true;

    wildFlyMaterial.opacity = 0.26 + amb.bustle * 0.4;
    for (let i = 0; i < WILD_FLY_COUNT; i += 1) {
      const si = i * 4;
      const pi = i * 3;
      const phase = wildFlySeeds[si + 2];
      const orbit = wildFlySeeds[si + 3];
      wildFlyPositions[pi] = wildFlySeeds[si] + Math.cos(t * 0.5 + phase) * orbit + Math.sin(t * 0.11 + phase) * 1.8;
      wildFlyPositions[pi + 1] = 0.6 + orbit + Math.sin(t * 0.8 + phase * 2) * 0.35;
      wildFlyPositions[pi + 2] = wildFlySeeds[si + 1] + Math.sin(t * 0.44 + phase) * orbit;
    }
    wildFlyGeometry.attributes.position.needsUpdate = true;

    // Ash only matters while fresh failures say so; updates skip when dark.
    ashMaterial.opacity += (amb.alert * 0.5 - ashMaterial.opacity) * 0.05;
    if (ashMaterial.opacity > 0.01) {
      for (let i = 0; i < ASH_COUNT; i += 1) {
        const si = i * 4;
        const pi = i * 3;
        const phase = ashSeeds[si + 2];
        ashPositions[pi] = ashSeeds[si] + Math.sin(t * 0.6 + phase) * 1.1;
        ashPositions[pi + 1] = 0.3 + ((ashSeeds[si + 3] * t + phase) % 7);
        ashPositions[pi + 2] = ashSeeds[si + 1] + Math.cos(t * 0.5 + phase) * 1.1;
      }
      ashGeometry.attributes.position.needsUpdate = true;
    }

    // Aurora: the sky breathes while real dream work is warm.
    for (let i = 0; i < auroras.length; i += 1) {
      const curtain = auroras[i];
      curtain.material.opacity = amb.dream * (0.1 + i * 0.02) * (0.7 + 0.3 * Math.sin(t * 0.12 + i * 2.1));
      if (!reducedMotion) curtain.rotation.z = Math.sin(t * 0.05 + i) * 0.04;
    }
    if (!reducedMotion) {
      for (const { mesh, dir } of mists) {
        mesh.position.x = Math.sin(t * 0.03 * dir) * 2.6;
        mesh.position.z = Math.cos(t * 0.022 * dir) * 2.6;
      }
    }

    renderer.render(scene, camera);
  }
  raf = requestAnimationFrame(frame);

  return {
    applyState(bound) {
      if (!bound) return;
      state.wind = bound.wind || 0;
      state.tps = bound.telemetry?.tokensPerSecond ?? null;
      if (bound.ambience) state.ambience = bound.ambience;
      for (const [id, figure] of figures) {
        const slot = bound.activity?.get?.(id);
        if (!slot) continue;
        figure.level += (slot.level - figure.level) * 0.35;
        for (const pulse of slot.pulses || []) {
          const key = `${id}:${pulse.kind}:${pulse.at}`;
          if (seenPulses.has(key)) continue;
          seenPulses.add(key);
          if (pulse.kind === "ember") { figure.emberAt = performance.now(); spawnRing(figure, 0xd0503c); }
          if (pulse.kind === "bloom-ring") spawnRing(figure);
          if (pulse.kind === "lab-work") mapleWorkUntil = Math.max(mapleWorkUntil, performance.now() + 14000);
          if (pulse.kind === "lab-flash") {
            labFlashAt = performance.now();
            figure.surgeAt = performance.now();
            mapleWorkUntil = Math.max(mapleWorkUntil, performance.now() + 14000);
            spawnRing(figure, 0x7ad0c0);
            // The outcome lands: anyone already gathered reacts.
            for (const other of residents) {
              if (performance.now() < other.gatherUntil || other.watching) other.reactAt = performance.now();
            }
          }
          if (pulse.kind === "lab-seed") { mapleWorkUntil = Math.max(mapleWorkUntil, performance.now() + 9000); spawnRing(figure, 0x9ec7ae); }
          if (pulse.kind === "place") spawnRing(figure, 0x9ec7ae);
          // Only a fresh summons moves a resident — a stale event spine must
          // not teleport the grove to the bench.
          if (pulse.kind === "gather" && Date.now() - pulse.at < 45000) {
            figure.gatherUntil = Math.max(figure.gatherUntil, performance.now() + 32000);
          }
        }
        const graft = bound.grafts?.get?.(id);
        if (graft) growGraft(figure, graft);
      }
      for (const bloom of bound.blooms || []) {
        if (seenBlooms.has(bloom.id)) continue;
        seenBlooms.add(bloom.id);
        plantBloom(bloom);
      }
      syncMarkers(bound.markers);
      // Latest unseen experiment replaces whatever is in flight — the newest
      // evidence wins over a stale replay.
      let latestReplay = null;
      for (const record of bound.experiments || []) {
        if (!record?.id || seenReplays.has(record.id)) continue;
        seenReplays.add(record.id);
        latestReplay = record;
      }
      if (latestReplay) startReplay(latestReplay);
    },
    // Pan the camera to a resident for a few seconds — the bindings panel
    // calls this so a row click visits the actual figure.
    focusOn(id) {
      const figure = figures.get(id);
      if (!figure) return false;
      focusFigure = figure;
      focusUntil = performance.now() + 7000;
      return true;
    },
    resize,
    dispose() {
      cancelAnimationFrame(raf);
      observer.disconnect();
      resizeObserver.disconnect();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("wheel", onWheel);
      scene.traverse((object) => {
        object.geometry?.dispose?.();
        if (object.material) (Array.isArray(object.material) ? object.material : [object.material]).forEach((material) => { material.map?.dispose?.(); material.dispose(); });
      });
      renderer.dispose();
    },
  };
}
