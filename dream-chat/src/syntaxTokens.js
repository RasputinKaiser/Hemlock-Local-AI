// Dependency-free syntax highlighting for ArtifactStudio source tabs.
// A modest regex tokenizer — a preview aid, not an editor. The contract that
// matters: the returned spans concatenate back to the exact input text.

export const TOKEN_TYPES = ["comment", "string", "keyword", "number", "tag", "attr", "punct", "text"];

const JS_KEYWORDS = "const|let|var|function|return|if|else|for|while|do|class|extends|new|import|export|from|as|default|async|await|try|catch|finally|throw|switch|case|break|continue|typeof|instanceof|in|of|this|null|undefined|true|false|void|delete|yield|static|get|set|super";

const RULES = {
  js: [
    ["comment", /\/\/[^\n]*|\/\*[\s\S]*?\*\//],
    ["string", /'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/],
    ["keyword", new RegExp(`\\b(?:${JS_KEYWORDS})\\b`)],
    ["number", /\b0x[0-9a-fA-F]+\b|\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/],
    ["punct", /=>|===|!==|==|!=|<=|>=|&&|\|\||\+\+|--|\+=|-=|\*=|\/=|\.\.\.|[{}()[\];,.<>=!&|+\-*\/%?:~^@#]/],
  ],
  css: [
    ["comment", /\/\*[\s\S]*?\*\//],
    ["string", /'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*'/],
    ["keyword", /@[\w-]+|!important\b/],
    ["number", /#[0-9a-fA-F]{3,8}\b|\b\d+(?:\.\d+)?(?:px|rem|em|ex|ch|%|vh|vw|vmin|vmax|svh|lvh|s|ms|fr|deg|rad|turn|pt|pc|cm|mm|in|q)?\b/],
    ["attr", /[\w-]+(?=\s*:)/],
    ["punct", /[{}():;,>+~*=\[\]]/],
  ],
  // Tag contents are handled by a second pass in tokenizeTag.
  html: [
    ["comment", /<!--[\s\S]*?(?:-->|$)/],
    ["keyword", /<![\s\S]*?>/],
    ["tagblock", /<\/?[A-Za-z][^>]*>?|<\/?[A-Za-z][\w-]*$/],
  ],
};

const TAG_INNER = [
  ["tag", /^\/?[\w-]+/],
  ["string", /"(?:[^"]*)"|'(?:[^']*)'/],
  ["attr", /[\w-]+(?==)/],
  ["punct", /\/?>$|=/],
];

function compile(defs) {
  const sources = defs.map(([, re]) => `(${re.source})`);
  return new RegExp(sources.join("|"), "g");
}

const compiled = new Map();
function patternFor(lang) {
  if (!compiled.has(lang)) compiled.set(lang, compile(RULES[lang]));
  return compiled.get(lang);
}

function runDefs(defs, code, start, end, out) {
  const re = compile(defs);
  re.lastIndex = 0;
  const slice = code.slice(start, end);
  let cursor = 0;
  let match;
  while ((match = re.exec(slice))) {
    if (match[0].length === 0) { re.lastIndex += 1; continue; }
    if (match.index > cursor) out.push({ type: "text", text: slice.slice(cursor, match.index) });
    const groupIndex = match.slice(1).findIndex((value) => value !== undefined);
    out.push({ type: defs[groupIndex][0], text: match[0] });
    cursor = match.index + match[0].length;
  }
  if (cursor < slice.length) out.push({ type: "text", text: slice.slice(cursor) });
}

function tokenizeTag(text, out) {
  // Strip the angle brackets, then sub-tokenize attributes inside.
  const open = text.match(/^<\/?/)?.[0] || "<";
  const close = text.match(/\/?>$/)?.[0] || "";
  out.push({ type: "tag", text: open });
  const inner = text.slice(open.length, text.length - close.length);
  const innerTokens = [];
  runDefs(TAG_INNER, inner, 0, inner.length, innerTokens);
  out.push(...innerTokens);
  if (close) out.push({ type: "tag", text: close });
}

export function languageForFile(name) {
  const ext = String(name || "").split(".").pop().toLowerCase();
  if (["html", "htm", "svg", "xml"].includes(ext)) return "html";
  if (ext === "css") return "css";
  if (["js", "mjs", "cjs", "jsx", "ts", "tsx", "json"].includes(ext)) return "js";
  return "text";
}

export function tokenize(code, lang) {
  const text = String(code ?? "");
  if (!text) return [];
  if (!RULES[lang]) return [{ type: "text", text }];
  const out = [];
  if (lang === "html") {
    const re = patternFor("html");
    let cursor = 0;
    let match;
    while ((match = re.exec(text))) {
      if (match[0].length === 0) { re.lastIndex += 1; continue; }
      if (match.index > cursor) out.push({ type: "text", text: text.slice(cursor, match.index) });
      const groupIndex = match.slice(1).findIndex((value) => value !== undefined);
      const kind = RULES.html[groupIndex][0];
      if (kind === "tagblock") tokenizeTag(match[0], out);
      else out.push({ type: kind, text: match[0] });
      cursor = match.index + match[0].length;
    }
    if (cursor < text.length) out.push({ type: "text", text: text.slice(cursor) });
    return out;
  }
  runDefs(RULES[lang], text, 0, text.length, out);
  return out;
}
