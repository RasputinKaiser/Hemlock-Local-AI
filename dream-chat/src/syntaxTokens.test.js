import test from "node:test";
import assert from "node:assert/strict";
import { tokenize, languageForFile } from "./syntaxTokens.js";

const joined = (tokens) => tokens.map((token) => token.text).join("");
const types = (tokens) => [...new Set(tokens.map((token) => token.type))];

test("languageForFile maps extensions to tokenizer lanes", () => {
  assert.equal(languageForFile("index.html"), "html");
  assert.equal(languageForFile("app.css"), "css");
  assert.equal(languageForFile("main.mjs"), "js");
  assert.equal(languageForFile("notes.txt"), "text");
  assert.equal(languageForFile(""), "text");
});

test("tokens always concatenate back to the exact input", () => {
  const samples = [
    ["html", `<!doctype html><main class="x"><!-- c --><p id='p'>hi</p></main>`],
    ["css", `/* c */ .a { color: #fff; margin: 0 auto; width: 50% }`],
    ["js", `const x = "a\\"b"; // tail\nlet y = 0x1f + 2.5;`],
    ["text", "plain <b>text</b> stays flat"],
    ["js", ""],
  ];
  for (const [lang, code] of samples) assert.equal(joined(tokenize(code, lang)), code, lang);
});

test("js lane marks comments, strings, keywords and numbers", () => {
  const tokens = tokenize(`// note\nconst a = "x" + 42;`, "js");
  for (const type of ["comment", "keyword", "number", "string"]) {
    assert.ok(types(tokens).includes(type), `expected a ${type} token`);
  }
  assert.equal(tokens[0].type, "comment");
  assert.ok(tokens.some((token) => token.type === "keyword" && token.text === "const"));
  assert.ok(tokens.some((token) => token.type === "string" && token.text === `"x"`));
  assert.ok(tokens.some((token) => token.type === "number" && token.text === "42"));
});

test("html lane splits tags into tag/attr/string spans", () => {
  const tokens = tokenize(`<a href="/x">go</a>`, "html");
  assert.ok(tokens.some((token) => token.type === "tag" && token.text === "<"));
  assert.ok(tokens.some((token) => token.type === "tag" && token.text === "a"));
  assert.ok(tokens.some((token) => token.type === "attr" && token.text === "href"));
  assert.ok(tokens.some((token) => token.type === "string" && token.text === `"/x"`));
  assert.ok(tokens.some((token) => token.type === "text" && token.text === "go"));
});

test("html comments and unclosed tags do not break coverage", () => {
  for (const code of [`<!-- never closed`, `<div class="o"`, `<p>ok</p>`]) {
    assert.equal(joined(tokenize(code, "html")), code);
  }
});

test("css lane marks comments, hex colors, units and at-rules", () => {
  const tokens = tokenize(`@media (min-width: 40px) { /* c */ color: #fff }`, "css");
  assert.ok(tokens.some((token) => token.type === "keyword" && token.text === "@media"));
  assert.ok(tokens.some((token) => token.type === "comment"));
  assert.ok(tokens.some((token) => token.type === "number" && token.text === "#fff"));
  assert.ok(tokens.some((token) => token.type === "number" && token.text === "40px"));
});

test("unknown languages degrade to a single text span", () => {
  assert.deepEqual(tokenize("<b>x</b>", "text"), [{ type: "text", text: "<b>x</b>" }]);
  assert.deepEqual(tokenize(null, "js"), []);
});
