import React from "react";
import { Icon } from "./Icons.jsx";

export function WindowFrame({ windowState, meta, active, onFocus, onDragStart, onResizeStart, onMinimize, onMaximize, onClose, children }) {
  if (!windowState || windowState.state === "closed") return null;
  const id = windowState.windowId;
  const maximized = windowState.state === "maximized";
  const minimized = windowState.state === "minimized";
  const style = maximized ? undefined : {
    left: `${windowState.bounds.x}px`,
    top: `${windowState.bounds.y}px`,
    width: `${windowState.bounds.width}px`,
    height: `${windowState.bounds.height}px`,
    minWidth: `${Math.min(windowState.minimumSize.width, windowState.bounds.width)}px`,
    minHeight: `${Math.min(windowState.minimumSize.height, windowState.bounds.height)}px`,
    zIndex: windowState.zOrder,
  };
  const resizeEdges = ["top-left", "top", "top-right", "left", "right", "bottom-left", "bottom", "bottom-right"];
  return (
    <section
      className={`os-window window-${id} ${active ? "is-active" : ""} ${maximized ? "is-maximized" : ""} ${minimized ? "is-minimized" : ""}`}
      style={style}
      aria-label={meta.label}
      onPointerDown={() => onFocus(id)}
    >
      <header className="window-bar" onPointerDown={(event) => onDragStart(event, id)} onDoubleClick={() => onMaximize(id)}>
        <div className="window-title">
          <span className={`window-glyph glyph-${meta.tone || "green"}`}><Icon name={meta.icon} size={14} /></span>
          <strong>{meta.label}</strong>
          {meta.status && <span className="window-status">{meta.status}</span>}
        </div>
        <div className="window-controls" onPointerDown={(event) => event.stopPropagation()}>
          <button type="button" onClick={() => onMinimize(id)} aria-label={`Minimize ${meta.label}`}><Icon name="minimize" size={13} /></button>
          <button type="button" onClick={() => onMaximize(id)} aria-label={`${maximized ? "Restore" : "Maximize"} ${meta.label}`}><Icon name="maximize" size={13} /></button>
          <button type="button" onClick={() => onClose(id)} aria-label={`Close ${meta.label}`}><Icon name="close" size={14} /></button>
        </div>
      </header>
      <div className="window-body">{children}</div>
      {!maximized && resizeEdges.map((edge) => <button key={edge} type="button" className={`window-resize-handle resize-${edge}`} onPointerDown={(event) => { event.stopPropagation(); event.currentTarget.setPointerCapture?.(event.pointerId); onResizeStart(event, id, edge); }} aria-label={`Resize ${meta.label} from ${edge}`} />)}
    </section>
  );
}
