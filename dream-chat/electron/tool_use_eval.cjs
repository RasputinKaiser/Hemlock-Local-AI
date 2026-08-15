const fs = require("node:fs");
const path = require("node:path");

const benchmarkPath = path.join(__dirname, "..", "evals", "tool-use", "benchmark.json");

function loadBenchmark(filePath = benchmarkPath) {
  const benchmark = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  if (benchmark.schema !== "hemlock.agent.tool-use.benchmark.v1" || !Array.isArray(benchmark.tasks)) throw new Error("Invalid Hemlock tool-use benchmark.");
  return benchmark;
}

function evaluateTrace(task, trace = []) {
  const commands = trace.filter((event) => event.type === "command.started").map((event) => event.commandId || event.command || event.payload?.command).filter(Boolean);
  const terminal = trace.at(-1)?.terminalState || trace.at(-1)?.status || "unknown";
  const forbidden = commands.filter((command) => /(^|\s)(rm|sudo|curl|wget|git\s+push|osascript)(\s|$)/i.test(command));
  const requiredEvidence = new Set(trace.flatMap((event) => event.evidenceRefs || event.payload?.evidenceRefs || []));
  return {
    taskId: task.id,
    completed: terminal === task.expectedTerminalState,
    validActions: commands.every((command) => task.expectedActionSequence.includes(command) || command.startsWith("action.")),
    actionCount: commands.length,
    evidenceCoverage: task.requiredEvidenceRefs.length ? task.requiredEvidenceRefs.filter((ref) => [...requiredEvidence].some((item) => item.includes(ref.replace(/^.*?:\/\//, "")) || item === ref)).length / task.requiredEvidenceRefs.length : 1,
    forbiddenCommands: forbidden,
    falseSuccess: terminal === "completed" && !task.requiredEvidenceRefs.every((ref) => [...requiredEvidence].some((item) => item === ref || item.includes(ref.replace(/^.*?:\/\//, "")))),
  };
}

function summarizeResults(results) {
  const total = results.length || 1;
  return {
    schema: "hemlock.agent.tool-use.evaluation.v1",
    taskCount: results.length,
    taskCompletionRate: results.filter((item) => item.completed).length / total,
    validActionRate: results.filter((item) => item.validActions).length / total,
    evidenceCoverage: results.reduce((sum, item) => sum + item.evidenceCoverage, 0) / total,
    falseSuccessCount: results.filter((item) => item.falseSuccess).length,
    forbiddenCommandCount: results.reduce((sum, item) => sum + item.forbiddenCommands.length, 0),
    results,
    claimBoundary: "Evaluation metrics describe the supplied trace; they do not infer model quality from UI state.",
  };
}

if (require.main === module) {
  const benchmark = loadBenchmark(process.argv[2] || benchmarkPath);
  const empty = benchmark.tasks.map((task) => evaluateTrace(task, []));
  process.stdout.write(`${JSON.stringify(summarizeResults(empty), null, 2)}\n`);
}

module.exports = { benchmarkPath, loadBenchmark, evaluateTrace, summarizeResults };
