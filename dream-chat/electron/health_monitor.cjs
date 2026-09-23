"use strict";

// Bounded /health watchdog for the Maple server (stability lane).
//
// No Electron, no I/O of its own — the host injects fetch, the activity
// gate, the event sink, and the recovery callback so node --test can drive
// poll() directly. The monitor exists to catch a wedged-but-alive server
// while a task is mid-loop; a clean process exit is already covered by the
// child's exit handler + crash_policy budget.
//
// Idle discipline: poll() self-gates on isActive(), so an idle session is
// never woken for health checks, and start/stop follow the task lifecycle.

const DEFAULT_INTERVAL_MS = 15000;
const DEFAULT_PROBE_TIMEOUT_MS = 8000;
// One slow answer is not an outage — a local server mid-prefill can stall a
// health response without being dead. Two consecutive failures before the
// host reacts keeps restart churn honest.
const DEFAULT_FAILURE_THRESHOLD = 2;

function createHealthMonitor({
  healthUrl,
  fetchImpl = null,
  intervalMs = DEFAULT_INTERVAL_MS,
  probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  failureThreshold = DEFAULT_FAILURE_THRESHOLD,
  isActive = () => false,
  emit = () => {},
  onOutage = () => {},
} = {}) {
  let timer = null;
  let disposed = false;
  let polling = false;
  let consecutiveFailures = 0;
  let outageOpen = false;

  async function probe() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), probeTimeoutMs);
    timeout.unref?.();
    try {
      const response = await fetchImpl(healthUrl, { signal: controller.signal });
      return { ok: response?.ok === true };
    } catch (error) {
      return { ok: false, error };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function poll() {
    if (disposed || polling) return;
    polling = true;
    try {
      if (!isActive() || !fetchImpl || !healthUrl) return;
      const result = await probe();
      if (result.ok) {
        consecutiveFailures = 0;
        if (outageOpen) {
          outageOpen = false;
          emit("maple.health.recovered", "passed", { healthUrl });
        }
        return;
      }
      consecutiveFailures += 1;
      if (!outageOpen && consecutiveFailures >= failureThreshold) {
        outageOpen = true;
        const detail = {
          healthUrl,
          consecutiveFailures,
          error: result.error ? String(result.error.message || result.error).slice(0, 500) : "unhealthy response",
        };
        emit("maple.health.failed", "failed", detail);
        await Promise.resolve(onOutage(detail)).catch((error) => {
          emit("maple.health.recovery.failed", "failed", { error: String(error?.message || error).slice(0, 500) });
        });
      }
    } finally {
      polling = false;
    }
  }

  function start() {
    if (disposed || timer) return;
    timer = setInterval(() => { void poll(); }, Math.max(250, Number(intervalMs) || DEFAULT_INTERVAL_MS));
    timer.unref?.();
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function dispose() {
    disposed = true;
    stop();
  }

  return {
    start,
    stop,
    dispose,
    poll,
    isRunning: () => timer !== null,
    inOutage: () => outageOpen,
    failureCount: () => consecutiveFailures,
  };
}

module.exports = {
  createHealthMonitor,
  DEFAULT_INTERVAL_MS,
  DEFAULT_PROBE_TIMEOUT_MS,
  DEFAULT_FAILURE_THRESHOLD,
};
