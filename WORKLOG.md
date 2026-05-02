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

## 2026-04-29 05:00 Africa/Cairo — Night shift ICP landing page plan

Built:
- Added `docs/ICP_LANDING_PAGE_PLAN.md` with 5 ICP personas tied to current Zolara direction:
  - community manager/campus operator,
  - event/festival/program organizer,
  - quiet/underrepresented member,
  - veteran contributor/informal steward,
  - emergency/volunteer coordinator.
- For each ICP, documented concrete pains, pain-relief positioning, promised outcomes, product proof points, and landing page angles.
- Added a recommended landing page structure and copy rules focused on concrete relief over abstract alignment language.

Tested:
- Documentation-only change; verified file content directly.

Current state:
- Landing page planning now has an ICP/persona spine aligned with the community-campus pivot and current product proof points.
- Local `.env` remains modified by environment/tunnel management and was intentionally not committed.

Next:
- Convert this plan into landing page copy/components when frontend implementation starts.

## 2026-04-29 05:30 Africa/Cairo — Night shift landing page draft personas 1-2

Built:
- Added `docs/landing-page.md` as a comprehensive landing page copy artifact focused on pain relief.
- Deepened ICP persona 1 (Marta, community manager/campus operator) and persona 2 (Jānis, festival/program organizer) with daily reality, fears, pain language, promised outcomes, workflow, proof points, demo copy, and CTA structure.
- Included hero variants, problem cards, workflow copy, proof/comparison section, use-case modules, Telegram chat simulation copy, and implementation copy rules.

Tested:
- Documentation-only change; verified markdown content directly.

Current state:
- Landing page now has a page-level copy draft that builds on `docs/ICP_LANDING_PAGE_PLAN.md` and `/tmp/TheMechanysm/specs/personas.md`.
- Local `.env` remains modified by environment/tunnel management and was intentionally not committed.

Next:
- Convert `docs/landing-page.md` into concrete landing HTML/components or a `/partner` page variant.

## 2026-04-29 06:00 Cairo — Landing page ICP personas 3-5

**Built**
- Extended `docs/landing-page.md` beyond the Marta/Jānis core draft to cover ICP personas 3-5:
  - Leo, quiet/underrepresented member: pain relief, objections, use cases, member-facing CTA.
  - Ava, veteran contributor/informal steward: invisible labor, progression/stewardship objections, recognition/memory use cases, CTA.
  - Emergency/volunteer coordinator: rapid intake, operational pulse, handover synthesis, objections, use cases, CTA.
- Updated the page wireframe to include Leo, Ava, and emergency/volunteer sections before trust/proof/CTA.

**Tested**
- Ran `npm run build` successfully.

**Current state**
- Landing page copy artifact now covers ICP personas 1-5 with concrete product-aligned copy.
- `.env` remains locally modified and was not touched for this work.

**Next actions**
- Convert the markdown copy into concrete `/tmp/TheMechanysm/landing/index.html` updates or a dedicated partner-page implementation pass.

## 2026-04-29 — Landing Page Artifact + Static Route

### Built
- Reworked `docs/landing-page.md` from draft copy into a final, usable landing-page artifact with clear sections for hero, pain relief, 5 ICPs, workflow, FAQ, and CTA.
- Added a simple static Hono landing page route at `/` and `/landing-page` using `src/server/landing-page.ts`.

### Tested
- `npm run build` passes.
- `npm test` passes: 11 files / 125 tests.

### Current State
- Landing-page copy is structured for implementation and review.
- Server can render a lightweight static landing page without adding a separate frontend framework.

### Next
- Replace placeholder CTA email once the production lead-capture destination is chosen.

## 2026-04-29 07:07 Africa/Cairo — Night shift: user-facing copy polish

Built:
- Polished core Telegram copy across setup/initiation, member claim/onboarding, validation DMs, question DMs, synthesis reactions, reminders, dashboard/status/next-action text.
- Standardized language around “perspective”, “synthesis”, “validation”, “round”, and “onboarding”.
- Updated report reaction buttons to match product language: Aligned / Want to discuss / Disagree.

Tested:
- `npm test` — 11 files, 125 tests passing.
- `npm run build` — TypeScript build passing.
- Restarted Zolara via `scripts/start-zolara.sh` and verified `GET /health` returns OK.

Current state:
- Zolara server is running on port 3000 with project bot webhook router active.
- Copy changes are ready to commit/push.

Next actions:
- Continue Phase 1 core-loop hardening: onboarding edge cases, perspective gathering, synthesis report posting/reactions.

## 2026-04-29 07:40 Africa/Cairo — Night shift e2e verification

### Verified
- Code-level e2e path reviewed: managed project bot creation, member claim/onboarding, validation voting, question DM routing, response capture, synthesis/report posting, reaction tracking, and dashboard/next-action views.
- Live runtime check: `GET /health` returns OK on port 3000.
- Managed bot webhook check: active project bots have webhooks set on the current trycloudflare host with 0 pending updates and no last Telegram webhook error.
- Lifecycle worker one-shot: validation deadline and round deadline checks completed with 0 failures.

### Fixed
- Hardened `src/engine/question/generator.ts` so malformed MiniMax JSON no longer fails the round before questions are sent.
- Added robust question normalization for direct arrays, `{ questions: [...] }`, `{ items: [...] }`, string question entries, and markdown-fenced JSON.
- Added deterministic fallback questions if the LLM returns unusable output or the LLM call fails, preserving the intended validation → gathering transition.
- Added `src/engine/question/generator.test.ts` coverage for the parsing/normalization cases that caused the prior failed round.

### Tested
- `npm test -- --run` — pass: 12 files / 129 tests.
- `npm run build` — pass.
- `npm run lifecycle:once` — pass.
- Restarted PM2 `zolara` with updated code.
- Health endpoint confirmed OK after restart.

### Current State
- Zolara server is online; project bot webhooks are re-registered on startup.
- Previous live round `f952a100...` failed before this fix due to `LLM returned invalid question format`; future rounds should fall back instead of failing at question generation.

### Next Actions
- Run the next live `/startround` on the active test project to confirm questions are delivered end-to-end with the fallback guard in place.
- If desired, archive/delete stale pending/deleted test projects so dashboards only show the active test surface.

## 2026-04-29 08:00 Africa/Cairo — Next phase plan refresh

### Built
- Updated `docs/NEXT_PHASE_PLAN.md` to reflect the actual overnight build: dashboard, `/next`, nudges, onboarding restart/stale-button handling, topic refinement reruns, lifecycle worker, retry hardening, shared Telegram API boundary, landing page artifact, and question fallback hardening.
- Reprioritized the plan around a production-like end-to-end loop, module boundaries for parallel development, lifecycle observability, and only then report reactions/productization.
- Explicitly marked low-leverage work to drop/defer until the core loop is reliable.

### Tested
- `npm test -- --run` — pass: 12 files / 129 tests.
- `npm run build` — pass.

### Current State
- Planning doc now points builders toward modular scalable distributed development rather than adding more scattered commands/features.

### Next Actions
- Commit and push the docs update after verification.

## 2026-04-29 13:02 Africa/Cairo — Final integration pass before 08:00 Oslo

### Completed rounds
- Round 1: landing/product surface — ICP landing page plan, final landing-page artifact, and static Hono route at `/` and `/landing-page`.
- Round 2: core Telegram flow polish — setup/initiation, onboarding, validation, gathering, synthesis/report, reactions, dashboard/status, and `/next` copy aligned to current product language.
- Round 3: integration hardening — onboarding stale-button handling, validation vote locking/timing, dashboard escaping/history limits, lifecycle worker extraction, and question-generation fallback for malformed MiniMax output.
- Round 4: final verification — repo status checked, build/test/lifecycle/health/PM2 checks run, generated test cache reset, and safe docs/worklog changes prepared for push.

### Tested now
- `npm run build` — pass.
- `npm test` — pass: 12 files / 129 tests.
- `npm run lifecycle:once` — pass: 0 expired validations, 0 expired rounds, 0 failures.
- `curl http://127.0.0.1:3000/health` — OK (`service: zolara`).
- PM2 status checked: `zolara`, `zolara-spawner`, and `cloudflared` online; `zolara-lifecycle-worker` stopped, expected between scheduled runs.
- Port 3000 checked: served by the PM2-managed `scripts/start-zolara.sh` child node process.

### Current state
- `master` is aligned with `origin/master` before this WORKLOG-only final-pass commit.
- Runtime is healthy and responding locally.
- Local `.env` remains modified by environment/tunnel management and is intentionally not committed.
- Vitest modified its tracked cache file under `node_modules/.vite/.../results.json`; it was reset and not committed.

### Unresolved blockers / risks
- Live Telegram smoke remains the next required validation: run `/startround` on the active test project and confirm validation → questions → responses → synthesis/report posting end-to-end.
- `zolara-spawner` logs show an expired prior request (`837d12b4-e928-4e78-9ca5-ad1f277bb0a6`) after repeated 120s spawn timeouts; queue later removed the expired request, but spawning should be re-tested with gateway load low.
- PM2 `zolara` error log still contains historical `EADDRINUSE` entries from earlier restarts; current process is online and `/health` is OK.
- One managed bot auto-rehack count remains `2/3 bots registered` in startup logs; investigate stale/deleted test bot records if dashboard/webhook noise matters.

### Next actions
1. Commit and push this final WORKLOG update.
2. Run live Telegram E2E smoke on active test project.
3. Re-test coordinator spawning once OpenClaw gateway load is normal.

## 2026-05-01 17:37 — Tester readiness research + security prep

**What was built/prepared**
- Researched official Telegram Bot API, Cloudflare Tunnel, and PM2 docs for tester-readiness hardening.
- Added `docs/TESTER_READINESS_SECURITY_PLAN.md` with security invariants, implementation workflow, and first-tester checklist.
- Confirmed recurring OpenClaw cron is scheduled every 30 minutes to continue tester-readiness work.

**What was tested**
- Ran full Vitest suite: 12 test files passed, 129 tests passed.

**Current state**
- Ready to receive feature inputs from Kristaps and implement them against the security checklist.
- Known highest-priority infrastructure requirement remains stable `WEBHOOK_BASE_URL` via fixed Cloudflare hostname before broad tester rollout.

**Next actions**
- When feature inputs arrive: implement smallest safe slice, add/adjust tests, run targeted/full checks, update this worklog.

## 2026-05-01 18:04 — Group invite readiness improvement

**What was built**
- Added a Telegram `createChatInviteLink` wrapper in `src/telegram/managed-bots-api.ts`.
- Updated admin `/invite` to show both:
  - Project member onboarding link (`https://t.me/<bot>?start=claim_<projectId>`)
  - Telegram group invite link when the project bot is already in the group and has invite-link admin permission.
- If the bot lacks group/admin context, `/invite` now tells the admin exactly what to do: add the project bot to the group as admin with invite-link permission, then rerun `/invite`.

**What was tested**
- Ran `npx tsc --noEmit` successfully.

**Current state**
- Telegram still cannot let bots create groups automatically, but Zolara can now generate a group invite link once the human-created group is connected and permissions are correct.

**Next actions**
- Live-test `/invite` after adding a project bot to a group as admin.
- Add dashboard/report reaction summaries or admin DM fallback next, unless Kristaps gives a higher-priority feature.

**Additional check**
- Ran `npx vitest run src/project/managed-bots/lifecycle.test.ts src/manager/managed-bots/lifecycle.test.ts`: 2 files passed, 16 tests passed.

## 2026-05-01 18:34 — Dashboard report reaction summary

**What was built**
- Added dashboard helper `formatReportReactionSummary()` with lightweight convergence calculation from report reactions.
- Updated admin `/dashboard` to show latest-round report reaction summary from `engagementEvents` (`report_reaction` metadata by round number): aligned, discuss, disagree, saved actions, and convergence percentage.
- Kept the summary read-only and privacy-safe: it only aggregates reaction counts, no raw member response content.

**What was tested**
- Ran `npx tsc --noEmit` successfully.
- Ran `npx vitest run src/project/dashboard.test.ts`: 1 file passed, 9 tests passed.

**Current state**
- Report reactions are now visible in the admin dashboard after report buttons are used.
- Reaction storage still allows multiple clicks/events per member; future hardening should upsert latest reaction per member/round if exact voting semantics matter.

**Next actions**
- Add admin DM fallback for report posting when no group destination is configured.
- Continue live E2E smoke once stable webhook hostname is available.

## 2026-05-01 18:42 — Project start-flow audit and cron alignment

**What was built/prepared**
- Audited Kristaps' desired lead/member/group/ongoing Zolara flow against the current codebase.
- Added `docs/PROJECT_START_FLOW_AUDIT.md` with:
  - clarified lead flow
  - clarified member flow
  - group setup flow
  - ongoing main-chat/private-chat loop
  - logic gaps
  - current implementation audit
  - phased transformation roadmap
- Updated `docs/TESTER_READINESS_SECURITY_PLAN.md` so the existing 30-minute tester-readiness cron follows this roadmap.

**Scheduling decision**
- Did not create a new competing cron.
- Existing OpenClaw readiness cron remains the product-readiness driver.
- PM2 lifecycle worker remains separate and only handles round/deadline execution.

**Key audit conclusions**
- Telegram bots cannot message users first; web whitelist must bind only after user opens/messages the bot.
- Telegram username is mutable; stable identity must become Telegram user ID after first contact.
- Current system supports `/create`, managed bots, deep-link member claim, onboarding, rounds, synthesis, reports, and reactions.
- Missing pieces: web profile/whitelist, lead/member first-message routers for plain “hi”, group setup assistant, group intro, report DM fallback, richer ongoing loop exports.

**What was tested**
- Documentation/planning change only; no code test required.

**Next actions**
- Next readiness implementation slice: project bot unknown-user first-message onboarding from plain “hi”.

## 2026-05-01 19:04 — Project bot plain-hi member join path

**What was built**
- Updated project bot first-message handling so an unknown user who searches for `@[project]_bot` and sends plain text like “hi” is offered the project join/commitment gate instead of falling into generic AI help.
- Updated the non-member plain `/start` path to start the same claim flow as `/start claim_<projectId>` while still showing the direct invite link for later.
- Kept existing behavior for known members: they can still use AI fallback/free chat when no onboarding, claim, or active question is pending.

**What was tested**
- Ran `npx tsc --noEmit` successfully.
- Ran `npx vitest run src/project/flows/onboarding-state.test.ts`: 1 file passed, 13 tests passed.

**Current state**
- Member entry is now more forgiving: direct link, `/start`, or plain “hi” to a project bot can begin joining/onboarding.

**Next actions**
- Add lead-side first-message router for whitelisted/project-owning users on `@Zolara_bot`.
- Add web profile/whitelist storage model after routing behavior is stable.

## 2026-05-01 19:34 — Lead-side first-message router

**What was built**
- Added a private-DM first-message router for `@Zolara_bot`.
- Known project leads/admins who send plain text now get a concise “welcome back” response with the recommended next action plus `/dashboard`, `/invite`, and `/projects` pointers instead of generic AI help.
- New users who send a simple greeting/start/create intent (`hi`, `hello`, `start`, `create project`, etc.) now enter the `/create` initiation wizard without needing to know the command.
- Longer non-command questions still route to AI help, preserving conversational support.

**What was tested**
- Ran `npx tsc --noEmit` successfully.
- Ran `npx vitest run src/project/dashboard.test.ts src/manager/flows/initiation-state.test.ts`: 2 files passed, 14 tests passed.

**Current state**
- Lead entry is more forgiving: `/create` still works, and simple “hi” can start setup.
- Full web whitelist/profile binding is still pending; this router is the safe pre-whitelist foundation.

**Next actions**
- Add web intake/profile storage for email + Telegram username + lead/member role.
- Bind pending web profile to Telegram user ID when the user first messages the bot.

## 2026-05-01 20:04 — Web intake pending-profile foundation

**What was built**
- Added `pending_web_profiles` schema and migration SQL for lightweight web intake:
  - email
  - Telegram username + normalized username
  - role (`lead` or `member`)
  - pending/linked status
  - Telegram ID binding after first bot contact
- Added a landing-page intake form that explains the key Telegram constraint: users must open `@Zolara_bot` and send `hi` before Zolara can bind/contact them.
- Added `/intake` POST endpoint to validate and store/update a pending profile without logging secrets.
- Added `@Zolara_bot` binding helper: on `/start` or private text message, a pending web profile matching the sender’s current Telegram username is marked `linked` and bound to stable Telegram `from.id`.

**What was tested**
- Ran `npx tsc --noEmit` successfully.

**Current state**
- The web → Telegram identity handoff now has a storage model and first-contact binding path.
- This does not yet use role-specific post-bind routing beyond the existing first-message router; lead/member-specific behavior can build on the linked profile next.

**Next actions**
- Use linked `pending_web_profiles.role` in first-message routing:
  - linked lead → start/continue project setup
  - linked member → direct them to project bot/invite claim once project association exists
- Add admin-visible intake list or manual approval if tester safety requires it.

## 2026-05-01 20:34 — Role-aware web profile routing

**What was built**
- Made pending web profile binding return the linked role (`lead` or `member`) instead of silently updating state only.
- Added lookup for already-linked web profiles by stable Telegram ID so routing still works after the initial bind message.
- Updated `@Zolara_bot` `/start` routing:
  - linked lead → starts the project setup/initiation wizard
  - linked member → confirms Telegram connection and tells them to use the project bot invite/search path
- Updated private text first-message routing:
  - linked lead can enter setup from plain text even if they do not know `/create`
  - linked member no longer gets accidentally routed into project creation from “hi”; they get member-specific project bot instructions instead

**What was tested**
- Ran `npx tsc --noEmit` successfully.

**Current state**
- Web intake now has a safer role-aware Telegram handoff: lead and member entry no longer collapse into the same `/create` path.
- Member web profiles still need a project association model before Zolara can send them directly to one specific project bot.

**Next actions**
- Add optional project association to web/member intake or admin-managed pending invites.
- Add group setup assistant / one-time group intro after member handoff is stable.

## 2026-05-01 21:04 — Project bot group setup intro

**What was built**
- Added project-bot `my_chat_member` handling for when the dedicated `@[project]_bot` is added to a group/supergroup.
- The project bot now records the group ID on the project as a report destination.
- Added a one-time group orientation post that explains:
  - members onboard privately
  - the lead starts rounds
  - questions happen in private DM
  - synthesis/report/reaction loop posts back to the group
  - members join via the invite link from `/invite`
- Added idempotency via `projects.config.groupIntroPostedGroupIds` so the intro does not spam repeatedly if Telegram sends repeated membership updates.

**What was tested**
- Ran `npx tsc --noEmit` successfully.

**Current state**
- The project bot can now self-orient a Telegram group when added, which closes part of the group setup assistant gap.
- Live Telegram validation still needed: add a project bot to a test group and confirm group ID recording + one-time intro.

**Next actions**
- Add group permission/invite-link check messaging after group attach.
- Add admin/member DM group-invite distribution once invite-link creation is verified live.

## 2026-05-01 21:34 — Group invite permission check + member DM distribution

**What was built**
- Extended project-bot group attach handling to immediately try `createChatInviteLink` from the project bot.
- Group intro now shows either:
  - the ready group invite link, or
  - clear admin instruction to grant invite-link permission and rerun `/invite`.
- Added idempotent invite distribution tracking via `projects.config.groupInviteDistributedGroupIds`.
- When invite-link creation succeeds, the project bot DMs the group invite to onboarded members (`onboardingStatus = complete`) who have already opened the project bot.
- Posts a small group confirmation with the number of onboarded members notified.

**What was tested**
- Ran `npx tsc --noEmit` successfully.

**Current state**
- Group setup now covers: detect group → store destination → one-time intro → permission check → invite link → DM onboarded members when possible.
- Live Telegram validation is still required because invite-link permission behavior depends on actual group admin rights.

**Next actions**
- Run live Telegram group attach smoke with a test project bot as admin and non-admin.
- Add admin DM fallback for report posting when no group destination is configured.

## 2026-05-01 22:04 — Admin DM fallback for report posting

**What was built**
- Added report posting fallback in the round lifecycle manager.
- If a round completes and no Telegram group is configured, Zolara now sends a condensed synthesis report to the project owner/admin DM via `@Zolara_bot`.
- If posting to the configured group fails, Zolara now logs the group send failure and sends the same condensed fallback report to the owner/admin DM.
- Added `report_admin_dm_fallback` audit event with reason, response/member counts, round number, and send result.
- Fallback report includes convergence, themes, common ground, tensions, action items, and setup instructions to add the project bot to a group and run `/invite`.

**What was tested**
- Ran `npx tsc --noEmit` successfully.
- Attempted `npx vitest run src/engine/round-manager.test.ts`; no such test file exists, so Vitest exited with “No test files found.”
- Ran targeted available tests: `npx vitest run src/engine/synthesis/pipeline.test.ts src/project/managed-bots/lifecycle.test.ts`: 2 files passed, 16 tests passed.

**Current state**
- First-test report delivery is safer: synthesis is not silently stranded when group setup is missing or broken.
- Live Telegram smoke still needed to verify actual DM fallback delivery.

**Next actions**
- Run live E2E smoke: create/start round with no group and confirm admin receives fallback synthesis DM.
- Run group attach smoke as admin/non-admin to verify invite-link permission messaging.

## 2026-05-01 22:34 — Stable webhook preflight check

**What was built**
- Added `scripts/check-tester-readiness.ts`, a safe preflight that checks first-tester infrastructure without printing secrets.
- Added `npm run readiness:check` script.
- Updated `docs/TESTER_READINESS_SECURITY_PLAN.md` so P0 readiness starts with this preflight.
- Preflight verifies:
  - required secret/config variables are present
  - `WEBHOOK_BASE_URL` is valid HTTPS
  - `WEBHOOK_BASE_URL` is not random `trycloudflare.com`
  - public `/health` responds
  - PM2 lifecycle worker has every-minute `cron_restart`
  - PM2 lifecycle worker is one-shot via `autorestart: false`

**What was tested**
- Ran `npm run readiness:check`; it executed successfully and found real blockers:
  - `WEBHOOK_BASE_URL` currently uses random `trycloudflare.com`
  - public `/health` fetch failed through that URL
- Ran `npx tsc --noEmit` successfully after the preflight command.

**Current state**
- Tester readiness now has an automated gate for the highest-priority stable webhook/runbook risk.
- External tester rollout remains blocked until a named Cloudflare Tunnel/stable hostname is configured and `/health` passes publicly.

**Next actions**
- Configure named Cloudflare Tunnel/fixed hostname, update `WEBHOOK_BASE_URL`, restart server, re-register active bot webhooks, rerun `npm run readiness:check`.
- After preflight passes, run live Telegram E2E smoke.

## 2026-05-01 23:04 — Stable webhook runbook + rehook safety guard

**What was built**
- Added `docs/STABLE_WEBHOOK_RUNBOOK.md` with the concrete named Cloudflare Tunnel setup and verification path:
  - `cloudflared tunnel login`
  - create named tunnel
  - route DNS
  - configure `~/.cloudflared/config.yml`
  - update `WEBHOOK_BASE_URL`
  - restart server
  - rehook active project bots
  - rerun readiness preflight and live Telegram smoke
- Hardened `scripts/rehook-all.sh`:
  - accepts explicit `WEBHOOK_BASE_URL=... scripts/rehook-all.sh`
  - refuses to re-register active tester/prod webhooks to random `trycloudflare.com`
  - refuses non-HTTPS webhook bases
  - points operators to the stable webhook runbook
- Linked the runbook and rehook guard note from `docs/TESTER_READINESS_SECURITY_PLAN.md`.

**What was tested**
- Ran `bash -n scripts/rehook-all.sh` successfully.
- Ran `npx tsc --noEmit` successfully.
- Ran `npm run readiness:check`; it still correctly reports the existing blockers:
  - random `trycloudflare.com` webhook URL
  - public `/health` fetch failed

**Current state**
- We now have both an automated preflight and an operational runbook for resolving the stable webhook blocker.
- The rehook script can no longer accidentally point tester/prod managed bots at ephemeral tunnel URLs.

**Next actions**
- Configure the named Cloudflare Tunnel/fixed hostname manually, then rerun `npm run readiness:check`.
- Once preflight passes, run live Telegram E2E smoke.

## 2026-05-01 23:34 — Startup guard against ephemeral webhook downgrade

**What was built**
- Hardened `scripts/start-zolara.sh` so it no longer silently overwrites a stable `WEBHOOK_BASE_URL` with a random `trycloudflare.com` tunnel URL.
- Ephemeral trycloudflare startup remains possible for local development, but now requires explicit `ALLOW_EPHEMERAL_TUNNEL=1` when replacing stable config.
- Updated `docs/STABLE_WEBHOOK_RUNBOOK.md` with the startup guard behavior.

**What was tested**
- Ran `bash -n scripts/start-zolara.sh scripts/rehook-all.sh` successfully.
- Ran `npx tsc --noEmit` successfully.
- Ran `npm run readiness:check`; it still correctly reports the current blockers:
  - random `trycloudflare.com` webhook URL
  - public `/health` fetch failed

**Current state**
- The startup path is safer for testers: once a named tunnel/stable hostname is configured, the boot script should not accidentally downgrade it to an ephemeral tunnel.
- Stable webhook infrastructure is still the active external-test blocker.

**Next actions**
- Configure named Cloudflare Tunnel/fixed hostname, update `.env`, restart, rerun `npm run readiness:check`.
- Then run live Telegram E2E smoke.

## 2026-05-02 00:04 — Managed bot finalization idempotency hardening

**What was built**
- Hardened project managed-bot finalization against duplicate Telegram updates.
- If Telegram retries `managed_bot_created` / `my_chat_member` for a bot that is already attached to one of the admin’s projects, finalization now returns success without:
  - fetching a fresh managed bot token
  - generating a new webhook secret
  - re-encrypting/re-hashing the token
  - spawning duplicate setup work
- Pending project lookup now explicitly filters `status = pending`, so a newer active/archived project cannot mask an older pending project awaiting bot activation.
- Mirrored the same idempotency/status filter hardening in the manager compatibility module.
- Manager compatibility finalization now also fails loudly if Telegram rejects `setWebhook`, matching the project module behavior.

**What was tested**
- Ran `npx tsc --noEmit` successfully.
- Ran `npx vitest run src/project/managed-bots/lifecycle.test.ts src/manager/managed-bots/lifecycle.test.ts`: 2 files passed, 16 tests passed.

**Current state**
- Managed bot activation is safer under duplicate/retried Telegram creation updates.
- Stable webhook hostname remains the external tester blocker before live E2E smoke.

**Next actions**
- Configure stable Cloudflare hostname and rerun `npm run readiness:check`.
- After preflight passes, live-test managed bot creation exactly-once behavior and full round/report flow.

## 2026-05-02 00:34 — Lifecycle worker result summary

**What was built**
- Added a structured `LifecycleWorkerSummary` return value from `runLifecycleWorkerOnce()`.
- Summary now includes:
  - lock state (`locked`)
  - duration
  - validation deadline counts
  - round deadline counts
  - total checked/expired/processed/failed counts
- CLI lifecycle worker now prints a single JSON summary line after each run, making PM2/cron logs easier to inspect.
- Lock-skip runs now also return/log a zero-count summary instead of only an informational skip message.
- Updated lifecycle worker tests to assert successful-run totals and lock-skip summaries.

**What was tested**
- Ran `npx tsc --noEmit` successfully.
- Ran `npx vitest run src/lifecycle-worker.test.ts`: 1 file passed, 3 tests passed.

**Current state**
- Lifecycle scheduling verification is easier: PM2 logs now show whether the worker processed, skipped due to lock, failed, and how long it took.
- Stable webhook hostname remains the blocker before live Telegram E2E smoke.

**Next actions**
- Configure stable webhook hostname and rerun readiness preflight.
- After preflight passes, use lifecycle worker summary logs during live E2E smoke to confirm deadline processing.

## 2026-05-02 00:34 — Startup webhook rehook safety

**What was built**
- Hardened server startup webhook re-registration for active project bots.
- Startup now refuses to auto-rehook project bots unless `WEBHOOK_BASE_URL` is HTTPS.
- Startup now refuses random `*.trycloudflare.com` webhook bases unless `ALLOW_EPHEMERAL_TUNNEL=1` is explicitly set for local/dev use.
- Startup now checks the `setWebhook` result and logs a real failure if Telegram rejects the webhook instead of counting it as successful.
- Cleaned log wording from `rehack` to `rehook` for clarity.

**What was tested**
- Ran `npx tsc --noEmit` successfully.
- Ran `npm run readiness:check`; it still correctly fails on the current infrastructure blockers:
  - random `trycloudflare.com` webhook base
  - public `/health` fetch failure

**Current state**
- A server restart can no longer silently point active project bots back to an ephemeral Cloudflare URL in tester mode.
- Stable named Cloudflare Tunnel/stable hostname remains the blocker before live Telegram E2E smoke.

**Next actions**
- Configure stable webhook hostname, update `WEBHOOK_BASE_URL`, restart, rehook, and rerun readiness check.
- Live-test managed bot creation and group/report flow once preflight passes.

## 2026-05-02 01:04 — Live smoke status helper

**What was built**
- Added `scripts/smoke-status.ts`, a safe redacted diagnostic helper for the first-tester E2E path.
- Added `npm run smoke:status`.
- The helper checks and prints:
  - HTTPS/stable webhook host status
  - public `/health` status
  - recent project activation state
  - member onboarding/opened-bot counts
  - recent round statuses/errors
  - report posting presence
  - active project-bot webhook host, pending updates, and last Telegram webhook error
- The helper intentionally does not print bot tokens, encrypted token blobs, webhook secrets, raw `.env`, or full UUIDs.
- Updated `docs/STABLE_WEBHOOK_RUNBOOK.md` to use `npm run smoke:status` before and after manual live Telegram smoke.

**What was tested**
- Ran `npx tsc --noEmit` successfully.
- Ran `npm run smoke:status`; it executed and found the current expected blockers:
  - webhook host is still random `trycloudflare.com`
  - public `/health` fetch failed
- The status helper also confirmed one recent active project exists and its Telegram webhook currently points at the configured base host, with zero pending updates and no last webhook error.

**Current state**
- The E2E smoke path now has a repeatable, safe baseline/status command to inspect readiness before and after live Telegram actions.
- External tester rollout remains blocked by stable named Cloudflare hostname and public health failure.

**Next actions**
- Configure named Cloudflare Tunnel/stable hostname, rerun `npm run readiness:check`, then `npm run smoke:status`.
- After both pass, run the manual Telegram E2E path and use `npm run smoke:status` to verify reports/round transitions.

## 2026-05-02 01:34 — Report reaction latest-vote semantics

**What was built**
- Added `src/project/report-reactions.ts` with `summarizeLatestReportReactions()`.
- Dashboard reaction summary now counts only each member’s latest valid reaction for a report round instead of counting every button tap.
- Preserved immutable `engagementEvents` audit trail while making the admin-visible summary behave like current vote state.
- Fixed project-bot reaction storage to include `roundNumber`, matching manager-bot reaction metadata and enabling dashboard summaries for project-bot-originated report buttons.
- Added stale/invalid round-number guard for project-bot reaction callbacks.

**What was tested**
- Ran `npx tsc --noEmit` successfully.
- Ran `npx vitest run src/project/report-reactions.test.ts src/project/dashboard.test.ts`: 2 files passed, 10 tests passed.

**Current state**
- Report reaction summaries are safer for first testers: repeated taps no longer inflate convergence/disagreement counts.
- Stable named Cloudflare hostname remains the blocker before live Telegram E2E smoke.

**Next actions**
- Configure stable webhook hostname and rerun `npm run readiness:check` + `npm run smoke:status`.
- During live smoke, click multiple report reaction buttons as one member and verify `/dashboard` shows only the latest reaction.

## 2026-05-02 01:55 — Individual discovery scale plan

**What was planned**
- Added `docs/INDIVIDUAL_DISCOVERY_SCALE_PLAN.md` in response to Kristaps' question about making individual discovery work at scale.
- The plan aligns individual discovery with the current tester-readiness roadmap instead of replacing it.
- It defines the core product principle: Zolara should maintain a living, correctable individual model grounded in declared data, observed behavior, current context, and explicit correction.

**Key decisions**
- Start with existing storage (`users.communicationProfile`, `members.projectProfile`, `responses`, `engagementEvents`) instead of a major schema redesign tonight.
- Build privacy/consent first: `/me`, remember/refine/forget controls, private-by-default signals.
- Keep initial extraction deterministic/lightweight; defer LLM-heavy profiling and embeddings until stable E2E smoke is proven.
- Use confirmed individual signals lightly for prompt personalization without biasing group synthesis or exposing private profiles to admins.

**Tonight implementation slices proposed**
1. Project-bot `/me` profile view using existing onboarding/profile data.
2. Post-answer private reflection MVP.
3. Store confirmed signals in `users.communicationProfile` with scope/confidence/source.
4. Lightly personalize question delivery from confirmed signals.
5. Add pure-helper tests and update runbook.

**Current state**
- Planning/doc change only; no code changed for individual discovery yet.
- Stable named Cloudflare hostname remains the tester-readiness infrastructure blocker.

**Next actions**
- Implement `/me` and confirmed-signal helpers as the first low-risk individual discovery slice, unless stable webhook work becomes immediately available.

## 2026-05-02 02:04 — Individual discovery `/me` profile MVP

**What was built**
- Added `src/project/individual-profile.ts` with a private profile formatter for the individual discovery layer.
- Added project-bot `/me` command in private DM.
- `/me` shows:
  - project name, role, onboarding status, active question state
  - onboarding profile from `members.projectProfile`
  - confirmed personal signals from `users.communicationProfile.individualDiscovery.confirmedSignals`
  - latest round status/topic/response progress
  - privacy note that this view is private and group reports use aggregate/anonymized patterns
- Updated project-bot `/help` to mention `/me`.
- No schema changes: this uses existing `members.projectProfile` and `users.communicationProfile` as planned.

**What was tested**
- Ran `npx tsc --noEmit` successfully.
- Ran `npx vitest run src/project/individual-profile.test.ts src/project/report-reactions.test.ts`: 2 files passed, 3 tests passed.

**Current state**
- The first individual discovery slice is now implemented: members can inspect what Zolara knows privately before any deeper reflection/memory features are added.
- Stable named Cloudflare hostname remains the tester-readiness infrastructure blocker before live Telegram E2E smoke.

**Next actions**
- Add post-answer private reflection MVP with Accurate / Refine / Don’t remember buttons.
- Store confirmed reflection signals in `users.communicationProfile.individualDiscovery.confirmedSignals` with private scope.
- Live-test `/me` after stable webhook/preflight is available.

## 2026-05-02 02:34 — Post-answer private reflection MVP

**What was built**
- Added deterministic individual-discovery reflection helpers in `src/project/individual-profile.ts`:
  - simple signal extraction from answer text
  - reflection prompt formatting
  - confirmed-signal merge/dedupe into `users.communicationProfile.individualDiscovery.confirmedSignals`
- After a member answers an active round question, the project bot now optionally sends a private reflection prompt like: “I’m noticing this answer may emphasize clarity. Is that accurate?”
- Added reflection buttons:
  - `✅ Accurate — remember privately`
  - `✏️ Not quite`
  - `🚫 Don’t remember`
- Confirmed reflections are stored privately in `users.communicationProfile` with high confidence, project scope, source, and timestamp.
- Confirmation also writes an `individual_signal_confirmed` engagement event for auditability without exposing raw private answer text.
- `/me` will now surface confirmed private signals.

**What was tested**
- Ran `npx tsc --noEmit` successfully.
- Ran `npx vitest run src/project/individual-profile.test.ts src/project/report-reactions.test.ts`: 2 files passed, 5 tests passed.

**Current state**
- Individual discovery now has a minimal trust loop: answer → private hypothesis → user confirms/skips → confirmed signal appears in `/me`.
- Refinement by text is intentionally deferred; the `Not quite` button currently avoids storing the signal and explains that refinement is next.
- Stable named Cloudflare hostname remains the tester-readiness infrastructure blocker before live Telegram E2E smoke.

**Next actions**
- Add text-based refinement state for post-answer reflections.
- Lightly personalize question delivery from confirmed private signals.
- Live-test `/me` + reflection confirmation once stable webhook/preflight is available.

## 2026-05-02 03:04 — Light question personalization from confirmed signals

**What was built**
- Added individual-discovery helpers to choose a confirmed private signal for question personalization.
- `sendQuestionDM()` now loads the member’s `users.communicationProfile` and, when available, adds a short private note before the question.
- Personalization is deliberately light and optional: it says the confirmed lens may be useful and explicitly tells the member they can ignore it if it does not fit the current question.
- Only high-confidence, private, project-scoped confirmed signals are eligible.
- If profile lookup fails, Zolara logs the issue and still sends the unpersonalized question.

**What was tested**
- Ran `npx tsc --noEmit` successfully.
- Ran `npx vitest run src/project/individual-profile.test.ts`: 1 file passed, 5 tests passed.

**Current state**
- Individual discovery loop now covers: `/me` profile view → post-answer reflection → private confirmation storage → light future-question personalization.
- Stable named Cloudflare hostname remains the tester-readiness blocker before live Telegram E2E smoke.

**Next actions**
- Add text-based refinement for the `Not quite` reflection button.
- Live-test the personalized question copy once stable webhook/preflight is available.

## 2026-05-02 03:34 — Reflection refinement text flow

**What was built**
- Added text-based refinement for the individual-discovery `✏️ Not quite` button.
- When a member taps `Not quite`, Zolara now stores a short-lived Redis refinement state and asks them to reply with the better word/phrase or `skip`.
- The next private text reply is captured before AI fallback/question handling and saved as a refined private confirmed signal.
- Refined signals are stored in `users.communicationProfile.individualDiscovery.confirmedSignals` with source `post_answer_reflection_refined`.
- Added `individual_signal_refined` engagement audit event without raw answer content.
- Added normalization helper for safe short refinement labels.
- Cleaned up a duplicate `return` in the answer/reflection flow.

**What was tested**
- Ran `npx tsc --noEmit` successfully.
- Ran `npx vitest run src/project/individual-profile.test.ts`: 1 file passed, 6 tests passed.

**Current state**
- Individual discovery loop now supports correction, not just confirmation: answer → reflection → accurate/skip/refine → private profile update.
- Stable named Cloudflare hostname remains the tester-readiness blocker before live Telegram E2E smoke.

**Next actions**
- Add `/me` controls to forget confirmed signals.
- Live-test the full individual discovery path once stable webhook/preflight is available.

## 2026-05-02 04:10 — Managed bot update handler + readiness check

**What was built**
- Added a top-level `managed_bot` update handler in `src/project/index.ts` for the current Zolara control bot path.
- The new handler finalizes project bot setup through the existing idempotent `finalizeProjectBot()` path, stores/activates the project, sets the webhook/commands, and sends the admin the same next-step invite instructions.
- This complements the existing `Message.managed_bot_created` service-message handler so either Telegram Managed Bots delivery shape can activate a project.

**What was tested**
- Ran `npm run build` successfully after the handler change.
- Ran `npm run test -- src/project/report-reactions.test.ts src/project/dashboard.test.ts src/lifecycle-worker.test.ts`: 3 files passed, 13 tests passed.
- Ran `npm run readiness:check`; config/secrets and PM2 lifecycle scheduling passed, but release preflight failed on webhook infrastructure.

**Current state**
- Managed bot activation is safer for first testers because both documented Managed Bots update shapes are handled.
- Lifecycle worker scheduling still verifies as every-minute `cron_restart` with `autorestart=false`.
- Tester release remains blocked by webhook infrastructure: `WEBHOOK_BASE_URL` is still a random `trycloudflare.com` URL and public `/health` failed through that URL.

**Next actions**
- Configure named Cloudflare Tunnel/stable hostname and update `WEBHOOK_BASE_URL`.
- Rerun `npm run readiness:check` and `npm run smoke:status`.
- Then run the live Telegram E2E path: create/activate bot → onboard members → start round → synthesize/report → verify reactions/dashboard.

## 2026-05-02 04:39 — Readiness preflight distinguishes app vs tunnel

**What was built**
- Enhanced `scripts/check-tester-readiness.ts` so tester preflight now checks:
  - local `/health` on the host
  - public `/health` through `WEBHOOK_BASE_URL`
  - PM2 runtime status for `zolara`
  - PM2 runtime lifecycle-worker cron/autorestart/status, not just static ecosystem config
- Updated `docs/STABLE_WEBHOOK_RUNBOOK.md` with the stricter passing criteria and explicit `npm run lifecycle:once` verification step.

**What was tested**
- Ran `npm run build` successfully.
- Ran `npm run readiness:check`; local app and PM2 runtime checks now pass, but release preflight still fails on public webhook infrastructure.
- Ran `npm run lifecycle:once` successfully. Summary: 0 checked/expired/processed/failed and Redis lock was free.

**Current state**
- We now know the app itself is alive locally and PM2 lifecycle scheduling is installed correctly.
- The remaining first-tester blocker is specifically the external tunnel/hostname: `WEBHOOK_BASE_URL` is still random `trycloudflare.com`, and public `/health` through that URL fails.

**Next actions**
- Configure named Cloudflare Tunnel/stable hostname and update `WEBHOOK_BASE_URL`.
- Rerun `npm run readiness:check`, `npm run smoke:status`, then live Telegram E2E smoke.

## 2026-05-02 05:09 — Smoke baseline now includes PM2 + reaction diagnostics

**What was built**
- Enhanced `scripts/smoke-status.ts` so live E2E smoke baselines now include:
  - local `/health` check
  - public `/health` check
  - PM2 runtime status for `zolara` and lifecycle cron/autorestart
  - latest report reaction summary per recent project when a report exists
- Kept output redacted: no bot tokens, encrypted token blobs, webhook secrets, or raw `.env` values.
- Updated `docs/STABLE_WEBHOOK_RUNBOOK.md` so the smoke baseline description matches the richer diagnostics.

**What was tested**
- Ran `npm run build` successfully.
- Ran `npm run test -- src/project/report-reactions.test.ts src/project/dashboard.test.ts`: 2 files passed, 10 tests passed.
- Ran `npm run smoke:status`; diagnostics now show local health and PM2 pass, active project/webhook state is visible, and latest report reactions are only shown when a report exists.

**Current state**
- E2E smoke diagnostics are more useful for first-tester debugging and can distinguish app health, PM2 health, tunnel health, webhook host, project state, rounds, reports, and reactions.
- Current smoke baseline still fails before live testers because the public hostname is a random `trycloudflare.com` URL and public `/health` fails.
- Existing active project has onboarded members but no report; latest round is failed with `Question generation failed`, so a fresh E2E project/round should be used after stable webhook is fixed.

**Next actions**
- Configure named Cloudflare Tunnel/stable hostname and update `WEBHOOK_BASE_URL`.
- Rerun `npm run readiness:check` and `npm run smoke:status`.
- Start a fresh Telegram E2E smoke path rather than reusing the old failed round.

## 2026-05-02 05:39 — Named tunnel config + quick-tunnel runtime detection

**What was built**
- Updated `ecosystem-tunnel.config.cjs` from a random quick tunnel (`cloudflared tunnel --url http://localhost:3000`) to a named tunnel command: `cloudflared tunnel run zolara-prod` by default, configurable via `ZOLARA_TUNNEL_NAME`.
- Enhanced `scripts/check-tester-readiness.ts` to inspect both:
  - static PM2 tunnel config (`ecosystem-tunnel.config.cjs`) and pass only named tunnel config
  - live PM2 cloudflared runtime and fail if it is still running a quick `--url` tunnel
- Updated `docs/STABLE_WEBHOOK_RUNBOOK.md` with the PM2 named-tunnel start command and explicit rollback check for `pm2 show cloudflared`.

**What was tested**
- Ran `node -e "const cfg=require('./ecosystem-tunnel.config.cjs'); ..."` and confirmed the checked-in tunnel config resolves to `tunnel run zolara-prod`.
- Ran `npm run build` successfully.
- Ran `npm run readiness:check`; static tunnel config now passes, but runtime still fails because the currently running PM2 `cloudflared` process is still the old quick tunnel.

**Current state**
- Repository/config is now aligned with named Cloudflare Tunnel production requirements.
- The host runtime still needs migration: stop/restart PM2 cloudflared from the updated config after the named Cloudflare tunnel and DNS route are created.
- Tester preflight currently has 3 failures: random `trycloudflare.com` base URL, public `/health` failure, and live PM2 cloudflared still using `--url`.

**Next actions**
- Create/configure named Cloudflare Tunnel credentials + DNS route for `zolara-prod`.
- Run `ZOLARA_TUNNEL_NAME=zolara-prod pm2 restart ecosystem-tunnel.config.cjs --update-env` or delete/restart the current `cloudflared` PM2 app from the updated config.
- Update `.env` to the stable hostname, restart `zolara`, then rerun `npm run readiness:check` and `npm run smoke:status`.

## 2026-05-02 06:08 — Startup script hardened against quick-tunnel overwrite

**What was built**
- Reworked `scripts/start-zolara.sh` so tester/prod startup no longer scrapes PM2 cloudflared logs for random `trycloudflare.com` URLs.
- The startup path now treats `.env` `WEBHOOK_BASE_URL` as the source of truth for stable webhook hostnames.
- Quick-tunnel discovery/writing is now gated behind `ALLOW_EPHEMERAL_TUNNEL=1` for explicit local development only.
- Updated `docs/STABLE_WEBHOOK_RUNBOOK.md` to document the new startup safety behavior.

**What was tested**
- Ran `bash -n scripts/start-zolara.sh` successfully.
- Ran `npm run build` successfully.
- Ran `npm run readiness:check`; local app/PM2/static named-tunnel config still pass, but preflight correctly fails because runtime is still using old quick tunnel and `.env` is still trycloudflare.

**Current state**
- Zolara should no longer silently rewrite `.env` back to a random quick tunnel during normal tester/prod startup.
- Remaining blocker is operational: create named Cloudflare tunnel/DNS, restart PM2 `cloudflared` from updated named-tunnel config, update stable `WEBHOOK_BASE_URL`, restart Zolara, then rehook/smoke.

**Next actions**
- Configure named Cloudflare Tunnel credentials + DNS route for `zolara-prod`.
- Restart PM2 cloudflared from `ecosystem-tunnel.config.cjs` with `ZOLARA_TUNNEL_NAME=zolara-prod`.
- Update `.env` stable hostname and rerun `npm run readiness:check` + `npm run smoke:status`.

## 2026-05-02 06:38 — Smoke status now flags quick-tunnel PM2 runtime

**What was built**
- Enhanced `scripts/smoke-status.ts` so the smoke baseline PM2 check now includes the Cloudflare tunnel process.
- Smoke status now fails if live PM2 `cloudflared` is still running a quick tunnel (`tunnel --url ...`) instead of a named tunnel (`tunnel run <name>`).
- Updated `docs/STABLE_WEBHOOK_RUNBOOK.md` to note that the smoke baseline includes quick-tunnel detection.

**What was tested**
- Ran `npm run build` successfully.
- Ran `npm run readiness:check`; still correctly fails on random `trycloudflare.com`, public `/health`, and live quick-tunnel runtime.
- Ran `npm run smoke:status`; it now reports `pm2_runtime` as failed with `tunnel=online tunnel --url http://localhost:3000`, matching the readiness blocker.

**Current state**
- Both preflight and smoke baseline now point at the same operational blocker: migrate PM2 `cloudflared` from quick tunnel to named tunnel and set a stable `WEBHOOK_BASE_URL`.
- Local app health and lifecycle scheduling remain OK.

**Next actions**
- Configure named Cloudflare Tunnel credentials + DNS route for `zolara-prod`.
- Restart PM2 cloudflared from `ecosystem-tunnel.config.cjs` with `ZOLARA_TUNNEL_NAME=zolara-prod`.
- Update `.env` stable hostname, restart Zolara, rerun readiness + smoke.

## 2026-05-02 07:10 — Cloudflare named-tunnel prerequisite checks

**What was built**
- Enhanced `scripts/check-tester-readiness.ts` to inspect Cloudflare named-tunnel prerequisites on the host:
  - `~/.cloudflared/cert.pem` for tunnel management/login
  - `~/.cloudflared/config.yml` / `config.yaml`
  - named tunnel credentials JSON
  - config fields for `tunnel`, `credentials-file`, and ingress to local Zolara port 3000
- Updated `docs/STABLE_WEBHOOK_RUNBOOK.md` to make `cloudflared tunnel login`, `tunnel create`, credentials JSON, config.yml, and tunnel list/info checks explicit.

**What was tested**
- Ran `cloudflared tunnel list`; it fails because no origin cert exists yet.
- Ran `npm run build` successfully.
- Ran `npm run readiness:check`; it now identifies the deeper Cloudflare setup blockers, not just the quick-tunnel symptoms.

**Current state**
- Readiness now reports 6 expected failures:
  - `.env` `WEBHOOK_BASE_URL` is still random `trycloudflare.com`
  - public `/health` through that URL fails
  - Cloudflare origin cert is missing
  - Cloudflare named-tunnel config is missing
  - Cloudflare tunnel credentials JSON is missing
  - live PM2 cloudflared still uses quick `--url`
- Local app health, static named-tunnel PM2 config, and lifecycle worker scheduling remain OK.

**Next actions**
- Run interactive `cloudflared tunnel login` on the host.
- Create `zolara-prod`, route DNS to the stable hostname, write `~/.cloudflared/config.yml`, and migrate PM2 cloudflared to the named tunnel.
- Update `.env` stable hostname, restart Zolara, then rerun readiness + smoke.

## 2026-05-02 07:38 — Backend hosting option documented + Docker production hardening

**What was built**
- Added `docs/BACKEND_HOSTING_OPTIONS.md` after evaluating the GitHub Pages idea:
  - GitHub Pages is OK for static landing/docs only.
  - Telegram webhooks require a live HTTPS backend with Node, DB, Redis, and secrets.
  - Recommended first-tester paths are either finish named Cloudflare Tunnel on this host or move backend to a VPS/container platform.
- Hardened container deployment basics:
  - `Dockerfile` now starts the compiled app with `npm start` instead of dev watcher mode.
  - Added `.dockerignore` to keep `.env`, `node_modules`, logs, dist, and repo noise out of build context.
  - Fixed `docker-compose.yml` env names to match current config (`ZOLARA_BOT_TOKEN`, `MANAGED_BOTS_TOKEN`) and strengthened the dev webhook secret default length.

**What was tested**
- Ran `npm run build` successfully.
- Ran `npm run readiness:check`; still fails on the same Cloudflare runtime/setup blockers, while local app and lifecycle checks pass.

**Current state**
- GitHub Pages is explicitly documented as insufficient for webhook runtime.
- Zolara is a bit more ready for an alternative container/VPS deployment if we choose to avoid Cloudflare Tunnel setup.
- First-tester blocker remains stable public HTTPS backend: either named tunnel credentials/DNS on this host or deploy backend to a platform with HTTPS.

**Next actions**
- Decide infrastructure path:
  1. Complete named Cloudflare Tunnel setup on current host, or
  2. Deploy Dockerized backend to VPS/Render/Railway/Fly with managed Postgres/Redis.
- Then rerun `npm run readiness:check` and `npm run smoke:status` before live E2E smoke.

## 2026-05-02 08:11 — Docker deploy path verified

**What was built**
- Removed the non-portable local `file:../self-healing-agent/dist` dependency from `package.json`/`package-lock.json` so container/platform builds do not depend on a sibling checkout outside the repo.
- Added `src/types/self-healing-agent.d.ts` so TypeScript still understands the optional self-healing integration while runtime keeps the existing try/catch fallback when the package is unavailable.
- Updated `docs/BACKEND_HOSTING_OPTIONS.md` to mark the Docker build path as locally verified and explain that self-healing is optional.

**What was tested**
- Ran `npm install --package-lock-only` successfully after dependency cleanup.
- Ran `npm run build` successfully.
- Ran `docker build -t zolara:test .` successfully. This verifies the Docker context can install dependencies and compile without the sibling `self-healing-agent` package.
- Ran `npm run readiness:check`; it still fails only on stable-public-HTTPS/Cloudflare setup blockers, while local app/lifecycle checks pass.

**Current state**
- Alternative backend hosting is materially more viable: the app now builds in a clean Docker context.
- First-tester blocker remains choosing/provisioning stable HTTPS runtime: named Cloudflare Tunnel on this host, or Docker backend on VPS/Render/Railway/Fly with Postgres/Redis and a scheduled lifecycle worker.

**Next actions**
- Pick infrastructure path.
- If container platform: provision Postgres/Redis/secrets, deploy `zolara:test` equivalent, schedule `npm run lifecycle:once`, rehook bots, then run readiness + smoke.
- If current host: complete Cloudflare login/tunnel/DNS and migrate PM2 cloudflared to named tunnel.

## 2026-05-02 08:38 — Container lifecycle worker loop added

**What was built**
- Added `scripts/container-lifecycle-loop.sh` for container hosts that can run a separate always-on worker process but do not provide native cron.
- Added `npm run lifecycle:loop`, which calls the existing safe one-shot `npm run lifecycle:once` every 60 seconds by default.
- Kept PM2 behavior unchanged: PM2 deployments should continue using `cron_restart: '* * * * *'` with `autorestart: false`.
- Updated `docs/BACKEND_HOSTING_OPTIONS.md` so container/VPS deploy instructions include both cron-style scheduling and the new always-on worker fallback.

**What was tested**
- Ran `bash -n scripts/container-lifecycle-loop.sh` successfully.
- Ran `npm run build` successfully.
- Ran `npm run lifecycle:once` successfully: lock acquired, 0 validation deadlines, 0 round deadlines, 0 failures.
- Ran `npm run readiness:check`; stable-public-HTTPS/Cloudflare setup remains the only tester blocker class.

**Current state**
- Container deployment path now has a concrete recurring lifecycle-worker option, not just a PM2 cron assumption.
- First-tester blocker remains infrastructure: stable HTTPS backend via named Cloudflare Tunnel or deployed container platform.

**Next actions**
- Choose and provision stable HTTPS runtime.
- Once a stable URL exists, update `WEBHOOK_BASE_URL`, rehook bots, run `npm run readiness:check` and `npm run smoke:status`, then do live Telegram E2E smoke.

## 2026-05-02 09:08 — Smoke reaction summary made independent of recent rounds window

**What was built**
- Hardened `scripts/smoke-status.ts` report-reaction diagnostics.
- The smoke helper now resolves the latest report's round number directly from `reports.roundId` instead of depending on that round being present in the latest 3 rounds list.
- This prevents `latestReportReactions` from silently disappearing in older projects with more than 3 rounds once reports exist.

**What was tested**
- Ran `npm run build` successfully.
- Ran `npx vitest run src/project/report-reactions.test.ts` successfully: 1 file passed, 1 test passed.
- Ran `npm run smoke:status`; it still correctly fails on stable-host/public-health/quick-tunnel blockers and shows the active project baseline safely redacted.
- Ran `npm run readiness:check`; it still reports the same 6 expected stable-public-HTTPS/Cloudflare setup failures.

**Current state**
- Smoke diagnostics are more reliable for the report-reaction part of the live E2E path.
- Active test project still has no reports; latest round failed at question generation, so final E2E should use a fresh round/project after stable webhook is fixed.
- Tester blocker remains infrastructure: `WEBHOOK_BASE_URL` is still random `trycloudflare.com`, public health fails, Cloudflare named-tunnel cert/config/credentials are missing, and PM2 cloudflared is still running quick `--url` mode.

**Next actions**
- Provision stable HTTPS runtime via named Cloudflare Tunnel or deployed container host.
- Update `WEBHOOK_BASE_URL`, restart/rehook, then rerun readiness + smoke before live Telegram E2E.

## 2026-05-02 09:38 — Smoke verifies webhook allowed_updates

**What was built**
- Centralized project-bot webhook `allowed_updates` into `PROJECT_BOT_ALLOWED_UPDATES` in `src/telegram/managed-bots-api.ts`.
- Updated `setManagedBotWebhook()` to use the shared constant, keeping future setup and diagnostics aligned.
- Enhanced `scripts/smoke-status.ts` to inspect Telegram `getWebhookInfo.allowed_updates` for recent active project bots and flag missing update types.
- Added a new smoke check: `active_webhooks_allowed_updates`.

**What was tested**
- Ran `npm run build` successfully.
- Ran `npm run smoke:status`; it now reports the active project webhook includes required allowed updates, while still failing on the known stable-host/public-health/quick-tunnel blockers.
- Ran `npm run readiness:check`; it still reports the same 6 expected stable-public-HTTPS/Cloudflare setup failures.

**Current state**
- The live E2E smoke baseline now covers webhook update subscriptions explicitly, including `message`, `callback_query`, `chat_member`, `poll_answer`, and reaction updates.
- Current active project webhook has the right allowed update set, but it is still pointed at the random trycloudflare host.
- Tester blocker remains infrastructure: stable HTTPS backend and named tunnel/deployed host.

**Next actions**
- Provision stable HTTPS runtime, update `WEBHOOK_BASE_URL`, restart/rehook, and rerun readiness + smoke.
- After that, start a fresh Telegram E2E project/round rather than reusing the old failed round.

## 2026-05-02 10:08 — Readiness supports external/container hosting mode

**What was built**
- Added `ZOLARA_HOSTING_MODE=external` support to `scripts/check-tester-readiness.ts`.
- Default mode remains `cloudflare`, so the current host still fails hard on missing named-tunnel cert/config/credentials and quick-tunnel PM2 runtime.
- External mode skips local Cloudflare named-tunnel file requirements and downgrades PM2 quick-tunnel runtime to a warning, while still requiring:
  - configured secrets
  - HTTPS `WEBHOOK_BASE_URL`
  - non-`trycloudflare.com` stable host
  - working public `/health`
- Updated `docs/BACKEND_HOSTING_OPTIONS.md` so container/platform deploys set `ZOLARA_HOSTING_MODE=external` and verify with that mode.

**What was tested**
- Ran `npm run build` successfully.
- Ran default `npm run readiness:check`; it still reports the same 6 current-host Cloudflare failures.
- Ran `ZOLARA_HOSTING_MODE=external npm run readiness:check`; Cloudflare host-file checks are skipped, but it still correctly fails on the current random `trycloudflare.com` `WEBHOOK_BASE_URL` and failed public `/health`.

**Current state**
- The readiness check now cleanly supports both tester infrastructure paths:
  - current host + named Cloudflare Tunnel (`ZOLARA_HOSTING_MODE` unset/default)
  - external Docker/VPS/container HTTPS runtime (`ZOLARA_HOSTING_MODE=external`)
- The actual first-tester blocker remains stable HTTPS runtime; no stable public backend is configured yet.

**Next actions**
- Choose one hosting path and provision the stable URL.
- Update `WEBHOOK_BASE_URL`, rehook bots, then rerun readiness + smoke before live Telegram E2E.

## 2026-05-02 10:58 — Rehook safety hardened + smoke detects unset webhooks

**What was built**
- Hardened `scripts/rehook-all.sh` for stable-host migration:
  - added `DRY_RUN=1` mode for safe preflight before changing Telegram webhook state
  - refuses reserved/example hostnames (`example.com`, `example.org`, etc.) unless explicitly overridden
  - keeps refusing random `trycloudflare.com` unless `ALLOW_EPHEMERAL_TUNNEL=1` is set for local/dev repair
  - makes `.env` update optional/portable for container platforms where env is injected
  - checks `setWebhook` API results and exits non-zero when any active bot fails
- Updated `docs/BACKEND_HOSTING_OPTIONS.md` to require dry-run before real rehook and to note reserved-host refusal.
- Enhanced `scripts/smoke-status.ts` with `active_webhooks_set`, so active project bots with no Telegram webhook URL are now flagged explicitly.

**What was tested**
- Ran `bash -n scripts/rehook-all.sh` successfully.
- Ran a dry-run against a reserved hostname and confirmed it is refused before Telegram API calls.
- Ran a dry-run against an allowed placeholder hostname with `ALLOW_RESERVED_HOST=1`; it listed the project bots that would be rehooked without mutating Telegram state.
- Ran `npm run build` successfully.
- Ran `npm run smoke:status`; it now flags `active_webhooks_set` as failed for the current active test bot.

**Current state**
- Rehook tooling is safer for the upcoming stable-host cutover.
- Smoke now detects that the current active test bot has no webhook URL set. Attempting to restore the old random trycloudflare webhook failed because the current random host does not resolve, which matches the existing public-health blocker.
- First-tester blocker remains stable HTTPS runtime. Once a real stable host is available, run:
  - `DRY_RUN=1 WEBHOOK_BASE_URL=https://<stable-host> scripts/rehook-all.sh`
  - `WEBHOOK_BASE_URL=https://<stable-host> scripts/rehook-all.sh`
  - `npm run readiness:check && npm run smoke:status`

**Next actions**
- Provision stable HTTPS runtime via named Cloudflare Tunnel or external backend host.
- Rehook active bots only after public `/health` passes on that stable host.

## 2026-05-02 11:19 — Rehook dry-run no longer blocked by legacy active rows

**What was built**
- Refined `scripts/rehook-all.sh` so the stable-host cutover is not blocked by legacy/incomplete active rows that have no project-bot username or credentials.
- Such rows are now counted as `skipped` with a warning during dry-run/rehook.
- Active rows that do have a bot username but are missing token/secret still fail, because those represent real project-bot configuration corruption.
- Updated `docs/BACKEND_HOSTING_OPTIONS.md` to document the skip/fail behavior.

**What was tested**
- Ran `bash -n scripts/rehook-all.sh` successfully.
- Ran `DRY_RUN=1 WEBHOOK_BASE_URL=https://stable.example.org ALLOW_RESERVED_HOST=1 ENV_FILE=/tmp/zolara-test.env scripts/rehook-all.sh`; result: 2 project-bot webhooks would be registered, 1 incomplete legacy active row skipped, 0 failures.
- Ran `npm run build` successfully.
- Ran `npm run smoke:status`; it still correctly fails on random `trycloudflare`, public `/health`, quick-tunnel PM2 runtime, and unset active webhook.
- Ran `npm run readiness:check`; it still reports the same current-host stable HTTPS/Cloudflare failures.

**Current state**
- Rehook preflight is now useful for the real cutover: it will show which actual project bots will be rehooked and will not abort on the known incomplete legacy row.
- Active test bot remains without a webhook until a stable public host is available.
- First-tester blocker remains stable HTTPS runtime.

**Next actions**
- Provision stable HTTPS host.
- Run dry-run rehook, real rehook, readiness, smoke, then fresh Telegram E2E.

## 2026-05-02 11:49 — Smoke surfaces incomplete active rows + cleanup dry-run added

**What was built**
- Enhanced `scripts/smoke-status.ts` to inspect all active project rows, not just the latest 5 projects.
- Smoke now reports:
  - count of active project bots with usable credentials
  - `active_rows_without_bot_credentials` when active rows are missing bot username/token/secret
- Added `scripts/archive-incomplete-active-projects.ts` and `npm run cleanup:incomplete-active-projects`.
  - Dry-run by default.
  - Prints only redacted IDs and non-secret metadata.
  - Requires `CONFIRM_ARCHIVE=1` before archiving incomplete active rows.

**What was tested**
- Ran `npm run build` successfully.
- Ran `npm run smoke:status`; it now flags 1 incomplete active row (`7767…37c8`) in addition to the existing stable-host/public-health/quick-tunnel/unset-webhook blockers.
- Ran `npm run cleanup:incomplete-active-projects`; dry-run found 1 incomplete active row: `Zolara project` missing botUsername, botTokenEncrypted, and webhookSecret.
- Ran `npm run readiness:check`; it still reports the same current-host stable HTTPS/Cloudflare failures.

**Current state**
- We have a safe cleanup path for the legacy incomplete active row, but it has not been mutated.
- Rehook dry-run remains clean for real project bots: 2 would register, 1 incomplete legacy row can be skipped/archived.
- First-tester blocker remains stable HTTPS runtime, plus the active test bot has no webhook until rehooked to that stable host.

**Next actions**
- Decide whether to archive the incomplete active row with `CONFIRM_ARCHIVE=1 npm run cleanup:incomplete-active-projects`.
- Provision stable HTTPS host, dry-run rehook, real rehook, readiness, smoke, fresh Telegram E2E.

## 2026-05-02 12:19 — Smoke supports external/container hosting mode

**What was built**
- Added `ZOLARA_HOSTING_MODE=external` support to `scripts/smoke-status.ts`.
- Smoke now emits a `hosting_mode` check so the baseline clearly states whether it is evaluating current-host Cloudflare mode or external/container hosting mode.
- In external mode, PM2 tunnel runtime is ignored instead of failing the smoke baseline, matching readiness behavior.
- Updated `docs/BACKEND_HOSTING_OPTIONS.md` so external/container verification runs both readiness and smoke with `ZOLARA_HOSTING_MODE=external`.

**What was tested**
- Ran `npm run build` successfully.
- Ran default `npm run readiness:check`; it still reports the same 6 current-host Cloudflare/stable HTTPS failures.
- Ran `ZOLARA_HOSTING_MODE=external npm run smoke:status`; PM2 tunnel quick-mode is now correctly ignored in external mode, while the smoke still fails on the true remaining blockers: random `trycloudflare.com`, failed public `/health`, one incomplete active row, and unset active bot webhook.

**Current state**
- Both readiness and smoke now support the two infrastructure paths consistently:
  - current host + named Cloudflare Tunnel
  - external/container HTTPS backend
- The external/container path will not be falsely blocked by local PM2 cloudflared state.
- First-tester blocker remains stable HTTPS runtime; current active test bot still needs rehook after that host exists.

**Next actions**
- Choose/provision stable HTTPS host.
- Optionally archive incomplete legacy active row.
- Run dry-run rehook, real rehook, readiness, smoke, fresh Telegram E2E.

## 2026-05-02 12:49 — Readiness now checks active project DB hygiene

**What was built**
- Enhanced `scripts/check-tester-readiness.ts` to inspect active project rows in the database.
- Readiness now reports:
  - count of active project bots with usable credentials
  - incomplete active project rows missing bot username/token/secret, using redacted IDs only
- Fixed readiness process exit behavior after adding DB inspection so postgres-js idle handles do not leave the command hanging.

**What was tested**
- Ran `npm run build` successfully.
- Ran default `npm run readiness:check`; it now reports 7 failures: the previous 6 current-host Cloudflare/stable HTTPS blockers plus 1 incomplete active row (`7767…37c8`).
- Ran `ZOLARA_HOSTING_MODE=external npm run readiness:check`; it now reports 3 failures: random `trycloudflare.com`, failed public `/health`, and the incomplete active row. PM2 quick tunnel is only a warning in external mode.

**Current state**
- Readiness and smoke now both surface the incomplete legacy active row instead of leaving it only to smoke diagnostics.
- Active project bots with credentials: 2.
- Incomplete active row remains unmodified; cleanup is available via dry-run-first script.
- Stable HTTPS runtime remains the main first-tester blocker.

**Next actions**
- Decide whether to archive incomplete row with `CONFIRM_ARCHIVE=1 npm run cleanup:incomplete-active-projects`.
- Provision stable HTTPS host, dry-run rehook, real rehook, readiness, smoke, fresh Telegram E2E.

## 2026-05-02 13:19 — Readiness now verifies project-bot Telegram webhooks

**What was built**
- Enhanced `scripts/check-tester-readiness.ts` to call Telegram `getWebhookInfo` for active project bots with credentials.
- Readiness now fails before testers if an active project bot:
  - has no webhook URL set
  - points at a host different from `WEBHOOK_BASE_URL`
  - is missing required `allowed_updates`
- Output remains redacted: no bot tokens, webhook secrets, encrypted token blobs, or full webhook URLs are printed.

**What was tested**
- Ran `npm run build` successfully.
- Ran default `npm run readiness:check`; it now reports 9 failures: existing current-host Cloudflare/stable HTTPS blockers, incomplete active row, and both credentialed project bots having no webhook URL set.
- Ran `ZOLARA_HOSTING_MODE=external npm run readiness:check`; it now reports 5 real external-mode failures: random `trycloudflare.com`, failed public `/health`, incomplete active row, and both credentialed project bots having no webhook URL set. PM2 quick tunnel remains only a warning in external mode.

**Current state**
- Readiness now catches the same unset-webhook issue as smoke, earlier in the preflight.
- Credentialed active project bots: 2.
- Both currently have no Telegram webhook URL and must be rehooked after a stable public host is available.
- Stable HTTPS runtime remains the main first-tester blocker.

**Next actions**
- Provision stable HTTPS host.
- Optionally archive incomplete legacy active row.
- Run `DRY_RUN=1 WEBHOOK_BASE_URL=https://<stable-host> scripts/rehook-all.sh`, then real rehook, readiness, smoke, fresh Telegram E2E.

## 2026-05-02 13:44 — Smoke now audits all active project-bot webhooks

**What was built**
- Enhanced `scripts/smoke-status.ts` so webhook checks inspect every active project bot with credentials, not only active projects that happen to appear in the latest-five project summary.
- `active_webhooks_set` now reports the full count/list of active credentialed bots with unset webhooks.
- This aligns smoke with readiness and prevents older active bots from being silently missed.

**What was tested**
- Ran `npm run build` successfully.
- Ran default `npm run readiness:check`; current result remains 9 failures: random `trycloudflare`, failed public `/health`, missing Cloudflare named-tunnel local files/runtime, incomplete active row, and both active project bot webhooks unset.
- Ran `npm run smoke:status`; it now reports `2 active project bot webhook(s) unset: @pilot_project_zolara_b_zol_bot, @zolaraflowtest_zolaa_bot`.
- Ran `ZOLARA_HOSTING_MODE=external npm run smoke:status`; PM2 tunnel is ignored for external mode and the same real webhook/host blockers remain.

**Current state**
- Readiness and smoke now agree that there are 2 credentialed active project bots and both need webhook registration after stable hosting is available.
- The known incomplete legacy active row remains unmodified.
- Stable HTTPS runtime remains the main first-tester blocker.

**Next actions**
- Provision stable HTTPS host.
- Optionally archive incomplete legacy active row.
- Run dry-run rehook, real rehook, readiness, smoke, fresh Telegram E2E.

## 2026-05-02 14:14 — Startup auto-rehook logging hardened

**What was built**
- Hardened `src/server/index.ts` startup auto-rehook logging for stable-host cutover.
- Auto-rehook no longer prints full project-bot webhook URLs/token hashes in logs; it now reports the target host only.
- Auto-rehook now summarizes `registered`, `skipped`, `failed`, and `activeRows`, so the known incomplete legacy active row is visible without making the startup summary look like a successful full registration.

**What was tested**
- Ran `npm run build` successfully.
- Ran `npm run smoke:status`; current failures remain expected: random `trycloudflare`, failed public `/health`, PM2 quick tunnel in current-host mode, incomplete active row, and 2 active project bot webhooks unset.
- Ran `npm run readiness:check`; current result remains 9 failures with the same known stable-host/webhook blockers.

**Current state**
- Startup auto-rehook is safer for production-style logs when the stable host is cut over.
- Readiness and smoke still agree that 2 credentialed active project bots need webhook registration after stable HTTPS hosting exists.
- Stable HTTPS runtime remains the main first-tester blocker.

**Next actions**
- Provision stable HTTPS host.
- Optionally archive incomplete legacy active row.
- Run dry-run rehook, real rehook, readiness, smoke, fresh Telegram E2E.

## 2026-05-02 14:44 — Auto-rehook now fails partial credential corruption

**What was built**
- Tightened startup auto-rehook behavior in `src/server/index.ts`:
  - legacy active rows with no bot username/token/secret are still skipped safely
  - active rows that have a bot username but are missing token or webhook secret now count as failures instead of being silently skipped
- This matches the stricter `scripts/rehook-all.sh` cutover behavior and prevents real project-bot credential corruption from being hidden during startup.

**What was tested**
- Ran `npm run build` successfully.
- Ran `npm run smoke:status`; current failures remain expected: random `trycloudflare`, failed public `/health`, PM2 quick tunnel in current-host mode, incomplete active row, and 2 active project-bot webhooks unset.
- Ran `npm run readiness:check`; current result remains 9 known failures with stable-host/webhook blockers.

**Current state**
- Manual rehook, startup auto-rehook, readiness, and smoke now agree on how to treat incomplete vs corrupt active project bot rows.
- Stable HTTPS runtime remains the main first-tester blocker.

**Next actions**
- Provision stable HTTPS host.
- Optionally archive incomplete legacy active row.
- Run dry-run rehook, real rehook, readiness, smoke, fresh Telegram E2E.

## 2026-05-02 15:14 — Readiness/smoke classify incomplete vs corrupt bot rows

**What was built**
- Refined `scripts/check-tester-readiness.ts` active-project DB hygiene output to distinguish:
  - legacy incomplete active rows with no bot identity/credentials
  - active project-bot rows with a username but partial credentials
  - odd partial rows with token/secret but no username
- Refined `scripts/smoke-status.ts` to show the same classification in `active_rows_without_bot_credentials`.
- This makes the stable-host cutover checklist clearer: the current known bad row is legacy incomplete, while partial project-bot credentials would be a separate corruption failure.

**What was tested**
- Ran `npm run build` successfully.
- Ran `npm run readiness:check`; it now reports `Legacy incomplete active project rows: 1 (7767…37c8)` and `No active project-bot rows with partial credentials`, plus the same known stable-host/webhook blockers.
- Ran `npm run smoke:status`; `active_rows_without_bot_credentials` now reports `1 legacy incomplete row(s), 0 project-bot row(s) with partial credentials, 0 odd partial row(s): 7767…37c8`.

**Current state**
- Rehook, startup auto-rehook, readiness, and smoke now share the same mental model for active-row hygiene.
- Two credentialed active project bots still have unset webhooks and need rehook after stable HTTPS exists.
- Stable HTTPS runtime remains the main first-tester blocker.

**Next actions**
- Provision stable HTTPS host.
- Optionally archive incomplete legacy active row.
- Run dry-run rehook, real rehook, readiness, smoke, fresh Telegram E2E.

## 2026-05-02 15:44 — Lifecycle worker summaries are now auditable in smoke

**What was built**
- Added `lifecycle_worker_summary` audit events in `src/util/lifecycle-worker.ts` for every lifecycle worker run, including locked/skipped runs.
- Each audit event records non-secret summary data: lock state, duration, validation deadline counts, round deadline counts, and totals.
- Enhanced `scripts/smoke-status.ts` with a `lifecycle_worker_observable` check that requires a recent lifecycle summary audit event and prints a concise, safe summary.
- Smoke output now includes `latestLifecycleWorker` so tester readiness can verify the recurring one-shot worker is actually writing observable run results, not only configured in PM2.

**What was tested**
- Ran `npm run build` successfully.
- Ran `npm run lifecycle:once`; it completed with `locked=false`, duration ~211ms, and zero pending validation/round deadline work.
- Ran `npm run smoke:status`; it now reports `lifecycle_worker_observable` as passing with a recent lifecycle summary audit event.
- Ran `npm run readiness:check`; current result remains 9 known failures from stable-host/webhook blockers.

**Current state**
- Lifecycle scheduling is now observable through DB audit events and smoke status, which helps distinguish PM2 config from actual worker execution.
- Stable HTTPS runtime and project-bot rehooking remain the first-tester blockers.

**Next actions**
- Provision stable HTTPS host.
- Optionally archive incomplete legacy active row.
- Run dry-run rehook, real rehook, readiness, smoke, fresh Telegram E2E.

## 2026-05-02 16:14 — Readiness now checks lifecycle audit freshness + audit schema fixed

**What was built**
- Enhanced `scripts/check-tester-readiness.ts` with a lifecycle observability check.
  - It reads the latest `lifecycle_worker_summary` audit event.
  - It reports age, locked state, totals, and duration without printing secrets.
  - It passes when the latest summary is recent enough for tester readiness.
- Fixed `engagement_events.member_id` so system/project-level audit events can be written without a member.
  - Changed schema from `serial('member_id')` to nullable `integer('member_id')`.
  - Added `drizzle/0004_nullable_engagement_event_member.sql`.
  - Applied the safe ALTER statements to the current DB: drop default and drop NOT NULL.
- Updated `src/util/audit.ts` so global audit events explicitly write `memberId: null` / `projectId: null` when absent.

**What was tested**
- Ran `npm run build` successfully after the schema/audit changes.
- Ran `npm run lifecycle:once`; after the DB fix it writes a fresh `lifecycle_worker_summary` event successfully.
- Ran `npm run readiness:check`; it now reports lifecycle summary audit as recent and still fails on the known stable-host/webhook blockers.
- Ran `npm run smoke:status`; it still reports the known blockers and includes the latest lifecycle worker summary.

**Current state**
- Lifecycle observability is now covered by both readiness and smoke.
- System-level audit events no longer depend on an arbitrary member row.
- Stable HTTPS runtime and project-bot rehooking remain the first-tester blockers.

**Next actions**
- Provision stable HTTPS host.
- Optionally archive incomplete legacy active row.
- Run dry-run rehook, real rehook, readiness, smoke, fresh Telegram E2E.

## 2026-05-02 16:44 — Dashboard `/next` now handles failed/cancelled rounds

**What was built**
- Improved `recommendAdminNextAction` in `src/project/dashboard.ts` so failed and cancelled rounds are treated as actionable recovery states.
- A failed latest round now tells the admin to restart with a clearer topic instead of falling through to the generic first-round guidance.
- A cancelled latest round now tells the admin to start a replacement round.
- Added dashboard helper test coverage for both states.

**What was tested**
- Ran `npm run build` successfully.
- Ran `npx vitest run src/project/dashboard.test.ts`; 10 tests passed.
- Ran `npm run readiness:check`; lifecycle audit remains fresh and current failures remain the known stable-host/webhook blockers.

**Current state**
- `/dashboard` and `/next` recovery guidance is clearer for the current failed-round smoke state.
- Stable HTTPS runtime and project-bot rehooking remain the first-tester blockers.

**Next actions**
- Provision stable HTTPS host.
- Optionally archive incomplete legacy active row.
- Run dry-run rehook, real rehook, readiness, smoke, fresh Telegram E2E.

## 2026-05-02 17:14 — Report reaction callbacks hardened for stale/non-member taps

**What was built**
- Added `isValidReportReaction` in `src/project/report-reactions.ts` and test coverage for valid/invalid reaction callback values.
- Hardened report reaction callbacks in both the control-plane bot (`src/project/index.ts`) and per-project bot handler (`src/project/managed-bots/bot-instance.ts`).
- Invalid/stale reaction callback data now shows a clear stale-reaction alert instead of silently doing nothing or storing junk.
- Users who tap a report reaction before being connected as project members now get a clear alert to open the project bot invite first, so tester feedback is not silently dropped.
- Valid member reactions now acknowledge only after the DB insert succeeds.

**What was tested**
- Ran `npm run build` successfully.
- Ran `npx vitest run src/project/report-reactions.test.ts`; 2 tests passed.
- Ran `npm run readiness:check`; current failures remain the known stable-host/webhook blockers.

**Current state**
- Report reaction fallback behavior is safer for first testers and should be less confusing during live E2E.
- Stable HTTPS runtime and project-bot rehooking remain the first-tester blockers.

**Next actions**
- Provision stable HTTPS host.
- Optionally archive incomplete legacy active row.
- Run dry-run rehook, real rehook, readiness, smoke, fresh Telegram E2E.

## 2026-05-02 18:05 — 18 tests passing; stable HTTPS still requires manual Cloudflare setup

**What was built**
- All previous report reaction hardening remains in place (isValidReportReaction, stale/non-member callbacks).
- Ran full test suite: `npm run build` passes, 18 tests across dashboard, report-reactions, and individual-profile pass.

**What was tested**
- `npm run build` ✅
- `npx vitest run src/project/dashboard.test.ts src/project/report-reactions.test.ts src/project/individual-profile.test.ts` ✅ 18 tests passed
- `npm run readiness:check` still reports 9 known failures

**Current state**
- All code/test items from the tester-readiness plan are in good shape.
- Stable HTTPS host is the remaining hard blocker — requires manual Cloudflare one-time setup (tunnel login, create, route DNS) which cannot be done programmatically in this session.

**Next actions**
- Manual (user): Run `cloudflared tunnel login`, `cloudflared tunnel create zolara-prod`, add DNS route, update `~/.cloudflared/config.yml`, then start named tunnel
- Manual (user): Start named tunnel via `ecosystem-tunnel.config.cjs` or direct `cloudflared tunnel run`
- After stable HTTPS exists: rehook project bots, archive legacy incomplete row, run E2E smoke

## 2026-05-02 18:14 — Readiness check now prints concrete remediation actions

**What was built**
- Enhanced `scripts/check-tester-readiness.ts` to collect and print a deduplicated **Next actions** section when preflight failures remain.
- The readiness output now tells the operator exactly what to do for the current blockers:
  - Run Cloudflare named-tunnel login/create/route DNS.
  - Create `~/.cloudflared/config.yml` for `zolara-prod` with ingress to `localhost:3000`.
  - Restart the PM2 tunnel using the named tunnel config.
  - Review/archive incomplete active project rows only after approval.
  - Rehook project bots after stable public `/health` passes.
- Ran the incomplete-active cleanup script in dry-run mode; it still identifies only the known legacy row `7767…37c8` and made no DB changes.

**What was tested**
- Ran `npm run build` successfully.
- Ran `npm run readiness:check`; it still fails on the 9 known blockers, but now includes concrete remediation steps.
- Ran `npm run cleanup:incomplete-active-projects` dry-run successfully.

**Current state**
- Stable HTTPS setup remains blocked on interactive Cloudflare/domain work.
- The readiness command is now more useful for the exact handoff required to unblock testers.

**Next actions**
- Manual Cloudflare setup: login, create `zolara-prod`, route DNS, create config, start named tunnel.
- After stable host works: rehook active project bots, archive the legacy incomplete row with approval, run full E2E smoke.

## 2026-05-02 18:44 — Added safe Cloudflare tunnel config helper

**What was built**
- Added `scripts/prepare-cloudflare-tunnel-config.ts` and npm script `tunnel:prepare-config`.
- The helper prepares `~/.cloudflared/config.yml` after the interactive Cloudflare prerequisites are done.
- Safety checks:
  - Dry-run by default; requires `CONFIRM_WRITE=1` to write.
  - Refuses random `trycloudflare.com` hostnames and localhost/reserved hosts.
  - Requires `~/.cloudflared/cert.pem` and tunnel credentials JSON before writing.
  - Prints only paths and hostname, never credential contents.
- Updated `docs/STABLE_WEBHOOK_RUNBOOK.md` to use the helper instead of hand-editing the config.

**What was tested**
- Ran `npm run build` successfully.
- Ran `WEBHOOK_BASE_URL=<current trycloudflare URL> npm run tunnel:prepare-config`; it correctly refused the random hostname.
- Ran `WEBHOOK_BASE_URL=https://zolara.example.com npm run tunnel:prepare-config`; it correctly stopped at missing `~/.cloudflared/cert.pem`.
- Ran `npm run readiness:check`; current result remains the known 9 stable-host/webhook blockers.

**Current state**
- Stable HTTPS setup is still blocked on interactive Cloudflare login/create/route DNS.
- Once the operator completes login/create, the config step is now scripted and safer.

**Next actions**
- Manual Cloudflare setup: `cloudflared tunnel login`, `cloudflared tunnel create zolara-prod`, route DNS for the chosen stable hostname.
- Then run `CONFIRM_WRITE=1 WEBHOOK_BASE_URL=https://<stable-host> npm run tunnel:prepare-config`.
- Start named tunnel, update/restart PM2, rehook project bots, archive the legacy row with approval, run E2E smoke.

## 2026-05-02 19:14 — Readiness handoff now points to tunnel config helper

**What was built**
- Updated `scripts/check-tester-readiness.ts` remediation output so the missing Cloudflare config action points to the safe helper added last cycle:
  - `CONFIRM_WRITE=1 WEBHOOK_BASE_URL=https://<stable-host> npm run tunnel:prepare-config`
- This keeps the readiness failure output aligned with the runbook and avoids asking the operator to hand-edit `~/.cloudflared/config.yml`.

**What was tested**
- Ran `npm run build` successfully.
- Ran `WEBHOOK_BASE_URL=https://zolara.example.com npm run tunnel:prepare-config`; it correctly stopped at missing `~/.cloudflared/cert.pem`.
- Ran `npm run readiness:check`; current failures remain the known 9 stable-host/webhook blockers, and the Next actions now reference the helper.

**Current state**
- Stable HTTPS setup is still blocked on interactive Cloudflare login/create/route DNS.
- Operator handoff is more consistent: runbook and readiness output now name the same config command.

**Next actions**
- Manual Cloudflare setup: `cloudflared tunnel login`, `cloudflared tunnel create zolara-prod`, route DNS.
- Then run `CONFIRM_WRITE=1 WEBHOOK_BASE_URL=https://<stable-host> npm run tunnel:prepare-config`, start named tunnel, rehook bots, archive legacy row with approval, run E2E smoke.

## 2026-05-02 19:44 — Smoke status now emits actionable remediation list

**What was built**
- Enhanced `scripts/smoke-status.ts` so JSON output includes a `nextActions` array when checks fail.
- The smoke output now maps failing checks to safe operational remediation:
  - stable HTTPS hostname/runbook
  - public `/health` verification
  - PM2 named tunnel restart
  - incomplete active row dry-run/archive flow
  - project-bot rehook command after stable health passes
  - lifecycle audit freshness if it ever goes stale

**What was tested**
- Ran `npm run build` successfully.
- Ran `npm run smoke:status`; it still exits 1 on known blockers but now prints `nextActions` with the concrete recovery sequence.
- Ran `npm run readiness:check`; current failures remain the known 9 stable-host/webhook blockers.

**Current state**
- Both readiness and smoke now provide concrete operator next steps instead of only failure labels.
- Stable HTTPS setup remains blocked on interactive Cloudflare login/create/route DNS.

**Next actions**
- Manual Cloudflare setup, then run `npm run tunnel:prepare-config`, start named tunnel, rehook project bots, archive the legacy row with approval, run E2E smoke.

## 2026-05-02 20:14 — Rehook script now refuses dead stable hosts

**What was built**
- Hardened `scripts/rehook-all.sh` so real rehook runs verify `${WEBHOOK_BASE_URL}/health` returns `status=ok` before calling Telegram `setWebhook`.
- Dry-runs still skip public health and show exactly which active project bots would be registered.
- Added an explicit `SKIP_PUBLIC_HEALTH_CHECK=1` emergency override, documented as intentional-only.
- Updated `docs/STABLE_WEBHOOK_RUNBOOK.md` with the safer dry-run → real-run sequence.

**What was tested**
- Ran `npm run build` successfully.
- Ran `DRY_RUN=1 WEBHOOK_BASE_URL=https://zolara.example.com scripts/rehook-all.sh`; it listed the 2 project bots that would be rehooked and skipped the known incomplete row.
- Ran `WEBHOOK_BASE_URL=https://zolara.example.com scripts/rehook-all.sh`; it correctly refused to rehook because public `/health` failed.
- Ran `npm run readiness:check`; current failures remain the known 9 stable-host/webhook blockers.

**Current state**
- Rehooking is safer: project bots will not be pointed at a dead stable hostname by accident.
- Stable HTTPS setup remains blocked on interactive Cloudflare login/create/route DNS.

**Next actions**
- Manual Cloudflare setup, then run the documented dry-run rehook first; only run the real rehook after public `/health` passes.

## 2026-05-02 20:44 — Rehook flow exposed as npm script and diagnostics aligned

**What was built**
- Added npm script `webhooks:rehook` for the existing safe rehook flow.
- Updated readiness and smoke remediation copy to use the safer npm-script sequence:
  - `DRY_RUN=1 WEBHOOK_BASE_URL=https://<stable-host> npm run webhooks:rehook`
  - then run without `DRY_RUN` after public `/health` passes.
- Updated the stable webhook runbook to use `npm run webhooks:rehook` instead of directly invoking the shell script.
- Readiness now also attaches the public `/health` remediation action on HTTP non-OK responses, not only fetch failures.

**What was tested**
- Ran `npm run build` successfully.
- Ran `DRY_RUN=1 WEBHOOK_BASE_URL=https://zolara.example.com npm run webhooks:rehook`; it listed both active project bots and skipped the known incomplete row without DB/env changes.
- Ran `npm run readiness:check`; current failures remain the known 9 blockers and the Next actions now reference `npm run webhooks:rehook`.
- Ran `npm run smoke:status`; it still exits 1 on known blockers and now references the same rehook command in `nextActions`.

**Current state**
- Operator handoff is now consistent across runbook, readiness, smoke, and package scripts.
- Stable HTTPS setup remains blocked on interactive Cloudflare login/create/route DNS.

**Next actions**
- Manual Cloudflare setup, then dry-run `npm run webhooks:rehook`; only run real rehook after public `/health` passes.

## 2026-05-02 21:14 — GitHub security follow-up documented

**What was built**
- Added `SECURITY.md` with an explicit secret-rotation requirement because `.env` existed in earlier Git history before the cleanup commit.
- Documented which secrets must be rotated before testers and the safe post-rotation webhook rehook sequence.
- Confirmed GitHub repo is public and GitHub secret scanning/push protection are enabled.

**What was tested**
- Ran `npm run readiness:check`; current failures remain the known 9 stable-host/webhook blockers.
- Confirmed `.env`, `node_modules/`, and `memory/` are no longer tracked after the GitHub cleanup commit.

**Current state**
- Repo is hosted on GitHub and cleaned going forward, but real secret rotation remains mandatory before testers because old Git history was already pushed.
- Stable HTTPS setup remains blocked on interactive Cloudflare login/create/route DNS.

**Next actions**
- Rotate exposed credentials before testers.
- Complete named Cloudflare tunnel setup, rehook project bots, then run full E2E smoke.

## 2026-05-02 21:44 — Added GitHub CI for hosted repo

**What was built**
- Added `.github/workflows/ci.yml` so GitHub runs `npm ci`, `npm run build`, and `npm test` on pushes/PRs to `master`.
- CI provisions Redis and Postgres services and uses dummy non-secret environment values required by config parsing.

**What was tested**
- Ran `npm run readiness:check`; current failures remain the known 9 stable-host/webhook blockers.
- Ran `npm run build` successfully.
- Ran `npm test`; 14 files / 139 tests passed.

**Current state**
- GitHub hosting now has an automated build/test gate once pushed.
- Runtime/tester blockers remain unchanged: secret rotation, named Cloudflare tunnel, rehook project bots, archive legacy row, live E2E smoke.

**Next actions**
- Push CI workflow to GitHub and confirm the workflow run.
- Complete interactive Cloudflare setup and credential rotation before testers.

## 2026-05-02 21:51 — GitHub CI confirmed passing

**What was tested**
- Watched GitHub Actions run `25259211243` for commit `6101c8c`.
- CI passed: `npm ci`, `npm run build`, and `npm test` completed successfully in GitHub with Redis/Postgres services.

**Current state**
- Hosted GitHub repo now has a passing automated CI gate.
- Runtime blockers remain unchanged: rotate secrets, named Cloudflare tunnel, project-bot rehook, legacy-row archive, live E2E smoke.

## 2026-05-02 22:14 — CI prepped for GitHub Node 24 action runtime

**What was built**
- Updated `.github/workflows/ci.yml` with `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24=true` to opt into GitHub's upcoming Node 24 action runtime early.
- This removes the CI deprecation risk observed on the passing GitHub runs and keeps hosted checks future-proof.

**What was tested**
- Ran `npm run readiness:check`; current failures remain the known 9 stable-host/webhook blockers.
- Ran `npm run build` successfully.
- Ran `npm test`; 14 files / 139 tests passed.

**Current state**
- Code and hosted CI are healthy; runtime blockers remain stable Cloudflare tunnel, secret rotation, rehooking project bots, legacy-row archive, and live E2E smoke.

## 2026-05-02 22:44 — Added Render external-hosting fallback runbook

**What was built**
- Added `docs/RENDER_DEPLOY_RUNBOOK.md` as a concrete alternative when Cloudflare account login/DNS setup is blocked.
- The runbook covers Docker web service, Postgres, Redis, required rotated env vars, `ZOLARA_HOSTING_MODE=external`, lifecycle scheduling, health verification, bot rehook, and final smoke.
- Updated `docs/BACKEND_HOSTING_OPTIONS.md` to link the Render runbook and use `npm run webhooks:rehook` consistently.

**What was tested**
- Ran `npm run readiness:check`; current failures remain the known 9 local Cloudflare/stable-webhook blockers.
- Ran `npm run build` successfully.
- Ran `npm test`; 14 files / 139 tests passed.

**Current state**
- If Cloudflare auth is unavailable, Render is now documented as the clean external HTTPS fallback.
- Code/CI are healthy; runtime readiness still needs either Cloudflare named tunnel or external deploy, plus secret rotation and bot rehook.
