"use strict";

// Receipt-bearing memory injection (T6-G1).
//
// Turns a SIPS recall payload into a labeled system-role block for the model
// plus citation receipts for the host. Host additions are labeled, never
// blended into model output.
//
// Promotion rule: SIPS memory records carry an explicit `status` field
// ("candidate" | "active" | "demoted" | "rolled_back"); memory_transition maps
// promote → "active". ONLY "active" (promoted) records may be injected —
// candidates are unverified seeds. Assumption: a record with no status field at
// all is not provably promoted, so it is excluded (conservative by design).

const MAX_BLOCK_CHARS = 2400;

function isPromotedRecord(record) {
  return Boolean(record) && typeof record === "object" && record.status === "active";
}

function promotedSortKey(record) {
  // Newest-promoted first. Records have no promotedAt timestamp, so fall back
  // to createdAt (the newest write for a promoted record approximates its
  // promotion time in this append-only store).
  return String(record.promotedAt || record.createdAt || "");
}

function truncateToCap(lines) {
  let block = lines.join("\n");
  if (block.length <= MAX_BLOCK_CHARS) return block;
  while (lines.length > 1 && lines.join("\n").length > MAX_BLOCK_CHARS) lines.pop();
  block = lines.join("\n");
  if (block.length <= MAX_BLOCK_CHARS) return block;
  // Hard-truncate the final line on a word boundary where avoidable.
  let cut = block.slice(0, MAX_BLOCK_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace > Math.floor(MAX_BLOCK_CHARS * 0.8)) cut = cut.slice(0, lastSpace);
  return cut.trimEnd();
}

function buildGroundedContext({ recall } = {}) {
  const records = Array.isArray(recall?.records) ? recall.records.filter(isPromotedRecord) : [];
  if (!records.length) return { systemBlock: null, citations: [] };
  const ordered = [...records].sort((a, b) => promotedSortKey(b).localeCompare(promotedSortKey(a)));
  const lines = [`[Hemlock memory · ${ordered.length} record(s) · verify-before-use]`];
  for (const record of ordered) {
    const title = String(record.title || "").trim() || "Untitled lesson";
    const body = String(record.body || "").trim();
    lines.push(`- ${title}: ${body}`);
  }
  return {
    systemBlock: truncateToCap(lines),
    citations: ordered.map((record) => ({
      id: record.id || null,
      title: String(record.title || "").trim() || "Untitled lesson",
    })),
  };
}

module.exports = { buildGroundedContext, MAX_BLOCK_CHARS };
