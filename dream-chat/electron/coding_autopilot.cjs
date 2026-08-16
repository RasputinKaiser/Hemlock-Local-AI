const { digest } = require("./thread_manager.cjs");

const REPAIR_SCHEMA = "hemlock.agent.repair.v1";

class CodingAutopilot {
  constructor({ inferRepair, apply, verify, rollback, emit = () => {}, maxAttempts = 2 } = {}) {
    this.inferRepair = inferRepair;
    this.apply = apply;
    this.verify = verify;
    this.rollback = rollback;
    this.emit = emit;
    this.maxAttempts = Math.max(0, Number(maxAttempts || 2));
  }

  async run({ threadId, taskId, objective, baseChangeSetId = null, issues = [], context = {} } = {}) {
    let lastFailure = { status: "blocked", issues: [...issues] };
    let lastGoodChangeSetId = baseChangeSetId;
    const attempts = [];
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const repair = {
        schema: REPAIR_SCHEMA,
        attempt,
        maxAttempts: this.maxAttempts,
        threadId,
        taskId,
        objective,
        baseChangeSetId,
        issues: lastFailure.issues || [],
        contextDigest: digest(JSON.stringify(context)),
      };
      this.emit("code.repair.started", "running", { repair }, { reversible: true });
      let candidate = null;
      try {
        const action = await this.inferRepair(repair);
        const input = action?.input || action || {};
        if (!input.source && !Array.isArray(input.patches)) throw new Error("Coding repair did not provide a complete source map or bounded patches.");
        candidate = await this.apply({ threadId, taskId, source: input.source, patches: input.patches, baseDigests: input.baseDigests, reason: `Maple repair ${attempt}/${this.maxAttempts}` });
        const verification = await this.verify({ threadId, taskId, candidate, repair });
        attempts.push({ attempt, candidateChangeSetId: candidate.id, status: verification?.status || "blocked", issues: verification?.issues || [] });
        if (verification?.status === "passed") {
          const evidenceRefs = [...new Set([...(candidate.evidenceRefs || []), ...(verification.evidenceRefs || [])])];
          const receipt = { schema: REPAIR_SCHEMA, status: "passed", threadId, taskId, attempt, maxAttempts: this.maxAttempts, baseChangeSetId, candidateChangeSetId: candidate.id, lastGoodChangeSetId: candidate.id, issues: [], verification, evidenceRefs, attempts };
          this.emit("code.repair.completed", "passed", { repair: receipt }, { evidenceRefs, reversible: true });
          return receipt;
        }
        lastFailure = { status: "blocked", issues: verification?.issues || [{ code: "verification_failed", message: "Coding verification failed." }] };
        if (candidate?.id) await this.rollback({ threadId, taskId, changeSetId: candidate.id });
      } catch (error) {
        attempts.push({ attempt, candidateChangeSetId: candidate?.id || null, status: "failed", error: error.message });
        lastFailure = { status: "blocked", issues: [...(lastFailure.issues || []), { code: error.code || "repair_failed", message: error.message }] };
        this.emit("code.repair.failed", "degraded", { threadId, taskId, attempt, error: error.message }, { reversible: true });
        if (candidate?.id) {
          try { await this.rollback({ threadId, taskId, changeSetId: candidate.id }); } catch { /* keep the original repair failure visible */ }
        }
      }
    }
    const receipt = { schema: REPAIR_SCHEMA, status: "exhausted", threadId, taskId, attempt: this.maxAttempts, maxAttempts: this.maxAttempts, baseChangeSetId, candidateChangeSetId: null, lastGoodChangeSetId, issues: lastFailure.issues || [], evidenceRefs: [], attempts };
    this.emit("code.repair.exhausted", "blocked", { repair: receipt }, { evidenceRefs: receipt.evidenceRefs, reversible: true });
    return receipt;
  }
}

module.exports = { CodingAutopilot, REPAIR_SCHEMA };
