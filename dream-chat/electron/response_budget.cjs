// Test-fixture helper only: consumed by e2e_artistic_fixture.cjs to pick a
// max_tokens for the fixture server. The live inference path does NOT use it —
// main.cjs sends `mapleMaxTokens` (or an explicit payload.max_tokens) instead.
function responseBudget(text = "") {
  const value = String(text || "").trim();
  if (
    value.length <= 80
    && /^(?:hey|hi|hello|thanks|thank you|how are you|good morning|good night|ok|okay)\b/i.test(value)
  ) return 320;
  if (
    value.length > 180
    || /\b(?:explain|why|compare|go deeper|describe|detail|detailed|elaborate|creative|revise|revision)\b/i.test(value)
  ) return 768;
  return 512;
}

module.exports = { responseBudget };
