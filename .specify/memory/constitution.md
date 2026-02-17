# Ralphie Constitution

## Purpose
- Establish deterministic, portable, and reproducible control planes for autonomous execution.
- Define behavior for all phases from planning through documentation.

## Governance
- Keep artifacts machine-readable: avoid local absolute paths, avoid command transcript leakage, and keep logs deterministic.
- Never skip consensus checks or phase schema checks.
- Treat gate failures as actionable signals, not terminal failure if bounded retries remain.

## Phase Contracts
- **Plan** produces research artifacts, an explicit implementation plan, and a deterministic stack snapshot.
- **Build** executes plan tasks against evidence in IMPLEMENTATION_PLAN.md and validates build schema.
- **Test** verifies behavior changes and records validation evidence.
- **Refactor** preserves behavior, reduces complexity, and documents rationale.
- **Lint** enforces deterministic quality and cleanup policies.
- **Document** closes the lifecycle with updated user-facing documentation.

## Recovery and Retry Policy
- Every phase attempt that fails schema, consensus, or transition checks is retried within
  `PHASE_COMPLETION_MAX_ATTEMPTS` using feedback from prior blockers.
- Hard stop occurs only after bounded retries are exhausted and gate feedback is persisted.

## Evidence Requirements
- Each phase writes machine-readable completion signal `<promise>DONE</promise>`.
- Plan/build/test/refactor/lint/document outputs must be reviewed by consensus and schema checks before transition.

## Environment Scope
- Repository-relative paths and relative markdown links are preferred.
- External references are allowed only when version/risk tradeoffs are explicitly documented.
