const BUILD_HANDOFF_PATTERN = /\b(?:build\s+(?:(?:this|that|the|a|an|my)\s+)?(?:new\s+)?(?:[\w-]+\s+){0,4}(?:artifact|animation|app|webapp|website|site|page|draft|working\s+version|prototype|component|feature|code)|build\s+(?:this|that|the)|implement\s+(?:this|the|that)|fix\s+(?:this|the|that)\s+(?:bug|issue|error|code)|refactor\s+(?:this|the|that)|write\s+(?:the\s+)?code|make\s+(?:the\s+)?(?:artifact|draft|working\s+version|app|site|website|animation)|create\s+(?:the|an?|my)\s+(?:artifact|draft|working\s+version|app|site|website|animation)|open\s+(?:a\s+)?working\s+version|turn\s+this\s+into\s+(?:an\s+)?(?:artifact|animation|site|app|page)|ship\s+(?:the\s+)?(?:draft|artifact|app|site|website))\b/i;

function hasBuildHandoff(text) {
  return BUILD_HANDOFF_PATTERN.test(String(text || ""));
}

function normalizeInteractionMode(value, text = "") {
  if (value === "build" || value === "explore") return value;
  return hasBuildHandoff(text) ? "build" : "explore";
}

function classifyIntent(text, interactionMode = null) {
  const value = String(text || "").toLowerCase();
  if (interactionMode === "build") return "coding";
  if (/\b(verify|test|check|lint|prove|run (?:the )?build)\b/.test(value)) return "verify";
  if (/\b(improve|self.?improve|sips|train|dream|learn)\b/.test(value)) return "improve";
  if (/\b(inspect|map|repo|files|codebase|status)\b/.test(value)) return "inspect";
  if (/\b(remember|memory|recall|lesson)\b/.test(value)) return "memory";
  if (interactionMode === "explore") return "conversation";
  return "conversation";
}

function resolveInteraction(payload = {}) {
  const text = String(payload.text || payload.objective || "").trim();
  const interactionMode = normalizeInteractionMode(payload.interactionMode, text);
  const intent = payload.intent || classifyIntent(text, payload.interactionMode ? interactionMode : null);
  return { text, interactionMode, intent };
}

module.exports = { BUILD_HANDOFF_PATTERN, hasBuildHandoff, normalizeInteractionMode, classifyIntent, resolveInteraction };
