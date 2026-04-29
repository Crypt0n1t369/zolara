# Zolara Builder Worklog

## 2026-04-26 — Agent Spawning Architecture

### What Was Built

**File-based spawn queue architecture** for creating OpenClaw sub-agents from Zolara's Node.js backend.

**Core insight:** `sessions_spawn` is an AI tool only — not available as CLI or HTTP RPC. The only reliable path from Node.js to spawning a sub-agent is:
1. Node.js backend writes to a file queue (non-blocking)
2. A PM2 daemon process (`zolara-spawner`) reads the queue every 30s
3. Daemon calls `openclaw agent --message` which sends to zolara-builder agent
4. zolara-builder agent (being AI-controlled) calls `sessions_spawn` internally
5. Session key written back to queue file

### Files Created/Modified

- `src/util/spawn-agent.ts` — Queue writer + `spawnViaCLI()` for cron processor
- `scripts/spawner-server.ts` — Queue processor (daemon or once mode)
- `ecosystem-spawner.config.cjs` — PM2 config for spawner daemon
- `src/project/agent/project-agent.ts` — Updated to use queue-based spawning

### Files Created

- `scripts/spawner-server.ts` — Queue processor daemon
- `ecosystem-spawner.config.cjs` — PM2 daemon config
- `src/util/spawn-agent.ts` — Queue read/write + spawnViaCLI

### Architecture

```
Project created → spawnProjectAgent() → writes to /tmp/zolara-spawn-queue.json
                                         ↓
                    PM2 daemon (every 30s) → reads queue → openclaw agent --message
                                         → zolara-builder processes → sessions_spawn
                                         → session key → results array
```

### What's Working

- ✅ `sessions_spawn` tool — confirmed working (spawned coordinator-test sub-agent)
- ✅ Spawner daemon running (PM2 process ID 2)
- ✅ Queue file operations (enqueue, read, write, clear)
- ✅ `spawnViaCLI()` — calls `openclaw agent --message` (works when gateway not overloaded)

### What's Pending

- `openclaw agent --message` CLI times out when gateway is heavily loaded
  - During our conversation, the gateway is processing ~200k tokens/min
  - This is temporary — will work when gateway is quieter
  - Latency will be 30-80s under load vs <10s normally

### PM2 Status

```
ID 1  cloudflared     online  (tunnel)
ID 0  zolara          online  (main bot)
ID 2  zolara-spawner  online  (daemon, every 30s)
```

### Next Steps

1. Test live project creation → verify coordinator spawns within 60s
2. Update `projectAgents` table with real session keys after spawn
3. Implement coordinator command flow (send commands to spawned coordinators)
4. Continue with Step O1-O6 (member onboarding flow)

### Tested Sub-Agent Spawn

```
session_key: agent:zolara-builder:subagent:be25edef-d520-4d43-85a4-251c8cef551c
- Spawn time: 3 seconds
- Tokens: 112 total (64 in / 48 out)
- Confirmed working with sessions_spawn mode='run'
```

## Previous Sessions

- 2026-04-25: Tunnel stability fix, project list bug fix, project_agents table migration

## 2026-04-26 — MiniMax + Spawn UX Follow-up

### Built / Fixed
- Updated coordinator spawn instruction to explicitly request `model: "minimax/MiniMax-M2.7"` in the `sessions_spawn` tool call.
- Added MiniMax M2.7 instruction inside the coordinator task prompt.
- Added admin-facing wait copy after bot creation: coordinator setup can take up to 60 seconds.
- Fixed PM2 spawner runtime to use Zolara's local `node_modules/.bin/tsx` instead of broken OpenClaw tsx preload path.
- Restarted `zolara` and `zolara-spawner`.

### Verified
- `npm run build` passes.
- `zolara-spawner` PM2 process is online.
- Spawn queue currently empty: 0 pending / 0 results.

### Next
- Live `/create` test once gateway load is normal.
- Continue Phase 1 with member onboarding flow O1-O6.

## 2026-04-27 — Spawner Model Isolation Fix

### Built / Fixed
- Removed MiniMax instructions from the spawner prompt path so zolara-builder is no longer asked to switch its own model.
- Added `COORDINATOR_MODEL` in `src/util/spawn-agent.ts`, defaulting coordinator child agents to `openai/gpt-5-nano`.
- Added explicit prompt guard: the model is only for the child `sessions_spawn` parameter, not the current builder/spawner session.
- Tightened spawn result handling: no false success if CLI output says “spawned/created” without a real `session_key`.
- Increased spawn CLI timeout budget from 50s to 120s and aligned the OpenClaw CLI timeout with it.
- Updated OpenClaw config: `zolara-builder` set back to `openai-codex/gpt-5.5`; `zolara-spawner` set to `openai/gpt-5-nano`.
- Restarted OpenClaw gateway and PM2 services.
- Cleaned up an orphan `node dist/index.js` process holding port 3000, then restarted Zolara under PM2.

### Verified
- `npm run build` passes.
- OpenClaw gateway is running and connectivity probe is OK.
- PM2: `zolara` and `zolara-spawner` are online.
- Zolara health endpoint returns OK on `http://localhost:3000/health`.
- Spawn queue status: 0 pending / 0 results.

### Current State
- Cheap model usage is isolated to the bot/coordinator spawner path.
- Builder model should no longer be interfered with by bot creator model changes.

### Next
- Run a live project creation test to verify coordinator spawning returns a real `session_key` under gateway load.

## 2026-04-27 — Bug + Infrastructure Improvement Pass

### Built / Fixed
- Fixed duplicate `@Zolara_bot` `/start` handlers so deep links (`claim_`, `join_`, `createbot_`) are handled before the generic welcome path. This unblocks member invite onboarding through the control bot fallback.
- Fixed member lookups for claims, saved responses, and report reactions to scope by both Telegram user and project. This prevents cross-project member contamination when the same user belongs to multiple projects.
- Hardened coordinator agent spawning:
  - `spawnProjectAgent()` now reuses an existing pending row instead of inserting a duplicate `project_agents` row.
  - Spawner daemon now reconciles successful `sessions_spawn` results directly into `project_agents` (`status=active`, real `sessionKey`) so rows do not remain pending if no caller polls the queue result.
- Added npm scripts for repeatable checks: `npm test`, `npm run spawner:status`, and `npm run spawner:once`.

### Tested
- `npm run build` — pass.
- `npm test` — pass: 9 files / 100 tests.
- `npm run spawner:status` — pass: 0 pending / 0 results.
- Restarted PM2 `zolara` and `zolara-spawner` with updated code.
- Verified PM2 processes online.
- Verified `GET http://localhost:3000/health` returns OK.
- Verified Postgres and Redis Docker containers are up.

### Current State
- Runtime is healthy: Zolara HTTP server online, spawner daemon online, queue empty.
- Member onboarding and response/reaction persistence are safer for multi-project users.
- Coordinator spawn rows should now resolve from pending to active after successful spawn.

### Next Actions
- Run a live `/create` + managed-bot creation test to verify end-to-end coordinator spawn writes a real `sessionKey` to `project_agents`.
- Continue Phase 1 member onboarding O1-O6 and perspective gathering once live spawn is confirmed.

## 2026-04-27 15:18 EEST — Managed bot creation unblock pass

Built/fixed:
- Managed bot username generation now hard-limits suggestions to Telegram's 32-character username max and valid bot suffix format.
- Project initiation now uses the same managed-bot creation module that stores the pending project, so the displayed BotFather link/username matches persisted state.
- Bot display names in creation links are capped to avoid BotFather UI length issues.
- Finalizing a managed bot now fails loudly if `setWebhook` is rejected instead of silently leaving a dead bot.
- Finalizing now stores the actual Telegram bot username, clears Redis initiation/pending state, and registers the creator as project owner/member.
- Project bot `/start` now responds with connection status for existing members/admins, or a clear invite-link instruction for non-members.
- Project bot response/reaction lookup now scopes member lookup by project to avoid cross-project member confusion.
- Startup tunnel URL selection now uses the newest cloudflared quick tunnel URL instead of stale logs.

Ops/repair:
- Restarted `cloudflared` tunnel under PM2.
- Updated `.env` to current tunnel URL and restarted `zolara`.
- Existing managed bot webhooks were re-registered against the current tunnel.
- Backfilled Kristaps/admin membership for existing projects so `/start` can confirm connection.

Verified:
- `npm run build` passes.
- `npm test` passes: 9 files / 100 tests.
- PM2: `zolara`, `zolara-spawner`, and `cloudflared` online.
- Health endpoint OK.
- Telegram `getWebhookInfo`: existing managed bots have webhook URL set on current tunnel with no last error.
- Zolara logs show project bot webhook POSTs returning 200.

Next:
- User should press `/start` again in the newly created project bot and expect a connection-status reply.
- Then test teammate invite claim flow and first collaboration round.

## 2026-04-27 15:49 EEST — Project bot onboarding resume fix

Issue reported:
- Newly created project bot did not appear to lead the user through onboarding / learning about the user.

Root cause found:
- Live Zolara logs showed project bot webhook POSTs were arriving and returning 200, but onboarding crashed when sending the "interests" prompt because a dynamic project description/name containing Markdown-sensitive characters caused Telegram `sendMessage` parse failure (`can't parse entities`).
- Plain `/start` in an existing project bot showed connection status but did not resume an active onboarding state.
- Onboarding welcome advanced state to `role` but did not immediately ask the role question, causing confusing UX.

Fixes:
- Removed unsafe Markdown parsing from onboarding/claim/project-start messages that include dynamic project names/descriptions.
- Plain `/start` now resumes active onboarding for the current project.
- Plain `/start` now starts onboarding for connected members whose onboarding is not complete.
- Onboarding welcome now immediately asks the role question in the same flow.
- Reset Kristaps' active onboarding state for project `837d12b4-e928-4e78-9ca5-ad1f277bb0a6` back to `welcome` so pressing `/start` in `@zolaraflowtest_zolaa_bot` restarts the learning flow cleanly.

Verified:
- `npm run build` passes.
- `npm test` passes: 9 files / 100 tests.
- Restarted PM2 `zolara` with updated code.
- Health endpoint OK.
- Managed bot webhooks re-registered on current Cloudflare tunnel.

Next:
- Kristaps should press `/start` in `@zolaraflowtest_zolaa_bot`; expected: welcome + role question. Then answer role, interests, availability, communication style.

## 2026-04-27 18:28 EEST — Post-onboarding message silence fix

Issue reported:
- User said onboarding flow works, but the newly created project bot does not respond to questions/messages after the flow.

Root cause:
- `handleOnboardingCallbackForProject` re-saved the returned onboarding state after `handleOnboardingCallback` had already finalized onboarding and cleared Redis. This recreated `onboard:{telegramId}` with `step: complete`.
- Later text messages were routed into onboarding handling and swallowed because `step: complete` has no text response path.

Fixes:
- Removed the wrapper-level re-save after onboarding callbacks; the callback handler owns persistence/clear.
- Added guard in plain `/start`: if an active onboarding state is `step: complete`, clear it before normal connected-member handling.
- Cleared Kristaps' stale `onboard:551447474` key.

Verified:
- `npm run build` passes.
- `npm test` passes: 9 files / 100 tests.
- Restarted PM2 `zolara` with updated code.
- Health endpoint OK.
- Live logs show project bot webhooks returning 200.

Next:
- User should message the project bot after completed onboarding; expected: normal conversational fallback or command handling instead of silence.
- After teammates complete onboarding, test `/members`, then first `/startround` and answer collection.

## 2026-04-27 18:58 EEST — Round notification + objective guard fix

Issue reported:
- Project bot invited existing completed user to register again from invite link.
- `/startround` without a topic created vague `General check-in` validation.
- Validation DM did not reach project bot users.

Root causes:
- Claim deep-link path did not check existing membership before starting claim again.
- `/startround` defaulted empty topics to `General check-in` instead of asking for a concrete objective.
- Validation/question send paths passed internal DB `users.id` values to Telegram send APIs instead of `users.telegramId`, so Telegram logged `chat not found` for chat IDs like 1/3/4.
- Project-bot callback handler did not handle `validate:*` callbacks.

Fixes:
- Claim deep-link now recognizes existing members: completed users get "already connected"; incomplete users resume onboarding.
- `/startround` now requires a clear objective and shows an example instead of defaulting to `General check-in`.
- Validation DMs now use Telegram IDs from the users table.
- Round question DMs now translate internal user IDs to Telegram IDs before sending.
- Validation callback handling added to per-project bot instances.
- Validation message changed to safe HTML formatting.
- Abandoned the vague test validation `d2671851-fe6e-414e-8ef1-363920aebc54` and cancelled its scheduled round.

Verified:
- `npm run build` passes.
- `npm test` passes: 9 files / 100 tests.
- Restarted PM2 `zolara`.
- Health endpoint OK.
- Latest vague validation marked abandoned/cancelled.

## 2026-04-28 — Problem Validation Button Flow Fix

### Built / Fixed
- Clarified validation vote behavior: one vote per member is now locked after the first choice instead of allowing repeated button presses to overwrite it.
- Confirmed validations now start the scheduled round through the normal gathering transition, generating and DMing the first question instead of only flipping round status.
- Round question generation now receives the actual topic text instead of an empty placeholder.

### Verified
- `npm run build` passes.
- Restarted PM2 `zolara`; service is online.

### Current State
- Pressing ✅ Clear records the vote; if the validation threshold is reached, the round proceeds into question gathering.
- Pressing ⚠️ Refine / ❓ Not sure records the vote and contributes to a `needs_work` outcome when tally completes. Clarification question generation exists, but the full group/admin clarification loop still needs final wiring.

## 2026-04-28 — Onboarding Ack + Hidden Thinking Fix

### Built / Fixed
- Onboarding free-text answers now get explicit acknowledgements before moving to the next question:
  - Role answer → saved confirmation.
  - Interests/knowledge answer → saved confirmation explaining it will personalize future questions.
- MiniMax provider now strips `<think>...</think>` blocks globally before any bot response is sent or parsed.

### Verified
- `npm run build` passes.
- Direct `stripThinkingTags()` smoke test passes.
- Restarted PM2 services and re-registered project bot webhooks on the current Cloudflare tunnel.
- `zolara`, `zolara-spawner`, and `cloudflared` are online; `/health` returns OK.

### Current State
- The reported onboarding message no longer silently jumps to the next step after free-text input.
- `/status` and other AI fallback replies should no longer expose hidden thinking text.

## 2026-04-28 — Onboarding/Validation Interleaving + Majority Fix

### Built / Fixed
- Validation DMs now target only fully onboarded members (`onboardingStatus = complete`). Members still answering onboarding questions should no longer get interrupted by topic validation.
- Problem validation now requires a strict Clear majority. A 1 Clear / 1 Unsure split is `needs_work`, not confirmed.
- Vote tally no longer closes just because 50% participation is reached. It closes only when:
  - Clear majority is mathematically reached, or
  - non-clear majority is mathematically reached, or
  - all eligible voters responded, or
  - the deadline passes.
- Role prompt now explicitly says the next typed reply is still saved even if another Zolara message arrives.
- Availability prompt now explains why the question exists and includes “Not sure yet”.

### Verified
- `npm run build` passes.
- `npx vitest run src/engine/phase-2-problem-def.test.ts` passes: 22/22.
- Restarted PM2 `zolara`; `/health` returns OK.
- PM2 process list saved.

## 2026-04-28 — Onboarding Back/Skip/Review UX

### Built / Fixed
- Added Back and Skip controls to onboarding prompts so users can recover if they answered late, got interrupted, or want to change course.
- Added a final onboarding review screen before completion:
  - Shows saved role, interests/knowledge, availability, and communication style.
  - Lets the member confirm or jump back to edit a specific field.
- Changed onboarding finalization so data is written to the member profile only after the user confirms the review screen.
- Saved availability into `projectProfile` so the answer is not lost.
- Text replies during button-only steps now explain to use buttons instead of silently falling through.

### Verified
- `npm run build` passes.
- `npx vitest run src/engine/phase-2-problem-def.test.ts` passes: 22/22.
- Restarted PM2 services after PM2 lost its process list; `cloudflared`, `zolara`, and `zolara-spawner` are online.
- `/health` returns OK.
- Project bot webhooks re-registered on the current Cloudflare tunnel.

## 2026-04-28 — Validation Clarification Loop UX

### Built / Fixed
- Improved validation completion copy so members see exactly why a topic passed or needs work:
  - Shows Clear votes vs strict-majority threshold.
  - Explains that the round starts only after Clear majority.
- Wired `needs_work` into an actionable clarification notification:
  - Generates 2–3 clarifying questions via MiniMax.
  - Suggests a clearer rewritten topic when possible.
  - Sends the clarification prompt to the project group(s) and admin.
  - Tells the admin/team to rewrite and re-run with `/startround <clearer topic>`.
- Changed clarification generation so it no longer silently resets validation back to voting. The failed validation remains `needs_work` until a new clearer topic is started.
- Fixed validation deadline query from `gte(deadline, now)` to `lte(deadline, now)` so only expired validations are picked up.

### Verified
- `npm run build` passes.
- `npx vitest run src/engine/phase-2-problem-def.test.ts` passes: 22/22.
- Restarted PM2 `zolara`; `/health` returns OK.
- PM2 services are online: cloudflared, zolara, zolara-spawner.

## 2026-04-28 — Round 3 Start + Bounded Dev Cron + Next Phase Plan

### Built / Fixed
- Started Round 3 first-round experience improvements:
  - Question DMs now include the topic context.
  - Question DMs explain why the member is being asked.
  - Added `/my_status` to project bots so members can see onboarding status, active question status, and latest round state.
- Added `docs/NEXT_PHASE_PLAN.md` with a reprioritized modular plan for flow completeness, refinement loop, lifecycle workers, backend modularity, and UX scalability.
- Added bounded cron runner: `scripts/dev-round-cron.sh`.
  - Runs build/test/health checks.
  - Dispatches the remaining planned dev round via `openclaw agent` only if the source tree is clean.
  - Uses `/tmp/zolara-dev-round-state.json` to stop after Round 4.
- Scheduled cron: `17 */6 * * * /home/drg/projects/zolara/scripts/dev-round-cron.sh`.

### Verified
- `npm run build` passes.
- `npx vitest run src/engine/phase-2-problem-def.test.ts` passes: 22/22.
- Restarted PM2 `zolara`; `/health` returns OK.
- PM2 services online: cloudflared, zolara, zolara-spawner.

### Current State
- Rounds 1–2 are complete and pushed.
- Round 3 is started with member-facing improvements.
- Cron is scheduled to dispatch Round 4 admin clarity work in a bounded way.

## 2026-04-28 — Round 4 Dashboard Started Immediately + Exact Night Shift Schedule

### Built / Fixed
- Added admin `/dashboard` command to the Zolara control bot.
- Dashboard shows:
  - Total members, onboarded members, pending onboarding.
  - Latest validation status, topic/refined topic, Clear/Refine/Unsure vote counts, confidence, clarification round.
  - Latest round number/status/topic and response counts/missing responses.
  - Recommended next action based on current project state.
- Removed earlier OS crontab approximate runner and replaced it with exact OpenClaw one-shot night-shift jobs at 30-minute Oslo intervals.

### Verified
- `npm run build` passes.
- `npx vitest run src/engine/phase-2-problem-def.test.ts` passes: 22/22.
- Restarted PM2 `zolara`; `/health` returns OK.

### Schedule
- OpenClaw jobs scheduled from 22:00 Oslo through 08:00 Oslo, every 30 minutes.
- Work blocks cover dashboard completion, onboarding polish, stale buttons, refined topic rerun, validation history, lifecycle workers, retry/audit, modularity, friction audit, essential functions, tests, ICP work, landing page, final integration, and handoff plan.

## 2026-04-28 23:07 EEST — Round 4 Admin Dashboard Continuation

### Built / Improved
- Improved `/dashboard` admin status surface on `@Zolara_bot`.
- Extracted dashboard helper logic into `src/project/dashboard.ts` so status decisions are testable.
- Dashboard now shows:
  - Member onboarding complete/pending counts.
  - Pending onboarding breakdown by status (`fresh`, `committed`, etc.).
  - Latest validation status, vote counts, confidence, clarification round, and refined topic if present.
  - Current active/scheduled round preferred over an older completed round, with response counts, missing responses, and deadline.
  - Recommended next admin action, including scheduled/gathering/synthesizing-specific guidance.
- Added dashboard helper tests in `src/project/dashboard.test.ts`.
- Updated stale onboarding state tests to include the existing `review` step.

### Tested
- `npm run build` — pass.
- `npm test` — pass: 10 files / 104 tests.
- Restarted PM2 `zolara` with updated code.
- Verified `GET http://localhost:3000/health` returns OK.

### Current State
- Round 4 dashboard is live and materially more reliable for admins: it prioritizes active/scheduled work, surfaces missing responses clearly, and gives a concrete next action.

### Next Actions
- Exercise `/dashboard` in Telegram against a live project with pending onboarding + validation voting data.
- Continue Round 4 admin UX polish if more status gaps appear in live use.

## 2026-04-28 23:36 EEST — Night Shift Dashboard Verification

### Verified
- `npm run build` passes.
- `npx vitest run src/project/dashboard.test.ts src/engine/phase-2-problem-def.test.ts` passes: 25/25.
- `npm test` passes: 10 files / 104 tests.
- `GET http://localhost:3000/health` returns OK.
- PM2 services are online: `cloudflared`, `zolara`, `zolara-spawner`.

### Current State
- Dashboard source and helper tests are already committed and pushed in `0bad22d`.
- No dashboard code failures found during this block; no PM2 restart needed because runtime health is OK and no code changed.
- Local `.env` remains modified by tunnel URL management and was intentionally not committed.

### Next Highest-Friction User Flow
- After `/dashboard`, the biggest user friction is the `needs_work` validation path: the system tells the admin/team to rewrite and re-run `/startround <clearer topic>`, but does not preserve the failed validation context or offer a one-tap/admin-guided refinement loop.

### Concrete Next Action
- Build an admin refinement flow for `needs_work`: store the clarification questions + suggested refined topic, add dashboard/start-round action copy that exposes the latest failed validation, and let the admin confirm or edit the suggested refined topic before automatically creating the replacement validation/round.

## 2026-04-29 — Onboarding Restart + Context Labels

### Built / Fixed
- Added `/restart_onboarding` for project bots and the control bot.
  - Clears any in-progress onboarding Redis state for the member/project.
  - Clears stale claim state before restarting.
  - Restarts safely only when the user has a known membership; otherwise asks them to use the invite link.
  - Control bot handles active onboarding, single-project membership, and asks multi-project users to restart inside the specific project bot.
- Added explicit `Currently answering: X` labels to every onboarding prompt: welcome, role, interests, availability, communication style, and review.
- Added onboarding step label helpers and tests.
- Added `/restart_onboarding` and `/my_status` to managed bot command menus.

### Verified
- `npm run build` passes.
- `npm test` passes: 10 files / 105 tests.
- Restarted PM2 `zolara`.
- Health check OK: `http://127.0.0.1:3000/health`.

### Current State
- Onboarding prompts now make the active answer context explicit.
- Members can safely redo onboarding without manually cancelling or asking an admin.

### Next
- Live Telegram smoke test of `/restart_onboarding` on a project bot with a real member account.

## 2026-04-29 00:38 EEST — Stale Button Handling for Onboarding + Validation

### Built / Fixed
- Added stale onboarding callback detection for moved/completed steps.
  - New onboarding buttons now encode the step they were rendered for.
  - Old buttons are checked against the current Redis step before mutating state.
  - Expired/completed/mismatched onboarding buttons now show clear recovery copy instead of silent/empty errors.
  - Recovery paths point members to the latest current step, `/status`, `/perspective`, or `/restart_onboarding` as appropriate.
- Updated project-bot and control-bot callback routing to handle missing onboarding sessions with user-facing guidance.
- Removed the per-project skip special case so all onboarding callbacks go through the same stale-state guard.
- Improved stale validation callback copy.
  - Completed/missing validation votes now explain the current state and guide users to `/status` or a fresh admin `/startround` rather than saying only “already complete.”
  - Unregistered validation voters get a clearer join/status path.
- Added tests for onboarding stale callback detection and validation stale-copy contracts.

### Verified
- `npm test` passes: 10 files / 110 tests.
- `npm run build` passes.
- Restarted PM2 `zolara` with updated code.
- Health check OK: `GET http://localhost:3000/health`.

### Current State
- Stale onboarding and validation buttons no longer fail silently or give confusing errors; users get a current-state explanation plus a concrete recovery path.

### Next
- Live Telegram smoke test: tap an old onboarding button after advancing steps, and tap an old validation vote after validation closes.

## 2026-04-29 01:07 EEST — Topic Refinement Rerun Flow

### Built / Fixed
- Added `/refinetopic <clearer topic>` for admins after a validation ends in `needs_work`.
  - Finds the latest `needs_work` validation for the selected project.
  - Stores the refined topic on the parent validation via existing `refined_text` while preserving original `topic_text`.
  - Cancels the old scheduled validation round and starts a fresh validation for the refined topic.
- Added `/adminguide`, `/admin_guide`, and `/admin-guide` handling with current refinement guidance when a project is waiting on a clearer topic.
- Improved `needs_work` clarification copy: points admins to `/refinetopic <clearer topic>` and explains when `/startround` should be used for a separate topic.
- Fixed active-validation detection to block concurrent `voting` validations instead of only stale `pending` rows.
- Updated AI help and Phase 2 tests to document the refinement flow.

### Verified
- `npm run build` passes.
- `npm test` passes: 10 files / 110 tests.
- Restarted PM2 `zolara`.
- Health check OK: `GET http://127.0.0.1:3000/health`.

### Current State
- The topic refinement loop is no longer a dead end: `needs_work` now has a clear admin command path that links original → refined using existing schema fields and reruns validation cleanly.

### Next
- Live Telegram smoke test: force a `needs_work` vote result, run `/admin-guide`, then `/refinetopic <suggested or edited topic>` and verify members receive the new validation.

## 2026-04-29 01:35 Cairo — Validation history dashboard/status

Built:
- Added validation history formatting for previous topic attempts, status, vote counts, clarification round, confidence, and refined topic.
- Wired `/dashboard` and `/status` to show the latest 5 validation attempts.
- Fixed `/status` round lookup to order by newest round number.

Tested:
- `npm test -- --run src/project/dashboard.test.ts` — pass.
- `npm run build` — pass.
- Restarted PM2 `zolara` and verified `GET /health` returns OK.

Current state:
- Runtime online with validation history visible in admin dashboard/status.

Next:
- Continue Phase 1 validation/onboarding flow improvements.

## 2026-04-29 02:08 Africa/Cairo — Lifecycle deadline worker

Built/fixed:
- Added `scripts/lifecycle-worker.ts` one-shot worker for validation vote deadlines and round gathering deadlines.
- Added Redis NX lock (`lock:lifecycle-worker`) so PM2/cron runs cannot overlap or duplicate deadline processing.
- Added PM2 cron integration as `zolara-lifecycle-worker` running once per minute via `ecosystem.config.cjs`.
- Added `npm run lifecycle:once` and `scripts/run-lifecycle-worker.sh` with logs appended to `/tmp/zolara-lifecycle-worker.log`.
- Hardened deadline handlers with structured summary logs (`checked/expired/processed/failed`).
- Added idempotency guard so round completion only processes rounds still in `gathering`.
- Added stale validation guard in `tallyVotes()` so already-closed validation sessions do not re-run side effects.

Verified:
- `npm run build` passes.
- `npm run test -- src/engine/round-lifecycle.integration.test.ts src/engine/phase-2-problem-def.test.ts` passes: 43 tests.
- `npm run lifecycle:once` runs successfully and logs zero pending expired validations/rounds in live DB.
- `pm2 startOrReload ecosystem.config.cjs --update-env` restarted Zolara and registered `zolara-lifecycle-worker`.
- `pm2 save` persisted the process list.
- Health endpoint OK: `GET http://localhost:3000/health`.

Current state:
- Main `zolara` PM2 app online.
- `zolara-lifecycle-worker` is a stopped PM2 cron app between scheduled runs, expected with `autorestart:false` + `cron_restart`.
- No expired validation or round deadlines were pending at verification time.

Next:
- Watch next live validation/round deadline to confirm logs show processing counts > 0 and no duplicate synthesis/report side effects.

## 2026-04-29 02:35 Africa/Cairo — Night shift retry/alert/audit hardening

**Built**
- Added shared retry helper (`src/util/resilience.ts`) with bounded exponential backoff, retry-after support, and structured retry warnings.
- Added audit helper (`src/util/audit.ts`) writing operational audit events to `engagement_events` without breaking the caller if audit persistence fails.
- Hardened MiniMax LLM calls with 45s timeout, 3-attempt retry for network/429/5xx failures, and audit records for generation/parse failures.
- Hardened Telegram sends with 3-attempt retry for 429/408/5xx/timeout failures, retry-after support, structured alerts, and `telegram_send_failed` audit events for final failures.
- Added round lifecycle transition auditing via `round_state_transition` events and structured logs; question send failures are tracked as unreachable members and audited.
- Persisted Telegram message IDs on successfully sent round questions.

**Tested**
- `npm run build` ✅
- `npm test` ✅ — 10 files / 111 tests passed
- Restarted PM2 `zolara` and verified `/health` ✅

**Current state**
- Main Zolara process is online after restart.
- Lifecycle worker remains stopped as before.

**Next actions**
- Add a small smoke test/mocked unit test around retry behavior if this grows beyond minimal hardening.
- Consider a dedicated audit table later; current minimal implementation reuses `engagement_events`.

## 2026-04-29 03:04 Africa/Cairo — Night shift modular boundary pass

- Reviewed managed bot lifecycle architecture across manager and project flows.
- Refactored duplicated Telegram Managed Bots API client code into `src/telegram/managed-bots-api.ts`.
- Kept `src/manager/managed-bots/lifecycle.ts` and `src/project/managed-bots/lifecycle.ts` as compatibility re-export shims so feature imports remain stable.
- Added `docs/BACKEND_BOUNDARIES.md` documenting the shared Telegram API boundary and where future shared operations should go.
- Tested: initial `npm test -- --runInBand ...` failed because Vitest v4 does not support Jest's `--runInBand` flag; reran targeted lifecycle tests — 16/16 passed; then ran full `npm test` — 111/111 passed.
- Built: `npm run build` passed.
- Restarted: `pm2 restart zolara`; verified PM2 online and `GET /health` returned ok.
- Current state: managed bot API behavior unchanged, but manager/project coupling and drift risk reduced.
- Next: continue Phase 1 round lifecycle/member onboarding hardening per implementation guide.

## 2026-04-29 03:30 EEST — Night shift user-friction audit + admin nudge command

### Audit findings
- Admin friction: `/dashboard` can identify pending onboarding / missing responses, but the admin had no direct next-action command to re-engage stalled members.
- Member friction: members can miss onboarding or an active round question and then silently block synthesis.
- Essential missing function selected: an admin-controlled reminder path that closes the gap between “I can see the blocker” and “I can do something about it.”

### Built
- Added `/nudge` on `@Zolara_bot` admin control plane.
- `/nudge` collects two blocker classes for the selected project:
  - members whose onboarding is not `complete`
  - members with unanswered questions in the active `gathering` round
- Sends project-bot DMs using the correct project token, combining multiple reminders per member into one message.
- Reports sent/failed counts plus pending onboarding and missing response totals back to the admin.
- Added `/nudge` to `/adminguide`.

### Tested
- `npm run build` — pass.
- `npm test` — pass: 10 files / 111 tests.
- Restarted PM2 `zolara` with updated code.
- Verified PM2 `zolara` is online and `GET http://127.0.0.1:3000/health` returns OK.

### Current state
- Admins now have a concrete recovery action when onboarding or active-round response collection stalls.
- No schema migration required.

### Next actions
- Live Telegram test: run `/dashboard`, then `/nudge` on a project with pending members or a gathering round.
- Consider adding a rate-limited automatic “nudge after N hours” worker using the same blocker logic.

## 2026-04-29 04:08 Africa/Cairo — Night shift admin next-action command

Built/fixed:
- Added `/next` on the Zolara control bot as a concise action surface for admins.
- Extracted dashboard recommendation logic into `recommendAdminNextAction()` so dashboard and `/next` share the same blocker priority.
- `/next` now chooses one concrete command based on live project state:
  - `/invite` when no members are connected.
  - `/nudge` for pending onboarding or missing gathering-round responses.
  - `/refinetopic <suggested topic>` / `/adminguide` after `needs_work` validation.
  - `/dashboard` for wait states like voting/synthesizing.
  - `/startround <topic>` when the project is ready for the next round.
- Updated `/dashboard` recommended action copy to include the command to run.
- Fixed `/members` to count `onboardingStatus = complete` as complete instead of the older `committed` status, and show each member status label.
- Updated admin guide/start/help context to mention `/next` and `/nudge`.

Tested:
- `npm run build` passes.
- `npm test -- --run src/project/dashboard.test.ts` passes: 5/5.
- `npm test` passes: 10 files / 112 tests.
- Restarted PM2 `zolara`; health check OK at `http://127.0.0.1:3000/health`.

Current state:
- Admins can now ask Zolara for the single next action instead of reading the whole dashboard and deciding manually.
- Runtime online; lifecycle worker remains stopped between cron runs as expected.

Next:
- Live Telegram smoke test `/next` on a project with each blocker state: no members, pending onboarding, active gathering round, and needs_work validation.

## 2026-04-29 04:38 Africa/Cairo — Night shift integration test hardening

Built/fixed:
- Added practical regression coverage around recent high-risk areas:
  - onboarding stale-button recovery and explicit prompt/context labels,
  - validation outcome/tally timing, including no early close on 50/50 splits,
  - dashboard/status validation-history escaping, limiting, and wait-state recommendations,
  - lifecycle worker Redis lock behavior and deadline check ordering.
- Extracted lifecycle worker implementation into `src/util/lifecycle-worker.ts` so the PM2/CLI wrapper stays thin and the lock/deadline orchestration is unit-testable.
- Fixed `processVote()` to honor the intended one-vote lock: repeated direct calls no longer overwrite an existing validation vote.

Tested:
- `npm test` passes: 11 files / 125 tests.
- `npm run build` passes.
- `npm run lifecycle:once` runs successfully with 0 expired validations / 0 expired rounds.
- Restarted PM2 `zolara`; health check OK at `http://127.0.0.1:3000/health`.
- PM2 state: `zolara`, `zolara-spawner`, and `cloudflared` online; `zolara-lifecycle-worker` stopped between cron runs as expected.

Current state:
- Integration-risk behavior is covered by more focused unit tests and the runtime is healthy after restart.
- Local `.env` remains modified by environment/tunnel management and was intentionally not committed.

Next:
- Live Telegram smoke tests for `/next`, `/nudge`, stale onboarding/validation buttons, and `/refinetopic` on real project states.
