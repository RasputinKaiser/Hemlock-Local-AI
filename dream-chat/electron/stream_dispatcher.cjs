const DEFAULT_FLUSH_MS = 16;

function createStreamFrameCoalescer({ emit = () => {}, intervalMs = DEFAULT_FLUSH_MS } = {}) {
  let pending = new Map();
  let timer = null;

  function schedule() {
    if (timer !== null) return;
    timer = setTimeout(flush, Math.max(0, intervalMs));
  }

  function flush() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    const frames = pending;
    pending = new Map();
    for (const frame of frames.values()) emit(frame);
  }

  function push(frame = {}) {
    const channel = frame.channel || "content";
    const existing = pending.get(channel);
    if (existing) {
      existing.delta += String(frame.delta || "");
      existing.time = frame.time || existing.time;
      if (frame.status) existing.status = frame.status;
      if (frame.usage !== null && frame.usage !== undefined) existing.usage = frame.usage;
      if (frame.stopReason !== null && frame.stopReason !== undefined) existing.stopReason = frame.stopReason;
    } else {
      const { sequence: _sequence, terminal: _terminal, ...initial } = frame;
      pending.set(channel, { ...initial, channel, delta: String(frame.delta || ""), terminal: false });
    }
    schedule();
  }

  function dispose() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    pending.clear();
    pending = new Map();
  }

  return {
    push,
    flush,
    dispose,
    pendingCount: () => pending.size,
  };
}

module.exports = { DEFAULT_FLUSH_MS, createStreamFrameCoalescer };
