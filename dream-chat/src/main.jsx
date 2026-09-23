import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Icon } from "./components/Icons.jsx";
import { WindowFrame } from "./components/WindowFrame.jsx";
import { WindowBoundary } from "./components/WindowBoundary.jsx";
import { WorkspaceOverview } from "./components/WorkspaceOverview.jsx";
import { WindowActionsMenu } from "./components/WindowActionsMenu.jsx";
import { ShortcutGuide } from "./components/ShortcutGuide.jsx";
import { centerWindow, minimizeWorkspace, restoreWorkspace } from "./windowActions.js";
import { attachDockMagnification, dockElement, flipRect, morphFromDock, morphToDock, windowElement } from "./windowMotion.js";
import { dockActivityBadges, dockApps, focusHandoffId, nextWindowInCycle, shortcutApp } from "./workspaceNavigation.js";
import { buildPaletteGroups, readRecentCommands, recordRecentCommand } from "./commandPalette.js";
import {
  WINDOW_DEFINITIONS,
  clampBounds,
  createWindowState,
  focusWindow as focusWindowState,
  keyboardPlacement,
  migrateWindowState,
  moveWindow,
  normalizeZOrder,
  openWindowBounds,
  pointerSnapCommand,
  resizeWindow,
  setWindowState,
  toggleMaximize,
} from "./windowManager.js";
import { createEphemeralStreamStore, createFrameCoalescer, hasLiveStream } from "./streamStore.js";
import { createEventBuffer } from "./eventBuffer.js";
import { pruneWorkToasts, pushWorkToast, workToastFor } from "./workToasts.js";
import { WINDOW_CTX_KEYS, useWindowCtx } from "./ctxSlices.js";
import {
  ACTIVE_TASK_STATUSES,
  CLOSE_WARNING_KEY,
  DEFAULT_MAPLE_MAX_TOKENS,
  MODEL_LANES,
  StatusLamp,
  TERMINAL_STREAM_STATUSES,
  displayText,
  formatTime,
} from "./windows/shared.jsx";
import { ChatWindow } from "./windows/ChatWindow.jsx";
import { ArtifactStudio } from "./windows/ArtifactStudio.jsx";
import { CommandCenter } from "./windows/CommandCenter.jsx";
import { ThreadsWindow } from "./windows/ThreadsWindow.jsx";
import { ActivityWindow, DreamWindow, GroveWindow, MapWindow, MemoryWindow, ReceiptsWindow, SettingsWindow, SipsWindow } from "./windows/UtilityWindows.jsx";
import "./styles.css";
import "./windows/chat.css";
import "./windows/artifact.css";
import "./windows/windows.css";

const DEFAULT_API = "http://127.0.0.1:8080";
const FACTS_KEY = "hemlock-facts-v2";
const API_KEY = "hemlock-api-v2";
const ADAPTER_KEY = "hemlock-adapter-v2";
const SIPS_KEY = "hemlock-sips-v2";
const DREAM_PROFILE_KEY = "hemlock-dream-profile-v2";
const MODEL_SELECTION_KEY = "hemlock-model-selection-v1";
const WINDOWS_KEY = "hemlock-os-windows-v2";
const ARTIFACT_LAYOUT_KEY = "hemlock-artifact-layout-v1";
const PRIMER_KEY = "hemlock-primer-v1";
const UNDERSTORY_KEY = "hemlock-understory-v1";
const AUTONOMY_KEY = "hemlock-autonomy-v1";

const DESKTOP_VISIBILITY_KEY = "hemlock-desktop-visibility-v1";

function readUnderstoryPreference() {
  try {
    return JSON.parse(localStorage.getItem(UNDERSTORY_KEY))?.on === true;
  } catch {
    return false;
  }
}
const DEFAULT_ARTIFACT_LAYOUT = { source: 0.68, diff: 0.88, preview: 1.48, evidence: 168 };

function normalizeModelSelection(value) {
  const lane = MODEL_LANES[value?.provider] || MODEL_LANES.maple;
  const modelIsValid = typeof value?.model === "string" && lane.modelOptions.some((option) => option.value === value.model);
  return {
    provider: lane.provider,
    model: modelIsValid ? value.model : lane.defaultModel,
    reasoning: lane.reasoningLevels.includes(value?.reasoning) ? value.reasoning : lane.defaultReasoning,
  };
}

function readModelSelection() {
  return normalizeModelSelection(readJson(MODEL_SELECTION_KEY, { provider: "maple" }));
}

const WINDOW_META = {
  center: { label: "Command Center", icon: "center", tone: "gold", status: "home" },
  chat: { label: "Chat / Code", icon: "chat", tone: "green", status: "local" },
  threads: { label: "Threads", icon: "chat", tone: "green", status: "local" },
  artifact: { label: "Artifact Studio", icon: "artifact", tone: "violet", status: "scratch" },
  sips: { label: "SIPS Control", icon: "sips", tone: "gold", status: "bounded" },
  memory: { label: "Memory Garden", icon: "memory", tone: "green", status: "local" },
  dream: { label: "Dream Lab", icon: "dream", tone: "violet", status: "MLX" },
  activity: { label: "Activity", icon: "activity", tone: "green", status: "live" },
  receipts: { label: "Receipts", icon: "receipt", tone: "gold", status: "evidence" },
  map: { label: "Project Map", icon: "map", tone: "green", status: "read-only" },
  grove: { label: "Understory Grove", icon: "grove", tone: "green", status: "ambient" },
  settings: { label: "Settings", icon: "settings", tone: "green", status: "local" },
};

function readJson(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key));
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function initialWindows() {
  const stored = readJson(WINDOWS_KEY, null);
  return migrateWindowState(stored, { workspaceId: "workspace-local", canvas: { width: 1240, height: 700 } });
}

function readArtifactLayout() {
  // studioPrefs (ArtifactStudio) persists view/viewport/layout under
  // STUDIO_PREFS_KEY; its layout fractions override the legacy key's.
  const stored = { ...readJson(ARTIFACT_LAYOUT_KEY, {}), ...(readJson("hemlock.artifact.layout", {}).layout || {}) };
  const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;
  return {
    source: Math.max(0.4, finite(stored.source, DEFAULT_ARTIFACT_LAYOUT.source)),
    diff: Math.max(0.4, finite(stored.diff, DEFAULT_ARTIFACT_LAYOUT.diff)),
    preview: Math.max(0.7, finite(stored.preview, DEFAULT_ARTIFACT_LAYOUT.preview)),
    evidence: Math.max(118, finite(stored.evidence, DEFAULT_ARTIFACT_LAYOUT.evidence)),
  };
}

function detectIntent(text, interactionMode = null) {
  const value = text.toLowerCase();
  if (interactionMode === "build") return "coding";
  // Keep human conversation conversational. Creation verbs are only
  // actionable when they are paired with a concrete software/artifact term;
  // “I want to make something beautiful together” is not a coding plan.
  const codingRequest = interactionMode !== "explore" && (/\b(code|implement|fix|bug|function|component|refactor|develop|artifact|animation|animated|html|css|javascript|typescript|canvas|svg|website|webpage|app|site|page|feature)\b/.test(value)
    || /\b(create|make|write|design|build)\b[\s\S]*\b(code|artifact|animation|animated|html|css|javascript|typescript|canvas|svg|website|webpage|app|site|page|feature|component|function)\b/.test(value)
    || /\b(build|design)\b[\s\S]*\b(site|app|page|html|css|javascript|component|feature|animation)\b/.test(value));
  if (codingRequest) return "coding";
  if (/\b(verify|test|check|lint|prove|run (?:the )?build)\b/.test(value)) return "verify";
  if (/\b(improve|self.?improve|sips|train|dream|learn)\b/.test(value)) return "improve";
  if (/\b(inspect|map|repo|files|codebase|status)\b/.test(value)) return "inspect";
  if (/\b(remember|memory|recall|lesson)\b/.test(value)) return "memory";
  return "conversation";
}

function parseInteractionMode(text) {
  const value = String(text || "").trim();
  const steering = value.match(/^(?:steer|steering)\s*[:\-]\s*(.+)$/i);
  const campaign = value.match(/^(?:campaign|auto|autonomous)\s*[:\-]\s*(.+)$/i);
  const content = steering ? steering[1].trim() : campaign ? campaign[1].trim() : value;
  const buildHandoff = /\b(?:build\s+(?:(?:this|that|the|a|an|my)\s+)?(?:new\s+)?(?:[\w-]+\s+){0,4}(?:artifact|animation|app|webapp|website|site|page|draft|working\s+version|prototype|component|feature|code)|build\s+(?:this|that|the)|implement\s+(?:this|the|that)|fix\s+(?:this|the|that)\s+(?:bug|issue|error|code)|refactor\s+(?:this|the|that)|write\s+(?:the\s+)?code|make\s+(?:the\s+)?(?:artifact|draft|working\s+version|app|site|website|animation)|create\s+(?:the|an?|my)\s+(?:artifact|draft|working\s+version|app|site|website|animation)|open\s+(?:a\s+)?working\s+version|turn\s+this\s+into\s+(?:an\s+)?(?:artifact|animation|site|app|page)|ship\s+(?:the\s+)?(?:draft|artifact|app|site|website))\b/i.test(content);
  return { mode: steering ? "steer" : campaign ? "campaign" : "queue", interactionMode: buildHandoff ? "build" : "explore", text: content };
}

function isProjectCorrection(text) {
  return /\b(actually|no,|that's wrong|that is wrong|use |fix |the error|the bug|doesn't work|does not work)\b/i.test(text)
    && /\b(code|repo|file|build|test|server|adapter|model|app|component|command|hook)\b/i.test(text);
}

function previewDocument(artifact) {
  if (!artifact?.source) return "<!doctype html><html><body><p>Waiting for the first complete artifact revision.</p></body></html>";
  const source = artifact.source;
  const entry = source[artifact.entrypoint] || source[Object.keys(source)[0]] || "";
  const css = Object.entries(source).filter(([name]) => name.endsWith(".css")).map(([, value]) => `<style>${value}</style>`).join("");
  const js = Object.entries(source).filter(([name]) => name.endsWith(".js") || name.endsWith(".mjs")).map(([, value]) => `<script>${value.replaceAll("</script>", "<\\/script>")}</script>`).join("");
  const harness = `<script>(function(){
    var emit=function(type,payload){ parent.postMessage({source:"hemlock-preview-harness",type:type,payload:payload||{}},"*"); };
    var stable=function(target){ if(typeof target!=="string" || !(target.startsWith("#") || target.startsWith("[data-preview-id"))) return null; try{return document.querySelector(target);}catch(e){return null;} };
    var summary=function(){ return {title:document.title,bodyText:(document.body&&document.body.innerText||"").slice(0,4000),elements:document.body?[...document.body.querySelectorAll("*")].slice(0,120).map(function(el){return {tag:el.tagName.toLowerCase(),id:el.id||null,previewId:el.dataset&&el.dataset.previewId||null,role:el.getAttribute("role"),text:(el.innerText||"").trim().slice(0,160),disabled:Boolean(el.disabled)}}):[]}; };
    var accessibility=function(){ return {landmarks:[...document.querySelectorAll("main,nav,header,footer,aside,section")].slice(0,40).map(function(el){return {tag:el.tagName.toLowerCase(),role:el.getAttribute("role"),label:el.getAttribute("aria-label"),text:(el.innerText||"").trim().slice(0,120)}}),controls:[...document.querySelectorAll("button,input,textarea,select,a")].slice(0,80).map(function(el){return {tag:el.tagName.toLowerCase(),label:el.getAttribute("aria-label")||el.innerText||el.placeholder||null,role:el.getAttribute("role"),disabled:Boolean(el.disabled)}})}; };
    window.addEventListener("error",function(e){emit("console",{level:"error",message:String(e.message||e.error||"runtime error")});});
    ["log","warn","error"].forEach(function(level){var original=console[level];console[level]=function(){emit("console",{level:level,message:[...arguments].map(String).join(" ")});original.apply(console,arguments);};});
    window.addEventListener("message",function(e){if(e.source!==parent||!e.data||e.data.source!=="hemlock-preview")return; var a=e.data.action,p=e.data.input||{},node;
      if(a==="inspect") emit("inspection",{dom:summary(),digest:null});
      else if(a==="accessibility") emit("accessibility",accessibility());
      else if(a==="resize") { document.documentElement.style.setProperty("--hemlock-preview-width",String(Math.max(1,Math.min(2400,Number(p.width)||800))+"px")); emit("resized",{width:Number(p.width)||800,height:Number(p.height)||600}); }
      else if(a==="click"||a==="hover"||a==="focus") {node=stable(p.target); if(!node){emit("blocked",{reason:"unstable_target"});return;} if(a==="click")node.click(); else if(a==="hover")node.dispatchEvent(new MouseEvent("mouseover",{bubbles:true})); else node.focus(); emit(a,{target:p.target});}
      else if(a==="type") {node=stable(p.target); if(!node||!("value" in node)){emit("blocked",{reason:"target_not_text_input"});return;} node.value=String(p.text||"").slice(0,10000);node.dispatchEvent(new Event("input",{bubbles:true}));emit("typed",{target:p.target});}
      else if(a==="key") {node=stable(p.target)||document.activeElement||document.body;node.dispatchEvent(new KeyboardEvent("keydown",{key:String(p.key||"Enter"),bubbles:true}));emit("keyed",{key:p.key||"Enter"});}
      else if(a==="scroll") {node=stable(p.target)||document.scrollingElement;node.scrollBy({top:Math.max(-2000,Math.min(2000,Number(p.top)||0)),left:Math.max(-2000,Math.min(2000,Number(p.left)||0)),behavior:"instant"});emit("scrolled",{target:p.target||"document"});}
      else if(a==="wait") {setTimeout(function(){emit("condition",{condition:String(p.condition||"bounded wait"),dom:summary()});},Math.max(0,Math.min(10000,Number(p.ms)||250)));}
      else emit("blocked",{reason:"unregistered_preview_action"});
    });
    emit("ready",{dom:summary(),accessibility:accessibility()});
  })();</script>`;
  let html = artifact.kind === "html" ? entry : artifact.kind === "svg" ? `<img src="data:image/svg+xml,${encodeURIComponent(entry)}" alt="Artifact SVG" />` : `<pre>${entry.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</pre>`;
  if (!html.includes("<html")) html = `<!doctype html><html><head><meta charset="utf-8">${css}</head><body>${html}${js}</body></html>`;
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; media-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none';">`;
  return html.replace(/<head>/i, `<head>${csp}`).replace(/<\/body>/i, `${harness}</body>`);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
  }
}

async function readResponse(response) {
  const text = await response.text();
  try { return text ? JSON.parse(text) : {}; } catch { return { raw: text }; }
}

async function requestCompletion(apiBase, body, timeoutMs = 180000) {
  const response = await fetchWithTimeout(`${apiBase.replace(/\/$/, "")}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, timeoutMs);
  const payload = await readResponse(response);
  if (!response.ok) {
    const detail = payload?.error?.message || payload?.error || payload?.raw || response.statusText || `HTTP ${response.status}`;
    const error = new Error(`Maple-Preview returned HTTP ${response.status}: ${detail}`);
    error.status = response.status;
    error.processReady = true;
    throw error;
  }
  return payload;
}

function inferenceProbeBody(adapterPath = "") {
  return {
    model: "default_model",
    messages: [{ role: "user", content: "Reply with exactly OK." }],
    temperature: 0,
    top_p: 1,
    top_k: 0,
    max_tokens: 1,
    stream: false,
    ...(adapterPath ? { adapters: adapterPath } : {}),
  };
}

async function probeReadiness(apiBase, adapterPath = "") {
  const base = apiBase.replace(/\/$/, "");
  let health;
  try { health = await fetchWithTimeout(`${base}/health`, {}, 10000); } catch (error) {
    error.processReady = false;
    error.inferenceReady = false;
    throw error;
  }
  if (!health.ok) {
    const error = new Error(`Maple-Preview health returned HTTP ${health.status}`);
    error.processReady = false;
    error.inferenceReady = false;
    throw error;
  }
  try {
    const result = await requestCompletion(base, inferenceProbeBody(adapterPath));
    if (!result?.choices?.[0]?.message || typeof result.usage !== "object") throw new Error("Inference probe returned no completed choice.");
    return { processReady: true, inferenceReady: true, adapterPath };
  } catch (error) {
    error.processReady = true;
    error.inferenceReady = false;
    throw error;
  }
}

function desktopAgent() {
  return window.hemlockAgent || window.mapleDesktop?.agent || window.mapleDesktop || null;
}

// First-run primer: teaches the four load-bearing ideas (verbatim, receipts,
// bounded, where output lands) in one inline, non-modal card. Shown once;
// dismissal persists under PRIMER_KEY.
// Reopen affordance: strip only the dismissed flag, keeping any other fields
// (e.g. timestamps) that may share the payload.
function clearPrimerDismissal(payload) {
  const next = { ...(payload && typeof payload === "object" ? payload : {}) };
  delete next.dismissed;
  return next;
}

function App() {
  const isDesktop = Boolean(window.mapleDesktop?.isDesktop);
  const [understory, setUnderstory] = useState(readUnderstoryPreference);
  const [apiBase, setApiBase] = useState(() => localStorage.getItem(API_KEY) || DEFAULT_API);
  const [modelSelection, setModelSelection] = useState(readModelSelection);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [providerStatuses, setProviderStatuses] = useState(() => readJson("hemlock-provider-status-v1", []));
  const [activeAdapterPath, setActiveAdapterPath] = useState(() => localStorage.getItem(ADAPTER_KEY) || "");
  const [facts, setFacts] = useState(() => readJson(FACTS_KEY, []));
  const [messages, setMessages] = useState([]);
  // Hooks belong to App, not the conditionally invoked window renderers.
  // Closing/minimizing Chat must never change App's hook order.
  const stableRetryRef = useRef(retryLastMessage);
  stableRetryRef.current = retryLastMessage;
  const stableRetryLast = useCallback((target) => stableRetryRef.current(target), []);
  const stableOpenWindowRef = useRef(openWindow);
  stableOpenWindowRef.current = openWindow;
  const stableOpenWindow = useCallback((id) => stableOpenWindowRef.current(id), []);
  const [draft, setDraft] = useState("");
  const [interactionMode, setInteractionMode] = useState("explore");
  const [autonomyMode, setAutonomyMode] = useState(() => localStorage.getItem(AUTONOMY_KEY) || "guided");
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const inspectorOpenerRef = useRef(null);
  useEffect(() => {
    if (!inspectorOpen) return undefined;
    const panel = document.getElementById("hemlock-chat-inspector");
    if (!panel) return undefined;
    inspectorOpenerRef.current = document.activeElement;
    const compact = () => getComputedStyle(panel).position === "absolute";
    if (compact()) panel.querySelector("button")?.focus();
    const dismiss = (event) => {
      if (event.type === "keydown" && document.querySelector(".palette-backdrop")) return;
      if (event.type === "keydown" && event.key !== "Escape") return;
      if (event.type === "pointerdown" && (!compact() || event.target.closest("#hemlock-chat-inspector, .chat-inspector-toggle"))) return;
      if (event.type === "keydown") { event.preventDefault(); event.stopPropagation(); inspectorOpenerRef.current?.focus?.(); }
      setInspectorOpen(false);
    };
    document.addEventListener("keydown", dismiss);
    document.addEventListener("pointerdown", dismiss);
    return () => {
      document.removeEventListener("keydown", dismiss);
      document.removeEventListener("pointerdown", dismiss);
      if (panel.contains(document.activeElement)) inspectorOpenerRef.current?.focus?.();
    };
  }, [inspectorOpen]);
  const [planCollapsed, setPlanCollapsed] = useState(true);
  // T7-S3: user-grantable plan budgets. Keyed by plan id so each new awaiting
  // plan starts from the host defaults instead of the last grant.
  const [budgetGrant, setBudgetGrant] = useState({ planId: null, steps: 8, commands: 12 });
  const [hostActivityOpen, setHostActivityOpen] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [thinkingStartedAt, setThinkingStartedAt] = useState(null);
  const [thinkingElapsed, setThinkingElapsed] = useState(null);
  const [isDreaming, setIsDreaming] = useState(false);
  const [dreamProgress, setDreamProgress] = useState(0);
  const [dreamStage, setDreamStage] = useState("Dream Lab is ready");
  const [dreamLog, setDreamLog] = useState("");
  const [dreamElapsed, setDreamElapsed] = useState(0);
  const [dreamReceipt, setDreamReceipt] = useState(null);
  const [trainingDataset, setTrainingDataset] = useState(null);
  const [dreamTrainingProfile, setDreamTrainingProfile] = useState(() => localStorage.getItem(DREAM_PROFILE_KEY) || "quality");
  const [serverProcessReady, setServerProcessReady] = useState(null);
  const [serverHealthProbe, setServerHealthProbe] = useState(null);
  const [inferenceReady, setInferenceReady] = useState(null);
  const [adapterVerified, setAdapterVerified] = useState(null);
  const [mapleLaunchState, setMapleLaunchState] = useState("idle");
  const [mapleLaunchError, setMapleLaunchError] = useState("");
  const [readinessCheck, setReadinessCheck] = useState("idle");
  const [recoveryNotice, setRecoveryNotice] = useState("");
  const [task, setTask] = useState(() => ({ ...readJson("hemlock-task-preview-v1", {}), objective: "Explore the Hemlock workspace", intent: "conversation", phase: "ready", status: "ready", foregroundStep: "Waiting for a local task" }));
  const [threadRegistry, setThreadRegistry] = useState({ projects: [], threads: [], activeThreadId: null, providerCaps: { maple: 1, codex: 2, claude: 2 } });
  const [suggestions, setSuggestions] = useState([]);
  const [threadPickerOpen, setThreadPickerOpen] = useState(false);
  const [renamingThreadId, setRenamingThreadId] = useState(null);
  const [renameDraft, setRenameDraft] = useState("");
  // Threads window detail panes: per-thread checkpoint lists and conversation
  // tails fetched on demand through thread.checkpoints / thread.conversation.
  const [threadCheckpoints, setThreadCheckpoints] = useState({});
  const [threadConversations, setThreadConversations] = useState({});
  const [events, setEvents] = useState([]);
  const [agentSnapshot, setAgentSnapshot] = useState(null);
  const [agentProjection, setAgentProjection] = useState(null);
  const [queueState, setQueueState] = useState(null);
  const [artifacts, setArtifacts] = useState([]);
  const [activeArtifactId, setActiveArtifactId] = useState(null);
  const [artifactView, setArtifactView] = useState("preview");
  const [artifactFocusPreview, setArtifactFocusPreview] = useState(false);
  const [artifactLayout, setArtifactLayout] = useState(readArtifactLayout);
  const [artifactFreeze, setArtifactFreeze] = useState(false);
  const [artifactReviseDraft, setArtifactReviseDraft] = useState("");
  const [artifactCompare, setArtifactCompare] = useState(null);
  const [artifactReviseBusy, setArtifactReviseBusy] = useState(false);
  const [artifactPinned, setArtifactPinned] = useState(false);
  const [previewSession, setPreviewSession] = useState(null);
  const [previewInspection, setPreviewInspection] = useState(null);
  const [previewNotice, setPreviewNotice] = useState("");
  const [previewViewport, setPreviewViewport] = useState("fill");
  const [comparePickerOpen, setComparePickerOpen] = useState(false);
  const [compareDismissedAt, setCompareDismissedAt] = useState(null);
  const [streamFrames, setStreamFrames] = useState([]);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [canvasSize, setCanvasSize] = useState({ width: 1240, height: 700 });
  const [candidates, setCandidates] = useState([]);
  const [worldMarkers, setWorldMarkers] = useState([]);
  const [sourcePolicies, setSourcePolicies] = useState([]);
  const [contextSnapshot, setContextSnapshot] = useState(null);
  const [workspaceWindows, setWorkspaceWindows] = useState(initialWindows);
  const workspaceWindowsRef = useRef(initialWindows);
  useEffect(() => { workspaceWindowsRef.current = workspaceWindows; }, [workspaceWindows]);
  const [activeWindowId, setActiveWindowId] = useState(() => Object.values(workspaceWindows).filter(item => ["normal", "maximized"].includes(item.state)).sort((a, b) => b.zOrder - a.zOrder)[0]?.windowId || null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [overviewOpen, setOverviewOpen] = useState(false);
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const [desktopSnapshot, setDesktopSnapshot] = useState(() => { const value = readJson(DESKTOP_VISIBILITY_KEY, null); return Array.isArray(value?.ids) ? value : null; });
  useEffect(() => { if (desktopSnapshot) localStorage.setItem(DESKTOP_VISIBILITY_KEY, JSON.stringify(desktopSnapshot)); else localStorage.removeItem(DESKTOP_VISIBILITY_KEY); }, [desktopSnapshot]);
  const [dockMenu, setDockMenu] = useState(null); // { windowId, x, y }
  const [activityTypeFilter, setActivityTypeFilter] = useState(null);
  const [receiptsFilter, setReceiptsFilter] = useState("");
  // Settings control surface: host-owned snapshots from settings.get and
  // deps.check, loaded lazily when the Settings window mounts.
  const [settingsSnapshot, setSettingsSnapshot] = useState(null);
  const [depsSnapshot, setDepsSnapshot] = useState(null);
  // In-app work notifications: terminal job events surfaced as quiet toasts.
  // The host's OS-notification path skips while the window is focused — this
  // is the renderer's own record, deduped by event id and self-expiring.
  const [workToasts, setWorkToasts] = useState([]);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [paletteActiveIndex, setPaletteActiveIndex] = useState(0);
  const [paletteContentMatches, setPaletteContentMatches] = useState([]);
  const [paletteRecentIds, setPaletteRecentIds] = useState(() => readRecentCommands());
  const threadSearchSupportRef = useRef({ available: null });
  const [confirmState, setConfirmState] = useState(null); // { title, body, confirmLabel, tone, resolve }
  const [skipCloseWarning, setSkipCloseWarning] = useState(() => readJson(CLOSE_WARNING_KEY, {}).skip === true);
  const [primerDismissed, setPrimerDismissed] = useState(() => readJson(PRIMER_KEY, {}).dismissed === true);
  const [error, setError] = useState("");
  const [factDraft, setFactDraft] = useState("");
  const [sipsObjective, setSipsObjective] = useState(() => readJson(SIPS_KEY, {}).objective || "Improve Hemlock's next coding task with a small verified change.");
  const [sipsVerifyProfile, setSipsVerifyProfile] = useState(() => readJson(SIPS_KEY, {}).verifyProfile || "app-build");
  const [sipsTrainingProfile, setSipsTrainingProfile] = useState(() => readJson(SIPS_KEY, {}).trainingProfile || "balanced");
  const [sipsStatus, setSipsStatus] = useState(null);
  const [experimentDataset, setExperimentDataset] = useState(null);
  const [sipsRoutes, setSipsRoutes] = useState([]);
  const [sipsRecallQuery, setSipsRecallQuery] = useState("");
  const [sipsRecall, setSipsRecall] = useState(null);
  // T6-M1b: grounding chip popover — injected-record usefulness feedback.
  const [groundingPopoverOpen, setGroundingPopoverOpen] = useState(false);
  const [groundingBusyId, setGroundingBusyId] = useState("");
  const [candidateBusyId, setCandidateBusyId] = useState("");
  const [sipsCycleState, setSipsCycleState] = useState("idle");
  const [sipsProgress, setSipsProgress] = useState(0);
  const [sipsStage, setSipsStage] = useState("SIPS is idle");
  const [sipsLog, setSipsLog] = useState("");
  const [sipsReceipt, setSipsReceipt] = useState(null);
  const [sipsRepoMap, setSipsRepoMap] = useState(null);
  const [sipsVerifyReceipt, setSipsVerifyReceipt] = useState(null);
  const [sipsError, setSipsError] = useState("");
  const [receiptRecords, setReceiptRecords] = useState([]);
  // Annotated memory inventory from the host's read-only memory.list — carries
  // ageDays/lastUsedAt/sourceRefs/effectiveStatus/clusterSize fields that the
  // memory.* event payloads don't. null until the first fetch; event-derived
  // memoryRecords stay the fallback.
  const [memoryInventory, setMemoryInventory] = useState(null);
  const [changeSet, setChangeSet] = useState(null);
  const [exportedChangeSet, setExportedChangeSet] = useState(null);
  const [changesetApplyBusy, setChangesetApplyBusy] = useState(false);
  const [commandBusy, setCommandBusy] = useState("");
  const [answerDraft, setAnswerDraft] = useState(""); // T7-S1: answer-in-place textarea state
  const endRef = useRef(null);
  const chatPinnedRef = useRef(true);
  const [chatPinned, setChatPinned] = useState(true);
  const paletteRef = useRef(null);
  const dockRef = useRef(null);
  const dragRef = useRef(null);
  const resizeRef = useRef(null);
  const [draggingWindowId, setDraggingWindowId] = useState(null);
  const [resizingWindowId, setResizingWindowId] = useState(null);
  const [snapPreview, setSnapPreview] = useState(null);
  const artifactPanelResizeRef = useRef(null);
  const artifactLayoutRef = useRef(artifactLayout);
  const conversationResponseIds = useRef(new Set());
  const liveStreamState = useRef(new Map());
  const artifactPeekedRef = useRef(false);
  const canvasRef = useRef(null);
  const streamStoreRef = useRef(null);
  useEffect(() => attachDockMagnification(dockRef.current), []);
  // Living chrome: every committed window-state change animates through FLIP
  // transforms — open/restore grow out of the dock icon, maximize/tile/close
  // glide between rects. Drag and resize stay pointer-locked (no tween), and
  // the effect never writes state: bounds in React stay the truth.
  const windowRectsRef = useRef({});
  useLayoutEffect(() => {
    const rects = {};
    for (const [id, item] of Object.entries(workspaceWindows)) {
      const el = windowElement(id);
      if (!el || ["closed", "minimized"].includes(item.state)) continue;
      const inFlight = el.getAnimations?.().length ? el.getBoundingClientRect() : null;
      const prev = inFlight || windowRectsRef.current[id];
      if (!prev) {
        morphFromDock(el, dockElement(id));
        rects[id] = el.getBoundingClientRect();
      } else if (draggingWindowId === id || resizingWindowId === id) {
        el.getAnimations?.().forEach((animation) => animation.cancel());
        rects[id] = el.getBoundingClientRect();
      } else {
        rects[id] = flipRect(el, prev) || el.getBoundingClientRect();
      }
    }
    windowRectsRef.current = rects;
  }, [workspaceWindows, canvasSize, draggingWindowId, resizingWindowId]);
  const providerRefreshRef = useRef(null);
  const previewConsoleErrorsRef = useRef([]);
  const [previewConsoleLines, setPreviewConsoleLines] = useState([]);
  const previewReportPartsRef = useRef({});
  const confirmStateRef = useRef(null);
  const confirmCancelButtonRef = useRef(null);
  const confirmAcceptButtonRef = useRef(null);
  const seenEventCountsRef = useRef(new Map()); // windowId -> events.length at last focus (dock unread truth)
  const unreadBaselineSeededRef = useRef(false);
  const missingWindowContentRef = useRef(new Set()); // windowId -> warned once about a missing renderer
  const verificationNoteRef = useRef(null); // T6-V2: last completion footnote key (dedupe)
  if (!streamStoreRef.current) streamStoreRef.current = createEphemeralStreamStore({ onFlush: setStreamFrames });

  function acceptTaskSnapshot(nextTask) {
    if (!nextTask) return;
    setTask((current) => {
      if (!current?.id || current.id === nextTask.id) return nextTask;
      const currentTime = Date.parse(current.updatedAt || current.startedAt || "");
      const nextTime = Date.parse(nextTask.updatedAt || nextTask.startedAt || "");
      return Number.isFinite(nextTime) && (!Number.isFinite(currentTime) || nextTime >= currentTime) ? nextTask : current;
    });
  }

  function hydrateAgentSnapshot(snapshot) {
    if (!snapshot) return;
    setAgentSnapshot(snapshot);
    setAgentProjection(snapshot.runtime?.workspace || snapshot.agent || null);
    setArtifacts(snapshot.runtime?.workspace?.artifacts || []);
    setActiveArtifactId(snapshot.runtime?.workspace?.activeArtifactId || snapshot.runtime?.workspace?.artifacts?.at(-1)?.id || null);
    setPreviewSession(snapshot.runtime?.workspace?.previewSession || null);
    if (snapshot.runtime?.workspace?.activeStreams) setStreamFrames(snapshot.runtime.workspace.activeStreams);
    if (snapshot.queue) setQueueState(snapshot.queue);
    setCandidates(snapshot.runtime?.workspace?.candidates || snapshot.agent?.candidates || []);
    setSourcePolicies(snapshot.runtime?.workspace?.sources || snapshot.agent?.sources || snapshot.context?.sources || []);
    if (snapshot.task) setTask(snapshot.task);
    if (snapshot.context) setContextSnapshot(snapshot.context);
    if (snapshot.server) {
      setServerProcessReady(snapshot.server.processReady);
      setInferenceReady(snapshot.server.inferenceReady);
      setAdapterVerified(snapshot.server.adapterPath ? snapshot.server.inferenceReady : null);
    }
    setEvents(snapshot.events || []);
    if (snapshot.experimentDataset) setExperimentDataset(snapshot.experimentDataset);
    if (Array.isArray(snapshot.world?.rows)) setWorldMarkers(snapshot.world.rows);
    if (snapshot.providers) setProviderStatuses(snapshot.providers);
    if (snapshot.threads) setThreadRegistry(snapshot.threads);
    if (snapshot.suggestions) setSuggestions(snapshot.suggestions);
  }

  function appendConversationResponse(conversation) {
    const channels = Array.isArray(conversation?.channels) ? conversation.channels : [];
    if (!conversation || (!conversation.answer && !channels.length)) return;
    const responseId = conversation.requestId || conversation.streamId || `${conversation.taskId || "task"}:${conversation.rawOutputRef || conversation.answer || channels.map((channel) => channel.name).join(",")}`;
    if (conversationResponseIds.current.has(responseId)) return;
    conversationResponseIds.current.add(responseId);
    setMessages((current) => {
      const streamId = conversation.telemetry?.streamId;
      const index = streamId ? current.findIndex((message) => message.streamId === streamId) : -1;
      const nextMessage = {
        id: index >= 0 ? current[index].id : crypto.randomUUID(),
        role: "assistant",
        content: String(conversation.answer || channels.find((channel) => channel.name === "content")?.text || ""),
        channels,
        requestId: conversation.requestId || null,
        streamId: streamId || null,
        streaming: false,
        rawOutputRef: conversation.rawOutputRef || null,
        traceRefs: conversation.traceRefs || [],
        displayMode: conversation.displayMode || "model-verbatim",
        provider: conversation.provider || conversation.telemetry?.provider || "maple",
        model: conversation.model || conversation.telemetry?.model || null,
        reasoning: conversation.reasoning || conversation.telemetry?.reasoning || null,
        hostStatus: conversation.hostStatus || null,
        telemetry: conversation.telemetry || null,
        createdAt: conversation.createdAt || new Date().toISOString(),
        time: formatTime(),
      };
      if (index >= 0) return current.map((message, messageIndex) => messageIndex === index ? nextMessage : message);
      return [...current, nextMessage];
    });
  }

  function setModelLane(provider) {
    const lane = MODEL_LANES[provider] || MODEL_LANES.maple;
    setModelSelection((current) => normalizeModelSelection({ provider: lane.provider, model: lane.defaultModel, reasoning: current.reasoning }));
    setModelPickerOpen(false);
  }

  function updateModelSelection(patch) {
    setModelSelection((current) => normalizeModelSelection({ ...current, ...patch }));
  }

  async function refreshProviderStatuses() {
    const providersApi = desktopAgent()?.providers;
    if (!isDesktop || !providersApi?.status) return null;
    if (providerRefreshRef.current) return providerRefreshRef.current;
    const refresh = (async () => {
      try {
        const result = await providersApi.status();
        setProviderStatuses(result?.providers || []);
        localStorage.setItem("hemlock-provider-status-v1", JSON.stringify(result?.providers || []));
        return result;
      } catch (providerError) {
        setError(`Provider status unavailable: ${providerError.message}`);
        return null;
      }
    })();
    providerRefreshRef.current = refresh;
    try {
      return await refresh;
    } finally {
      if (providerRefreshRef.current === refresh) providerRefreshRef.current = null;
    }
  }

  function toggleModelPicker() {
    setModelPickerOpen((open) => {
      const next = !open;
      if (next) void refreshProviderStatuses();
      return next;
    });
  }

  useEffect(() => { localStorage.setItem(FACTS_KEY, JSON.stringify(facts)); }, [facts]);
  useEffect(() => {
    document.documentElement.classList.toggle("understory", understory);
    localStorage.setItem(UNDERSTORY_KEY, JSON.stringify({ on: understory }));
  }, [understory]);
  useEffect(() => { localStorage.setItem(API_KEY, apiBase); }, [apiBase]);
  useEffect(() => { localStorage.setItem(MODEL_SELECTION_KEY, JSON.stringify(modelSelection)); }, [modelSelection]);
  useEffect(() => { activeAdapterPath ? localStorage.setItem(ADAPTER_KEY, activeAdapterPath) : localStorage.removeItem(ADAPTER_KEY); }, [activeAdapterPath]);
  useEffect(() => { localStorage.setItem(DREAM_PROFILE_KEY, dreamTrainingProfile); }, [dreamTrainingProfile]);
  useEffect(() => { localStorage.setItem(AUTONOMY_KEY, autonomyMode); }, [autonomyMode]);
  useEffect(() => { localStorage.setItem(SIPS_KEY, JSON.stringify({ objective: sipsObjective, verifyProfile: sipsVerifyProfile, trainingProfile: sipsTrainingProfile })); }, [sipsObjective, sipsVerifyProfile, sipsTrainingProfile]);
  // Grounding popover closes on Escape or any pointer-down outside its wrap.
  useEffect(() => {
    if (!groundingPopoverOpen) return undefined;
    const handlePointerDown = (event) => {
      if (!event.target?.closest?.(".grounding-wrap")) setGroundingPopoverOpen(false);
    };
    const handleKeyDown = (event) => {
      if (event.key === "Escape") setGroundingPopoverOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [groundingPopoverOpen]);
  // Model picker and compare picker are dialogs like the thread picker:
  // Escape and a pointer-down outside must dismiss them in every shell —
  // the global shortcut layer only exists on desktop.
  useEffect(() => {
    if (!modelPickerOpen && !comparePickerOpen) return undefined;
    const handleKeyDown = (event) => {
      if (event.key !== "Escape") return;
      if (modelPickerOpen) {
        setModelPickerOpen(false);
        document.querySelector(".model-picker-trigger")?.focus();
      }
      if (comparePickerOpen) setComparePickerOpen(false);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [modelPickerOpen, comparePickerOpen]);
  useEffect(() => {
    if (!modelPickerOpen) return undefined;
    const handlePointerDown = (event) => {
      if (!event.target?.closest?.(".model-picker")) setModelPickerOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [modelPickerOpen]);
  useEffect(() => { localStorage.setItem(WINDOWS_KEY, JSON.stringify(workspaceWindows)); }, [workspaceWindows]);
  // Load the annotated memory inventory when the Memory window is visible.
  // The listing is a read-only host command; transitions refetch it inside
  // runCommand so staleness/cluster fields never go stale after a mutation.
  const memoryVisible = ["normal", "maximized"].includes(workspaceWindows.memory?.state);
  useEffect(() => {
    if (!memoryVisible || !isDesktop) return undefined;
    const agent = desktopAgent();
    if (!agent?.runCommand) return undefined;
    let cancelled = false;
    agent.runCommand("memory.list").then((listed) => { if (!cancelled) setMemoryInventory(listed?.records || []); }).catch(() => {});
    return () => { cancelled = true; };
  }, [memoryVisible, isDesktop]);
  useEffect(() => {
    artifactLayoutRef.current = artifactLayout;
    localStorage.setItem(ARTIFACT_LAYOUT_KEY, JSON.stringify(artifactLayout));
  }, [artifactLayout]);
  useEffect(() => { localStorage.setItem("hemlock-task-preview-v1", JSON.stringify(task)); }, [task]);
  useEffect(() => {
    const node = canvasRef.current;
    if (!node) return undefined;
    const update = () => {
      const rect = node.getBoundingClientRect();
      setCanvasSize({ width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)) });
    };
    update();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(update) : null;
    observer?.observe(node);
    window.addEventListener("resize", update);
    return () => { observer?.disconnect(); window.removeEventListener("resize", update); };
  }, []);
  // The desktop-strip clock must tick on its own: on a quiet session no other
  // state changes, and a re-render-only clock goes visibly stale.
  const [clockNow, setClockNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setClockNow(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    setWorkspaceWindows((current) => Object.fromEntries(Object.entries(current).map(([id, item]) => [id, {
      ...item,
      bounds: clampBounds(item.bounds, canvasSize, item.minimumSize),
      restoreBounds: clampBounds(item.restoreBounds, canvasSize, item.minimumSize),
    }])));
  }, [canvasSize.width, canvasSize.height]);
  useEffect(() => {
    if (!isThinking || !thinkingStartedAt) { setThinkingElapsed(null); return undefined; }
    const tick = () => setThinkingElapsed(Math.floor((Date.now() - thinkingStartedAt) / 1000));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [isThinking, thinkingStartedAt]);

  useEffect(() => {
    if (!error) return undefined;
    const timer = setTimeout(() => setError(""), 12000);
    return () => clearTimeout(timer);
  }, [error]);

  useEffect(() => {
    const node = endRef.current;
    const container = node?.closest(".chat-scroll");
    if (!container) return undefined;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    if (chatPinnedRef.current || distanceFromBottom <= 96) container.scrollTo({ top: container.scrollHeight, behavior: "auto" });
    const onScroll = () => {
      const pinned = container.scrollHeight - container.scrollTop - container.clientHeight <= 96;
      chatPinnedRef.current = pinned;
      setChatPinned((current) => current === pinned ? current : pinned);
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => container.removeEventListener("scroll", onScroll);
  }, [messages, isThinking, streamFrames]);

  useEffect(() => {
    if (task.status === "waiting_for_approval") setPlanCollapsed(false);
  }, [task.id, task.status]);

  // T6-V2: when a conversational task completes after applying a change set,
  // compose one local host-labeled footnote from the already-hosted
  // task.verification facts (renderer-only composition — no new IPC).
  useEffect(() => {
    const verification = task.verification?.schema === "hemlock.agent.verification.v1" ? task.verification : null;
    if (task.status !== "completed" || !verification || (verification.status !== "passed" && verification.status !== "failed")) return undefined;
    const noteKey = `${task.id}:${verification.changeSetId || verification.command || verification.ranAt}`;
    if (verificationNoteRef.current === noteKey) return undefined;
    verificationNoteRef.current = noteKey;
    const seconds = Number.isFinite(verification.durationMs) ? `${(verification.durationMs / 1000).toFixed(1)}s` : "";
    const detail = [verification.command, seconds].filter(Boolean).join(" · ");
    const text = `Host receipt · change set applied · verification ${verification.status}${detail ? ` (${detail})` : ""}${verification.status === "failed" ? " — repair available" : ""}`;
    setMessages((current) => current.some((message) => message.kind === "host-footnote" && message.text === text) ? current : [...current, { id: `verify-note-${Date.now()}`, role: "system", kind: "host-footnote", status: verification.status, text, content: text, provider: "host", createdAt: new Date().toISOString(), time: formatTime() }]);
    return undefined;
  }, [task.id, task.status, task.verification]);

  // While waiting on a local inference, probe the server health directly
  // instead of trusting the stale serverProcessReady flag (which can be false
  // from an earlier failure while the current request is actually streaming).
  useEffect(() => {
    if (!isThinking || !isDesktop) { setServerHealthProbe(null); return undefined; }
    let disposed = false;
    const probe = async () => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 4000);
        const response = await fetch(`${apiBase}/health`, { signal: controller.signal });
        clearTimeout(timer);
        if (!disposed) setServerHealthProbe(response.ok);
      } catch {
        if (!disposed) setServerHealthProbe(false);
      }
    };
    probe();
    const interval = setInterval(probe, 10000);
    return () => { disposed = true; clearInterval(interval); };
  }, [isThinking, isDesktop, apiBase]);

  useEffect(() => {
    setHostActivityOpen(false);
  }, [task.id, task.threadId]);

  useEffect(() => {
    chatPinnedRef.current = true;
  }, [task.threadId, task.id]);

  useEffect(() => {
    const onShortcut = (event) => {
      if (document.querySelector('[aria-modal="true"], .window-actions-menu')) return;
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.key.toLowerCase() !== "m") return;
      event.preventDefault();
      toggleModelPicker();
    };
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, []);

  // Thread popover: close on Escape or outside click (standard popover behavior).
  useEffect(() => {
    if (!threadPickerOpen) return undefined;
    const onKey = (event) => {
      if (event.key !== "Escape") return;
      setThreadPickerOpen(false);
      // The popover unmounts whatever held focus — return it to the trigger.
      document.querySelector(".thread-switcher")?.focus();
    };
    const onPointer = (event) => {
      const bar = document.querySelector(".thread-bar");
      if (bar && !bar.contains(event.target)) setThreadPickerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer, true);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("pointerdown", onPointer, true); };
  }, [threadPickerOpen]);

  // First-run primer: Escape dismisses it, but never while a modal overlay
  // (palette, confirm dialog, dock menu) owns the keystroke.
  useEffect(() => {
    if (primerDismissed) return undefined;
    const onKey = (event) => {
      if (event.key !== "Escape") return;
      if (paletteOpen || confirmState || dockMenu) return;
      dismissPrimer();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [primerDismissed, paletteOpen, confirmState, dockMenu]);

  function dismissPrimer() {
    setPrimerDismissed(true);
    try { localStorage.setItem(PRIMER_KEY, JSON.stringify({ dismissed: true, dismissedAt: new Date().toISOString() })); } catch { /* storage unavailable */ }
  }

  // Settings → "Reopen getting-started tips": clear the persisted dismissal and
  // surface the primer by focusing Chat (restoring it if minimized), or opening
  // the Command Center when Chat is closed — the primer renders in both.
  function reopenPrimer() {
    setPrimerDismissed(false);
    try { localStorage.setItem(PRIMER_KEY, JSON.stringify(clearPrimerDismissal(readJson(PRIMER_KEY, {})))); } catch { /* storage unavailable */ }
    const chatState = workspaceWindows.chat?.state;
    if (chatState && chatState !== "closed") focusWindow("chat");
    else openWindow("center");
  }

  useEffect(() => {
    const agent = desktopAgent();
    if (!isDesktop || !agent?.getState) return undefined;
    let disposed = false;
    agent.getState().then((snapshot) => {
      if (disposed) return;
      hydrateAgentSnapshot(snapshot);
      // The server may still be reaching readiness when the first snapshot
      // lands (waitForServer runs async at boot). Re-hydrate shortly after so
      // the heartbeat reflects reality without waiting for the first chat.
      if (snapshot.server?.processReady !== true) {
        setTimeout(() => {
          if (disposed) return;
          agent.getState().then((next) => { if (!disposed) hydrateAgentSnapshot(next); }).catch(() => {});
        }, 8000);
      }
      const activeThreadId = snapshot.threads?.activeThreadId || snapshot.task?.threadId;
      if (activeThreadId && agent.runCommand) {
        agent.runCommand("thread.switch", { threadId: activeThreadId }).then((result) => {
          if (disposed) return;
          if (result?.task) {
            acceptTaskSnapshot(result.task);
            setModelSelection(normalizeModelSelection({ provider: result.task.provider, model: result.task.model, reasoning: result.task.reasoning }));
          }
          if (Array.isArray(result?.conversation) && result.conversation.length) {
            setMessages((current) => current.length ? current : result.conversation.map((entry) => ({ id: entry.id, role: entry.role, content: entry.content, channels: entry.channels || [], provider: entry.provider, model: entry.model, reasoning: entry.reasoning, rawOutputRef: entry.rawOutputRef, partial: entry.partial || false, stopReason: entry.stopReason || null, createdAt: entry.createdAt || null, time: entry.createdAt ? formatTime(entry.createdAt) : "" })));
          }
        }).catch((conversationError) => {
          if (!disposed) setError(`Hemlock conversation history unavailable: ${conversationError.message}`);
        });
      }
    }).catch((stateError) => setError(`Hemlock runtime state unavailable: ${stateError.message}`));
    const ingestAgentEvent = (event) => {
      setEvents((current) => current.some((item) => item.id === event.id) ? current : [...current, event].slice(-160));
      const toast = workToastFor(event);
      if (toast) setWorkToasts((current) => pushWorkToast(current, toast));
      if (event.type === "task.updated" && event.payload?.task) acceptTaskSnapshot(event.payload.task);
      if (event.type === "maple.server.ready" && event.payload?.processReady === true) setServerProcessReady(true);
      if (event.type === "thread.switched" && event.payload?.threadId) {
        const switchedThreadId = event.payload.threadId;
        setThreadRegistry((current) => ({ ...current, activeThreadId: switchedThreadId }));
        // A thread switch (from any window/path) must swap the visible
        // transcript to the new thread's stored conversation — otherwise the
        // old chat bleeds into the new thread's context.
        setMessages([]);
        const switchAgent = desktopAgent();
        if (isDesktop && switchAgent?.runCommand) {
          switchAgent.runCommand("conversation.history", { threadId: switchedThreadId }).then((history) => {
            if (Array.isArray(history?.conversation) && history.conversation.length) {
              setMessages(history.conversation.map((entry) => ({ id: entry.id, role: entry.role, content: entry.content, channels: entry.channels || [], provider: entry.provider, model: entry.model, reasoning: entry.reasoning, rawOutputRef: entry.rawOutputRef, partial: entry.partial || false, stopReason: entry.stopReason || null, createdAt: entry.createdAt || null, time: entry.createdAt ? formatTime(entry.createdAt) : "" })));
            }
          }).catch((historyError) => setError(`Hemlock conversation history unavailable: ${historyError.message}`));
        }
      }
      // Thread lifecycle events from other surfaces (or agent-initiated forks)
      // leave the registry stale — re-read it rather than patching locally.
      if (["thread.forked", "thread.deleted", "thread.checkpoint.restored"].includes(event.type)) void refreshThreadRegistry();
      if (event.type === "conversation.response" && event.payload?.conversation) {
        // Ignore responses that belong to another thread — they must not
        // appear in this thread's transcript or ride along as its context.
        const responseThreadId = event.payload.threadId || event.payload.conversation.threadId;
        if (!responseThreadId || responseThreadId === (task.threadId || threadRegistry.activeThreadId)) appendConversationResponse(event.payload.conversation);
      }
      if (event.type === "suggestion.created" && event.payload?.suggestion) setSuggestions((current) => [...current.filter((item) => item.suggestionId !== event.payload.suggestion.suggestionId), event.payload.suggestion].slice(-32));
      if (event.type === "task.queue.updated" && event.payload?.queue) setQueueState(event.payload.queue);
      if (event.type === "candidate.created" && event.payload?.candidate) setCandidates((current) => [...current.filter((item) => item.id !== event.payload.candidate.id), event.payload.candidate].slice(-120));
      if (event.type === "candidate.accepted" || event.type === "candidate.dismissed") setCandidates((current) => current.map((item) => item.id === event.payload?.candidate?.id ? event.payload.candidate : item));
      if (event.type === "change-set.prepared" || event.type === "change-set.approved" || event.type === "change-set.rejected") setChangeSet(event.payload?.changeSet || null);
      if (event.type === "conversation.episode.completed" && event.payload?.episode) setAgentProjection((current) => ({ ...(current || {}), episodes: [...(current?.episodes || []).filter((item) => item.id !== event.payload.episode.id), event.payload.episode].slice(-40) }));
      if (event.type === "episode.updated" && event.payload?.episode) setAgentProjection((current) => ({ ...(current || {}), episodes: [...(current?.episodes || []).filter((item) => item.id !== event.payload.episode.id), event.payload.episode].slice(-40) }));
      if (event.type === "plan.proposed" || event.type === "plan.awaiting_approval" || event.type === "plan.approved" || event.type === "plan.rejected") {
        setAgentProjection((current) => {
          const plan = event.payload?.plan || (event.payload?.planId ? (current?.plans || []).find((item) => item.id === event.payload.planId) : null);
          const projectedPlan = plan && event.type === "plan.approved" ? { ...plan, status: "approved", approvedAt: event.createdAt } : plan && event.type === "plan.rejected" ? { ...plan, status: "rejected", rejectedAt: event.createdAt } : plan;
          return projectedPlan ? { ...(current || {}), plans: [...(current?.plans || []).filter((item) => item.id !== projectedPlan.id), projectedPlan] } : current;
        });
      }
      // plan.adapted carries only the inserted step, not the plan — splice it
      // into the projected plan so the step rail reflects adaptive selection.
      if (event.type === "plan.adapted" && event.payload?.insertedStep) {
        setAgentProjection((current) => {
          const plans = current?.plans || [];
          const plan = plans.find((item) => item.id === event.payload.planId);
          if (!plan) return current;
          const inserted = event.payload.insertedStep;
          const steps = [...(plan.steps || [])];
          const at = Math.max(0, Math.min(steps.length, (inserted.step || steps.length + 1) - 1));
          if (steps[at]?.commandId === inserted.commandId) steps[at] = { ...steps[at], ...inserted };
          else steps.splice(at, 0, inserted);
          const nextPlan = { ...plan, steps, lastAdaptiveDecision: { atStep: at + 1, commandId: inserted.commandId, reason: inserted.selectionReason || event.payload?.reason || null } };
          return { ...current, plans: plans.map((item) => (item.id === plan.id ? nextPlan : item)) };
        });
      }
      if (event.type.startsWith("action.") && event.payload?.action) setAgentProjection((current) => ({ ...(current || {}), actions: [...(current?.actions || []).filter((item) => item.id !== event.payload.action.id), event.payload.action] }));
      if (event.type === "observation.recorded" && event.payload?.observation) setAgentProjection((current) => ({ ...(current || {}), observations: [...(current?.observations || []).filter((item) => item.id !== event.payload.observation.id), event.payload.observation] }));
      if (event.type === "context.source.policy.updated" && event.payload?.source) setSourcePolicies((current) => current.map((item) => item.sourceId === event.payload.source.sourceId ? event.payload.source : item));
      if (event.type === "command.started") setCommandBusy(event.payload?.command || "working");
      if (event.type === "command.completed") setCommandBusy("");
      if (event.type === "experiment.note.recorded") setExperimentDataset((current) => ({ schema: "hemlock.world.dataset.summary.v1", ...(current || {}), count: (current?.count || 0) + 1, latest: { id: event.payload?.findingId || null, experiment: event.payload?.experiment || null, recordedAt: event.createdAt || null } }));
      if (event.type === "world.placed" && event.payload?.marker) setWorldMarkers((current) => [...current.filter((item) => item.id !== event.payload.marker.id), event.payload.marker].slice(-48));
      if (event.type === "context.quality.updated") {
        setContextSnapshot((current) => ({
          ...(current || {}),
          quality: event.payload?.quality || current?.quality,
          providers: event.payload?.providers || current?.providers,
          updatedAt: event.createdAt,
        }));
      }
      if (event.type.startsWith("artifact.") && event.payload?.artifact) {
        setArtifacts((current) => [...current.filter((item) => item.id !== event.payload.artifact.id), event.payload.artifact].slice(-40));
        setActiveArtifactId(event.payload.artifact.id);
        if (event.payload.artifact.revision > 0) {
          previewConsoleErrorsRef.current = [];
          previewReportPartsRef.current = {};
          setPreviewConsoleLines([]);
        }
        if (event.payload.artifact.revision > 0 && !artifactPeekedRef.current) { artifactPeekedRef.current = true; peekArtifact(); }
      }
      if (event.type === "artifact.preview.ready" && event.payload?.session) setPreviewSession(event.payload.session);
      if (event.type === "artifact.inspection.completed") setPreviewInspection(event.payload?.inspection || null);
    };
    // Host events can arrive in bursts during active tasks; queue them and
    // drain once per ~16ms window (or immediately past the queue cap) so a
    // burst is one React state pass, not one render per event.
    const eventBuffer = createEventBuffer({
      onFlush: (batch) => { for (const event of batch) ingestAgentEvent(event); },
    });
    const stop = agent.subscribe?.((event) => eventBuffer.push(event));
    // Coalesce high-frequency stream deltas before they touch React state:
    // buffered frames replay in push order through the same reducer below on
    // one flush (rAF or a 50ms cap, whichever first); a terminal frame drains
    // synchronously so completion never lags. Per-frame dedupe is preserved.
    const flushStreamedMessages = (frames) => {
      for (const frame of frames) {
        const previous = liveStreamState.current.get(frame.streamId) || { sequence: -1, text: "", channels: {} };
        if (Number.isFinite(frame.sequence) && frame.sequence <= previous.sequence) continue;
        const channel = frame.channel || "content";
        const channels = { ...(previous.channels || {}) };
        channels[channel] = `${channels[channel] || ""}${frame.delta || ""}`;
        liveStreamState.current.set(frame.streamId, { sequence: frame.sequence, text: channels.content || "", channels, terminal: frame.terminal, status: frame.status });
        // Internal structured-action reasoning is streamed into Activity and
        // receipts, but it is not a conversational assistant message. Only the
        // model_text lane should materialize in the Chat transcript.
        if (frame.kind !== "model_text") continue;
        setMessages((current) => {
          const index = current.findIndex((message) => message.streamId === frame.streamId);
          if (index < 0 && (frame.delta || frame.terminal)) return [...current, { id: crypto.randomUUID(), role: "assistant", content: channels.content || "", channels: Object.entries(channels).map(([name, text]) => ({ name, text, visible: true, source: frame.provider || "maple" })), provider: frame.provider || "maple", streamId: frame.streamId, streaming: !frame.terminal, telemetry: null, streamStopReason: frame.stopReason || null, displayMode: "model-verbatim", createdAt: frame.createdAt || new Date().toISOString(), time: formatTime() }];
          if (index < 0) return current;
          return current.map((message, messageIndex) => messageIndex === index ? { ...message, content: channels.content || "", channels: Object.entries(channels).map(([name, text]) => ({ name, text, visible: true, source: frame.provider || message.provider || "maple" })), provider: frame.provider || message.provider || "maple", streaming: !frame.terminal, streamStatus: frame.status, streamStopReason: frame.stopReason || message.streamStopReason || null } : message);
        });
      }
    };
    const streamedMessageCoalescer = createFrameCoalescer({ onFlush: flushStreamedMessages });
    const stopStream = agent.subscribeStream?.((frame) => {
      streamStoreRef.current?.apply(frame);
      streamedMessageCoalescer.push(frame);
    });
    return () => { disposed = true; stop?.(); stopStream?.(); streamedMessageCoalescer.dispose(); eventBuffer.dispose(); };
  }, [isDesktop]);

  // Toast expiry sweep: only ticks while toasts exist, and only ever removes
  // entries past their own expiresAt — a fresh toast never clears an old one.
  useEffect(() => {
    if (!workToasts.length) return undefined;
    const timer = setInterval(() => setWorkToasts((current) => pruneWorkToasts(current, Date.now())), 2000);
    return () => clearInterval(timer);
  }, [workToasts.length]);

  useEffect(() => {
    const onPreviewMessage = (event) => {
      if (event.data?.source !== "hemlock-preview-harness") return;
      const frame = document.querySelector(".artifact-preview-frame");
      if (frame?.contentWindow && event.source !== frame.contentWindow) return;
      const type = event.data.type;
      if (type === "console") {
        if (event.data.payload?.level === "error") previewConsoleErrorsRef.current = [...previewConsoleErrorsRef.current, event.data.payload].slice(-20);
        setPreviewConsoleLines((current) => [...current, { level: event.data.payload?.level || "log", message: String(event.data.payload?.message || ""), time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) }].slice(-100));
        setPreviewNotice(`${event.data.payload?.level || "log"}: ${event.data.payload?.message || "preview console output"}`);
      }
      if (type === "inspection" || type === "accessibility" || type === "ready" || type === "condition") {
        const payload = event.data.payload || {};
        previewReportPartsRef.current = {
          ...previewReportPartsRef.current,
          ready: true,
          inspection: type === "inspection" || type === "condition" ? payload : previewReportPartsRef.current.inspection || (payload.dom ? { dom: payload.dom, digest: payload.digest || null } : null),
          accessibility: type === "accessibility" ? payload : previewReportPartsRef.current.accessibility || payload.accessibility || null,
        };
        setPreviewInspection(payload || null);
        const session = previewSession;
        const agent = desktopAgent();
        if (isDesktop && session && agent?.reportPreview) {
          const parts = previewReportPartsRef.current;
          void agent.reportPreview({
            schema: "hemlock.agent.artifact.preview.report.v1",
            taskId: session.taskId,
            artifactId: session.artifactId,
            revision: session.revision,
            sessionId: session.id,
            ready: Boolean(parts.ready),
            inspection: parts.inspection,
            accessibility: parts.accessibility,
            consoleErrors: previewConsoleErrorsRef.current,
            inspectionDigest: null,
          }).catch((reportError) => setPreviewNotice(`Preview report unavailable: ${reportError.message}`));
        }
      }
      if (event.data.type === "blocked") setPreviewNotice(`Preview action blocked: ${event.data.payload?.reason || "registered target required"}`);
    };
    window.addEventListener("message", onPreviewMessage);
    return () => window.removeEventListener("message", onPreviewMessage);
  }, [isDesktop, previewSession]);

  useEffect(() => {
    if (!isDesktop || !previewSession) return undefined;
    const frame = document.querySelector(".artifact-preview-frame");
    if (!frame?.contentWindow) return undefined;
    const timer = window.setTimeout(() => {
      frame.contentWindow.postMessage({ source: "hemlock-preview", action: "inspect" }, "*");
      frame.contentWindow.postMessage({ source: "hemlock-preview", action: "accessibility" }, "*");
    }, 0);
    return () => window.clearTimeout(timer);
  }, [isDesktop, previewSession, activeArtifactId]);

  useEffect(() => {
    const agent = desktopAgent();
    if (!isDesktop || !window.mapleDesktop?.onSipsProgress) return undefined;
    return window.mapleDesktop.onSipsProgress((update) => {
      if (typeof update.progress === "number") setSipsProgress(Math.max(0, Math.min(update.progress, 100)));
      if (update.stage) setSipsStage(update.stage);
      if (update.log) setSipsLog(update.log);
      if (update.receiptPath) setSipsLog(update.receiptPath);
    });
  }, [isDesktop]);

  useEffect(() => {
    if (!isDesktop) return undefined;
    const onKeyDown = (event) => {
      // A modal confirm dialog owns the keyboard while it is open; OS-level
      // shortcuts must not fire underneath it.
      if (confirmStateRef.current) return;
      if (overviewOpen || shortcutHelpOpen || dockMenu) return;
      if (paletteOpen) { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); paletteRef.current?.focus(); } return; }
      if (comparePickerOpen) { if (event.key === "Escape") setComparePickerOpen(false); return; }
      const shortcutKey = event.code?.startsWith("Key") ? event.code.slice(3).toLowerCase() : event.key.toLowerCase();
      if (event.key === "F1") { event.preventDefault(); showShortcuts(); return; }
      if ((event.metaKey || event.ctrlKey) && event.altKey && shortcutKey === "d") { event.preventDefault(); toggleDesktop(); return; }
      // ⌘W closes the focused window (⌘⌥W still works as an alias). In the
      // browser preview this intercepts the tab-close chord for the app shell.
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && shortcutKey === "w") { event.preventDefault(); if (activeWindowId) void closeWindow(activeWindowId); return; }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "o") {
        event.preventDefault();
        setPaletteOpen(false);
        setOverviewOpen(true);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen(true);
      }
      // Stable app shortcuts never change when window focus changes. The
      // command palette intercepts digits for its own result jumps.
      if ((event.metaKey || event.ctrlKey) && !event.altKey && /^[0-9]$/.test(event.key)) {
        if (paletteOpen) return;
        const targetId = shortcutApp(event.key);
        if (targetId) {
          event.preventDefault();
          openWindow(targetId);
        }
        return;
      }
      // Cycle windows: Cmd+Backtick walks open windows front-to-back — from
      // the focused window to the next one behind it, wrapping at the back.
      if ((event.metaKey || event.ctrlKey) && event.key === "`") {
        event.preventDefault();
        const nextWindowId = nextWindowInCycle(workspaceWindowsRef.current, activeWindowId);
        if (nextWindowId) focusWindow(nextWindowId);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.altKey) {
        const command = event.key === "ArrowLeft" ? "half-left" : event.key === "ArrowRight" ? "half-right" : event.key === "ArrowUp" ? "maximize" : event.key === "ArrowDown" ? "restore" : shortcutKey === "m" ? "minimize" : null;
        if (command) {
          event.preventDefault();
          if (!activeWindowId) return;
          if (command === "minimize") minimizeWindow(activeWindowId);
          else setWorkspaceWindows((current) => ({ ...current, [activeWindowId]: keyboardPlacement(current[activeWindowId], command, canvasSize) }));
        }
      }
      if (event.key === "Escape") {
        // Escape dismisses overlays. It must NEVER cancel running work: the
        // palette, popovers, and dialogs all close on Escape, which trains a
        // reflex that would otherwise destroy hours of local training. Cancellation
        // is an explicit action (the Dream Lab stop control) with its own confirm.
        if (comparePickerOpen) setComparePickerOpen(false);
        if (paletteOpen) setPaletteOpen(false);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [activeWindowId, canvasSize, isDesktop, isDreaming, paletteOpen, comparePickerOpen, overviewOpen, shortcutHelpOpen, dockMenu, desktopSnapshot, skipCloseWarning]);

  useEffect(() => {
    if (!paletteOpen) return undefined;
    // Focus trap: Tab must cycle inside the palette, not walk into the frozen
    // desktop behind the backdrop. Focus returns to the trigger on close.
    const paletteOpener = document.activeElement;
    paletteRef.current?.focus();
    const onTrap = (event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setPaletteOpen(false); return; }
      if (event.key !== "Tab") return;
      const focusables = document.querySelectorAll(".command-palette input, .command-palette button:not([disabled])");
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onTrap, true);
    return () => { document.removeEventListener("keydown", onTrap, true); if (paletteOpener instanceof HTMLElement) paletteOpener.focus(); };
  }, [paletteOpen]);

  useEffect(() => {
    if (!confirmState) return undefined;
    // Focus trap for the confirm alertdialog: Tab cycles between its two
    // buttons; Escape/Enter are handled by the dialog's own key handling.
    const opener = document.activeElement;
    const dialog = document.querySelector(".confirm-dialog");
    const firstButton = dialog?.querySelector("button:not(.close-warning-opt-out)");
    firstButton?.focus();
    const onTrap = (event) => {
      if (event.key === "Escape") { event.stopPropagation(); settleConfirmDialog(false); return; }
      if (event.key === "Enter" && event.target instanceof HTMLElement && event.target.tagName !== "BUTTON") { event.preventDefault(); settleConfirmDialog(true); return; }
      if (event.key !== "Tab") return;
      const focusables = dialog ? [...dialog.querySelectorAll("button:not([disabled])")] : [];
      if (focusables.length < 2) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onTrap, true);
    return () => { document.removeEventListener("keydown", onTrap, true); if (opener instanceof HTMLElement) opener.focus(); };
  }, [confirmState]);

  useEffect(() => { setPaletteActiveIndex(0); }, [paletteQuery, paletteOpen]);
  // Lane B: thread content search. `thread.search` IS allowlisted in
  // runAgentCommand (electron/main.cjs), so this probe lights up body matches
  // with no renderer change. It calls the sanctioned agent:command channel
  // directly — deliberately bypassing runCommand() so a missing route never
  // raises the error banner or flickers commandBusy. If the route is ever
  // unavailable the probe fails once and is never retried this session.
  useEffect(() => {
    const query = paletteQuery.trim();
    if (!paletteOpen || query.length < 2 || threadSearchSupportRef.current.available === false) {
      setPaletteContentMatches([]);
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      const agent = desktopAgent();
      if (!agent?.runCommand) {
        threadSearchSupportRef.current.available = false;
        return;
      }
      agent.runCommand("thread.search", { query, limit: 6 }).then((result) => {
        if (cancelled) return;
        threadSearchSupportRef.current.available = true;
        const rows = Array.isArray(result) ? result : Array.isArray(result?.results) ? result.results : [];
        setPaletteContentMatches(rows);
      }).catch(() => {
        if (cancelled) return;
        threadSearchSupportRef.current.available = false;
        setPaletteContentMatches([]);
      });
    }, 200);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [paletteOpen, paletteQuery]);

  useEffect(() => { confirmStateRef.current = confirmState; }, [confirmState]);

  useEffect(() => {
    if (confirmState) confirmAcceptButtonRef.current?.focus();
  }, [confirmState]);

  // Dock truthfulness baseline: history that hydrates at boot is not "unread
  // activity". Only events arriving after this point mark unfocused windows.
  useEffect(() => {
    if (unreadBaselineSeededRef.current || !events.length) return;
    unreadBaselineSeededRef.current = true;
    Object.keys(WINDOW_META).forEach((id) => { if (!seenEventCountsRef.current.has(id)) seenEventCountsRef.current.set(id, events.length); });
  }, [events]);

  useEffect(() => {
    const move = (event) => {
      const drag = dragRef.current;
      const resize = resizeRef.current;
      if (!drag && !resize) return;
      if (drag) {
        const rect = canvasRef.current.getBoundingClientRect();
        const command = pointerSnapCommand(event.clientX - rect.left, event.clientY - rect.top, canvasSize, { altKey: event.altKey });
        if (command !== drag.snapCommand) {
          drag.snapCommand = command;
          const item = workspaceWindowsRef.current[drag.id];
          setSnapPreview(command ? { command, bounds: keyboardPlacement(item, command, canvasSize).bounds } : null);
        }
      }
      setWorkspaceWindows((current) => {
        const state = current[drag?.id || resize.id];
        if (!state || state.state === "maximized") return current;
        if (drag) {
          const origin = { ...state, bounds: drag.originBounds };
          return { ...current, [drag.id]: moveWindow(origin, event.clientX - drag.startX, event.clientY - drag.startY, canvasSize, { enabled: false }) };
        }
        const origin = { ...state, bounds: resize.originBounds };
        return { ...current, [resize.id]: resizeWindow(origin, resize.edge, event.clientX - resize.startX, event.clientY - resize.startY, canvasSize, { altKey: event.altKey }) };
      });
    };
    const up = (event) => {
      const action = dragRef.current || resizeRef.current;
      if (action?.id) setWorkspaceWindows((current) => {
        const item = current[action.id];
        const placed = event.type === "pointerup" && action.snapCommand && !event.altKey
          ? keyboardPlacement(item, action.snapCommand, canvasSize)
          : { ...item, bounds: clampBounds(item.bounds, canvasSize, item.minimumSize) };
        return { ...current, [action.id]: placed };
      });
      dragRef.current = null;
      resizeRef.current = null;
      setSnapPreview(null);
      setDraggingWindowId(null);
      setResizingWindowId(null);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", up);
    window.addEventListener("blur", up);
    return () => { document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", up); document.removeEventListener("pointercancel", up); window.removeEventListener("blur", up); };
  }, [canvasSize]);

  const chatMessages = useMemo(() => messages.map(({ role, content }) => ({ role, content })), [messages]);
  const bakedFacts = useMemo(() => facts.filter((fact) => fact.baked), [facts]);
  const memoryRecords = useMemo(() => events.filter((event) => ["memory.promoted", "memory.candidate.created", "memory.promote", "memory.demote", "memory.rollback"].includes(event.type)).map((event) => ({ ...event.payload?.record, id: event.payload?.record?.id || event.payload?.targetId, event })), [events]);
  const activeLessons = useMemo(() => memoryRecords.filter((item) => item.event?.type === "memory.promoted" && item.body).slice(-4), [memoryRecords]);
  const memoryMessage = useMemo(() => {
    const lines = [];
    if (bakedFacts.length) lines.push("Saved personal facts:\n" + bakedFacts.map((fact) => `- ${fact.text}`).join("\n"));
    if (activeLessons.length) lines.push("Verified local project lessons:\n" + activeLessons.map((item) => `- ${item.body}`).join("\n"));
    if (!lines.length) return null;
    return { role: "system", content: ["You are Hemlock, a private local assistant running through Maple-Preview.", ...lines, "Use these local context items when relevant. Do not invent facts or claim a receipt you do not have."].join("\n\n") };
  }, [activeLessons, bakedFacts]);
  const latestEvent = events.at(-1);
  const latestReceiptEvent = useMemo(() => [...events].reverse().find((event) => event.type.includes("completed") && event.evidenceRefs?.length) || latestEvent, [events, latestEvent]);
  const artifactForPreview = artifacts.find((item) => item.id === activeArtifactId) || artifacts.at(-1) || null;
  // The preview srcDoc concatenates the whole artifact source map (potentially
  // MBs) plus the interaction harness — rebuild only when the artifact itself
  // changed, not on every event/stream render.
  const previewSrc = useMemo(() => artifactForPreview?.status === "failed" && artifactForPreview?.lastKnownGoodSource ? previewDocument({ ...artifactForPreview, source: artifactForPreview.lastKnownGoodSource }) : previewDocument(artifactForPreview), [artifactForPreview]);
  const serverState = serverProcessReady === true ? "ready" : serverProcessReady === false ? "down" : "unknown";
  const liveStream = hasLiveStream(streamFrames);
  const taskProgress = isDreaming ? dreamProgress : sipsCycleState === "running" ? sipsProgress : liveStream || isThinking ? 42 : task.status === "completed" ? 100 : 0;
  const selectedLane = MODEL_LANES[modelSelection.provider] || MODEL_LANES.maple;
  const selectedProviderStatus = providerStatuses.find((item) => item.provider === selectedLane.provider) || null;
  const selectedProviderState = selectedLane.provider === "maple"
    ? serverState
    : selectedProviderStatus?.authenticated ? "ready" : selectedProviderStatus?.installed === false ? "down" : "unknown";

  function addEventPreview(type, status, payload = {}) {
    const event = { schema: "hemlock.agent.event.v1", id: `preview-${Date.now()}-${Math.random()}`, sessionId: "browser-preview", taskId: task.id, type, status, source: "renderer-preview", createdAt: new Date().toISOString(), payload, evidenceRefs: [], reversible: false };
    setEvents((current) => [...current, event].slice(-160));
    return event;
  }

  async function emitAgentEvent(type, status, payload = {}, evidenceRefs = []) {
    if (isDesktop && window.mapleDesktop?.emitAgentEvent) {
      try {
        const event = await window.mapleDesktop.emitAgentEvent({ type, status, payload, evidenceRefs });
        setEvents((current) => current.some((item) => item.id === event.id) ? current : [...current, event].slice(-160));
        return event;
      } catch (eventError) {
        setError(`Could not record local event: ${eventError.message}`);
      }
    }
    return addEventPreview(type, status, payload);
  }

  async function updateTask(patch) {
    setTask((current) => ({ ...current, ...patch, updatedAt: new Date().toISOString() }));
    if (isDesktop && window.mapleDesktop?.updateAgentTask) {
      try { const next = await window.mapleDesktop.updateAgentTask(patch); acceptTaskSnapshot(next); } catch (taskError) { setError(`Could not update local task: ${taskError.message}`); }
    } else addEventPreview("task.updated", patch.status || "observed", { task: { ...task, ...patch } });
  }

  function focusWindow(id) {
    revealWindow(id);
    setActiveWindowId(id);
    // Focusing a window acknowledges its unread activity (dock gold dot).
    seenEventCountsRef.current.set(id, events.length);
    setWorkspaceWindows((current) => focusWindowState(current, id, undefined, canvasSize));
  }

  function openWindow(id) {
    revealWindow(id);
    setActiveWindowId(id);
    seenEventCountsRef.current.set(id, events.length);
    setWorkspaceWindows((current) => current[id]?.state !== "closed"
      ? focusWindowState(current, id, undefined, canvasSize)
      : openWindowBounds(current, id, canvasSize, { collisionAware: true }));
  }

  function revealWindow(id) {
    if (window.innerWidth < 760) requestAnimationFrame(() => document.querySelector(`.window-${id}`)?.scrollIntoView({ block: "start" }));
  }

  function placeWindow(id, command) {
    setActiveWindowId(id);
    setWorkspaceWindows((current) => normalizeZOrder({ ...current, [id]: keyboardPlacement(current[id], command, canvasSize) }, id));
    setDockMenu(null);
  }

  function showWindowMenu(id, opener, placement = "below") {
    if (!opener) return;
    const rect = opener.getBoundingClientRect();
    setDockMenu({ windowId: id, x: rect.left, y: placement === "above" ? rect.top : rect.bottom, placement, opener });
  }

  function runWindowAction(id, action) {
    setDockMenu(null);
    if (action === "close") { void closeWindow(id); return; }
    if (action === "minimize") { minimizeWindow(id); return; }
    if (action === "focus") { focusWindow(id); return; }
    if (action === "center" || action === "default-size") {
      setActiveWindowId(id);
      setWorkspaceWindows(current => normalizeZOrder({ ...current, [id]: centerWindow(current[id], canvasSize, action === "default-size") }, id));
      return;
    }
    placeWindow(id, action);
  }

  function toggleDesktop() {
    setDockMenu(null);
    setInspectorOpen(false);
    if (desktopSnapshot) {
      const restored = restoreWorkspace(workspaceWindowsRef.current, desktopSnapshot, canvasSize);
      setWorkspaceWindows(restored.windows);
      setActiveWindowId(restored.activeId);
      setDesktopSnapshot(null);
    } else {
      const hidden = minimizeWorkspace(workspaceWindowsRef.current, activeWindowId, canvasSize);
      if (!hidden.snapshot.ids.length) return;
      setDesktopSnapshot(hidden.snapshot);
      setWorkspaceWindows(hidden.windows);
      setActiveWindowId(null);
    }
  }

  function showShortcuts() {
    setPaletteOpen(false);
    setOverviewOpen(false);
    setDockMenu(null);
    setShortcutHelpOpen(true);
  }

  function dismissWindow(id, state) {
    if (id === "chat") setInspectorOpen(false);
    // Focus returns to the previously focused window — the next frontmost one
    // in z-order behind the dismissed window.
    const nextId = focusHandoffId(workspaceWindowsRef.current, id);
    setWorkspaceWindows((current) => {
      const next = { ...current, [id]: setWindowState(current[id], state, canvasSize) };
      return activeWindowId === id && nextId ? focusWindowState(next, nextId, undefined, canvasSize) : next;
    });
    if (activeWindowId === id) setActiveWindowId(nextId);
  }

  async function closeWindow(id) {
    if (skipCloseWarning) { dismissWindow(id, "closed"); return; }
    const confirmed = await confirmDialog({ title: `Close ${WINDOW_META[id]?.label || "this window"}?`, body: "Its state is kept. Reopen it any time from the dock; running work is not cancelled.", confirmLabel: "Close window", allowSkipCloseWarning: true });
    if (confirmed) dismissWindow(id, "closed");
  }

  function neverWarnOnWindowClose() {
    localStorage.setItem(CLOSE_WARNING_KEY, JSON.stringify({ skip: true }));
    setSkipCloseWarning(true);
    settleConfirmDialog(true);
  }

  function minimizeWindow(id) {
    const frame = windowElement(id);
    const dock = dockElement(id);
    if (frame && dock) void morphToDock(frame, dock).then(() => dismissWindow(id, "minimized"));
    else dismissWindow(id, "minimized");
  }

  function maximizeWindow(id) {
    setActiveWindowId(id);
    setWorkspaceWindows((current) => normalizeZOrder({ ...current, [id]: toggleMaximize(current[id], canvasSize) }, id));
  }

  function startDrag(event, id) {
    if (event.button !== 0 || event.target.closest("button") || window.innerWidth < 760) return;
    const state = workspaceWindows[id];
    if (!state || state.state === "maximized" || state.state === "closed") return;
    focusWindow(id);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDraggingWindowId(id);
    dragRef.current = { id, startX: event.clientX, startY: event.clientY, originBounds: state.bounds };
  }

  function startResize(event, id, edge = "bottom-right") {
    event.stopPropagation();
    if (event.button !== 0) return;
    const state = workspaceWindows[id];
    if (!state || state.state === "maximized" || state.state === "closed") return;
    focusWindow(id);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setResizingWindowId(id);
    resizeRef.current = { id, edge, startX: event.clientX, startY: event.clientY, originBounds: state.bounds };
  }

  function resizeWithKeyboard(id, edge, dx, dy) {
    setWorkspaceWindows((current) => ({ ...current, [id]: resizeWindow(current[id], edge, dx, dy, canvasSize) }));
  }

  async function runCommand(action, payload = {}) {
    const agent = desktopAgent();
    if (!isDesktop || !agent?.runCommand) {
      setError("Browser preview cannot run local Hemlock commands. Open the Electron app for the control plane.");
      return null;
    }
    setCommandBusy(action);
    setError("");
    try {
      const result = await agent.runCommand(action, payload);
      if (result?.task) acceptTaskSnapshot(result.task);
      if (result?.plan) setAgentProjection((current) => ({ ...(current || {}), plans: [...(current?.plans || []).filter((item) => item.id !== result.plan.id), result.plan] }));
      if (result?.action) setAgentProjection((current) => ({ ...(current || {}), actions: [...(current?.actions || []).filter((item) => item.id !== result.action.id), result.action] }));
      if (result?.observation) setAgentProjection((current) => ({ ...(current || {}), observations: [...(current?.observations || []).filter((item) => item.id !== result.observation.id), result.observation] }));
      if (result?.threads || result?.projects || result?.providerActive) setThreadRegistry((current) => ({ ...current, ...(result?.threads ? { threads: result.threads } : {}), ...(result?.projects ? { projects: result.projects } : {}), ...(result?.providerActive ? { providerActive: result.providerActive } : {}) }));
      if (result?.thread) setThreadRegistry((current) => ({ ...current, threads: [...(current.threads || []).filter((item) => item.id !== result.thread.id), result.thread], activeThreadId: action === "thread.switch" ? result.thread.id : current.activeThreadId }));
      if (result?.suggestion) setSuggestions((current) => [...current.filter((item) => item.suggestionId !== result.suggestion.suggestionId), result.suggestion]);
      if (Array.isArray(result?.suggestions)) setSuggestions(result.suggestions);
      if (action === "thread.switch" && result?.task) {
        acceptTaskSnapshot(result.task);
        setModelSelection(normalizeModelSelection({ provider: result.task.provider, model: result.task.model, reasoning: result.task.reasoning }));
        setMessages((result.conversation || []).map((entry) => ({ id: entry.id, role: entry.role, content: entry.content, channels: entry.channels || [], provider: entry.provider, model: entry.model, reasoning: entry.reasoning, rawOutputRef: entry.rawOutputRef, createdAt: entry.createdAt || null, time: entry.createdAt ? formatTime(entry.createdAt) : "" })));
        setArtifacts([]);
        setPreviewSession(null);
        setPreviewInspection(null);
      }
      if (action === "status") setSipsStatus(result);
      if (action === "context.refresh" || action === "context.search") setContextSnapshot(result);
      if (action === "context.refresh") {
        setAgentProjection((current) => ({ ...(current || {}), contextQuality: result?.quality || current?.contextQuality }));
        if (result?.sources) setSourcePolicies(result.sources);
      }
      if (action === "sources.get") setSourcePolicies(result?.sources || []);
      if (action === "sources.policy" && result?.source) setSourcePolicies((current) => current.map((item) => item.sourceId === result.source.sourceId ? result.source : item));
      if (action === "routes") setSipsRoutes(result.routes || []);
      if (action === "recall") { setSipsRecall(result); openWindow("memory"); }
      if (action === "repo-map") { setSipsRepoMap(result); openWindow("map"); }
      if (action === "verify") { setSipsVerifyReceipt(result); openWindow("receipts"); }
      if (action === "receipts.query") { setReceiptRecords(result?.receipts || []); setAgentProjection((current) => ({ ...(current || {}), receipts: result })); openWindow("receipts"); }
      if (action === "memory.list") setMemoryInventory(result?.records || []);
      if (action === "experiment.suggest") openWindow("grove");
      // Mutating memory commands leave the annotated inventory stale — refetch
      // the read-only listing so age/cluster fields stay honest afterwards.
      if (["memory.consolidate", "memory.promote", "memory.demote", "memory.rollback"].includes(action) && result) {
        agent.runCommand("memory.list").then((listed) => setMemoryInventory(listed?.records || [])).catch(() => {});
      }
      if (action === "change.prepare") { setChangeSet(result); openWindow("receipts"); }
      if (action === "change.approve" || action === "change.reject") setChangeSet(result);
      if (action === "world.state") { if (Array.isArray(result?.markers)) setWorldMarkers(result.markers); openWindow("grove"); }
      if (action === "candidate.create" && result?.candidate) setCandidates((current) => [...current, result.candidate].slice(-120));
      if (action === "candidate.accept" || action === "candidate.dismiss") setCandidates((current) => current.map((item) => item.id === result?.candidate?.id ? result.candidate : item));
      if (action === "selfloop") { setSipsStatus((await agent.runCommand("status")) || sipsStatus); }
      return result;
    } catch (commandError) {
      setError(commandError.message);
      return null;
    } finally {
      setCommandBusy("");
    }
  }

  // agent:queue-cancel returns the post-cancel snapshot; adopt it so the
  // readouts don't wait for the next task.queue.updated broadcast.
  async function cancelQueuedIntent(requestId) {
    try {
      const result = await desktopAgent()?.cancelQueued?.(requestId);
      if (result?.queue) setQueueState(result.queue);
      return result;
    } catch (cancelError) {
      setError(`Could not cancel the queued request: ${cancelError.message}`);
      return null;
    }
  }

  async function refreshAgentState() {
    const agent = desktopAgent();
    if (!isDesktop || !agent?.getState) {
      setError("The durable plan is available in the Hemlock desktop control plane.");
      return null;
    }
    setCommandBusy("agent.state");
    setError("");
    try {
      const snapshot = await agent.getState();
      hydrateAgentSnapshot(snapshot);
      return snapshot;
    } catch (stateError) {
      setError(`Hemlock runtime state unavailable: ${stateError.message}`);
      return null;
    } finally {
      setCommandBusy("");
    }
  }

  async function refreshThreadRegistry() {
    const result = await runCommand("thread.list");
    if (result?.threads) setThreadRegistry(result);
    const suggestionResult = await runCommand("suggestion.list");
    if (Array.isArray(suggestionResult?.suggestions)) setSuggestions(suggestionResult.suggestions);
  }

  // Settings surface loaders — the window triggers them on mount; reads stay
  // on the host (settings.get / deps.check) so the renderer never probes
  // the filesystem or python env itself.
  async function loadSettingsPanel() {
    if (!isDesktop) return null;
    const settings = await runCommand("settings.get");
    if (settings) setSettingsSnapshot(settings);
    if (!depsSnapshot) {
      const deps = await runCommand("deps.check");
      if (deps) setDepsSnapshot(deps);
    }
    return settings;
  }

  async function refreshDeps() {
    const result = await runCommand("deps.check");
    if (result) setDepsSnapshot(result);
    return result;
  }

  async function updateRuntimeSetting(key, value) {
    const result = await runCommand("settings.set", { key, value });
    if (result?.settings) {
      setSettingsSnapshot(result);
      // Live-apply seams the renderer owns: the persisted defaults land on
      // the controls that feed intent.submit on the next send.
      if (key === "autonomyDefault" && typeof result.settings.autonomyDefault === "string") setAutonomyMode(result.settings.autonomyDefault);
      if (key === "reasoningLevel" && typeof result.settings.reasoningLevel === "string") updateModelSelection({ reasoning: result.settings.reasoningLevel });
    }
    return result;
  }

  async function clearPromptCache() {
    const result = await runCommand("settings.clearPromptCache");
    if (result) {
      const settings = await runCommand("settings.get");
      if (settings) setSettingsSnapshot(settings);
    }
    return result;
  }

  async function switchThread(threadId) {
    if (!threadId || threadId === task.threadId) {
      setThreadPickerOpen(false);
      return;
    }
    const result = await runCommand("thread.switch", { threadId });
    if (result?.thread) {
      setThreadRegistry((current) => ({ ...current, activeThreadId: result.thread.id }));
      setThreadPickerOpen(false);
    }
  }

  function startThreadRename(threadId, currentTitle) {
    setRenamingThreadId(threadId);
    setRenameDraft(currentTitle || "");
  }

  async function commitThreadRename(threadId) {
    const title = renameDraft.trim();
    setRenamingThreadId(null);
    setRenameDraft("");
    if (!title) return;
    const result = await runCommand("thread.rename", { threadId, title });
    if (result?.thread) await refreshThreadRegistry();
  }

  async function archiveThread(threadId) {
    const confirmed = await confirmDialog({ title: "Archive this thread?", body: "The conversation moves to the archived list. You can restore it later from the thread picker.", confirmLabel: "Archive thread", tone: "default" });
    if (!confirmed) return;
    const result = await runCommand("thread.archive", { threadId });
    if (result?.thread) {
      await refreshThreadRegistry();
      // If the archived thread was active, move to the most recent remaining one.
      if (threadId === (task.threadId || threadRegistry.activeThreadId)) {
        const remaining = (threadRegistry.threads || []).filter((item) => item.id !== threadId && item.status !== "archived");
        if (remaining.length) await switchThread(remaining[0].id);
        else setThreadRegistry((current) => ({ ...current, activeThreadId: null }));
      }
    }
  }

  async function restoreThread(threadId) {
    const result = await runCommand("thread.restore", { threadId });
    if (result?.thread) await refreshThreadRegistry();
  }

  // Threads window helpers: detail fetches and lifecycle wrappers for an
  // arbitrary threadId (the chat picker's helpers only handle the common
  // switch/rename/archive/restore cases).
  async function loadThreadCheckpoints(threadId) {
    if (!threadId) return [];
    const result = await runCommand("thread.checkpoints", { threadId });
    const checkpoints = Array.isArray(result?.checkpoints) ? result.checkpoints : [];
    setThreadCheckpoints((current) => ({ ...current, [threadId]: checkpoints }));
    return checkpoints;
  }

  async function loadThreadConversation(threadId, limit = 40) {
    if (!threadId) return [];
    const result = await runCommand("thread.conversation", { threadId, limit });
    const conversation = Array.isArray(result?.conversation) ? result.conversation : [];
    setThreadConversations((current) => ({ ...current, [threadId]: conversation }));
    return conversation;
  }

  // Fork stays on the current thread — the new thread only joins the list;
  // the window decides whether to select or switch to it.
  async function forkThread(threadId, title) {
    const result = await runCommand("thread.fork", { threadId, ...(title ? { title } : {}) });
    if (result?.thread) await refreshThreadRegistry();
    return result?.thread || null;
  }

  async function restoreThreadCheckpoint(threadId, checkpointId) {
    const confirmed = await confirmDialog({ title: "Restore this checkpoint?", body: "The thread rolls back to this recorded state. A marker checkpoint preserves the current point first.", confirmLabel: "Restore checkpoint" });
    if (!confirmed) return null;
    const result = await runCommand("thread.checkpoint.restore", { threadId, checkpointId });
    if (result?.thread || result?.checkpoint) {
      await refreshThreadRegistry();
      await loadThreadCheckpoints(threadId);
    }
    return result;
  }

  async function pauseThread(threadId) {
    const result = await runCommand("thread.pause", { threadId });
    if (result?.thread) await refreshThreadRegistry();
    return result?.thread || null;
  }

  async function resumeThread(threadId) {
    const result = await runCommand("thread.resume", { threadId });
    if (result?.thread) await refreshThreadRegistry();
    return result?.thread || null;
  }

  async function cancelThread(threadId) {
    const thread = (threadRegistry.threads || []).find((item) => item.id === threadId);
    const confirmed = await confirmDialog({ title: "Cancel this thread?", body: `Cancellation is terminal — "${displayText(thread?.title, threadId)}" stops and cannot be resumed.`, confirmLabel: "Cancel thread", tone: "danger" });
    if (!confirmed) return null;
    const result = await runCommand("thread.cancel", { threadId });
    if (result?.thread) await refreshThreadRegistry();
    return result?.thread || null;
  }

  async function deleteThread(threadId) {
    const thread = (threadRegistry.threads || []).find((item) => item.id === threadId);
    const live = ["accepted", "planning", "running", "verifying", "repairing", "waiting_for_approval", "waiting_for_user", "paused", "blocked"].includes(thread?.status);
    const confirmed = await confirmDialog({
      title: "Delete this thread permanently?",
      body: live ? "This thread still has live work — deleting it force-cancels the run, then removes the registry entry, checkpoints, and stored conversation. This cannot be undone." : "The registry entry, checkpoints, and stored conversation are removed. This cannot be undone.",
      confirmLabel: "Delete thread",
      tone: "danger",
    });
    if (!confirmed) return null;
    const result = await runCommand("thread.delete", { threadId, ...(live ? { force: true } : {}) });
    if (result?.deleted) {
      setThreadCheckpoints((current) => { const next = { ...current }; delete next[threadId]; return next; });
      setThreadConversations((current) => { const next = { ...current }; delete next[threadId]; return next; });
      const listing = await runCommand("thread.list");
      if (listing?.threads) setThreadRegistry(listing);
      // Deleting the active thread re-points the host at another thread;
      // follow it so the transcript never shows a thread that no longer exists.
      if (threadId === (task.threadId || threadRegistry.activeThreadId) && listing?.activeThreadId) await switchThread(listing.activeThreadId);
    }
    return result;
  }

  async function createThread() {
    if (!isDesktop) {
      setError("Open the Hemlock desktop app to create and save threads. This browser view is a preview.");
      return;
    }
    // Native directory picker (Electron's dialog.showOpenDialog). The old
    // blocking JS prompt threw silently in Electron and killed the feature.
    try {
      const picked = await (window.mapleDesktop?.pickDirectory || window.hemlockAgent?.pickDirectory)?.();
      if (!picked || picked.canceled || !picked.path) return;
      const workspaceRoot = picked.path;
      setCommandBusy("thread.create");
      setError("");
      const result = await runCommand("thread.create", { workspaceRoot, title: "New Hemlock thread", provider: modelSelection.provider, model: modelSelection.model, reasoning: modelSelection.reasoning, autonomy: "bounded-local" });
      if (result?.thread) await switchThread(result.thread.id);
      else if (result === null) setError("Thread creation failed. Check the error banner and try again.");
    } catch (createError) {
      setError(`Could not create thread: ${createError.message}`);
    } finally {
      setCommandBusy("");
    }
  }

  // T8-F2: fresh context. Archives this thread's conversation so the model
  // stops re-reading poisoned history (refusal loops, dead ends) every turn.
  async function resetConversationContext() {
    if (!isDesktop) {
      setError("Fresh context requires the Hemlock desktop control plane.");
      return;
    }
    setCommandBusy("conversation.reset");
    setError("");
    try {
      const result = await runCommand("conversation.reset", { threadId: task.threadId || threadRegistry.activeThreadId });
      if (result?.status === "reset") {
        setMessages([]);
        setMessages((current) => current.some((message) => message.kind === "host-footnote" && message.text?.startsWith("Fresh context ·")) ? current : [...current, { id: `fresh-note-${Date.now()}`, role: "system", kind: "host-footnote", status: "passed", text: `Fresh context · ${result.archivedMessages} messages archived — the model starts from zero.`, content: `Fresh context · ${result.archivedMessages} messages archived`, provider: "host", createdAt: new Date().toISOString(), time: formatTime() }]);
      } else if (result === null) {
        setError("Context reset failed. Check the error banner and try again.");
      }
    } catch (resetError) {
      setError(`Could not reset context: ${resetError.message}`);
    } finally {
      setCommandBusy("");
    }
  }

  async function updateProviderCapacity(provider, value) {
    const parsed = Math.max(1, Math.min(8, Number(value) || 1));
    const result = await runCommand("provider.capacity", { caps: { [provider]: parsed } });
    if (result?.providerCaps) setThreadRegistry((current) => ({ ...current, providerCaps: result.providerCaps }));
  }

  async function transitionSuggestion(suggestion, status = "accepted") {
    const action = status === "accepted" ? "suggestion.accept" : status === "dismissed" ? "suggestion.dismiss" : "suggestion.snooze";
    const result = await runCommand(action, { suggestionId: suggestion.suggestionId });
    // T8-F6: provider escalation removed — accepted suggestions no longer
    // switch lanes; Hemlock runs only the selected model.
  }

  async function refreshSips() {
    const [status, routes] = await Promise.all([runCommand("status"), runCommand("routes")]);
    if (status) setSipsStatus(status);
    if (routes) setSipsRoutes(routes.routes || []);
  }

  function peekArtifact() {
    setWorkspaceWindows((current) => openWindowBounds(current, "artifact", canvasSize, { collisionAware: true }));
  }

  async function reviseArtifactWithMaple(instruction) {
    const text = String(instruction || "").trim();
    const target = artifacts.find((item) => item.id === activeArtifactId) || artifacts.at(-1);
    if (!text || !target || artifactReviseBusy) return;
    if (!isDesktop) { setPreviewNotice("Artifact revision by Maple is available in the desktop runtime."); return; }
    setArtifactReviseBusy(true);
    setArtifactReviseDraft("");
    // The envelope stays in `text` so intent parsing sees the full revision
    // instruction, but the user-visible title comes from the user's own words —
    // otherwise the wrapper sentence becomes the artifact title and manifests
    // accumulate nested "Revise the task artifact …" names.
    const cleanTitle = text.replace(/\s+/g, " ").slice(0, 60).trimEnd() || `Revision of ${displayText(target.title, "task artifact")}`;
    try {
      const agent = desktopAgent();
      await agent.submitIntent({
        text: `Revise the task artifact "${target.title}" (artifactId: ${target.id}). Instruction: ${text}. Apply the change with artifact.author as a new revision of that artifactId; keep the entrypoint and runtime template unchanged.`,
        title: cleanTitle,
        mode: "build",
        interactionMode: "build",
        threadId: task.threadId || threadRegistry.activeThreadId || undefined,
        projectId: task.projectId || undefined,
        workspaceRoot: task.workspaceRoot || undefined,
        autonomy: "bounded-local",
        requestId: crypto.randomUUID(),
        source: "artifact-studio",
        apiBase,
        adapterPath: activeAdapterPath,
        provider: modelSelection.provider,
        model: modelSelection.model,
        reasoning: modelSelection.reasoning,
        messages: [{ role: "user", content: `Revise artifact ${target.id}: ${text}` }],
      });
      // The revision event stream will surface the new revision; open the
      // studio so the user sees it land.
      peekArtifact();
    } catch (reviseError) {
      setPreviewNotice(cleanErrorText(reviseError.message));
    } finally {
      setArtifactReviseBusy(false);
    }
  }

  async function runArtifact(action, input = {}) {
    const agent = desktopAgent();
    const previewAction = action.startsWith("preview.");
    if (!isDesktop || !(previewAction ? agent?.preview : agent?.artifacts)) {
      setPreviewNotice("Browser mode is a non-runtime visual preview; artifact authority is available in Electron.");
      return null;
    }
    try {
      const normalizedAction = action.replace(/^artifact\./, "").replace(/^preview\./, "");
      const result = await (previewAction ? agent.preview(normalizedAction, { ...input, taskId: input.taskId || task.id }) : agent.artifacts(normalizedAction, { ...input, taskId: input.taskId || task.id }));
      const artifact = result?.artifact || (result?.source ? result : null);
      if (artifact?.id) {
        setArtifacts((current) => [...current.filter((item) => item.id !== artifact.id), artifact]);
        setActiveArtifactId(artifact.id);
        if (artifact.revision > 0 && !artifactFreeze) peekArtifact();
      }
      if (result?.session) { setPreviewSession(result.session); peekArtifact(); }
      if (result?.interaction?.result === "blocked" || result?.reason) setPreviewNotice(result.reason || "Preview interaction blocked.");
      return result;
    } catch (artifactError) {
      setPreviewNotice(artifactError.message);
      return null;
    }
  }

  // Artifact → repository pipeline. Dry-run first (plan in previewNotice),
  // then a second explicit confirmation performs the real write; every step
  // leaves a receipt (apply-receipt.json + agent event with branch/SHA).
  async function planExportedChangeSet() {
    const agent = desktopAgent();
    if (!isDesktop || !agent?.runCommand || !exportedChangeSet?.id) {
      setPreviewNotice("Applying to a repository needs the Electron runtime and a freshly exported change set.");
      return null;
    }
    try {
      const plan = await agent.runCommand("changeset.apply", { changeSetId: exportedChangeSet.id, dryRun: true });
      const files = plan?.plan || [];
      if (!files.length) { setPreviewNotice("The change set carries no files, so there is nothing to apply."); return null; }
      setPreviewNotice(`Apply plan · ${plan.targetRepo} · branch ${plan.branch}: ${files.map((item) => `${item.path} (+${item.added}/-${item.removed}${item.existed ? "" : ", new file"})`).join(" · ")}`);
      return plan;
    } catch (planError) {
      setPreviewNotice(cleanErrorText(planError.message));
      return null;
    }
  }

  async function applyExportedChangeSet() {
    const agent = desktopAgent();
    if (!isDesktop || !agent?.runCommand) {
      setPreviewNotice("Browser mode is a non-runtime visual preview; repository applies run in Electron only.");
      return;
    }
    const fileCount = Object.keys(exportedChangeSet?.artifactSource || {}).length;
    const confirmedPlan = await confirmDialog({
      title: "Apply this change set to the repository?",
      body: `${fileCount} file${fileCount === 1 ? "" : "s"} will be planned against the active thread workspace on branch hemlock/${exportedChangeSet?.artifactId || "artifact"}. The first pass is a dry run — nothing is written until you confirm the plan.`,
      confirmLabel: "Show apply plan",
      tone: "danger",
    });
    if (!confirmedPlan) return;
    const plan = await planExportedChangeSet();
    if (!plan) return;
    const confirmedApply = await confirmDialog({
      title: `Write ${plan.totalFiles} file${plan.totalFiles === 1 ? "" : "s"} to the repository?`,
      body: `Hemlock will create branch ${plan.branch} in ${plan.targetRepo} and commit "${plan.commitMessage}". The receipt records the commit SHA.`,
      confirmLabel: "Apply for real",
      tone: "danger",
    });
    if (!confirmedApply) {
      setPreviewNotice(`Apply cancelled before any write. Change set ${exportedChangeSet.id} stays waiting_for_approval.`);
      return;
    }
    setChangesetApplyBusy(true);
    try {
      const receipt = await agent.runCommand("changeset.apply", { changeSetId: exportedChangeSet.id });
      setPreviewNotice(receipt?.status === "applied"
        ? `Applied ${receipt.applied.length} file${receipt.applied.length === 1 ? "" : "s"}${receipt.branch ? ` · branch ${receipt.branch}` : ""}${receipt.commitSha ? ` · commit ${String(receipt.commitSha).slice(0, 12)}` : " · no git repo (files written untracked)"} · receipt: ${receipt.receiptPath}`
        : `Apply did not complete: ${displayText(receipt?.status, "unknown status")}.`);
    } catch (applyError) {
      setPreviewNotice(cleanErrorText(applyError.message));
    } finally {
      setChangesetApplyBusy(false);
    }
  }

  function latestCodingExamples() {
    const examples = [];
    if (agentProjection?.episodes?.length) examples.push(...agentProjection.episodes);
    for (let index = 0; index < messages.length - 1; index += 1) {
      const user = messages[index];
      const assistant = messages[index + 1];
      if (user.role !== "user" || assistant.role !== "assistant" || !assistant.content?.trim()) continue;
      examples.push({ messages: [{ role: "user", content: user.content }, { role: "assistant", content: assistant.content }], metadata: { userMessageId: user.id, assistantMessageId: assistant.id } });
    }
    const seen = new Set();
    return examples.filter((example) => {
      const key = example.id || JSON.stringify(example.messages);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(-6);
  }

  async function runSipsCycle() {
    if (!isDesktop) { setSipsError("The SIPS cycle needs the Hemlock desktop app."); return; }
    const examples = latestCodingExamples();
    if (!examples.length) { setSipsError("Complete one local coding exchange first so SIPS has a bounded dataset seed."); return; }
    openWindow("sips");
    openWindow("activity");
    setSipsCycleState("running");
    setSipsProgress(0);
    setSipsStage("SIPS is preparing a bounded cycle");
    setSipsLog("");
    setSipsError("");
    setSipsReceipt(null);
    await updateTask({ objective: sipsObjective, intent: "improve", phase: "training", status: "running", foregroundStep: "Running one bounded SIPS cycle" });
    try {
      const result = await runCommand("cycle", { objective: sipsObjective, verifyProfile: sipsVerifyProfile, trainingProfile: sipsTrainingProfile, examples, numLayers: 1 });
      if (result) {
        setSipsReceipt(result);
        if (result.training?.adapterPath) { setActiveAdapterPath(result.training.adapterPath); setAdapterVerified(result.training.inferenceReady === true); }
        await refreshSips();
      }
      await updateTask({ phase: "review", status: result?.status === "candidate-ready" ? "completed" : "blocked", foregroundStep: result?.status === "candidate-ready" ? "Candidate ready for review" : "Cycle blocked; inspect the receipt" });
    } catch (cycleError) {
      setSipsError(cycleError.message);
      await updateTask({ phase: "blocked", status: "blocked", blockedReason: cycleError.message, foregroundStep: "SIPS cycle failed; inspect Activity" });
    } finally {
      setSipsCycleState("idle");
    }
  }

  async function runSelfloop(action) {
    const result = await runCommand("selfloop", { selfloopAction: action, focus: sipsObjective });
    if (result?.state) setSipsStatus((current) => ({ ...current, selfloop: result.state }));
  }

  async function recordMemory(payload) {
    if (isDesktop && window.mapleDesktop?.recordMemory) {
      try { return await window.mapleDesktop.recordMemory(payload); } catch (memoryError) { setError(memoryError.message); return null; }
    }
    addEventPreview(payload.status === "candidate" ? "memory.candidate.created" : "memory.promoted", "recorded", { title: payload.title, body: payload.body });
    return null;
  }

  async function transitionMemory(item, action) {
    if (!isDesktop) {
      setError("Memory transitions need the Hemlock desktop app so the rollback receipt stays local.");
      return;
    }
    if (!item?.id) return;
    const result = await runCommand(`memory.${action}`, { targetId: item.id, note: `User requested ${action} for ${item.title || item.id}.` });
    if (result) await refreshSips();
  }

  // T6-M1b: one recall-usefulness vote from the grounding chip popover. The
  // host appends to the feedback ledger and, when memory_fitness's
  // auto-demote criteria are met, runs the existing demote transition; we
  // then drop the record from the chip's list so the popover reflects that.
  async function sendGroundingFeedback(record, kind) {
    if (!record?.id || groundingBusyId) return;
    setGroundingBusyId(record.id);
    try {
      const result = await runCommand("memory.feedback", { recordId: record.id, kind, query: sipsRecallQuery });
      if (result?.autoDemoted === true) {
        setSipsRecall((current) => (current ? { ...current, records: current.records.filter((item) => item?.id !== record.id) } : current));
        setGroundingPopoverOpen(false);
      }
    } catch {
      // Failure surfaces through the command trace; the chip stays as-is.
    } finally {
      setGroundingBusyId("");
    }
  }

  async function transitionCandidate(candidate, action) {
    if (!isDesktop || !candidate?.id) {
      setError("Candidate transitions need the Hemlock desktop control plane.");
      return;
    }
    if (candidateBusyId) return;
    const agent = desktopAgent();
    setCandidateBusyId(candidate.id);
    try {
      const result = action === "accept"
        ? await agent.acceptCandidate?.(candidate.id)
        : await agent.dismissCandidate?.(candidate.id);
      if (result?.candidate) {
        setCandidates((current) => current.map((item) => item.id === result.candidate.id ? result.candidate : item));
        if (result.candidate.status === "accepted" && result.candidate.title) setTask((current) => ({ ...current, objective: result.candidate.title, status: "accepted", phase: "plan", foregroundStep: "Plan the accepted candidate" }));
      }
    } catch (candidateError) {
      setError(candidateError.message);
    } finally {
      setCandidateBusyId("");
    }
  }

  async function setSourceEnabled(source, enabled) {
    if (!isDesktop) {
      setError("Source policies are available in the Hemlock desktop control plane.");
      return;
    }
    await runCommand("sources.policy", { sourceId: source.sourceId, policy: { enabled, permissionState: enabled ? "user-enabled" : "user-disabled" } });
  }

  async function startDream() {
    if ((!facts.length && !messages.length) || isDreaming) return;
    openWindow("dream");
    openWindow("activity");
    setIsDreaming(true);
    setDreamProgress(0);
    setDreamStage(isDesktop ? "Preparing local Dream" : "Previewing local memory");
    setDreamLog("");
    setDreamElapsed(0);
    setDreamReceipt(null);
    setError("");
    setRecoveryNotice("");
    try {
      await updateTask({ objective: "Run local Dream", intent: "improve", phase: "training", status: "running", foregroundStep: "Preparing a local adapter" });
    } catch (dreamSetupError) {
      // Composer untrap guard: a failed pre-flight task update must never
      // strand isDreaming=true (which disables both composer inputs).
      setError(`${dreamSetupError.message}. Dream did not start; the composer stays available.`);
      setIsDreaming(false);
      return;
    }
    if (isDesktop) {
      const stop = window.mapleDesktop.onDreamProgress((update) => {
        if (typeof update.progress === "number") setDreamProgress(Math.max(0, Math.min(update.progress, 100)));
        if (update.stage) setDreamStage(update.stage);
        if (update.log) setDreamLog(update.log);
        if (typeof update.elapsed === "number") setDreamElapsed(update.elapsed);
        if (typeof update.serverProcessReady === "boolean") setServerProcessReady(update.serverProcessReady);
        if (typeof update.inferenceReady === "boolean") setInferenceReady(update.inferenceReady);
      });
      try {
        const agent = desktopAgent();
        const codingExamples = latestCodingExamples();
        const dataset = await agent?.runCommand?.("training.prepare", { facts: facts.map(({ text }) => text), conversation: messages.map(({ role, content }) => ({ role, content })), examples: codingExamples });
        if (dataset) setTrainingDataset(dataset);
        const result = await window.mapleDesktop.startDream({ facts: facts.map(({ text }) => text), conversation: messages.map(({ role, content }) => ({ role, content })), examples: codingExamples, profile: dreamTrainingProfile, numLayers: 1 });
        stop?.();
        setDreamReceipt(result.trainingReceipt || null);
        setActiveAdapterPath(result.adapterPath);
        setAdapterVerified(result.inferenceReady === true);
        setServerProcessReady(result.processReady === true);
        setInferenceReady(result.inferenceReady === true);
        setFacts((current) => current.map((fact) => ({ ...fact, baked: true })));
        await updateTask({ phase: "review", status: "completed", foregroundStep: "Dream adapter inference verified" });
      } catch (dreamError) {
        stop?.();
        setError(`${dreamError.message}. The base Maple-Preview server was preserved.`);
        setInferenceReady(false);
        await updateTask({ phase: "blocked", status: "blocked", blockedReason: dreamError.message, foregroundStep: "Dream failed; inspect the Dream Lab receipt" });
      } finally {
        setIsDreaming(false);
      }
      return;
    }
    let progress = 0;
    const timer = window.setInterval(() => {
      progress += 20;
      setDreamProgress(progress);
      setDreamElapsed(Math.round(progress / 20));
      if (progress >= 40) setDreamStage("Replaying the local conversation");
      if (progress >= 80) setDreamStage("Saving a browser memory preview");
      if (progress >= 100) {
        window.clearInterval(timer);
        setFacts((current) => current.map((fact) => ({ ...fact, baked: true })));
        addEventPreview("dream.completed", "preview", { stage: "Browser memory preview complete" });
        setIsDreaming(false);
      }
    }, 300);
  }

  async function launchMapleDream() {
    if (!isDesktop) {
      setError("Maple/Dream launch is available in the Hemlock desktop app; browser preview cannot start local processes.");
      return;
    }
    if (mapleLaunchState === "launching") return;
    openWindow("dream");
    openWindow("activity");
    setMapleLaunchState("launching");
    setMapleLaunchError("");
    setError("");
    try {
      const agent = desktopAgent();
      const launch = agent?.maple?.launch || agent?.launchMaple || ((input = {}) => agent?.runCommand?.("maple.launch", input));
      if (!launch) throw new Error("The Electron Maple launch bridge is unavailable.");
      const result = await launch({});
      if (!result?.processReady) throw new Error(result?.error || "The Maple process did not become ready.");
      setServerProcessReady(true);
      setInferenceReady(result.inferenceReady === true);
      setMapleLaunchState("ready");
      setDreamStage("Maple runtime ready — Dream training remains explicit");
      setDreamLog("health verified; no inference probe was run");
    } catch (launchError) {
      setMapleLaunchState("failed");
      setMapleLaunchError(launchError.message);
      setServerProcessReady(false);
      setInferenceReady(false);
      setError(`${launchError.message}. No inference or training was started.`);
    }
  }

  async function checkReadiness() {
    if (readinessCheck === "checking") return;
    setReadinessCheck("checking");
    setError("");
    try {
      let status;
      try { status = await probeReadiness(apiBase, activeAdapterPath); } catch (adapterError) {
        setServerProcessReady(adapterError.processReady === true);
        setInferenceReady(false);
        if (!activeAdapterPath || adapterError.status === undefined || adapterError.status < 400) throw adapterError;
        const staleAdapter = activeAdapterPath;
        status = await probeReadiness(apiBase, "");
        setActiveAdapterPath("");
        setAdapterVerified(false);
        setRecoveryNotice(`Recovered with base inference. The stale adapter reference was cleared, but ${staleAdapter} was not deleted.`);
      }
      setServerProcessReady(status.processReady);
      setInferenceReady(status.inferenceReady);
      setAdapterVerified(Boolean(status.adapterPath));
      setReadinessCheck("ready");
      await emitAgentEvent("inference.completed", "verified", status);
    } catch (readinessError) {
      setServerProcessReady(readinessError.processReady === true);
      setInferenceReady(false);
      setReadinessCheck("failed");
      setError(`${readinessError.message}. Process readiness and actual inference readiness are separate.`);
      await emitAgentEvent("inference.failed", "failed", { error: readinessError.message });
    }
  }

  function jumpToLatest() {
    const node = endRef.current;
    const container = node?.closest(".chat-scroll");
    if (!container) return;
    container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
    chatPinnedRef.current = true;
    setChatPinned(true);
  }

  async function stopGeneration() {
    if (cancelBusy) return;
    const hasModelTextStream = streamFrames.some((frame) => frame.kind === "model_text" && !frame.terminal && !TERMINAL_STREAM_STATUSES.has(frame.status));
    if (!isThinking && !hasModelTextStream) return;
    const agent = desktopAgent();
    if (!agent?.cancelStream && !agent?.cancel) return;
    setCancelBusy(true);
    try {
      if (agent.cancelStream && (isThinking || hasModelTextStream)) {
        // Stream-scoped stop: aborts in-flight model output without cancelling
        // the task; the aborted stream flows into the normal partial-persist path.
        await agent.cancelStream({});
      } else {
        await agent.cancel(task.id);
      }
    } catch { /* the host keeps partial output regardless; nothing to recover here */ }
    setCancelBusy(false);
    setIsThinking(false);
    setThinkingStartedAt(null);
    // A stop is a host action, not model output — record it as a host note so the
// verbatim-trust boundary stays intact (never styled as what the model said).
setMessages((current) => [...current, { id: `stopped-${Date.now()}`, role: "system", content: "Generation stopped by host action.", provider: "host", createdAt: new Date().toISOString(), time: formatTime(), stopped: true }]);
  }

  function retryLastMessage(targetMessage = null) {
    if (isThinking || isDreaming) return;
    const lastUser = targetMessage && targetMessage.role === "user" && (targetMessage.content || "").trim()
      ? targetMessage
      : [...messages].reverse().find((item) => item.role === "user" && (item.content || "").trim());
    if (!lastUser) return;
    setDraft(lastUser.content.trim());
    // Reuse the normal send path on the next tick so all guards and state
    // handling stay in one place.
    setTimeout(() => {
      const form = document.querySelector(".chat-compose");
      form?.requestSubmit?.();
    }, 0);
  }

  async function sendMessage(event) {
    event?.preventDefault();
    const rawContent = draft.trim();
    if (!rawContent || isDreaming || (!isDesktop && isThinking)) return;
    if (!isDesktop && modelSelection.provider !== "maple") {
      setError("Codex and Claude subscription lanes are available in the Hemlock desktop app; browser preview remains Maple-only.");
      return;
    }
    const parsedInteraction = parseInteractionMode(rawContent);
    const interaction = {
      ...parsedInteraction,
      interactionMode: interactionMode === "build" || parsedInteraction.interactionMode === "build" ? "build" : "explore",
    };
    const content = interaction.text;
    if (!content) return;
    setDraft("");
    setError("");
    const userMessage = { id: crypto.randomUUID(), role: "user", content, createdAt: new Date().toISOString(), time: formatTime() };
    const nextMessages = [...messages, userMessage];
    setMessages(nextMessages);
    setIsThinking(true);
    setThinkingStartedAt(Date.now());
    setThinkingElapsed(null);
    openWindow("chat");

    const agent = desktopAgent();
    if (isDesktop && agent?.submitIntent && agent?.runCommand) {
      try {
        const requestId = crypto.randomUUID();
        const intentResult = await agent.submitIntent({
          text: content,
          mode: interaction.mode,
          interactionMode: interaction.interactionMode,
          threadId: task.threadId || threadRegistry.activeThreadId || undefined,
          projectId: task.projectId || undefined,
          workspaceRoot: task.workspaceRoot || undefined,
          autonomy: autonomyMode,
          requestId,
          source: "command-center",
          apiBase,
          adapterPath: activeAdapterPath,
          provider: modelSelection.provider,
          model: modelSelection.model,
          reasoning: modelSelection.reasoning,
          messages: [memoryMessage, ...chatMessages, { role: "user", content }].filter(Boolean),
        });
        if (intentResult?.task) acceptTaskSnapshot(intentResult.task);
        if (intentResult?.queue) setQueueState(intentResult.queue);
        if (intentResult?.context) setContextSnapshot(intentResult.context);
        if (intentResult?.recall) setSipsRecall(intentResult.recall);
        if (intentResult?.conversation) appendConversationResponse(intentResult.conversation);
        if (intentResult?.inference) {
          setServerProcessReady(intentResult.inference.processReady === true);
          setInferenceReady(intentResult.inference.inferenceReady === true);
          setAdapterVerified(Boolean(intentResult.inference.adapterPath));
        }
        if (intentResult?.conversation) {
          openWindow("chat");
        } else if (intentResult?.status === "steered" || intentResult?.status === "queued") {
          openWindow("chat");
        } else if (intentResult?.plan) {
          setAgentProjection((current) => ({ ...(current || {}), plans: [...(current?.plans || []).filter((item) => item.id !== intentResult.plan.id), intentResult.plan] }));
          openWindow("center");
        } else {
          throw new Error("Hemlock accepted the intent but did not produce a durable plan.");
        }
      } catch (requestError) {
        setError(`${requestError.message}. The task remains visible for inspection; no command completion is claimed.`);
      } finally {
        setIsThinking(false);
        setThinkingStartedAt(null);
      }
      return;
    }

    try {
      await updateTask({ objective: content.slice(0, 1000), intent: interaction.interactionMode === "build" ? "coding" : detectIntent(content, interaction.interactionMode), interactionMode: interaction.interactionMode, phase: "work", status: "running", foregroundStep: `Thinking with ${MODEL_LANES[modelSelection.provider].label}`, provider: modelSelection.provider, model: modelSelection.model || null, reasoning: modelSelection.reasoning, blockedReason: null });
      await emitAgentEvent("prompt.submitted", "received", { content: content.slice(0, 500), intent: detectIntent(content) });
      if (isDesktop) await runCommand("context.refresh", { reason: "prompt" });
      await emitAgentEvent("inference.started", "running", { provider: modelSelection.provider, model: modelSelection.model || null, reasoning: modelSelection.reasoning, adapterPath: activeAdapterPath || null });
    } catch (sendSetupError) {
      // Composer untrap guard: a failed pre-flight step must never strand
      // isThinking=true (Send stays disabled while thinking outside desktop).
      setError(`${sendSetupError.message}. The task was not started; the composer stays available.`);
      setIsThinking(false);
      setThinkingStartedAt(null);
      await emitAgentEvent("prompt.failed", "blocked", { error: sendSetupError.message }).catch(() => {});
      return;
    }
    const baseBody = { messages: [memoryMessage, ...chatMessages, { role: "user", content }].filter(Boolean), temperature: 0.7, top_p: 0.95, top_k: 20, max_tokens: DEFAULT_MAPLE_MAX_TOKENS, stream: false, chat_template_kwargs: { enable_thinking: true } };
    const requestedAdapter = activeAdapterPath;
    try {
      let payload;
      let recovered = false;
      try { payload = await requestCompletion(apiBase, { ...baseBody, ...(requestedAdapter ? { adapters: requestedAdapter } : {}) }); }
      catch (adapterError) {
        setServerProcessReady(adapterError.processReady === true);
        setInferenceReady(false);
        if (!requestedAdapter || adapterError.status === undefined || adapterError.status < 400) throw adapterError;
        payload = await requestCompletion(apiBase, baseBody);
        recovered = true;
        setActiveAdapterPath("");
        setAdapterVerified(false);
        setRecoveryNotice(`Recovered this chat with base inference; the stale adapter reference was cleared, but the existing adapter at ${requestedAdapter} was not deleted.`);
      }
      const choice = payload?.choices?.[0];
      if (!choice?.message) throw new Error("Maple-Preview returned no completed inference message.");
      const channels = Object.entries(choice.message)
        .filter(([, value]) => typeof value === "string" && value.length > 0)
        .map(([name, text]) => ({ name, text, visible: true, source: "maple" }));
      const answer = String(choice.message.content || "").trim();
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: "assistant", content: answer, channels, displayMode: "model-verbatim", hostStatus: "completed", telemetry: { bufferedFallback: true, streaming: false, maxTokens: baseBody.max_tokens, usage: payload.usage || null }, createdAt: new Date().toISOString(), time: formatTime() }]);
      setServerProcessReady(true);
      setInferenceReady(true);
      setAdapterVerified(Boolean(requestedAdapter && !recovered));
      await emitAgentEvent("inference.completed", "passed", { adapterPath: recovered ? null : requestedAdapter || null, usage: payload.usage || null, channels, displayMode: "model-verbatim", bufferedFallback: true });
      await updateTask({ phase: "complete", status: "completed", foregroundStep: "Ready for the next local task" });
      if (isProjectCorrection(content)) {
        await recordMemory({ title: "Hemlock coding correction", body: `Symptom: The user corrected a project coding behavior.\nFix: ${content}\nProof: A subsequent local Maple-Preview inference completed after the correction.`, tags: "hemlock,correction,learning", status: "candidate", confidence: "medium", verifyBeforeUse: true });
      }
    } catch (requestError) {
      setInferenceReady(false);
      setError(`${requestError.message}. No inference success is claimed.`);
      await emitAgentEvent("inference.failed", "failed", { error: requestError.message });
      await updateTask({ phase: "blocked", status: "blocked", blockedReason: requestError.message, foregroundStep: "Inference blocked; inspect Activity" });
    } finally {
      setIsThinking(false);
    }
  }

  function addFact() {
    const value = factDraft.trim();
    if (!value) return;
    // A double-click before the draft state clears must not record the same
    // fact twice.
    setFacts((current) => current.at(-1)?.text === value ? current : [...current, { id: crypto.randomUUID(), text: value, createdAt: new Date().toISOString(), baked: false }]);
    setFactDraft("");
    openWindow("memory");
  }

  function removeFact(id) { setFacts((current) => current.filter((fact) => fact.id !== id)); }

  function confirmDialog(options = {}) {
    return new Promise((resolve) => {
      setConfirmState({ title: "Confirm", confirmLabel: "Confirm", tone: "default", ...options, resolve });
    });
  }

  function settleConfirmDialog(result) {
    const current = confirmStateRef.current;
    setConfirmState(null);
    current?.resolve?.(result);
  }

  // Command palette as a true launcher: Surfaces (every Hemlock window),
  // Actions, Threads, and Settings — fuzzy-matched and arrow-key navigable.
  const exportTargetId = artifacts.find((item) => item.id === activeArtifactId)?.id || artifacts.at(-1)?.id || null;
  const activeThreadId = task.threadId || threadRegistry.activeThreadId;
  const surfaceBadge = (id) => id === "artifact" && artifacts.length ? ` · ${artifacts.length} artifact${artifacts.length > 1 ? "s" : ""}` : id === "chat" && messages.some((message) => message.role !== "system") ? ` · ${messages.filter((message) => message.role !== "system").length} messages` : id === "activity" && events.length ? ` · ${events.length} events` : "";
  const paletteSections = [
    { id: "surfaces", label: "SURFACES", items: Object.entries(WINDOW_META).filter(([id]) => id !== "settings").map(([id, meta]) => {
      const state = workspaceWindows[id];
      const open = Boolean(state && state.state !== "closed");
      const minimized = state?.state === "minimized";
      const status = !open ? "closed" : minimized ? "minimized" : activeWindowId === id ? "focused" : "open";
      return { id: `surface-${id}`, section: "surfaces", label: meta.label, hint: `${status}${surfaceBadge(id)}`, icon: meta.icon, action: () => (!open || minimized || activeWindowId !== id ? openWindow(id) : focusWindow(id)) };
    }) },
    { id: "actions", label: "ACTIONS", items: [
      ...(ACTIVE_TASK_STATUSES.has(task.status) ? [
        task.status === "paused"
          ? { id: "action-task-resume", section: "actions", label: "Resume task", hint: "Continue the approved plan from its parked boundary", icon: "play", action: () => void runCommand("task.resume", { taskId: task.id }) }
          : { id: "action-task-pause", section: "actions", label: "Pause task", hint: "Park at the next step boundary — the queue slot stays held", icon: "pause", action: () => void runCommand("task.pause", { taskId: task.id }) },
        { id: "action-task-steer", section: "actions", label: "Steer task", hint: "Redirect at the next bounded decision — pre-fills the composer", icon: "pencil", action: () => { setDraft((value) => `steer: ${value.replace(/^steer\s*[:\-]\s*/i, "").trim()}`.trimEnd()); openWindow("chat"); } },
      ] : []),
      { id: "action-new-thread", section: "actions", label: "New thread", hint: "Start a fresh local conversation", icon: "plus", action: () => void createThread() },
      { id: "action-fork-thread", section: "actions", label: "Fork active thread", hint: activeThreadId ? "Mint a sibling thread with provenance back to this one" : "No active thread to fork yet", icon: "copy", action: () => { openWindow("threads"); if (activeThreadId) void forkThread(activeThreadId); } },
      { id: "action-search-threads", section: "actions", label: "Search threads", hint: "Host-side search over titles and conversation bodies", icon: "search", action: () => openWindow("threads") },
      { id: "action-fresh-context", section: "actions", label: "Fresh context (clear this thread's history)", hint: "Archive the conversation so the model starts from zero — escapes refusal loops and poisoned context", icon: "refresh", action: () => void resetConversationContext() },
      { id: "action-new-artifact", section: "actions", label: "New artifact", hint: "Create a task-scoped draft artifact", icon: "artifact", action: () => void runArtifact("create", { artifactId: `artifact-${Date.now()}`, title: `Task artifact · ${new Date().toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`, kind: "html", entrypoint: "index.html", mime: "text/html" }) },
      { id: "action-freeze", section: "actions", label: artifactFreeze ? "Unfreeze artifact feed" : "Freeze artifact feed", hint: "Pause or resume live artifact following", icon: "work", action: () => setArtifactFreeze((value) => !value) },
      { id: "action-pin", section: "actions", label: artifactPinned ? "Unpin artifact" : "Pin artifact", hint: "Keep the studio pinned across switches", icon: "artifact", action: () => setArtifactPinned((value) => !value) },
      { id: "action-export-change-set", section: "actions", label: "Export change set", hint: exportTargetId ? "Export the current artifact revision for review" : "No task artifact revision is ready to export yet", icon: "receipt", action: () => { if (exportTargetId) void runArtifact("export", { artifactId: exportTargetId }); else setPreviewNotice("No task artifact revision is ready to export yet."); } },
      { id: "action-context-refresh", section: "actions", label: "Refresh awareness context", hint: "Check local history providers and focus evidence", icon: "activity", action: () => void runCommand("context.refresh", { reason: "command-palette" }) },
      { id: "action-verify", section: "actions", label: "Run UI verification", hint: "Run the selected allowlisted check", icon: "verify", action: () => void runCommand("verify", { profile: sipsVerifyProfile }) },
      { id: "action-prepare-change", section: "actions", label: "Prepare current change set", hint: "Capture a reviewable patch without applying it", icon: "work", action: () => void runCommand("change.prepare") },
      { id: "action-map", section: "actions", label: "Map the project", hint: "Read the current repository state", icon: "map", action: () => void runCommand("repo-map") },
      { id: "action-receipts", section: "actions", label: "Query receipts", hint: "Inspect evidence and verification records", icon: "receipt", action: () => void runCommand("receipts.query") },
      { id: "action-compare-lane", section: "actions", label: "Compare last reply across lanes", hint: `Re-send your last prompt verbatim to one other lane · current: ${selectedLane.label}`, icon: "pulse", action: () => setComparePickerOpen(true) },
      { id: "action-maple-launch", section: "actions", label: "Launch Maple / Dream runtime", hint: serverProcessReady ? "Runtime process is already up — re-verify inference" : "Boot the local model server and Dream pipeline", icon: "play", action: () => void runCommand("maple.launch") },
      { id: "action-world-state", section: "actions", label: "Inspect grove world state", hint: "Read durable markers, experiment landmarks, and sky ambience", icon: "grove", action: () => void runCommand("world.state") },
      { id: "action-experiment-suggest", section: "actions", label: "Suggest next experiments", hint: "Rank coverage gaps across recorded experiment receipts and findings", icon: "grove", action: () => void runCommand("experiment.suggest") },
      { id: "action-memory-inventory", section: "actions", label: "Refresh memory inventory", hint: "Read annotated lesson records — staleness, provenance, dupe clusters", icon: "memory", action: () => { openWindow("memory"); void runCommand("memory.list"); } },
      { id: "action-selfloop", section: "actions", label: "Start self-loop", hint: "Start a persistent bounded focus", icon: "play", action: () => void runSelfloop("start") },
    ] },
    { id: "threads", label: "THREADS", items: [{ id: "thread-manage", section: "threads", label: "Manage threads", hint: "Open the Threads window — checkpoints, conversation, fork", icon: "chat", action: () => openWindow("threads") }, ...(threadRegistry.threads || []).filter((thread) => thread.status !== "archived").slice(-8).reverse().map((thread) => ({ id: `thread-${thread.id}`, section: "threads", label: displayText(thread.title, "Untitled thread"), hint: `${thread.id === activeThreadId ? "active thread" : "switch to"} · ${displayText(thread.provider, "maple")}`, icon: "chat", action: () => void switchThread(thread.id) }))] },
    { id: "settings", label: "SETTINGS", items: [{ id: "surface-settings", section: "settings", label: WINDOW_META.settings.label, hint: "Configure local connection and profiles", icon: WINDOW_META.settings.icon, action: () => openWindow("settings") }] },
  ];
  const paletteQueryTrimmed = paletteQuery.trim();
  // Lane B: backend content matches are ADDITIVE to the instant title matches.
  // Threads already surfaced by title matching are not duplicated, and content
  // rows bypass the fuzzy filter — the backend already decided they match the
  // query, and a truncated snippet could otherwise drop a real hit.
  const paletteTitleThreadIds = new Set((threadRegistry.threads || []).filter((thread) => thread.status !== "archived").slice(-8).map((thread) => thread.id));
  const paletteContentItems = paletteQueryTrimmed.length >= 2
    ? paletteContentMatches
      .filter((match) => match?.threadId && !paletteTitleThreadIds.has(String(match.threadId)))
      .slice(0, 6)
      .map((match) => ({
        id: `thread-content-${match.threadId}`,
        section: "threads",
        label: displayText(match.title, "Untitled thread"),
        hint: match.snippet ? `matches · ${displayText(match.snippet).slice(0, 60)}` : "matches · title",
        icon: "search",
        // Backend-verified content match: bypasses the local fuzzy filter.
        bypassFilter: true,
        action: () => void switchThread(match.threadId),
      }))
    : [];
  const paletteAllSections = paletteSections.map((section) => section.id === "threads" ? { ...section, items: [...section.items, ...paletteContentItems] } : section);
  const visiblePaletteGroups = buildPaletteGroups(paletteAllSections, { query: paletteQueryTrimmed, recentIds: paletteRecentIds });
  const visiblePaletteItems = visiblePaletteGroups.flatMap((group) => group.items);
  const visiblePaletteIndexById = new Map(visiblePaletteItems.map((item, index) => [item.id, index]));
  const safePaletteIndex = visiblePaletteItems.length ? Math.min(Math.max(paletteActiveIndex, 0), visiblePaletteItems.length - 1) : 0;
  useEffect(() => {
    if (paletteOpen) document.getElementById(`palette-item-${safePaletteIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [paletteOpen, safePaletteIndex, paletteQuery]);

  function chooseCommand(item) {
    setPaletteRecentIds(recordRecentCommand(item.id));
    item.action();
    setPaletteOpen(false);
    setPaletteQuery("");
  }

  function beginArtifactPanelResize(event, axis) {
    event.preventDefault();
    event.stopPropagation();
    const workspace = event.currentTarget.closest(".artifact-workspace");
    if (!workspace) return;
    artifactPanelResizeRef.current = {
      axis,
      rect: workspace.getBoundingClientRect(),
      startX: event.clientX,
      startY: event.clientY,
      start: { ...artifactLayoutRef.current },
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function updateArtifactPanelResize(event) {
    const active = artifactPanelResizeRef.current;
    if (!active) return;
    const clampPanel = (value, minimum, maximum) => Math.min(Math.max(value, minimum), maximum);
    const usableWidth = Math.max(320, active.rect.width - 24);
    const totalFr = active.start.source + active.start.diff + active.start.preview;
    if (active.axis === "evidence") {
      const maximum = Math.max(118, active.rect.height - 300);
      const evidence = clampPanel(active.start.evidence + active.startY - event.clientY, 118, maximum);
      setArtifactLayout((current) => ({ ...current, evidence }));
      return;
    }
    const deltaFr = ((event.clientX - active.startX) / usableWidth) * totalFr;
    if (active.axis === "source-diff") {
      const sourceDiff = active.start.source + active.start.diff;
      const source = clampPanel(active.start.source + deltaFr, 0.4, sourceDiff - 0.4);
      setArtifactLayout((current) => ({ ...current, source, diff: sourceDiff - source }));
      return;
    }
    const left = active.start.source + active.start.diff + deltaFr;
    const diff = clampPanel(left - active.start.source, 0.4, totalFr - active.start.source - 0.7);
    setArtifactLayout((current) => ({ ...current, diff, preview: totalFr - active.start.source - diff }));
  }

  function endArtifactPanelResize(event) {
    if (!artifactPanelResizeRef.current) return;
    event?.currentTarget?.releasePointerCapture?.(event.pointerId);
    artifactPanelResizeRef.current = null;
  }

  function handleArtifactPanelResizeKey(event, axis) {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const delta = event.shiftKey ? 0.2 : 0.1;
    setArtifactLayout((current) => {
      const clampPanel = (value, minimum, maximum) => Math.min(Math.max(value, minimum), maximum);
      if (axis === "evidence") {
        const direction = event.key === "ArrowUp" ? 1 : event.key === "ArrowDown" ? -1 : 0;
        return { ...current, evidence: clampPanel(current.evidence + direction * delta * 100, 118, 560) };
      }
      if (axis === "source-diff") {
        const total = current.source + current.diff;
        const direction = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
        const source = clampPanel(current.source + direction * delta, 0.4, total - 0.4);
        return { ...current, source, diff: total - source };
      }
      const total = current.source + current.diff + current.preview;
      const direction = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      const left = clampPanel(current.source + current.diff + direction * delta, current.source + 0.4, total - 0.7);
      const diff = left - current.source;
      return { ...current, diff, preview: total - current.source - diff };
    });
  }

  async function providerAuthAction(provider, action) {
    const api = desktopAgent()?.providers;
    if (!isDesktop || !api?.[action]) {
      setError("Provider login controls are available in the Hemlock desktop app.");
      return;
    }
    try {
      await api[action](provider);
      setRecoveryNotice(`${MODEL_LANES[provider]?.label || provider} ${action} terminal opened. Finish the provider's own flow, then refresh status.`);
    } catch (authError) {
      setError(authError.message);
    }
  }

  function renderModelPicker() {
    const modelOption = selectedLane.modelOptions.find((option) => option.value === modelSelection.model);
    return <div className="model-picker">
      <button type="button" className="model-picker-trigger" onClick={toggleModelPicker} aria-expanded={modelPickerOpen} aria-haspopup="dialog" aria-label={`Selected model: ${selectedLane.label}`}>
        <StatusLamp state={selectedProviderState} label={selectedLane.shortLabel} />
        <span className="model-picker-trigger-copy"><strong>{selectedLane.label}</strong><small>{modelOption?.label || modelSelection.model || selectedLane.defaultModelLabel}</small></span>
        <kbd className="model-picker-shortcut">⌘⇧M</kbd>
        <Icon name="chevron" size={13} />
      </button>
      {modelPickerOpen && <section className="model-picker-popover" role="dialog" aria-label="Choose Hemlock model">
        <div className="model-picker-heading"><span>MODEL LANE</span><small>{selectedLane.kind === "subscription" ? "uses your provider subscription" : "runs on this Mac"}</small></div>
        <div className="model-picker-options">{Object.values(MODEL_LANES).map((lane) => { const status = providerStatuses.find((item) => item.provider === lane.provider); return <button type="button" key={lane.provider} className={lane.provider === modelSelection.provider ? "is-selected" : ""} onClick={() => setModelLane(lane.provider)}><span><strong>{lane.label}</strong><small>{lane.kind === "subscription" ? status?.authenticated ? "login detected" : "login required" : "local MLX"}</small></span><Icon name={lane.provider === modelSelection.provider ? "check" : "chevron"} size={13} /></button>; })}</div>
        <label className="model-picker-field">Model<select value={modelSelection.model} onChange={(event) => updateModelSelection({ model: event.target.value })}>{selectedLane.modelOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label>
        <label className="model-picker-field">Reasoning<select value={modelSelection.reasoning} onChange={(event) => updateModelSelection({ reasoning: event.target.value })}>{selectedLane.reasoningLevels.map((level) => <option value={level} key={level}>{level === "on" ? "Thinking on" : level === "off" ? "Thinking off (faster)" : level}</option>)}</select></label>
        {selectedLane.provider !== "maple" && !selectedProviderStatus?.authenticated && <button type="button" className="model-picker-login" onClick={() => { setModelPickerOpen(false); openWindow("settings"); }}>Open Settings to log in</button>}
        <p className="model-picker-note">{selectedLane.provider === "maple" ? "Local conversation and Dream stay on this Mac." : `Hemlock invokes the ${selectedLane.label} CLI with this model and reasoning level; credentials remain in the provider's own account store.`}</p>
      </section>}
    </div>;
  }

  const ctx = { activeAdapterPath, activeArtifactId, activityTypeFilter, adapterVerified, addFact, agentProjection, agentSnapshot, answerDraft, apiBase, applyExportedChangeSet, archiveThread, artifactCompare, artifactFocusPreview, artifactFreeze, artifactLayout, artifactPinned, artifactReviseBusy, artifactReviseDraft, artifactView, artifacts, autonomyMode, beginArtifactPanelResize, budgetGrant, cancelBusy, cancelQueuedIntent, candidateBusyId, candidates, changeSet, changesetApplyBusy, chatPinned, checkReadiness, clearPromptCache, commandBusy, commitThreadRename, compareDismissedAt, confirmDialog, contextSnapshot, createThread, depsSnapshot, dismissPrimer, draft, dreamElapsed, dreamLog, dreamProgress, dreamReceipt, dreamStage, dreamTrainingProfile, endArtifactPanelResize, endRef, error, events, experimentDataset, exportedChangeSet, factDraft, facts, focusWindow, groundingBusyId, groundingPopoverOpen, handleArtifactPanelResizeKey, hostActivityOpen, inferenceReady, inspectorOpen, inspectorOpenerRef, interactionMode, isDesktop, isDreaming, isThinking, jumpToLatest, latestReceiptEvent, launchMapleDream, loadSettingsPanel, liveStream, mapleLaunchError, mapleLaunchState, memoryInventory, memoryRecords, messages, modelSelection, openWindow, planCollapsed, previewConsoleLines, previewInspection, previewNotice, previewSession, previewSrc, previewViewport, primerDismissed, providerAuthAction, providerStatuses, queueState, readinessCheck, receiptRecords, receiptsFilter, recoveryNotice, refreshAgentState, refreshDeps, refreshProviderStatuses, refreshSips, refreshThreadRegistry, removeFact, renameDraft, renamingThreadId, reopenPrimer, resetConversationContext, restoreThread, reviseArtifactWithMaple, runArtifact, runCommand, runSelfloop, runSipsCycle, selectedLane, selectedProviderStatus, sendGroundingFeedback, sendMessage, serverHealthProbe, serverProcessReady, serverState, settingsSnapshot, setActiveAdapterPath, setActivityTypeFilter, setAdapterVerified, setAnswerDraft, setApiBase, setArtifactCompare, setArtifactFocusPreview, setArtifactFreeze, setArtifactLayout, setArtifactPinned, setArtifactReviseDraft, setArtifactView, setAutonomyMode, setBudgetGrant, setCompareDismissedAt, setDraft, setDreamTrainingProfile, setError, setExportedChangeSet, setFactDraft, setGroundingPopoverOpen, setHostActivityOpen, setInferenceReady, setInspectorOpen, setInteractionMode, setPlanCollapsed, setPreviewConsoleLines, setPreviewNotice, setPreviewViewport, setReadinessCheck, setReceiptsFilter, setRenameDraft, setRenamingThreadId, setServerProcessReady, setSipsObjective, setSipsRecallQuery, setSipsTrainingProfile, setSipsVerifyProfile, setSkipCloseWarning, setSourceEnabled, setThreadPickerOpen, sipsCycleState, sipsError, sipsLog, sipsObjective, sipsProgress, sipsRecall, sipsRecallQuery, sipsReceipt, sipsRepoMap, sipsStage, sipsStatus, sipsTrainingProfile, sipsVerifyProfile, skipCloseWarning, sourcePolicies, stableOpenWindow, stableRetryLast, startDream, startThreadRename, stopGeneration, streamFrames, suggestions, switchThread, task, taskProgress, thinkingElapsed, threadPickerOpen, threadRegistry, threadCheckpoints, threadConversations, forkThread, loadThreadCheckpoints, loadThreadConversation, pauseThread, resumeThread, cancelThread, deleteThread, restoreThreadCheckpoint, trainingDataset, transitionCandidate, transitionMemory, transitionSuggestion, updateArtifactPanelResize, updateProviderCapacity, updateRuntimeSetting, worldMarkers };

  // Per-window memoized slices: each window receives only the ctx fields it
  // declares in WINDOW_CTX_KEYS, so an unrelated state change (a dream tick,
  // an event burst) no longer re-renders every mounted window. Function fields
  // arrive as stable forwarders — slice identity only breaks when a listed
  // value actually changes.
  const centerCtx = useWindowCtx(WINDOW_CTX_KEYS.center, ctx);
  const chatCtx = useWindowCtx(WINDOW_CTX_KEYS.chat, ctx);
  const threadsCtx = useWindowCtx(WINDOW_CTX_KEYS.threads, ctx);
  const artifactCtx = useWindowCtx(WINDOW_CTX_KEYS.artifact, ctx);
  const sipsCtx = useWindowCtx(WINDOW_CTX_KEYS.sips, ctx);
  const memoryCtx = useWindowCtx(WINDOW_CTX_KEYS.memory, ctx);
  const dreamCtx = useWindowCtx(WINDOW_CTX_KEYS.dream, ctx);
  const activityCtx = useWindowCtx(WINDOW_CTX_KEYS.activity, ctx);
  const receiptsCtx = useWindowCtx(WINDOW_CTX_KEYS.receipts, ctx);
  const mapCtx = useWindowCtx(WINDOW_CTX_KEYS.map, ctx);
  const groveCtx = useWindowCtx(WINDOW_CTX_KEYS.grove, ctx);
  const settingsCtx = useWindowCtx(WINDOW_CTX_KEYS.settings, ctx);

  const windowContent = {
    center: () => <CommandCenter ctx={centerCtx} />,
    chat: () => <ChatWindow ctx={chatCtx} />,
    threads: () => <ThreadsWindow ctx={threadsCtx} />,
    artifact: () => <ArtifactStudio ctx={artifactCtx} />,
    sips: () => <SipsWindow ctx={sipsCtx} />,
    memory: () => <MemoryWindow ctx={memoryCtx} />,
    dream: () => <DreamWindow ctx={dreamCtx} />,
    activity: () => <ActivityWindow ctx={activityCtx} />,
    receipts: () => <ReceiptsWindow ctx={receiptsCtx} />,
    map: () => <MapWindow ctx={mapCtx} />,
    grove: () => <GroveWindow ctx={groveCtx} />,
    settings: () => <SettingsWindow ctx={settingsCtx} />,
  };

  return <main className="hemlock-os">
    {shortcutHelpOpen && <ShortcutGuide metadata={WINDOW_META} onDismiss={() => setShortcutHelpOpen(false)} onOpenApp={(id) => { setShortcutHelpOpen(false); openWindow(id); }} />}
    {overviewOpen && <WorkspaceOverview windows={workspaceWindows} metadata={WINDOW_META} activeId={activeWindowId} onShowShortcuts={showShortcuts} onDismiss={() => setOverviewOpen(false)} onActivate={(id) => { setOverviewOpen(false); openWindow(id); }} />}
    <div className="ambient-branch branch-a" /><div className="ambient-branch branch-b" />
    <header className="system-bar"><button type="button" className="system-brand" onClick={() => openWindow("center")} aria-label="Open Command Center"><span className="brand-mark"><Icon name="tree" size={28} /></span><strong>Hemlock</strong><span>OS</span></button><div className="system-context"><span className="system-path">active task / <strong>{task.intent || "conversation"}</strong></span><span className="system-task">{task.objective}</span></div><div className="system-health">{renderModelPicker()}<div className="system-health-chip"><StatusLamp state={sipsStatus?.selfloop?.status === "active" ? "working" : "ready"} label={sipsStatus?.selfloop?.status === "active" ? "active" : "idle"} /><span>SIPS</span></div><button className="system-understory" onClick={() => setUnderstory((current) => !current)} aria-label="Toggle understory mode" aria-pressed={understory} title={understory ? "Switch to paper theme" : "Switch to understory theme"}><Icon name={understory ? "sun" : "moon"} size={17} /></button><div className="system-health-chip system-activity-chip"><StatusLamp state={commandBusy || isThinking || isDreaming || liveStream ? "working" : "ready"} label={commandBusy || isThinking || isDreaming || liveStream ? "working" : `${events.length} events`} /><span>ACTIVITY</span></div><button className="system-palette" onClick={() => setPaletteOpen(true)} aria-label="Open command palette"><Icon name="command" size={15} /><kbd>⌘K</kbd></button><button className="system-settings" onClick={() => openWindow("settings")} aria-label="Open settings"><Icon name="settings" size={16} /></button></div></header>
    <div className="desktop-strip">
      <button type="button" className="workspace-overview-trigger" onClick={() => setOverviewOpen(true)} aria-label="Open window overview" aria-haspopup="dialog" aria-expanded={overviewOpen} title="Window overview · ⌘⇧O"><Icon name="windows" size={16} /><span>Windows</span><span className="workspace-window-count">{Object.values(workspaceWindows).filter(item => item.state !== "closed").length}</span><Icon name="chevron" size={11} /></button>
      <span className="strip-active-window">{WINDOW_META[activeWindowId]?.label || "Desktop"}</span><span className="strip-line" /><div className="workspace-strip-actions"><button type="button" onClick={toggleDesktop} aria-label={desktopSnapshot ? "Restore workspace windows" : "Show desktop"} aria-pressed={Boolean(desktopSnapshot)} title="Show desktop / restore windows · ⌘⌥D"><Icon name={desktopSnapshot ? "windows" : "desktop"} size={16} /><span>{desktopSnapshot ? "Restore windows" : "Desktop"}</span></button><button type="button" onClick={showShortcuts} aria-label="Open shortcut guide" aria-haspopup="dialog" title="Keyboard shortcuts · F1"><Icon name="keyboard" size={18} /></button></div><span className="strip-event">{latestEvent ? latestEvent.type.replaceAll(".", " · ") : "session ready"}</span><span className="strip-time">{formatTime(clockNow)}</span>
    </div>
    <section ref={canvasRef} className="desktop-canvas" aria-label="Hemlock desktop workspace">
      {snapPreview && <div className="window-snap-preview" aria-hidden="true" style={{ left: snapPreview.bounds.x, top: snapPreview.bounds.y, width: snapPreview.bounds.width, height: snapPreview.bounds.height }}><span>{snapPreview.command === "maximize" ? "Fill workspace" : snapPreview.command === "half-left" ? "Tile left" : "Tile right"} · release to place · Option to cancel</span></div>}
      {Object.keys(WINDOW_META).map((id) => { const windowState = workspaceWindows[id]; if (!windowState || windowState.state === "closed") return null; const renderContent = windowContent[id]; if (typeof renderContent !== "function") { if (!missingWindowContentRef.current.has(id)) { missingWindowContentRef.current.add(id); console.warn(`[hemlock] window "${id}" has no registered renderer — skipping its content`); } return null; } const content = windowState.state === "minimized" ? null : renderContent(); return <WindowFrame key={id} windowState={windowState} meta={WINDOW_META[id]} active={activeWindowId === id} dragging={draggingWindowId === id} resizing={resizingWindowId === id} onFocus={focusWindow} onDragStart={startDrag} onResizeStart={startResize} onResize={resizeWithKeyboard} onActions={showWindowMenu} onMinimize={minimizeWindow} onMaximize={maximizeWindow} onClose={closeWindow}><WindowBoundary windowId={id} label={WINDOW_META[id].label}>{content}</WindowBoundary></WindowFrame>; })}
      {workToasts.length > 0 && <div className="work-toasts" aria-label="Work notifications">{workToasts.map((toast) => <div className={`work-toast work-toast-${toast.tone}`} key={toast.id} role="status"><button type="button" className="work-toast-open" onClick={() => { openWindow(toast.windowId); setWorkToasts((current) => current.filter((item) => item.id !== toast.id)); }} title={`Open ${WINDOW_META[toast.windowId]?.label || "the evidence window"}`}><Icon name={toast.icon} size={15} /><span><strong>{toast.title}</strong><small>{toast.body}</small></span></button><button type="button" className="work-toast-dismiss" onClick={() => setWorkToasts((current) => current.filter((item) => item.id !== toast.id))} aria-label={`Dismiss ${toast.title}`}><Icon name="close" size={12} /></button></div>)}</div>}
    </section>
    <nav ref={dockRef} className="understory-dock" aria-label="Hemlock surfaces" onKeyDown={(event) => {
      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
        const button = event.target.closest('[data-window-id]');
        if (button && workspaceWindows[button.dataset.windowId]?.state !== "closed") { event.preventDefault(); showWindowMenu(button.dataset.windowId, button, "above"); }
        return;
      }
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      const buttons = [...event.currentTarget.querySelectorAll("button")];
      const index = buttons.indexOf(document.activeElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
      event.preventDefault(); buttons[next]?.focus();
    }}>{dockApps(WINDOW_META, workspaceWindows).map(([id, meta]) => { const state = workspaceWindows[id]; const open = state?.state !== "closed"; const minimized = state?.state === "minimized"; const active = activeWindowId === id; // Unread truth: an event arrived since this window was last focused while it could not be seen.
const lastSeenEvents = seenEventCountsRef.current.get(id); const hasUnread = events.length > (lastSeenEvents ?? events.length) && (!state || state.state === "closed" || !active); // Status chips ride the icon corner and derive only from live state — an approval wait is a distinct amber chip, not the unread dot.
const badges = dockActivityBadges(id, { taskStatus: task.status, isDreaming, unseenEvents: events.slice(lastSeenEvents ?? events.length) }); return <button type="button" key={id} data-window-id={id} aria-pressed={active} className={`dock-item ${open ? "open" : ""} ${active ? "active" : ""}`} onClick={() => open && !minimized ? focusWindow(id) : openWindow(id)} onContextMenu={(event) => { if (!open) return; event.preventDefault(); showWindowMenu(id, event.currentTarget, "above"); }} aria-label={`${meta.label}, ${active ? "focused" : minimized ? "minimized" : open ? "open, inactive" : "closed"}${hasUnread ? ", unread activity" : ""}${badges.length ? `, ${badges.map((badge) => badge.label).join(", ")}` : ""}`}><span className={`dock-icon glyph-${meta.tone}`}><Icon name={meta.icon} size={17} />{badges.map((badge) => <i key={badge.id} className={`dock-badge dock-badge-${badge.tone}`} title={badge.label} aria-hidden="true"><Icon name={badge.icon} size={9} /></i>)}</span><span>{meta.label}{minimized && <small className="dock-state-label">Minimized</small>}</span>{hasUnread ? <i className="dock-unread" title="New activity since last focus" /> : null}</button>; })}<button className="dock-item dock-command" onClick={() => setOverviewOpen(true)} aria-label="Open all apps" title="All apps · ⌘⇧O"><span className="dock-icon"><Icon name="apps" size={22} /></span><span>All apps</span></button></nav>
    {dockMenu && <WindowActionsMenu key={dockMenu.windowId} label={WINDOW_META[dockMenu.windowId]?.label || "Window"} state={workspaceWindows[dockMenu.windowId]?.state} anchor={dockMenu} opener={dockMenu.opener} onAction={(action) => runWindowAction(dockMenu.windowId, action)} onDismiss={() => setDockMenu(null)} />}
    {paletteOpen && <div className="palette-backdrop" onClick={() => setPaletteOpen(false)}><section className="command-palette" role="dialog" aria-modal="true" aria-label="Command palette" onClick={(event) => event.stopPropagation()}><div className="palette-top"><Icon name="command" size={16} /><input ref={paletteRef} value={paletteQuery} onChange={(event) => setPaletteQuery(event.target.value)}
        onKeyDown={(event) => {
          if (!visiblePaletteItems.length) return;
          if (event.key === "ArrowDown") { event.preventDefault(); setPaletteActiveIndex((safePaletteIndex + 1) % visiblePaletteItems.length); }
          else if (event.key === "ArrowUp") { event.preventDefault(); setPaletteActiveIndex((safePaletteIndex - 1 + visiblePaletteItems.length) % visiblePaletteItems.length); }
          else if (event.key === "Enter") { event.preventDefault(); chooseCommand(visiblePaletteItems[safePaletteIndex]); }
          else if ((event.metaKey || event.ctrlKey) && /^[1-9]$/.test(event.key)) { event.preventDefault(); const pick = visiblePaletteItems[Number(event.key) - 1]; if (pick) chooseCommand(pick); }
        }}
        placeholder="Search the Hemlock operating environment…" aria-label="Search Hemlock commands" role="combobox" aria-expanded="true" aria-autocomplete="list" aria-controls="palette-listbox" aria-activedescendant={visiblePaletteItems[safePaletteIndex] ? `palette-item-${safePaletteIndex}` : undefined} /><kbd>ESC</kbd></div><div className="palette-list" id="palette-listbox" role="listbox" aria-label="Hemlock commands">{visiblePaletteGroups.map((group) => <React.Fragment key={group.id}><div className="palette-section-label">{group.label}</div>{group.items.map((item) => { const flatIndex = visiblePaletteIndexById.get(item.id); return <button key={item.id} id={`palette-item-${flatIndex}`} role="option" aria-selected={flatIndex === safePaletteIndex} className={flatIndex === safePaletteIndex ? "is-active" : ""} onClick={() => chooseCommand(item)}><span className="palette-icon"><Icon name={item.icon} size={16} /></span><span><strong>{item.label}</strong><small>{item.hint}</small></span><span className="palette-arrow">↵</span></button>; })}</React.Fragment>)}{!visiblePaletteItems.length && <p className="empty-copy">No local command matches that search.</p>}</div><div className="palette-foot"><span>Only allowlisted local actions appear here.</span><span>Hemlock OS</span></div></section></div>}
    {confirmState && <div className="palette-backdrop confirm-backdrop" onClick={() => settleConfirmDialog(false)}><section className="command-palette confirm-dialog" role="alertdialog" aria-modal="true" aria-label={confirmState.title} aria-describedby={confirmState.body ? "confirm-dialog-desc" : undefined} onClick={(event) => event.stopPropagation()}><div className="confirm-dialog-body"><strong>{confirmState.title}</strong>{confirmState.body && <p id="confirm-dialog-desc">{confirmState.body}</p>}</div><div className="confirm-dialog-actions">
      {confirmState.allowSkipCloseWarning && <button type="button" className="quiet-action close-warning-opt-out" onClick={neverWarnOnWindowClose} title="Close this window and skip future window-close warnings">Never show this again</button>}
      <button type="button" className="quiet-action" autoFocus={confirmState.tone === "danger"} onClick={() => settleConfirmDialog(false)}>Cancel</button><button type="button" className={confirmState.tone === "danger" ? "danger-action" : "primary-action"} autoFocus={confirmState.tone !== "danger"} onClick={() => settleConfirmDialog(true)}>{confirmState.confirmLabel}</button></div></section></div>}
    {comparePickerOpen && <div className="palette-backdrop compare-picker-backdrop" onClick={() => setComparePickerOpen(false)}><section className="compare-picker" role="dialog" aria-modal="true" aria-label="Choose a comparison lane" onClick={(event) => event.stopPropagation()}><strong>Compare last reply</strong><p>Your last prompt is re-sent verbatim to one other lane. Read-only inference — no tools run and nothing else changes.</p><div className="compare-picker-options">{Object.values(MODEL_LANES).filter((lane) => lane.provider !== modelSelection.provider).map((lane) => <button type="button" key={lane.provider} disabled={Boolean(commandBusy)} onClick={() => { setComparePickerOpen(false); void runCommand("comparison.run", { targetProvider: lane.provider }); }}><strong>{lane.label}</strong><small>{lane.kind === "subscription" ? "subscription lane" : "local MLX lane"}</small></button>)}</div></section></div>}
  </main>;
}

// Apply understory mode before first paint so a night session never flashes bright paper.
if (readUnderstoryPreference()) document.documentElement.classList.add("understory");

createRoot(document.getElementById("root")).render(<App />);
