// Living-chrome motion: FLIP geometry morphs for window state changes.
// Everything is transform/opacity on the compositor — bounds stay in React
// state untouched; we only animate the visual delta between two rects.

export function reducedMotion() {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// Gentle-overshoot settle for geometry; quick expo-out for fades.
export const GEOMETRY_EASE = "cubic-bezier(.22, 1.12, .3, 1)";
export const FADE_EASE = "cubic-bezier(.16, 1, .3, 1)";

const fine = (rect) => rect && rect.width > 0 && rect.height > 0;

// Play a transform from rect `prev` to the element's committed layout rect.
// `prev` should be the visually-correct prior rect — if an earlier FLIP was
// mid-flight, pass the animated rect so the new tween continues smoothly.
export function flipRect(el, prev, { duration = 340, extra = {} } = {}) {
  if (!el || reducedMotion() || !fine(prev)) return null;
  el.getAnimations?.().forEach((animation) => animation.cancel());
  const next = el.getBoundingClientRect();
  if (!fine(next)) return null;
  const dx = prev.left - next.left;
  const dy = prev.top - next.top;
  const sx = prev.width / next.width;
  const sy = prev.height / next.height;
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(sx - 1) < 0.005 && Math.abs(sy - 1) < 0.005) return null;
  el.animate([
    { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, ...extra.from },
    { transform: "translate(0, 0) scale(1, 1)", ...extra.to },
  ], { duration, easing: GEOMETRY_EASE, ...extra.options });
  return next;
}

// Minimize morph: the window collapses into its dock item before the state
// update unmounts it. Returns a promise that resolves when it is safe to hide.
export function morphToDock(el, dockEl, { duration = 300 } = {}) {
  if (!el || !dockEl || reducedMotion()) return Promise.resolve();
  const from = el.getBoundingClientRect();
  const to = dockEl.getBoundingClientRect();
  if (!fine(from) || !fine(to)) return Promise.resolve();
  const dx = to.left + to.width / 2 - (from.left + from.width / 2);
  const dy = to.top + to.height / 2 - (from.top + from.height / 2);
  const scale = Math.max(0.02, Math.min(to.width / from.width, to.height / from.height));
  const animation = el.animate([
    { transform: "translate(0,0) scale(1)", opacity: 1 },
    { transform: `translate(${dx}px, ${dy}px) scale(${scale})`, opacity: 0.15 },
  ], { duration, easing: GEOMETRY_EASE, fill: "forwards" });
  return animation.finished.catch(() => {});
}

// Open/restore morph: start collapsed at the dock item and grow into place.
export function morphFromDock(el, dockEl, { duration = 380 } = {}) {
  if (!el || !dockEl || reducedMotion()) return null;
  const from = dockEl.getBoundingClientRect();
  const to = el.getBoundingClientRect();
  if (!fine(from) || !fine(to)) return null;
  const dx = from.left + from.width / 2 - (to.left + to.width / 2);
  const dy = from.top + from.height / 2 - (to.top + to.height / 2);
  const scale = Math.max(0.02, Math.min(from.width / to.width, from.height / to.height));
  return el.animate([
    { transform: `translate(${dx}px, ${dy}px) scale(${scale})`, opacity: 0 },
    { transform: "translate(0,0) scale(1)", opacity: 1 },
  ], { duration, easing: GEOMETRY_EASE });
}

// Arrival cue for elements that just entered the UI (transcript receipts,
// messages, notices): a short rise-and-fade that reads as "this just
// happened". One-shot WAAPI on the compositor — React state is never touched,
// and callers should gate on freshness so hydrated history doesn't replay it.
export function arriveIn(el, { duration = 240, dy = 7 } = {}) {
  if (!el || reducedMotion()) return null;
  return el.animate([
    { transform: `translateY(${dy}px)`, opacity: 0 },
    { transform: "translateY(0, 0)", opacity: 1 },
  ], { duration, easing: FADE_EASE });
}

export function windowElement(id) {
  return document.querySelector(`.os-window[data-window-id="${id}"]`);
}

export function dockElement(id) {
  return document.querySelector(`.understory-dock [data-window-id="${id}"]`);
}

// macOS-style dock magnification: scale each item by pointer proximity.
// Writes transforms directly — no React re-render per pointermove.
export function attachDockMagnification(nav, { radius = 120, maxScale = 1.32 } = {}) {
  if (!nav || reducedMotion()) return () => {};
  const items = () => [...nav.querySelectorAll(".dock-item")];
  const onMove = (event) => {
    for (const item of items()) {
      const rect = item.getBoundingClientRect();
      const dist = Math.abs(event.clientX - (rect.left + rect.width / 2));
      const t = Math.max(0, 1 - dist / radius);
      const scale = 1 + (maxScale - 1) * t * t;
      item.style.transform = `translateY(${-10 * t * t}px) scale(${scale})`;
    }
  };
  const onLeave = () => items().forEach((item) => { item.style.transform = ""; });
  nav.addEventListener("pointermove", onMove);
  nav.addEventListener("pointerleave", onLeave);
  return () => { nav.removeEventListener("pointermove", onMove); nav.removeEventListener("pointerleave", onLeave); onLeave(); };
}
