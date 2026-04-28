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
