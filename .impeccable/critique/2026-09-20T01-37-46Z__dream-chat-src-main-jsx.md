---
target: HemlockOS GUI critique and audit
total_score: 25
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 4
timestamp: 2026-09-20T01-37-46Z
slug: dream-chat-src-main-jsx
---
Method: dual-agent (A: sa-0-60c4faa1 · B: sa-1-8606ec24)

# HemlockOS critique and audit — pre-fix baseline

Target: dream-chat/src/main.jsx and the full desktop workspace. Mode: Operate. User explicitly authorized broad assessment plus implementation, including layout, spacing, sizing, resizing and navigation. These scores describe the reviewed baseline, not the subsequent fixes.

## Design specificity verdict

Authored and product-specific: forest chrome, warm paper, serif/mono typography, managed windows, and model/host separation establish Hemlock's identity. Preserve those foundations. The idle dashboard hierarchy and compact-space allocation undermine the promised OS experience.

## Design health

| Heuristic | Score /4 | Key issue |
|---|---:|---|
| System status | 2 | Idle, unconfigured, checking and ready need distinct language |
| Familiar language | 2 | Continue task before meaningful work exists |
| User control | 3 | Compact inspector dismissal/focus gaps |
| Consistency | 3 | Sidebar changes to blocking overlay without appropriate interaction behavior |
| Error prevention | 3 | Good approval boundaries; unavailable preview actions fail after clicking |
| Recognition | 3 | Three inventories repeat apps without sufficient priority |
| Efficiency | 3 | Useful window controls; compact reading space too small |
| Visual hierarchy | 2 | Idle monitors and composer metadata compete with work |
| Error recovery | 2 | Some errors state boundaries without actionable recovery |
| Help | 2 | Vocabulary before first-success guidance |
| **Total** | **25/40** | **Acceptable — significant usability work remains** |

## Technical audit

| Dimension | Score /4 | Key issue |
|---|---:|---|
| Accessibility | 2 | Verified contrast failures and concealed focus |
| Performance | 3 | Bounded idle measurement is quiet; streaming not benchmarked |
| Responsiveness | 2 | Inspector blocks composer; text scaling starves transcript |
| Theming | 2 | Fixed workbench colors bypass understory tokens |
| Implementation integrity | 2 | Static training curve appears like measured evidence |
| **Total** | **11/20** | **Acceptable — significant work needed** |

## Overall impression and strengths

The desktop has genuine working foundations but passing bounds tests did not establish hit-test reachability. Preserve (1) forest/paper identity, (2) exact model output separated from host evidence, and (3) real keyboard resizing, minimize/restore and reversible close-warning opt-out.

## Consolidated priorities

1. **P1 — Inspector obstructs Send.** Build auto-opens an overlay across composer controls at the default 880x640 window. Hit-testing confirms interception; Escape from the opener fails. Keep the composer outside compact inspection geometry, stop auto-opening on mode changes, and manage focus/Escape/outside-click. Suggested commands: harden/adapt. Sources: main.jsx inspector and styles.css compact rail; assessment A interaction-checks.json and B confirmed-interactions.json.
2. **P1 — Conversation space is starved.** At 520x480 the transcript is 134px versus a 209px composer; at the 760x620 desktop transcript is 100px. A text-only 200% stress test reduces it to 40px. Consolidate chrome, grow the draft input as needed, disclose secondary context, guarantee a reading floor and allow overflow to remain reachable. Suggested command: layout/adapt.
3. **P1 — First run lacks a clear starting point.** Empty telemetry, lifecycle vocabulary and Continue task dominate before real work. Add an idle task-first home with Chat, model configuration and genuine recent work; retain rich active/blocked views. Suggested command: onboard/distill.
4. **P1 — Verified text contrast failures.** Thread ready label is 1.72:1 paper and 1.39:1 understory. Timestamp 1.99:1, objective supporting copy 3.48:1, active lifecycle label 3.89:1. All require 4.5:1. Scope paper metadata/status tokens correctly and verify computed colors in both themes. Suggested command: colorize.
5. **P2 — Navigation and Settings lack task hierarchy.** Eleven dock choices compete; catalog repeats in overview and palette. Settings is a 374px viewport over 1613px content with model setup interleaved with scheduler/training. Prioritize frequent/open windows, group the full library, stabilize numeric shortcuts, and split Settings into Models/accounts, Workspace, Context/memory and Advanced/runtime. Suggested commands: shape/distill.
6. **P2 — Theme and information integrity gaps.** Large paper surfaces bypass understory tokens, essential state labels remain 9px, and Dream shows hard-coded loss polylines with no visible illustration disclosure. Use semantic surfaces, readable functional metadata, and honest empty training observations instead of decorative evidence. Suggested commands: colorize/typeset/clarify.

## Cognitive load and personas

Assessment A marked five of eight cognitive checks failed: single focus, chunking, hierarchy, one-thing-at-a-time, and minimal choices. Grouping, working memory support and general progressive disclosure were strengths. Alex/power users hit an obstructed Build action and cramped transcript; Jordan/new users decode an idle cockpit and scattered setup; Sam/keyboard-low-vision users face concealed focus and pale small status text.

## Detector evidence and limits

CLI markup scan returned zero findings. Runtime detector produced 774 raw occurrences across Center/Chat/Dream: repeated elements, intentional occlusion of inactive windows, pinned brand treatments and generic font thresholds explain many. They are not 774 independent bugs. The confirmed technical audit consolidates six issues (0 P0, 2 P1, 4 P2). Runtime injection and overlay DOM succeeded, but user-visible browser presentation was not established; no live user overlay is claimed. Helper was stopped and existing dev server preserved. No inference, training or real conversation changes were used in the assessment.

## Minor observations

Browser preview footer incorrectly claims Electron Runtime; project directory is hidden in Build; role=badge is invalid; stacked optional browser preview does not scroll a newly focused window into view. Fix these within the broad pass.

## Direction resolved by user authorization

The user has already requested broad fixes, not an assessment-only deliverable. Proceed with task-first home, a leaner nonblocking Chat layout, frequent/current-work navigation, grouped Settings and honest readable system states. Do not reopen the already confirmed scope or visual identity. No post-fix score is assigned without a separate assessment.

Detailed independent evidence: work/gui-assessment-a/assessment-a.md and work/gui-assessment-b/REPORT.md.
