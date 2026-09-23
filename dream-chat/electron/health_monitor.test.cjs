"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

// Stability lane: bounded /health watchdog. The module is injectable so the
// tests drive poll() directly; the source guards at the bottom cover the
// main.cjs wiring (same pattern as crash_policy.test.cjs).
const { createHealthMonitor, DEFAULT_FAILURE_THRESHOLD } = require(path.resolve(__dirname, "health_monitor.cjs"));

function harness({ active = true, failures = Infinity, threshold } = {}) {
  const events = [];
  const outages = [];
  let fetches = 0;
  let remainingFailures = failures;
  const monitor = createHealthMonitor({
    healthUrl: "http://127.0.0.1:8080/health",
    failureThreshold: threshold ?? DEFAULT_FAILURE_THRESHOLD,
    fetchImpl: async () => {
      fetches += 1;
      if (remainingFailures > 0) {
        remainingFailures -= 1;
        throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });
      }
      return { ok: true };
    },
    isActive: () => active,
    emit: (type, status, payload) => events.push({ type, status, payload }),
    onOutage: async (detail) => { outages.push(detail); },
  });
  return { monitor, events, outages, fetches: () => fetches };
}

test("poll does not fetch while the task gate is closed (idle = no polling)", async () => {
  const { monitor, events, fetches } = harness({ active: false });
  await monitor.poll();
  await monitor.poll();
  assert.equal(fetches(), 0);
  assert.equal(events.length, 0);
});

test("a single failure below the threshold emits nothing", async () => {
  const { monitor, events, outages } = harness({ failures: 1 });
  await monitor.poll();
  assert.equal(events.length, 0);
  assert.equal(outages.length, 0);
  assert.equal(monitor.inOutage(), false);
});

test("failure transition emits maple.health.failed once and triggers recovery once per outage", async () => {
  const { monitor, events, outages } = harness({ failures: 10 });
  for (let i = 0; i < DEFAULT_FAILURE_THRESHOLD + 3; i++) await monitor.poll();
  const failed = events.filter((event) => event.type === "maple.health.failed");
  assert.equal(failed.length, 1, "one event per outage, not per failed poll");
  assert.equal(failed[0].status, "failed");
  assert.match(failed[0].payload.error, /fetch failed|ECONNREFUSED/);
  assert.equal(outages.length, 1);
  assert.equal(monitor.inOutage(), true);
});

test("recovery emits maple.health.recovered and a later outage re-opens", async () => {
  const { monitor, events, outages } = harness({ failures: DEFAULT_FAILURE_THRESHOLD });
  for (let i = 0; i < DEFAULT_FAILURE_THRESHOLD; i++) await monitor.poll();
  await monitor.poll(); // now succeeds
  assert.deepEqual(events.map((event) => event.type), ["maple.health.failed", "maple.health.recovered"]);
  assert.equal(monitor.inOutage(), false);
  assert.equal(monitor.failureCount(), 0);
  assert.equal(outages.length, 1);
});

test("onOutage rejection is reported, never thrown", async () => {
  const events = [];
  const monitor = createHealthMonitor({
    healthUrl: "http://127.0.0.1:8080/health",
    failureThreshold: 1,
    fetchImpl: async () => { throw new Error("down"); },
    isActive: () => true,
    emit: (type, status, payload) => events.push({ type, status, payload }),
    onOutage: async () => { throw new Error("restart refused"); },
  });
  await monitor.poll();
  assert.deepEqual(events.map((event) => event.type), ["maple.health.failed", "maple.health.recovery.failed"]);
  assert.match(events[1].payload.error, /restart refused/);
});

test("start/stop/dispose manage the interval without leaking", async () => {
  const { monitor } = harness();
  assert.equal(monitor.isRunning(), false);
  monitor.start();
  assert.equal(monitor.isRunning(), true);
  monitor.start(); // idempotent
  monitor.stop();
  assert.equal(monitor.isRunning(), false);
  monitor.start();
  monitor.dispose();
  assert.equal(monitor.isRunning(), false);
  await monitor.poll(); // disposed poll is a no-op
  assert.equal(monitor.inOutage(), false);
});

// --- Wiring guards (source-level; main.cjs has no test export seam) ---

test("main.cjs wires the health monitor to the task lifecycle and the bounded restart path", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "main.cjs"), "utf8");
  assert.match(src, /createHealthMonitor\(\{[\s\S]*healthUrl:\s*`\$\{serverUrl\}\/health`/, "monitor must poll the maple /health endpoint");
  assert.match(src, /isActive:\s*mapleHealthMonitorActive/, "monitor must self-gate on task activity");
  assert.match(src, /updateAgentTask[\s\S]*?syncMapleHealthMonitor\(\)/, "task transitions must start/stop the monitor");
  assert.match(src, /onOutage:[\s\S]*?recordCrash\(mapleCrashTimestamps[\s\S]*?restartMapleRuntime\(/, "an outage must consume crash budget and use the bounded restart path");
  assert.match(src, /mapleHealthMonitor\?\.dispose\(\)/, "session close must dispose the monitor");
});

test("main.cjs records fatal process errors and renderer crashes as durable events", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "main.cjs"), "utf8");
  assert.match(src, /process\.on\("uncaughtException"/, "missing uncaughtException hook");
  assert.match(src, /process\.on\("unhandledRejection"/, "missing unhandledRejection hook");
  assert.match(src, /appendAgentEvent\("runtime\.error",\s*"failed"/, "fatal errors must be journalled");
  assert.match(src, /"render-process-gone"[\s\S]*?appendAgentEvent\("renderer\.crashed",\s*"failed"/, "renderer crashes must be journalled");
  assert.match(src, /rendererLastReloadAt/, "renderer auto-reload must be bounded");
  assert.match(src, /"unresponsive"[\s\S]*?appendAgentEvent\("renderer\.unresponsive"/, "unresponsive renderers must be journalled without auto-action");
});

test("main.cjs bounds auto-resume after an unexpected exit", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "main.cjs"), "utf8");
  assert.match(src, /task\.resumed_after_restart/, "missing the resume receipt event");
  assert.match(src, /blockTask\(task\.id,\s*"server restarted twice"\)/, "second crash under one task must block it");
  assert.match(src, /mapleRespawnPendingResume/, "unexpected exits must flag the pending resume");
});

test("main.cjs metrics fixes: budget mirror, wall-clock start, adopted-server inference readiness", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "main.cjs"), "utf8");
  // commandsUsed lives on the kernel projection; it must be mirrored back.
  assert.match(src, /kernelBudget\.commandsUsed !== agentTask\.budget\?\.commandsUsed/, "commandsUsed must be mirrored onto agentTask");
  // wallClockStartedAt is set at task creation, not lazily at step one.
  assert.match(src, /budget:\s*\{\s*\.\.\.mergeBudget\(DEFAULT_BUDGET\),\s*wallClockStartedAt:\s*Date\.now\(\)\s*\}/, "task creation must start the wall clock");
  // An adopted server has no child handle; readiness must not throw on it.
  assert.match(src, /serverState\.adopted !== true/, "waitForServer must tolerate adopted servers");
  // The warmup probe must not stomp the served adapter path.
  assert.match(src, /probeInference\(warmupAdapter\)/, "warmup must probe the served adapter");
});
