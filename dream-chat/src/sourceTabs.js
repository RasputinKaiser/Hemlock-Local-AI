// Source tab helpers for ArtifactStudio — pure, dependency-free.
// artifact.source is a { filename: contents } map held by the host registry.

export function sourceFileNames(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return [];
  return Object.keys(source).filter((name) => typeof source[name] === "string").sort();
}

// Prefer the requested tab; fall back to the artifact entrypoint, then the
// first file — the strip must never point at a file that no longer exists.
export function resolveActiveFile(source, preferred, entrypoint = null) {
  const names = sourceFileNames(source);
  if (!names.length) return null;
  if (preferred && names.includes(preferred)) return preferred;
  if (entrypoint && names.includes(entrypoint)) return entrypoint;
  return names[0];
}

const encoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;

export function byteLength(text) {
  const value = String(text ?? "");
  if (encoder) return encoder.encode(value).length;
  // Fallback for runtimes without TextEncoder: UTF-8 byte estimate.
  let bytes = 0;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.codePointAt(i);
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (code > 0xffff) i += 1;
  }
  return bytes;
}

export function fileStats(text) {
  const value = String(text ?? "");
  return { bytes: byteLength(value), lines: value.length ? value.split("\n").length : 0 };
}

export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return "0 B";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

// One combined blob for "copy all" — keeps the historical `// name` header
// convention so pasted output still shows provenance per file.
export function combinedSource(source) {
  return sourceFileNames(source).map((name) => `// ${name}\n${source[name]}`).join("\n\n");
}
