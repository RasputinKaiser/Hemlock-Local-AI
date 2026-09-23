import { useRef } from "react";

// Per-window ctx slices. App builds one ctx bag per render; passing it whole
// re-renders every mounted window on any state change. Each window declares
// the fields it reads here — ctxSlices.test.js greps the window sources and
// fails if a `ctx.X` reference is missing from its list.
export const WINDOW_CTX_KEYS = {
  center: [
    "activeAdapterPath", "adapterVerified", "agentProjection", "artifactReviseBusy",
    "cancelQueuedIntent", "candidateBusyId", "candidates", "changesetApplyBusy", "commandBusy",
    "confirmDialog", "contextSnapshot", "dismissPrimer", "draft", "dreamProgress",
    "dreamReceipt", "dreamStage", "error", "events", "focusWindow", "inferenceReady",
    "isDesktop", "isDreaming", "isThinking", "liveStream", "memoryRecords",
    "messages", "modelSelection", "openWindow", "primerDismissed", "queueState",
    "readinessCheck", "recoveryNotice", "runCommand", "selectedLane",
    "selectedProviderStatus", "sendMessage", "serverProcessReady", "serverState",
    "setDraft", "setError", "setThreadPickerOpen", "sipsCycleState", "sipsProgress", "sipsStage",
    "sipsStatus", "sipsVerifyProfile", "streamFrames", "switchThread", "task", "taskProgress",
    "threadRegistry", "transitionCandidate", "transitionMemory",
  ],
  chat: [
    "agentProjection", "answerDraft", "archiveThread", "autonomyMode", "budgetGrant",
    "cancelBusy", "cancelQueuedIntent", "chatPinned", "commandBusy",
    "commitThreadRename", "compareDismissedAt", "contextSnapshot", "createThread",
    "dismissPrimer", "draft", "endRef", "error", "events", "groundingBusyId",
    "groundingPopoverOpen", "hostActivityOpen", "inspectorOpen", "inspectorOpenerRef",
    "interactionMode", "isDesktop", "isDreaming", "isThinking", "jumpToLatest",
    "messages", "modelSelection", "openWindow", "planCollapsed", "primerDismissed",
    "queueState", "refreshAgentState", "refreshThreadRegistry", "renameDraft",
    "renamingThreadId", "resetConversationContext", "restoreThread", "runCommand",
    "selectedLane", "sendGroundingFeedback", "sendMessage", "serverHealthProbe",
    "serverState", "setAnswerDraft", "setAutonomyMode", "setBudgetGrant",
    "setCompareDismissedAt", "setDraft", "setError", "setGroundingPopoverOpen",
    "setHostActivityOpen", "setInspectorOpen", "setInteractionMode",
    "setPlanCollapsed", "setRenameDraft", "setRenamingThreadId",
    "setThreadPickerOpen", "sipsRecall", "stableOpenWindow", "stableRetryLast",
    "startThreadRename", "stopGeneration", "streamFrames", "suggestions",
    "switchThread", "task", "thinkingElapsed", "threadPickerOpen", "threadRegistry",
    "transitionSuggestion",
  ],
  threads: [
    "archiveThread", "cancelThread", "commandBusy", "createThread", "deleteThread",
    "forkThread", "isDesktop", "loadThreadCheckpoints", "loadThreadConversation",
    "pauseThread", "refreshThreadRegistry", "restoreThread",
    "restoreThreadCheckpoint", "resumeThread", "runCommand", "switchThread",
    "task", "threadCheckpoints", "threadConversations", "threadRegistry",
  ],
  artifact: [
    "activeArtifactId", "applyExportedChangeSet", "artifact", "artifactCompare",
    "artifactFocusPreview", "artifactFreeze", "artifactLayout", "artifactPinned",
    "artifactReviseBusy", "artifactReviseDraft", "artifactView", "artifacts",
    "beginArtifactPanelResize", "changesetApplyBusy", "confirmDialog",
    "endArtifactPanelResize", "exportedChangeSet", "handleArtifactPanelResizeKey",
    "isDesktop", "isThinking", "openWindow", "previewConsoleLines",
    "previewInspection", "previewNotice", "previewSession", "previewSrc",
    "previewViewport", "reviseArtifactWithMaple", "runArtifact",
    "setArtifactCompare", "setArtifactFocusPreview", "setArtifactFreeze",
    "setArtifactPinned", "setArtifactReviseDraft", "setArtifactView",
    "setExportedChangeSet", "setPreviewConsoleLines", "setPreviewNotice",
    "setPreviewViewport", "task", "updateArtifactPanelResize",
  ],
  sips: [
    "commandBusy", "isDreaming", "openWindow", "refreshSips", "runCommand",
    "runSelfloop", "runSipsCycle", "setSipsObjective", "setSipsRecallQuery",
    "setSipsTrainingProfile", "setSipsVerifyProfile", "sipsCycleState", "sipsError",
    "sipsLog", "sipsObjective", "sipsProgress", "sipsRecallQuery", "sipsReceipt",
    "sipsStage", "sipsStatus", "sipsTrainingProfile", "sipsVerifyProfile",
  ],
  memory: [
    "addFact", "agentProjection", "candidateBusyId", "candidates", "commandBusy", "factDraft",
    "facts", "isDesktop", "memoryInventory", "memoryRecords", "openWindow", "removeFact",
    "runCommand", "setFactDraft", "setReceiptsFilter", "sipsRecall", "task",
    "transitionCandidate", "transitionMemory",
  ],
  dream: [
    "activeAdapterPath", "commandBusy", "confirmDialog", "dreamElapsed", "dreamLog",
    "events",
    "dreamProgress", "dreamReceipt", "dreamStage", "dreamTrainingProfile",
    "experimentDataset", "facts", "isDesktop", "isDreaming", "launchMapleDream",
    "mapleLaunchError", "mapleLaunchState", "messages", "recoveryNotice",
    "runCommand", "serverProcessReady", "setActiveAdapterPath", "setAdapterVerified",
    "setDreamTrainingProfile", "startDream", "trainingDataset",
  ],
  activity: [
    "activityTypeFilter", "commandBusy", "events", "isDreaming", "isThinking",
    "liveStream", "openWindow", "setActivityTypeFilter", "streamFrames",
  ],
  receipts: [
    "changeSet", "commandBusy", "events", "latestReceiptEvent", "openWindow", "receiptRecords",
    "receiptsFilter", "runCommand", "setPreviewNotice", "setReceiptsFilter",
  ],
  map: ["commandBusy", "runCommand", "sipsRepoMap"],
  grove: ["events", "isDesktop", "worldMarkers"],
  settings: [
    "agentProjection", "agentSnapshot", "apiBase", "checkReadiness",
    "clearPromptCache", "commandBusy", "confirmDialog", "depsSnapshot",
    "dreamTrainingProfile", "inferenceReady", "isDesktop", "loadSettingsPanel",
    "providerAuthAction",
    "providerStatuses", "readinessCheck", "refreshDeps", "refreshProviderStatuses", "reopenPrimer",
    "serverState", "setApiBase", "setDreamTrainingProfile", "setInferenceReady",
    "setReadinessCheck", "setServerProcessReady", "setSkipCloseWarning",
    "setSourceEnabled", "settingsSnapshot", "skipCloseWarning", "sourcePolicies",
    "threadRegistry",
    "updateProviderCapacity", "updateRuntimeSetting",
  ],
};

// Declared keys that windows read defensively but the ctx bag does not
// (currently) provide — slices expose them as undefined, matching the bag.
export const OPTIONAL_CTX_KEYS = new Set(["artifact"]);

export function pickCtx(source, keys) {
  const slice = {};
  for (const key of keys) slice[key] = source[key];
  return slice;
}

// Sentinel slot for function-valued fields: the bag re-creates closures every
// render, so function identity can never gate invalidation. Slices emit stable
// forwarders that call through to the latest bag value instead.
const FUNCTION_FIELD = Symbol("ctx-function");

function sliceDeps(source, keys) {
  return keys.map((key) => (typeof source[key] === "function" ? FUNCTION_FIELD : source[key]));
}

// Pure memoizing slicer: returns the identical slice object until a listed
// non-function field's value changes. Function fields are stable wrappers
// bound to the newest source on every call — handlers always run the current
// closure without breaking memoization.
export function createCtxSliceCache() {
  const wrappers = new Map();
  let latest = null;
  let lastDeps = null;
  let lastSlice = null;
  return function sliceCtx(source, keys) {
    latest = source;
    const deps = sliceDeps(source, keys);
    if (lastSlice
      && lastDeps.length === deps.length
      && deps.every((value, index) => Object.is(value, lastDeps[index]))) {
      return lastSlice;
    }
    const slice = {};
    for (const key of keys) {
      const value = source[key];
      if (typeof value === "function") {
        if (!wrappers.has(key)) wrappers.set(key, (...args) => latest?.[key]?.(...args));
        slice[key] = wrappers.get(key);
      } else {
        slice[key] = value;
      }
    }
    lastDeps = deps;
    lastSlice = slice;
    return slice;
  };
}

// useWindowCtx(WINDOW_CTX_KEYS.chat, ctx) → memoized per-window bag. The
// cache lives in a ref so slice identity survives App re-renders.
export function useWindowCtx(keys, source) {
  const cacheRef = useRef(null);
  if (!cacheRef.current) cacheRef.current = createCtxSliceCache();
  return cacheRef.current(source, keys);
}
