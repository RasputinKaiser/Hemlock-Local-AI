import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { importJsx } from "./testSupport/jsxLoader.js";

const { ArtifactStudio } = await importJsx(new URL("./windows/ArtifactStudio.jsx", import.meta.url));

const noop = () => {};
const baseCtx = (overrides = {}) => ({
  artifacts: [],
  activeArtifactId: null,
  previewConsoleLines: [],
  previewInspection: null,
  previewSession: null,
  previewNotice: "",
  previewSrc: "",
  previewViewport: "fill",
  artifactView: "preview",
  artifactLayout: { source: 0.68, diff: 0.88, preview: 1.48, evidence: 168 },
  artifactCompare: null,
  artifactReviseDraft: "",
  artifactReviseBusy: false,
  artifactFocusPreview: false,
  artifactFreeze: false,
  artifactPinned: false,
  isDesktop: true,
  isThinking: false,
  task: { status: "running" },
  runArtifact: async () => null,
  confirmDialog: async () => false,
  setPreviewNotice: noop,
  setArtifactView: noop,
  setPreviewViewport: noop,
  setArtifactCompare: noop,
  setArtifactReviseDraft: noop,
  setArtifactFreeze: noop,
  setArtifactPinned: noop,
  setArtifactFocusPreview: noop,
  setPreviewConsoleLines: noop,
  openWindow: noop,
  ...overrides,
});

const artifact = {
  id: "a1",
  title: `Revise the task artifact "Night Garden" (artifactId: a1). Instruction: add stars`,
  kind: "html",
  mime: "text/html",
  entrypoint: "index.html",
  status: "ready",
  revision: 2,
  digest: "sha256:abc",
  source: { "index.html": "<main>hi</main>", "style.css": "main { color: #fff }" },
  revisions: [
    { id: "r1", revision: 1, digest: "sha256:111", status: "ready", source: {} },
    { id: "r2", revision: 2, digest: "sha256:222", status: "drafting", source: {} },
  ],
  evidence: [],
};

test("studio renders file tabs, palette and revision badges", () => {
  const html = renderToStaticMarkup(React.createElement(ArtifactStudio, { ctx: baseCtx({ artifacts: [artifact], activeArtifactId: "a1" }) }));
  // Title hygiene: envelope stripped for the heading, full title in tooltip.
  assert.match(html, /<h2 title="[^"]*artifactId[^"]*">Night Garden<\/h2>/);
  assert.match(html, /source-tab-strip/);
  assert.match(html, /index\.html/);
  assert.match(html, /style\.css/);
  assert.match(html, /preview-palette/);
  assert.match(html, /rev-dot/);
});

test("host fallback evidence renders the placeholder banner", () => {
  const flagged = { ...artifact, evidence: [{ type: "authoring.host_fallback", reason: "no usable envelope" }] };
  const html = renderToStaticMarkup(React.createElement(ArtifactStudio, { ctx: baseCtx({ artifacts: [flagged], activeArtifactId: "a1" }) }));
  assert.match(html, /artifact-banner-fallback/);
  assert.match(html, /Placeholder content/);
});

test("repair evidence renders the subtler recovered note when it is the latest signal", () => {
  const repaired = { ...artifact, evidence: [
    { type: "authoring.host_fallback", reason: "scaffold" },
    { type: "authoring.repaired_source", reason: "repair pass" },
  ] };
  const html = renderToStaticMarkup(React.createElement(ArtifactStudio, { ctx: baseCtx({ artifacts: [repaired], activeArtifactId: "a1" }) }));
  assert.match(html, /artifact-banner-repaired/);
  assert.doesNotMatch(html, /artifact-banner-fallback/);
});

test("send-errors button appears only when the preview console has errors", () => {
  const clean = renderToStaticMarkup(React.createElement(ArtifactStudio, { ctx: baseCtx({ artifacts: [artifact], activeArtifactId: "a1" }) }));
  assert.doesNotMatch(clean, /send-errors-action/);
  const noisy = renderToStaticMarkup(React.createElement(ArtifactStudio, {
    ctx: baseCtx({ artifacts: [artifact], activeArtifactId: "a1", previewConsoleLines: [{ level: "error", message: "boom", time: "1" }] }),
  }));
  assert.match(noisy, /send-errors-action/);
  assert.match(noisy, /Send 1 error to Maple/);
});

test("studio degrades gracefully with no artifact and a minimal ctx", () => {
  const html = renderToStaticMarkup(React.createElement(ArtifactStudio, { ctx: { artifacts: [], previewConsoleLines: [], artifactLayout: {}, task: {} } }));
  assert.match(html, /Artifact Studio/);
  assert.match(html, /No task-scoped artifact yet/);
});
