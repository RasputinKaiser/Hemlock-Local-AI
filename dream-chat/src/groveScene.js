// Understory Grove — ambient 3D scene.
//
// Three.js is imported lazily so the shell and node tests never pay for WebGL.
// The scene is an ambient window onto real event bindings: activity levels,
// pulses, grafts, blooms and wind all come from groveBindings. It never decides
// state by itself; callers push bound state in through applyState().

export async function createGroveScene(canvas, { roster, reducedMotion = false } = {}) {
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

  // Moss floor with soft height noise.
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

  // Memory garden ring: seeds and blooms planted at the clearing's edge.
  const garden = new THREE.Group();
  scene.add(garden);
  const planted = new Map();

  const state = { wind: 0, tps: null };
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

    scene.add(root);
    activeReplay = { root, tn, count: points.length, channels, ribbons, fadables, startedAt: performance.now() };
    labFlashAt = performance.now(); // the replay is the lab event made visible
    mapleWorkUntil = performance.now() + REPLAY_MS + 3000; // hold Maple at the bench through the replay
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
  let raf = 0;

  function frame(nowMs) {
    raf = requestAnimationFrame(frame);
    if (!visible) return;
    const t = nowMs / 1000;

    if (!reducedMotion && !dragging) cameraState.theta += 0.00045;
    const focusTarget = activeReplay && labGroup ? labGroup.position : cameraHome;
    scratchVec.set(focusTarget.x, focusTarget.y + (activeReplay ? 1.3 : 0), focusTarget.z);
    cameraState.target.lerp(scratchVec, activeReplay ? 0.05 : 0.018);
    const { theta, phi, radius, target } = cameraState;
    camera.position.set(target.x + Math.cos(theta) * Math.cos(phi) * radius, target.y + Math.sin(phi) * radius, target.z + Math.sin(theta) * Math.cos(phi) * radius);
    camera.lookAt(target);

    let strongest = 0;
    let strongestFigure = null;
    for (const figure of figures.values()) {
      const surge = figure.surgeAt ? Math.max(0, 1 - (nowMs - figure.surgeAt) / 2400) : 0;
      const breathe = reducedMotion ? 0 : Math.sin(t * (0.85 + figure.level * 0.5) + figure.phase) * (0.014 + figure.level * 0.02);
      figure.upper.scale.setScalar(1 + breathe);
      figure.upper.rotation.z = reducedMotion ? 0 : Math.sin(t * 0.5 + figure.phase) * (0.006 + state.wind * 0.03);
      figure.upper.rotation.x = reducedMotion ? 0 : surge * 0.09;
      figure.headPivot.rotation.y = reducedMotion ? 0 : Math.sin(t * 0.42 + figure.phase * 1.7) * (0.06 + figure.level * 0.05);
      figure.headPivot.rotation.z = reducedMotion ? 0 : Math.sin(t * 0.33 + figure.phase) * 0.03;
      // Live work lifts the ember rim on the head and the heartlight.
      figure.headMaterial.emissiveIntensity += (0.35 + figure.level * 0.9 + surge * 1.8 - figure.headMaterial.emissiveIntensity) * 0.12;
      figure.heartMaterial.emissiveIntensity += (0.25 + figure.level * 1.8 + surge * 2.2 - figure.heartMaterial.emissiveIntensity) * 0.12;

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
      figure.flies.material.opacity = Math.min(0.95, figure.level * 0.9 + 0.06);

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

    // Maple locomotion: work events hold it at the bench reaching toward the
    // rig; quiet walks it home. Ambient posture only — no invented activity.
    if (mapleFigure && mapleWorkSpot) {
      const working = nowMs < mapleWorkUntil || Boolean(activeReplay);
      const spot = working ? mapleWorkSpot : mapleFigure.home;
      const gx = mapleFigure.group.position.x;
      const gz = mapleFigure.group.position.z;
      const dx = spot.x - gx;
      const dz = spot.z - gz;
      const distance = Math.hypot(dx, dz);
      if (distance > 0.01) {
        mapleFigure.group.position.x = gx + dx * Math.min(1, 0.05 + distance * 0.01);
        mapleFigure.group.position.z = gz + dz * Math.min(1, 0.05 + distance * 0.01);
        if (!reducedMotion) mapleFigure.group.position.y = Math.abs(Math.sin(t * 7)) * Math.min(0.05, distance * 0.06);
      } else if (mapleFigure.group.position.y !== 0) {
        mapleFigure.group.position.y *= 0.8;
      }
      const facing = working
        ? Math.atan2(labGroup.position.x - mapleFigure.group.position.x, labGroup.position.z - mapleFigure.group.position.z)
        : Math.atan2(2.1, 1.6);
      const turn = Math.atan2(Math.sin(facing - mapleFigure.group.rotation.y), Math.cos(facing - mapleFigure.group.rotation.y));
      mapleFigure.group.rotation.y += turn * 0.06;
      const reach = activeReplay ? -1.05 : working ? -0.3 : 0;
      const arm = mapleFigure.armPivots[1];
      arm.rotation.x += (reach - arm.rotation.x) * 0.08;
    }

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
      const fade = reducedMotion ? Math.max(0, 1 - elapsed / REPLAY_FADE_MS) : elapsed <= REPLAY_MS ? 1 : Math.max(0, 1 - (elapsed - REPLAY_MS) / REPLAY_FADE_MS);
      if (fade !== replay.fade) {
        replay.fade = fade;
        for (const { material, base } of replay.fadables) material.opacity = base * fade;
      }
      if (fade <= 0) disposeReplay();
    }

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

    renderer.render(scene, camera);
  }
  raf = requestAnimationFrame(frame);

  return {
    applyState(bound) {
      if (!bound) return;
      state.wind = bound.wind || 0;
      state.tps = bound.telemetry?.tokensPerSecond ?? null;
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
          if (pulse.kind === "lab-flash") { labFlashAt = performance.now(); figure.surgeAt = performance.now(); mapleWorkUntil = Math.max(mapleWorkUntil, performance.now() + 14000); spawnRing(figure, 0x7ad0c0); }
          if (pulse.kind === "lab-seed") { mapleWorkUntil = Math.max(mapleWorkUntil, performance.now() + 9000); spawnRing(figure, 0x9ec7ae); }
        }
        const graft = bound.grafts?.get?.(id);
        if (graft) growGraft(figure, graft);
      }
      for (const bloom of bound.blooms || []) {
        if (seenBlooms.has(bloom.id)) continue;
        seenBlooms.add(bloom.id);
        plantBloom(bloom);
      }
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
        if (object.material) (Array.isArray(object.material) ? object.material : [object.material]).forEach((material) => material.dispose());
      });
      renderer.dispose();
    },
  };
}
