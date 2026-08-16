const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { coerceActionPayload } = require("./agent_contracts.cjs");

function digest(value) { return crypto.createHash("sha256").update(String(value), "utf8").digest("hex"); }

const variations = [
  { id: "css-dom", payload: { input: { source: { "index.html": `<!doctype html><main class="window"><i class="moth"></i></main><style>@keyframes drift{to{transform:translateX(40px)}}.moth{animation:drift 4s infinite}</style>` } } } },
  { id: "svg-botanical", payload: { source: { "index.html": `<!doctype html><svg viewBox="0 0 100 60" aria-label="Moonlit leaves"><circle cx="75" cy="18" r="10"/><path d="M50 58C35 35 40 20 50 8M50 30C32 24 25 14 20 6" fill="none" stroke="currentColor"><animateTransform attributeName="transform" type="rotate" values="-3 50 58;3 50 58;-3 50 58" dur="5s" repeatCount="indefinite"/></path></svg>` } } },
  { id: "canvas-particles", payload: { "index.html": `<!doctype html><canvas id="field" aria-label="Bioluminescent particle field"></canvas><script>const c=document.querySelector('canvas'),x=c.getContext('2d');function draw(t){x.clearRect(0,0,c.width=640);x.fillStyle='#06233a';x.fillRect(0,0,640,360);x.fillStyle='#bdf';for(let i=0;i<18;i++)x.fillRect((i*71+t/30)%640,(i*37)%360,3,3);requestAnimationFrame(draw)}draw(0)</script>` } },
  { id: "kinetic-cards", payload: { source: { "index.html": `<!doctype html><main><article class="card">North</article><article class="card">Current</article><article class="card">Light</article></main><style>main{display:flex;gap:1rem}.card{animation:breathe 3s ease-in-out infinite alternate}@keyframes breathe{to{transform:translateY(-12px) rotate(2deg)}}</style>` } } },
];

const actions = variations.map((variation, index) => coerceActionPayload(variation.payload, {
  taskId: `variation-${variation.id}`,
  step: index + 1,
  commandId: "artifact.author",
  expectedEvidence: ["artifact://revision"],
}));

for (const [index, action] of actions.entries()) {
  assert.equal(action.schema, "hemlock.agent.action.v1");
  assert.equal(action.commandId, "artifact.author");
  assert.equal(typeof action.input.source["index.html"], "string");
  assert.ok(action.input.source["index.html"].length > 80);
  assert.equal(action.taskId, `variation-${variations[index].id}`);
}

const sourceDigests = new Set(actions.map((action) => digest(JSON.stringify(action.input.source))));
const result = { schema: "hemlock.e2e.artistic-variations-fixture.v1", requested: variations.length, passed: actions.length, uniqueSourceCount: sourceDigests.size, diversity: sourceDigests.size === variations.length ? "varied" : "repeated" };
process.stdout.write(`${JSON.stringify(result)}\n`);
