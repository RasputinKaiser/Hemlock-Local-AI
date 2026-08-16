const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");

test("preload exposes Maple launch through both desktop surfaces", async () => {
  const exposed = new Map();
  const originalLoad = Module._load;
  Module._load = function mockedLoad(request, parent, isMain) {
    if (request === "electron") {
      return {
        contextBridge: { exposeInMainWorld: (name, api) => exposed.set(name, api) },
        ipcRenderer: {
          invoke: async (channel, ...args) => ({ channel, args }),
          on() {},
          removeListener() {},
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  const preloadPath = path.resolve(__dirname, "preload.cjs");
  delete require.cache[preloadPath];
  try {
    require(preloadPath);
  } finally {
    Module._load = originalLoad;
  }

  const mapleDesktop = exposed.get("mapleDesktop");
  const hemlockAgent = exposed.get("hemlockAgent");
  assert.equal((await mapleDesktop.maple.launch()).channel, "maple:launch");
  assert.equal((await mapleDesktop.launchMaple()).channel, "maple:launch");
  assert.equal((await hemlockAgent.maple.launch()).channel, "maple:launch");
  assert.equal((await hemlockAgent.launchMaple()).channel, "maple:launch");
  assert.equal((await mapleDesktop.agent.reportPreview({ sessionId: "preview-test" })).channel, "agent:preview-report");
  assert.equal((await hemlockAgent.reportPreview({ sessionId: "preview-test" })).channel, "agent:preview-report");
});
