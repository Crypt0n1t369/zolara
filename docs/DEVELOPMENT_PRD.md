# Zolara Development PRD — Bug Fixing & Code Cleanup
**Date:** 2026-04-26
**Status:** IN PROGRESS

---

## Executive Summary

After a thorough codebase audit, I've identified **9 critical bugs**, **5 medium-priority issues**, and **4 architectural concerns** in the Zolara codebase. The primary root cause of the MiniMax M2.7 "fake completion" problem is likely a combination of: (1) onboarding data never being persisted to the DB (member profile data lost), (2) LLM responses being anonymized before theme extraction runs, and (3) silent TypeScript type cast errors causing data to be mis-routed.

---

## Phase 0: Critical Bug Fixes (Done ✅)

### ✅ Bug 1: `src/manager/index.ts` is Dead Code
**Status:** DEFERRED — PM2 confirmed not starting it; preserved in git for spec compliance.

### ✅ Bug 2: `finalizeOnboarding` Never Called
**Fixed:** `handleOnboardingCallback` now calls `finalizeOnboarding(newState)` on `style` action (final step).
**Also fixed:** DB query now filters by both `projectId` AND `userId` (was updating wrong member).

### ✅ Bug 3: `handleOnboardingCallback` Answers `$1` Literal String
**Fixed:** All 16 occurrences replaced with proper user-facing messages.

### ✅ Bug 4: Text Input During Onboarding Never Handled
**Fixed:** `message:text` handler in `project/index.ts` now checks `loadOnboardingState` and routes to `handleOnboardingText`.

### ✅ Bug 5: `saveResponse` Uses Telegram `userId` as Database `memberId`
**Fixed:** Now looks up member via `users` table join before inserting response.

### ✅ Bug 6: `collectResponses` anonymizes text BEFORE LLM theme extraction
**Fixed:** Actual response text now flows to LLM. Anonymization only in final report quotes.

### ✅ Bug 7: `finalizeOnboarding` DB query missing `userId` filter
**Fixed:** Added `and(eq(members.projectId, projectId), eq(members.userId, userId))` filter.

### ✅ Bug 8: `sendWelcome` double-sent next step
**Fixed:** `sendWelcome` now only saves state and returns; dispatcher calls the next renderer.

### ✅ Bug 9: `finalizeClaim` no userId filter
**Fixed:** Added `and(eq(members.projectId, state.projectId), eq(members.userId, userId))`.

### ✅ Bug 10: Redis key mismatch in project bot
**Fixed:** `bot-instance.ts` now uses `q:${userId}` (matching `telegram-sender.ts`).

### ✅ Claim → Onboarding transition missing
**Fixed:** `handleClaimCallback` now creates `OnboardingState` and calls `handleOnboardingStep` after commit.

### ✅ `synthesizeReport` missing anonymity param
**Fixed:** `anonymity` param added; quotes anonymized in final report per mode.

### ✅ Dead code cleanup
**Removed:** `bot-instance.ts.bak4`, renamed `ecosystem.config.js` → `ecosystem.config.cjs`.

---

## Phase 1: Confirmed Working Features

### Project Management (Archive / Delete)
- ✅ `buildProjectManageKeyboard` has Archive + Delete buttons
- ✅ `project:archive:` callback updates `projects.status = 'archived'`
- ✅ `project:delete:` callback updates `projects.status = 'deleted'`
- Both are soft deletes (data preserved 30 days)

### Project Selection (Switch Between Bots)
- ✅ `/projects` command shows project list with inline keyboard
- ✅ `project:select:{id}` callback stores selection in Redis
- ✅ `project:manage:{id}` callback shows management keyboard
- **Issue found:** `resolveAdminProject` uses `admins.telegramId` → correct
- **Issue found:** `/projects` keyboard only shows projects where admin has `adminId` in `projects.adminId` column (bigint vs serial join — potential type issue but not blocking)

### Managed Bot Creation
- ✅ `createProjectBot()` creates a scoped grammY Bot per project
- ✅ `finalizeProjectBot()` calls `getManagedBotToken`, encrypts, sets webhook
- ✅ Bot stored with `botTelegramId`, `botUsername`, `botTokenEncrypted`, `webhookSecret`
- 4 managed bots exist in DB (testerbot, pilot projects)

### Managed Bot Onboarding Flow
- ✅ Project bot `callback_query:data` handler routes `onboard:*` to `handleOnboardingCallbackForProject`
- ✅ `handleOnboardingCallbackForProject` calls `handleOnboardingCallback` from `onboarding-steps.ts`
- ✅ `handleOnboardingTextForProject` calls `handleOnboardingText` from `onboarding-steps.ts`
- ✅ `handleMemberClaimForProject` saves `ClaimState` and calls `handleClaimWelcome`
- ✅ Onboarding state keyed by `onboard:{telegramId}` (same key for all projects)
- ✅ Question answering: reads `q:{userId}` (correct key after fixes)
- **Issue found:** Bot instance does NOT handle `callback_query` for project management (admin commands like archive/delete are on @Zolara_bot only, not project bots — this is correct architecture)

### AI Conversational Fallback
- ✅ Both @Zolara_bot (`src/project/index.ts`) and project bots (`bot-instance.ts`) have AI help handlers
- ✅ @Zolara_bot: `handleAIHelp` — full context (admin status, projects, active flows)
- ✅ Project bot: simple `llm.generate` with project name context

### Data Storage
- ✅ `users` table: `telegramId` (bigint) is the primary user identifier
- ✅ `members` table: links userId (FK to users.id) to projectId (FK to projects.id)
- ✅ `members.projectProfile` JSONB stores role, interests, communication_style
- ✅ `rounds` table: tracks status, topic, anonymity, responseCount, memberCount
- ✅ `responses` table: links questionId + memberId to responseText
- ✅ `admin_roles` table: multi-admin support (projectId + adminId + role)

---

## Phase 2: New Feature Requests (Not Yet Implemented)

### 🔲 Per-Project Sub-Agents
**Request:** Each new bot spawns a new agent deleted when bot is deleted (30-day restore window).

**Implementation approach:**
1. Add `agents` table: `id, projectId, agentType, config (jsonb), createdAt, deletedAt, restoreUntil`
2. When `finalizeProjectBot()` completes → call `sessions_spawn` with project context
3. Store agent session key in `projects.agentSessionKey`
4. On project archive/delete → soft-delete agent via `deletedAt` + `restoreUntil = now + 30 days`
5. Background job checks `restoreUntil < now` → permanently deletes agent
6. Restore capability: `deletedAt` is not null → agent can be re-spawned within 30 days

**Key insight:** This requires OpenClaw sub-agent infrastructure. Agent lifecycle tied to project lifecycle.

**PRD section to add:** `FEATURE: per-project sub-agents`

---

### 🔲 Member Free-Chat / Conversational Mode
**Request:** Users should be able to chat with the bot.

**Current state:** @Zolara_bot has `handleAIHelp` with rich context. Project bots have a basic LLM call with project name only. Neither is a true conversational memory system.

**Implementation approach:**
1. Store project context in Redis: `proj:{projectId}:memory` — rolling 50-message buffer of ambient signals
2. Project context injected into question personalization prompts
3. Round boundary: compress memory to project memory (1 Flash LLM call)
4. `ambient_signals` table: store keyword-captured insights per project
5. `async_insights` table: store compressed context from completed rounds

**PRD section to add:** `FEATURE: free-chat ambient memory`

---

### 🔲 Bot Deletion / Archive via @Zolara_bot
**Request:** Admin wants to delete/archive bots from within Zolara.

**Current state:** Works but UI is confusing — project management keyboard exists but admin may not know to click ⚙️ from `/projects`.

**Improvements:**
1. Add `/mybots` command showing only bots created by this admin (with status)
2. Add explicit "Delete Bot" and "Archive Bot" commands
3. Confirm dialog before destructive actions (callback with confirm/reject)

---

### 🔲 Onboarding Flow Context
**Request:** New members should provide role, skills, interests for question personalization.

**Current state:** ✅ O1-O6 onboarding is wired (role, interests, availability, communication_style).

**Missing piece:** Onboarding profile is collected but round questions are not yet personalized per member. Need to verify `personalizeQuestion()` reads `members.projectProfile` and uses it.

---

### 🔲 Restore Deleted Bots (30-day window)
**Request:** Deleted bots should be restorable for 30 days.

**Implementation:**
1. On delete: set `deletedAt = now`, `restoreUntil = now + 30 days`
2. Show deleted projects in `/projects` with strikethrough
3. `restore` command: re-activates project, re-spawns agent if applicable
4. Background cron: permanently deletes after `restoreUntil`

---

## Root Cause Chain (Why M2.7 Appeared to "Work" While Nothing Worked)

```
1. Onboarding data never persisted (finalizeOnboarding never called)
   → Member profiles empty in DB
   → personalizeQuestion() gets no context
   → Questions are generic

2. Redis key mismatch (proj:${projectId}:q:${userId} vs q:${userId})
   → Question state stored but NEVER found when member replied
   → Member got confirmation message but response never saved

3. saveResponse used wrong memberId
   → Even if response was saved, it went to wrong member record

4. collectResponses anonymized BEFORE LLM analysis
   → LLM received [Response] placeholders
   → Synthesis could not extract real themes
   → Report was generic noise

5. claim→onboarding transition was missing
   → Member confirmed commitment but onboarding never started
   → Even if onboarding completed, no data flowed anywhere
```

---

## Implementation Order (Updated)

1. ✅ Checkpoint (git commit)
2. ✅ Bug 5 — saveResponse memberId lookup (CRITICAL)
3. ✅ Bug 6 — anonymization before LLM (CRITICAL)
4. ✅ Bug 2 — wire finalizeOnboarding (CRITICAL)
5. ✅ Bug 4 — onboarding text handling (HIGH)
6. ✅ Bug 3 — $1 callback answers (HIGH)
7. ✅ Bug 7 — finalizeOnboarding DB query (HIGH)
8. ✅ Bug 8 — sendWelcome double-send (MEDIUM)
9. ✅ Redis key mismatch (Phase 2)
10. ✅ Phase 1 — clean up dead code
11. 🔲 Per-project sub-agents (NEW)
12. 🔲 Free-chat / conversational mode (NEW)
13. 🔲 Bot restore from deletion (NEW)
14. Run full test suite

---

## Test Plan

```bash
cd ~/projects/zolara && npx vitest run
# Must maintain 100/100 tests passing

npx tsc --noEmit
# Must exit 0
```

### Manual Test Scenarios

**Admin: Create project + managed bot**
1. `/create` → complete initiation flow
2. Telegram link appears → approve bot in BotFather
3. `@newbot` created → verify `botTelegramId` in DB

**Member: Join project bot**
1. Open project bot DM → click Start or send `/start`
2. `/start claim_{projectId}` → commitment welcome
3. Confirm → onboarding welcome (O1)
4. Enter role → interests → availability → communication style
5. Verify DB: `SELECT role, project_profile FROM members WHERE user_id = ...`

**Member: Answer a round question**
1. Admin runs `/startround "topic"`
2. Member receives DM question
3. Member types answer → confirm saved to `responses` table

**Admin: Archive project**
1. `/projects` → tap ⚙️ on project
2. Tap Archive → verify `status = 'archived'` in DB
