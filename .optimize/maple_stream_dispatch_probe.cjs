const { createStreamFrameCoalescer } = require("../dream-chat/electron/stream_dispatcher.cjs");

const frameCount = Number(process.env.HEMLOCK_STREAM_PROBE_FRAMES || 4000);
const channels = ["work_note", "content"];
const source = Array.from({ length: frameCount }, (_, index) => ({
  channel: channels[index % channels.length],
  delta: "x",
  sequence: index,
}));

let directCalls = 0;
for (const _frame of source) directCalls += 1;

let coalescedCalls = 0;
const dispatcher = createStreamFrameCoalescer({ emit: () => { coalescedCalls += 1; }, intervalMs: 60_000 });
for (const frame of source) dispatcher.push(frame);
dispatcher.flush();

const reductionPercent = ((directCalls - coalescedCalls) / directCalls) * 100;
console.log(`source_frames=${frameCount}`);
console.log(`direct_ipc_calls=${directCalls}`);
console.log(`coalesced_ipc_calls=${coalescedCalls}`);
console.log(`ipc_call_reduction_percent=${reductionPercent.toFixed(2)}`);
