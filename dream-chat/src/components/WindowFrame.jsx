import React from "react";
import { Icon } from "./Icons.jsx";

export function WindowFrame({ windowState, meta, active, dragging, resizing, onFocus, onDragStart, onResizeStart, onResize, onActions, onMinimize, onMaximize, onClose, children }) {
  // The dock is the only minimized representation: no hidden body, titlebar, or
  // focusable descendants should remain in the workspace/accessibility tree.
  if (!windowState || ["closed", "minimized"].includes(windowState.state)) return null;
  const id = windowState.windowId;
  const maximized = windowState.state === "maximized";

  // Keep zOrder applied even when maximized: a maximized window must still stack above
  // other open windows, and dropping zIndex lets DOM order decide the paint order.
  const style = {
    ...(maximized ? {} : {
      left: `${windowState.bounds.x}px`,
      top: `${windowState.bounds.y}px`,
      width: `${windowState.bounds.width}px`,
      height: `${windowState.bounds.height}px`,
      minWidth: `${Math.min(windowState.minimumSize.width, windowState.bounds.width)}px`,
      minHeight: `${Math.min(windowState.minimumSize.height, windowState.bounds.height)}px`,
    }),
    zIndex: windowState.zOrder,
  };
  const resizeEdges = ["top-left", "top", "top-right", "left", "right", "bottom-left", "bottom", "bottom-right"];
  const raiseWindow = () => { if (!active) onFocus(id); };
  const primaryPointer = (event) => event.button === 0 && event.isPrimary !== false;
  function resizeWithKeyboard(event, edge) {
    if (!onResize || event.metaKey || event.ctrlKey || event.altKey) return;
    const step = event.shiftKey ? 50 : 10;
    const dx = /left|right/.test(edge) ? ({ ArrowLeft: -step, ArrowRight: step }[event.key] || 0) : 0;
    const dy = /top|bottom/.test(edge) ? ({ ArrowUp: -step, ArrowDown: step }[event.key] || 0) : 0;
    if (!dx && !dy) return;
    event.preventDefault();
    event.stopPropagation();
    onResize(id, edge, dx, dy);
  }
  return (
    <section
      className={`os-window window-${id} ${active ? "is-active" : ""} ${maximized ? "is-maximized" : ""} ${dragging ? "is-dragging" : ""} ${resizing ? "is-resizing" : ""}`}
      style={style}
      aria-label={meta.label}
      onPointerDownCapture={(event) => { if (primaryPointer(event)) raiseWindow(); }}
      onFocusCapture={raiseWindow}
    >
      <header className="window-bar" onPointerDown={(event) => { if (primaryPointer(event)) onDragStart(event, id); }} onDoubleClick={() => onMaximize(id)} onContextMenu={(event) => { if (!onActions) return; event.preventDefault(); onActions(id, event.currentTarget.querySelector('.window-actions-trigger')); }}>
        <div className="window-title">
          <span className={`window-glyph glyph-${meta.tone || "green"}`}><Icon name={meta.icon} size={14} /></span>
          <strong>{meta.label}</strong>
          {meta.status && <span className="window-status">{meta.status}</span>}
        </div>
        <div className="window-controls" onPointerDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
          {onActions && <button type="button" className="window-actions-trigger" onClick={(event) => onActions(id, event.currentTarget)} aria-label={`Window actions for ${meta.label}`} aria-haspopup="menu" title="Window actions · tile, center, resize"><Icon name="more" size={17} /></button>}
          <button type="button" onClick={() => onMinimize(id)} aria-label={`Minimize ${meta.label}`} title="Minimize · ⌘⌥M"><Icon name="minimize" size={15} /></button>
          <button type="button" onClick={() => onMaximize(id)} aria-label={`${maximized ? "Restore" : "Maximize"} ${meta.label}`} title={maximized ? "Restore size · ⌘⌥↓" : "Fill workspace · ⌘⌥↑"}><Icon name={maximized ? "restore" : "maximize"} size={15} /></button>
          <button type="button" onClick={() => onClose(id)} aria-label={`Close ${meta.label}`} title="Close window · ⌘⌥W"><Icon name="close" size={16} /></button>
        </div>
      </header>
      <div className="window-body">{children}</div>
      {!maximized && resizeEdges.map((edge) => <button
        key={edge}
        type="button"
        className={`window-resize-handle resize-${edge}`}
        tabIndex={onResize ? 0 : -1}
        onPointerDown={(event) => {
          event.stopPropagation();
          if (!primaryPointer(event)) return;
          onResizeStart(event, id, edge);
        }}
        onKeyDown={(event) => resizeWithKeyboard(event, edge)}
        aria-label={`Resize ${meta.label} from ${edge}`}
        aria-description={onResize ? "Use arrow keys to resize by 10 pixels, or Shift and arrow keys for 50 pixels." : undefined}
      />)}
    </section>
  );
}
