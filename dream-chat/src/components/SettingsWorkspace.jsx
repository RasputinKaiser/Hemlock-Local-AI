import React, { useId, useRef, useState } from "react";
import { Icon } from "./Icons.jsx";
import "./settings-workspace.css";

const SECTIONS = [
  { id: "models", label: "Models & accounts", icon: "connection" },
  { id: "workspace", label: "Workspace", icon: "windows" },
  { id: "context", label: "Context & memory", icon: "memory" },
  { id: "advanced", label: "Advanced/runtime", icon: "settings" },
];

function formatBytes(bytes) {
  return bytes == null ? "—" : bytes > 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GiB` : bytes > 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MiB` : `${Math.round(bytes / 1024)} KiB`;
}

function statusLabel(state, label) {
  return <span className="settings-workspace-status" data-state={state}>{label}</span>;
}

/**
 * Task-based settings; the parent retains all host actions and persistence.
 *
 * model state: apiBase, serverState, inferenceReady, readinessCheck, isDesktop,
 * skipCloseWarning, dreamTrainingProfile, modelLanes (MODEL_LANES),
 * providerStatuses, providerCaps (threadRegistry.providerCaps), sourcePolicies,
 * inventory (agentSnapshot?.storageInventory), storageRoot (existing fallback).
 *
 * model callbacks: setApiBase, setReadinessCheck, setServerProcessReady,
 * setInferenceReady, checkReadiness, refreshProviderStatuses, providerAuthAction,
 * onSkipCloseWarningChange(skip), reopenPrimer, setSourceEnabled,
 * updateProviderCapacity, setDreamTrainingProfile, displayText.
 * onSkipCloseWarningChange must persist CLOSE_WARNING_KEY and update state.
 * No host calls, localStorage writes, or training operations occur on mount.
 */
export function SettingsWorkspace({ model }) {
  const [activeSection, setActiveSection] = useState("models");
  const idPrefix = useId();
  const scrollRef = useRef(null);
  function selectSection(section) {
    setActiveSection(section);
    // Only task content scrolls; navigation never overlaps keyboard focus.
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }
  return <SettingsWorkspaceView model={model} activeSection={activeSection} onSectionChange={selectSection} idPrefix={idPrefix} scrollRef={scrollRef} />;
}

/** Controlled presentation, also usable by an embedding workspace. */
export function SettingsWorkspaceView({ model, activeSection = "models", onSectionChange, idPrefix, scrollRef }) {
  const {
    apiBase, setApiBase, setReadinessCheck, setServerProcessReady, setInferenceReady,
    serverState, inferenceReady, readinessCheck, checkReadiness,
    isDesktop, modelLanes, providerStatuses = [], refreshProviderStatuses, providerAuthAction,
    skipCloseWarning, onSkipCloseWarningChange, reopenPrimer,
    sourcePolicies = [], setSourceEnabled, displayText,
    providerCaps = {}, updateProviderCapacity, dreamTrainingProfile, setDreamTrainingProfile,
    inventory, storageRoot,
  } = model;
  const providerStatusById = Object.fromEntries(providerStatuses.map((status) => [status.provider, status]));
  const sectionProps = (section) => ({
    id: `${idPrefix}-${section}`,
    "aria-labelledby": `${idPrefix}-${section}-heading`,
    hidden: activeSection !== section,
    className: "settings-workspace-section",
  });

  return <div className="settings-workspace">
    <nav className="settings-workspace-nav" aria-label="Settings sections">
      {SECTIONS.map(({ id, label, icon }) => <button
        key={id}
        type="button"
        aria-controls={`${idPrefix}-${id}`}
        aria-current={activeSection === id ? "page" : undefined}
        onClick={() => onSectionChange(id)}
      ><Icon name={icon} size={18} />{label}</button>)}
    </nav>

    <div className="settings-workspace-content" ref={scrollRef}>
    {/* Keep inactive sections mounted to retain drafts, but out of the tab order. */}
    <section {...sectionProps("models")}>
      <h2 id={`${idPrefix}-models-heading`}>Models & accounts</h2>
      <div className="settings-workspace-group">
        <h3>Local model connection</h3>
        <label className="settings-workspace-field">
          Maple-Preview server URL
          <input
            type="text"
            value={apiBase}
            spellCheck={false}
            autoCapitalize="none"
            aria-describedby={`${idPrefix}-connection-help`}
            onChange={(event) => {
              setApiBase(event.target.value);
              setReadinessCheck("idle");
              setServerProcessReady(null);
              setInferenceReady(null);
            }}
          />
        </label>
        <p id={`${idPrefix}-connection-help`}>Hemlock sends requests through the Electron control plane. A healthy process is not the same as a completed inference response.</p>
        <div className="settings-workspace-readiness" role="status" aria-live="polite">
          {statusLabel(serverState, `process: ${serverState}`)}
          {statusLabel(inferenceReady ? "ready" : inferenceReady === false ? "down" : "idle", `inference: ${inferenceReady ? "verified" : inferenceReady === false ? "not verified" : "not checked"}`)}
        </div>
        <button className="settings-workspace-primary" type="button" onClick={() => void checkReadiness()} disabled={readinessCheck === "checking"}>
          {readinessCheck === "checking" ? "Checking local inference…" : "Check local readiness"}
        </button>
      </div>
      <div className="settings-workspace-group">
        <div className="settings-workspace-heading-row">
          <h3>Subscription providers</h3>
          <button type="button" onClick={() => void refreshProviderStatuses()} disabled={!isDesktop}><Icon name="refresh" size={15} /> Refresh</button>
        </div>
        <p>Log in through each provider’s own CLI. Hemlock never asks for or stores API keys, OAuth tokens, or subscription credentials.</p>
        {!isDesktop && <p className="settings-workspace-note">Account controls are available in the Hemlock desktop app.</p>}
        {['codex', 'claude'].map((provider) => {
          const lane = modelLanes[provider];
          const status = providerStatusById[provider];
          const authenticated = status?.authenticated === true;
          return <div className="settings-workspace-account" key={provider}>
            <div className="settings-workspace-account-copy">
              <strong>{lane.label}</strong>
              {statusLabel(authenticated ? "ready" : status?.installed === false ? "down" : "unknown", authenticated ? "login detected" : status?.installed === false ? "not installed" : "login required")}
              <small>{authenticated ? status.accountLabel : `${lane.label} subscription via ${provider === "codex" ? "ChatGPT" : "Claude Code"}`}</small>
            </div>
            <div className="settings-workspace-actions">
              <button type="button" onClick={() => void providerAuthAction(provider, "login")} disabled={!isDesktop || status?.installed === false}><Icon name="login" size={15} /> {authenticated ? "Re-authenticate" : "Log in"}</button>
              {authenticated && <button type="button" onClick={() => void providerAuthAction(provider, "logout")} disabled={!isDesktop}><Icon name="logout" size={15} /> Log out</button>}
            </div>
          </div>;
        })}
      </div>
    </section>

    <section {...sectionProps("workspace")}>
      <h2 id={`${idPrefix}-workspace-heading`}>Workspace</h2>
      <div className="settings-workspace-group">
        <h3>Window behavior</h3>
        <label className="settings-workspace-check">
          <input type="checkbox" checked={!skipCloseWarning} aria-describedby={`${idPrefix}-close-help`} onChange={(event) => onSkipCloseWarningChange(!event.target.checked)} />
          <span>Ask before closing a window</span>
        </label>
        <p id={`${idPrefix}-close-help`}>Closing a window keeps its state and does not cancel running work. Destructive actions still ask for confirmation.</p>
      </div>
      <div className="settings-workspace-group">
        <h3>Getting started</h3>
        <p>Revisit the workspace tips when you need a reminder.</p>
        <button type="button" onClick={reopenPrimer}>Reopen getting-started tips</button>
      </div>
    </section>

    <section {...sectionProps("context")}>
      <h2 id={`${idPrefix}-context-heading`}>Context & memory</h2>
      <div className="settings-workspace-group">
        <h3>Context sources</h3>
        <p>Hemlock only uses enabled sources. Every surfaced observation retains its source and freshness.</p>
        {sourcePolicies.length ? sourcePolicies.map((source) => <label className="settings-workspace-check settings-workspace-source" key={source.sourceId}>
          <span>
            <strong>{displayText(source.displayName)}</strong>
            <small>{displayText(source.sourceId)} · {displayText(source.retention)} · {displayText(source.permissionState)}</small>
          </span>
          <input type="checkbox" checked={source.enabled !== false} onChange={(event) => void setSourceEnabled(source, event.target.checked)} disabled={!isDesktop || source.sourceId === "local-project"} />
        </label>) : <p className="settings-workspace-note">Source policies will appear after the desktop runtime resumes.</p>}
      </div>
    </section>

    <section {...sectionProps("advanced")}>
      <h2 id={`${idPrefix}-advanced-heading`}>Advanced/runtime</h2>
      <div className="settings-workspace-group">
        <h3>Concurrency caps</h3>
        <small className="settings-workspace-caption">Provider scheduler · host-owned · no silent fallback</small>
        <p>Maple-Preview remains serialized unless you deliberately change its lane cap. Codex and Claude lanes can run independently.</p>
        <div className="settings-workspace-cap-grid">
          {["maple", "codex", "claude"].map((provider) => <label className="settings-workspace-field" key={provider}>
            <span>{modelLanes[provider].shortLabel}</span>
            <input
              type="number" min="1" max="8"
              defaultValue={providerCaps[provider] || 1}
              key={`${provider}-${providerCaps[provider] || 1}`}
              onBlur={(event) => {
                const next = Number(event.target.value);
                if (Number.isFinite(next) && next >= 1 && next <= 8 && next !== (providerCaps[provider] || 1)) void updateProviderCapacity(provider, String(next));
                else event.target.value = String(providerCaps[provider] || 1);
              }}
              onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
              disabled={!isDesktop}
            />
            <small>{provider === "maple" ? "local lane" : "subscription lane"}</small>
          </label>)}
        </div>
      </div>
      <div className="settings-workspace-group">
        <h3>Dream training</h3>
        <label className="settings-workspace-field">Regular Dream profile
          <select value={dreamTrainingProfile} onChange={(event) => setDreamTrainingProfile(event.target.value)}>
            <option value="smoke">Smoke · 1 step</option>
            <option value="balanced">Balanced · 4 steps</option>
            <option value="quality">Quality · 8 steps</option>
          </select>
        </label>
      </div>
      <div className="settings-workspace-group">
        <h3>Runtime storage</h3>
        <p className="settings-workspace-path">{displayText(inventory?.root || storageRoot, "Hemlock application data")}</p>
        <dl className="settings-workspace-storage">
          <div><dt>Model</dt><dd>{formatBytes(inventory?.modelBytes)}</dd></div>
          <div><dt>Runtime</dt><dd>{formatBytes(inventory?.totalRuntimeBytes)}</dd></div>
          <div><dt>Free</dt><dd>{formatBytes(inventory?.freeBytes)}</dd></div>
        </dl>
        <p>Models, adapters, datasets, receipts, and event projections stay outside the Git worktree. Inventory is informational; cleanup remains an explicit future operation.</p>
      </div>
    </section>
    </div>
  </div>;
}
