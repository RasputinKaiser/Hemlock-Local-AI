import React, { useLayoutEffect, useRef, useState } from "react";
import { Icon } from "./Icons.jsx";
import { windowMenuItems } from "../windowActions.js";
import "./workspace-controls.css";

export function WindowActionsMenu({ label, state, anchor, opener, onAction, onDismiss }) {
  const root = useRef(null);
  const [position, setPosition] = useState(null);
  const items = windowMenuItems(state);
  useLayoutEffect(() => {
    const place = () => {
      const bounds = root.current.getBoundingClientRect();
      const left = Math.max(8, Math.min(anchor.x, window.innerWidth - bounds.width - 8));
      const requestedTop = anchor.placement === "below" ? anchor.y + 5 : anchor.y - bounds.height - 5;
      const top = Math.max(8, Math.min(requestedTop, window.innerHeight - bounds.height - 8));
      setPosition({ left, top });
    };
    place();

    window.addEventListener("resize", place);
    return () => { window.removeEventListener("resize", place); if (opener?.isConnected) opener.focus(); };
  }, [anchor.x, anchor.y, anchor.placement, opener]);
  const placed = position !== null;
  useLayoutEffect(() => { if (placed) root.current.querySelector('button:not([disabled])')?.focus(); }, [placed]);
  function navigate(event) {
    const buttons = [...root.current.querySelectorAll('button:not([disabled])')];
    const current = buttons.indexOf(document.activeElement);
    if (event.key === "Escape" || event.key === "Tab") { event.preventDefault(); event.stopPropagation(); onDismiss(); return; }
    const target = event.key === "ArrowDown" ? (current + 1) % buttons.length
      : event.key === "ArrowUp" ? (current - 1 + buttons.length) % buttons.length
        : event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
          : event.key.length === 1 && !event.metaKey && !event.ctrlKey ? buttons.findIndex((button, index) => index > current && button.textContent.trim().toLowerCase().startsWith(event.key.toLowerCase())) : -1;
    if (target >= 0) { event.preventDefault(); event.stopPropagation(); buttons[target]?.focus(); }
  }
  return <div className="window-actions-backdrop" onPointerDown={onDismiss} onContextMenu={event => { event.preventDefault(); onDismiss(); }}>
    <div ref={root} className="window-actions-menu" style={{ left: position?.left || 8, top: position?.top || 8, visibility: position ? "visible" : "hidden" }} role="menu" aria-label={`${label} actions`} onPointerDown={event => event.stopPropagation()} onKeyDown={navigate}>
      <div className="window-actions-heading">{label}</div>
      {items.map(item => <button type="button" role="menuitem" key={item.id} disabled={item.disabled} className={item.destructive ? "is-destructive" : undefined} onClick={() => onAction(item.id)}><Icon name={item.icon} size={17} /><span>{item.label}</span>{item.shortcut && <kbd>{item.shortcut}</kbd>}</button>)}
    </div>
  </div>;
}
