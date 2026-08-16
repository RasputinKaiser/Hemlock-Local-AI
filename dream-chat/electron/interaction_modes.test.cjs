const assert = require("node:assert/strict");
const test = require("node:test");
const { classifyIntent, hasBuildHandoff, resolveInteraction } = require("./interaction_modes.cjs");

test("visual ideation stays conversational until a build handoff", () => {
  assert.equal(hasBuildHandoff("I want an animation that feels like fog over a garden."), false);
  assert.equal(resolveInteraction({ text: "I want an animation that feels like fog over a garden." }).interactionMode, "explore");
  assert.equal(resolveInteraction({ text: "I want an animation that feels like fog over a garden." }).intent, "conversation");
  assert.equal(resolveInteraction({ text: "Build this as an animation." }).interactionMode, "build");
  assert.equal(classifyIntent("Build this as an animation.", "build"), "coding");
});

test("an explicit interaction mode wins over ambiguous words", () => {
  assert.deepEqual(resolveInteraction({ text: "Create a beautiful page concept", interactionMode: "explore" }), { text: "Create a beautiful page concept", interactionMode: "explore", intent: "conversation" });
  assert.equal(resolveInteraction({ text: "Make the draft", interactionMode: "build" }).intent, "coding");
  assert.equal(resolveInteraction({ text: "Improve the next coding task", interactionMode: "explore" }).intent, "improve");
  assert.equal(resolveInteraction({ text: "Implement this plan" }).interactionMode, "build");
});

test("recognizes natural build requests with a new artifact or app", () => {
  assert.equal(resolveInteraction({ text: "Build a new unique interactive animation artifact called Orbit No. 7." }).interactionMode, "build");
  assert.equal(resolveInteraction({ text: "Build an actual webapp for exploring the archive." }).interactionMode, "build");
  assert.equal(resolveInteraction({ text: "Create the website draft now." }).interactionMode, "build");
  assert.equal(classifyIntent("Build a new unique interactive animation artifact.", "build"), "coding");
});

test("does not treat visual ideation without a build handoff as a task", () => {
  assert.equal(resolveInteraction({ text: "I have an idea for a new interactive animation artifact: a brass planetarium with a slow eclipse." }).interactionMode, "explore");
  assert.equal(resolveInteraction({ text: "Could you create a visual concept for an animation?" }).interactionMode, "explore");
});
