import { useEffect, useMemo, useRef, useState } from "react";

import { GROVE_ROSTER, bindGrove, bindingRows } from "../groveBindings.js";
import { Icon } from "./Icons.jsx";

function relativeAge(ageMs) {
  if (!Number.isFinite(ageMs)) return "never";
  if (ageMs < 5000) return "now";
  if (ageMs < 60000) return `${Math.round(ageMs / 1000)}s ago`;
  if (ageMs < 3600000) return `${Math.round(ageMs / 60000)}m ago`;
  return `${Math.round(ageMs / 3600000)}h ago`;
}

// The grove is an ambient window, not a dashboard: the paper rail on the right
// keeps every animated claim inspectable against the real event spine.
export default function GroveSurface({ events, isDesktop, seed, markers }) {
  const canvasRef = useRef(null);
  const sceneRef = useRef(null);
  const [sceneReady, setSceneReady] = useState(false);
  const [sceneError, setSceneError] = useState(null);
  const [sceneSlow, setSceneSlow] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const [tick, setTick] = useState(0);

  const bound = useMemo(() => bindGrove(events, { markers }), [events, markers]);
  const rows = useMemo(() => bindingRows(events), [events, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const reducedMotion = useMemo(() => window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false, []);

  useEffect(() => {
    let cancelled = false;
    import("../groveScene.js")
      .then((module) => {
        if (cancelled || !canvasRef.current) return;
        return module.createGroveScene(canvasRef.current, { roster: GROVE_ROSTER, reducedMotion, seed }).then((scene) => {
          if (cancelled) { scene.dispose(); return; }
          sceneRef.current = scene;
          setSceneReady(true);
        });
      })
      .catch((error) => { if (!cancelled) setSceneError(error); });
    return () => {
      cancelled = true;
      sceneRef.current?.dispose();
      sceneRef.current = null;
    };
  }, [reducedMotion, seed]);

  useEffect(() => {
    if (sceneReady) sceneRef.current?.applyState(bound);
  }, [bound, sceneReady]);

  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 15000);
    return () => clearInterval(timer);
  }, []);

  // Loading honesty: if the 3D module is still waking after a while, say so —
  // and point at the bindings rail, which is already live without the scene.
  useEffect(() => {
    if (sceneReady || sceneError) return undefined;
    const timer = setTimeout(() => setSceneSlow(true), 12000);
    return () => clearTimeout(timer);
  }, [sceneReady, sceneError]);

  const telemetry = bound.telemetry;
  const ambience = bound.ambience;
  const skyNote = ambience
    ? [ambience.dream > 0.15 ? "dream aurora" : null, ambience.alert > 0.15 ? "failure ash" : null].filter(Boolean).join(" · ")
    : "";

  return <div className="grove-shell">
    <div className="grove-stage">
      <canvas ref={canvasRef} className="grove-canvas" aria-label="Understory grove — ambient view of local models bound to real events" />
      {sceneError && <div className="grove-overlay grove-error" role="status">
        <Icon name="warning" size={16} />
        <p>The grove could not start in this renderer ({String(sceneError.message || sceneError)}). Bindings remain accurate below.</p>
      </div>}
      {!sceneReady && !sceneError && <div className="grove-overlay"><span className="grove-loading">{sceneSlow ? "still waking the 3D scene — the bindings rail is already live" : "waking the understory…"}</span></div>}
      {!isDesktop && <div className="grove-banner" role="note">
        <Icon name="info" size={14} /> Ambient preview — live bindings need the Electron desktop. The roster is real; nothing here is simulated activity.
      </div>}
      <div className="grove-legend" aria-hidden="true">
        <span><i className="grove-dot grove-dot-firefly" /> inference</span>
        <span><i className="grove-dot grove-dot-lab" /> experiments</span>
        <span><i className="grove-dot grove-dot-graft" /> dream growth</span>
        <span><i className="grove-dot grove-dot-bloom" /> memory</span>
        {bound.markers.length > 0 && <span><i className="grove-dot grove-dot-marker" /> markers</span>}
        <span><i className="grove-dot grove-dot-ember" /> failure</span>
      </div>
      <button type="button" className="grove-panel-toggle" onClick={() => setPanelOpen((open) => !open)} aria-expanded={panelOpen} aria-label={panelOpen ? "Hide bindings" : "Show bindings"}>
        <Icon name={panelOpen ? "chevronRight" : "chevronLeft"} size={15} /> bindings
      </button>
    </div>
    {panelOpen && <aside className="grove-bindings" aria-label="Grove bindings — what the world shows and why">
      <div className="grove-bindings-head">
        <span className="cockpit-kicker">RESIDENTS</span>
        {telemetry && <span className="grove-tps" title={`Last inference: ${telemetry.mode || "conversation"}`}>tok/s {telemetry.tokensPerSecond?.toFixed(1) ?? "—"}{telemetry.cacheHitRatio != null && <em> · cache {Math.round(telemetry.cacheHitRatio * 100)}%</em>}</span>}
      </div>
      {skyNote && <div className="grove-lab-readout">
        <span className="cockpit-kicker">SKY</span>
        <strong>{skyNote}</strong>
        <small>ambient state bound to recent dream/failure events</small>
      </div>}
      {bound.experiments.length > 0 && <div className="grove-lab-readout" title={bound.experiments.at(-1).id}>
        <span className="cockpit-kicker">LAB REPLAY</span>
        <strong>{bound.experiments.at(-1).experiment}</strong>
        <small>
          {bound.experiments.at(-1).trail.points.length} measured samples
          {bound.experiments.at(-1).divergence != null && <> · Δ {(bound.experiments.at(-1).divergence * 100).toFixed(2)}%</>}
          {" · "}{relativeAge(Math.max(0, Date.now() - bound.experiments.at(-1).at))}
        </small>
      </div>}
      {bound.markers.length > 0 && <div className="grove-lab-readout grove-marker-readout">
        <span className="cockpit-kicker">MARKERS</span>
        <div className="grove-marker-list">
          {bound.markers.slice().reverse().map((marker) => <strong key={marker.id} title={marker.note || marker.label}>
            {marker.label} <em>{marker.kind}{marker.seededPosition ? " · seeded" : ""}</em>
          </strong>)}
        </div>
        <small>{bound.markers.length} placed — persisted in the world marker ledger{bound.markers.length > 6 ? " · scroll the rail" : ""}</small>
      </div>}
      <ul className="grove-roster">
        {rows.map((row) => <li key={row.id} className={row.activity > 0.3 ? "is-lit" : ""} role="button" tabIndex={0}
          title="Visit in the grove"
          onClick={() => sceneRef.current?.focusOn?.(row.id)}
          onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); sceneRef.current?.focusOn?.(row.id); } }}>
          <div className="grove-entity-head">
            <strong>{row.name}</strong>
            <span className="grove-activity" style={{ "--level": row.activity }} title={row.lastEvent ? `${row.lastEvent.type} · ${relativeAge(row.lastEvent.ageMs)}` : "no events this session"} />
          </div>
          <small className="grove-entity-role">{row.role}</small>
          <dl>
            <div><dt>form</dt><dd>{row.params}</dd></div>
            <div><dt>weights</dt><dd>{row.dtype}</dd></div>
            <div><dt>source</dt><dd className="grove-path">{row.directory}</dd></div>
            <div><dt>last event</dt><dd>{row.lastEvent ? <>{row.lastEvent.type} <em>{relativeAge(row.lastEvent.ageMs)}</em></> : "none yet"}</dd></div>
            {row.gathered && <div><dt>status</dt><dd className="grove-grown">gathered at the lab</dd></div>}
            {row.graft && <div><dt>graft</dt><dd className={row.graft.status === "failed" ? "grove-ember" : "grove-grown"}>{row.graft.status} · {row.graft.type}</dd></div>}
          </dl>
        </li>)}
      </ul>
      <p className="grove-honesty">The scene is ambient. Every light, graft, and bloom above is bound to a real event from this session — receipts remain the source of truth.</p>
    </aside>}
  </div>;
}
