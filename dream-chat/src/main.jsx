import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Icon } from "./components/Icons.jsx";
import { WindowFrame } from "./components/WindowFrame.jsx";
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
  resizeWindow,
  setWindowState,
  toggleMaximize,
} from "./windowManager.js";
import { createEphemeralStreamStore, hasLiveStream } from "./streamStore.js";
import "./styles.css";

const DEFAULT_API = "http://127.0.0.1:8080";
const FACTS_KEY = "hemlock-facts-v2";
const API_KEY = "hemlock-api-v2";
const ADAPTER_KEY = "hemlock-adapter-v2";
const SIPS_KEY = "hemlock-sips-v2";
const DREAM_PROFILE_KEY = "hemlock-dream-profile-v2";
const WINDOWS_KEY = "hemlock-os-windows-v2";
const ARTIFACT_LAYOUT_KEY = "hemlock-artifact-layout-v1";
const DEFAULT_ARTIFACT_LAYOUT = { source: 0.68, diff: 0.88, preview: 1.48, evidence: 168 };

const WINDOW_META = {
  center: { label: "Command Center", icon: "center", tone: "gold", status: "home" },
  chat: { label: "Chat / Code", icon: "chat", tone: "green", status: "local" },
  artifact: { label: "Artifact Studio", icon: "artifact", tone: "violet", status: "scratch" },
  sips: { label: "SIPS Control", icon: "sips", tone: "gold", status: "bounded" },
  memory: { label: "Memory Garden", icon: "memory", tone: "green", status: "local" },
  dream: { label: "Dream Lab", icon: "dream", tone: "violet", status: "MLX" },
  activity: { label: "Activity", icon: "activity", tone: "green", status: "live" },
  receipts: { label: "Receipts", icon: "receipt", tone: "gold", status: "evidence" },
  map: { label: "Project Map", icon: "map", tone: "green", status: "read-only" },
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

function formatTime(value = new Date()) {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function formatElapsed(seconds) {
  if (!seconds) return "—";
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function displayText(value, fallback = "—") {
  if (value == null || value === "") return fallback;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((item) => displayText(item, "")).filter(Boolean).join(" · ") || fallback;
  try { return JSON.stringify(value); } catch { return fallback; }
}

function responseBudget(text = "") {
  const value = String(text || "").trim();
  if (value.length <= 80 && /^(?:hey|hi|hello|thanks|thank you|how are you|good morning|good night|ok|okay)\b/i.test(value)) return 320;
  if (value.length > 180 || /\b(?:explain|why|compare|go deeper|describe|detail|detailed|elaborate|creative|revise|revision)\b/i.test(value)) return 768;
  return 512;
}

function messageChannels(message) {
  if (Array.isArray(message?.channels) && message.channels.length) return message.channels;
  if (typeof message?.content === "string" && message.content) return [{ name: "content", text: message.content, visible: true, source: "maple" }];
  return [];
}

function readArtifactLayout() {
  const stored = readJson(ARTIFACT_LAYOUT_KEY, {});
  const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;
  return {
    source: Math.max(0.4, finite(stored.source, DEFAULT_ARTIFACT_LAYOUT.source)),
    diff: Math.max(0.4, finite(stored.diff, DEFAULT_ARTIFACT_LAYOUT.diff)),
    preview: Math.max(0.7, finite(stored.preview, DEFAULT_ARTIFACT_LAYOUT.preview)),
    evidence: Math.max(118, finite(stored.evidence, DEFAULT_ARTIFACT_LAYOUT.evidence)),
  };
}

function detectIntent(text) {
  const value = text.toLowerCase();
  // Keep human conversation conversational. Creation verbs are only
  // actionable when they are paired with a concrete software/artifact term;
  // “I want to make something beautiful together” is not a coding plan.
  const codingRequest = /\b(code|implement|fix|bug|function|component|refactor|develop|artifact|animation|animated|html|css|javascript|typescript|canvas|svg|website|webpage|app|site|page|feature)\b/.test(value)
    || /\b(create|make|write|design|build)\b[\s\S]*\b(code|artifact|animation|animated|html|css|javascript|typescript|canvas|svg|website|webpage|app|site|page|feature|component|function)\b/.test(value)
    || /\b(build|design)\b[\s\S]*\b(site|app|page|html|css|javascript|component|feature|animation)\b/.test(value);
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
  if (steering) return { mode: "steer", text: steering[1].trim() };
  return { mode: "queue", text: value };
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

function StatusLamp({ state = "idle", label }) {
  const safeState = displayText(state, "idle");
  return <span className={`status-lamp ${safeState}`}><i />{displayText(label, safeState)}</span>;
}

function SectionTitle({ icon, children, right }) {
  return <div className="section-title"><span><Icon name={icon} size={14} />{displayText(children)}</span>{right && <em>{displayText(right)}</em>}</div>;
}

function Metric({ value, label, tone = "green" }) {
  return <div className={`metric metric-${tone}`}><strong>{displayText(value)}</strong><span>{displayText(label)}</span></div>;
}

function EventRow({ event }) {
  const eventLabel = displayText(event.type?.replaceAll?.(".", " · "), "local event");
  const payloadText = displayText(event.payload?.stage || event.payload?.command || event.payload?.title || event.payload?.error || event.status, "local observation");
  return <div className={`event-row event-${event.status}`}>
    <span className="event-node" />
    <div className="event-copy"><strong>{eventLabel}</strong><span>{payloadText || "local observation"}</span></div>
    <time>{formatTime(event.createdAt)}</time>
  </div>;
}

function conciseAgentNote(event) {
  const payload = event.payload || {};
  const action = payload.action || {};
  const observation = payload.observation || {};
  const command = payload.command || action.commandId;
  switch (event.type) {
    case "task.created": return "Hemlock attached this request to a durable local task.";
    case "memory.recalled": return `Recalled ${payload.count ?? 0} scoped lesson${payload.count === 1 ? "" : "s"} before work began.`;
    case "context.quality.updated": return `Context checked: ${payload.quality?.status || "local evidence"} with ${Math.round((payload.quality?.confidence || 0) * 100)}% confidence.`;
    case "plan.proposed": return `Bounded plan proposed: ${payload.plan?.steps?.length || 0} registered step${payload.plan?.steps?.length === 1 ? "" : "s"}.`;
    case "plan.approved": return "Plan approved; Maple may continue through the registered host loop.";
    case "plan.rejected": return `Plan rejected: ${String(payload.reason || "user decision").slice(0, 220)}`;
    case "task.steering.received": return `Steering accepted for the next bounded decision; an already-running inference is not rewritten: ${String(payload.steering?.content || "update received").slice(0, 180)}`;
    case "inference.started": return payload.mode === "structured-action" ? "Maple is selecting one registered action from the current evidence." : "Maple is composing a local response.";
    case "inference.failed": return `Maple inference needs attention: ${String(payload.error || "no usable output").slice(0, 220)}`;
    case "action.inference.failed": return `Maple action output was not usable; one repair prompt is being attempted.`;
    case "action.parse.failed": return `The host rejected the proposed action format; one repair prompt is being attempted.`;
    case "action.inference.fallback": return `Maple structured output was unavailable; the host used the next approved artifact step and marked the fallback.`;
    case "inference.completed": {
      const telemetry = payload.telemetry || {};
      const timing = telemetry.elapsedMs ? ` in ${Math.round(telemetry.elapsedMs / 100) / 10}s` : "";
      const tokens = telemetry.completionTokens != null ? ` · ${telemetry.completionTokens} output tokens` : "";
      return `Host recorded Maple's ${payload.mode === "structured-action" ? "structured action pass" : "local response"}${timing}${tokens}.`;
    }
    case "action.proposed": return `Maple proposed ${action.commandId || action.kind || "a bounded action"}: ${String(action.shortRationale || "no rationale supplied").slice(0, 180)}`;
    case "action.validated": return `Host validated ${action.commandId || action.kind || "the action"} against the allowlist and scope.`;
    case "command.started": return `Host started ${command || "a registered command"}.`;
    case "observation.recorded": return `Observation recorded: ${String(observation.summary || event.status).slice(0, 220)}`;
    case "action.completed": return "Registered action completed and its observation was attached to the episode.";
    case "task.blocked": return `Blocked honestly: ${String(payload.reason || "the task needs a decision").slice(0, 220)}`;
    case "task.completed": return "Task completed with the evidence recorded by the host.";
    default: return null;
  }
}

function App() {
  const isDesktop = Boolean(window.mapleDesktop?.isDesktop);
  const [apiBase, setApiBase] = useState(() => localStorage.getItem(API_KEY) || DEFAULT_API);
  const [activeAdapterPath, setActiveAdapterPath] = useState(() => localStorage.getItem(ADAPTER_KEY) || "");
  const [facts, setFacts] = useState(() => readJson(FACTS_KEY, []));
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState("");
  const [isThinking, setIsThinking] = useState(false);
  const [isDreaming, setIsDreaming] = useState(false);
  const [dreamProgress, setDreamProgress] = useState(0);
  const [dreamStage, setDreamStage] = useState("Dream Lab is ready");
  const [dreamLog, setDreamLog] = useState("");
  const [dreamElapsed, setDreamElapsed] = useState(0);
  const [dreamReceipt, setDreamReceipt] = useState(null);
  const [trainingDataset, setTrainingDataset] = useState(null);
  const [dreamTrainingProfile, setDreamTrainingProfile] = useState(() => localStorage.getItem(DREAM_PROFILE_KEY) || "quality");
  const [serverProcessReady, setServerProcessReady] = useState(null);
  const [inferenceReady, setInferenceReady] = useState(null);
  const [adapterVerified, setAdapterVerified] = useState(null);
  const [readinessCheck, setReadinessCheck] = useState("idle");
  const [recoveryNotice, setRecoveryNotice] = useState("");
  const [task, setTask] = useState(() => ({ ...readJson("hemlock-task-preview-v1", {}), objective: "Explore the Hemlock workspace", intent: "conversation", phase: "ready", status: "ready", foregroundStep: "Waiting for a local task" }));
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
  const [artifactPinned, setArtifactPinned] = useState(false);
  const [previewSession, setPreviewSession] = useState(null);
  const [previewInspection, setPreviewInspection] = useState(null);
  const [previewNotice, setPreviewNotice] = useState("");
  const [streamFrames, setStreamFrames] = useState([]);
  const [canvasSize, setCanvasSize] = useState({ width: 1240, height: 700 });
  const [candidates, setCandidates] = useState([]);
  const [sourcePolicies, setSourcePolicies] = useState([]);
  const [contextSnapshot, setContextSnapshot] = useState(null);
  const [workspaceWindows, setWorkspaceWindows] = useState(initialWindows);
  const [activeWindowId, setActiveWindowId] = useState("center");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [error, setError] = useState("");
  const [factDraft, setFactDraft] = useState("");
  const [sipsObjective, setSipsObjective] = useState(() => readJson(SIPS_KEY, {}).objective || "Improve Hemlock's next coding task with a small verified change.");
  const [sipsVerifyProfile, setSipsVerifyProfile] = useState(() => readJson(SIPS_KEY, {}).verifyProfile || "app-build");
  const [sipsTrainingProfile, setSipsTrainingProfile] = useState(() => readJson(SIPS_KEY, {}).trainingProfile || "balanced");
  const [sipsStatus, setSipsStatus] = useState(null);
  const [sipsRoutes, setSipsRoutes] = useState([]);
  const [sipsRecallQuery, setSipsRecallQuery] = useState("");
  const [sipsRecall, setSipsRecall] = useState(null);
  const [sipsCycleState, setSipsCycleState] = useState("idle");
  const [sipsProgress, setSipsProgress] = useState(0);
  const [sipsStage, setSipsStage] = useState("SIPS is idle");
  const [sipsLog, setSipsLog] = useState("");
  const [sipsReceipt, setSipsReceipt] = useState(null);
  const [sipsRepoMap, setSipsRepoMap] = useState(null);
  const [sipsVerifyReceipt, setSipsVerifyReceipt] = useState(null);
  const [sipsError, setSipsError] = useState("");
  const [receiptRecords, setReceiptRecords] = useState([]);
  const [changeSet, setChangeSet] = useState(null);
  const [commandBusy, setCommandBusy] = useState("");
  const endRef = useRef(null);
  const paletteRef = useRef(null);
  const dragRef = useRef(null);
  const resizeRef = useRef(null);
  const artifactPanelResizeRef = useRef(null);
  const artifactLayoutRef = useRef(artifactLayout);
  const conversationResponseIds = useRef(new Set());
  const liveStreamState = useRef(new Map());
  const artifactPeekedRef = useRef(false);
  const canvasRef = useRef(null);
  const streamStoreRef = useRef(null);
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
        hostStatus: conversation.hostStatus || null,
        telemetry: conversation.telemetry || null,
        time: formatTime(),
      };
      if (index >= 0) return current.map((message, messageIndex) => messageIndex === index ? nextMessage : message);
      return [...current, nextMessage];
    });
  }

  useEffect(() => { localStorage.setItem(FACTS_KEY, JSON.stringify(facts)); }, [facts]);
  useEffect(() => { localStorage.setItem(API_KEY, apiBase); }, [apiBase]);
  useEffect(() => { activeAdapterPath ? localStorage.setItem(ADAPTER_KEY, activeAdapterPath) : localStorage.removeItem(ADAPTER_KEY); }, [activeAdapterPath]);
  useEffect(() => { localStorage.setItem(DREAM_PROFILE_KEY, dreamTrainingProfile); }, [dreamTrainingProfile]);
  useEffect(() => { localStorage.setItem(SIPS_KEY, JSON.stringify({ objective: sipsObjective, verifyProfile: sipsVerifyProfile, trainingProfile: sipsTrainingProfile })); }, [sipsObjective, sipsVerifyProfile, sipsTrainingProfile]);
  useEffect(() => { localStorage.setItem(WINDOWS_KEY, JSON.stringify(workspaceWindows)); }, [workspaceWindows]);
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
  useEffect(() => {
    setWorkspaceWindows((current) => Object.fromEntries(Object.entries(current).map(([id, item]) => [id, {
      ...item,
      bounds: clampBounds(item.bounds, canvasSize, item.minimumSize),
      restoreBounds: clampBounds(item.restoreBounds, canvasSize, item.minimumSize),
    }])));
  }, [canvasSize.width, canvasSize.height]);
  useEffect(() => {
    const node = endRef.current;
    const container = node?.closest(".chat-scroll");
    if (container) container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
  }, [messages, isThinking]);

  useEffect(() => {
    const agent = desktopAgent();
    if (!isDesktop || !agent?.getState) return undefined;
    let disposed = false;
    agent.getState().then((snapshot) => {
      if (disposed) return;
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
    }).catch((stateError) => setError(`Hemlock runtime state unavailable: ${stateError.message}`));
    const stop = agent.subscribe?.((event) => {
      setEvents((current) => current.some((item) => item.id === event.id) ? current : [...current, event].slice(-160));
      if (event.type === "task.updated" && event.payload?.task) acceptTaskSnapshot(event.payload.task);
      if (event.type === "task.queue.updated" && event.payload?.queue) setQueueState(event.payload.queue);
      if (event.type === "conversation.response" && event.payload?.conversation) appendConversationResponse(event.payload.conversation);
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
      if (event.type.startsWith("action.") && event.payload?.action) setAgentProjection((current) => ({ ...(current || {}), actions: [...(current?.actions || []).filter((item) => item.id !== event.payload.action.id), event.payload.action] }));
      if (event.type === "observation.recorded" && event.payload?.observation) setAgentProjection((current) => ({ ...(current || {}), observations: [...(current?.observations || []).filter((item) => item.id !== event.payload.observation.id), event.payload.observation] }));
      if (event.type === "context.source.policy.updated" && event.payload?.source) setSourcePolicies((current) => current.map((item) => item.sourceId === event.payload.source.sourceId ? event.payload.source : item));
      if (event.type === "command.started") setCommandBusy(event.payload?.command || "working");
      if (event.type === "command.completed") setCommandBusy("");
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
        if (event.payload.artifact.revision > 0 && !artifactPeekedRef.current) { artifactPeekedRef.current = true; peekArtifact(); }
      }
      if (event.type === "artifact.preview.ready" && event.payload?.session) setPreviewSession(event.payload.session);
      if (event.type === "artifact.inspection.completed") setPreviewInspection(event.payload?.inspection || null);
    });
    const stopStream = agent.subscribeStream?.((frame) => {
      streamStoreRef.current?.apply(frame);
      const previous = liveStreamState.current.get(frame.streamId) || { sequence: -1, text: "", channels: {} };
      if (Number.isFinite(frame.sequence) && frame.sequence <= previous.sequence) return;
      const channel = frame.channel || "content";
      const channels = { ...(previous.channels || {}) };
      channels[channel] = `${channels[channel] || ""}${frame.delta || ""}`;
      liveStreamState.current.set(frame.streamId, { sequence: frame.sequence, text: channels.content || "", channels, terminal: frame.terminal, status: frame.status });
      setMessages((current) => {
        const index = current.findIndex((message) => message.streamId === frame.streamId);
        if (index < 0 && (frame.delta || frame.terminal)) return [...current, { id: crypto.randomUUID(), role: "assistant", content: channels.content || "", channels: Object.entries(channels).map(([name, text]) => ({ name, text, visible: true, source: "maple" })), streamId: frame.streamId, streaming: !frame.terminal, telemetry: null, displayMode: "model-verbatim", time: formatTime() }];
        if (index < 0) return current;
        return current.map((message, messageIndex) => messageIndex === index ? { ...message, content: channels.content || "", channels: Object.entries(channels).map(([name, text]) => ({ name, text, visible: true, source: "maple" })), streaming: !frame.terminal, streamStatus: frame.status } : message);
      });
    });
    return () => { disposed = true; stop?.(); stopStream?.(); };
  }, [isDesktop]);

  useEffect(() => {
    const onPreviewMessage = (event) => {
      if (event.data?.source !== "hemlock-preview-harness") return;
      const frame = document.querySelector(".artifact-preview-frame");
      if (frame?.contentWindow && event.source !== frame.contentWindow) return;
      if (event.data.type === "inspection" || event.data.type === "accessibility" || event.data.type === "ready" || event.data.type === "condition") {
        setPreviewInspection(event.data.payload || null);
        if (isDesktop && previewSession && desktopAgent()?.preview) void desktopAgent().preview("inspect", { sessionId: previewSession.id, inspection: event.data.payload, digest: null });
      }
      if (event.data.type === "console") setPreviewNotice(`${event.data.payload?.level || "log"}: ${event.data.payload?.message || "preview console output"}`);
      if (event.data.type === "blocked") setPreviewNotice(`Preview action blocked: ${event.data.payload?.reason || "registered target required"}`);
    };
    window.addEventListener("message", onPreviewMessage);
    return () => window.removeEventListener("message", onPreviewMessage);
  }, [isDesktop, previewSession]);

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
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen(true);
      }
      if ((event.metaKey || event.ctrlKey) && event.altKey) {
        const command = event.key === "ArrowLeft" ? "half-left" : event.key === "ArrowRight" ? "half-right" : event.key === "ArrowUp" ? "maximize" : event.key === "ArrowDown" ? "restore" : event.key.toLowerCase() === "m" ? "minimize" : null;
        if (command) {
          event.preventDefault();
          setWorkspaceWindows((current) => ({ ...current, [activeWindowId]: keyboardPlacement(current[activeWindowId], command, canvasSize) }));
        }
      }
      if (event.key === "Escape") {
        setPaletteOpen(false);
        if (isDreaming && window.mapleDesktop?.cancelAgentTask) void window.mapleDesktop.cancelAgentTask();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [activeWindowId, canvasSize, isDesktop, isDreaming]);

  useEffect(() => {
    if (!paletteOpen) return undefined;
    paletteRef.current?.focus();
    return undefined;
  }, [paletteOpen]);

  useEffect(() => {
    const move = (event) => {
      const drag = dragRef.current;
      const resize = resizeRef.current;
      if (!drag && !resize) return;
      setWorkspaceWindows((current) => {
        const state = current[drag?.id || resize.id];
        if (!state || state.state === "maximized") return current;
        if (drag) {
          const origin = { ...state, bounds: drag.originBounds };
          return { ...current, [drag.id]: moveWindow(origin, event.clientX - drag.startX, event.clientY - drag.startY, canvasSize, { altKey: event.altKey }) };
        }
        const origin = { ...state, bounds: resize.originBounds };
        return { ...current, [resize.id]: resizeWindow(origin, resize.edge, event.clientX - resize.startX, event.clientY - resize.startY, canvasSize, { altKey: event.altKey }) };
      });
    };
    const up = () => {
      const action = dragRef.current || resizeRef.current;
      if (action?.id) setWorkspaceWindows((current) => ({ ...current, [action.id]: { ...current[action.id], bounds: clampBounds(current[action.id].bounds, canvasSize, current[action.id].minimumSize) } }));
      dragRef.current = null;
      resizeRef.current = null;
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
    return () => { document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", up); };
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
  const latestReceiptEvent = [...events].reverse().find((event) => event.type.includes("completed") && event.evidenceRefs?.length) || latestEvent;
  const serverState = serverProcessReady === true ? "ready" : serverProcessReady === false ? "down" : "unknown";
  const liveStream = hasLiveStream(streamFrames);
  const taskProgress = isDreaming ? dreamProgress : sipsCycleState === "running" ? sipsProgress : liveStream || isThinking ? 42 : task.status === "completed" ? 100 : 0;

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
    setActiveWindowId(id);
    setWorkspaceWindows((current) => focusWindowState(current, id));
  }

  function openWindow(id) {
    setActiveWindowId(id);
    setWorkspaceWindows((current) => openWindowBounds(current, id, canvasSize, { collisionAware: true }));
  }

  function closeWindow(id) {
    setWorkspaceWindows((current) => ({ ...current, [id]: setWindowState(current[id], "closed", canvasSize) }));
    if (activeWindowId === id) setActiveWindowId("center");
  }

  function minimizeWindow(id) {
    setWorkspaceWindows((current) => ({ ...current, [id]: setWindowState(current[id], "minimized", canvasSize) }));
  }

  function maximizeWindow(id) {
    setActiveWindowId(id);
    setWorkspaceWindows((current) => normalizeZOrder({ ...current, [id]: toggleMaximize(current[id], canvasSize) }, id));
  }

  function startDrag(event, id) {
    if (event.target.closest("button") || window.innerWidth < 900) return;
    const state = workspaceWindows[id];
    if (!state || state.state === "maximized" || state.state === "closed") return;
    focusWindow(id);
    dragRef.current = { id, startX: event.clientX, startY: event.clientY, originBounds: state.bounds };
  }

  function startResize(event, id, edge = "bottom-right") {
    event.stopPropagation();
    const state = workspaceWindows[id];
    if (!state || state.state === "maximized" || state.state === "closed") return;
    focusWindow(id);
    resizeRef.current = { id, edge, startX: event.clientX, startY: event.clientY, originBounds: state.bounds };
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
      if (action === "change.prepare") { setChangeSet(result); openWindow("receipts"); }
      if (action === "change.approve" || action === "change.reject") setChangeSet(result);
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

  async function refreshSips() {
    const [status, routes] = await Promise.all([runCommand("status"), runCommand("routes")]);
    if (status) setSipsStatus(status);
    if (routes) setSipsRoutes(routes.routes || []);
  }

  function peekArtifact() {
    setWorkspaceWindows((current) => openWindowBounds(current, "artifact", canvasSize, { collisionAware: true }));
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

  async function transitionCandidate(candidate, action) {
    if (!isDesktop || !candidate?.id) {
      setError("Candidate transitions need the Hemlock desktop control plane.");
      return;
    }
    const agent = desktopAgent();
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
    await updateTask({ objective: "Run local Dream", intent: "improve", phase: "training", status: "running", foregroundStep: "Preparing a local adapter" });
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
        const dataset = await agent?.runCommand?.("training.prepare", { facts: facts.map(({ text }) => text), conversation: messages.map(({ role, content }) => ({ role, content })), examples: latestCodingExamples() });
        if (dataset) setTrainingDataset(dataset);
        const result = await window.mapleDesktop.startDream({ facts: facts.map(({ text }) => text), conversation: messages.map(({ role, content }) => ({ role, content })), profile: dreamTrainingProfile, numLayers: 1 });
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

  async function sendMessage(event) {
    event?.preventDefault();
    const rawContent = draft.trim();
    if (!rawContent || isDreaming || (!isDesktop && isThinking)) return;
    const interaction = parseInteractionMode(rawContent);
    const content = interaction.text;
    if (!content) return;
    setDraft("");
    setError("");
    const userMessage = { id: crypto.randomUUID(), role: "user", content, time: formatTime() };
    const nextMessages = [...messages, userMessage];
    setMessages(nextMessages);
    setIsThinking(true);
    openWindow("chat");

    const agent = desktopAgent();
    if (isDesktop && agent?.submitIntent && agent?.runCommand) {
      try {
        const requestId = crypto.randomUUID();
        const intentResult = await agent.submitIntent({
          text: content,
          mode: interaction.mode,
          requestId,
          source: "command-center",
          apiBase,
          adapterPath: activeAdapterPath,
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
      }
      return;
    }

    await updateTask({ objective: content.slice(0, 1000), intent: detectIntent(content), phase: "work", status: "running", foregroundStep: "Thinking with Maple-Preview", blockedReason: null });
    await emitAgentEvent("prompt.submitted", "received", { content: content.slice(0, 500), intent: detectIntent(content) });
    if (isDesktop) await runCommand("context.refresh", { reason: "prompt" });
    await emitAgentEvent("inference.started", "running", { adapterPath: activeAdapterPath || null });
    const baseBody = { messages: [memoryMessage, ...chatMessages, { role: "user", content }].filter(Boolean), temperature: 0.7, top_p: 0.95, top_k: 20, max_tokens: responseBudget(content), stream: false };
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
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: "assistant", content: answer, channels, displayMode: "model-verbatim", hostStatus: "completed", telemetry: { bufferedFallback: true, streaming: false, maxTokens: baseBody.max_tokens, usage: payload.usage || null }, time: formatTime() }]);
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
    setFacts((current) => [...current, { id: crypto.randomUUID(), text: value, createdAt: new Date().toISOString(), baked: false }]);
    setFactDraft("");
    openWindow("memory");
  }

  function removeFact(id) { setFacts((current) => current.filter((fact) => fact.id !== id)); }

  const commandItems = [
    { id: "center", label: "Open Command Center", hint: "Focus the Hemlock home surface", icon: "center", action: () => openWindow("center") },
    { id: "chat", label: "Open Chat / Code", hint: "Continue the local conversation", icon: "chat", action: () => openWindow("chat") },
    { id: "artifact", label: "Open Artifact Studio", hint: "Inspect task-scoped live artifacts", icon: "artifact", action: () => openWindow("artifact") },
    { id: "sips", label: "Open SIPS Control", hint: "Inspect the bounded self-improvement loop", icon: "sips", action: () => { openWindow("sips"); void refreshSips(); } },
    { id: "memory", label: "Open Memory Garden", hint: "Inspect local facts and lessons", icon: "memory", action: () => openWindow("memory") },
    { id: "dream", label: "Open Dream Lab", hint: "Inspect Dream training and adapter state", icon: "dream", action: () => openWindow("dream") },
    { id: "activity", label: "Open Activity", hint: "Follow the local event stream", icon: "activity", action: () => openWindow("activity") },
    { id: "receipts", label: "Open Receipts", hint: "Inspect evidence and verification", icon: "receipt", action: () => void runCommand("receipts.query") },
    { id: "map", label: "Map the project", hint: "Read the current repository state", icon: "map", action: () => void runCommand("repo-map") },
    { id: "context", label: "Refresh awareness context", hint: "Check local history providers and focus evidence", icon: "activity", action: () => void runCommand("context.refresh", { reason: "command-palette" }) },
    { id: "verify", label: "Run UI verification", hint: "Run the selected allowlisted check", icon: "receipt", action: () => void runCommand("verify", { profile: sipsVerifyProfile }) },
    { id: "prepare-change", label: "Prepare current change set", hint: "Capture a reviewable patch without applying it", icon: "work", action: () => void runCommand("change.prepare") },
    { id: "selfloop", label: "Start self-loop", hint: "Start a persistent bounded focus", icon: "play", action: () => void runSelfloop("start") },
    { id: "settings", label: "Open Settings", hint: "Configure local connection and profiles", icon: "settings", action: () => openWindow("settings") },
  ];
  const filteredCommands = commandItems.filter((item) => `${item.label} ${item.hint}`.toLowerCase().includes(paletteQuery.toLowerCase())).slice(0, 8);

  function chooseCommand(item) {
    item.action();
    setPaletteOpen(false);
    setPaletteQuery("");
  }

  function renderCenter() {
    const quality = contextSnapshot?.quality || {};
    const confidence = Number.isFinite(Number(quality.confidence)) ? Math.round(Number(quality.confidence) * 100) : 0;
    const contextStatus = quality.status || (isDesktop ? "awaiting refresh" : "preview only");
    const freshness = quality.freshnessSeconds == null ? "—" : formatElapsed(Math.max(0, Math.round(quality.freshnessSeconds)));
    const phases = [
      { id: "intent", label: "Intent", icon: "target" },
      { id: "recall", label: "Recall", icon: "memory" },
      { id: "work", label: "Work", icon: "work" },
      { id: "verify", label: "Verify", icon: "verify" },
      { id: "remember", label: "Remember", icon: "leaf" },
    ];
    const phaseId = task.status === "completed" ? "remember" : task.phase === "plan" ? "recall" : task.phase === "training" ? "work" : task.phase === "review" || task.phase === "complete" ? "verify" : task.phase === "approval" ? "verify" : task.phase;
    const phaseIndex = Math.max(0, phases.findIndex((phase) => phase.id === phaseId));
    const trace = events.slice(-4).reverse();
    const receipts = events.filter((event) => event.evidenceRefs?.length || event.type.includes("completed") || event.type.includes("failed")).slice(-5).reverse();
    const taskEvent = (event) => event.taskId === task.id || event.payload?.taskId === task.id || event.payload?.task?.id === task.id;
    const blockers = events.filter((event) => taskEvent(event) && (event.status === "failed" || event.type.includes("blocked"))).slice(-2).reverse();
    const plans = (agentProjection?.plans || []).filter((item) => item.taskId === task.id);
    const actions = (agentProjection?.actions || []).filter((item) => item.taskId === task.id);
    const activePlan = plans.find((item) => item.id === task.activePlanId) || plans.at(-1) || null;
    const activeAction = actions.find((item) => item.id === task.activeActionId) || actions.filter((item) => !["completed", "failed", "cancelled", "blocked", "rejected"].includes(item.status)).at(-1) || null;
    const observations = agentProjection?.observations || [];
    const latestObservation = observations.at(-1) || null;
    const planNeedsApproval = activePlan?.status === "proposed" || (task.status === "waiting_for_approval" && !activeAction);
    const actionNeedsApproval = Boolean(activeAction && ["proposed", "validated"].includes(activeAction.status) && activePlan?.status === "approved");
    const activeCandidates = candidates.filter((item) => ["candidate", "accepted", "snoozed"].includes(item.status)).slice().reverse();
    const ambientCandidate = activeCandidates[0] || null;
    const candidate = memoryRecords.find((item) => !["memory.promoted", "memory.demote", "memory.rollback"].includes(item.event?.type));
    const activeStep = task.status === "blocked" ? "Inspect the blocker receipt" : isDreaming ? dreamStage : sipsCycleState === "running" ? sipsStage : task.foregroundStep || "Choose the next bounded action";
    const nextAction = task.status === "blocked" ? "Inspect blocker" : planNeedsApproval ? "Approve bounded plan" : actionNeedsApproval ? "Accept proposed action" : task.status === "waiting_for_approval" ? "Review prepared change" : ambientCandidate ? "Review surfaced candidate" : task.phase === "verify" || task.phase === "review" ? "Run UI verification" : task.phase === "training" ? "Open Dream Lab" : "Continue task";
    const workstreams = [
      { id: "task", icon: "center", title: task.objective || "Current task", status: task.status || "ready", meta: `${task.intent || "conversation"} · ${task.phase || "ready"}` },
      { id: "sips", icon: "sips", title: "Self-improvement loop", status: sipsStatus?.selfloop?.status || "idle", meta: `${sipsStatus?.cycleCount ?? 0} cycles` },
      { id: "dream", icon: "dream", title: "Dream adapter", status: isDreaming ? "training" : dreamReceipt ? "candidate ready" : "standby", meta: activeAdapterPath ? "adapter linked" : "no active candidate" },
      { id: "context", icon: "activity", title: "Awareness context", status: contextStatus, meta: `${contextSnapshot?.observations?.length ?? 0} observations` },
    ];
    const runNextAction = () => {
      if (task.status === "blocked") { openWindow("receipts"); return; }
      if (planNeedsApproval && activePlan) { void runCommand("plan.approve", { taskId: task.id, planId: activePlan.id }); return; }
      if (actionNeedsApproval && activeAction) { void runCommand("action.accept", { taskId: task.id, actionId: activeAction.id }); return; }
      if (task.status === "waiting_for_approval") { openWindow("receipts"); return; }
      if (ambientCandidate) { openWindow("memory"); return; }
      if (task.phase === "verify" || task.phase === "review") { void runCommand("verify", { profile: sipsVerifyProfile }); return; }
      if (task.phase === "training") { openWindow("dream"); return; }
      openWindow("chat");
    };
    const phaseClass = (index) => task.status === "completed" ? "is-done" : task.status === "blocked" && index === phaseIndex ? "is-blocked" : index < phaseIndex ? "is-done" : index === phaseIndex ? "is-active" : "";

    return <div className="cockpit-shell">
      <aside className="workstream-rail" aria-label="Hemlock workstreams">
        <div className="rail-heading"><span className="cockpit-kicker">WORKSTREAMS</span><button type="button" onClick={() => { setDraft("Start a new Hemlock workstream: "); openWindow("chat"); }} aria-label="Start a new workstream"><Icon name="plus" size={15} /></button></div>
        <div className="workstream-list">{workstreams.map((stream, index) => { const streamStatus = displayText(stream.status, "ready"); const streamMeta = displayText(stream.meta); return <button type="button" key={stream.id} className={`workstream-item ${index === 0 ? "is-selected" : ""}`} title={`${displayText(stream.title)} · ${streamMeta} · ${streamStatus}`} aria-label={`${displayText(stream.title)}. ${streamMeta}. Status: ${streamStatus}.`} onClick={() => stream.id === "sips" ? openWindow("sips") : stream.id === "dream" ? openWindow("dream") : stream.id === "context" ? void runCommand("context.refresh", { reason: "workstream" }) : focusWindow("center")}><span className={`workstream-icon ${stream.id}`}><Icon name={stream.icon} size={17} /></span><span className="workstream-copy"><strong>{displayText(stream.title)}</strong><small>{streamMeta}</small></span><span className={`workstream-state state-${streamStatus.replaceAll(" ", "-")}`}>{streamStatus}</span></button>; })}</div>
        <div className="rail-footer"><span>LOCAL WORKSPACE</span><strong>{isDesktop ? "Electron control plane" : "Browser preview"}</strong><button type="button" onClick={() => openWindow("map")}><Icon name="map" size={13} /> Project map</button></div>
      </aside>

      <section className="cockpit-workbench" aria-label="Active Hemlock workbench">
        <div className="workbench-topline"><div><span className="cockpit-kicker">ACTIVE WORKSTREAM / {task.intent || "conversation"}</span><span className="workbench-id">{task.id || "local-session"}</span></div><span className={`task-state task-state-${task.status}`}>{task.status || "ready"}</span></div>
        <div className="lifecycle-layout">
          <ol className="lifecycle-rail" aria-label="Task lifecycle">{phases.map((phase, index) => <li className={phaseClass(index)} key={phase.id}><span className="lifecycle-node"><Icon name={phase.icon} size={18} /></span><span><strong>{phase.label}</strong><small>{task.status === "completed" ? "done" : index < phaseIndex ? "done" : index === phaseIndex ? task.status === "blocked" ? "blocked" : "in progress" : "pending"}</small></span></li>)}</ol>
          <div className="workbench-main">
            <section className="live-task-panel" aria-label="Live Task"><div className="live-task-heading"><div><span className="cockpit-kicker">LIVE TASK</span><h2>Maple output and host evidence</h2></div><button type="button" className="quiet-action" onClick={() => openWindow("chat")}>Open Chat</button></div><div className="live-task-panel-grid"><section className="maple-output-card"><div className="block-label"><span>MAPLE OUTPUT</span><small>model-verbatim · visible by default</small></div>{messages.filter((message) => message.role === "assistant").slice(-1).map((message) => <div key={message.id}>{messageChannels(message).map((channel, index) => <div className={`maple-channel ${channel.name === "content" ? "maple-channel-content" : "maple-channel-secondary"}`} key={`${channel.name}-${index}`}><span className="model-channel-label">Maple · {displayText(channel.name, "content")}</span>{channel.name === "content" ? <p>{displayText(channel.text, "")}</p> : <pre>{displayText(channel.text, "")}</pre>}</div>)}</div>)}{!messages.some((message) => message.role === "assistant") && <p className="empty-copy">Casual conversation and completed responses appear in Chat.</p>}</section><section className="live-action-card"><div className="block-label"><span>LIVE ACTION</span><small>{displayText(activeAction?.status, "idle")}</small></div>{activeAction ? <><strong>{displayText(activeAction.commandId || activeAction.kind)}</strong><p>{displayText(activeAction.shortRationale)}</p><details><summary>Exact envelope and Maple output reference</summary><pre>{displayText({ action: activeAction, rawModelOutputRef: activeAction.rawModelOutputRef, modelChannels: activeAction.modelChannels, parseStatus: activeAction.parseStatus, fallbackMode: activeAction.fallbackMode }, "No action envelope recorded.")}</pre></details></> : <p className="empty-copy">No action is active. The host does not turn conversation into a plan.</p>}</section><section className="live-evidence-card"><div className="block-label"><span>EVIDENCE</span><small>{displayText(latestObservation?.status || latestEvent?.status, "waiting")}</small></div><p>{displayText(latestObservation?.summary || latestEvent?.payload?.reason || "Receipts, observations, and stop reasons will appear here.")}</p>{latestObservation?.outputDigest && <code>{latestObservation.outputDigest}</code>}{receipts.slice(0, 3).map((event) => <div className="evidence-line" key={event.id}><strong>{displayText(event.type.replaceAll(".", " · "))}</strong><small>{displayText(event.evidenceRefs?.[0] || event.payload?.rawOutputRef || "event recorded")}</small></div>)}</section></div></section>
            <details className="full-trace" open={false}><summary>Full trace · lifecycle, command detail, and host interpretation</summary>
            <section className="objective-block"><div className="block-label"><span>CURRENT OBJECTIVE</span><time>updated {formatTime(task.updatedAt || latestEvent?.createdAt)}</time></div><h1>{task.objective || "A quiet place for ambitious work."}</h1><p>Local only. Preserve determinism and auditability. Base Maple weights remain immutable.</p></section>
            <section className="attention-ribbon" aria-label="Now next why"><div><span>NOW</span><strong>{displayText(task.status === "blocked" ? "Needs attention" : activeStep, "Choose the next bounded action")}</strong><small>{displayText(task.phase || "ready")} · {displayText(task.status || "ready")}</small></div><div><span>NEXT</span><strong>{displayText(nextAction)}</strong><small>{ambientCandidate ? "candidate awaiting review" : "selected from current task state"}</small></div><div><span>WHY</span><strong>{displayText(contextSnapshot?.focusHypotheses?.[0]?.label || "Hemlock workspace")}</strong><small>{displayText(contextSnapshot?.focusHypotheses?.[0]?.evidenceRefs?.[0] || "local task and project evidence")}</small></div></section>
            <section className="agent-loop-panel" aria-label="Maple host execution loop"><div className="block-label"><span>HOST EXECUTION LOOP</span><span className={`loop-badge ${displayText(task.status, "ready")}`}>{displayText(task.status, "ready")}</span></div><div className="agent-loop-grid"><div><small>PLAN</small><strong>{displayText(activePlan ? activePlan.status.replaceAll("_", " ") : "not proposed")}</strong><span>{activePlan?.steps?.length || 0} bounded steps</span></div><div><small>ACTION</small><strong>{displayText(activeAction?.commandId || activeAction?.kind || "waiting")}</strong><span>{displayText(activeAction?.status || "no action selected")}</span></div><div><small>OBSERVATION</small><strong>{displayText(latestObservation?.status || "pending")}</strong><span>{displayText(latestObservation ? latestObservation.summary : "No command receipt yet")}</span></div><div><small>BUDGET</small><strong>{task.budget?.agentStepsUsed || 0}/{task.budget?.maxAgentSteps || 8}</strong><span>{task.budget?.commandsUsed || 0}/{task.budget?.maxCommands || 12} commands</span></div></div>{(queueState?.count || 0) > 0 && <div className="agent-queue-readout"><span><Icon name="pulse" size={13} /> INTENT QUEUE</span><strong>{queueState.pending?.length || 0} waiting</strong><small>{queueState.active ? `active: ${displayText(queueState.active.payload?.text || "local task")}` : "ready to start"}</small></div>}{planNeedsApproval && activePlan && <div className="agent-loop-decision"><p>{displayText(activePlan.rationale)}</p><div className="candidate-actions"><button type="button" onClick={() => void runCommand("plan.approve", { taskId: task.id, planId: activePlan.id })}>Approve plan</button><button type="button" onClick={() => void runCommand("plan.reject", { taskId: task.id, planId: activePlan.id, reason: "Plan rejected from Command Center" })}>Reject</button></div></div>}{actionNeedsApproval && activeAction && <div className="agent-loop-decision"><p>{displayText(activeAction.shortRationale)}</p><div className="candidate-actions"><button type="button" onClick={() => void runCommand("action.accept", { taskId: task.id, actionId: activeAction.id })}>Accept action</button><button type="button" onClick={() => void runCommand("action.reject", { taskId: task.id, actionId: activeAction.id, reason: "Action rejected from Command Center" })}>Reject</button></div></div>}<div className="agent-loop-trace">{actions.slice(-4).reverse().map((action) => <span key={action.id}><i className={`trace-status trace-${action.status}`} /><strong>{displayText(action.commandId || action.kind)}</strong><small>{displayText(action.status)}</small></span>)}</div></section>
            <section className="work-note-block"><div className="block-label"><span>WORK NOTE</span><time>{latestEvent ? formatTime(latestEvent.createdAt) : "session ready"}</time></div><p>{displayText(isThinking ? "Maple-Preview is composing a local response." : isDreaming ? dreamStage : sipsCycleState === "running" ? sipsStage : latestEvent?.payload?.stage || latestEvent?.payload?.command || "Hemlock is waiting for the next bounded action.")}</p><div className="active-step-card"><div className="step-card-heading"><span className="step-index">{task.status === "blocked" ? "!" : "→"}</span><div><span className="cockpit-kicker">ACTIVE STEP</span><strong>{displayText(activeStep, "Choose the next bounded action")}</strong></div><span className="step-progress">{taskProgress ? `${Math.round(taskProgress)}%` : "ready"}</span></div><p>{displayText(task.status === "blocked" ? task.blockedReason || "A local operation needs inspection before the task can continue." : "Keep the next action bounded, receipt-backed, and visible to the agent.")}</p><div className="step-card-actions"><button type="button" className="next-action-button" onClick={runNextAction}><Icon name={task.status === "blocked" ? "warning" : "play"} size={14} /> {displayText(nextAction)}</button><button type="button" className="quiet-action" onClick={() => openWindow("activity")}>Activity <Icon name="chevron" size={13} /></button></div></div></section>
            <section className="trace-block"><div className="trace-heading"><span>COMMAND TRACE <em>{trace.length}</em></span><button type="button" onClick={() => openWindow("activity")}>View stream <Icon name="chevron" size={12} /></button></div>{trace.length ? <div className="trace-list">{trace.map((event) => <div className="trace-row" key={event.id}><time>{formatTime(event.createdAt)}</time><span>{event.type.replaceAll(".", " · ")}</span><i className={`trace-status trace-${event.status}`}><Icon name={event.status === "failed" ? "warning" : event.status === "running" ? "pulse" : "check"} size={12} /></i><small>{displayText(event.payload?.stage || event.payload?.command || event.status)}</small></div>)}</div> : <p className="empty-copy">No command trace yet. The first request will appear here.</p>}</section>
            </details>
          </div>
        </div>
      </section>

      <aside className="evidence-ledger" aria-label="Evidence and context ledger">
        <section className="ledger-section context-ledger"><div className="ledger-heading"><span>CONTEXT QUALITY</span><button type="button" onClick={() => void runCommand("context.refresh", { reason: "ledger" })} aria-label="Refresh context quality"><Icon name="refresh" size={13} /></button></div><div className="quality-readout"><div className="quality-ring" style={{ "--quality": `${confidence}%` }}><strong>{confidence || "—"}</strong><span>{confidence ? "high" : contextStatus}</span></div><div className="quality-stats"><div><span>Freshness</span><strong>{freshness}</strong></div><div><span>Relevance</span><strong>{quality.relevance == null ? "—" : `${Math.round(quality.relevance * 100)}%`}</strong></div><div><span>Coverage</span><strong>{quality.sourceCoverage == null ? "—" : `${Math.round(quality.sourceCoverage * 100)}%`}</strong></div><div><span>Providers</span><strong>{(contextSnapshot?.providers || []).filter((provider) => provider.status === "fresh" || provider.status === "available").length}/{contextSnapshot?.providers?.length || 0}</strong></div></div></div><p className="ledger-note">{contextStatus === "fresh" ? "Fresh local context is available with redaction and provenance." : "Refresh awareness context before relying on day-to-day observations."}</p></section>
        <section className="ledger-section"><div className="ledger-heading"><span>EVIDENCE LEDGER</span><button type="button" onClick={() => openWindow("receipts")}>View all <Icon name="chevron" size={12} /></button></div>{receipts.length ? <div className="ledger-list">{receipts.map((event) => <button type="button" className="ledger-row" key={event.id} onClick={() => openWindow("receipts")}><Icon name="receipt" size={13} /><span><strong>{event.type.replaceAll(".", " · ")}</strong><small>{displayText(event.evidenceRefs?.[0] || event.payload?.stage || "local receipt")}</small></span><time>{formatTime(event.createdAt)}</time></button>)}</div> : <p className="empty-copy">Receipts will collect here as Hemlock works.</p>}</section>
        <section className="ledger-section candidate-ledger"><div className="ledger-heading"><span>AMBIENT INBOX</span><span className="ledger-tag">{activeCandidates.length ? `${activeCandidates.length} REVIEW` : "QUIET"}</span></div>{ambientCandidate ? <><strong>{displayText(ambientCandidate.title)}</strong><p>{displayText(ambientCandidate.summary)}</p><small>{displayText(ambientCandidate.reason)} · {Math.round((ambientCandidate.confidence || 0) * 100)}% confidence</small><div className="candidate-actions"><button type="button" onClick={() => void transitionCandidate(ambientCandidate, "accept")}>Accept task</button><button type="button" onClick={() => void transitionCandidate(ambientCandidate, "dismiss")}>Dismiss</button></div></> : candidate ? <><strong>{displayText(candidate.title || "Unreviewed project lesson")}</strong><p>{displayText(candidate.body || "Evidence attached to candidate.")}</p><small>verify before use · {displayText(candidate.event?.evidenceRefs?.[0] || "receipt linked")}</small><div className="candidate-actions"><button type="button" onClick={() => openWindow("memory")}>Review memory</button><button type="button" onClick={() => void transitionMemory(candidate, "demote")}>Demote</button></div></> : <p className="empty-copy">No candidate needs attention. Enabled sources remain quiet.</p>}</section>
        <section className={`ledger-section blocker-ledger ${blockers.length || task.status === "blocked" ? "has-blocker" : ""}`}><div className="ledger-heading"><span>BLOCKERS</span>{blockers.length || task.status === "blocked" ? <span className="ledger-tag alert">ATTENTION</span> : <span className="ledger-tag good">CLEAR</span>}</div>{task.status === "blocked" ? <p><Icon name="warning" size={14} /> {displayText(task.blockedReason || "The current task is blocked.")}</p> : blockers.length ? blockers.map((event) => <p key={event.id}><Icon name="warning" size={14} /> {displayText(event.payload?.error || event.payload?.stage || event.type)}</p>) : <p><Icon name="check" size={14} /> No active blockers in the current task.</p>}</section>
      </aside>

      <section className="cockpit-bottom" aria-label="Hemlock command and activity console">
        <div className="cockpit-console command-console"><div className="console-heading"><span>COMMAND CONSOLE</span><kbd>⌘K</kbd></div><form onSubmit={sendMessage}><textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Command Hemlock…" rows="2" aria-label="Hemlock command input" disabled={isDreaming} /><div className="console-actions"><div className="mode-actions"><button type="button" onClick={() => { setDraft("Inspect the current Hemlock project and report what matters next."); openWindow("chat"); }}><Icon name="map" size={13} /> Inspect</button><button type="button" onClick={() => { setDraft("Improve the next coding task with one verified SIPS cycle."); openWindow("sips"); }}><Icon name="dream" size={13} /> Improve</button><button type="button" onClick={() => openWindow("memory")}><Icon name="memory" size={13} /> Remember</button></div><button className="primary-action" type="submit" disabled={!draft.trim() || isDreaming || (!isDesktop && isThinking)}><Icon name="send" size={14} /> Run</button></div></form><div className="console-footer"><StatusLamp state={serverState} label={isDesktop ? "local runtime" : "browser preview"} /><span>{activeAdapterPath ? (adapterVerified ? "Dream adapter verified" : "adapter recorded") : "base Maple-Preview"}</span><span>Tab complete</span></div></div>
        <div className="event-spine"><div className="bottom-heading"><span>EVENT SPINE</span><button type="button" onClick={() => openWindow("activity")}>All activity <Icon name="chevron" size={12} /></button></div>{events.slice(-5).reverse().map((event) => <div className="spine-row" key={event.id}><i className={`spine-dot spine-${event.status}`} /><time>{formatTime(event.createdAt)}</time><span className={`spine-type spine-type-${event.status}`}>{displayText(event.status)}</span><strong>{displayText(event.payload?.stage || event.payload?.command || event.type.replaceAll(".", " · "))}</strong></div>)}{!events.length && <p className="empty-copy">Session events will appear here.</p>}</div>
        <div className="loop-panel"><div className="bottom-heading"><span>DREAM / SIPS ACTIVITY</span><button type="button" onClick={() => openWindow(sipsCycleState === "running" ? "sips" : "dream")}>{sipsCycleState === "running" ? "SIPS" : "DREAM"} <Icon name="chevron" size={12} /></button></div><div className="loop-panel-state"><span className={isDreaming || sipsCycleState === "running" ? "is-live" : ""}><Icon name={isDreaming ? "dream" : "sips"} size={15} /> {isDreaming ? dreamStage : sipsCycleState === "running" ? sipsStage : "No long-running work"}</span><strong>{isDreaming ? `${Math.round(dreamProgress)}%` : sipsCycleState === "running" ? `${Math.round(sipsProgress)}%` : "ready"}</strong></div><div className="loop-panel-actions"><button type="button" onClick={() => openWindow("dream")}><Icon name="dream" size={13} /> Dream Lab</button><button type="button" onClick={() => openWindow("sips")}><Icon name="sips" size={13} /> SIPS Control</button></div></div>
        <div className="pulse-panel"><div className="bottom-heading"><span>HEARTBEAT</span><StatusLamp state={serverState} label={serverState} /></div><div className="pulse-visual"><Icon name="pulse" size={130} /><span className="pulse-ring ring-a" /><span className="pulse-ring ring-b" /></div><strong>{events.length ? `${events.length} events` : "quiet"}</strong><small>{latestEvent ? `last ${formatTime(latestEvent.createdAt)}` : "waiting for local activity"}</small></div>
        {error && <div className="runtime-alert cockpit-error"><Icon name="activity" size={15} /><span>{error}</span></div>}
      </section>
    </div>;
  }

  function renderChat() {
    const taskEvents = events.filter((event) => event.taskId === task.id || event.payload?.taskId === task.id || event.payload?.task?.id === task.id);
    const workNotes = taskEvents.map((event) => ({ event, note: conciseAgentNote(event) })).filter((item) => item.note).slice(-12);
    const liveStreams = streamFrames.filter((stream) => stream.kind === "model_text" && !stream.terminal);
    const actions = (agentProjection?.actions || []).filter((action) => action.taskId === task.id);
    const activeAction = actions.find((action) => action.id === task.activeActionId) || actions.filter((action) => !["completed", "failed", "cancelled", "blocked", "rejected"].includes(action.status)).at(-1) || actions.at(-1) || null;
    const latestActionEvent = taskEvents.filter((event) => event.type.startsWith("action.") || event.type.startsWith("command.")).at(-1) || null;
    const latestObservation = (agentProjection?.observations || []).filter((observation) => observation.taskId === task.id || !observation.taskId).at(-1) || null;
    const evidenceRefs = [...new Set([...(latestObservation?.evidenceRefs || []), ...(latestActionEvent?.evidenceRefs || []), ...(task.evidenceRefs || [])].filter(Boolean))];
    const renderChannels = (message) => {
      const channels = messageChannels(message);
      if (!channels.length) return <div className="maple-channel maple-channel-empty"><span className="model-channel-label">Maple · no prose channel returned</span><p>The model response contained no text channel. The host record remains available in Full trace.</p></div>;
      return channels.map((channel, index) => {
        const label = `Maple · ${displayText(channel.name, "content")}`;
        if (channel.name === "content" || index === 0 && channels.length === 1) return <div className="maple-channel maple-channel-content" key={`${channel.name}-${index}`}><span className="model-channel-label">{label}</span><div className="message-content">{displayText(channel.text, "")}{message.streaming && <span className="stream-caret" aria-label="Maple response still arriving">▍</span>}</div></div>;
        return <details className="maple-channel maple-channel-secondary" open key={`${channel.name}-${index}`}><summary className="model-channel-label">{label} · emitted by Maple</summary><pre>{displayText(channel.text, "")}</pre></details>;
      });
    };
    return <div className="chat-surface"><div className="surface-intro chat-task-header"><div><span className="eyebrow">TASK STREAM <span className="browser-boundary">{isDesktop ? "ELECTRON RUNTIME" : "BROWSER VISUAL PREVIEW"}</span></span><details className="objective-collapse" open={!task.objective || task.objective.length < 120}><summary>{task.objective || "Untitled Hemlock task"}</summary><p>Maple output stays verbatim; host actions and evidence stay beside it.</p></details></div><StatusLamp state={hasLiveStream(liveStreams) || task.status === "running" ? "working" : task.status === "blocked" ? "down" : "ready"} label={liveStreams.length ? `${liveStreams.length} stream${liveStreams.length === 1 ? "" : "s"}` : task.status} /></div>{(queueState?.pending?.length || liveStreams.length) > 0 && <div className="chat-activity-strip"><span>{liveStreams.length ? "LIVE RESPONSE" : "QUEUE"}</span><strong>{liveStreams.length ? `${Math.round((liveStreams.at(-1)?.text || "").length)} chars received` : `${queueState?.pending?.length || 0} waiting`}</strong>{queueState?.pending?.slice(0, 2).map((entry) => <button key={entry.id} type="button" onClick={() => void desktopAgent()?.cancelQueued?.(entry.requestId)}>{entry.position}. {entry.payload?.objective || entry.payload?.text}</button>)}</div>}<div className="chat-scroll">
      {!messages.length && !workNotes.length && <div className="empty-work"><span className="empty-symbol"><Icon name="leaf" size={26} /></span><h3>Start with Maple</h3><p>Conversation comes first. Exact model channels, live actions, and evidence will appear here as the task develops.</p></div>}
      {messages.map((message) => <article className={`work-message ${message.role}`} key={message.id}><div className="message-meta"><span>{displayText(message.role === "user" ? "YOU" : "MAPLE")}{message.streaming ? " · LIVE" : ""}</span><time>{displayText(message.time)}</time></div>{message.role === "assistant" ? <section className="maple-output-card" aria-label="Maple emitted response"><div className="card-kicker"><span>MAPLE OUTPUT</span><small>{message.displayMode || "model-verbatim"}</small></div>{renderChannels(message)}</section> : <div className="message-content">{displayText(message.content)}</div>}{message.telemetry && <details className="host-telemetry" open={message.role === "assistant"}><summary>Host telemetry</summary><p>{message.telemetry.elapsedMs != null ? `${Math.round(message.telemetry.elapsedMs / 100) / 10}s` : "timing unavailable"}{message.telemetry.completionTokens != null ? ` · ${message.telemetry.completionTokens} output tokens` : ""}{message.telemetry.finishReason ? ` · stop: ${message.telemetry.finishReason}` : ""}{message.telemetry.outputDigest ? ` · ${message.telemetry.outputDigest}` : ""}{message.telemetry.streamId ? ` · stream ${message.telemetry.streamId}` : ""}{message.telemetry.bufferedFallback ? " · buffered fallback" : message.telemetry.streaming ? " · SSE stream" : ""}{message.rawOutputRef ? ` · raw ${message.rawOutputRef}` : ""}</p></details>}</article>)}
      <section className="live-task-surface" aria-label="Live task detail"><div className="live-task-heading"><span>LIVE TASK</span><small>host detail beside Maple output</small></div><div className="live-task-grid"><section className="live-action-card"><div className="card-kicker"><span>LIVE ACTION</span><small>{displayText(activeAction?.status, "idle")}</small></div>{activeAction ? <><strong>{displayText(activeAction.commandId || activeAction.kind)}</strong><p>{displayText(activeAction.shortRationale)}</p><details open><summary>Exact validated action envelope</summary><pre>{displayText(activeAction, "No action envelope recorded.")}</pre></details>{(activeAction.modelChannels?.length || activeAction.rawModelOutputRef) && <details open><summary>Raw Maple output reference</summary><pre>{displayText({ rawModelOutputRef: activeAction.rawModelOutputRef, modelChannels: activeAction.modelChannels, parseStatus: activeAction.parseStatus, fallbackMode: activeAction.fallbackMode }, "No raw output reference.")}</pre></details>}</> : <p className="empty-copy">No validated action is active. Casual conversation stays in Chat.</p>}</section><section className="live-evidence-card"><div className="card-kicker"><span>EVIDENCE</span><small>{displayText(latestObservation?.status || latestActionEvent?.status, "waiting")}</small></div><p>{displayText(latestObservation?.summary || latestActionEvent?.payload?.reason || "Authoritative observations and receipts will collect here.")}</p>{latestObservation?.outputDigest && <code>{latestObservation.outputDigest}</code>}{evidenceRefs.length > 0 && <ul>{evidenceRefs.slice(0, 5).map((ref) => <li key={ref}>{displayText(ref)}</li>)}</ul>}{(task.blockedReason || latestActionEvent?.payload?.stopReason) && <p className="evidence-stop">Stop reason: {displayText(task.blockedReason || latestActionEvent.payload.stopReason)}</p>}</section></div></section>
      {workNotes.length > 0 && <details className="host-trace" open={false}><summary>Full trace · decisions, tools, observations, repairs, and receipts</summary><div className="agent-notes-list">{workNotes.map(({ event, note }) => <div className={`agent-note agent-note-${event.status}`} key={event.id}><i /><span>{note}</span><time>{formatTime(event.createdAt)}</time></div>)}</div></details>}
      {isThinking && <div className="live-note"><span className="pulse" /> Host is waiting for Maple’s local response <span>···</span></div>}
      <div ref={endRef} />
    </div><form className="chat-compose" onSubmit={sendMessage}><textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendMessage(event); } }} placeholder="Continue the conversation or task…" rows="2" aria-label="Continue Hemlock task" disabled={isDreaming} /><button className="primary-action" type="submit" disabled={!draft.trim() || isDreaming || (!isDesktop && isThinking)}><Icon name="send" size={15} /> Send</button></form></div>;
  }

  function renderSips() {
    const selfloop = sipsStatus?.selfloop || { status: "idle" };
    return <div className="sips-surface"><div className="surface-intro"><div><span className="eyebrow"><Icon name="sips" size={13} /> LOCAL CONTROL ROOM</span><h2>SIPS / self-improvement</h2></div><StatusLamp state={selfloop.status === "active" ? "working" : "ready"} label={selfloop.status} /></div><p className="surface-copy">A bounded loop for inspect, recall, verify, Dream, compare, and remember. Every consequential state stays attached to a receipt.</p><div className="sips-metrics"><Metric value={sipsStatus?.records ?? "—"} label="lessons" /><Metric value={sipsStatus?.datasetRows ?? "—"} label="data rows" tone="gold" /><Metric value={sipsStatus?.cycleCount ?? "—"} label="cycles" tone="violet" /></div><section className="surface-section"><SectionTitle icon="command" right="allowlisted">Commands</SectionTitle><div className="inline-search"><input value={sipsRecallQuery} onChange={(event) => setSipsRecallQuery(event.target.value)} placeholder="Recall a project lesson…" aria-label="Recall project lesson" /><button onClick={() => void runCommand("recall", { query: sipsRecallQuery })} aria-label="Recall lesson"><Icon name="search" size={15} /></button></div><div className="quick-command-grid"><button onClick={() => void refreshSips()} disabled={Boolean(commandBusy)}><Icon name="activity" size={13} /> Status</button><button onClick={() => void runCommand("repo-map")} disabled={Boolean(commandBusy)}><Icon name="map" size={13} /> Map</button><button onClick={() => void runCommand("verify", { profile: sipsVerifyProfile })} disabled={Boolean(commandBusy)}><Icon name="receipt" size={13} /> Verify</button><button onClick={() => openWindow("receipts")}><Icon name="receipt" size={13} /> Receipts</button></div></section><section className="surface-section cycle-section"><SectionTitle icon="dream" right={sipsCycleState}>{sipsObjective}</SectionTitle><textarea className="setting-control" value={sipsObjective} onChange={(event) => setSipsObjective(event.target.value)} rows="2" disabled={sipsCycleState === "running"} aria-label="SIPS objective" /><div className="split-controls"><label>Verify<select value={sipsVerifyProfile} onChange={(event) => setSipsVerifyProfile(event.target.value)}><option value="app-build">UI build</option><option value="diff-check">Git diff</option><option value="python-tests">MLX tests</option></select></label><label>Dream<select value={sipsTrainingProfile} onChange={(event) => setSipsTrainingProfile(event.target.value)}><option value="smoke">Smoke</option><option value="balanced">Balanced</option><option value="quality">Quality</option></select></label></div><div className="cycle-strip"><span className="done">BASE</span><span className={sipsCycleState === "running" ? "active" : ""}>DATA</span><span className={sipsStage.toLowerCase().includes("dream") ? "active" : ""}>DREAM</span><span className={sipsStage.toLowerCase().includes("verify") ? "active" : ""}>VERIFY</span></div><div className="progress-bar"><span style={{ width: `${sipsCycleState === "running" ? sipsProgress : sipsReceipt ? 100 : 0}%` }} /></div><p className="stage-copy">{sipsStage}{sipsLog ? ` · ${sipsLog}` : ""}</p><button className="wide-action" onClick={() => void runSipsCycle()} disabled={sipsCycleState === "running" || isDreaming}>{sipsCycleState === "running" ? "Cycle running…" : "Run one bounded cycle"}</button></section><section className="surface-section loop-section"><SectionTitle icon="play" right={selfloop.status}>Persistent focus</SectionTitle><p className="surface-copy">{selfloop.focus || sipsObjective}</p><div className="loop-actions"><button onClick={() => void runSelfloop("start")} disabled={selfloop.status === "active"}><Icon name="play" size={13} /> Start</button><button onClick={() => void runSelfloop("pause")} disabled={selfloop.status !== "active"}><Icon name="pause" size={13} /> Pause</button><button onClick={() => void runSelfloop("resume")} disabled={selfloop.status !== "paused"}>Resume</button><button onClick={() => void runSelfloop("complete")} disabled={!(["active", "paused"].includes(selfloop.status))}>Complete</button></div></section>{sipsError && <div className="runtime-alert"><Icon name="activity" size={15} />{sipsError}</div>}</div>;
  }

  function renderMemory() {
    return <div className="memory-surface"><div className="surface-intro"><div><span className="eyebrow"><Icon name="memory" size={13} /> LOCAL MEMORY</span><h2>Memory Garden</h2></div><StatusLamp state="ready" label="on this Mac" /></div><p className="surface-copy">Personal facts stay separate from project lessons. Verified observations take root; uncertain ones remain seeds.</p><div className="memory-add"><input value={factDraft} onChange={(event) => setFactDraft(event.target.value)} onKeyDown={(event) => event.key === "Enter" && addFact()} placeholder="Add a personal fact…" aria-label="Add personal fact" /><button onClick={addFact} aria-label="Add personal fact"><Icon name="plus" size={16} /></button></div><section className="garden-section"><SectionTitle icon="leaf" right={`${facts.length} facts`}>Personal facts</SectionTitle>{facts.length ? facts.map((fact) => <div className="garden-row" key={fact.id}><span className={`seed-dot ${fact.baked ? "rooted" : "seed"}`} /><div><strong>{displayText(fact.text)}</strong><small>{fact.baked ? "baked into local memory" : "waiting for Dream"}</small></div><button onClick={() => removeFact(fact.id)} aria-label={`Remove ${displayText(fact.text)}`}>×</button></div>) : <p className="empty-copy">No personal facts yet.</p>}</section><section className="garden-section candidate-garden"><SectionTitle icon="activity" right={`${candidates.filter((item) => item.status === "candidate").length} seeds`}>Ambient candidates</SectionTitle>{candidates.filter((item) => item.status === "candidate").slice().reverse().slice(0, 6).map((candidate) => <div className="candidate-row" key={candidate.id}><div><strong>{displayText(candidate.title)}</strong><small>{displayText(candidate.summary)}</small><em>{displayText(candidate.sourceId)} · {Math.round((candidate.confidence || 0) * 100)}% · {displayText(candidate.reason)}</em></div><div className="lesson-actions"><button onClick={() => void transitionCandidate(candidate, "accept")}>Accept</button><button onClick={() => void transitionCandidate(candidate, "dismiss")}>Dismiss</button></div></div>)}{!candidates.some((item) => item.status === "candidate") && <p className="empty-copy">No ambient observations need review.</p>}</section><section className="garden-section"><SectionTitle icon="sips" right={`${memoryRecords.length} lessons`}>Project lessons</SectionTitle>{memoryRecords.length ? memoryRecords.slice().reverse().map((item, index) => { const transitioned = ["memory.demote", "memory.rollback"].includes(item.event?.type); return <div className={`lesson-row ${transitioned ? "is-faded" : ""}`} key={item.event?.id || index}><span className={`lesson-mark ${item.event?.type === "memory.promoted" ? "rooted" : "candidate"}`} /><div><strong>{displayText(item.title || "Hemlock lesson")}</strong><small>{displayText(item.body || "Local evidence attached.")}</small><em>{item.event?.type === "memory.promoted" ? "promoted · verify before use" : item.event?.type === "memory.demote" ? "demoted · history retained" : item.event?.type === "memory.rollback" ? "rolled back · history retained" : "candidate"}</em><div className="lesson-actions"><button onClick={() => void transitionMemory(item, "demote")} disabled={commandBusy === "memory.demote"}>Demote</button><button onClick={() => void transitionMemory(item, "rollback")} disabled={commandBusy === "memory.rollback"}>Undo</button></div></div></div>; }) : <p className="empty-copy">Hemlock will add a project lesson after a verified correction or SIPS receipt.</p>}</section>{sipsRecall?.records?.length > 0 && <section className="garden-section recalled"><SectionTitle icon="search" right={`${sipsRecall.records.length} matches`}>Recalled now</SectionTitle>{sipsRecall.records.slice(0, 3).map((record) => <div className="recalled-row" key={record.id}><strong>{displayText(record.title)}</strong><span>{displayText(record.body)}</span></div>)}</section>}</div>;
  }

  function renderDream() {
    const stepCount = { smoke: 1, balanced: 4, quality: 8 }[dreamTrainingProfile] || 8;
    return <div className="dream-surface"><div className="dream-hero"><div className="dream-moon-large"><Icon name="dream" size={36} /></div><div><span className="eyebrow">LOCAL TRAINING WINDOW</span><h2>Dream Lab</h2><p>{isDreaming ? dreamStage : dreamReceipt ? "Candidate adapter receipt is available." : "Prepare an isolated LoRA adapter without touching the base Maple weights."}</p></div><StatusLamp state={isDreaming ? "working" : dreamReceipt ? "ready" : "idle"} label={isDreaming ? `${dreamProgress}%` : "idle"} /></div><div className="dream-progress"><div className="progress-bar"><span style={{ width: `${dreamProgress}%` }} /></div><div><span>{dreamLog || "The live heartbeat appears here during MLX work."}</span><strong>{formatElapsed(dreamElapsed)}</strong></div></div><div className="dream-chart"><div className="chart-lines"><i /><i /><i /><i /></div><svg viewBox="0 0 620 150" preserveAspectRatio="none" aria-label="Dream loss preview"><polyline points="0,110 40,88 78,102 116,66 154,82 192,54 230,75 268,61 306,72 344,47 382,63 420,50 458,58 496,42 534,52 572,44 620,50" /><polyline className="faint" points="0,126 40,113 78,124 116,92 154,103 192,84 230,98 268,87 306,95 344,76 382,90 420,80 458,87 496,72 534,82 572,75 620,80" /></svg><div className="chart-labels"><span>step 1</span><span>step {Math.max(1, Math.ceil((dreamProgress / 100) * stepCount))}</span></div></div><div className="dream-metrics"><Metric value={`${Math.round((dreamProgress / 100) * stepCount)}/${stepCount}`} label="steps" tone="gold" /><Metric value={trainingDataset?.sourceRows ?? facts.length + messages.length} label="dataset rows" /><Metric value={dreamReceipt?.baseWeightsUnchanged === true ? "safe" : "—"} label="base weights" tone="violet" /><Metric value={dreamReceipt?.inferenceReady === true ? "ready" : "—"} label="adapter" /></div><div className="dream-controls"><label>Profile<select value={dreamTrainingProfile} onChange={(event) => setDreamTrainingProfile(event.target.value)} disabled={isDreaming}><option value="smoke">Smoke · 1 step</option><option value="balanced">Balanced · 4 steps</option><option value="quality">Quality · 8 steps</option></select></label><button className="wide-action" onClick={() => void startDream()} disabled={isDreaming || (!facts.length && !messages.length)}><Icon name="dream" size={15} />{isDreaming ? "Dreaming locally…" : "Prepare dataset + start Dream"}</button>{isDreaming && <button className="quiet-action" onClick={() => void window.mapleDesktop?.cancelAgentTask?.()}><Icon name="stop" size={13} /> Stop</button>}</div>{trainingDataset && <div className="proof-callout"><SectionTitle icon="database" right="ready">Dataset holdout</SectionTitle><span>{trainingDataset.trainingRows} train · {trainingDataset.validationRows} validation · {trainingDataset.sourceRows} source rows</span><small>The dataset is prepared before the explicit training operation; no weights changed during preparation.</small></div>}{dreamReceipt && <div className="proof-callout"><SectionTitle icon="receipt" right={dreamReceipt.baseWeightsUnchanged === true ? "verified" : "unproven"}>Latest training proof</SectionTitle><span>Profile: {dreamReceipt.profile || "—"} · rows: {dreamReceipt.dataset?.sourceRows ?? dreamReceipt.dataset?.examples ?? "—"} · holdout: {dreamReceipt.dataset?.validationHoldout === true ? "yes" : "no"}</span><small>The integrity receipt proves isolation; it does not claim a general model-quality gain.</small></div>}{recoveryNotice && <div className="runtime-alert">{recoveryNotice}</div>}</div>;
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

  function renderArtifactStudio() {
    const artifact = artifacts.find((item) => item.id === activeArtifactId) || artifacts.at(-1) || null;
    const sourceText = artifact ? Object.entries(artifact.source || {}).map(([name, value]) => `// ${name}\n${value}`).join("\n\n") : "No task-scoped artifact yet. Create one from the command palette or the authoring action.";
    const revisionOptions = artifact?.revisions?.length ? artifact.revisions : [];
    const previewSrc = artifact?.status === "failed" && artifact?.lastKnownGoodSource ? previewDocument({ ...artifact, source: artifact.lastKnownGoodSource }) : previewDocument(artifact);
    const previewCommand = (action, input = {}) => {
      if (!previewSession) return setPreviewNotice("Open a preview session before sending a registered preview command.");
      if (action === "inspect" || action === "accessibility") {
        const frame = document.querySelector(".artifact-preview-frame");
        frame?.contentWindow?.postMessage({ source: "hemlock-preview", action, input }, "*");
        setPreviewNotice(`Requested ${action} from the isolated preview harness.`);
        return;
      }
      void runArtifact("preview.interact", { sessionId: previewSession.id, previewAction: action, ...input });
      const frame = document.querySelector(".artifact-preview-frame");
      frame?.contentWindow?.postMessage({ source: "hemlock-preview", action, input }, "*");
    };
    return <div className="artifact-studio-surface">
      <div className="artifact-toolbar"><div><span className="eyebrow"><Icon name="artifact" size={13} /> TASK-SCOPED ARTIFACT</span><h2>{artifact?.title || "Artifact Studio"}</h2></div><div className="artifact-toolbar-actions"><button type="button" className="quiet-action" onClick={() => void runArtifact("create", { artifactId: `artifact-${Date.now()}`, title: "Eastern Hemlock night garden", kind: "html", entrypoint: "index.html", mime: "text/html" })}>New artifact</button>{artifact && !artifact.revision && <button type="button" className="quiet-action" onClick={() => void runArtifact("author", { artifactId: artifact.id, kind: "html", filename: "index.html", runtimeTemplate: "html", objective: "Create an ambitious Eastern Hemlock night-garden single page", source: { "index.html": "<main data-preview-id=\"garden\"><h1>Eastern Hemlock Night Garden</h1><p>A living task-local draft.</p></main>" } })}>Author starter</button>}<span className={`artifact-status status-${artifact?.status || "drafting"}`}>{artifact?.status || "drafting"}</span><button type="button" className="quiet-action" onClick={() => setArtifactFreeze((value) => !value)}>{artifactFreeze ? "Follow live" : "Freeze"}</button><button type="button" className="quiet-action" onClick={() => setArtifactPinned((value) => !value)}>{artifactPinned ? "Unpin" : "Pin"}</button><button type="button" className="quiet-action" onClick={() => setArtifactView("diff")} disabled={!artifact?.revision}>Compare revisions</button><button type="button" className="quiet-action" onClick={() => setPreviewNotice("Evidence is the Electron artifact manifest, revision digest, and preview interaction receipts.")}>Open evidence</button><button type="button" className="quiet-action" onClick={() => setArtifactView("source")} disabled={!artifact?.revision}>Reveal source</button><button type="button" className="quiet-action" onClick={() => void runArtifact("preview.open", { artifactId: artifact?.id })} disabled={!artifact?.revision}>Open preview</button><button type="button" className="quiet-action" onClick={() => void runArtifact("preview.stop", { sessionId: previewSession?.id, reason: "agent_input_paused" })} disabled={!previewSession}>Pause agent input</button></div></div>
      {previewNotice && <div className="artifact-notice" role="status">{previewNotice}</div>}
      <div className="artifact-revisions"><span>Revision</span>{revisionOptions.map((revision) => <button key={revision.id} type="button" className={revision.revision === artifact?.revision ? "is-selected" : ""} onClick={() => setPreviewNotice(`Revision r${revision.revision} · ${revision.digest}`)}>r{revision.revision}</button>)}<span className="artifact-layout-hint">Drag dividers · use arrows · scroll for all panels</span>{artifact?.digest && <small className="artifact-digest">{artifact.digest}</small>}</div>
      <div className="artifact-tabs" role="tablist" aria-label="Artifact Studio panes">{["source", "diff", "preview", "output", "inspect"].map((tab) => <button key={tab} type="button" role="tab" aria-selected={artifactView === tab} className={artifactView === tab ? "is-selected" : ""} onClick={() => setArtifactView(tab)}>{tab === "source" ? "Source" : tab[0].toUpperCase() + tab.slice(1)}</button>)}</div>
      <div className={`artifact-workspace ${artifactFocusPreview ? "is-preview-focused" : ""}`} style={{ "--artifact-source-fr": `${artifactLayout.source}fr`, "--artifact-diff-fr": `${artifactLayout.diff}fr`, "--artifact-preview-fr": `${artifactLayout.preview}fr`, "--artifact-evidence-row": `${artifactLayout.evidence}px` }}>
        <section className={`artifact-pane artifact-source-pane ${artifactView === "source" ? "is-visible" : ""}`}><div className="pane-heading"><span>Source</span><button type="button" onClick={() => void runArtifact("artifact.inspect", { artifactId: artifact?.id })}>Reveal source</button></div><pre>{sourceText}</pre></section>
        <section className={`artifact-pane artifact-diff-pane ${artifactView === "diff" ? "is-visible" : ""}`}><div className="pane-heading"><span>Diff</span><button type="button" onClick={() => void runArtifact("compare", { artifactId: artifact?.id, from: Math.max(1, (artifact?.revision || 1) - 1), to: artifact?.revision })}>Compare revisions</button></div><p>{artifact?.revision > 1 ? "Select Compare revisions to request a durable source diff." : "The first complete revision has no parent diff."}</p></section>
        <section className={`artifact-pane artifact-preview-pane ${artifactView === "preview" ? "is-visible" : ""}`}><div className="pane-heading"><span>Live Preview <small>{isDesktop ? "Electron sandbox" : "Browser visual preview · non-runtime"}</small></span><div className="preview-pane-actions"><button type="button" onClick={() => previewCommand("inspect")}>Inspect</button><button type="button" onClick={() => previewCommand("accessibility")}>A11y</button><button type="button" className="preview-focus-action" onClick={() => setArtifactFocusPreview((value) => !value)}>{artifactFocusPreview ? "Workspace" : "Focus preview"}</button></div></div>{artifact?.revision ? <iframe className="artifact-preview-frame" title="Isolated artifact preview" sandbox="allow-scripts allow-forms" referrerPolicy="no-referrer" srcDoc={previewSrc} /> : <div className="artifact-empty"><Icon name="artifact" size={22} /><strong>The first renderable revision will peek here.</strong><span>Authoring stays scoped to this task and never writes repository source.</span></div>}</section>
        <section className={`artifact-pane artifact-output-pane ${artifactView === "output" ? "is-visible" : ""}`}><div className="pane-heading"><span>Output / Console</span><button type="button" onClick={() => setPreviewNotice("Console is sourced from preview harness messages and host receipts.")}>Open evidence</button></div><pre>{previewInspection ? JSON.stringify(previewInspection, null, 2) : "No preview console output yet."}</pre></section>
        <section className={`artifact-pane artifact-inspect-pane ${artifactView === "inspect" ? "is-visible" : ""}`}><div className="pane-heading"><span>Inspection</span><button type="button" onClick={() => previewCommand("wait", { ms: 250 })}>Wait 250ms</button></div><pre>{previewInspection ? JSON.stringify(previewInspection, null, 2) : "Inspection follows the latest registered preview command."}</pre></section>
        <button type="button" className="artifact-resize-handle artifact-resize-source-diff" aria-label="Resize Source and Diff panels" title="Drag to resize Source and Diff panels" onPointerDown={(event) => beginArtifactPanelResize(event, "source-diff")} onPointerMove={updateArtifactPanelResize} onPointerUp={endArtifactPanelResize} onPointerCancel={endArtifactPanelResize} onKeyDown={(event) => handleArtifactPanelResizeKey(event, "source-diff")} />
        <button type="button" className="artifact-resize-handle artifact-resize-diff-preview" aria-label="Resize Diff and Live Preview panels" title="Drag to resize Diff and Live Preview panels" onPointerDown={(event) => beginArtifactPanelResize(event, "diff-preview")} onPointerMove={updateArtifactPanelResize} onPointerUp={endArtifactPanelResize} onPointerCancel={endArtifactPanelResize} onKeyDown={(event) => handleArtifactPanelResizeKey(event, "diff-preview")} />
        <button type="button" className="artifact-resize-handle artifact-resize-evidence" aria-label="Resize Output and Inspection panels" title="Drag to resize Output and Inspection panels" onPointerDown={(event) => beginArtifactPanelResize(event, "evidence")} onPointerMove={updateArtifactPanelResize} onPointerUp={endArtifactPanelResize} onPointerCancel={endArtifactPanelResize} onKeyDown={(event) => handleArtifactPanelResizeKey(event, "evidence")} />
      </div>
      <div className="artifact-footer"><span>{artifact ? `${artifact.kind} · ${artifact.mime} · ${artifact.entrypoint}` : "No artifact selected"}</span><span>{previewSession ? `preview ${previewSession.status} · ${previewSession.actions}/24 actions` : "preview session idle"}</span><button type="button" className="quiet-action" onClick={() => void runArtifact("export", { artifactId: artifact?.id })} disabled={!artifact?.revision}>Export to change set</button></div>
    </div>;
  }

  function renderActivity() {
    return <div className="activity-surface"><div className="surface-intro"><div><span className="eyebrow"><Icon name="activity" size={13} /> LOCAL EVENT STREAM</span><h2>Activity</h2></div><StatusLamp state={commandBusy || isThinking || isDreaming || liveStream ? "working" : "ready"} label={commandBusy || isThinking || isDreaming || liveStream ? "working" : "quiet"} /></div><div className="event-stream">{events.length ? events.slice().reverse().slice(0, 22).map((event) => <EventRow event={event} key={event.id} />) : <p className="empty-copy">Hemlock events will appear here as the workspace works.</p>}</div><section className="stream-records"><SectionTitle icon="pulse" right={`${streamFrames.length} buffered`}>Ephemeral streams</SectionTitle>{streamFrames.slice(-8).reverse().map((stream) => { const streamKind = displayText(stream.kind, "stream"); const streamStatus = displayText(stream.status, "buffered"); const streamText = typeof stream.text === "string" ? stream.text.slice(-160) : stream.text; return <div className="stream-record" key={displayText(stream.streamId, `${streamKind}-${streamStatus}`)}><span className={`stream-kind stream-kind-${streamKind}`}>{streamKind}</span><strong>{streamStatus}</strong><small>{displayText(streamText)}</small></div>; })}</section></div>;
  }

  function renderReceipts() {
    const storedReceipts = receiptRecords.slice(0, 8);
    return <div className="receipts-surface"><div className="surface-intro"><div><span className="eyebrow"><Icon name="receipt" size={13} /> PROOF STORE</span><h2>Receipts</h2></div><button className="quiet-action" type="button" onClick={() => void runCommand("receipts.query")}>Refresh</button></div><p className="surface-copy">A visible state is only a receipt-backed claim when it links to evidence.</p>{changeSet && <section className="proof-callout change-set-callout"><SectionTitle icon="work" right={displayText(changeSet.status)}>Prepared change set</SectionTitle><strong>{displayText(changeSet.id)}</strong><small>{displayText(changeSet.claimBoundary)}</small><div className="candidate-actions"><button type="button" onClick={() => void runCommand("change.approve", { changeSetId: changeSet.id, confirm: true })} disabled={changeSet.status !== "waiting_for_approval"}>Approve and apply</button><button type="button" onClick={() => void runCommand("change.reject", { changeSetId: changeSet.id, note: "Rejected from Receipts" })} disabled={changeSet.status !== "waiting_for_approval"}>Reject</button></div></section>}<section className="receipt-section"><SectionTitle icon="database" right={`${storedReceipts.length} stored`}>Runtime receipts</SectionTitle>{storedReceipts.length ? <div className="receipt-stack">{storedReceipts.map((item) => <div className="receipt-card" key={item.path}><div><strong>{displayText(item.receipt?.schema, "local receipt")}</strong><span className={`receipt-state ${displayText(item.receipt?.status, "recorded")}`}>{displayText(item.receipt?.status, "recorded")}</span></div><p>{displayText(item.receipt?.objective || item.receipt?.error, "Persistent runtime evidence.")}</p><small>{displayText(item.relativePath)}</small></div>)}</div> : <p className="empty-copy">Stored Dream and SIPS receipts will appear after the first runtime query.</p>}</section><section className="receipt-section"><SectionTitle icon="activity" right="current session">Event evidence</SectionTitle><div className="receipt-stack">{events.filter((event) => event.evidenceRefs?.length || event.type.includes("completed") || event.type.includes("failed")).slice().reverse().slice(0, 12).map((event) => <div className="receipt-card" key={event.id}><div><strong>{displayText(event.type?.replaceAll?.(".", " · "), "local event")}</strong><span className={`receipt-state ${displayText(event.status, "recorded")}`}>{displayText(event.status, "recorded")}</span></div><p>{displayText(event.payload?.stage || event.payload?.error || event.payload?.command, "Local runtime event recorded.")}</p><small>{displayText(event.evidenceRefs?.join?.(" · "), "session event evidence")}</small></div>)}</div></section>{latestReceiptEvent && <div className="proof-callout"><SectionTitle icon="receipt" right="latest">Selected evidence</SectionTitle><span>{displayText(latestReceiptEvent.type?.replaceAll?.(".", " · "), "local event")} · {displayText(latestReceiptEvent.status, "recorded")}</span><small>{displayText(latestReceiptEvent.evidenceRefs?.[0], "Event is recorded in the current local session.")}</small></div>}</div>;
  }

  function renderMap() {
    return <div className="map-surface"><div className="surface-intro"><div><span className="eyebrow"><Icon name="map" size={13} /> READ-ONLY TOPOLOGY</span><h2>Project Map</h2></div><StatusLamp state={sipsRepoMap?.dirty ? "working" : "ready"} label={sipsRepoMap ? (sipsRepoMap.dirty ? "dirty" : "clean") : "not read"} /></div><div className="map-visual"><div className="map-node root"><Icon name="tree" size={18} /><strong>Hemlock</strong><small>{displayText(sipsRepoMap?.branch || "main")}</small></div><div className="map-line" /><div className="map-branches"><span><Icon name="dream" size={14} /> Maple model</span><span><Icon name="sips" size={14} /> SIPS runtime</span><span><Icon name="chat" size={14} /> Dream chat</span></div></div><div className="map-list"><div><span>Repository</span><strong>{displayText(sipsRepoMap?.root || "Open desktop to inspect")}</strong></div><div><span>Branch</span><strong>{displayText(sipsRepoMap?.branch || "—")}</strong></div><div><span>Worktree</span><strong>{sipsRepoMap?.dirty ? "changes present" : sipsRepoMap ? "clean" : "—"}</strong></div><div><span>Files observed</span><strong>{sipsRepoMap?.files?.length || "—"}</strong></div></div><button className="wide-action" onClick={() => void runCommand("repo-map")}>Refresh project map</button></div>;
  }

  function renderSettings() {
    const inventory = agentSnapshot?.storageInventory;
    const formatBytes = (bytes) => bytes == null ? "—" : bytes > 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GiB` : bytes > 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MiB` : `${Math.round(bytes / 1024)} KiB`;
    return <div className="settings-surface"><div className="surface-intro"><div><span className="eyebrow"><Icon name="settings" size={13} /> LOCAL CONFIGURATION</span><h2>Settings</h2></div></div><label>Maple-Preview server URL<input className="setting-control" value={apiBase} onChange={(event) => { setApiBase(event.target.value); setReadinessCheck("idle"); setServerProcessReady(null); setInferenceReady(null); }} /></label><p className="surface-copy">Hemlock sends requests through the Electron control plane. A healthy process is not the same as a completed inference response.</p><div className="readiness-box"><StatusLamp state={serverState} label={`process: ${serverState}`} /><StatusLamp state={inferenceReady ? "ready" : inferenceReady === false ? "down" : "idle"} label={`inference: ${inferenceReady ? "verified" : inferenceReady === false ? "not verified" : "not checked"}`} /></div><label>Regular Dream profile<select className="setting-control" value={dreamTrainingProfile} onChange={(event) => setDreamTrainingProfile(event.target.value)}><option value="smoke">Smoke · 1 step</option><option value="balanced">Balanced · 4 steps</option><option value="quality">Quality · 8 steps</option></select></label><button className="wide-action" onClick={() => void checkReadiness()} disabled={readinessCheck === "checking"}>{readinessCheck === "checking" ? "Checking local inference…" : "Check local readiness"}</button><section className="settings-sources"><SectionTitle icon="activity" right="explicit opt-in">Context sources</SectionTitle><p className="surface-copy">Hemlock only uses enabled sources. Every surfaced observation retains its source and freshness.</p>{sourcePolicies.length ? sourcePolicies.map((source) => <label className="source-policy" key={source.sourceId}><span><strong>{displayText(source.displayName)}</strong><small>{displayText(source.sourceId)} · {displayText(source.retention)} · {displayText(source.permissionState)}</small></span><input type="checkbox" checked={source.enabled !== false} onChange={(event) => void setSourceEnabled(source, event.target.checked)} disabled={!isDesktop || source.sourceId === "local-project"} /></label>) : <p className="empty-copy">Source policies will appear after the desktop runtime resumes.</p>}</section><section className="settings-runtime"><SectionTitle icon="database" right="application data">Runtime storage</SectionTitle><p>{displayText(inventory?.root || agentProjection?.storage?.root || agentSnapshot?.runtime?.root, "Hemlock application data")}</p><div className="storage-metrics"><span>Model<strong>{formatBytes(inventory?.modelBytes)}</strong></span><span>Runtime<strong>{formatBytes(inventory?.totalRuntimeBytes)}</strong></span><span>Free<strong>{formatBytes(inventory?.freeBytes)}</strong></span></div><small>Models, adapters, datasets, receipts, and event projections stay outside the Git worktree. Inventory is informational; cleanup remains an explicit future operation.</small></section></div>;
  }

  const windowContent = { center: renderCenter(), chat: renderChat(), artifact: renderArtifactStudio(), sips: renderSips(), memory: renderMemory(), dream: renderDream(), activity: renderActivity(), receipts: renderReceipts(), map: renderMap(), settings: renderSettings() };

  return <main className="hemlock-os">
    <div className="ambient-branch branch-a" /><div className="ambient-branch branch-b" />
    <header className="system-bar"><div className="system-brand" onClick={() => openWindow("center")} role="button" tabIndex="0"><span className="brand-mark"><Icon name="tree" size={28} /></span><strong>Hemlock</strong><span>OS</span></div><div className="system-context"><span className="system-path">active task / <strong>{task.intent || "conversation"}</strong></span><span className="system-task">{task.objective}</span></div><div className="system-health"><div className="system-health-chip"><StatusLamp state={serverState} label={isDesktop ? "local only" : "preview"} /><span>MAPLE</span></div><div className="system-health-chip"><StatusLamp state={sipsStatus?.selfloop?.status === "active" ? "working" : "ready"} label={sipsStatus?.selfloop?.status === "active" ? "active" : "idle"} /><span>SIPS</span></div><div className="system-health-chip system-activity-chip"><StatusLamp state={commandBusy || isThinking || isDreaming || liveStream ? "working" : "ready"} label={commandBusy || isThinking || isDreaming || liveStream ? "working" : `${events.length} events`} /><span>ACTIVITY</span></div><button className="system-palette" onClick={() => setPaletteOpen(true)} aria-label="Open command palette"><Icon name="command" size={15} /><kbd>⌘K</kbd></button><button className="system-settings" onClick={() => openWindow("settings")} aria-label="Open settings"><Icon name="settings" size={16} /></button></div></header>
    <div className="desktop-strip"><span className="strip-label">UNDERSTORY / {task.status}</span><span className="strip-line" /><span className="strip-event">{latestEvent ? latestEvent.type.replaceAll(".", " · ") : "session ready"}</span><span className="strip-time">{formatTime()}</span></div>
    <section ref={canvasRef} className="desktop-canvas" aria-label="Hemlock desktop workspace">{Object.keys(WINDOW_META).map((id) => <WindowFrame key={id} windowState={workspaceWindows[id]} meta={WINDOW_META[id]} active={activeWindowId === id} onFocus={focusWindow} onDragStart={startDrag} onResizeStart={startResize} onMinimize={minimizeWindow} onMaximize={maximizeWindow} onClose={closeWindow}>{windowContent[id]}</WindowFrame>)}</section>
    <nav className="understory-dock" aria-label="Hemlock surfaces">{Object.entries(WINDOW_META).map(([id, meta]) => { const state = workspaceWindows[id]; const open = state?.state !== "closed"; const minimized = state?.state === "minimized"; return <button type="button" key={id} className={`dock-item ${open ? "open" : ""} ${activeWindowId === id ? "active" : ""}`} onClick={() => open && !minimized ? focusWindow(id) : openWindow(id)} aria-label={`${open && !minimized ? "Focus" : "Open"} ${meta.label}`}><span className={`dock-icon glyph-${meta.tone}`}><Icon name={meta.icon} size={17} /></span><span>{meta.label}</span>{(id === "activity" && events.length > 0) || (id === "artifact" && artifacts.length > 0) || (id === "dream" && isDreaming) || (id === "sips" && sipsCycleState === "running") ? <i className="dock-notification" /> : null}</button>; })}<button className="dock-item dock-command" onClick={() => setPaletteOpen(true)} aria-label="Open command palette"><span className="dock-icon"><Icon name="command" size={17} /></span><span>Command palette</span></button></nav>
    {paletteOpen && <div className="palette-backdrop" onClick={() => setPaletteOpen(false)}><section className="command-palette" onClick={(event) => event.stopPropagation()}><div className="palette-top"><Icon name="command" size={16} /><input ref={paletteRef} value={paletteQuery} onChange={(event) => setPaletteQuery(event.target.value)} placeholder="Search the Hemlock operating environment…" aria-label="Search Hemlock commands" /><kbd>ESC</kbd></div><div className="palette-list">{filteredCommands.map((item) => <button key={item.id} onClick={() => chooseCommand(item)}><span className="palette-icon"><Icon name={item.icon} size={16} /></span><span><strong>{item.label}</strong><small>{item.hint}</small></span><span className="palette-arrow">↵</span></button>)}{!filteredCommands.length && <p className="empty-copy">No local command matches that search.</p>}</div><div className="palette-foot"><span>Only allowlisted local actions appear here.</span><span>Hemlock OS</span></div></section></div>}
  </main>;
}

createRoot(document.getElementById("root")).render(<App />);
