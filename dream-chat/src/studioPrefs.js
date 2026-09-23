// Layout/view persistence for ArtifactStudio. Storage is injected so the
// module stays pure and testable; the component passes window.localStorage.

export const STUDIO_PREFS_KEY = "hemlock.artifact.layout";
export const ARTIFACT_VIEWS = ["source", "diff", "preview", "output", "inspect"];
export const PREVIEW_VIEWPORTS = ["fill", "mobile", "tablet", "desktop"];

const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : null;

export function sanitizeStudioPrefs(raw) {
  if (!raw || typeof raw !== "object") return {};
  const prefs = {};
  if (ARTIFACT_VIEWS.includes(raw.artifactView)) prefs.artifactView = raw.artifactView;
  if (PREVIEW_VIEWPORTS.includes(raw.previewViewport)) prefs.previewViewport = raw.previewViewport;
  if (raw.layout && typeof raw.layout === "object") {
    const layout = {};
    for (const key of ["source", "diff", "preview", "evidence"]) {
      const value = finite(raw.layout[key]);
      if (value !== null && value > 0) layout[key] = value;
    }
    if (Object.keys(layout).length) prefs.layout = layout;
  }
  return prefs;
}

export function readStudioPrefs(storage) {
  try {
    return sanitizeStudioPrefs(JSON.parse(storage?.getItem?.(STUDIO_PREFS_KEY) || "{}"));
  } catch {
    return {};
  }
}

export function writeStudioPrefs(storage, prefs) {
  try {
    const clean = sanitizeStudioPrefs(prefs);
    storage?.setItem?.(STUDIO_PREFS_KEY, JSON.stringify(clean));
    return clean;
  } catch {
    return {};
  }
}
