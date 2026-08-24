const TERMINAL = new Set(["completed", "failed", "interrupted", "cancelled", "interrupted_by_steering"]);

// Shared scheduling core: drain on animation frame or a hard latency cap,
// whichever fires first. The cap matters in background tabs/windows where
// rAF never ticks — without it streamed text would visibly stall.
function createScheduler({ runFlush, frameBudgetMs, maxLatencyMs, requestAnimationFrame }) {
  const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : null;
  let scheduled = false;
  let frameId = null;
  let timer = null;
  const cancel = () => {
    if (frameId !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frameId);
    if (timer !== null) clearTimeout(timer);
    frameId = null;
    timer = null;
  };
  const flush = () => {
    scheduled = false;
    cancel();
    runFlush();
  };
  return {
    flush,
    cancel,
    schedule() {
      if (scheduled) return;
      scheduled = true;
      if (raf) {
        frameId = raf(flush);
        timer = setTimeout(flush, maxLatencyMs);
      } else {
        timer = setTimeout(flush, frameBudgetMs);
      }
    },
  };
}

export function createEphemeralStreamStore({ onFlush = () => {}, frameBudgetMs = 16, maxLatencyMs = 50, requestAnimationFrame } = {}) {
  const streams = new Map();
  const scheduler = createScheduler({
    frameBudgetMs,
    maxLatencyMs,
    requestAnimationFrame,
    runFlush: () => onFlush([...streams.values()].map((stream) => ({ ...stream }))),
  });
  return {
    apply(frame) {
      if (!frame?.streamId) return;
      const previous = streams.get(frame.streamId) || { streamId: frame.streamId, text: "", channels: {}, sequence: -1, terminal: false };
      if (Number.isFinite(frame.sequence) && frame.sequence <= previous.sequence) return;
      const channel = frame.channel || "content";
      const channels = { ...(previous.channels || {}) };
      channels[channel] = `${channels[channel] || ""}${frame.delta || ""}`;
      const next = {
        ...previous,
        ...frame,
        channels,
        text: channels.content || "",
        sequence: frame.sequence ?? previous.sequence,
        terminal: Boolean(frame.terminal || TERMINAL.has(frame.status)),
      };
      streams.set(frame.streamId, next);
      // Terminal frames land synchronously so completion (streaming flags,
      // live badges) is never delayed by the coalescing window.
      if (next.terminal) { scheduler.flush(); return; }
      scheduler.schedule();
    },
    get(streamId) { return streams.get(streamId) || null; },
    snapshot() { return [...streams.values()].map((stream) => ({ ...stream })); },
    clear(streamId) { streams.delete(streamId); scheduler.schedule(); },
    dispose() { scheduler.cancel(); streams.clear(); },
  };
}

// Ordered buffering layer for high-frequency stream frames: every pushed
// frame is retained and handed to onFlush exactly once, in push order, on a
// single drain. A terminal frame drains synchronously.
export function createFrameCoalescer({ onFlush = () => {}, frameBudgetMs = 16, maxLatencyMs = 50, requestAnimationFrame } = {}) {
  let queue = [];
  const scheduler = createScheduler({
    frameBudgetMs,
    maxLatencyMs,
    requestAnimationFrame,
    runFlush: () => {
      if (!queue.length) return;
      const batch = queue;
      queue = [];
      onFlush(batch);
    },
  });
  return {
    push(item) {
      queue.push(item);
      if (item?.terminal === true) scheduler.flush();
      else scheduler.schedule();
    },
    pendingCount() { return queue.length; },
    dispose() { scheduler.cancel(); queue = []; },
  };
}

export function hasLiveStream(streams = []) {
  return streams.some((stream) => stream?.terminal !== true && !TERMINAL.has(stream?.status));
}
