import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../components/Icons.jsx";
import { GlossaryHint } from "./shared.jsx";
import { sourceFileNames, resolveActiveFile, fileStats, formatBytes, combinedSource } from "../sourceTabs.js";
import { tokenize, languageForFile } from "../syntaxTokens.js";
import { diffFiles } from "../artifactDiff.js";
import { displayArtifactTitle, evidenceFlags, revisionBadge } from "../artifactMeta.js";
import { pushNotice, dismissNotice } from "../noticeStack.js";
import { readStudioPrefs, writeStudioPrefs } from "../studioPrefs.js";
import { PALETTE_ACTIONS, HARNESS_ACTIONS, paletteAction, buildInteractInput, summarizeInteraction, isRenderableScreenshotRef } from "../previewPalette.js";

// Above this size highlighting costs more than it helps on a preview surface.
const HIGHLIGHT_LIMIT = 240000;
const DIFF_RENDER_LIMIT = 1500;

const SourceTokens = memo(function SourceTokens({ text, language }) {
  const tokens = useMemo(() => tokenize(text, language), [text, language]);
  return <>
    {tokens.map((token, index) => token.type === "text"
      ? <React.Fragment key={index}>{token.text}</React.Fragment>
      : <span key={index} className={`tok-${token.type}`}>{token.text}</span>)}
  </>;
});

const DiffLine = memo(function DiffLine({ op }) {
  const tone = op.type === "added" ? "is-added" : op.type === "removed" ? "is-removed" : "is-same";
  const sign = op.type === "added" ? "+" : op.type === "removed" ? "−" : " ";
  return <div className={`diff-line ${tone}`}>
    <span className="diff-num">{op.before || ""}</span>
    <span className="diff-num">{op.after || ""}</span>
    <span className="diff-sign">{sign}</span>
    <code>{op.text}</code>
  </div>;
});

const DiffFileBlock = memo(function DiffFileBlock({ file }) {
  const ops = file.ops.length > DIFF_RENDER_LIMIT ? file.ops.slice(0, DIFF_RENDER_LIMIT) : file.ops;
  return <details open={file.changed}>
    <summary>
      <code className="diff-file-name">{file.file}</code>
      {file.isNew
        ? <span className="diff-stat is-added">new file</span>
        : file.isDeleted
          ? <span className="diff-stat is-removed">deleted file</span>
          : file.changed
            ? <><span className="diff-stat is-added">+{file.added}</span><span className="diff-stat is-removed">−{file.removed}</span></>
            : <span className="diff-stat">unchanged</span>}
    </summary>
    <div className="diff-lines">
      {ops.map((op, index) => <DiffLine key={index} op={op} />)}
      {file.ops.length > ops.length && <div className="diff-line is-same"><span className="diff-num" /><span className="diff-num" /><span className="diff-sign">…</span><code>{file.ops.length - ops.length} more lines truncated for display</code></div>}
    </div>
  </details>;
});

const ConsoleLine = memo(function ConsoleLine({ line }) {
  return <div className={`console-line console-${line.level}`}>
    <time>{line.time}</time>
    <span className="console-level">{line.level}</span>
    <code>{line.message}</code>
  </div>;
});

const RevisionButton = memo(function RevisionButton({ revision, isCurrent, onRestore, onInfo }) {
  const badge = revisionBadge(revision);
  const tip = isCurrent
    ? `Current · ${badge.status}${badge.digest ? ` · ${badge.digest}` : ""}`
    : `Restore r${revision.revision} · ${badge.status}${badge.shortDigest ? ` · ${badge.shortDigest}` : ""}${badge.createdAt ? ` · ${badge.createdAt}` : ""}`;
  return <button
    type="button"
    className={isCurrent ? "is-selected" : ""}
    title={tip}
    onClick={() => (isCurrent ? onInfo(revision, badge) : onRestore(revision))}
  >
    <i className={`rev-dot rev-${badge.status}`} aria-hidden="true" />r{revision.revision}
  </button>;
});

// Artifact Studio: source/diff/preview/evidence panes for task artifacts.
// Extracted from main.jsx — App-scope values arrive through the ctx bag.
export const ArtifactStudio = memo(function ArtifactStudio({ ctx }) {
  const artifacts = Array.isArray(ctx.artifacts) ? ctx.artifacts : [];
  const artifact = ctx.artifact || artifacts.find((item) => item.id === ctx.activeArtifactId) || artifacts.at(-1) || null;
  const consoleLines = Array.isArray(ctx.previewConsoleLines) ? ctx.previewConsoleLines : [];
  const consoleErrorCount = consoleLines.filter((line) => line.level === "error").length;
  const revisionOptions = artifact?.revisions?.length ? artifact.revisions : [];

  const source = artifact?.source && typeof artifact.source === "object" ? artifact.source : {};
  const files = useMemo(() => sourceFileNames(source), [source]);
  const fileInfo = useMemo(() => Object.fromEntries(files.map((name) => [name, fileStats(source[name])])), [files, source]);

  const [fileChoices, setFileChoices] = useState({});
  const activeFile = resolveActiveFile(source, fileChoices[artifact?.id || ""], artifact?.entrypoint);
  const activeText = activeFile ? source[activeFile] : null;
  const activeLanguage = languageForFile(activeFile || artifact?.entrypoint || artifact?.kind);

  const [notices, setNotices] = useState([]);
  const [paletteActionId, setPaletteActionId] = useState("click");
  const [paletteValues, setPaletteValues] = useState({});
  const [lastInteraction, setLastInteraction] = useState(null);
  const [reviseSubmitted, setReviseSubmitted] = useState(false);
  const [studioOpBusy, setStudioOpBusy] = useState(false);
  const runStudioOp = useCallback(async (command, payload) => {
    if (studioOpBusy) return;
    setStudioOpBusy(true);
    try { await ctx.runArtifact?.(command, payload); }
    finally { setStudioOpBusy(false); }
  }, [ctx, studioOpBusy]);

  // Studio-originated notices are pushed locally (repeat-safe) and echoed to
  // the host channel; host-side notices (console traffic, blocked events)
  // arrive through the mirror effect below. selfNoticeRef prevents the mirror
  // from double-stacking our own messages.
  const selfNoticeRef = useRef("");
  const notify = useCallback((text, tone = "info") => {
    const message = String(text || "").trim();
    if (!message) return;
    selfNoticeRef.current = message;
    setNotices((current) => pushNotice(current, { text: message, tone }));
    if (typeof ctx.setPreviewNotice === "function") ctx.setPreviewNotice(message);
  }, [ctx.setPreviewNotice]);

  // Mirror the host notice channel into the durable stack so console traffic
  // can no longer erase action feedback.
  useEffect(() => {
    if (!ctx.previewNotice || ctx.previewNotice === selfNoticeRef.current) return;
    setNotices((current) => pushNotice(current, { text: ctx.previewNotice }));
  }, [ctx.previewNotice]);

  // Persisted studio layout: main.jsx already round-trips the panel fractions
  // (hemlock-artifact-layout-v1); here we keep view + viewport + fractions
  // together under hemlock.artifact.layout and restore what ctx exposes.
  const restoredPrefsRef = useRef(false);
  useEffect(() => {
    if (restoredPrefsRef.current) return;
    restoredPrefsRef.current = true;
    const prefs = readStudioPrefs(typeof window !== "undefined" ? window.localStorage : null);
    if (prefs.artifactView && prefs.artifactView !== ctx.artifactView) ctx.setArtifactView?.(prefs.artifactView);
    if (prefs.previewViewport && prefs.previewViewport !== ctx.previewViewport) ctx.setPreviewViewport?.(prefs.previewViewport);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (typeof window === "undefined") return;
    writeStudioPrefs(window.localStorage, { artifactView: ctx.artifactView, previewViewport: ctx.previewViewport, layout: ctx.artifactLayout });
  }, [ctx.artifactView, ctx.previewViewport, ctx.artifactLayout]);

  const flags = useMemo(() => evidenceFlags(artifact), [artifact]);
  const showFallback = flags.fallbackIndex > -1 && flags.fallbackIndex > flags.repairedIndex;
  const showRepaired = flags.repairedIndex > -1 && flags.repairedIndex > flags.fallbackIndex;
  const waitingForApproval = reviseSubmitted && ctx.task?.status === "waiting_for_approval";

  const copyText = (text, label) => {
    void navigator.clipboard?.writeText(text).then(
      () => notify(`${label} copied · r${artifact?.revision || 1} · provenance: task-scoped draft, not repository code.`),
      () => notify("Clipboard is unavailable in this context — select the source text instead.", "warn"),
    );
  };

  const postToHarness = (action, input = {}) => {
    const frame = document.querySelector(".artifact-preview-frame");
    frame?.contentWindow?.postMessage({ source: "hemlock-preview", action, input }, "*");
  };

  const previewCommand = async (action, input = {}) => {
    const spec = paletteAction(action);
    if (!ctx.previewSession) {
      notify("Open a preview session before sending a registered preview command.", "warn");
      return null;
    }
    if (spec?.hostCommand) {
      const result = await ctx.runArtifact?.(spec.hostCommand, { sessionId: ctx.previewSession.id, reason: spec.reason });
      setLastInteraction({ text: action === "pause" ? "pause → agent input paused for this session" : "stop → preview session stopped", screenshotRef: null });
      notify(action === "pause" ? "Preview agent input paused — the session stays open." : "Preview session stopped.");
      return result;
    }
    if (spec?.harnessOnly) {
      postToHarness(action, input);
      notify(`Requested ${action} from the isolated preview harness.`);
      return null;
    }
    const request = ctx.runArtifact?.("preview.interact", { sessionId: ctx.previewSession.id, previewAction: action, ...input });
    if (HARNESS_ACTIONS.has(action)) postToHarness(action, input);
    const result = await request;
    const screenshotRef = result?.interaction?.screenshotRef || null;
    setLastInteraction({ text: summarizeInteraction(action, result), screenshotRef });
    notify(summarizeInteraction(action, result));
    return result;
  };

  const runPalette = (event) => {
    event.preventDefault();
    try {
      const input = buildInteractInput(paletteActionId, paletteValues);
      void previewCommand(paletteActionId, input);
    } catch (paletteError) {
      notify(paletteError.message, "warn");
    }
  };

  const sendErrorsToMaple = () => {
    const errors = consoleLines.filter((line) => line.level === "error").slice(-5);
    if (!errors.length) return;
    const list = errors.map((line) => `- ${String(line.message).slice(0, 200)}`).join("\n");
    ctx.setArtifactReviseDraft?.(`Fix the preview console errors in this artifact:\n${list}`.slice(0, 1400));
    notify("Error report drafted in the revision bar — review it, then press Revise with Maple.");
  };

  const submitRevision = (instruction) => {
    setReviseSubmitted(true);
    void ctx.reviseArtifactWithMaple?.(instruction);
  };

  const restoreRevision = (revision) => {
    void ctx.confirmDialog?.({
      title: `Restore revision r${revision.revision}?`,
      body: "The current source will be replaced by this revision.",
      confirmLabel: "Restore revision",
      tone: "danger",
    }).then((confirmed) => {
      if (confirmed) void ctx.runArtifact?.("restore", { artifactId: artifact.id, revision: revision.revision });
    });
  };

  const paletteSpec = paletteAction(paletteActionId) || PALETTE_ACTIONS[0];
  const displayTitle = displayArtifactTitle(artifact?.title);
  const compareResult = useMemo(() => (ctx.artifactCompare ? diffFiles(ctx.artifactCompare.files) : null), [ctx.artifactCompare]);

  return <div className="artifact-studio-surface">
    <div className="artifact-toolbar">
      <div>
        <span className="eyebrow"><Icon name="artifact" size={13} /> TASK-SCOPED ARTIFACT</span>
        <h2 title={artifact?.title || undefined}>{artifact ? displayTitle : "Artifact Studio"}</h2>
      </div>
      <div className="artifact-toolbar-actions">
        <button type="button" className="quiet-action" disabled={studioOpBusy} onClick={() => void runStudioOp("create", { artifactId: `artifact-${Date.now()}`, title: `Task artifact · ${new Date().toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`, kind: "html", entrypoint: "index.html", mime: "text/html" })}>New artifact</button>
        {artifact && !artifact.revision && <button type="button" className="quiet-action" disabled={studioOpBusy} onClick={() => void runStudioOp("author", { artifactId: artifact.id, kind: "html", filename: "index.html", runtimeTemplate: "html", objective: "Create an ambitious Eastern Hemlock night-garden single page", source: { "index.html": "<main data-preview-id=\"garden\"><h1>Eastern Hemlock Night Garden</h1><p>A living task-local draft.</p></main>" } })}>Author starter</button>}
        <span className={`artifact-status status-${artifact?.status || "drafting"}`}>{artifact?.status || "drafting"}</span>
        <button type="button" className="quiet-action" onClick={() => ctx.setArtifactFreeze?.((value) => !value)}>{ctx.artifactFreeze ? "Follow live" : "Freeze"}</button>
        <button type="button" className="quiet-action" onClick={() => ctx.setArtifactPinned?.((value) => !value)}>{ctx.artifactPinned ? "Unpin" : "Pin"}</button>
        <button type="button" className="quiet-action" onClick={() => ctx.setArtifactView?.("diff")} disabled={!artifact?.revision}>Compare revisions</button>
        <details className="artifact-more-menu">
          <summary className="quiet-action">More <Icon name="chevron" size={12} /></summary>
          <div className="artifact-more-panel" onClick={(event) => event.currentTarget.closest("details")?.removeAttribute("open")}>
            <button type="button" onClick={() => notify("Evidence is the Electron artifact manifest, revision digest, and preview interaction receipts.")}>Open evidence</button>
            <button type="button" onClick={() => ctx.setArtifactView?.("source")} disabled={!artifact?.revision}>Reveal source</button>
            <button type="button" onClick={() => void ctx.runArtifact?.("preview.open", { artifactId: artifact?.id })} disabled={!artifact?.revision}>Open preview</button>
            <button type="button" onClick={() => void ctx.runArtifact?.("preview.stop", { sessionId: ctx.previewSession?.id, reason: "agent_input_paused" })} disabled={!ctx.previewSession}>Pause agent input</button>
          </div>
        </details>
      </div>
    </div>

    {showFallback && <div className="artifact-banner artifact-banner-fallback" role="alert">
      <Icon name="warning" size={14} />
      <span><strong>Placeholder content</strong> — Maple's authoring didn't return usable source; this scaffold is host-generated.{flags.fallback?.reason ? ` ${flags.fallback.reason}` : ""}</span>
    </div>}
    {showRepaired && <div className="artifact-banner artifact-banner-repaired" role="status">
      <Icon name="info" size={13} />
      <span>Recovered via repair pass{flags.repaired?.reason ? ` — ${flags.repaired.reason}` : ""}.</span>
    </div>}

    {waitingForApproval && <div className="artifact-approval-chip" role="status">
      <Icon name="pause" size={12} />
      <span>Revision needs an approved plan step — artifact authoring runs inside the plan boundary, review in Chat.</span>
      <button type="button" onClick={() => ctx.openWindow?.("chat")}>Review in Chat</button>
    </div>}

    <div className="artifact-quick-asks">
      {["Add a dark mode toggle", "Polish spacing and typography", "Make it responsive on mobile"].map((ask) => (
        <button key={ask} type="button" disabled={!artifact || ctx.artifactReviseBusy || ctx.isThinking} onClick={() => submitRevision(ask)}>{ask}</button>
      ))}
    </div>

    <form className="artifact-revise-bar" onSubmit={(event) => { event.preventDefault(); submitRevision(ctx.artifactReviseDraft); }}>
      <Icon name="artifact" size={14} />
      <input value={ctx.artifactReviseDraft ?? ""} onChange={(event) => ctx.setArtifactReviseDraft?.(event.target.value)} placeholder={artifact ? "Tell Maple what to change in this artifact…" : "Create an artifact first, then direct Maple here."} aria-label="Artifact revision instruction for Maple" disabled={!artifact || ctx.artifactReviseBusy || ctx.isThinking} />
      {ctx.artifactReviseBusy
        ? <span className="artifact-revise-status"><span className="pulse" /> Maple is revising…</span>
        : <button className="primary-action" type="submit" disabled={!(ctx.artifactReviseDraft || "").trim() || !artifact || ctx.isThinking}>Revise with Maple</button>}
      {artifact?.revision ? <small>r{artifact.revision} · {artifact.status}</small> : null}
    </form>

    {notices.length > 0 && <div className="artifact-notice-stack" role="status" aria-live="polite">
      {notices.map((notice) => (
        <div key={notice.id} className={`artifact-notice notice-${notice.tone}`}>
          <span>{notice.text}{notice.count > 1 ? <em className="notice-count"> ×{notice.count}</em> : null}</span>
          <button type="button" aria-label="Dismiss notice" onClick={() => setNotices((current) => dismissNotice(current, notice.id))}><Icon name="close" size={10} /></button>
        </div>
      ))}
    </div>}

    <div className="artifact-revisions">
      <span>Revision</span>
      {revisionOptions.map((revision) => (
        <RevisionButton
          key={revision.id}
          revision={revision}
          isCurrent={revision.revision === artifact?.revision}
          onInfo={(record, badge) => notify(`Current revision r${record.revision} · ${badge.status} · ${record.digest}`)}
          onRestore={restoreRevision}
        />
      ))}
      <span className="artifact-layout-hint">Drag dividers · use arrows · scroll for all panels</span>
      {artifact?.digest && <small className="artifact-digest">{artifact.digest}</small>}
    </div>

    <div className="artifact-tabs" role="tablist" aria-label="Artifact Studio panes">
      {["source", "diff", "preview", "output", "inspect"].map((tab) => (
        <button key={tab} type="button" role="tab" aria-selected={ctx.artifactView === tab} className={ctx.artifactView === tab ? "is-selected" : ""} onClick={() => ctx.setArtifactView?.(tab)}>
          {tab === "source" ? "Source" : tab[0].toUpperCase() + tab.slice(1)}
          {tab === "output" && consoleErrorCount > 0 && <span className="console-error-badge" title={`${consoleErrorCount} preview console error${consoleErrorCount === 1 ? "" : "s"}`}>{consoleErrorCount}</span>}
        </button>
      ))}
    </div>

    <div className={`artifact-workspace ${ctx.artifactFocusPreview ? "is-preview-focused" : ""}`} style={{ "--artifact-source-fr": `${ctx.artifactLayout?.source ?? 0.68}fr`, "--artifact-diff-fr": `${ctx.artifactLayout?.diff ?? 0.88}fr`, "--artifact-preview-fr": `${ctx.artifactLayout?.preview ?? 1.48}fr`, "--artifact-evidence-row": `${ctx.artifactLayout?.evidence ?? 168}px` }}>

      <section className={`artifact-pane artifact-source-pane ${ctx.artifactView === "source" ? "is-visible" : ""}`}>
        <div className="pane-heading">
          <span>Source{files.length ? ` · ${files.length} file${files.length === 1 ? "" : "s"}` : ""}</span>
          <div className="preview-pane-actions">
            <button type="button" onClick={() => activeFile && copyText(activeText, `${activeFile}`)} disabled={!activeFile} title="Copy the active file"><Icon name="copy" size={12} /> Copy file</button>
            <button type="button" onClick={() => copyText(combinedSource(source), "Artifact source")} disabled={!files.length} title="Copy all files — provenance noted, this is not repository code"><Icon name="copy" size={12} /> Copy all</button>
            <button type="button" onClick={() => void ctx.runArtifact?.("artifact.inspect", { artifactId: artifact?.id })}>Reveal source</button>
          </div>
        </div>
        {files.length > 0 && <div className="source-tab-strip" role="tablist" aria-label="Artifact files">
          {files.map((name) => (
            <button key={name} type="button" role="tab" aria-selected={name === activeFile} className={name === activeFile ? "is-selected" : ""} title={`${name} · ${formatBytes(fileInfo[name]?.bytes)} · ${fileInfo[name]?.lines ?? 0} lines`} onClick={() => setFileChoices((current) => ({ ...current, [artifact?.id || ""]: name }))}>
              {name}<small>{formatBytes(fileInfo[name]?.bytes)}</small>
            </button>
          ))}
        </div>}
        {activeText !== null
          ? <pre className="source-view" data-file={activeFile}>{activeText.length > HIGHLIGHT_LIMIT ? activeText : <SourceTokens text={activeText} language={activeLanguage} />}</pre>
          : <p>No task-scoped artifact yet. Create one from the command palette or the authoring action.</p>}
      </section>

      <section className={`artifact-pane artifact-diff-pane ${ctx.artifactView === "diff" ? "is-visible" : ""}`}>
        <div className="pane-heading">
          <span>Diff{ctx.artifactCompare ? ` · r${ctx.artifactCompare.from} → r${ctx.artifactCompare.to}` : ""}</span>
          <button type="button" disabled={!artifact?.revision || artifact.revision < 2} title={artifact?.revision > 1 ? `Diff r${artifact.revision - 1} against r${artifact.revision}` : "Needs two revisions to compare"} onClick={async () => {
            if (!artifact?.revision || artifact.revision < 2) return;
            const result = await ctx.runArtifact?.("compare", { artifactId: artifact.id, from: artifact.revision - 1, to: artifact.revision });
            if (result?.files) ctx.setArtifactCompare?.(result);
          }}>Compare revisions</button>
        </div>
        {compareResult
          ? <div className="artifact-diff-result">{compareResult.map((file) => <DiffFileBlock key={file.file} file={file} />)}</div>
          : <p>{artifact?.revision > 1 ? "Click Compare revisions to diff the last two revisions." : "The diff appears once the artifact has at least two revisions."}</p>}
      </section>

      <section className={`artifact-pane artifact-preview-pane ${ctx.artifactView === "preview" ? "is-visible" : ""}`}>
        <div className="pane-heading">
          <span>Live Preview <small>{ctx.isDesktop ? "Electron sandbox" : "Browser visual preview · non-runtime"}</small></span>
          <div className="preview-pane-actions">
            <div className="preview-viewport-bar" role="group" aria-label="Preview viewport width">
              {[["fill", "Fill"], ["mobile", "390px"], ["tablet", "768px"], ["desktop", "1280px"]].map(([id, label]) => (
                <button key={id} type="button" className={ctx.previewViewport === id ? "is-selected" : ""} aria-pressed={ctx.previewViewport === id} onClick={() => ctx.setPreviewViewport?.(id)}>{label}</button>
              ))}
            </div>
            <button type="button" onClick={() => previewCommand("inspect")}>Inspect</button>
            <button type="button" onClick={() => previewCommand("accessibility")}>A11y</button>
            <button type="button" className="preview-focus-action" onClick={() => ctx.setArtifactFocusPreview?.((value) => !value)}>{ctx.artifactFocusPreview ? "Workspace" : "Focus preview"}</button>
          </div>
        </div>
        {artifact?.revision
          ? <>
            <form className="preview-palette" onSubmit={runPalette}>
              <Icon name="target" size={12} />
              <select value={paletteActionId} onChange={(event) => setPaletteActionId(event.target.value)} aria-label="Preview interaction" title="Registered preview action">
                {PALETTE_ACTIONS.map((action) => <option key={action.id} value={action.id}>{action.label}</option>)}
              </select>
              {paletteSpec.fields.map((field) => (
                <input
                  key={field.name}
                  value={paletteValues[field.name] || ""}
                  onChange={(event) => setPaletteValues((current) => ({ ...current, [field.name]: event.target.value }))}
                  placeholder={field.required ? `${field.placeholder || field.label} *` : field.placeholder || field.label}
                  aria-label={`${paletteSpec.label} ${field.label}`}
                  required={field.required}
                />
              ))}
              <button type="submit" className="primary-action" disabled={!ctx.previewSession} title={ctx.previewSession ? "Send the registered preview action" : "Open a preview session first (More → Open preview)"}>Run</button>
            </form>
            {lastInteraction && <div className="preview-interact-result" role="status">
              <code>{lastInteraction.text}</code>
              {isRenderableScreenshotRef(lastInteraction.screenshotRef) && <img className="preview-screenshot" src={lastInteraction.screenshotRef} alt="Latest preview screenshot" />}
            </div>}
            <div className={`preview-frame-wrap viewport-${ctx.previewViewport || "fill"}`}>
              <iframe className="artifact-preview-frame" title="Isolated artifact preview" sandbox="allow-scripts allow-forms" referrerPolicy="no-referrer" srcDoc={ctx.previewSrc} />
            </div>
          </>
          : <div className="artifact-empty"><Icon name="artifact" size={22} /><strong>The first renderable revision will peek here.</strong><span>Authoring stays scoped to this task and never writes repository source.</span></div>}
      </section>

      <section className={`artifact-pane artifact-output-pane ${ctx.artifactView === "output" ? "is-visible" : ""}`}>
        <div className="pane-heading">
          <span>Output / Console{consoleLines.length ? ` · ${consoleLines.length}` : ""}{consoleErrorCount ? <span className="console-error-badge" title="Preview console errors">{consoleErrorCount} error{consoleErrorCount === 1 ? "" : "s"}</span> : null}</span>
          <div className="preview-pane-actions">
            {consoleErrorCount > 0 && <button type="button" className="send-errors-action" disabled={!artifact || ctx.artifactReviseBusy} onClick={sendErrorsToMaple} title="Draft a revision instruction with these errors — you review before it sends"><Icon name="send" size={11} /> Send {consoleErrorCount} error{consoleErrorCount === 1 ? "" : "s"} to Maple</button>}
            <button type="button" onClick={() => ctx.setPreviewConsoleLines?.([])} disabled={!consoleLines.length}>Clear</button>
          </div>
        </div>
        {consoleLines.length
          ? <div className="console-lines">{consoleLines.map((line, index) => <ConsoleLine key={index} line={line} />)}</div>
          : <p className="empty-copy">Console output from the live preview appears here — logs, warnings, and errors.</p>}
        {ctx.previewInspection && <details className="artifact-inspection-dump"><summary>Last inspection payload</summary><pre>{JSON.stringify(ctx.previewInspection, null, 2)}</pre></details>}
      </section>

      <section className={`artifact-pane artifact-inspect-pane ${ctx.artifactView === "inspect" ? "is-visible" : ""}`}>
        <div className="pane-heading">
          <span>Inspection</span>
          <div className="preview-pane-actions">
            <button type="button" onClick={() => previewCommand("inspect")}>Inspect DOM</button>
            <button type="button" onClick={() => previewCommand("accessibility")}>A11y tree</button>
            <button type="button" onClick={() => previewCommand("wait", { ms: 250 })}>Wait 250ms</button>
          </div>
        </div>
        {(() => {
          const dom = ctx.previewInspection?.dom || null;
          const a11y = ctx.previewInspection?.landmarks ? ctx.previewInspection : (ctx.previewInspection?.accessibility || null);
          if (!dom && !a11y) return <p className="empty-copy">Run "Inspect DOM" or "A11y tree" to capture a structured snapshot of the live preview. The snapshot also feeds the host verification report.</p>;
          return <div className="inspection-report">
            {dom && <>
              <div className="inspection-block"><strong>Document</strong><span>{dom.title || "untitled"} · {dom.elements?.length || 0} elements · {(dom.bodyText || "").length} chars of text</span></div>
              {dom.elements?.length ? <div className="inspection-list">{dom.elements.filter((el) => el.text || el.previewId || el.id).slice(0, 40).map((el, index) => <div className="inspection-row" key={index}><span className="inspection-tag">{el.tag}</span>{el.previewId && <code>#{el.previewId}</code>}{el.id && !el.previewId && <code>#{el.id}</code>}{el.role && <em>{el.role}</em>}<small>{(el.text || "").slice(0, 90) || "—"}</small></div>)}</div> : null}
            </>}
            {a11y?.landmarks && <>
              <div className="inspection-block"><strong>Landmarks</strong><span>{a11y.landmarks.length} regions</span></div>
              <div className="inspection-list">{a11y.landmarks.map((landmark, index) => <div className="inspection-row" key={index}><span className="inspection-tag">{landmark.tag}</span>{landmark.role && <em>{landmark.role}</em>}{landmark.label && <code>{landmark.label}</code>}<small>{(landmark.text || "").slice(0, 90) || "—"}</small></div>)}</div>
              {a11y.controls?.length ? <><div className="inspection-block"><strong>Controls</strong><span>{a11y.controls.length} interactive</span></div><div className="inspection-list">{a11y.controls.map((control, index) => <div className="inspection-row" key={index}><span className="inspection-tag">{control.tag}</span>{control.disabled ? <em className="is-disabled">disabled</em> : null}<small>{control.label || "(no accessible label)"}</small></div>)}</div></> : null}
            </>}
            {ctx.previewInspection && <details className="artifact-inspection-dump"><summary>Raw payload</summary><pre>{JSON.stringify(ctx.previewInspection, null, 2)}</pre></details>}
          </div>;
        })()}
      </section>

      <button type="button" className="artifact-resize-handle artifact-resize-source-diff" aria-label="Resize Source and Diff panels" title="Drag to resize Source and Diff panels" onPointerDown={(event) => ctx.beginArtifactPanelResize?.(event, "source-diff")} onPointerMove={ctx.updateArtifactPanelResize} onPointerUp={ctx.endArtifactPanelResize} onPointerCancel={ctx.endArtifactPanelResize} onKeyDown={(event) => ctx.handleArtifactPanelResizeKey?.(event, "source-diff")} />
      <button type="button" className="artifact-resize-handle artifact-resize-diff-preview" aria-label="Resize Diff and Live Preview panels" title="Drag to resize Diff and Live Preview panels" onPointerDown={(event) => ctx.beginArtifactPanelResize?.(event, "diff-preview")} onPointerMove={ctx.updateArtifactPanelResize} onPointerUp={ctx.endArtifactPanelResize} onPointerCancel={ctx.endArtifactPanelResize} onKeyDown={(event) => ctx.handleArtifactPanelResizeKey?.(event, "diff-preview")} />
      <button type="button" className="artifact-resize-handle artifact-resize-evidence" aria-label="Resize Output and Inspection panels" title="Drag to resize Output and Inspection panels" onPointerDown={(event) => ctx.beginArtifactPanelResize?.(event, "evidence")} onPointerMove={ctx.updateArtifactPanelResize} onPointerUp={ctx.endArtifactPanelResize} onPointerCancel={ctx.endArtifactPanelResize} onKeyDown={(event) => ctx.handleArtifactPanelResizeKey?.(event, "evidence")} />
    </div>

    <div className="artifact-footer">
      <span>{artifact ? `${artifact.kind} · ${artifact.mime} · ${artifact.entrypoint}` : "No artifact selected"}</span>
      <span>{ctx.previewSession ? `preview ${ctx.previewSession.status} · ${ctx.previewSession.actions}/24 actions` : "preview session idle"}</span>
      <GlossaryHint as="button" type="button" className="quiet-action" term="Change set" definition="a bundled set of prepared edits held for your approval — nothing touches the repository until you approve it." onClick={() => { void ctx.runArtifact?.("export", { artifactId: artifact?.id }).then((result) => { if (result?.changeSet) ctx.setExportedChangeSet?.(result.changeSet); }); }} disabled={!artifact?.revision}>Export to change set</GlossaryHint>
      {ctx.exportedChangeSet && (!artifact?.id || ctx.exportedChangeSet.artifactId === artifact.id) && <button type="button" className="quiet-action" title="Dry-run the change set against the thread workspace first; a second confirmation writes and commits with a receipt." onClick={() => void ctx.applyExportedChangeSet?.()} disabled={ctx.changesetApplyBusy || !ctx.exportedChangeSet?.artifactSource}>{ctx.changesetApplyBusy ? "Applying…" : `Apply to repository… (${Object.keys(ctx.exportedChangeSet.artifactSource || {}).length})`}</button>}
    </div>
  </div>;
});
