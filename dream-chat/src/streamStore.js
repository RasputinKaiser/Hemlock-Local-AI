const TERMINAL = new Set(["completed", "failed", "interrupted", "cancelled", "interrupted_by_steering"]);

export function createEphemeralStreamStore({ onFlush = () => {}, frameBudgetMs = 16 } = {}) {
  const streams = new Map();
  let scheduled = false;
  let timer = null;
  const flush = () => {
    scheduled = false;
    timer = null;
    onFlush([...streams.values()].map((stream) => ({ ...stream })));
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(flush);
    else timer = setTimeout(flush, frameBudgetMs);
  };
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
      schedule();
    },
    get(streamId) { return streams.get(streamId) || null; },
    snapshot() { return [...streams.values()].map((stream) => ({ ...stream })); },
    clear(streamId) { streams.delete(streamId); schedule(); },
    dispose() { if (timer) clearTimeout(timer); streams.clear(); },
  };
}

export function hasLiveStream(streams = []) {
  return streams.some((stream) => stream?.terminal !== true && !TERMINAL.has(stream?.status));
}
