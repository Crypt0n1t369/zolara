# Zolara Development PRD — Bug Fixing & Code Cleanup
**Date:** 2026-04-26
**Status:** IN PROGRESS

---

## Executive Summary

After a thorough codebase audit, I've identified **9 critical bugs**, **5 medium-priority issues**, and **4 architectural concerns** in the Zolara codebase. The primary root cause of the MiniMax M2.7 "fake completion" problem is likely a combination of: (1) onboarding data never being persisted to the DB (member profile data lost), (2) LLM responses being anonymized before theme extraction runs, and (3) silent TypeScript type cast errors causing data to be mis-routed.

---

## Phase 0: Critical Bug Fixes (Do First)

### Bug 1: `src/manager/index.ts` is Dead Code Creating a Phantom Bot
**Severity:** CRITICAL — potential 409 polling conflict
**File:** `src/manager/index.ts`

**Problem:** This file creates a second `managerBot` instance using the SAME `ZOLARA_BOT_TOKEN` as `zolaraBot` in `src/project/index.ts`. The exported functions `handleManagerWebhook` and `startManagerPolling` are NEVER imported by `src/server/index.ts` (which uses `src/project/index.ts` instead). If PM2 starts this as a separate process, Telegram will reject the second bot with a 409 Conflict.

**Discovery:** `src/server/index.ts` imports `handleZolaraWebhook`, `startZolaraPolling`, and `handleProjectBotUpdate` from `src/project/index.ts`. The `src/manager/index.ts` exports `handleManagerWebhook` and `startManagerPolling` — these are completely unused.

**Fix:** Delete `src/manager/index.ts` and all files in `src/manager/` that exist solely to support the manager bot. The `src/manager/` directory should be removed entirely since it's replaced by `src/project/`. Keep `src/manager/admin-commands.ts` and `src/manager/admin-management.ts` and `src/manager/project-selector.ts` and `src/manager/flows/` and `src/manager/managed-bots/` ONLY if they are imported by `src/project/index.ts`.

**Verification:**
```bash
grep -r "from.*manager/" src/project/index.ts
# Should show imports from ./manager/...
# If not, the whole src/manager/ directory can go
```

---

### Bug 2: `finalizeOnboarding` Never Called — All Member Profile Data Lost
**Severity:** CRITICAL — data loss, no member profiles
**File:** `src/project/flows/onboarding-steps.ts`

**Problem:** The onboarding flow (welcome → role → interests → availability → communication_style → complete) collects rich member profile data (role, interests, availability, communication style) but **never saves any of it to the database**. The function `finalizeOnboarding(state)` exists but is never called anywhere. After the `complete` step message is sent, the state is cleared from Redis and all data is gone.

**Root cause of "MiniMax completed but nothing happened":** Member profiles never exist in the DB, so `personalizeQuestion()` always gets empty profiles, questions are generic, and the round appears to "work" but without member context.

**Fix:** Call `finalizeOnboarding(state)` in `handleOnboardingCallback` when the `communication_style` step is confirmed (the final step before `complete`). Also call it in `sendComplete` for safety.

```typescript
// In sendComplete, after sending the completion message:
await finalizeOnboarding(state);
await clearOnboardingState(state.telegramId);
```

---

### Bug 3: `handleOnboardingCallback` Answers `$1` Literal String
**Severity:** HIGH — UX broken, callbacks give no feedback
**File:** `src/project/flows/onboarding-steps.ts`

**Problem:** The `handleOnboardingCallback` function has `await answerCb(ctx, '$1')` — a literal `$1` string — as the default case and in several branches. This is debug/copied-code residue.

**Fix:** Replace all `$1` answers with appropriate user-facing messages:
- Default: `await answerCb(ctx, 'Processing...')`
- Skip actions where appropriate

---

### Bug 4: Text Input During Onboarding Never Handled
**Severity:** HIGH — onboarding flow broken for text steps
**File:** `src/project/index.ts` (message:text handler)

**Problem:** When a user is in the onboarding flow (role or interests steps), they type text. But the `message:text` handler in `src/project/index.ts` only checks for `loadInitState` — it never checks for `loadOnboardingState`. So onboarding text falls through to AI help, not to the onboarding text handler.

**Fix:** Add `loadOnboardingState` check in the `message:text` handler, and call `handleOnboardingText` when active.

---

### Bug 5: `saveResponse` Uses Telegram `userId` as Database `memberId`
**Severity:** CRITICAL — response data mis-routed, synthesis gets no data
**File:** `src/project/index.ts`

**Problem:** In the question answering section of `message:text`:
```typescript
await db.insert(responses).values({
  questionId: questionId as any,
  memberId: userId as any, // WRONG: userId is Telegram ID, memberId is DB serial
  responseText: text.slice(0, 5000),
  ...
});
```
`members.id` is a serial integer auto-increment PK, not a Telegram user ID. This insert either fails (if types are strictly enforced) or creates a mis-routed response.

**Fix:** Look up the actual `memberId` from the DB:
```typescript
const [memberRow] = await db.select({ memberId: members.id })
  .from(members)
  .innerJoin(users, eq(members.userId, users.id))
  .where(eq(users.telegramId, userId))
  .limit(1);
if (!memberRow) { ... error ... }
await db.insert(responses).values({ memberId: memberRow.memberId, ... });
```

---

### Bug 6: `collectResponses` anonymizes text BEFORE LLM theme extraction
**Severity:** CRITICAL — synthesis produces garbage themes
**File:** `src/engine/synthesis/pipeline.ts`

**Problem:**
```typescript
return rows.map((r) => ({
  text: anonymity === 'full' ? `[Response]` : r.responseText ?? '',
  questionType: r.questionType ?? 'open',
}));
```
When `anonymity === 'full'`, the LLM that runs `extractThemes()` receives ONLY the string `[Response]` repeated N times. It cannot extract themes from this. This is the primary synthesis quality issue.

**Fix:** Always pass the actual response text to the LLM for analysis. Anonymization should only affect the final report presentation:
```typescript
return rows.map((r) => ({
  text: r.responseText ?? '',
  questionType: r.questionType ?? 'open',
  // anonymity flag is used later when formatting the report
}));
```

---

### Bug 7: `finalizeOnboarding` DB query missing `userId` filter
**Severity:** HIGH — wrong member record updated
**File:** `src/project/flows/onboarding-steps.ts`

**Problem in `finalizeOnboarding`:**
```typescript
const [member] = await db
  .select()
  .from(members)
  .where(eq(members.projectId, projectId as any))
  .limit(1); // WRONG: finds ANY member in project, not this specific user
```
If there are multiple members in a project, this updates the FIRST one, not the correct member.

**Fix:** Query by both `projectId` AND `userId`:
```typescript
const [member] = await db
  .select()
  .from(members)
  .where(and(
    eq(members.projectId, projectId as any),
    eq(members.userId, userId)
  ))
  .limit(1);
```

---

### Bug 8: Onboarding `welcome` step double-advances state then calls wrong next step
**Severity:** MEDIUM — onboarding flow skips role step or shows wrong UI
**File:** `src/project/flows/onboarding-steps.ts`

**Problem in `sendWelcome`:**
```typescript
state.step = nextOnboardingStep(state.step); // advances from 'welcome' to 'role'
await saveOnboardingState(state);
await sendRole(ctx, state); // This sends 'role' UI but state is already saved as 'role'
```
But then in `handleOnboardingStep`, when `state.step === 'role'`, it calls `sendRole` AGAIN. The state was saved correctly, but `sendRole` is called twice (once from `sendWelcome`, once from the dispatcher).

Actually looking more carefully: `sendWelcome` saves state as 'role' then calls `sendRole`. Then the handler returns, and the caller (`handleOnboardingCallback`) calls `handleOnboardingStep` again because the callback handler calls `handleOnboardingStep` for availability/style. But for role/interests (text steps), the handler returns `newState` and the caller needs to call `handleOnboardingStep`.

The actual issue: when `sendWelcome` advances state and calls `sendRole`, it should NOT advance the state itself — the `handleOnboardingText` should advance after text is received, not during welcome. But `sendWelcome` IS supposed to auto-advance to role.

Actually, the double-call issue: `sendWelcome` calls `sendRole`. Then `handleOnboardingStep` is called with state.step = 'role', which also calls `sendRole`. This means the role prompt is sent TWICE to the user.

**Fix:** In `sendWelcome`, don't call `sendRole` directly — just save state and return. Let the caller's dispatcher handle calling `handleOnboardingStep`. Or, in `sendWelcome`, advance the state AND return (don't call next step renderer directly).

---

### Bug 9: `my_chat_member` handler conflict between manager and project bots
**Severity:** MEDIUM — potential duplicate processing
**File:** `src/project/index.ts`

**Problem:** `src/project/index.ts` registers a `my_chat_member` handler. `src/manager/index.ts` ALSO registers a `my_chat_member` handler (for the same bot token). Both handlers fire on the same update. The manager's handler at the bottom of the file has some imports that seem to be from `../project` — suggesting the manager file was getting contaminated with project code.

After fixing Bug 1 (removing dead manager/index.ts), this should be resolved since only one bot instance will exist.

---

## Phase 1: Code Quality Fixes

### Issue A: `$1` callback answers throughout codebase
**Search:** `answerCb(ctx, '\$1')` or `await answerCb(ctx, '$1')`
**Files:** Likely in `src/project/index.ts`, `src/project/flows/onboarding-steps.ts`

### Issue B: `as any` casts for `projectId` and `userId` in DB operations
**Severity:** MEDIUM — type safety bypassed
The schema uses `uuid` for projectId and `serial` for ids. The `as any` casts hide real type errors.

### Issue C: Duplicate `escapeMarkdownV2` import in `initiation-steps.ts`
**File:** `src/manager/flows/initiation-steps.ts`
The `initiation-steps.ts` imports `escapeMarkdownV2` from `../../util/telegram-sender` but then the file has the `MiniMaxProvider` class appended at the bottom (from `src/engine/llm/minimax.ts`).

Wait, actually looking at the file content I read earlier, the `initiation-steps.ts` file has:
1. All the step functions
2. Then at the bottom: `import type { LLMProvider, LLMResponse } from './provider';` and the `MiniMaxProvider` class

This means the `MiniMaxProvider` from `minimax.ts` was COPY-PASTED into `initiation-steps.ts` as well! This is a duplication.

**Fix:** Remove the duplicate `MiniMaxProvider` from `initiation-steps.ts`. It should only import from `./provider` and `../llm/minimax`.

### Issue D: `src/server/index.ts` has duplicate `import` at bottom of file
The server file has self-healing agent setup, then the app, then a `{ ... }` block at the very bottom that imports and starts `startZolaraPolling`. This is a valid pattern (dynamic import at bottom), but the code structure is convoluted.

---

## Phase 2: Data Integrity Fixes

### Fix: Question routing key mismatch
**File:** `src/util/telegram-sender.ts` and `src/project/index.ts`

In `sendQuestionDM`:
```typescript
await redis.setex(`proj:${projectId}:q:${userId}`, 86400, JSON.stringify({...}));
```
In `message:text` handler:
```typescript
const qState = await redis.get(`q:${userId}`); // WRONG — missing `proj:${projectId}:` prefix!
```
The keys don't match! This means responses to questions are NEVER found.

**Fix:** Either remove the `proj:${projectId}:` prefix from the key (simpler), or store projectId in the key and look it up correctly.

---

## Implementation Order

1. **Checkpoint** ✅ (git commit done)
2. **Bug 5** — Fix `saveResponse` memberId lookup (CRITICAL)
3. **Bug 1** — Remove dead `src/manager/index.ts` (CRITICAL)
4. **Bug 6** — Fix anonymization before LLM (CRITICAL)
5. **Bug 2** — Wire `finalizeOnboarding` call (CRITICAL)
6. **Bug 4** — Add onboarding text handling in message:text (HIGH)
7. **Bug 3** — Fix `$1` callback answers (HIGH)
8. **Bug 7** — Fix finalizeOnboarding DB query (HIGH)
9. **Bug 8** — Fix double-sendRole in welcome (MEDIUM)
10. **Phase 1** — Clean up duplicate code, `as any` casts
11. **Phase 2** — Fix Redis key mismatch
12. **Run full test suite** and verify

---

## Test Plan

After each fix:
```bash
cd ~/projects/zolara && npx vitest run
# Must maintain 100/100 tests passing
npx tsc --noEmit
# Must exit 0
```

For the onboarding fix, manual test:
1. Admin: `/create` → complete initiation flow
2. Member: click invite link → claim → onboarding
3. Complete all 5 onboarding steps
4. Verify DB: `SELECT * FROM members WHERE project_id = '...'` → role, project_profile populated
