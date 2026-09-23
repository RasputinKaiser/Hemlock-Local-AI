import React from "react";
import { Icon } from "./Icons.jsx";

// Per-window error boundary: a render crash inside one window degrades to an
// inline card instead of unmounting the whole OS shell. Reload remounts the
// window content; if the renderer keeps throwing, the card comes back.
export class WindowBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
    this.reload = () => this.setState({ error: null });
    this.lastReport = { key: "", at: 0 };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    const componentStack = String(info?.componentStack || "");
    console.error(`[hemlock] window "${this.props.windowId || "unknown"}" render crashed:`, error, componentStack);
    // Render crashes are durable receipts, not console noise: the host writes
    // a renderer.error event onto the same spine everything else lands on.
    const component = componentStack.match(/at ([A-Z][A-Za-z0-9]*)/)?.[1] || "unknown";
    const report = {
      component,
      message: String(error?.message || error || "render crashed").slice(0, 1000),
      stack: `${String(error?.stack || "")}\n${componentStack}`.slice(0, 2048),
      windowId: String(this.props.windowId || ""),
    };
    if (typeof window === "undefined") return;
    // Identical crash loops (same component, same message) report once a
    // minute — the host dedupes too, so this is belt-and-suspenders.
    const key = `${component}|${report.message}`;
    const now = Date.now();
    if (key === this.lastReport.key && now - this.lastReport.at < 60000) return;
    this.lastReport = { key, at: now };
    const send = window.mapleDesktop?.reportRendererError || window.hemlockAgent?.reportRendererError;
    Promise.resolve(send?.(report)).catch(() => {});
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="window-boundary-card" role="alert">
        <span className="window-boundary-glyph"><Icon name="warning" size={20} /></span>
        <div className="window-boundary-copy">
          <strong>{this.props.label || "This window"} hit an error</strong>
          <p>{String(error?.message || error)}</p>
        </div>
        <button type="button" className="primary-action" onClick={this.reload}>Reload window</button>
      </div>
    );
  }
}
