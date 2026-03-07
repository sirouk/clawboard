# Clawboard Design Rules

This document captures the durable product, UX, and implementation rules the repo should keep obeying as the system evolves.

## 1) Product North Star
- Clawboard is the operator-facing continuity layer for an OpenClaw instance.
- The operator should be able to answer "What is happening, where should I continue, and what already happened?" in under 10 seconds.
- Structure wins over raw transcript volume: Topic -> Task -> timeline is the primary mental model.
- The product should feel like a live control surface, not a passive log archive.

## 2) Unified View Is the Primary Surface
- `/u` is the default route and the main place operators work.
- Topics are the hierarchy container.
- Tasks are the actionable continuity unit.
- Timeline/chat detail is subordinate to the selected task.
- Supporting pages such as Logs, Stats, Setup, Providers, and Graph must have direct URLs, but they do not replace Unified View as the primary operating surface.

## 3) One-Box Composer Contract
- Unified View has one specialized top composer, not separate "search" and "send" inputs.
- Typing a draft message should also surface potential topic/task matches.
- The draft message remains the source of truth; search is advisory, not a separate state machine.
- No selection means `new topic -> new task`.
- Selecting a topic means `topic -> new task`.
- Selecting a task means `topic -> continue existing task`.
- The current send target must always be visible as a chip/pill inside the composer.
- The send button label must mirror the current action (`Start new topic`, `New task in topic`, `Continue task`, etc.).
- `Enter` sends. `Shift+Enter` inserts a newline. The textarea auto-grows naturally.

## 4) Search and Match Surfacing
- The typing state should reveal likely continuation targets without hijacking the operator's draft.
- Search results must preserve hierarchy clarity: show topics as containers and tasks as the continuable units inside them.
- When the operator is typing, matching topics should expand automatically so relevant tasks are visible without extra clicks.
- Semantic search is allowed to broaden recall, but only high-confidence semantic matches should be surfaced as explicit UI candidates.
- Internal ranking jargon is never user-facing. Copy should say `smart search` or equivalent, not backend stack names.
- Search UI should help the operator choose a destination, not re-filter the whole product into noise.

## 5) Topic and Task Interaction Rules
- Topics are created through conversation flow and resolver logic, not through a separate "create topic" management form.
- Tasks can be created inline inside a topic.
- Tasks can be moved between topics.
- Move/edit actions must stay inline and lightweight; avoid full-width management forms when a compact control works.
- Tasks and topics can be pinned, and pinning should read as a stable prioritization tool rather than a hidden sort hack.
- Topic/task cards should make hierarchy obvious even when content is collapsed.

## 6) Task Chat Rules
- Task chat is a pinned session, not an ambiguous thread guess.
- On desktop, task chat should feel anchored to the task card and stay visually connected to that task.
- On mobile, task chat becomes a fullscreen layer with:
  - a clear close affordance
  - visible topic/task context
  - a readable status control
  - an anchored bottom composer
- Exiting mobile fullscreen should return the operator to the board cleanly without losing state.

## 7) Timeline and Readability
- Timeline remains newest-first, with real timestamps preserved.
- Expand/collapse affordances should be obvious and large enough to hit reliably.
- Summaries are the default compact mode.
- Raw content should be available on demand but not overwhelm the default board state.
- Tool/system noise should never dominate conversational continuity in the default operator view.

## 8) Realtime and State
- Live updates should arrive via SSE/reconcile, not blind polling.
- UI state must converge incrementally and predictably under reconnects.
- URL state is for navigational state, not unsent draft text.
- Browser API access should default to same-origin proxy behavior unless the operator explicitly overrides the API base.
- No state boundary should make an in-flight run feel invisible or untrustworthy.

## 9) Minimal UI Noise
- Status pills must be visually distinct from action buttons.
- Remove duplicate controls and duplicated explanations.
- Every visible control needs a clear job.
- Supporting metadata is good when it helps routing or triage; it is noise when it repeats the obvious.

## 10) Accessibility and Input Quality
- Click targets for core actions must be comfortably large.
- Keyboard usage should work for primary board actions.
- Focus, active, disabled, and hover states must remain visible in dark mode.
- Mobile layouts must be first-class, not desktop layouts squeezed smaller.

## 11) Visual System
- The product should stay dark, crisp, and high-contrast.
- Accent color is for action and attention, not decoration everywhere.
- Color should help distinguish topics/tasks/status without turning the board into visual static.
- Motion should be subtle and functional.
- Components should feel intentionally designed, not generic control-library defaults.

## 12) Source of Truth and API Ownership
- FastAPI is the canonical business API.
- Next.js API routes are compatibility/proxy surfaces, not competing sources of business logic.
- UI behavior should reflect backend contracts exactly, especially around routing, scope, and cancellation.

## 13) Documentation and Testing
- Core docs should describe the live contracts, not the historical implementation debates.
- Duplicated companion docs should be merged or archived once the canonical doc absorbs them.
- One-off test reports do not belong in the root once their lessons are captured in `TESTING.md` or the core specs.
- Significant UI or routing changes require lint, typecheck, and targeted Playwright coverage.

## 14) Security and Privacy
- Never store secrets or personal data in repo docs, fixtures, or examples.
- If sensitive data appears anywhere, scrub it immediately.
- Public repo safety is a standing requirement, not a release-only concern.
