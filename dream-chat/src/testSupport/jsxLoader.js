import { readFile } from "node:fs/promises";
import { transformWithOxc } from "vite";

const cache = new Map();

// Test-only JSX loader: transforms actual modules and resolves their imports.
// CSS is exercised by browser tests, not injected into the Node renderer.
export async function jsxModuleUrl(url) {
  const key = url.href;
  if (cache.has(key)) return cache.get(key);
  const result = await transformWithOxc(await readFile(url, "utf8"), url.pathname, { jsx: { runtime: "classic" } });
  let code = result.code;
  const imports = [...code.matchAll(/^import\s+(?:[^;]+?\s+from\s+)?["']([^"']+)["'];?$/gm)];
  for (const match of imports) {
    const specifier = match[1];
    if (specifier.endsWith(".css")) { code = code.replace(match[0], ""); continue; }
    const resolved = specifier.startsWith(".") ? new URL(specifier, url) : new URL(import.meta.resolve(specifier));
    const replacement = resolved.pathname.endsWith(".jsx") ? await jsxModuleUrl(resolved) : resolved.href;
    code = code.replace(match[0], match[0].replace(specifier, replacement));
  }
  const dataUrl = `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
  cache.set(key, dataUrl);
  return dataUrl;
}

export async function importJsx(url) { return import(await jsxModuleUrl(url)); }
