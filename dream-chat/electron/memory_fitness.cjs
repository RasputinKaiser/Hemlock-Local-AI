// Memory-record fitness scoring for scoped recall (Lane B, pure module).
//
// Memory records accumulate usage feedback over their lifetime: how often they
// were used, how often they helped, and how often they were irrelevant. This
// module turns that feedback into a single 0..100 fitness score so recall can
// rank candidates without re-litigating the policy at every call site.
//
// Policy:
//   - base 50 (an unvoted record is neither trusted nor distrusted);
//   - +8 per useful vote, contribution capped at +30 (enthusiasm saturates —
//     one great week should not permanently crown a record);
//   - -12 per irrelevant vote, contribution floored at -40 (a record can sink
//     very low but arithmetic alone never buries it at exactly 0);
//   - recency bonus up to +10 for recently-promoted records: full bonus inside
//     7 days of promotion, linear decay to 0 at 90 days (fresh curation wins
//     ties; stale promotions stop mattering);
//   - final score clamped to 0..100 and rounded to an integer.
//
// Everything here is pure: no DOM, no fs, no Electron, no mutation of inputs.

const BASE_SCORE = 50;
const USEFUL_STEP = 8;
const USEFUL_CAP = 30;
const IRRELEVANT_STEP = 12;
const IRRELEVANT_FLOOR = 40;
const RECENCY_BONUS_MAX = 10;
const RECENCY_FULL_DAYS = 7;
const RECENCY_ZERO_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

// Coerce a record field into a safe non-negative integer; garbage counts as 0.
function safeCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

// Recency bonus for a promotedAt ISO string relative to `now`. Null/unparseable
// timestamps earn nothing; future-dated promotions are clamped to maximally
// fresh (no time-travel bonus beyond the cap).
function recencyBonus(promotedAt, now) {
  if (typeof promotedAt !== "string") return 0;
  const promotedMs = Date.parse(promotedAt);
  if (!Number.isFinite(promotedMs)) return 0;
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now) || Date.now();
  const ageDays = Math.max(0, (nowMs - promotedMs) / DAY_MS);
  if (ageDays <= RECENCY_FULL_DAYS) return RECENCY_BONUS_MAX;
  if (ageDays >= RECENCY_ZERO_DAYS) return 0;
  const span = RECENCY_ZERO_DAYS - RECENCY_FULL_DAYS;
  return RECENCY_BONUS_MAX * (1 - (ageDays - RECENCY_FULL_DAYS) / span);
}

// Score a single memory record 0..100 from its usage feedback. Missing or
// garbage fields degrade to a blank record (base score), never NaN or throw.
function scoreRecord(record, { now = new Date() } = {}) {
  const r = record && typeof record === "object" ? record : {};
  const useful = safeCount(r.useful);
  const irrelevant = safeCount(r.irrelevant);
  const usefulContribution = Math.min(useful * USEFUL_STEP, USEFUL_CAP);
  const irrelevantContribution = Math.max(-(irrelevant * IRRELEVANT_STEP), -IRRELEVANT_FLOOR);
  const raw = BASE_SCORE + usefulContribution + irrelevantContribution + recencyBonus(r.promotedAt, now);
  return Math.round(Math.min(100, Math.max(0, raw)));
}

// Rank records for recall: score descending, ties broken by promotedAt desc
// (newer curation first) then id asc (deterministic). Never mutates the input
// array or the records inside it; garbage collections return [].
function rankForRecall(records, { now = new Date() } = {}) {
  if (!Array.isArray(records)) return [];
  const promotedMs = (record) => {
    const t = record && typeof record === "object" ? Date.parse(record.promotedAt) : NaN;
    return Number.isFinite(t) ? t : -Infinity;
  };
  return records
    .map((record) => ({
      record: record && typeof record === "object" ? { ...record } : record,
      score: scoreRecord(record, { now }),
      promoted: promotedMs(record),
      id: record && typeof record === "object" ? String(record.id ?? "") : "",
    }))
    .sort((a, b) =>
      b.score - a.score ||
      b.promoted - a.promoted ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    )
    .map((entry) => entry.record);
}

// Auto-demote policy: a record that drew at least 3 irrelevant votes AND more
// irrelevant than useful votes is net noise and should leave the recall pool.
function shouldAutoDemote(record) {
  const r = record && typeof record === "object" ? record : {};
  const irrelevant = safeCount(r.irrelevant);
  const useful = safeCount(r.useful);
  return irrelevant >= 3 && irrelevant > useful;
}

// Apply a feedback event to a record, returning a NEW object — the input is
// never mutated. "used" counts a recall hit; "useful"/"irrelevant" count votes.
// Unknown kinds return the record unchanged; missing records are treated as
// blank ones that then gain the feedback.
function applyFeedback(record, kind) {
  const base = record && typeof record === "object" ? { ...record } : {};
  const next = {
    uses: safeCount(base.uses),
    useful: safeCount(base.useful),
    irrelevant: safeCount(base.irrelevant),
    promotedAt: typeof base.promotedAt === "string" ? base.promotedAt : null,
    ...base,
  };
  switch (kind) {
    case "used":
      next.uses += 1;
      return next;
    case "useful":
      next.useful += 1;
      return next;
    case "irrelevant":
      next.irrelevant += 1;
      return next;
    default:
      // Unknown feedback: nothing to count, nothing to change.
      return record !== undefined ? record : next;
  }
}

module.exports = {
  scoreRecord,
  rankForRecall,
  shouldAutoDemote,
  applyFeedback,
};
