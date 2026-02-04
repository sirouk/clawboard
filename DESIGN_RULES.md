# Clawboard Design Rules (SOTA)

This document captures durable product, UX, and engineering rules learned during the build. It is intentionally generic and contains no personal or customer data.

## 1) Product North Star
- Clawboard is a companion “side‑brain” for an OpenClaw instance.
- All conversations and actions are captured and organized by topic, with tasks and a continuous timeline.
- No thread management for the user. Topics are the primary navigation surface.
- The user must always be able to answer: **“Where did I leave off?”** in under 10 seconds.

## 2) Unified View Is the Primary Surface
- Unified View is the default route and main navigation destination.
- Topics expand to tasks; tasks expand to timeline entries.
- All other views (Dashboard, Stats, Setup, Providers) are supporting pages with their own URLs.
- If a page can be visited, it must have a direct URL and be back/forward friendly.

## 3) Timeline Readability & Controls
- Timeline is newest‑first, but true timestamps are preserved.
- Only the most recent date group is expanded by default; older groups collapsed.
- Expanding/collapsing is done by clicking the row anywhere (not tiny buttons).
- Use carets for expand/collapse, not “Expand/Collapse” text.
- Provide a **Show raw / Show summaries** toggle for prompt inspection.
- Summaries are shown by default; full prompts available on demand.

## 4) Tasks & Topics
- Topics are auto‑created by the agent; users do not manually create topics.
- Tasks can be moved between topics.
- Move is an inline control (button → dropdown + Cancel), not a full-width select.
- Tasks and topics can be pinned (pin icon toggle, not a text label).
- Sort topics by pinned first, then by last activity descending.

## 5) Minimal UI Noise
- Status chips (To Do / Doing / Blocked / Done) must be visually distinct from buttons.
- Avoid “button‑looking” styles for non-interactive status pills.
- Remove redundant controls (e.g., duplicated show/hide buttons).
- Collapsed nav shows icons only; expanded nav shows text + icons.

## 6) Navigation & History
- All expansion states are reflected in URL state.
- Back/forward restores expansion state and scroll position when possible.
- URL paths should use clean slugs (not long query strings).

## 7) Real‑Time Updates (SSE)
- UI updates must be live without refresh.
- SSE only (no periodic polling), with:
  - `Last-Event-ID` replay
  - reconcile-on-reconnect (`/api/changes?since=`)
- No frantic re-renders: updates should be incremental and stable.

## 8) Data Source of Truth
- UI always reads from the API/database.
- No default or personal data in the runtime store.
- Demo/test data only loads via explicit test/seed commands.
- Keep fixtures fully generic and robust.

## 9) API & Docs
- FastAPI provides the canonical API (Next.js does NOT host API routes).
- `/docs` must show full schemas with required/optional fields and examples.
- Endpoints must be idempotent where applicable (upsert, log append with source IDs).

## 10) Accessibility & Interaction
- Large click targets for expandable rows.
- Keyboard support for expand/collapse where applicable.
- Focus and hover states must be visible in dark mode.

## 11) Visual System (OpenClaw‑adjacent)
- Dark, crisp base; controlled accent usage.
- Accent color only for actions/attention; minimize overuse.
- Consistent spacing, cards, and typography across pages.
- Animations should be subtle and functional (no gimmicks).

## 12) Security & Privacy
- Never store secrets or personal data in repo, fixtures, or logs.
- If sensitive data appears, scrub it immediately.
- Do not ship personal references in docs, examples, or default data.

## 13) Quality Bar
- No bandaids. Prefer clean architecture and stable state management.
- Every UI element must have a clear purpose.
- Run lint + full test suite after significant changes.

