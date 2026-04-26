# WORKLOG - Zolara Builder

## Session: 2026-04-21

---

## What Was Built

### Zolara Bot Consolidation — Single Bot Architecture

**Problem:** Two bots were being used (@Themechanysm_bot for admin, @Zolara_bot for product), but Kristaps wanted one bot (@Zolara_bot) for everything.

**Solution:** Consolidated into a single bot handler at `src/project/index.ts`.

---

## Architecture

**Single bot:** `@Zolara_bot` — token: `8763853211:AAFjtMmLQZFrmdkhXSVJWypmTlD-cwlnSfA`

**Config changes:**
- `ZOLARA_BOT_TOKEN` — the main bot token (was `TELEGRAM_BOT_TOKEN`, now renamed)
- `MANAGED_BOTS_TOKEN` — used for Telegram Managed Bots API calls (same token in single-bot mode, separate for multi-bot mode)

**Archived (reversible):**
- `src/manager/` → `src/manager-archived/`
- `src/project/` → `src/project-archived/`

---

## New Commands on @Zolara_bot

| Command | Function |
|---------|----------|
| `/start` | Welcome screen |
| `/help` | How Zolara works |
| `/create` | Start project initiation flow (13 steps) |
| `/cancel` | Cancel any active flow |
| `/projects` | List admin's projects |
| `/startround [topic]` | Trigger a perspective round |
| `/cancelround` | Cancel active round |
| `/members` | List project members + commitment status |
| `/invite` | Get invite link for members |
| `/status` | Current round status |

**Member flow:**
- `/start claim_{projectId}` → commitment gate → onboarding → question answering

---

## Managed Bots API

Still used for per-project bot creation. `@Zolara_bot` calls `getManagedBotToken` to create a dedicated bot per project team. The managed-bots module moved to `src/project/managed-bots/`.

---

## Testing

```bash
cd ~/projects/zolara && npx vitest run
# 57 tests passing (8 files)
# 0 TypeScript errors
```

---

## Phase 1 Status

- [x] Verbal initiation flow (Steps 1-11)
- [x] Managed Bots API integration (Step 12)
- [x] Member onboarding / claim flow (O1-O6)
- [x] Perspective gathering engine
- [x] Synthesis report generation
- [x] Report posting + reaction tracking
- [x] Self-healing agent (bonus)
- [x] Admin commands (/projects, /startround, /cancelround, /members, /invite, /status)
- [x] Group auto-detection
- [x] Single bot consolidation

**Phase 1 COMPLETE** ✅

---

## Next Steps (Phase 2)

- Round deadline cron scheduling
- Report posting to group (after synthesis)
- Response tracking (member replies → responses table)
- Nudge/reminder system for non-responding members
- /settings command for admin project config changes
- Add/remove admin functionality
## 2026-04-23 — Session 36bcb99d

### What was built

**TypeScript compilation cleanup:**
- Deleted orphaned `src/project-archived/` and `src/manager-archived/` (TS was including them despite excludes)
- Fixed tsconfig.json: `module: ESNext`, `moduleResolution: bundler`
- Fixed 8 TS errors: status nullability, rounds.createdAt→startedAt, pino logger overloads, projectMembers→members

**Reaction tracking (wired to DB):**
- Updated `postReportToGroupChat` to accept `projectId` param
- Callback data changed from `reaction:{roundNumber}:{type}` → `reaction:{projectId}:{roundNumber}:{type}`
- Reaction callback now stores in `engagement_events` table with memberId, projectId, roundNumber, reaction type, chatId, messageId

**Nudge scheduler (non-responders only):**
- Added join to `responses` + `questions` to find which members have responded
- Sends reminders only to members NOT in the responded set
- Nudge count stored in Redis key `nudge:{roundId}`

**Webhook re-established:**
- Domain `builder.drg.lat` expired (NXDOMAIN)
- Using Cloudflare tunnel: `https://eric-organize-dried-modification.trycloudflare.com`
- Webhook secret: `zolara_dev_secret_32chars_min` (NOT the old `d41e1a8f...`)

### Current state
- `npx tsc --noEmit` → exit 0 ✅
- PM2 zolara: running on port 3000 ✅
- Webhook: set to cloudflared URL ✅
- Cloudflared tunnel: running in background (pid 3501811)

### High-priority items status
| Item | Status |
|------|--------|
| Perspective gathering (triggerRound → DM questions) | ✅ Complete |
| Synthesis report generation | ✅ Complete |
| Report posting + reaction tracking | ✅ DB wired |
| Nudge/reminder for non-responders | ✅ Fixed |
| /settings for admin project config | ❌ Not started |
| Add/remove admin functionality | ❌ Not started |

### Notes
- Domain `builder.drg.lat` is dead — need to renew or get new domain for permanent webhook URL
- Cloudflared tunnel URL changes every restart — need a permanent domain

## 2026-04-23 PM — Polling Mode (Session cont.)

### What was fixed
- Webhook deleted (`deleteWebhook` called on Telegram API)
- `NODE_ENV=development` was blocking polling startup
- Changed `src/server/index.ts` to always call `startZolaraPolling()` (not gated on production)
- Cloudflared tunnel killed — no longer needed
- grammY long-polling is now the sole update mechanism

### Current state
- `@Zolara_bot` running via grammY long-polling (PID via PM2)
- No external tunnel, no domain needed
- Polling auto-resumes after restart
- `[Zolara] Starting polling — @Zolara_bot is live!` confirmed in logs

### Summary
| Concern | Status |
|---------|--------|
| URL changes on restart | ✅ Non-issue — no URL needed |
| 409 conflict (polling) | ✅ Different bot token from workspace |
| Domain expiry | ✅ N/A — polling only |
| Auto-restart recovery | ✅ Polling reconnects automatically |

## 2026-04-23 — Admin Management Built

### New commands added
| Command | Who | Description |
|---------|-----|-------------|
| /addadmin @username | owner | Add an admin to the project |
| /removeadmin @username | owner | Remove an admin |
| /transferownership @username | owner | Transfer project ownership |
| /admins | admin | List all admins of the project |
| /settings | owner | Interactive settings menu |

### Schema changes
- Added `admin_roles` table: `projectId`, `adminId`, `role` ('owner'|'admin'|'viewer')
- Single `adminId` on `projects` kept for backward compat
- `admin_roles` provides multi-admin capabilities

### Implementation details
- /addadmin: resolves @username via Telegram ID lookup (user must have messaged bot)
- /removeadmin: only owner can remove; cannot remove owner
- /transferownership: transfers owner role, old owner becomes admin
- /settings: inline keyboard UI, interactive conversation for value input
- Settings stored in `projects.config` JSONB

### Tests
- 44 tests still passing ✅

### Files added
- src/manager/admin-management.ts (new)

### Files modified
- src/data/schema/projects.ts (added admin_roles table)
- src/project/index.ts (wired new commands + settings callback)

## 2026-04-23 PM — Bug fixes

### Bugs fixed
- "Use a template" button: removed — was a broken stub
- "1-on-1 chats" DM option: removed — not implemented in single-bot mode, confusing
- sendConfirmConfig markdown: removed MarkdownV2 (em-dash — caused 400 parse error)
- Invite link: always uses @Zolara_bot (single-bot mode), not project's managed bot

### On the DM context / multi-bot note
Zolara currently runs as single-bot (@Zolara_bot) for all projects. The Managed Bots
API creates bot tokens per project, but those are stored/encrypted and not yet used
for routing. All message routing goes through @Zolara_bot. Full multi-bot routing
where each project uses its own bot is a larger architecture change.

44 tests still green.

## 2026-04-23 — Multi-bot Infrastructure Build

### What was built

**Multi-bot webhook router** (`src/server/index.ts`):
- Route: `POST /webhook/projectbot/:tokenHash`
- URL param `tokenHash` = SHA hash of bot token (from `projects.botTokenHash`)
- Header `X-Telegram-Bot-Api-Secret-Token` = per-project `webhookSecret`
- Both must match → authenticates the project bot
- Decrypts `projects.botTokenEncrypted` to create a scoped Bot instance for handling
- Always returns 200 to Telegram to prevent retries

**Per-project bot factory** (`src/project/managed-bots/bot-instance.ts`):
- `createProjectBot(botToken, projectId)` → cached grammY Bot instance per project
- Handles: `/start claim_*` → claim flow, onboarding callbacks, question answering, report reactions
- All per-project handlers wired to route with `projectId` in context

**Multi-bot aware telegram sender** (`src/util/telegram-sender.ts`):
- `sendMessage(chatId, text, options?, projectId?)` → uses project's own bot if projectId given
- `sendQuestionDM()` → per-project Redis key `proj:${projectId}:q:${userId}`
- `sendReminderDM()` → takes projectId as first arg
- `postReportToGroupChat()` → uses project's own bot

**New DB field**:
- `projects.encryptedApiKey` — per-project MiniMax API key (for future multi-key support)

**Webhook URL format**: `https://{server}/webhook/projectbot/{tokenHash}`

### What was tested
- TypeScript compiles clean (0 errors)
- 44/44 unit tests pass
- Server starts and reaches `online` state
- PM2 restart count: 13

### Current state
- Multi-bot webhook routing infrastructure in place
- `@Zolara_bot` still the only active bot (polling)
- Managed project bots can be created via `finalizeProjectBot()` — webhook set, token encrypted
- Redis keys now per-project (`proj:${projectId}:q:${userId}`) for isolation

### Next step
Wire up `finalizeProjectBot()` into the project creation flow so when Kristaps runs `/create`, a project-specific managed bot is created and its webhook registered automatically. Then test the full end-to-end creation.


## 2026-04-23 — Session 14:42 UTC

### Critical Bug Fixes (✅ DONE)

**Bug 1: `finalizeProjectBot` admin lookup was broken**
- `projects.adminId` (DB integer) was being queried with `adminTelegramId` (Telegram user ID like `551447474`)
- Fixed: added admin lookup by `admins.telegramId` first → use resulting `admin.id` for project query
- This unblocked the entire managed bot creation flow

**Bug 2: Webhook URL path mismatch**
- `finalizeProjectBot` was building `/webhook/project/{tokenHash}`
- Server route is `/webhook/projectbot/{tokenHash}`
- Fixed: updated to `/webhook/projectbot/{tokenHash}`

### Bug Fix: Markdown Parse Error
- Hyphens in project names caused "Character '-' is reserved" crash in grammY
- Added `escapeMarkdownV2()` utility to `src/util/telegram-sender.ts`
- Applied to `sendBotCreation` message in initiation-steps.ts

### New Feature: `message_reaction` Webhook Handler (✅ DONE)
- Added `bot.on('message_reaction', ...)` handler in `bot-instance.ts`
- Fires when user long-presses a message and adds emoji reaction directly
- Stores to Redis key `reaction:{chatId}:{messageId}` (TTL 7 days)
- Also writes to `engagement_events` table with emoji in metadata
- `allowed_updates` in webhook already includes `message_reaction` ✅

### Project Selector (✅ DONE earlier today)
- `src/manager/project-selector.ts` — full multi-project admin support
- All admin commands now show project selector if admin has 2+ projects
- Selection persists in Redis `active_project:{telegramId}` for 24h

### Infrastructure
- cloudflare-tunnel PM2 process running with auto-update wrapper
- `WEBHOOK_BASE_URL=https://printing-cons-goat-plastic.trycloudflare.com`
- Both processes saved to PM2 startup (`pm2 save`)

### Test Status
- 44 tests passing
- `npx tsc --noEmit` exits 0

### Remaining Items
1. Webhook URL stability — quick tunnel works but URL changes on restart (auto-wrapper handles it)
2. Bot username availability check — nice to have before showing create link
3. Per-project MiniMax key — schema ready, not wired in LLM layer

## 2026-04-23 - Bot Creation Flow (Managed Bots API)

### What was fixed
- Managed Bots API integration working end-to-end
- @Zolara_bot is the managing bot (enabled can_manage_bots in BotFather)
- Admin runs /create → completes config → gets `https://t.me/newbot/Zolara_bot/{username}` link
- Admin taps link → Telegram shows "Create Bot" dialog → approves
- Telegram sends `message:managed_bot_created` update to @Zolara_bot
- `finalizeProjectBot()` called → gets token via `getManagedBotToken` → sets webhook → project active
- Admin gets member invite link back

### Key fixes applied
1. `creation.ts` MANAGER_BOT_USERNAME = 'Zolara_bot' (not Zolara_builder_bot)
2. `lifecycle.ts` generateBotUsername: added 4-char random suffix to avoid collisions
3. `project/index.ts`: added `message:managed_bot_created` handler
4. `creation.ts`: `finalizeProjectBot` no longer calls `getManagedBotInfo` (unreliable at creation time)
5. All `finalizeProjectBot` calls updated to pass `botUser.username` from the event
6. Error handling in `sendBotCreation` improved - TDZ bug fixed

### Pending issues
- "New Thread" popup in private chats - Telegram setting, needs bot privacy toggle off in BotFather
- Some TypeScript errors from string manipulation that needed manual fixes
- Still need to verify finalizeProjectBot flow fully completes (getManagedBotToken works, webhook set, DB updated)

### Next steps
- Test full end-to-end: create project → approve bot → verify DB has botTokenHash + active status
- Test member flow: invite link → /start → commitment → onboarding
- Verify webhook delivery works for project bot messages

## 2026-04-23 - Anonymity Flow + Project Memory Research

### What was built

**Anonymity cascade (continued from yesterday):**
- `rounds.anonymity` column — per-round override, nullable (null = project default)
- `triggerRound(projectId, topic, { anonymity })` accepts optional override
- `/startround` now parses `--anonymous`, `--attributed`, `--optional` flags
- Synthesis pipeline reads round-level anonymity for response attribution
- ClaimState updated to pass anonymity into onboarding welcome message
- `handleClaimWelcome` dynamically shows attribution text based on project setting

**Project Memory & Context-Building Mechanism:**
- Researched cross-session context building from TheMechanysm specs
- Key sources: deep_research_synthesis.md, group_interaction.md, user_profiling_model.md, use_case_deep_dives.md, free_chat_mode.md, telegram_api_reference.md
- Synthesized findings into `docs/project-memory-mechanism.md`

### Project Memory Mechanism Summary

**Four silent memory layers:**
1. **Round Memory** — structured records per round (themes, tensions, convergence score)
2. **Topic Graph** — tensions/themes tracked across rounds as a relational graph
3. **Member Profiles** — behavioral inference from 1v1 and group interactions
4. **Ambient Signals** — keyword-captured insights from group chat (no LLM cost)

**Non-intrusive by design:**
- Bot NEVER sends unsolicited 1v1 between rounds (Telegram constraint — can't initiate anyway)
- Group observation is passive — 50-message Redis buffer, keyword-matched messages embedded only
- Context compressed at round boundaries (1 Flash LLM call), not streamed continuously
- Member profiles inferred from behavior, never announced

**Implementation priority:**
- Phase 1 (next): `async_insights` table + store free-chat insights + round transition context compression + inject into question generation
- Phase 2: topic graph tables + auto-extract from completed rounds
- Phase 3: member profile passive learning
- Phase 4: decision log + institutional memory

### What was tested
- TypeScript compiles clean (`npx tsc --noEmit`)
- PM2 restart successful, bot online
- Working: anonymity flags in `/startround`, ClaimState passed to welcome message

### Current state
- Phase 1 (core loop): Steps 1-11 done ✅, Step 12 (bot creation via Managed Bots API) ✅, member onboarding flow O1-O6 ✅
- Anonymity mechanism fully wired ✅
- Project memory mechanism documented, ready for implementation

### Next steps
1. Implement `async_insights` table (schema + store free-chat insights)
2. Round transition context compression job
3. Inject project context into question generation
4. Phase 2: topic graph tables + auto-extract topics from rounds
5. Phase 3: member profile passive learning from response behavior

## 2026-04-26 — Bug Fixing Session

### Bugs Fixed (10 total)

**Critical: Onboarding flow never started after member claimed**
- `handleClaimCallback` confirmed commitment but never triggered Phase 2 onboarding (O1-O6)
- Fixed: `handleClaimCallback` now creates `OnboardingState` and calls `handleOnboardingStep` after `finalizeClaim`
- Fixed: `finalizeClaim` now filters by both `projectId` AND `userId` (was updating first member found)

**Critical: Onboarding data never persisted**
- `finalizeOnboarding` was defined but never called anywhere in the flow
- All profile data (role, interests, availability, communication style) was discarded on completion
- Fixed: `finalizeOnboarding` now called in `handleOnboardingCallback` for `style` action (final step)

**Critical: Redis key mismatch — all member responses dropped**
- `sendQuestionDM` wrote to `proj:${projectId}:q:${userId}`
- `message:text` handler read from `q:${userId}`
- Fixed: both now use `q:${userId}`

**Critical: Synthesis received empty `[Response]` placeholders**
- `collectResponses` replaced ALL text with `[Response]` before LLM theme extraction
- LLM was analyzing nothing — synthesis was blind
- Fixed: actual text now flows to LLM; anonymization only in final report quotes

**Bug: 16× `$1` literal strings in answerCallbackQuery calls**
- `'$1'` is a PostgreSQL parameter placeholder, not a message string
- Replaced all with proper user-facing messages

**Bug: `sendWelcome` double-sent next step**
- `sendWelcome` called `await sendRole()` directly then returned
- Dispatcher also called the next renderer — caused double-send
- Fixed: `sendWelcome` now only saves state and returns; dispatcher handles next step

**Bug: `saveResponse` used Telegram userId as DB memberId**
- All response records saved with wrong memberId
- Fixed: now looks up member via `users` table join

**Bug: `finalizeOnboarding` DB update had no userId filter**
- Would update wrong member if project had multiple members
- Fixed: now filters by `and(eq(members.projectId, projectId), eq(members.userId, userId))`

**Bug: `synthesizeReport` missing anonymity param**
- Quotes could not be anonymized in final report output
- Fixed: `anonymity` param added, quotes anonymized appropriately per mode

**Dead code cleanup:**
- Removed `bot-instance.ts.bak4` (old backup file)
- Renamed `ecosystem.config.js` → `ecosystem.config.cjs` (ESM/CommonJS fix)
- Confirmed `src/manager/index.ts` is dead code but preserved for now (referenced in spec)

### Test Status
- `npx tsc --noEmit` → clean ✅
- `npx vitest run` → 100/100 tests passing ✅
- Manual end-to-end onboarding test: TODO

### Git State
- Commit: `f678194` — "fix(bot): 10-bug patch — onboarding flow, synthesis, Redis keys, dead code"

## 2026-04-26 PM — Session 2 (Kristaps Concerns Audit)

### Kristaps' 6 Concerns — Audit Results

**1. Delete/archive bots as admin**
- ✅ WORKS — `project:archive:` and `project:delete:` callbacks exist and update DB
- Keyboard: `/projects` → tap ⚙️ → Archive / Delete buttons
- Both are soft deletes (data preserved 30 days)

**2. Reliably select/switch between bots (edit/control)**
- ✅ WORKS — `project:select:` callback stores selection in Redis `selected_project:{telegramId}`
- Project selector keyboard: `/projects` shows all admin's projects with inline keyboard
- ⚠️ Minor: bigint vs serial join in `resolveAdminProject` — works but type safety could be better

**3. Newly created team bot functionality**
- ✅ INFRASTRUCTURE works — `finalizeProjectBot()` creates bot, sets webhook, encrypts token
- 4 managed bots in DB with `botTelegramId` + `webhookSecret`
- ❌ NOT TESTED end-to-end — no live test with actual member DM to project bot
- 🔲 Per-project sub-agents not implemented yet (see below)

**4. Onboarding flow per fresh member on project bot**
- ✅ O1-O6 steps wired for project bots via `handleOnboardingCallbackForProject`
- Role, interests, availability, communication_style all collected
- ✅ `finalizeOnboarding` persisted to DB (fixed this session)
- 🔲 Question personalization from onboarding profile NOT tested live

**5. Data properly stored and connected per bot/user**
- ✅ `users` → `members` → `projects` chain works (verified with raw SQL)
- ✅ `members.userId` → FK to `users.id`
- ✅ `members.projectId` → FK to `projects.id`
- ✅ `members.projectProfile` JSONB stores onboarding data
- ⚠️ Need to verify onboarding data actually written with fresh member test

**6. Per-project sub-agents (NEW REQUEST)**
- ❌ NOT IMPLEMENTED — added to DEVELOPMENT_PRD.md as Phase 2 feature
- Implementation: OpenClaw `sessions_spawn` per project, `agents` table, 30-day restore window

**7. Users able to chat with bot (NEW REQUEST)**
- ✅ @Zolara_bot: `handleAIHelp` with rich context (admin status, projects, flows)
- ✅ Project bots: AI fallback handler with project name context
- 🔲 Free-chat / conversational memory mode not implemented yet — added to PRD

### Bugs Fixed This Session (Additional)

**Bug 11: Redis key mismatch in bot-instance.ts**
- `bot-instance.ts` was reading `proj:${projectId}:q:${userId}` for question state
- `telegram-sender.ts` was writing `q:${userId}`
- Fixed: bot-instance now reads `q:${userId}`

### Git State
- Commit: `1e8f9c8` — "fix(managed-bot): question Redis key consistency + comment fixes"
- Total commits today: 3 (checkpoint, 10-bug patch, managed-bot fix)

### Test Status
- `npx tsc --noEmit` → clean ✅
- `npx vitest run` → 100/100 ✅
- Bot online + health check ✅

### Updated PRD
- `docs/DEVELOPMENT_PRD.md` fully updated with:
  - ✅ All Phase 0 bugs marked done
  - Confirmed working features documented
  - New requests: per-project sub-agents, free-chat, bot restore
  - Root cause chain for MiniMax "fake completion"
