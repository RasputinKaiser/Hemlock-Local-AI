# Hemlock Chat/Code visual QA

Result: `passed`

## Inputs

- Reference screenshot: `/var/folders/70/37y2xd0n6vbf04fw178_zy9h0000gn/T/codex-clipboard-ceb2cc55-62fe-4518-b104-6f24131442e7.png` (2880 × 1632)
- Live implementation capture: `/tmp/hemlock-chat-polish-final-state.png` (2880 × 1800)
- Surface: Electron `Chat / Code`, active task, approved plan, host activity collapsed, Vite hot-reloaded and then hard-reloaded before capture.

## Comparison

- Hierarchy: the transcript is the primary reading surface. The repeated task objective is reduced to a compact context line, while the thread bar remains the durable conversation identity.
- Conversation readability: user messages use a bounded centered measure; Maple output is no longer presented as a large dashboard card, so prose and visible reasoning channels can read as one continuous chat stream.
- Progressive disclosure: host activity and full trace sit in a separate collapsed rail; the approved plan remains a one-row collapsed dock with an explicit Expand plan control. Waiting-for-approval plans still open and keep Approve plan reachable.
- Spatial stability: the transcript owns the scrolling surface and follows only when the reader is near the bottom. The host rail, plan, work-mode controls, and composer are outside that scroll region and remain anchored. Expanded host detail is bounded to a short inspector with its own scroll, so it cannot cover the transcript.
- Visual language: the existing Newsreader, DM Sans, DM Mono, forest/cream/gold palette, status lamps, and iconography are preserved; the pass changes measure, density, and disclosure rather than introducing unrelated decoration.
- Privacy: the captured workspace label is `~/Code/Hemlock`; the macOS account name is not rendered.

## Notes

The capture was taken with the existing Electron workspace bounds, so the surrounding Hemlock shell remains visible behind the Chat/Code window. The Chat/Code surface itself was evaluated at the live desktop viewport and remains usable at both the supplied fullscreen composition and its current persisted windowed bounds. No generated image asset was needed for this pass.

## Regression checks

- UI tests: 17 passed
- Agent tests: 81 passed
- Vite build: passed
- Electron syntax check: passed
- `git diff --check`: passed
