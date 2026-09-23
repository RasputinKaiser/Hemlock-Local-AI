import React, { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "../components/Icons.jsx";
import { CopyMessageButton } from "../components/CopyMessageButton.jsx";
import { withProvenance } from "../copyProvenance.js";
import { arriveIn } from "../windowMotion.js";
import { authoringEvidence, AUTHORING_FLAG_COPY, buildTranscriptTimeline, inputContract, planProgress, planStepStates, scoreReceipt } from "../agentTimeline.js";
import { filterTranscript, highlightSegments, normalizeQuery, SEARCH_KINDS } from "../transcriptSearch.js";
import { parseSlashCommand, prefixMode, resolveSlashCommand, slashCommandList } from "../chatCommands.js";
import { friendlyError } from "../friendlyError.js";
import { readDraft, writeDraft } from "../draftStore.js";
import { contextStatus } from "../contextStatus.js";
import { hasLiveStream } from "../streamStore.js";
import {
  ACTIVE_TASK_STATUSES,
  DEFAULT_MAPLE_MAX_TOKENS,
  GlossaryHint,
  MODEL_LANES,
  PrimerCard,
  StatusLamp,
  TERMINAL_STREAM_STATUSES,
  compactPreview,
  displayText,
  formatRelativeTime,
  formatTime,
  formatTokensPerSecond,
  messageChannels,
} from "./shared.jsx";

// Chat window: transcript, plan/approval card, host event rail, composer.
// Extracted from main.jsx — App-scope values arrive through the ctx bag.
const AUTONOMY_LABELS = { "bounded-local": "supervised", guided: "guided", autonomous: "autonomous", "bounded-campaign": "campaign" };


// Hoisted from the chat component so memoized transcript rows can use it
// without re-creating a closure per render.
function channelProviderName(provider) {
  return MODEL_LANES[provider]?.label || (provider ? String(provider).toUpperCase() : "Local");
}

// Search highlighting: split display text into segments and wrap hits in
// <mark>. Identity output (the plain string) when there is no query, so the
// common path stays unchanged.
function markedText(text, query) {
  const value = String(text ?? "");
  if (!query) return value;
  return highlightSegments(value, query).map((segment, index) => (
    segment.match ? <mark className="search-hit" key={index}>{segment.text}</mark> : <React.Fragment key={index}>{segment.text}</React.Fragment>
  ));
}

// Raw view for assistant rows: the recorded channels verbatim, plus the host's
// rawOutputRef when present. Labeled chrome — never merged into the rendered
// output card.
function rawChannelText(message) {
  const channels = message?.channels || [];
  const body = channels.length
    ? channels.map((channel) => `[${channel.name || "content"}]\n${channel.text || ""}`).join("\n\n")
    : String(message?.content || "");
  return message?.rawOutputRef ? `${body}\n\nraw ref: ${message.rawOutputRef}` : body;
}


// T11-B: one transcript row, memoized. Coalesced stream flushes replace the
// `messages` array immutably but only spread-change the message that actually
// advanced — so with primitives-only other props and a stable onRetry,
// React.memo skips every untouched row on each flush.
const TranscriptMessageRow = memo(function TranscriptMessageRow({
  message,
  index,
  total,
  isThinking,
  reasoningOff,
  threadId,
  threadTitle,
  onRetry,
  onEdit,
  highlight = "",
}) {
  const [rawOpen, setRawOpen] = useState(false);
  const messageProvider = message.provider || message.channels?.[0]?.source || "maple";
  const messageProviderName = channelProviderName(messageProvider);
  const renderChannels = (target) => {
    const channels = messageChannels(target);
    const providerName = channelProviderName(target.provider || channels[0]?.source);
    const visibleChannels = channels.filter((channel) => (channel.text || "").trim().length > 0)
      // Reasoning toggle ("Thinking: off") hides the CoT channel entirely.
      // Local models always emit <think> internally; this is a display
      // control, and the full trace still records the reasoning.
      .filter((channel) => !(reasoningOff && (channel.name === "reasoning" || channel.name === "reasoning_content")));
    const streamDied = target.telemetry?.finishReason === "error" || target.streamStatus === "failed" || target.streamStatus === "restarting" || target.errorCode === "CANCELLED";
    const failureText = String(target.telemetry?.stopReason || target.streamStopReason || "");
    const gpuError = streamDied && /metal|commandbuffer|gpu/i.test(failureText);
    // Honest waiting state: while the stream is opening we must not flash the
    // terminal "finished without text" copy at an empty bubble.
    if (!visibleChannels.length && target.streaming && !streamDied) return <div className="maple-channel maple-channel-waiting"><span className="model-channel-label">{providerName}</span><p>Waiting for the first {providerName} output…<span className="stream-caret" aria-hidden="true">▍</span></p></div>;
    if (!visibleChannels.length) return <div className="maple-channel maple-channel-empty"><span className="model-channel-label">{providerName}</span>{gpuError ? <><p>The model hit a GPU error (transient). Hemlock retried automatically — try again if this persists.</p><div className="repair-actions"><button type="button" disabled={isThinking} onClick={() => onRetry()}>Re-run this prompt</button></div></> : streamDied ? <><p>The connection to the local model dropped mid-reply (the server likely restarted after a hiccup). The reply was not completed.</p><div className="repair-actions"><button type="button" disabled={isThinking} onClick={() => onRetry()}>Re-run this prompt</button></div></> : <p>The model finished without returning any text. This usually means it hit its token limit while reasoning. Try again, or raise the token ceiling in a longer task.</p>}</div>;
    return visibleChannels.map((channel, index) => {
      const label = `${channelProviderName(channel.source || target.provider)} · ${displayText(channel.name, "content")}`;
      if (channel.name === "content" || index === 0 && channels.length === 1) return <div className="maple-channel maple-channel-content" key={`${channel.name}-${index}`}><span className="model-channel-label">{label}</span><div className="message-content">{markedText(displayText(channel.text, ""), highlight)}{target.streaming && <span className="stream-caret" aria-label={`${providerName} response still arriving`}>▍</span>}</div></div>;
      const isReasoning = channel.name === "reasoning" || channel.name === "reasoning_content";
      const reasoningLabel = isReasoning ? `${providerName} · thinking` : label;
      return <details className={`maple-channel maple-channel-secondary ${isReasoning ? "maple-channel-reasoning" : ""}`} open={Boolean(target.streaming) && !target.stopped} key={`${channel.name}-${index}-${target.streaming ? "live" : "done"}`}><summary className="model-channel-label">{reasoningLabel}{isReasoning ? (target.streaming ? " · streaming…" : ` · ${Math.round((channel.text || "").length / 4)} tokens of thought`) : ` · model channel`}{isReasoning && !target.streaming && (channel.text || "").length > 0 ? <span className="reasoning-preview">{displayText(channel.text.replace(/\s+/g, " ").trim().slice(0, 110))}{channel.text.length > 110 ? "…" : ""}</span> : null}</summary><pre>{displayText(channel.text, "")}</pre></details>;
    });
  };
  return <article className={`work-message ${message.role}${message.kind === "host-footnote" ? ` chat-host-footnote is-${message.status}` : ""}${message.partial ? " is-partial" : ""}${message.streaming ? " is-streaming" : ""}`}>{message.partial && <div className="partial-note">Interrupted — reply kept up to the cut ({String(message.stopReason || "cancelled")}).</div>}<div className="message-meta"><span>{displayText(message.role === "user" ? "YOU" : messageProviderName.toUpperCase())}{message.streaming ? " · LIVE" : ""}</span><time>{displayText(message.time)}</time><span className="message-actions"><CopyMessageButton text={message.content || (message.channels || []).find((channel) => channel.name === "content")?.text || ""} provenanceText={withProvenance(message, { providerLabel: MODEL_LANES[messageProvider]?.shortLabel || messageProviderName.toUpperCase(), threadTitle })} />{message.role === "user" && <button type="button" title="Edit & resend — loads this message back into the composer" aria-label="Edit and resend this message" onClick={() => onEdit?.(message)} disabled={isThinking || !onEdit}><Icon name="pencil" size={13} /> Edit</button>}{message.role === "assistant" && <button type="button" title="Toggle the raw recorded channel payload — what the host stored, not a re-render" aria-pressed={rawOpen} onClick={() => setRawOpen((value) => !value)}><Icon name="receipt" size={13} /> {rawOpen ? "Rendered" : "Raw"}</button>}<button type="button" title={`Ask again · resends this message${index < total - 1 ? " as the newest prompt" : ""}`} aria-label={`Ask again, resend this message`} onClick={() => onRetry(message)} disabled={isThinking}><Icon name="retry" size={13} /> Retry</button></span></div>{message.role === "assistant" ? <section className="maple-output-card" aria-label={`${messageProviderName} emitted response`}><div className="card-kicker"><span>{messageProviderName.toUpperCase()} OUTPUT</span><GlossaryHint as="small" term="Verbatim" definition="this is the model’s exact output — Hemlock never paraphrases or edits what the model said.">{message.displayMode || "model-verbatim"}</GlossaryHint></div>{renderChannels(message)}</section> : <div className="message-content">{markedText(displayText(message.content), highlight)}</div>}{rawOpen && <pre className="raw-output-view" aria-label="Raw recorded channel payload">{displayText(rawChannelText(message), "No recorded channels.")}</pre>}
{message.telemetry && <details className="host-telemetry" open={message.role === "assistant"}><summary>Host telemetry</summary><p>{message.telemetry.provider ? `${message.telemetry.provider} · ${message.telemetry.reasoning || "native"} · ` : ""}{message.telemetry.elapsedMs != null ? `${Math.round(message.telemetry.elapsedMs / 100) / 10}s` : "timing unavailable"}{message.telemetry.completionTokens != null ? ` · ${message.telemetry.completionTokens} output tokens` : ""} · {formatTokensPerSecond(message.telemetry, message.telemetry.elapsedMs)}{message.telemetry.finishReason ? ` · stop: ${message.telemetry.finishReason}` : ""}{message.telemetry.outputDigest ? ` · ${displayText(message.telemetry.outputDigest)}` : ""}{message.telemetry.streamId ? ` · stream ${displayText(message.telemetry.streamId)}` : ""}{message.telemetry.bufferedFallback ? " · buffered fallback" : message.telemetry.streaming ? " · SSE stream" : ""}{typeof message.telemetry.cacheHitRatio === "number" ? ` · cache ${Math.round(message.telemetry.cacheHitRatio * 100)}%` : ""}{message.rawOutputRef ? ` · raw ${displayText(message.rawOutputRef)}` : ""}</p></details>}</article>;
});


// Context meter (T6-G3): make the bounded prompt budget visible. The host
// reports the exact chars it sent (telemetry.contextChars); the budget is the
// compaction default (24k). Pure so the amber threshold is testable.
const CONTEXT_BUDGET_CHARS = 24000;

function contextMeter(telemetry) {
  const used = Number(telemetry?.contextChars);
  if (!Number.isFinite(used) || used <= 0) return null;
  const percent = Math.min(100, Math.round((used / CONTEXT_BUDGET_CHARS) * 100));
  const kb = (used / 1024).toFixed(1);
  return { percent, label: `context · ${kb}k / ${Math.round(CONTEXT_BUDGET_CHARS / 1024)}k`, warn: percent >= 80 };
}


const FRESH_EVENT_WINDOW_MS = 45000;

// Long transcripts mount only the latest window of rows; "show earlier" and
// search hits expand the boundary upward. Filtering still runs over the full
// message list, so hidden rows are always findable.
const TRANSCRIPT_WINDOW = 150;


// One host receipt row interleaved into the transcript timeline: a dense
// one-line summary (kind, honest note, command chip, score margin) that
// expands into the input contract, scalar payload, and evidence refs.
// Styled as host chrome — never as model output (the verbatim boundary).
const HostEventRow = memo(function HostEventRow({ event, note, onOpenWindow, highlight = "" }) {
  const rootRef = useRef(null);
  // Fresh arrivals animate once; hydrated history mounts silently.
  const fresh = Date.now() - (Date.parse(event.createdAt) || 0) < FRESH_EVENT_WINDOW_MS;
  useLayoutEffect(() => { if (fresh) arriveIn(rootRef.current); }, []); // mount-only arrival cue
  const payload = event.payload || {};
  const action = payload.action || null;
  // Placeholder/repaired authoring evidence rides inside the action's input —
  // surface it loudly so scaffold content never passes as authored output.
  const authoringFlags = authoringEvidence(event);
  const commandId = action?.commandId || (typeof payload.command === "string" ? payload.command : null) || payload.commandId || payload.insertedStep?.commandId || null;
  const chips = inputContract(action?.input || payload.input || null);
  const score = event.type === "action.scored" ? scoreReceipt({ ...payload, status: event.status }) : null;
  const evidenceRefs = [...new Set([...(event.evidenceRefs || []), ...(action?.expectedEvidence || []), ...(payload.observation?.evidenceRefs || [])].filter(Boolean))];
  const scalars = Object.entries(payload).filter(([key, value]) => value != null && typeof value !== "object" && !["taskId", "actionId", "planId"].includes(key));
  const destination = commandId?.startsWith("artifact.") || commandId === "preview.interact"
    ? { id: "artifact", label: "Open Artifact Studio" }
    : ["code.apply", "git.diff", "git.status", "verify", "verification.list", "changeset.apply", "receipts.query"].includes(commandId) || event.type === "artifact.verification.failed"
      ? { id: "receipts", label: "Open Receipts" }
      : null;
  return <details className={`host-event host-event-${displayText(event.status, "recorded")}`} ref={rootRef}>
    <summary>
      <i className="host-event-node" aria-hidden="true" />
      <span className="host-event-kind">{displayText(event.type?.replaceAll?.(".", " · "), "host event")}</span>
      <span className="host-event-note">{markedText(note || displayText(payload.stage || payload.command || payload.title || payload.error || event.status, "host event recorded"), highlight)}</span>
      {commandId && <code className="cmd-chip" title="Registered, allowlisted host command">{commandId}</code>}
      {authoringFlags.length > 0 && <code className="fallback-chip" title={AUTHORING_FLAG_COPY[authoringFlags[0].type]}>{authoringFlags.some((flag) => flag.type === "authoring.host_fallback") ? "placeholder content" : "repaired content"}</code>}
      {score?.margin != null && <code className="score-chip" title={`Winner's logprob margin over the runner-up${score.avgLogprob != null ? ` · avg logprob ${score.avgLogprob.toFixed(2)}` : ""}`}>margin {score.margin.toFixed(2)}</code>}
      <time>{formatTime(event.createdAt)}</time>
    </summary>
    <div className="host-event-body">
      {authoringFlags.map((flag) => <p key={flag.type} className="host-event-honesty"><Icon name="warning" size={11} /> {AUTHORING_FLAG_COPY[flag.type]}{flag.reason ? ` ${displayText(flag.reason)}` : ""}</p>)}
      {score && !score.degraded && <div className="host-event-facts">
        {score.winner && <span>winner <code className="cmd-chip">{score.winner}</code></span>}
        {score.runnerUp && <span>runner-up <code className="cmd-chip is-runner-up">{score.runnerUp}</code></span>}
        {score.candidateCount != null && <span>{score.candidateCount} candidates scored</span>}
        {score.elapsedMs != null && <span>in {Math.round(score.elapsedMs / 10) / 100}s</span>}
        {score.cachedTokens != null && <span>{score.cachedTokens} cached prompt tokens</span>}
        {score.complete && <span>decided without generating tokens</span>}
      </div>}
      {chips.length > 0 && <div className="host-event-facts"><span className="host-event-facts-label">input contract</span>{chips.map((chip) => <code key={chip.key} className="input-chip">{chip.key}={chip.value}</code>)}</div>}
      {action?.shortRationale && <p className="host-event-rationale">{displayText(action.shortRationale)}</p>}
      {scalars.length > 0 && <div className="host-event-payload">{scalars.slice(0, 10).map(([key, value]) => <div key={key}><code>{key}</code><span>{String(value).slice(0, 220)}</span></div>)}</div>}
      {evidenceRefs.length > 0 && <ul className="host-event-refs">{evidenceRefs.slice(0, 6).map((ref) => <li key={ref}>{displayText(ref)}</li>)}</ul>}
      {destination && <div className="host-event-actions"><button type="button" onClick={() => onOpenWindow(destination.id)}>{destination.label}</button></div>}
    </div>
  </details>;
});


function conciseAgentNote(event, task) {
  const payload = event.payload || {};
  const action = payload.action || {};
  const observation = payload.observation || {};
  const command = payload.command || action.commandId;
  const provider = payload.provider || payload.telemetry?.provider || payload.conversation?.provider || task?.provider;
  const providerLabel = MODEL_LANES[provider]?.label || "selected provider";
  switch (event.type) {
    case "task.created": return "Hemlock attached this request to a durable local task.";
    case "memory.recalled": return `Recalled ${payload.count ?? 0} scoped lesson${payload.count === 1 ? "" : "s"} before work began.`;
    case "context.quality.updated": return `Context checked: ${payload.quality?.status || "local evidence"} with ${Math.round((payload.quality?.confidence || 0) * 100)}% confidence.`;
    case "plan.proposed": return `Bounded plan proposed: ${payload.plan?.steps?.length || 0} registered step${payload.plan?.steps?.length === 1 ? "" : "s"}.`;
    case "plan.approved": return "Plan approved; the selected provider may continue through the registered host loop.";
    case "plan.rejected": return `Plan rejected: ${String(payload.reason || "user decision").slice(0, 220)}`;
    case "plan.auto_approved": return "Campaign mode: the bounded plan was auto-approved; every action still carries a receipt.";
    case "task.paused": return "Task paused at a step boundary — resume to continue the plan.";
    case "task.resumed": return "Task resumed from its pause point.";
    case "task.cancelled": return "Task cancelled by request; queued intents stay held rather than auto-starting.";
    case "task.queued": return `Intent queued behind the active task at position ${payload.position || "?"}: ${String(payload.entry?.payload?.objective || payload.entry?.payload?.text || "queued request").slice(0, 140)}`;
    case "task.queue.cancelled": return "A queued intent was cancelled before it started.";
    case "action.autonomy.bypass": return `${payload.commandId || "An action"} ran without an approval click under ${payload.autonomy || "elevated"} autonomy — receipted as an explicit bypass.`;
    case "action.scored": return event.status === "degraded"
      ? `Action scoring unavailable (${String(payload.error || "scorer offline").slice(0, 120)}); using normal generation.`
      : `Scored ${payload.candidateCount ?? "?"} candidate actions in ${Math.round((payload.elapsedMs || 0) / 10) / 100}s — chose ${payload.winner?.commandId || "a step"}${payload.runnerUp?.commandId ? ` over ${payload.runnerUp.commandId}` : ""}${Number.isFinite(payload.margin) ? ` (margin ${payload.margin.toFixed(2)})` : ""}${payload.complete ? " without generating tokens" : ""}${payload.cachedTokens ? ` · ${payload.cachedTokens} cached prompt tokens` : ""}.`;
    case "dream.adapter.grafted": return "Dream adapter grafted into the live server; detach in Dream Lab to return to base.";
    case "dream.adapter.detached": return "Active graft detached — the server restarted on base Maple weights.";
    case "dream.fuse.started": return "Fusing the grafted adapter into a new checkpoint…";
    case "dream.fused": return "Graft fused into new served weights — detach returns to the base checkpoint.";
    case "task.steering.received": return `Steering accepted for the next bounded decision; an already-running inference is not rewritten: ${String(payload.steering?.content || "update received").slice(0, 180)}`;
    case "task.steering.restarted": return `Inference restarted with ${payload.steeringCount || 1} steering update${payload.steeringCount === 1 ? "" : "s"} folded into the conversation.`;
    case "maple.recovery": return `Connection to ${providerLabel} dropped; the runtime restarted and your prompt is being re-run (attempt ${payload.attempt || 1}).`;
    case "inference.started": return payload.mode === "structured-action" ? `${providerLabel} is selecting one registered action from the current evidence.` : `${providerLabel} is composing a response.`;
    case "inference.failed": return `${providerLabel} inference needs attention: ${String(payload.error || "no usable output").slice(0, 220)}`;
    case "action.inference.failed": return `${providerLabel} action output was not usable; one repair prompt is being attempted.`;
    case "action.parse.failed": return `The host rejected the proposed action format; one repair prompt is being attempted.`;
    case "action.inference.fallback": return `${providerLabel} structured output was unavailable; the host used the next approved artifact step and marked the fallback — any resulting content is placeholder/repaired, not verbatim model output.`;
    case "inference.completed": {
      const telemetry = payload.telemetry || {};
      const timing = telemetry.elapsedMs ? ` in ${Math.round(telemetry.elapsedMs / 100) / 10}s` : "";
      const tokens = telemetry.completionTokens != null ? ` · ${telemetry.completionTokens} output tokens` : "";
      return `Host recorded ${providerLabel}'s ${payload.mode === "structured-action" ? "structured action pass" : "response"}${timing}${tokens}.`;
    }
    case "action.proposed": return `${providerLabel} proposed ${action.commandId || action.kind || "a bounded action"}: ${String(action.shortRationale || "no rationale supplied").slice(0, 180)}`;
    case "action.validated": return `Host validated ${action.commandId || action.kind || "the action"} against the allowlist and scope.`;
    case "command.started": return `Host started ${command || "a registered command"}.`;
    case "observation.recorded": return `Observation recorded: ${String(observation.summary || event.status).slice(0, 220)}`;
    case "action.completed": return "Registered action completed and its observation was attached to the episode.";
    case "task.blocked": return `Blocked honestly: ${String(payload.reason || "the task needs a decision").slice(0, 220)}`;
    case "task.completed": return "Task completed with the evidence recorded by the host.";
    case "plan.adapted": return `Plan adapted: ${payload.insertedStep?.commandId || "a step"} was ${payload.insertedStep?.adaptive ? "moved to the front as an adaptive selection" : "inserted"} — the approved boundary still binds.`;
    case "task.question": return `${providerLabel} needs your input: ${String(payload.question || task?.foregroundStep || "answer to continue").slice(0, 200)}`;
    case "action.retry.proposed": return `Action failed (${String(payload.category || "retryable").slice(0, 60)}); retry ${payload.retryCount || "?"} was proposed by the host.`;
    case "action.command.recovered": return `${providerLabel} chose an unavailable command; the host continued with the approved step instead.`;
    case "action.redirected": return `The host redirected to the next planned step: ${String(payload.reason || "guardrail").slice(0, 140)}`;
    case "artifact.author.ensure": return `The host created the scratch artifact before authoring so the plan stayed honest.`;
    case "artifact.author.recovered": return `Artifact authoring recovered on the last good revision: ${String(payload.reason || "").slice(0, 160)}`;
    case "artifact.author.repaired": return `Repaired content — ${providerLabel}'s authoring envelope lacked usable source, so one bounded repair inference wrote it. Marked repaired, not verbatim model output.`;
    case "artifact.verification.failed": return `Preview verification failed honestly — ${(payload.issues || []).length || "some"} issue${(payload.issues || []).length === 1 ? "" : "s"} recorded; repair follows.`;
    case "artifact.repair.started": return `Repairing the artifact from recorded preview issues (attempt ${payload.repair?.attempt || 1}).`;
    case "artifact.repair.completed": return "Artifact repair passed verification; the receipt is attached.";
    case "artifact.repair.failed": return `Artifact repair attempt ${payload.attempt || "?"} did not pass: ${String(payload.error || "see receipt").slice(0, 160)}`;
    case "artifact.repair.exhausted": return "Artifact repair exhausted its bounded attempts — the last good revision is still available.";
    case "command.completed": return `Host completed ${command || "the registered command"}${payload.exitCode != null ? ` · exit ${payload.exitCode}` : ""}.`;
    case "command.blocked": return `Host refused ${command || "a command"}: ${String(payload.reason || payload.error || "outside the approved boundary").slice(0, 160)}`;
    case "task.answered": return "Your answer was recorded into the thread and the task resumed.";
    case "task.steered": return `Steering update recorded: ${String(payload.steering?.content || payload.text || "update received").slice(0, 180)}`;
    case "task.queue.started": return "A queued intent started — the previous task reached a terminal receipt.";
    case "task.queue.completed": return "Queued intent completed; the queue advanced.";
    case "task.queue.failed": return `Queued intent failed: ${String(payload.error || "see receipt").slice(0, 160)}`;
    case "verification.started": return `Host started verification: ${String(payload.profile || payload.command || "allowlisted check").slice(0, 120)}`;
    case "verification.ran": case "verification.completed": return `Verification ${payload.status || "recorded"}${payload.command ? ` · ${String(payload.command).slice(0, 100)}` : ""}${payload.evidenceRefs?.length ? " — evidence attached" : ""}.`;
    case "artifact.verification.completed": return `Preview verification ${payload.status || "completed"}${(payload.issues || []).length ? ` · ${payload.issues.length} issue${payload.issues.length === 1 ? "" : "s"}` : " · clean"}.`;
    case "artifact.preview.ready": return "Isolated preview session is live — inspect and interact actions are available.";
    case "artifact.interaction.blocked": return `Preview interaction blocked by the sandbox: ${String(payload.reason || "outside the contract").slice(0, 140)}`;
    case "artifact.restore.failed": return `Revision restore failed: ${String(payload.error || "see receipt").slice(0, 160)}`;
    case "improve.proposed": return `Bounded improvement proposal recorded: ${String(payload.title || payload.summary || "see receipt").slice(0, 160)}`;
    case "experiment.completed": return `World experiment measured by the host: ${String(payload.experiment || payload.summary || "finding recorded").slice(0, 140)}`;
    case "comparison.completed": return `Lane comparison completed — both replies are stored verbatim for review.`;
    case "comparison.failed": return `Lane comparison failed: ${String(payload.error || "see receipt").slice(0, 160)}`;
    case "comparison.blocked": return `Lane comparison blocked: ${String(payload.reason || "see receipt").slice(0, 160)}`;
    case "sips.cycle.started": return "SIPS cycle started — bounded inspect, recall, verify, and remember steps.";
    case "sips.cycle.completed": return "SIPS cycle completed with its receipts attached.";
    case "sips.cycle.failed": return `SIPS cycle failed honestly: ${String(payload.error || "see receipt").slice(0, 160)}`;
    case "dream.started": return `Dream training started (${String(payload.profile || "local profile").slice(0, 60)}) — base weights stay immutable.`;
    case "dream.completed": return "Dream run completed; the candidate adapter receipt is in Dream Lab.";
    case "dream.failed": return `Dream run failed: ${String(payload.error || "see receipt").slice(0, 180)}`;
    case "dream.blocked": return `Dream run blocked: ${String(payload.reason || "approval or scope needed").slice(0, 160)}`;
    case "inference.retrying": return `${providerLabel} inference is retrying (attempt ${payload.attempt || "?"}).`;
    case "inference.stopped": return "Generation stopped — partial output was kept verbatim where recorded.";
    case "maple.runtime.restarted": return "The local Maple runtime restarted; grafted adapters re-attach on boot.";
    case "maple.crashloop.detected": return `Maple crash loop detected after ${payload.attempts || "repeated"} restarts — check local readiness in Settings.`;
    case "conversation.partial": return `The reply was cut off (${String(payload.stopReason || "length").slice(0, 80)}) — recorded as partial verbatim.`;
    case "operation.cancelled": return `Cancelled: ${String(payload.operation || payload.reason || "operation").slice(0, 140)}`;
    default: return null;
  }
}

export const ChatWindow = memo(function ChatWindow({ ctx }) {
  const activeThreadId = ctx.task.threadId || ctx.threadRegistry.activeThreadId;

  // --- Transcript search / filter -----------------------------------------
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchKind, setSearchKind] = useState("all");
  const [slashNotice, setSlashNotice] = useState(null);
  const surfaceRef = useRef(null);
  const [floorSqueezed, setFloorSqueezed] = useState(false);
  const [unread, setUnread] = useState({ anchor: null, base: 0, count: 0 });
  const [renderedCount, setRenderedCount] = useState(TRANSCRIPT_WINDOW);
  const draftRef = useRef(ctx.draft);
  const draftThreadRef = useRef(null);
  const restoringDraftRef = useRef(false);

  // Track the live draft so a thread switch can stash it for the outgoing
  // thread before the incoming thread's saved draft loads.
  useEffect(() => { draftRef.current = ctx.draft; });

  // Per-thread draft persistence: on a thread change, stash the outgoing
  // draft under the old key and restore the incoming thread's saved draft.
  // A non-empty live draft (e.g. pre-filled by another surface) always wins.
  useEffect(() => {
    const nextId = activeThreadId || null;
    if (draftThreadRef.current === nextId) return undefined;
    const storage = globalThis.localStorage;
    if (draftThreadRef.current) writeDraft(storage, draftThreadRef.current, draftRef.current);
    draftThreadRef.current = nextId;
    if (!nextId) return undefined;
    const stored = readDraft(storage, nextId);
    const current = draftRef.current;
    if (current.trim() && current !== stored) {
      writeDraft(storage, nextId, current);
    } else if (stored !== current) {
      restoringDraftRef.current = true;
      ctx.setDraft(stored);
    }
    return undefined;
  }, [activeThreadId]);

  // Continuous persistence — a send clears the draft, which removes the key.
  useEffect(() => {
    const id = draftThreadRef.current;
    if (!id) return;
    if (restoringDraftRef.current) { restoringDraftRef.current = false; return; }
    writeDraft(globalThis.localStorage, id, ctx.draft);
  }, [ctx.draft]);

  // Transcript floor (~160px of reading height): when the window is too short
  // to afford it, the secondary rails collapse on the transition edge — they
  // never fight the user's own toggles continuously.
  useEffect(() => {
    const node = surfaceRef.current;
    if (!node || typeof ResizeObserver !== "function") return undefined;
    const observer = new ResizeObserver((entries) => {
      const height = entries[0]?.contentRect?.height;
      if (Number.isFinite(height) && height > 0) setFloorSqueezed(height < 400);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!floorSqueezed) return;
    if (ctx.inspectorOpen) ctx.setInspectorOpen(false);
    if (!ctx.planCollapsed) ctx.setPlanCollapsed(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- edge-triggered rail collapse
  }, [floorSqueezed]);

  // Unread tracking: when the user scrolls up mid-stream, pin the divider at
  // the first message that arrived after they left the bottom and count every
  // new transcript row (messages + host events) until they jump back.
  useEffect(() => { setUnread({ anchor: null, base: 0, count: 0 }); setRenderedCount(TRANSCRIPT_WINDOW); }, [activeThreadId]);

  // Edit & resend: load the message into the composer draft and focus it.
  const handleEditMessage = useCallback((message) => {
    ctx.setDraft(String(message?.content || ""));
    surfaceRef.current?.querySelector?.(".chat-compose textarea")?.focus?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setDraft is a stable setState
  }, [ctx.setDraft]);

  function renderThreadBar() {
    const activeThread = (ctx.threadRegistry.threads || []).find((item) => item.id === activeThreadId);
    const openThreads = (ctx.threadRegistry.threads || []).filter((item) => item.status !== "archived");
    const archivedThreads = (ctx.threadRegistry.threads || []).filter((item) => item.status === "archived");
    const renderThreadRow = (thread) => (
      <div className={`thread-row-wrap ${thread.id === activeThreadId ? "is-active" : ""}`} key={thread.id}>
        {ctx.renamingThreadId === thread.id ? (
          <form className="thread-row thread-rename" onSubmit={(event) => { event.preventDefault(); void ctx.commitThreadRename(thread.id); }}>
            <input value={ctx.renameDraft} onChange={(event) => ctx.setRenameDraft(event.target.value)} autoFocus aria-label="Thread name" onKeyDown={(event) => { if (event.key === "Escape") { ctx.setRenamingThreadId(null); ctx.setRenameDraft(""); } }} />
            <button type="submit" className="thread-rename-save">Save</button>
          </form>
        ) : (
          <>
            <button type="button" className="thread-row" aria-current={thread.id === activeThreadId ? "true" : undefined} onClick={() => void ctx.switchThread(thread.id)}>
              <span><strong>{displayText(thread.title)}</strong><small>{formatRelativeTime(thread.updatedAt || thread.lastOpenedAt)}{thread.workspaceRoot ? ` · ${displayText(thread.workspaceRoot)}` : ""} · {displayText(thread.provider, "maple")}</small></span>
              <StatusLamp state={thread.status === "running" ? "working" : thread.status === "blocked" ? "down" : "ready"} label={displayText(thread.status, "ready")} />
            </button>
            <span className="thread-row-actions">
              <button type="button" title="Rename thread" aria-label={`Rename ${displayText(thread.title)}`} onClick={() => ctx.startThreadRename(thread.id, thread.title)}><Icon name="pencil" size={12} /></button>
              <button type="button" title="Archive thread" aria-label={`Archive ${displayText(thread.title)}`} onClick={() => void ctx.archiveThread(thread.id)}><Icon name="archive" size={12} /></button>
            </span>
          </>
        )}
      </div>
    );
    return <section className="thread-bar" aria-label="Hemlock threads"><div className="thread-bar-main"><button type="button" className="thread-switcher" onClick={() => ctx.setThreadPickerOpen((value) => !value)} aria-expanded={ctx.threadPickerOpen}><Icon name="chat" size={14} /><span className="thread-context-label">{ctx.interactionMode === "build" ? "Build context" : "Conversation context"}</span><span className="thread-context-copy"><strong>{displayText(ctx.task.objective || activeThread?.title || "Hemlock thread")}</strong><small>{displayText(activeThread?.workspaceRoot || ctx.task.workspaceRoot || "No project directory")}</small></span><StatusLamp state={ctx.task.status === "running" ? "working" : ctx.task.status === "blocked" ? "down" : "ready"} label={displayText(ctx.task.status, "ready")} /><Icon name="chevron" size={12} /></button><button type="button" className="quiet-action" disabled={!ctx.isDesktop} title={!ctx.isDesktop ? "Open the Hemlock desktop app to create and save threads" : "Create a new thread"} onClick={() => void ctx.createThread()}><Icon name="plus" size={13} /> {ctx.isDesktop ? "New thread" : "Desktop threads"}</button></div>{ctx.threadPickerOpen && <div className="thread-popover" role="dialog" aria-label="Thread list"><div className="thread-popover-heading"><span>THREADS</span><button type="button" onClick={() => void ctx.refreshThreadRegistry()}><Icon name="refresh" size={12} /> Refresh</button></div>{openThreads.map(renderThreadRow)}{!openThreads.length && <p className="empty-copy">{ctx.isDesktop ? "No open threads. Create one to start a fresh conversation." : "Saved threads are available in the Hemlock desktop app."}</p>}{archivedThreads.length > 0 && <details className="thread-archived"><summary>Archived ({archivedThreads.length})</summary>
{archivedThreads.map((thread) => <div className="thread-row-wrap is-archived" key={thread.id}><button type="button" className="thread-row" onClick={() => void ctx.restoreThread(thread.id)}><span><strong>{displayText(thread.title)}</strong><small>archived {formatRelativeTime(thread.archivedAt)} · select to restore</small></span></button><span className="thread-row-actions"><button type="button" title="Restore thread" aria-label={`Restore ${displayText(thread.title)}`} onClick={() => void ctx.restoreThread(thread.id)}><Icon name="refresh" size={12} /></button></span></div>)}</details>}</div>}</section>;
  }

  function renderSuggestionCards() {
    const visible = ctx.suggestions.filter((item) => item.status === "unread").slice().reverse().slice(0, 4);
    if (!visible.length) return null;
    return <section className="suggestion-stack" aria-label="Hemlock suggestions"><div className="card-kicker"><span>HEMLOCK SUGGESTIONS{visible.length > 1 ? ` · ${visible.length}` : ""}</span><small>host-generated · never runs automatically</small></div>{visible.map((suggestion) => <article className="suggestion-card" key={suggestion.suggestionId}><div><strong>{displayText(suggestion.title)}</strong><p>{displayText(suggestion.summary)}</p><small>{displayText(suggestion.reason)}</small>{suggestion.recommendedAction?.command && <em className="suggestion-recommended">suggests: {displayText(String(suggestion.recommendedAction.command).replaceAll(".", " · "))}</em>}{suggestion.evidenceRefs?.[0] && <code>{displayText(suggestion.evidenceRefs[0])}</code>}</div><div className="suggestion-actions"><button type="button" onClick={() => void ctx.transitionSuggestion(suggestion, "accepted")}>Review / act</button><button type="button" className="quiet-action" onClick={() => void ctx.transitionSuggestion(suggestion, "snoozed")}>Snooze</button><button type="button" className="quiet-action" onClick={() => void ctx.transitionSuggestion(suggestion, "dismissed")}>Dismiss</button></div></article>)}</section>;
  }

    const taskEvents = ctx.events.filter((event) => event.taskId === ctx.task.id || event.payload?.taskId === ctx.task.id || event.payload?.task?.id === ctx.task.id);
    const workNotes = taskEvents.map((event) => ({ event, note: conciseAgentNote(event, ctx.task) })).filter((item) => item.note).slice(-12);
    // Live panel covers BOTH stream kinds (T7-S1): conversational replies and
    // the resumed structured-action loop after you answer a question. Silent
    // host work is not acceptable — watch the model think either way.
    const liveStreams = ctx.streamFrames.filter((stream) => (stream.kind === "model_text" || stream.kind === "agent_action") && !stream.terminal && !TERMINAL_STREAM_STATUSES.has(stream.status));
    const plans = (ctx.agentProjection?.plans || []).filter((plan) => plan.taskId === ctx.task.id);
    const planFromEvents = taskEvents.slice().reverse().map((event) => event.payload?.plan).find(Boolean) || null;
    const activePlan = plans.find((plan) => plan.id === ctx.task.activePlanId) || planFromEvents || plans.at(-1) || null;
    const actions = (ctx.agentProjection?.actions || []).filter((action) => action.taskId === ctx.task.id);
    const activeAction = actions.find((action) => action.id === ctx.task.activeActionId) || actions.filter((action) => !["completed", "failed", "cancelled", "blocked", "rejected"].includes(action.status)).at(-1) || actions.at(-1) || null;
    const latestActionEvent = taskEvents.filter((event) => event.type.startsWith("action.") || event.type.startsWith("command.")).at(-1) || null;
    const latestObservation = (ctx.agentProjection?.observations || []).filter((observation) => observation.taskId === ctx.task.id).at(-1) || null;
    const planNeedsApproval = Boolean(activePlan?.status === "proposed" && ctx.task.status === "waiting_for_approval");
    const planStateMissing = Boolean(ctx.task.status === "waiting_for_approval" && ctx.task.activePlanId && !activePlan);
    const planIsApproved = activePlan?.status === "approved";
    // T7-S3: grantable budgets — stepper values fall back to host defaults for
    // any plan the user has not touched yet, and overrides ride plan.approve.
    const budgetGrantActive = ctx.budgetGrant.planId === activePlan?.id;
    const grantSteps = budgetGrantActive ? ctx.budgetGrant.steps : 8;
    const grantCommands = budgetGrantActive ? ctx.budgetGrant.commands : 12;
    const setGrantSteps = (value) => ctx.setBudgetGrant({ planId: activePlan?.id || null, steps: Math.min(24, Math.max(1, value)), commands: grantCommands });
    const setGrantCommands = (value) => ctx.setBudgetGrant({ planId: activePlan?.id || null, steps: grantSteps, commands: Math.min(40, Math.max(1, value)) });
    const grantOverrides = grantSteps !== 8 || grantCommands !== 12
      ? { ...(grantSteps !== 8 && { maxAgentSteps: grantSteps }), ...(grantCommands !== 12 && { maxCommands: grantCommands }) }
      : null;
    const budgetUsage = ctx.task.status === "running" && ctx.task.budget
      ? `steps ${ctx.task.budget.agentStepsUsed || 0}/${ctx.task.budget.maxAgentSteps || 8} · commands ${ctx.task.budget.commandsUsed || 0}/${ctx.task.budget.maxCommands || 12}`
      : null;
    const evidenceRefs = planNeedsApproval || planStateMissing ? [] : [...new Set([...(latestObservation?.evidenceRefs || []), ...(latestActionEvent?.evidenceRefs || []), ...(ctx.task.evidenceRefs || [])].filter(Boolean))];
    const evidenceStatus = planNeedsApproval || planStateMissing ? "waiting" : latestObservation?.status || latestActionEvent?.status || "waiting";
    const evidenceSummary = planNeedsApproval
      ? "No command or preview verification has run. Hemlock is waiting for your plan approval."
      : planStateMissing
        ? "The task requires approval, but its durable plan is not loaded in this window. Refresh task state before acting."
        : latestObservation?.summary || latestActionEvent?.payload?.reason || "Authoritative observations and receipts will collect here.";
    const modelActivity = liveStreams.length ? "streaming" : ctx.task.status === "waiting_for_approval" && !planIsApproved ? "idle · approval required" : ctx.task.status === "running" ? "working" : ctx.task.status || "idle";
    const taskActive = ACTIVE_TASK_STATUSES.has(ctx.task.status);
    const autonomyLabel = AUTONOMY_LABELS[ctx.task.autonomy] || null;
    const objective = displayText(ctx.task.objective, "Untitled Hemlock task");
    const objectiveIsLong = objective.length >= 120;
    const objectiveSummary = objectiveIsLong ? compactPreview(objective) : objective;
    const liveStream = liveStreams.at(-1) || null;
    const liveStreamRate = formatTokensPerSecond(liveStream?.usage, liveStream?.startedAt ? Date.now() - new Date(liveStream.startedAt).getTime() : null);
    // Interleaved transcript: durable host events land between dated messages
    // (taskless events like dream.* / inference.failed are session-wide).
    const timeline = buildTranscriptTimeline(ctx.messages, ctx.events, ctx.task.id);
    const timelineCount = timeline.before.length + timeline.tail.length + [...timeline.after.values()].reduce((sum, list) => sum + list.length, 0);
    // Plan step rail states mirror the orchestrator's own progression rule —
    // completed action count is the durable signal, not a parallel model.
    const completedSteps = actions.filter((action) => action.status === "completed").length;
    const stepStates = planStepStates(activePlan?.steps || [], completedSteps, { planStatus: activePlan?.status || "", taskStatus: ctx.task.status });
    const progress = planProgress(activePlan?.steps || [], completedSteps, activePlan?.status || "");

    // Transcript search: filters both messages and host-event rows by text and
    // row kind. Pure matching lives in transcriptSearch.js; rows are only ever
    // hidden, never reordered.
    const timelineEvents = [...timeline.before, ...timeline.tail, ...[...timeline.after.values()].flat()];
    const searchNeedle = normalizeQuery(searchQuery);
    const searchActive = searchOpen && (Boolean(searchNeedle) || searchKind !== "all");
    const searchResult = searchActive
      ? filterTranscript({ messages: ctx.messages, events: timelineEvents, query: searchNeedle, kind: searchKind, eventText: (event) => conciseAgentNote(event, ctx.task) })
      : null;
    const eventVisible = (event) => !searchResult || searchResult.eventIds.has(event.id ?? event);
    const messageVisible = (index) => !searchResult || searchResult.messageIndexes.has(index);
    // Highlighting follows the filter — a closed bar never leaves stray marks.
    const highlightQuery = searchActive ? searchNeedle : "";
    // Rows before windowStart stay unmounted. A search hit above the window
    // pulls the boundary up to the earliest match so results are never hidden.
    const hiddenByWindow = Math.max(0, ctx.messages.length - renderedCount);
    const earliestHit = searchResult?.messageIndexes?.size ? Math.min(...searchResult.messageIndexes) : null;
    const windowStart = earliestHit != null ? Math.min(hiddenByWindow, earliestHit) : hiddenByWindow;

    // Unread pill + divider: anchored to the first message that arrives after
    // the user scrolls away from the bottom; cleared when they jump back.
    const totalTranscriptItems = ctx.messages.length + timelineCount;
    useEffect(() => {
      setUnread((current) => {
        if (ctx.chatPinned) return current.anchor == null ? current : { anchor: null, base: 0, count: 0 };
        if (current.anchor == null) return { anchor: ctx.messages.length, base: totalTranscriptItems, count: 0 };
        const count = Math.max(0, totalTranscriptItems - current.base);
        return count === current.count ? current : { ...current, count };
      });
    }, [ctx.chatPinned, ctx.messages.length, totalTranscriptItems]);

    // Composer grammar: prefix hints mirror the host's parseInteractionMode;
    // slash commands are intercepted before submit so they never ship to the
    // model as an objective.
    const prefixHint = ctx.draft.trim().startsWith("/") ? null : prefixMode(ctx.draft);
    const handleSlashCommand = ({ name }) => {
      const command = resolveSlashCommand(name);
      if (!command) {
        setSlashNotice({ tone: "warn", text: `Unknown command /${name} — nothing was sent. Known commands: ${slashCommandList()}` });
        return;
      }
      ctx.setDraft("");
      if (command.kind === "window") { setSlashNotice(null); ctx.openWindow(command.windowId); return; }
      if (command.kind === "stop") {
        if (ctx.isThinking || liveStreams.length) { setSlashNotice(null); void ctx.stopGeneration(); }
        else setSlashNotice({ tone: "info", text: "Nothing is generating right now." });
        return;
      }
      if (command.kind === "retry") {
        if (ctx.isThinking || ctx.isDreaming) setSlashNotice({ tone: "info", text: "Wait for the current reply to settle before retrying." });
        else { setSlashNotice(null); ctx.stableRetryLast?.(); }
        return;
      }
      if (command.kind === "fresh-context") {
        if (typeof ctx.resetConversationContext === "function") {
          setSlashNotice(null);
          void ctx.resetConversationContext();
        } else {
          setSlashNotice({ tone: "info", text: "/clear archives this thread's context so the model starts fresh — run it from the command palette: ⌘K → “Fresh context”." });
        }
        return;
      }
      setSlashNotice({ tone: "info", text: "F1 opens the shortcut guide · ⌘K opens the command palette · prefixes steer: campaign: queue: choose how an intent is handled" });
    };
    const handleComposerSubmit = (event) => {
      const slash = parseSlashCommand(ctx.draft);
      if (slash) {
        event?.preventDefault();
        handleSlashCommand(slash);
        return;
      }
      setSlashNotice(null);
      void ctx.sendMessage(event);
    };

    const contextChip = contextStatus({ contextSnapshot: ctx.contextSnapshot, agentProjection: ctx.agentProjection });

    const serverDownWhileWaiting = ctx.isThinking && ctx.isDesktop && ctx.serverHealthProbe === false;
    // One honest DM Mono line above the composer: what the user is talking to.
    const composerModelLine = (() => {
      const optionLabel = ctx.selectedLane.modelOptions.find((option) => option.value === ctx.modelSelection.model)?.label || ctx.modelSelection.model || "";
      if (!optionLabel) return "local · ready";
      const laneLabel = ctx.selectedLane.kind === "local" ? "local lane" : `${ctx.selectedLane.label.toLowerCase()} lane`;
      const ceiling = `${Math.round(DEFAULT_MAPLE_MAX_TOKENS / 1024)}k ceiling`;
      const readiness = ctx.serverState === "ready" ? "ready" : ctx.serverState === "down" ? "server down" : "readiness unchecked";
      return `${optionLabel} · ${laneLabel} · ${ceiling} · ${readiness}`;
    })();
    // Context meter: last assistant reply reports what the host actually sent.
    const contextMeterState = contextMeter([...ctx.messages].reverse().find((item) => item.role === "assistant")?.telemetry);
    const evidenceRail = <details className="chat-evidence-rail" open={Boolean(evidenceRefs.length || ctx.task.status === "blocked")}><summary><GlossaryHint term="Receipts" definition="host-recorded evidence from validated actions and observations in this task." className="host-summary-label">EVIDENCE</GlossaryHint><span className={`host-summary-status host-summary-${evidenceStatus}`}>{displayText(evidenceStatus, "waiting")}</span><Icon name="chevron" size={12} /></summary><div className="chat-evidence-body"><p>{displayText(evidenceSummary)}</p>{evidenceRefs.length > 0 && <ul>{evidenceRefs.slice(0, 3).map((ref) => <li key={ref}>{displayText(ref)}</li>)}</ul>}{latestObservation?.outputDigest && <code>{latestObservation.outputDigest}</code>}{(ctx.task.blockedReason || latestActionEvent?.payload?.stopReason) && <p className="evidence-stop">Stop reason: {displayText(ctx.task.blockedReason || latestActionEvent.payload.stopReason)}</p>}{ctx.task.artifactRepair?.status === "exhausted" && <div className="repair-actions"><button type="button" onClick={() => void ctx.runCommand("artifact.repair.retry", { taskId: ctx.task.id })}>Retry repair</button>{ctx.task.artifactRepair?.lastGoodRevision && <button type="button" onClick={() => void ctx.runCommand("artifact.repair.use-last-good", { taskId: ctx.task.id })}>Use last good revision</button>}</div>}</div></details>;
    // Post-apply verification card (T6-V1): compact host-labeled block fed by
    // task.verification, which the main process pins after a conversational
    // code.apply runs its allowlisted verification profile.
    const verification = ctx.task.verification?.schema === "hemlock.agent.verification.v1" ? ctx.task.verification : null;
    const verificationCard = verification && <section className={`chat-verification-card is-${verification.status}`} aria-label="Post-apply verification"><div className="card-kicker"><span>VERIFICATION</span><small>{displayText(verification.status, "waiting")}</small></div>{verification.label && <strong>{displayText(verification.label)}</strong>}{verification.command && <code>{displayText(verification.command)}</code>}<div className="verification-meta"><small>{Number.isFinite(verification.durationMs) && verification.durationMs > 0 ? `${(verification.durationMs / 1000).toFixed(1)}s` : "duration n/a"}{verification.exitCode != null ? ` · exit ${verification.exitCode}` : ""}</small></div>{verification.reason && <p className="evidence-stop">{displayText(verification.reason)}</p>}{verification.outputTail && <details><summary>Output tail</summary><pre>{displayText(verification.outputTail)}</pre></details>}</section>;
    const hostActivity = <section className="chat-host-rail" aria-label="Host activity"><details className="chat-host-details" open={ctx.hostActivityOpen} onToggle={(event) => ctx.setHostActivityOpen(event.currentTarget.open)}><summary className="chat-host-summary"><span className="host-summary-label">HOST ACTIVITY</span><strong>{activeAction ? displayText(activeAction.commandId || activeAction.kind) : planNeedsApproval ? "Waiting for plan approval" : "No active action"}</strong><span className={`host-summary-status host-summary-${evidenceStatus}`}>{activeAction ? displayText(activeAction.status, "proposed") : displayText(evidenceStatus, "waiting")}</span><Icon name="chevron" size={12} /></summary><section className="live-task-surface"><div className="live-task-heading"><span>LIVE TASK</span><small>host detail beside {ctx.selectedLane.label} output</small></div><div className="live-task-grid"><section className="live-action-card"><div className="card-kicker"><span>LIVE ACTION</span><small>{displayText(activeAction?.status, planNeedsApproval ? "not started" : "idle")}</small></div>{activeAction ? <><strong>{displayText(activeAction.commandId || activeAction.kind)}</strong><p>{displayText(activeAction.shortRationale)}</p><details><summary>Exact validated action envelope</summary><pre>{displayText(activeAction, "No action envelope recorded.")}</pre></details>{(activeAction.modelChannels?.length || activeAction.rawModelOutputRef) && <details><summary>Raw provider output reference</summary><pre>{displayText({ rawModelOutputRef: activeAction.rawModelOutputRef, modelChannels: activeAction.modelChannels, parseStatus: activeAction.parseStatus, fallbackMode: activeAction.fallbackMode }, "No raw output reference.")}</pre></details>}</> : <p className="empty-copy">{planNeedsApproval ? `No model action has run yet. Approve the plan to let ${ctx.selectedLane.label} start choosing and streaming work.` : "No validated action is active. Casual conversation stays in Chat."}</p>}</section><section className="live-evidence-card"><div className="card-kicker"><span>EVIDENCE</span><small>{displayText(evidenceStatus, "waiting")}</small></div><p>{displayText(evidenceSummary)}</p>{latestObservation?.outputDigest && <code>{latestObservation.outputDigest}</code>}{evidenceRefs.length > 0 && <ul>{evidenceRefs.slice(0, 5).map((ref) => <li key={ref}>{displayText(ref)}</li>)}</ul>}{(ctx.task.blockedReason || latestActionEvent?.payload?.stopReason) && <p className="evidence-stop">Stop reason: {displayText(ctx.task.blockedReason || latestActionEvent.payload.stopReason)}</p>}{ctx.task.artifactRepair?.status === "exhausted" && <div className="repair-actions"><button type="button" onClick={() => void ctx.runCommand("artifact.repair.retry", { taskId: ctx.task.id })}>Retry repair</button>{ctx.task.artifactRepair?.lastGoodRevision && <button type="button" onClick={() => void ctx.runCommand("artifact.repair.use-last-good", { taskId: ctx.task.id })}>Use last good revision</button>}</div>}</section></div></section></details>{workNotes.length > 0 && <details className="host-trace" open={false}><summary>Full trace · decisions, tools, observations, repairs, and receipts</summary><div className="agent-notes-list">{workNotes.map(({ event, note }) => <div className={`agent-note agent-note-${event.status}`} key={event.id}><i /><span>{note}</span><time>{formatTime(event.createdAt)}</time></div>)}</div></details>}</section>;
    const groundingRecords = Array.isArray(ctx.sipsRecall?.records) ? ctx.sipsRecall.records.filter((record) => record && record.status === "active") : [];
    // T7-S1: answer-in-place. While the task waits on the user, Maple's
    // question renders verbatim above the plan dock; the answer persists as a
    // normal user message via task.answer and the card disappears on resume.
    const questionPrompt = ctx.task.phase === "waiting_for_user" ? displayText(ctx.task.question?.prompt || ctx.task.foregroundStep || "", "Maple needs your answer to continue.") : "";
    const questionCard = questionPrompt && <section className="chat-question-card is-awaiting" aria-label={`${ctx.selectedLane.label} asks you a question`}><div className="card-kicker"><span>{ctx.selectedLane.shortLabel} ASKS</span><StatusLamp state="working" label="ASKS YOU" /></div><strong className="chat-question-prompt">{questionPrompt}</strong><textarea value={ctx.answerDraft} onChange={(event) => ctx.setAnswerDraft(event.target.value)} placeholder={`Answer in place — ${ctx.selectedLane.label} resumes with your reply…`} rows="3" aria-label={`Answer ${ctx.selectedLane.label}'s question`} disabled={Boolean(ctx.commandBusy)} /><div className="chat-question-actions"><small>Your answer joins the thread history verbatim.</small><button type="button" className="primary-action" disabled={!ctx.answerDraft.trim() || Boolean(ctx.commandBusy)} onClick={() => { const answer = ctx.answerDraft.trim(); ctx.setAnswerDraft(""); void ctx.runCommand("task.answer", { taskId: ctx.task.id, answer }); }}>{ctx.commandBusy === "task.answer" ? "Sending…" : "Send answer"}</button></div></section>;
    const planCard = (activePlan || planStateMissing || ctx.task.status === "waiting_for_approval") && <section className={`chat-plan-card ${planNeedsApproval || planStateMissing ? "is-awaiting" : "is-approved"} ${ctx.planCollapsed ? "is-collapsed" : ""}`} aria-label="Plan and approval"><div className="chat-plan-heading"><div><span className="card-kicker">PLAN / APPROVAL</span><GlossaryHint as="strong" term="Bounded" definition="the agent may only run the bounded steps listed here — approving the plan is what approves the steps; nothing executes before that.">{planNeedsApproval ? `Review before ${ctx.selectedLane.label} starts` : planStateMissing ? "Plan state needs refresh" : "Bounded plan"}</GlossaryHint></div><div className="chat-plan-heading-actions">{autonomyLabel && <span className={`autonomy-badge${ctx.task.autonomy === "bounded-campaign" ? " is-campaign" : ""}`} title="Host-recorded autonomy for this task">{autonomyLabel}</span>}<StatusLamp state={planNeedsApproval || planStateMissing ? "working" : "ready"} label={planNeedsApproval ? "waiting for approval" : planStateMissing ? "not loaded" : activePlan?.status || "ready"} />{activePlan && <button type="button" className={`plan-collapse-toggle ${ctx.planCollapsed ? "is-collapsed" : ""}`} onClick={() => ctx.setPlanCollapsed((value) => !value)} aria-expanded={!ctx.planCollapsed} aria-controls="hemlock-plan-body"><Icon name="chevron" size={14} /> <span>{ctx.planCollapsed ? "Expand plan" : "Collapse plan"}</span></button>}</div></div>{activePlan ? <><div id="hemlock-plan-body" className="chat-plan-scroll" hidden={ctx.planCollapsed}><div className="chat-plan-meta"><GlossaryHint term="Bounded" definition="only these allowlisted, host-prepared steps can run — no source mutation outside them.">HOST-PREPARED CAPABILITY BOUNDARY</GlossaryHint><small>{activePlan.steps?.length || 0} steps · {progress && progress.done > 0 ? `${progress.done} completed with receipts` : "no source mutation has run"}</small></div><p className="chat-plan-rationale">{displayText(activePlan.rationale, "Hemlock prepared this bounded plan from the request.")}</p>{progress && <div className="chat-plan-progress" role="progressbar" aria-valuenow={progress.done} aria-valuemin={0} aria-valuemax={progress.total} aria-label={`Plan progress — ${progress.label}`}><i style={{ "--plan-fill": progress.ratio }} /><em>{progress.label}</em></div>}<ol className="chat-plan-steps">{(activePlan.steps || []).map((step, index) => { const state = stepStates[index] || "queued"; const chips = inputContract(step.input, { max: 2, valueLength: 30 }); return <li key={`${activePlan.id}-${step.step}`} className={`is-${state}`}><span className="plan-step-node">{state === "done" || state === "current" || state === "blocked" ? <Icon name={state === "done" ? "check" : state === "blocked" ? "warning" : "pulse"} size={11} /> : <small>{step.step}</small>}</span><div><span className="plan-step-title"><strong>{displayText(step.label || step.commandId || step.kind)}</strong>{step.commandId && <code className="cmd-chip">{step.commandId}</code>}{step.adaptive && <em className="adaptive-chip" title={step.selectionReason || "Inserted by bounded adaptive selection"}>adaptive</em>}{chips.map((chip) => <code key={chip.key} className="input-chip">{chip.key}={chip.value}</code>)}</span><small>{displayText(step.expectedEvidence?.join?.(" · ") || "Host receipt after this step")}</small></div></li>; })}</ol>{activePlan.lastAdaptiveDecision && <p className="chat-plan-adapted"><Icon name="pulse" size={11} /> Adapted at step {activePlan.lastAdaptiveDecision.atStep}: <code className="cmd-chip">{activePlan.lastAdaptiveDecision.commandId}</code>{activePlan.lastAdaptiveDecision.reason ? ` · ${displayText(activePlan.lastAdaptiveDecision.reason)}` : ""}</p>}{budgetUsage && <p className="budget-usage" aria-label="Budget usage">{budgetUsage}</p>}<p className="chat-plan-boundary"><strong>{planNeedsApproval ? "Maple has not run yet." : planIsApproved ? "Maple is free to choose the next useful action inside this approved boundary." : "The host has not claimed work outside this plan."}</strong> Safeguards still own scope, approvals, verification, and completion.</p></div>{planNeedsApproval && <div className="chat-plan-actions"><div className="budget-stepper" role="group" aria-label="Grantable budgets"><small>steps</small><button type="button" aria-label="Fewer steps" onClick={() => setGrantSteps(grantSteps - 1)} disabled={grantSteps <= 1}>−</button><strong>{grantSteps}</strong><button type="button" aria-label="More steps" onClick={() => setGrantSteps(grantSteps + 1)} disabled={grantSteps >= 24}>+</button><small>commands</small><button type="button" aria-label="Fewer commands" onClick={() => setGrantCommands(grantCommands - 1)} disabled={grantCommands <= 1}>−</button><strong>{grantCommands}</strong><button type="button" aria-label="More commands" onClick={() => setGrantCommands(grantCommands + 1)} disabled={grantCommands >= 40}>+</button></div><button type="button" className="primary-action" onClick={() => void ctx.runCommand("plan.approve", { taskId: ctx.task.id, planId: activePlan.id, ...(grantOverrides ? { budgetOverrides: grantOverrides } : {}) })} disabled={Boolean(ctx.commandBusy)}><Icon name="check" size={14} /> {ctx.commandBusy === "plan.approve" ? "Approving…" : "Approve plan"}</button><button type="button" className="quiet-action" onClick={() => void ctx.runCommand("plan.reject", { taskId: ctx.task.id, planId: activePlan.id, reason: "Plan rejected from Chat" })} disabled={Boolean(ctx.commandBusy)}>Reject</button></div>}</> : <><p className="chat-plan-rationale">{evidenceSummary}</p><div className="chat-plan-actions"><button type="button" className="primary-action" onClick={() => void ctx.refreshAgentState()} disabled={ctx.commandBusy === "agent.state"}><Icon name="refresh" size={14} /> {ctx.commandBusy === "agent.state" ? "Refreshing…" : "Refresh task state"}</button></div></>}</section>;
    const groundingCount = groundingRecords.length;
    const groundingChip = groundingCount > 0 && <span className="grounding-wrap"><button type="button" className="grounding-chip" aria-expanded={ctx.groundingPopoverOpen} onClick={() => ctx.setGroundingPopoverOpen((open) => !open)} title="Promoted memories injected into this reply's context — rate them useful or not relevant">grounding · {groundingCount}</button>{ctx.groundingPopoverOpen && <div className="grounding-popover" role="group" aria-label="Injected memory usefulness feedback"><span className="grounding-popover-heading">INJECTED MEMORIES</span>{groundingRecords.map((record) => <div className="grounding-record" key={record.id}><span className="grounding-record-title" title={displayText(record.title, record.id)}>{displayText(record.title, record.id)}</span><span className="grounding-record-actions"><button type="button" disabled={ctx.groundingBusyId === record.id} onClick={() => void ctx.sendGroundingFeedback(record, "useful")} aria-label={`Mark ${displayText(record.title, record.id)} useful`}>useful</button><button type="button" disabled={ctx.groundingBusyId === record.id} onClick={() => void ctx.sendGroundingFeedback(record, "irrelevant")} aria-label={`Mark ${displayText(record.title, record.id)} not relevant`}>not relevant</button></span></div>)}<button type="button" className="grounding-garden-link" onClick={() => { ctx.setGroundingPopoverOpen(false); ctx.openWindow("memory"); }}>Open Memory Garden</button></div>}</span>;
    const chatStatusBar = <div className="chat-status-bar" aria-label="Chat status"><StatusLamp state={ctx.task.status === "running" || ctx.task.phase === "waiting_for_user" || liveStreams.length ? "working" : ctx.task.status === "blocked" ? "down" : "ready"} label={ctx.task.status === "running" ? "WORKING" : ctx.task.phase === "waiting_for_user" ? "ASKS YOU" : displayText(ctx.task.status, "READY")} /><span>{ctx.messages.length ? `${ctx.messages.at(-1)?.role === "user" ? "You" : MODEL_LANES[ctx.messages.at(-1)?.provider || ctx.modelSelection.provider]?.shortLabel || "MODEL"} ${displayText(ctx.messages.at(-1)?.time, formatTime())}` : "Ready"}</span><span>{liveStreams.length ? `${ctx.selectedLane.label} (live) · ${liveStreamRate}` : (() => { const lastAssistant = [...ctx.messages].reverse().find((item) => item.role === "assistant" && item.telemetry?.completionTokens != null); return lastAssistant ? `${ctx.selectedLane.label} · ${lastAssistant.telemetry.completionTokens} tokens last reply` : ctx.selectedLane.label; })()}</span>{groundingChip}{contextChip && <button type="button" className="context-stale-chip" title={displayText(contextChip.title)} onClick={() => ctx.openWindow("settings")}><Icon name="warning" size={11} /> {displayText(contextChip.label)}</button>}{autonomyLabel && <span>autonomy · {autonomyLabel}</span>}<span>{ctx.isDesktop ? "Electron runtime" : "Browser preview"}</span></div>;
    const lastAssistantReply = [...ctx.messages].reverse().find((message) => message.role === "assistant") || null;
    const laneComparison = ctx.task.comparison?.schema === "hemlock.agent.comparison.v1" ? ctx.task.comparison : null;
    const showLaneCompare = Boolean(laneComparison && ctx.compareDismissedAt !== laneComparison.ranAt);
    return <div ref={surfaceRef} onKeyDown={(event) => {
      // ⌘F scopes to the chat window only — the handler lives on this subtree,
      // so it cannot hijack find-in-page while another window owns focus.
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "f") { event.preventDefault(); setSearchOpen(true); }
    }} className={`chat-surface${ctx.interactionMode === "build" ? " is-build" : ""}${!ctx.inspectorOpen ? " is-inspector-hidden" : ""}${ctx.task.phase === "waiting_for_user" && questionPrompt ? " is-asking" : ""}${floorSqueezed ? " is-floor-squeezed" : ""}`}>
      {renderThreadBar()}
      {searchOpen && <div className="chat-search-bar" role="search" onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); if (searchQuery || searchKind !== "all") { setSearchQuery(""); setSearchKind("all"); } else { setSearchOpen(false); } } }}>
        <Icon name="search" size={13} />
        <input type="search" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Filter messages and host events…" aria-label="Filter transcript" autoFocus />
        <span className="chat-search-kinds" role="group" aria-label="Filter by row type">{SEARCH_KINDS.map((kind) => <button key={kind} type="button" className={searchKind === kind ? "is-selected" : ""} aria-pressed={searchKind === kind} onClick={() => setSearchKind(kind)}>{kind === "all" ? "All" : kind === "you" ? "You" : kind === "model" ? "Model" : "Host"}</button>)}</span>
        <span className="chat-search-count" aria-live="polite">{searchResult ? `${searchResult.total} match${searchResult.total === 1 ? "" : "es"}` : `${totalTranscriptItems} rows`}</span>
        <button type="button" aria-label="Close transcript filter" onClick={() => { setSearchOpen(false); setSearchQuery(""); setSearchKind("all"); }}><Icon name="close" size={14} /></button>
      </div>}
      {ctx.error && (() => { const friendly = friendlyError(ctx.error); return <div className="runtime-alert chat-error" role="alert"><Icon name="warning" size={15} /><span className="error-friendly-line">{displayText(friendly.line)}{friendly.hint ? ` ${displayText(friendly.hint)}` : ""}</span><details className="error-details"><summary>Details</summary><pre>{displayText(friendly.detail)}</pre><CopyMessageButton text={friendly.detail} /></details><button type="button" className="error-dismiss" onClick={() => ctx.setError("")} aria-label="Dismiss error"><Icon name="close" size={16} /></button></div>; })()}
      <div className="surface-intro chat-task-header"><div><span className="eyebrow">TASK STREAM <span className="browser-boundary">{ctx.isDesktop ? "ELECTRON RUNTIME" : "BROWSER VISUAL PREVIEW"}</span></span><details className="objective-collapse" open={!objectiveIsLong}><summary className="chat-context-summary"><span className="chat-context-label">{ctx.interactionMode === "build" ? "BUILD CONTEXT" : "CONVERSATION CONTEXT"}</span><span>{objectiveSummary}</span></summary>{objectiveIsLong && <p className="objective-full">{objective}</p>}<p>{MODEL_LANES[ctx.modelSelection.provider].label} output stays verbatim; host actions and evidence stay beside it.</p></details></div><StatusLamp state={hasLiveStream(liveStreams) || ctx.task.status === "running" ? "working" : ctx.task.status === "blocked" ? "down" : "ready"} label={modelActivity} /></div>
      {renderSuggestionCards()}
      {(ctx.queueState?.pending?.length || liveStreams.length) > 0 && <div className="chat-activity-strip"><span>{liveStreams.length ? "LIVE RESPONSE" : "QUEUE"}</span><strong>{liveStreams.length ? `${Math.round((liveStreams.at(-1)?.text || "").length)} chars received` : `${ctx.queueState?.pending?.length || 0} waiting`}</strong>{ctx.queueState?.pending?.slice(0, 2).map((entry) => <button key={entry.id} type="button" aria-label={`Cancel queued request: ${displayText(entry.payload?.objective || entry.payload?.text)}`} title="Cancel this queued request" onClick={() => void ctx.cancelQueuedIntent(entry.requestId)}>{entry.position}. {displayText(entry.payload?.objective || entry.payload?.text)}</button>)}</div>}
      {showLaneCompare && (() => { const comparisonLane = MODEL_LANES[laneComparison.targetProvider] || MODEL_LANES.maple; const currentTelemetry = lastAssistantReply?.telemetry || null; const currentReplyText = lastAssistantReply?.content || (lastAssistantReply?.channels || []).find((channel) => channel.name === "content")?.text || ""; const pinnedPrompt = String(laneComparison.promptText || "").replace(/\s+/g, " ").trim(); const latestUserPrompt = ([...ctx.messages].reverse().find((message) => message.role === "user")?.content || "").replace(/\s+/g, " ").trim(); const promptSuperseded = Boolean(pinnedPrompt) && latestUserPrompt !== pinnedPrompt; return <section className="chat-compare" aria-label="Model lane comparison"><div className="chat-compare-heading"><span className="card-kicker">LANE COMPARE</span><small>same prompt · both replies verbatim</small><button type="button" className="quiet-action" onClick={() => ctx.setCompareDismissedAt(laneComparison.ranAt)}>Dismiss</button></div>{pinnedPrompt && <div className="chat-compare-prompt" title={pinnedPrompt}><small>PROMPT PINNED</small><code>{compactPreview(pinnedPrompt, 120)}</code>{promptSuperseded && <small className="chat-compare-stale">prompt since superseded</small>}</div>}<div className="chat-compare-grid"><div className="chat-compare-column"><span className="chat-compare-label">{ctx.selectedLane.shortLabel} · CURRENT LANE</span>{currentTelemetry && <small>{formatTokensPerSecond(currentTelemetry, currentTelemetry.elapsedMs)}</small>}<pre>{displayText(currentReplyText, "No assistant reply in this thread yet.")}</pre></div><div className="chat-compare-column"><span className="chat-compare-label">{comparisonLane.shortLabel} · COMPARISON</span>{laneComparison.telemetry && <small>{formatTokensPerSecond(laneComparison.telemetry, laneComparison.telemetry.elapsedMs)}</small>}<pre>{displayText(laneComparison.answer, "(empty response)")}</pre></div></div></section>; })()}
      {questionCard}
      {planCard}
      <div className="chat-scroll">
      {!ctx.primerDismissed && <details className="chat-help-disclosure"><summary>How Hemlock keeps your work and evidence separate</summary><PrimerCard onDismiss={ctx.dismissPrimer} /></details>}

      {!ctx.messages.length && !workNotes.length && !timelineCount && <div className="empty-work"><span className="empty-symbol"><Icon name="leaf" size={26} /></span><h3>Start with {MODEL_LANES[ctx.modelSelection.provider].label}</h3><p>Conversation comes first. Exact model channels, live actions, and evidence will appear here as the task develops.</p></div>}
      {searchResult && searchResult.total === 0 && <div className="empty-work is-filtered"><p>No transcript rows match that filter.</p></div>}
      {timeline.before.filter(eventVisible).map((event) => <HostEventRow key={event.id} event={event} note={conciseAgentNote(event, ctx.task)} onOpenWindow={ctx.stableOpenWindow} highlight={highlightQuery} />)}
      {windowStart > 0 && <button type="button" className="chat-show-earlier" onClick={() => setRenderedCount((count) => count + TRANSCRIPT_WINDOW)}>Show earlier · {windowStart} hidden above</button>}
      {ctx.messages.slice(windowStart).map((message, offset) => { const messageIndex = windowStart + offset; return !messageVisible(messageIndex) ? null : <React.Fragment key={message.id}>{unread.anchor === messageIndex && !ctx.chatPinned ? <div className="unread-divider" role="separator"><span>new activity below</span></div> : null}<TranscriptMessageRow key={message.id} message={message} index={messageIndex} total={ctx.messages.length} isThinking={ctx.isThinking} reasoningOff={ctx.modelSelection.reasoning === "off"} threadId={activeThreadId} threadTitle={(ctx.threadRegistry.threads || []).find((item) => item.id === activeThreadId)?.title || ""} onRetry={ctx.stableRetryLast} onEdit={handleEditMessage} highlight={highlightQuery} />{(timeline.after.get(messageIndex) || []).filter(eventVisible).map((event) => <HostEventRow key={event.id} event={event} note={conciseAgentNote(event, ctx.task)} onOpenWindow={ctx.stableOpenWindow} highlight={highlightQuery} />)}</React.Fragment>; })}
      {timeline.tail.filter(eventVisible).map((event) => <HostEventRow key={event.id} event={event} note={conciseAgentNote(event, ctx.task)} onOpenWindow={ctx.stableOpenWindow} highlight={highlightQuery} />)}
      {liveStreams.length > 0 && <section className="chat-live-stream" aria-label="Live model stream" aria-live="polite"><div className="chat-live-stream-heading"><div><span className="card-kicker">LIVE MODEL STREAM</span><strong>{channelProviderName(liveStream?.provider || ctx.modelSelection.provider)} is working</strong></div><small>{Math.round((liveStream?.text || "").length)} chars{liveStreamRate !== "tok/s —" ? ` · ${liveStreamRate}` : ""} · {displayText(liveStream?.status, "streaming")}</small></div>{liveStreams.slice(-1).map((stream) => <div className="chat-live-stream-body" key={stream.streamId}>{Object.entries(stream.channels || {}).filter(([, text]) => text).map(([channel, text]) => <div className="chat-live-channel" key={`${stream.streamId}-${channel}`}><span>{displayText(channel, "content")}</span><pre>{text}</pre></div>)}</div>)}</section>}
      {!ctx.chatPinned && (unread.count > 0 || ctx.isThinking || liveStreams.length > 0) && <button type="button" className="chat-jump-latest" onClick={ctx.jumpToLatest}><Icon name="chevron" size={12} /> {unread.count > 0 ? `Jump to latest · ${unread.count} new` : "New activity"}</button>}
      {serverDownWhileWaiting ? <div className="live-note is-stalled"><span className="pulse" /> The local model server is not responding. Open Settings → Check local readiness, or restart Hemlock.</div> : ctx.isThinking && (() => { const liveFrame = liveStreams.at(-1) || null; const reasoningText = liveFrame?.channels?.reasoning || liveFrame?.channels?.reasoning_content || ""; const contentText = liveFrame?.channels?.content || ""; const reasoningTokens = reasoningText ? Math.round(reasoningText.length / 4) : 0; const phase = contentText ? "writing the answer" : reasoningTokens > 0 ? "thinking" : ctx.serverHealthProbe === null ? "loading model weights" : "warming up"; return <div className="live-note live-note-thinking"><span className="pulse" /> {ctx.selectedLane.label} is {phase}{ctx.serverHealthProbe === null && phase === "loading model weights" ? " — first load can take a moment" : ""}{ctx.thinkingElapsed != null ? <span className="thinking-timer">{ctx.thinkingElapsed < 60 ? `${ctx.thinkingElapsed}s` : `${Math.floor(ctx.thinkingElapsed / 60)}m ${ctx.thinkingElapsed % 60}s`}</span> : null}{reasoningTokens > 0 && !contentText ? <span className="thinking-reasoning-chars">{reasoningTokens} tokens reasoned</span> : null}<span className="thinking-dots" aria-hidden="true"><i /><i /><i /></span></div>; })()}
      <div ref={ctx.endRef} />
      </div>
      <aside id="hemlock-chat-inspector" className="chat-work-rail" aria-label="Hemlock work rail" hidden={!ctx.inspectorOpen}>
        <div className="chat-inspector-heading"><strong>Activity & evidence</strong><button type="button" onClick={() => { ctx.inspectorOpenerRef.current?.focus?.(); ctx.setInspectorOpen(false); }} aria-label="Close activity and evidence"><Icon name="close" size={15} /></button></div>
        {hostActivity}{verificationCard}{evidenceRail}
      </aside>
      <div className="chat-composer-area">
        {ctx.task.status === "blocked" && <div className="blocked-recovery" role="group" aria-label="Blocked task recovery">
          <Icon name="warning" size={13} />
          <span className="blocked-recovery-copy"><strong>Task blocked</strong>{ctx.task.blockedReason ? ` · ${displayText(compactPreview(ctx.task.blockedReason, 110))}` : ""}</span>
          <span className="blocked-recovery-actions">
            <button type="button" className="primary-action" title="Load the task objective into the composer to revise and send again" onClick={() => { ctx.setDraft(ctx.task.objective || ""); surfaceRef.current?.querySelector?.(".chat-compose textarea")?.focus?.(); }}><Icon name="pencil" size={12} /> Edit & resubmit</button>
            <button type="button" disabled={!ctx.isDesktop || Boolean(ctx.commandBusy)} title="Resume the approved plan from the blocked step" onClick={() => void ctx.runCommand("task.resume", { taskId: ctx.task.id })}><Icon name="retry" size={12} /> {ctx.commandBusy === "task.resume" ? "Retrying…" : "Retry step"}</button>
            <button type="button" onClick={() => ctx.openWindow("receipts")}><Icon name="receipt" size={12} /> Open receipts</button>
          </span>
        </div>}
        <div className="interaction-mode-bar" role="group" aria-label="Hemlock interaction mode">

          <button type="button" className={ctx.interactionMode === "explore" ? "is-selected" : ""} aria-pressed={ctx.interactionMode === "explore"} onClick={() => ctx.setInteractionMode("explore")}><Icon name="chat" size={13} /> Explore</button>
          <button type="button" className={ctx.interactionMode === "build" ? "is-selected" : ""} aria-pressed={ctx.interactionMode === "build"} onClick={() => ctx.setInteractionMode("build")} title="Review a plan before a build starts"><Icon name="artifact" size={13} /> Build</button>
          <span className="autonomy-divider" aria-hidden="true" />
          <button type="button" className={ctx.autonomyMode === "bounded-local" ? "is-selected" : ""} aria-pressed={ctx.autonomyMode === "bounded-local"} onClick={() => ctx.setAutonomyMode("bounded-local")} title="Every plan and explicit action waits for your approval">Supervised</button>
          <button type="button" className={ctx.autonomyMode === "guided" ? "is-selected" : ""} aria-pressed={ctx.autonomyMode === "guided"} onClick={() => ctx.setAutonomyMode("guided")} title="Plans auto-approve; sandboxed artifact and preview actions run without clicks">Guided</button>
          <button type="button" className={ctx.autonomyMode === "autonomous" ? "is-selected" : ""} aria-pressed={ctx.autonomyMode === "autonomous"} onClick={() => ctx.setAutonomyMode("autonomous")} title="Plans and all actions except training run autonomously; budgets still bind">Autonomous</button>
          {taskActive && <><span className="autonomy-divider" aria-hidden="true" />
            {ctx.task.status === "paused"
              ? <button type="button" className="task-flow-btn" onClick={() => void ctx.runCommand("task.resume", { taskId: ctx.task.id })} disabled={Boolean(ctx.commandBusy) || !ctx.isDesktop} title="Resume the approved plan from its parked boundary"><Icon name="play" size={12} /> Resume</button>
              : <button type="button" className="task-flow-btn" onClick={() => void ctx.runCommand("task.pause", { taskId: ctx.task.id })} disabled={Boolean(ctx.commandBusy) || !ctx.isDesktop} title="Park the task at the next step boundary — it keeps its queue slot"><Icon name="pause" size={12} /> Pause</button>}
            <button type="button" className="task-flow-btn" onClick={() => { ctx.setDraft((value) => { const trimmed = value.replace(/^steer\s*[:\-]\s*/i, "").trim(); return `steer: ${trimmed}`.trimEnd(); }); }} title="Redirect the active task — the host folds your note in at the next bounded decision"><Icon name="pencil" size={12} /> Steer</button>
          </>}
          <button type="button" className="chat-inspector-toggle" aria-pressed={searchOpen} onClick={() => { setSearchOpen((open) => { const next = !open; if (!next) { setSearchQuery(""); setSearchKind("all"); } return next; }); }} title="Filter the transcript · ⌘F"><Icon name="search" size={13} /> {searchOpen ? "Close find" : "Find"}</button>
          <button type="button" className="chat-inspector-toggle" aria-expanded={ctx.inspectorOpen} aria-controls="hemlock-chat-inspector" onClick={() => ctx.setInspectorOpen((open) => !open)}><Icon name="receipt" size={13} /> {ctx.inspectorOpen ? "Hide activity" : "Activity & evidence"}</button>
        </div>
        <details className="composer-details"><summary>Model & context</summary><div className="composer-model-line">{composerModelLine}{contextMeterState && <span className={`context-meter${contextMeterState.warn ? " is-warn" : ""}`} role="meter" aria-valuenow={contextMeterState.percent} aria-valuemin={0} aria-valuemax={100} aria-label="Prompt context budget used" title="Share of the bounded prompt budget the last reply used"><i style={{ "--meter-fill": `${contextMeterState.percent}%` }} /><span>{contextMeterState.label}</span></span>}</div></details>
        <form className="chat-compose" onSubmit={handleComposerSubmit}>
          <textarea value={ctx.draft} onChange={(event) => { ctx.setDraft(event.target.value); if (slashNotice) setSlashNotice(null); event.target.style.height = "auto"; event.target.style.height = `${Math.min(event.target.scrollHeight, 112)}px`; }} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void handleComposerSubmit(event); } }} placeholder={ctx.interactionMode === "build" ? "Describe the artifact to build…" : taskActive ? "steer: redirect the active task, or send a new message…" : "Message your model…"} rows="1" aria-label="Continue Hemlock task" aria-describedby="chat-compose-hint" disabled={ctx.isDreaming} />
          {(ctx.isThinking || liveStreams.length > 0) && <button type="button" className="stop-action" onClick={() => void ctx.stopGeneration()} disabled={ctx.cancelBusy}><Icon name="stop" size={14} /> {ctx.cancelBusy ? "Stopping…" : "Stop"}</button>}
          <button className="primary-action" type="submit" disabled={!ctx.draft.trim() || ctx.isDreaming || (!ctx.isDesktop && ctx.isThinking)}><Icon name="send" size={15} /> Send</button>
        </form>
        <div className="compose-hint" id="chat-compose-hint">
          {slashNotice && <span className={`slash-notice is-${slashNotice.tone}`} role={slashNotice.tone === "warn" ? "alert" : "status"}><Icon name={slashNotice.tone === "warn" ? "warning" : "info"} size={11} /> {displayText(slashNotice.text)}</span>}
          {prefixHint && !slashNotice && <span className="prefix-hint" role="note"><code>{displayText(prefixHint.prefix)}</code> {displayText(prefixHint.hint)}</span>}
          <span>Enter to send · Shift+Enter for a new line</span>
          <span>{taskActive ? "steer: redirects this task · campaign: starts an autonomous intent · /help lists commands" : "campaign: starts an autonomous intent · /help lists commands"}</span>
        </div>
      </div>
      {chatStatusBar}
    </div>;
  });
