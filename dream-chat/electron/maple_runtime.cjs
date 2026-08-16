const MAPLE_LAUNCH_SCHEMA = "hemlock.maple.launch.v1";

function createMapleLaunchResult({ server = {}, startedAt = null, error = null } = {}) {
  const processReady = server.processReady === true;
  const inferenceReady = server.inferenceReady === true;
  return {
    schema: MAPLE_LAUNCH_SCHEMA,
    status: error ? "failed" : processReady ? "ready" : "blocked",
    processReady,
    inferenceReady,
    server: { ...server, processReady, inferenceReady },
    elapsedMs: Number.isFinite(startedAt) ? Math.max(0, Date.now() - startedAt) : null,
    ...(error ? { error: String(error.message || error) } : {}),
    ...(error?.code ? { errorCode: String(error.code) } : {}),
    ...(error?.signal ? { errorSignal: String(error.signal) } : {}),
    claimBoundary: "This action starts the local Maple runtime and verifies HTTP health only. It does not run an inference request, Dream training, or prove model quality.",
  };
}

module.exports = { MAPLE_LAUNCH_SCHEMA, createMapleLaunchResult };
