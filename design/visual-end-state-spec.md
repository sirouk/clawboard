# Clawboard Visual Test End-State Spec

## Goal
Create a deterministic visual regression suite that catches UI/UX drift across core routes and high-risk unified-view interaction states on desktop and mobile.

## Scope (End State)
- Route-level visual snapshots exist for:
  - `/u`
  - `/dashboard`
  - `/log`
  - `/graph`
  - `/stats`
  - `/setup`
  - `/providers`
- State-level visual snapshots exist for Unified View:
  - Topic expanded
  - Task expanded with task chat visible
  - Topic chat visible
  - Mobile fullscreen task chat layer
- Visual tests run from a dedicated Playwright config and do not alter existing functional e2e coverage.
- Visual tests use stable, deterministic data (`tests/fixtures/portal.json`) and deterministic rendering controls.

## Defaults Inferred
- Baseline images are committed in-repo under Playwright snapshot folders.
- Local visual coverage runs on Chromium desktop and Chromium mobile by default.
- CI visual coverage runs Chromium desktop/mobile plus WebKit mobile by default.
- Local WebKit visual coverage can be enabled by env flag (`PLAYWRIGHT_VISUAL_WEBKIT=1`).
- Existing functional e2e config remains unchanged.

## Acceptance Criteria
1. `npm run test:visual:update` generates baseline snapshots for all visual tests and projects.
2. `npm run test:visual` passes without updating snapshots.
3. Visual tests fail when a snapshot differs beyond configured thresholds.
4. Snapshot outputs are deterministic across repeated local runs on the same machine.
5. Snapshot naming is platform-neutral so Linux/macOS CI hosts read the same baselines.
6. Existing commands (`npm run test:e2e`, `npm run test`) are not broken by visual-test additions.

## Determinism Rules
- Freeze time for visual tests.
- Disable animations/transitions/caret blink during captures.
- Use deterministic fixture-backed API server.
- Wait for route-specific ready selectors before each capture.

## Unknowns (Flagged)
- If CI/runtime environment changes font rendering engine or antialiasing stack, strict pixel diffs may need threshold tuning.

## Non-Goals
- Replacing functional e2e tests.
- Redesigning product flows.
- Solving all interaction flakes in this change set.
