// Ordered ingestion buffer for host events: IPC bursts queue up and drain as
// ONE onFlush(batch) on a ~16ms window, so a burst costs a single React state
// pass instead of one render per event. Ordering is preserved; nothing is
// deduped or dropped. A queue that reaches the cap drains synchronously —
// memory and latency stay bounded under a flood.
export const EVENT_FLUSH_MS = 16;
export const EVENT_BUFFER_CAP = 200;

export function createEventBuffer({
  onFlush = () => {},
  flushMs = EVENT_FLUSH_MS,
  cap = EVENT_BUFFER_CAP,
} = {}) {
  let queue = [];
  let timer = null;
  let disposed = false;
  const drain = () => {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    if (!queue.length) return;
    const batch = queue;
    queue = [];
    onFlush(batch);
  };
  return {
    push(item) {
      if (disposed) return;
      queue.push(item);
      if (queue.length >= cap) { drain(); return; }
      if (timer === null) timer = setTimeout(drain, flushMs);
    },
    flush: drain,
    size() { return queue.length; },
    // Unmount path: deliver whatever is still queued rather than dropping it.
    dispose() { drain(); disposed = true; },
  };
}
