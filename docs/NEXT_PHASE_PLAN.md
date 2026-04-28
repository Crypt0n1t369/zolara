# Zolara Next Phase Plan — Streamlined Distributed Project Development

## Objective
Make Zolara feel like a clear, modular consensus workflow: members know what to do next, admins know project state, and unclear topics turn into structured refinement instead of dead ends.

## Current Completed Foundation
- Managed/project bot infrastructure exists.
- Onboarding persists member profile data and now supports Back, Skip, edit, and final review confirmation.
- Validation requires strict Clear majority.
- `needs_work` now creates clarifying questions and suggested rewrite guidance.
- First question copy now includes topic context and why the member is being asked.
- `/my_status` gives members a personal status surface.

## Immediate Remaining Round
### Round 4 — Admin Clarity Dashboard
Build `/dashboard` for admins/project owners:
- members onboarded vs pending
- current validation status and vote counts
- active/scheduled round status
- responses received vs missing
- next recommended action

Why this matters: distributed teams need a single control panel so the admin does not guess whether the project is stuck on onboarding, validation, or responses.

## Reprioritized Next Phase

### Phase A — Flow Completeness
1. Finish `/dashboard`.
2. Add `/restart_onboarding` for members.
3. Add explicit “currently answering: X” label to onboarding prompts.
4. Add stale-button handling for old onboarding/validation buttons.

### Phase B — Topic Refinement Loop
1. Let admins submit a refined topic directly from clarification flow.
2. Store parent/child relationship between original and refined validation.
3. Add “use suggested topic” button if Telegram callback size allows; otherwise send command template.
4. Show validation history in dashboard.

### Phase C — Round Lifecycle Reliability
1. Add cron/worker for validation deadlines.
2. Add cron/worker for round deadlines and synthesis.
3. Add retry/alerting for failed LLM or Telegram sends.
4. Add audit events for every state transition.

### Phase D — Modular Back-End Structure
Refactor toward modules with clear boundaries:
- `flows/onboarding` — member profile flow
- `flows/validation` — topic validation/refinement
- `flows/rounds` — question delivery/response collection
- `flows/synthesis` — report generation/posting
- `admin/dashboard` — admin status/actions
- `infra/bots` — managed bot lifecycle/webhooks

Each module should own:
- commands/callbacks
- state transitions
- tests
- user-facing copy

### Phase E — Front-End / UX Scalability
Even while Telegram-first:
- define status cards as structured view models, not ad-hoc strings
- keep copy builders separate from business logic
- use consistent action labels: Back, Skip, Edit, Confirm, Restart, View status
- prepare these view models for future web/app UI reuse

## Drop / Defer
- Do not build complex sub-agent coordinator behavior until core flow is reliable.
- Do not add advanced analytics before dashboard + lifecycle workers are solid.
- Do not overbuild multi-channel posting until Telegram project flow is clean end-to-end.

## Success Criteria
- A new member can join, onboard, answer a question, and understand what happened.
- An unclear topic produces actionable refinement guidance.
- An admin can run one command and know exactly what is blocking progress.
- Scheduled workers keep validations/rounds moving without manual babysitting.
- Build/tests pass after each round and PM2 health remains OK.
