import React, { useEffect, useRef } from "react";
import { Icon } from "./Icons.jsx";
import { APP_SHORTCUTS } from "../workspaceNavigation.js";
import "./workspace-controls.css";

const groups = [
  { title: "Navigate", items: [["apps", "All apps / window overview", "⌘⇧O"], ["command", "Search commands", "⌘K"], ["command", "Run a palette result", "⌘1–9"], ["windows", "Cycle open windows", "⌘`"], ["desktop", "Show desktop / restore windows", "⌘⌥D"], ["windows", "Move along the dock · window actions menu", "← → · Shift+F10"], ["keyboard", "This shortcut guide", "F1"]] },
  { title: "Arrange the active window", items: [["tileLeft", "Tile left", "⌘⌥←"], ["tileRight", "Tile right", "⌘⌥→"], ["maximize", "Fill workspace", "⌘⌥↑"], ["restore", "Restore size", "⌘⌥↓"], ["maximize", "Double-click a title bar", "fill / restore"], ["minimize", "Minimize", "⌘⌥M"], ["close", "Close window", "⌘W"]] },
  { title: "Conversation & controls", items: [["send", "Send a message", "Enter"], ["chat", "New line", "Shift+Enter"], ["search", "Filter the transcript", "⌘F"], ["connection", "Choose model", "⌘⇧M"], ["copy", "Copy with provenance", "Option-click Copy"], ["resetSize", "Resize a focused edge", "Arrows · Shift for larger steps"]] },
  { title: "Agent control", items: [["target", "Autonomy — Supervised · Guided · Autonomous", "composer bar"], ["pencil", "Redirect the active task", "steer: instruction"], ["play", "Start an autonomous bounded run", "campaign: goal"], ["pause", "Pause / resume at a step boundary", "active-step card"], ["pulse", "Scored action choice", "scored: cmd · margin"]] },
];

export function ShortcutGuide({ metadata, onOpenApp, onDismiss }) {
  const root = useRef(null);
  useEffect(() => {
    const opener = document.activeElement;
    root.current.querySelector('button')?.focus();
    return () => { if (opener?.isConnected) opener.focus(); };
  }, []);
  function onKey(event) {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onDismiss(); }
    if (event.key !== "Tab") return;
    const buttons = [...root.current.querySelectorAll('button:not([disabled])')];
    if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons.at(-1).focus(); }
    else if (!event.shiftKey && document.activeElement === buttons.at(-1)) { event.preventDefault(); buttons[0].focus(); }
  }
  return <div className="palette-backdrop shortcut-backdrop" onClick={onDismiss}>
    <section className="shortcut-guide" ref={root} role="dialog" aria-modal="true" aria-labelledby="shortcut-guide-title" onClick={event => event.stopPropagation()} onKeyDown={onKey}>
      <header><div><Icon name="keyboard" size={24} /><h2 id="shortcut-guide-title">Workspace shortcuts</h2></div><button type="button" onClick={onDismiss} aria-label="Close shortcut guide"><Icon name="close" size={18} /></button></header>
      <p className="shortcut-intro">Every window also has an actions menu. Escape dismisses overlays; it never stops your work.</p>
      <div className="shortcut-scroll">
        <div className="shortcut-groups">{groups.map(group => <section key={group.title}><h3>{group.title}</h3><dl>{group.items.map(([icon, label, keys]) => <div key={label}><dt><Icon name={icon} size={16} />{label}</dt><dd><kbd>{keys}</kbd></dd></div>)}</dl></section>)}</div>
        <section className="shortcut-apps"><h3>Go directly to an app</h3><div>{APP_SHORTCUTS.map((id, index) => <button key={id} type="button" onClick={() => onOpenApp(id)}><Icon name={metadata[id].icon} size={18} /><span>{metadata[id].label}</span>{index < 10 && <kbd>⌘{(index + 1) % 10}</kbd>}</button>)}</div></section>
      </div>
      <footer>Drag to a workspace edge to preview tiling. Hold Option to disable snapping.</footer>
    </section>
  </div>;
}
