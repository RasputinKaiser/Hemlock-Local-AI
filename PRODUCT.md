# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Electron + React (Vite build) desktop app in `dream-chat`; plain CSS with shared styles and scoped component styles, main process in CommonJS (`electron/main.cjs`). Local MLX inference via a bundled mlx_lm Python server; provider lanes (Codex, Claude) via CLIs. No UI framework, no CSS-in-JS, no component library.

## Users

Primary: RasputinKaiser — developer and builder working locally on a 16 GB Apple Silicon Mac. HemlockOS is a local AI workstation for chatting with models, running bounded agent tasks, building artifacts, and managing local memory/training. Secondary (future): public/open-source users — the app should remain legible and installable beyond its author, with copy that does not assume insider context. Public-facing identity uses RasputinKaiser, not the owner's personal name.

## Product Purpose

HemlockOS is a local-first AI desktop environment ("the model lives in the GUI, not a VM"): a coherent workspace for conversing with, directing, and inspecting models; following host actions and their evidence; building artifacts; and managing local knowledge. Success means completing these jobs without losing the conversation, the work, or one's place in the workspace. It should behave like an operating environment rather than a dashboard decorated with window borders.

## Positioning

Model-verbatim trust architecture: the app never paraphrases model output. Model channels render verbatim beside host-owned evidence, actions, receipts, and telemetry, with durable thread state (checkpoints, JSONL conversations, registry) that survives restarts. A neighboring chat shell could not truthfully claim this separation.

## Operating Context

- Runs as a desktop app on macOS (Electron), launched via scripts/launch-hemlock.zsh or Hemlock.app; prod UI loads the built dist/ bundle.
- Local inference: mlx_lm server on 127.0.0.1:8080 (Maple 2-bit, LFM2.5-8B-A1B-MLX-4bit); per-request model switching with cache clearing.
- Threads persist under ~/Library/Application Support/Hemlock/threads/ (registry.json, conversations/*.jsonl).
- The agent (Hermes) routinely edits the app's source directly; UI must stay live-editable and hot-reloadable (vite build + relaunch).
- 16 GB Mac: memory pressure is real; UI should communicate slow prefills honestly.
- Users move among multiple tools while work continues. Opening, switching, resizing, tiling, minimizing, and restoring windows are core workflows, not decorative affordances.
- The Electron desktop is the primary operating surface. Browser previews support development and verification; they do not imply that every native host capability is available in the browser.

## Capabilities and Constraints

- Chat / Code window: streaming model responses with separate reasoning/content channels, thread bar (create/switch/rename/archive/restore threads, auto-titles), plan approval card, evidence rail, host activity, work mode (Explore/Build).
- Command Center: cockpit overview, heartbeat, events, error surface.
- Artifact Studio: build-mode artifact creation with preview, diff, evidence panels.
- Settings: local server URL/config, readiness checks, subscription provider CLI status (Codex/Claude logins).
- SIPS Control, Memory Garden, Dream Lab (local LoRA training), Activity, Receipts, Project Map.
- Workspace navigation: searchable Windows overview with focused/open/minimized states, direct dock launching, keyboard navigation, and a command palette.
- Managed windows: Command Center and app windows can move and resize; edge placement previews before release; minimize/restore preserves state. Panels adapt to the space available inside their window.
- Conversation-first Chat: composer below the transcript; activity/evidence is secondary and dismissible, with a sidebar or drawer appropriate to the available space.
- Window-close warnings offer a persistent opt-out that can be reversed in Settings. Closing a window preserves its saved state and does not cancel running work; this opt-out does not suppress destructive-operation confirmations.
- Constraints: no cloud dependency for core flows; never fabricate model output; errors must be honest and jargon-free; Electron cannot use window.prompt/confirm — use native dialogs or in-app UI. Keep implementation plain, semantically named, and readily editable by agents.

## Brand Commitments

- Name: Hemlock / HemlockOS (tree glyph, "OS" chip in the header).
- Voice: calm, precise, slightly botanical/naturalist; receipt-and-evidence language ("bounded", "verbatim", "receipts", "understory").
- Typography: Newsreader (serif, display) + DM Mono (labels, metadata) — binding pairing.
- Palette: warm paper background (#fffdf6 family), deep botanical green ink (#2e4e38 family), sage/moss borders, gold accent (#cf9e42), soft cream panels. Light theme only, plus **understory mode**: a persisted night variant that dims the paper family ~12-18% (same hues, lamps turned down) for late-night sessions; toggled from the system bar.
- The botanical identity is established, but incumbent layout, spacing, formatting, sizing, and navigation are not binding templates. The user explicitly permits substantial changes to these when they improve the OS-like experience. Do not preserve dashboard conventions at the expense of usable desktop behavior.

## Evidence on Hand

- Working app with all surfaces implemented (dream-chat/src/main.jsx, styles.css).
- Workspace interaction guide: `docs/gui-workspace.md`.
- Repeatable browser and real-Electron GUI smoke tests: `dream-chat/scripts/gui-smoke.mjs` and `dream-chat/scripts/gui-electron-smoke.mjs`. Native tests use isolated application data; their success does not establish live inference or training quality.
- Rendered workspace screenshots and verification results: `work/gui-refresh-2026-09-19/`. Window-manager and component tests cover resize, focus, state restoration, and keyboard behavior.
- Design critique archive at .impeccable/critique/ (thread management critique, 17/40 baseline).
- No testimonials, press, or marketing assets exist; do not fabricate any.

## Product Principles

1. Model output is verbatim; host interpretation is always labeled and separable.
2. Every consequential action leaves a receipt; nothing is claimed without evidence.
3. Local-first: the machine's models, the machine's data, honest about hardware limits.
4. Work comes first: conversation and artifacts retain useful space; supporting detail is available through honest progressive disclosure, not competing for equal prominence.
5. Desktop coherence: navigation, focus, sizing, resizing, and state restoration should follow a consistent, discoverable operating-system model. Persistent preferences remove repetitive friction without weakening consequential-action boundaries.

## Accessibility & Inclusion

Keyboard-operable controls with visible focus and sensible focus restoration; navigable dock, overview, and command palette; pointer and keyboard resizing; Escape/outside-click dismissal for overlays without cancelling running work; aria-current/aria-expanded on stateful controls; readable metadata sizes (avoid sub-10px text for essential info); color never the sole carrier of state. Hover and keyboard-focus feedback should agree, motion should respect reduced-motion preferences, and compact windows must not hide essential controls.
