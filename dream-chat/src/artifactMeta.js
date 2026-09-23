// Artifact presentation helpers — title hygiene, evidence flags, revision
// badges. Pure functions; ArtifactStudio owns the rendering.

const REVISE_ENVELOPE = /^\s*Revise the task artifact\s+["“]([\s\S]*?)["”]\s*\(artifactId:\s*[^)]*\)\.?/i;

// Artifact titles can arrive wrapped in the revise-instruction envelope
// ("Revise the task artifact \"…\" (artifactId: …). Instruction: …").
// Display the inner title, truncated; the full string stays for tooltips.
export function displayArtifactTitle(title, max = 60) {
  const raw = String(title || "").trim();
  const wrapped = raw.match(REVISE_ENVELOPE);
  let clean = (wrapped ? wrapped[1] : raw).trim();
  if (!clean) clean = "Untitled artifact";
  if (clean.length > max) clean = `${clean.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
  return clean;
}

function latestIndex(evidence, type) {
  const list = Array.isArray(evidence) ? evidence : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i]?.type === type) return i;
  }
  return -1;
}

// Placeholder-content honesty: host_fallback means Maple's authoring returned
// nothing usable and the scaffold is host-generated; repaired_source means a
// bounded repair pass recovered real content. Check both the live artifact and
// a nested manifest copy, whichever the caller has. Indices let the caller
// show whichever signal is most recent.
export function evidenceFlags(artifact) {
  const evidence = [
    ...(Array.isArray(artifact?.evidence) ? artifact.evidence : []),
    ...(Array.isArray(artifact?.manifest?.evidence) ? artifact.manifest.evidence : []),
  ];
  const fallbackIndex = latestIndex(evidence, "authoring.host_fallback");
  const repairedIndex = latestIndex(evidence, "authoring.repaired_source");
  return {
    fallback: fallbackIndex >= 0 ? evidence[fallbackIndex] : null,
    repaired: repairedIndex >= 0 ? evidence[repairedIndex] : null,
    fallbackIndex,
    repairedIndex,
  };
}

// Revision rail badge: records carry status + digest + createdAt; degrade to a
// neutral badge when they don't.
export function revisionBadge(revision) {
  const digest = String(revision?.digest || "");
  return {
    status: revision?.status || "drafting",
    digest,
    shortDigest: digest ? digest.replace(/^sha256:/, "").slice(0, 10) : "",
    createdAt: revision?.createdAt || null,
  };
}
