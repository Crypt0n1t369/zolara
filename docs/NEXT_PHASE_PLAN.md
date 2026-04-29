# Zolara Next Phase Plan — Modular Scalable Distributed Development

_Last updated: 2026-04-29 08:00 Africa/Cairo after the overnight build block._

## Objective
Ship a reliable Telegram-first consensus loop that can be developed by multiple agents/developers without stepping on each other: clear module boundaries, durable lifecycle workers, observable state transitions, and admin/member UX that always says what is blocking progress.

## What Was Actually Built Overnight

### Product Flow / UX
- Admin `/dashboard` exists and now shows onboarding, validation, validation history, rounds, response progress, and recommended next action.
- Admin `/next` gives a short action recommendation without the full dashboard.
- Admin nudge flow exists for stalled/pending members.
- Member `/restart_onboarding` exists and onboarding copy is more explicit about the current answer target.
- Stale onboarding and validation buttons are handled with clearer recovery copy.
- Validation clarification now produces actionable suggested rewrite guidance.
- Admins can submit a refined topic and rerun validation.
- Validation history is surfaced in dashboard/status flows.
- Core Telegram copy was polished across initiation, onboarding, validation, question delivery, and status surfaces.

### Lifecycle / Reliability
- Lifecycle deadline worker was added for validation deadlines and round deadlines/synthesis triggers.
- Redis NX locking was added around lifecycle worker execution.
- LLM, Telegram send, audit, and round transition paths received retry/error hardening.
- Question generation fallback was hardened so a bad LLM output can still produce usable round questions.
- Integration/structural tests were expanded for lifecycle, validation, dashboard, onboarding state, and question fallback behavior.

### Architecture / Modularity
- Telegram Managed Bots API calls were consolidated into `src/telegram/managed-bots-api.ts` with manager/project lifecycle modules acting as compatibility boundaries.
- `docs/BACKEND_BOUNDARIES.md` now documents the shared managed-bot API boundary.
- Landing page/ICP artifacts were drafted and exposed through a static route; useful for positioning, but not on the critical product path.

## Current State
Zolara now has the minimum admin/member control surfaces needed to run a distributed consensus loop without constant manual inspection. The next bottleneck is not more commands; it is making the loop production-reliable and modular enough that separate builders can own onboarding, validation, rounds, synthesis, and admin surfaces independently.

## Ruthless Priority Order

### P0 — Prove One End-to-End Loop in Production-Like Conditions
**Goal:** one project can onboard members, validate/refine a topic, start a round, gather responses, synthesize, post a report, and show admin/member status without manual DB edits.

1. Run a fresh end-to-end smoke test using the Product Bot.
2. Fix only blockers found in that path.
3. Verify lifecycle worker behavior under PM2/system process management.
4. Confirm dashboard `/next` points to the correct next action at every state.
5. Record the runbook: commands, expected states, and common recovery steps.

**Exit criteria:** a new project reaches a posted synthesis report with no manual intervention except normal user/admin Telegram actions.

### P1 — Hard Module Boundaries for Distributed Development
**Goal:** enable parallel builders to work safely by owning modules instead of scattered handlers.

Create/finish module boundaries around:
- `src/project/flows/onboarding/` — member profile flow, callbacks, copy, tests.
- `src/project/flows/validation/` — topic validation, clarification, rerun, history, tests.
- `src/project/flows/rounds/` — question send, response collection, nudges, tests.
- `src/engine/synthesis/` — synthesis pipeline, report shape, posting contract, tests.
- `src/project/admin/` — dashboard, `/next`, nudges, admin-only guards, tests.
- `src/telegram/` — Telegram API boundaries, send/retry utilities, managed bot operations.
- `src/util/lifecycle-worker.ts` — only orchestration/locking; business transitions stay in engine modules.

Rules for every module:
- Own its command/callback handlers.
- Own its copy builders or view models.
- Own state transition helpers.
- Own tests for stale buttons, invalid state, and happy path.
- Export a small `registerXHandlers(bot, deps)` or equivalent boundary.

### P2 — Lifecycle Reliability and Observability
**Goal:** scheduled work keeps the product moving and tells us when it cannot.

1. Add structured audit events for every validation and round transition not already covered.
2. Add worker result summaries: processed, skipped, failed, locked, duration.
3. Add failure surfacing to admin dashboard: failed synthesis, failed sends, insufficient responses.
4. Add idempotency guards for refined-topic validation reruns and round completion.
5. Add minimal dead-letter/retry visibility for Telegram and LLM failures.

### P3 — Synthesis Report Posting + Reaction Tracking
**Goal:** close the loop after gathering.

1. Confirm report posting target selection: group, channel, or admin DM fallback.
2. Post the synthesis report with stable inline actions.
3. Implement report reactions: `Aligned`, `Discuss`, `Disagree`.
4. Store reaction state and show summary in dashboard.
5. Calculate convergence score only after reaction tracking is stable.

### P4 — Productization Only After Core Loop Is Stable
**Goal:** support acquisition without distracting from the loop.

1. Keep landing page artifacts lightweight.
2. Use ICP copy to inform onboarding/admin copy.
3. Do not expand marketing pages until the core loop has a verified demo path.

## Drop / Defer

Drop or defer these until P0-P2 are solid:
- Complex autonomous sub-agent/project coordinator behavior inside the product.
- Advanced analytics, embeddings, and convergence visualizations beyond basic reaction summary.
- Multi-channel posting sophistication beyond one clear Telegram target plus fallback.
- Web app UI work; keep Telegram-first but structure view models so a web UI can reuse them later.
- More landing page/persona expansion beyond the current artifact.
- Large schema redesigns unless an end-to-end blocker proves they are necessary.
- Clever AI follow-up rounds before the first manual/scheduled round lifecycle is dependable.

## Recommended Parallel Workstreams

### Builder A — End-to-End Verification
Owns P0 smoke test, blocker fixes, runbook, and PM2/worker verification.

### Builder B — Module Boundary Refactor
Owns P1 directory/interface cleanup with no behavior changes unless tests require it.

### Builder C — Lifecycle Observability
Owns P2 audit coverage, worker summaries, and dashboard failure surfacing.

Only start Builder D for report reactions after Builder A proves synthesis/report posting is reachable.

## Success Criteria for the Next Build Block
- Fresh project reaches synthesis report posting through normal Telegram actions.
- `/dashboard` and `/next` correctly identify blockers at onboarding, validation, gathering, synthesis, and failed states.
- Lifecycle worker can be run repeatedly without duplicate transitions or duplicate reports.
- At least one major flow is moved behind a clean module boundary with tests still passing.
- Build and tests pass before push.
