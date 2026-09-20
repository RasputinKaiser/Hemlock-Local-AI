import React, { useEffect, useRef, useState } from "react";
import { Icon } from "./Icons.jsx";

export async function copyExactText(text, clipboard = globalThis.navigator?.clipboard) {
  if (typeof text !== "string" || !text.trim()) throw new Error("There is no text to copy.");
  if (typeof clipboard?.writeText !== "function") throw new Error("Clipboard access is unavailable. Select the message to copy it manually.");
  await clipboard.writeText(text);
}

export function CopyMessageButton({ text, provenanceText }) {
  const [status, setStatus] = useState("idle");
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (status !== "copied") return undefined;
    const timer = setTimeout(() => setStatus("idle"), 2200);
    return () => clearTimeout(timer);
  }, [status]);
  async function copy(event) {
    setStatus("copying");
    try {
      await copyExactText(event.altKey && provenanceText ? provenanceText : text);
      if (alive.current) setStatus("copied");
    } catch {
      if (alive.current) setStatus("error");
    }
  }
  const label = status === "copied" ? "Copied" : status === "copying" ? "Copying…" : status === "error" ? "Try copy again" : "Copy";
  return <span className="copy-message-control"><button type="button" title="Copy exact message text · Option-click includes provenance" aria-label="Copy message (Option-click to include provenance)" onClick={copy} disabled={!text?.trim() || status === "copying"}><Icon name={status === "copied" ? "check" : status === "error" ? "warning" : "copy"} size={13} />{label}</button><span className={`copy-message-status${status === "error" ? " is-error" : ""}`} role="status" aria-live="polite">{status === "error" ? "Copy failed. Select the message and copy manually." : status === "copied" ? "Copied to clipboard" : ""}</span></span>;
}
