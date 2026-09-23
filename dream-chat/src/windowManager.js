export const WINDOW_SCHEMA = "hemlock.window.state.v2";
export const TITLEBAR_HEIGHT = 42;
export const MIN_VISIBLE_BODY = 80;
export const SNAP_THRESHOLD = 7;
export const CASCADE_STEP = 24;

export const WINDOW_DEFINITIONS = {
  center: { label: "Command Center", preferred: { width: 1180, height: 650 }, minimum: { width: 720, height: 500 } },
  chat: { label: "Chat / Code", preferred: { width: 880, height: 640 }, minimum: { width: 520, height: 480 } },
  threads: { label: "Threads", preferred: { width: 900, height: 580 }, minimum: { width: 560, height: 400 } },
  artifact: { label: "Artifact Studio", preferred: { width: 860, height: 600 }, minimum: { width: 560, height: 400 } },
  activity: { label: "Activity", preferred: { width: 640, height: 440 }, minimum: { width: 460, height: 280 } },
  receipts: { label: "Receipts", preferred: { width: 640, height: 440 }, minimum: { width: 460, height: 280 } },
  sips: { label: "SIPS Control", preferred: { width: 520, height: 420 }, minimum: { width: 360, height: 320 } },
  memory: { label: "Memory Garden", preferred: { width: 520, height: 420 }, minimum: { width: 360, height: 320 } },
  dream: { label: "Dream Lab", preferred: { width: 620, height: 520 }, minimum: { width: 360, height: 320 } },
  map: { label: "Project Map", preferred: { width: 610, height: 420 }, minimum: { width: 360, height: 320 } },
  grove: { label: "Understory Grove", preferred: { width: 820, height: 560 }, minimum: { width: 460, height: 340 } },
  settings: { label: "Settings", preferred: { width: 780, height: 600 }, minimum: { width: 440, height: 400 } },
};

const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;

export function normalizeCanvas(canvas = {}) {
  return {
    width: Math.max(1, finite(canvas.width, 1)),
    height: Math.max(TITLEBAR_HEIGHT + MIN_VISIBLE_BODY, finite(canvas.height, TITLEBAR_HEIGHT + MIN_VISIBLE_BODY)),
  };
}

export function normalizeMinimumSize(size = {}, fallback = { width: 360, height: 320 }) {
  return {
    width: Math.max(1, finite(size.width, fallback.width)),
    height: Math.max(TITLEBAR_HEIGHT + MIN_VISIBLE_BODY, finite(size.height, fallback.height)),
  };
}

export function fitSize(size, minimum, canvas) {
  const bounds = normalizeCanvas(canvas);
  const min = normalizeMinimumSize(minimum);
  return {
    width: Math.max(Math.min(finite(size.width, min.width), bounds.width), Math.min(min.width, bounds.width)),
    height: Math.max(Math.min(finite(size.height, min.height), bounds.height), Math.min(min.height, bounds.height)),
  };
}

export function clampBounds(input = {}, canvas, minimum = { width: 360, height: 320 }) {
  const surface = normalizeCanvas(canvas);
  const min = normalizeMinimumSize(minimum);
  const size = fitSize(input, min, surface);
  const maxX = Math.max(0, surface.width - size.width);
  const maxY = Math.max(0, surface.height - size.height);
  const bodyMaxY = Math.max(TITLEBAR_HEIGHT, surface.height - MIN_VISIBLE_BODY);
  const y = Math.min(Math.max(0, finite(input.y, 0)), Math.min(maxY, Math.max(0, bodyMaxY - TITLEBAR_HEIGHT)));
  return {
    x: Math.min(Math.max(0, finite(input.x, 0)), maxX),
    y,
    width: size.width,
    height: size.height,
  };
}

export function createWindowState(windowId, options = {}) {
  const definition = WINDOW_DEFINITIONS[windowId] || WINDOW_DEFINITIONS.settings;
  const openedAt = options.openedAt || new Date().toISOString();
  const bounds = clampBounds({ ...definition.preferred, ...(options.bounds || {}) }, options.canvas || definition.preferred, definition.minimum);
  return {
    schema: WINDOW_SCHEMA,
    workspaceId: String(options.workspaceId || "workspace-local"),
    windowId,
    state: options.state || "closed",
    minimizedFrom: options.state === "minimized" ? (options.minimizedFrom === "maximized" ? "maximized" : "normal") : null,
    bounds,
    restoreBounds: clampBounds(options.restoreBounds || bounds, options.canvas || definition.preferred, definition.minimum),
    minimumSize: normalizeMinimumSize(definition.minimum),
    zOrder: Math.max(0, Math.floor(finite(options.zOrder, 0))),
    focus: options.focus === true,
    pin: options.pin === true,
    snapTarget: options.snapTarget || null,
    openedAt,
    lastFocusedAt: options.lastFocusedAt || openedAt,
  };
}

export function normalizeState(windowId, value, options = {}) {
  const definition = WINDOW_DEFINITIONS[windowId] || WINDOW_DEFINITIONS.settings;
  const fallback = createWindowState(windowId, options);
  if (!value || typeof value !== "object") return fallback;
  // Once migrated, the canonical state wins over stale v1 booleans retained in
  // the record; otherwise a restored window can minimize itself on next launch.
  const legacyState = value.schema === WINDOW_SCHEMA && ["closed", "normal", "minimized", "maximized"].includes(value.state)
    ? value.state
    : value.state === "minimized" || value.minimized ? "minimized" : value.state === "maximized" || value.maximized ? "maximized" : value.open === false ? "closed" : value.state || "normal";
  const boundsInput = value.bounds || { x: value.x, y: value.y, width: value.width, height: value.height };
  const restoreInput = value.restoreBounds || value.restore || boundsInput;
  const normalized = {
    ...fallback,
    ...value,
    schema: WINDOW_SCHEMA,
    workspaceId: String(value.workspaceId || options.workspaceId || fallback.workspaceId),
    windowId,
    state: ["closed", "normal", "minimized", "maximized"].includes(legacyState) ? legacyState : "closed",
    minimizedFrom: legacyState === "minimized"
      ? (["normal", "maximized"].includes(value.minimizedFrom) ? value.minimizedFrom : value.maximized === true || value.state === "maximized" ? "maximized" : "normal")
      : null,
    bounds: clampBounds(boundsInput, options.canvas || definition.preferred, definition.minimum),
    restoreBounds: clampBounds(restoreInput, options.canvas || definition.preferred, definition.minimum),
    // Minimum dimensions are UI constraints, not user preferences. Refresh them
    // when restoring an older session so new controls cannot be resized away.
    minimumSize: normalizeMinimumSize(definition.minimum),
    zOrder: Math.max(0, Math.floor(finite(value.zOrder ?? value.zIndex, 0))),
    focus: value.focus === true || value.active === true,
    pin: value.pin === true || value.pinned === true,
    snapTarget: value.snapTarget || null,
    openedAt: value.openedAt || fallback.openedAt,
    lastFocusedAt: value.lastFocusedAt || value.focusedAt || fallback.lastFocusedAt,
  };
  return normalized;
}

export function migrateWindowState(stored, options = {}) {
  const source = stored && typeof stored === "object" ? stored : {};
  const workspaceId = String(options.workspaceId || source.workspaceId || "workspace-local");
  const canvas = options.canvas || { width: 1240, height: 700 };
  const ids = Object.keys(WINDOW_DEFINITIONS);
  const migrated = Object.fromEntries(ids.map((id) => [id, normalizeState(id, source[id], { workspaceId, canvas })]));
  const opened = ids.filter((id) => migrated[id].state !== "closed");
  if (!opened.length) migrated.center.state = "normal";
  return normalizeZOrder(migrated, migrated.center.windowId);
}

export function normalizeZOrder(windows, focusedId = null) {
  const entries = Object.entries(windows || {});
  const ordered = entries.sort(([aId, a], [bId, b]) => {
    if (focusedId && aId === focusedId) return 1;
    if (focusedId && bId === focusedId) return -1;
    return (a.zOrder || 0) - (b.zOrder || 0) || String(a.lastFocusedAt).localeCompare(String(b.lastFocusedAt));
  });
  const next = {};
  ordered.forEach(([id, item], index) => {
    next[id] = { ...item, zOrder: index + 1, focus: focusedId ? id === focusedId : item.focus === true };
  });
  return next;
}

export function focusWindow(windows, windowId, now = new Date().toISOString(), canvas = null) {
  if (!windows?.[windowId]) return windows;
  const item = windows[windowId];
  // Re-clamp on focus: a window persisted against an older canvas size (or parked
  // outside the visible surface) must come back on-screen when the user summons it.
  // Without this, clicking the dock item only re-orders z and nothing visibly changes.
  const bounds = canvas ? clampBounds(item.bounds, canvas, item.minimumSize) : item.bounds;
  const state = item.state === "minimized" ? (item.minimizedFrom === "maximized" ? "maximized" : "normal") : item.state;
  // Capture-phase pointer/focus events can both request activation. Avoid a new
  // state tree on every click, but never skip re-clamping or repairing z-order.
  if (item.focus && state === item.state
    && ["x", "y", "width", "height"].every((key) => bounds[key] === item.bounds[key])
    && Object.entries(windows).every(([id, other]) => id === windowId || (!other.focus && other.zOrder < item.zOrder))) return windows;
  return normalizeZOrder({ ...windows, [windowId]: { ...item, state, minimizedFrom: null, bounds, lastFocusedAt: now } }, windowId);
}

function overlaps(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

export function openWindowBounds(windows, windowId, canvas, options = {}) {
  const item = windows?.[windowId];
  if (!item) return windows;
  // Reopening a minimized window is restoration, not a new cascading placement.
  if (item.state === "minimized") return focusWindow(windows, windowId, options.now, canvas);
  const surface = normalizeCanvas(canvas);
  let bounds = clampBounds(item.bounds, surface, item.minimumSize);
  const occupied = Object.values(windows).filter((other) => other.windowId !== windowId && !["closed", "minimized"].includes(other.state));
  if (options.collisionAware !== false && occupied.some((other) => overlaps(bounds, other.bounds))) {
    for (let step = 1; step <= occupied.length + 4; step += 1) {
      const candidate = clampBounds({ ...bounds, x: bounds.x + CASCADE_STEP, y: bounds.y + CASCADE_STEP }, surface, item.minimumSize);
      if (!occupied.some((other) => overlaps(candidate, other.bounds))) { bounds = candidate; break; }
      bounds = candidate;
    }
  }
  return focusWindow({ ...windows, [windowId]: { ...item, state: "normal", bounds, openedAt: item.openedAt || new Date().toISOString() } }, windowId, options.now);
}

export function moveWindow(item, dx, dy, canvas, options = {}) {
  if (!item || item.state === "maximized") return item;
  const next = clampBounds({ ...item.bounds, x: item.bounds.x + dx, y: item.bounds.y + dy }, canvas, item.minimumSize);
  const snapped = options.altKey ? { bounds: next, snapTarget: null } : snapBounds(next, canvas, options);
  return { ...item, bounds: snapped.bounds, snapTarget: snapped.snapTarget };
}

export function resizeWindow(item, edge, dx, dy, canvas, options = {}) {
  if (!item || item.state === "maximized") return item;
  const surface = normalizeCanvas(canvas);
  const start = clampBounds(item.bounds, surface, item.minimumSize);
  const min = fitSize(item.minimumSize, item.minimumSize, surface);
  let left = start.x, top = start.y;
  let right = start.x + start.width, bottom = start.y + start.height;
  // Clamp the moving edge, not the entire rectangle: the opposite edge must
  // stay anchored when resizing against the desktop boundary or minimum size.
  if (edge.includes("left")) left = Math.max(0, Math.min(right - min.width, left + finite(dx, 0)));
  if (edge.includes("right")) right = Math.min(surface.width, Math.max(left + min.width, right + finite(dx, 0)));
  if (edge.includes("top")) top = Math.max(0, Math.min(bottom - min.height, top + finite(dy, 0)));
  if (edge.includes("bottom")) bottom = Math.min(surface.height, Math.max(top + min.height, bottom + finite(dy, 0)));
  return { ...item, bounds: { x: left, y: top, width: right - left, height: bottom - top }, snapTarget: null };
}

export function pointerSnapCommand(x, y, canvas, options = {}) {
  if (options.altKey) return null;
  const surface = normalizeCanvas(canvas);
  if (y <= 12) return "maximize";
  if (x <= 18) return "half-left";
  if (x >= surface.width - 18) return "half-right";
  return null;
}

export function snapBounds(bounds, canvas, options = {}) {
  if (options.altKey || options.enabled === false) return { bounds, snapTarget: null };
  const surface = normalizeCanvas(canvas);
  const targets = [
    { id: "left", bounds: { x: 0, y: 0, width: Math.floor(surface.width / 2), height: surface.height } },
    { id: "right", bounds: { x: Math.ceil(surface.width / 2), y: 0, width: Math.floor(surface.width / 2), height: surface.height } },
    { id: "top", bounds: { x: 0, y: 0, width: surface.width, height: Math.floor(surface.height / 2) } },
    { id: "bottom", bounds: { x: 0, y: Math.ceil(surface.height / 2), width: surface.width, height: Math.floor(surface.height / 2) } },
  ];
  const distances = {
    left: Math.abs(bounds.x),
    right: Math.abs(bounds.x + bounds.width - surface.width),
    top: Math.abs(bounds.y),
    bottom: Math.abs(bounds.y + bounds.height - surface.height),
  };
  const target = targets.find((candidate) => distances[candidate.id] <= SNAP_THRESHOLD);
  return target ? { bounds: clampBounds(target.bounds, surface, { width: 1, height: TITLEBAR_HEIGHT + MIN_VISIBLE_BODY }), snapTarget: target.id } : { bounds, snapTarget: null };
}

export function toggleMaximize(item, canvas) {
  if (!item) return item;
  if (item.state === "maximized") return { ...item, state: "normal", bounds: clampBounds(item.restoreBounds, canvas, item.minimumSize), snapTarget: null };
  return { ...item, state: "maximized", restoreBounds: clampBounds(item.bounds, canvas, item.minimumSize), bounds: clampBounds({ x: 0, y: 0, width: canvas.width, height: canvas.height }, canvas, item.minimumSize), snapTarget: null };
}

export function setWindowState(item, state, canvas) {
  if (!item) return item;
  if (state === "minimized") return { ...item, state: "minimized", minimizedFrom: item.state === "maximized" || (item.state === "minimized" && item.minimizedFrom === "maximized") ? "maximized" : "normal", focus: false };
  if (state === "closed") return { ...item, state: "closed", focus: false };
  if (state === "normal" && item.state === "minimized") return { ...item, state: item.minimizedFrom === "maximized" ? "maximized" : "normal", minimizedFrom: null, bounds: clampBounds(item.bounds, canvas, item.minimumSize) };
  if (state === "normal" && item.state === "maximized") return toggleMaximize(item, canvas);
  return { ...item, state };
}

export function keyboardPlacement(item, command, canvas) {
  if (!item) return item;
  const surface = normalizeCanvas(canvas);
  if (command === "half-left") return { ...item, state: "normal", restoreBounds: item.bounds, bounds: clampBounds({ x: 0, y: 0, width: Math.floor(surface.width / 2), height: surface.height }, surface, item.minimumSize), snapTarget: "left" };
  if (command === "half-right") return { ...item, state: "normal", restoreBounds: item.bounds, bounds: clampBounds({ x: Math.ceil(surface.width / 2), y: 0, width: Math.floor(surface.width / 2), height: surface.height }, surface, item.minimumSize), snapTarget: "right" };
  if (command === "maximize") return item.state === "maximized" ? item : toggleMaximize(item, surface);
  if (command === "restore") return item.state === "minimized" ? setWindowState(item, "normal", surface) : item.state === "maximized" ? toggleMaximize(item, surface) : { ...item, state: "normal", bounds: clampBounds(item.restoreBounds, surface, item.minimumSize) };
  if (command === "minimize") return setWindowState(item, "minimized", surface);
  return item;
}

export function toLegacyRendererShape(item) {
  return item ? {
    ...item,
    id: item.windowId,
    open: item.state !== "closed",
    minimized: item.state === "minimized",
    maximized: item.state === "maximized",
    x: item.bounds.x,
    y: item.bounds.y,
    width: item.bounds.width,
    height: item.bounds.height,
    zIndex: item.zOrder,
    pinned: item.pin,
  } : item;
}
