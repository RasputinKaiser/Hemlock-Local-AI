// Context-quality chip state for the Chat composer. The host reports quality
// through contextSnapshot.quality (context_broker.cjs: status fresh|stale|
// needs-refresh, requiresRefresh, sourceCoverage 0..1, freshnessSeconds,
// confidence) and mirrors it into agentProjection.contextQuality. Pure so the
// stale/zero-coverage thresholds stay testable.

export function contextStatus({ contextSnapshot = null, agentProjection = null } = {}) {
  const quality = contextSnapshot?.quality || agentProjection?.contextQuality || null;
  if (!quality || typeof quality !== "object") return null;
  const status = String(quality.status || "");
  const coverage = Number.isFinite(quality.sourceCoverage) ? quality.sourceCoverage : null;
  const stale = quality.requiresRefresh === true
    || status === "stale"
    || status === "needs-refresh"
    || coverage === 0;
  if (!stale) return null;
  const label = status === "needs-refresh" || coverage === 0 ? "context needs refresh" : "context stale";
  const parts = [`status ${status || "unknown"}`];
  if (coverage != null) parts.push(`source coverage ${Math.round(coverage * 100)}%`);
  if (Number.isFinite(quality.freshnessSeconds) && quality.freshnessSeconds != null) {
    const minutes = Math.max(0, Math.round(quality.freshnessSeconds / 60));
    parts.push(minutes < 1 ? "last observation <1m old" : `last observation ${minutes}m old`);
  }
  return {
    status: status || "unknown",
    coverage,
    label,
    title: `Context quality: ${parts.join(" · ")} — open Settings to review sources and refresh.`,
  };
}
