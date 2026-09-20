import React, { useEffect, useRef, useState } from "react";
import { Icon } from "./Icons.jsx";
import "./workspace-navigation.css";
import { APP_GROUPS, APP_SHORTCUTS } from "../workspaceNavigation.js";

const descriptions = {
  center: "Tasks, context, and workspace health",
  chat: "Conversations and code assistance",
  artifact: "Preview, inspect, and revise your work",
  memory: "Personal facts and project lessons",
  sips: "Local self-improvement controls",
  dream: "Local model training and adapters",
  activity: "Live events and operation history",
  receipts: "Evidence and verification records",
  map: "Repository structure and worktree state",
  grove: "Ambient 3D world of local models, bound to real events",
  settings: "Models, accounts, and preferences",
};

export function WorkspaceOverview({ windows, metadata, activeId, onActivate, onDismiss, onShowShortcuts }) {
  const [query, setQuery] = useState("");
  const rootRef = useRef(null);
  const searchRef = useRef(null);
  useEffect(() => {
    const opener = document.activeElement;
    searchRef.current?.focus();
    return () => { if (opener?.isConnected) opener.focus(); };
  }, []);
  const matches = Object.entries(metadata).filter(([id, meta]) => `${meta.label} ${descriptions[id]}`.toLowerCase().includes(query.trim().toLowerCase()));
  const open = matches.filter(([id]) => windows[id]?.state !== "closed").sort(([a], [b]) => (windows[b]?.zOrder || 0) - (windows[a]?.zOrder || 0));
  const closed = matches.filter(([id]) => windows[id]?.state === "closed");
  function handleKey(event) {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onDismiss(); return; }
    const buttons = [...rootRef.current.querySelectorAll(".overview-app")];
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) && (event.target !== searchRef.current || event.key.startsWith("Arrow"))) {
      if (!buttons.length) return;
      event.preventDefault();
      const index = buttons.indexOf(document.activeElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : event.key === "ArrowDown" ? (index + 1) % buttons.length : (index - 1 + buttons.length) % buttons.length;
      buttons[next].focus();
    }
    if (event.key === "Enter" && event.target === searchRef.current && buttons.length) { event.preventDefault(); buttons[0].click(); }
    if (event.key === "Tab") {
      const items = [...rootRef.current.querySelectorAll("input, button")];
      const first = items[0], last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  }
  function group(title, items) {
    if (!items.length) return null;
    return <section className="overview-group" aria-label={title}><h3>{title}<span>{items.length}</span></h3><div className="overview-apps">{items.map(([id, meta]) => {
      const state = windows[id]?.state || "closed";
      const status = state === "closed" ? "Open" : state === "minimized" ? "Minimized" : id === activeId ? "Focused" : "Open window";
      return <button type="button" className={`overview-app${id === activeId ? " is-current" : ""}`} key={id} onClick={() => onActivate(id)}>
        <span className={`window-glyph glyph-${meta.tone}`}><Icon name={meta.icon} size={20} /></span>
        <span className="overview-app-copy"><strong>{meta.label}</strong><small>{descriptions[id]}</small></span>
        <span className="overview-app-state">{status}{APP_SHORTCUTS.indexOf(id) < 10 && <kbd>⌘{(APP_SHORTCUTS.indexOf(id) + 1) % 10}</kbd>}</span>
      </button>;
    })}</div></section>;
  }
  return <div className="palette-backdrop overview-backdrop" onClick={onDismiss}><section ref={rootRef} className="workspace-overview" role="dialog" aria-modal="true" aria-labelledby="overview-title" onClick={event => event.stopPropagation()} onKeyDown={handleKey}>
    <header className="overview-heading"><div><h2 id="overview-title">Your workspace</h2><p>Switch windows or open an app. Your work stays where you left it.</p></div><button type="button" className="quiet-action" onClick={onDismiss} aria-label="Close window overview"><Icon name="close" size={18} /></button></header>
    <label className="overview-search"><Icon name="search" size={18} /><input ref={searchRef} value={query} onChange={event => setQuery(event.target.value)} placeholder="Find an app or window…" aria-label="Find an app or window" /><kbd>Esc</kbd></label>
    <div className="overview-scroll">{group("Open windows", open)}{APP_GROUPS.map(category => <React.Fragment key={category.label}>{group(category.label, closed.filter(([id]) => category.ids.includes(id)))}</React.Fragment>)}{!matches.length && <p className="empty-copy" role="status">No matching apps. Try Chat, Settings, or Activity.</p>}</div>
    <footer className="overview-footer"><span>↑ ↓ to navigate · Enter to open · Esc to return</span>{onShowShortcuts && <button type="button" className="overview-shortcut-link" onClick={onShowShortcuts}><Icon name="keyboard" size={15} /> All shortcuts</button>}</footer>
  </section></div>;
}
