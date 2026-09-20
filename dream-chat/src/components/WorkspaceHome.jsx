import React from "react";
import { Icon } from "./Icons.jsx";
import "./workspace-home.css";

// Idle Command Center: one task entry point on paper, not an empty cockpit.
// Parent owns navigation, thread switching, readiness observations and all work.
// No checks, inference, persistence, or synthetic model state run on mount.

/** Describe observations, never promote process health/auth to inference proof. */
export function workspaceReadiness({
  isDesktop, provider, providerStatus, serverProcessReady, inferenceReady, readinessCheck,
}) {
  if (isDesktop === false) return {
    label: "Browser preview",
    detail: "Desktop provider status is unavailable here. Open Chat to explore the interface.",
  };
  if (provider === "maple") {
    if (readinessCheck === "checking") return {
      label: "Readiness check in progress",
      detail: "Waiting for the inference check result; a running process alone is not proof.",
    };
    if (serverProcessReady === false) return {
      label: "Local server unavailable",
      detail: "Open Configure models to inspect the local server before sending a message.",
    };
    if (inferenceReady === false || readinessCheck === "failed") return {
      label: "Inference check failed",
      detail: "Open Configure models to inspect the failure before trying again.",
    };
    if (inferenceReady === true) return {
      label: "Last inference check passed",
      detail: "This reports the last check, not a guarantee for the next request.",
    };
    return {
      label: "Inference not checked",
      detail: serverProcessReady === true
        ? "Local server is responding. That does not verify model inference."
        : "Local server status is unknown. Configure models to inspect its connection.",
    };
  }
  if (providerStatus?.installed === false) return {
    label: "Provider CLI not found",
    detail: "Open Configure models for provider setup.",
  };
  if (providerStatus?.authenticated === false) return {
    label: "Provider sign-in required",
    detail: "Open Configure models to sign in before sending a message.",
  };
  if (providerStatus?.authenticated === true) return {
    label: "Provider sign-in reported",
    detail: "Sign-in status is not an inference check. Availability is confirmed when a request runs.",
  };
  return {
    label: "Provider status not checked",
    detail: "Open Configure models to inspect the selected provider.",
  };
}

function threadTime(thread) {
  for (const value of [thread.updatedAt, thread.lastOpenedAt, thread.createdAt]) {
    const time = typeof value === "string" ? Date.parse(value) : NaN;
    if (Number.isFinite(time)) return time;
  }
  return 0;
}

/** Registry records only. Sorting never mutates the parent-owned collection. */
export function recentWorkspaceThreads(threads = []) {
  const seen = new Set();
  return (Array.isArray(threads) ? threads : [])
    .filter((thread) => thread?.id && !["archived", "closed"].includes(thread.status) && !thread.archivedAt)
    .slice()
    .sort((a, b) => threadTime(b) - threadTime(a))
    .filter((thread) => {
      if (seen.has(thread.id)) return false;
      seen.add(thread.id);
      return true;
    });
}

const COUNT_LABELS = {
  threads: "Open threads",
  projects: "Projects",
  artifacts: "Artifacts",
  receipts: "Receipts",
  observations: "Context observations",
};

/**
 * All props are observations or callbacks from App; this is a stateless view.
 * Required navigation: onOpenChat(), onConfigureModels().
 * Provider: provider, providerLabel, modelLabel, providerStatus (selected record),
 * isDesktop, serverProcessReady (boolean|null), inferenceReady (boolean|null),
 * readinessCheck (idle|checking|ready|failed).
 * Threads: raw threadRegistry.threads; activeThreadId; onSwitchThread(id) must
 * switch AND open Chat. threadSwitching disables rows during a host command.
 * Optional: onBrowseThreads(), counts {threads,projects,artifacts,receipts,
 * observations} (omit unknown values), showHowItWorks (default true).
 */
export function WorkspaceHome({
  onOpenChat,
  onConfigureModels,
  provider,
  providerLabel,
  modelLabel,
  providerStatus = null,
  isDesktop,
  serverProcessReady = null,
  inferenceReady = null,
  readinessCheck = "idle",
  threads = [],
  activeThreadId = null,
  onSwitchThread,
  threadSwitching = false,
  onBrowseThreads,
  counts,
  showHowItWorks = true,
}) {
  const readiness = workspaceReadiness({ isDesktop, provider, providerStatus, serverProcessReady, inferenceReady, readinessCheck });
  const openThreads = recentWorkspaceThreads(threads);
  const recentThreads = openThreads.slice(0, 3);
  const knownCounts = Object.entries(COUNT_LABELS)
    .filter(([key]) => Number.isSafeInteger(counts?.[key]) && counts[key] >= 0);
  const selection = [providerLabel || provider, modelLabel].filter(Boolean).join(" · ");

  return <section className="workspace-home" aria-label="Workspace home">
    <div className="workspace-home-content">
      <header className="workspace-home-intro">
        <h1>What would you like to work on?</h1>
        <p>Start with a question, explore an idea, or build something in Chat.</p>
        <div className="workspace-home-actions">
          <button type="button" className="workspace-home-primary" onClick={onOpenChat} disabled={!onOpenChat}>
            <Icon name="chat" size={17} /> Open Chat
          </button>
          <button type="button" className="workspace-home-secondary" onClick={onConfigureModels} disabled={!onConfigureModels}>
            <Icon name="settings" size={16} /> Configure models
          </button>
        </div>
      </header>

      <section className="workspace-home-provider" aria-label="Selected provider and readiness">
        <span className="workspace-home-label">Selected model</span>
        <strong>{selection || "No model selection supplied"}</strong>
        <div className="workspace-home-readiness" role="status" aria-live="polite" aria-atomic="true">
          <span>{readiness.label}</span>
          <p>{readiness.detail}</p>
        </div>
      </section>

      {recentThreads.length > 0 && <section className="workspace-home-recent" aria-label="Recent open threads">
        <div className="workspace-home-section-heading">
          <h2>Recent threads</h2>
          {onBrowseThreads && openThreads.length > recentThreads.length && <button type="button" className="workspace-home-link" onClick={onBrowseThreads}>Browse all threads</button>}
        </div>
        <ul className="workspace-home-thread-list">
          {recentThreads.map((thread) => <li key={thread.id}>
            <button type="button" className="workspace-home-thread" onClick={() => onSwitchThread?.(thread.id)} disabled={!onSwitchThread || threadSwitching} aria-current={thread.id === activeThreadId ? "true" : undefined}>
              <span className="workspace-home-thread-copy">
                <strong>{typeof thread.title === "string" && thread.title.trim() ? thread.title : "Untitled thread"}</strong>
                <span className="workspace-home-thread-meta">
                  {thread.provider && <span>{thread.provider}</span>}
                  {thread.workspaceRoot && <span className="workspace-home-thread-path" title={thread.workspaceRoot}>{thread.workspaceRoot}</span>}
                </span>
              </span>
              {thread.id === activeThreadId && <span className="workspace-home-current">Current</span>}
              <Icon name="chat" size={15} />
            </button>
          </li>)}
        </ul>
      </section>}

      {(knownCounts.length > 0 || showHowItWorks) && <footer className="workspace-home-details">
        {knownCounts.length > 0 && <details>
          <summary>Workspace details</summary>
          <dl className="workspace-home-counts">
            {knownCounts.map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{counts[key]}</dd></div>)}
          </dl>
          <p>Recorded workspace counts, not a live health check.</p>
        </details>}
        {showHowItWorks && <details>
          <summary>How Hemlock works</summary>
          <p>Model output stays verbatim in Chat. Host actions and their evidence are labeled separately, so you can inspect what happened without mistaking host notes for a model response.</p>
        </details>}
      </footer>}
    </div>
  </section>;
}
