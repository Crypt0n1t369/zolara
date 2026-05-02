# Project Start Flow Audit — Lead, Member, Group, Ongoing Loop

_Last updated: 2026-05-01 18:42 Africa/Cairo_

## Desired product logic, clarified

### A. Project lead entry
1. Lead lands on Zolara landing page.
2. Lead logs in or creates a lightweight profile.
3. Lead submits email + Telegram username.
4. System whitelists/authorizes that Telegram username for lead onboarding.
5. Lead searches for `@Zolara_bot` or clicks a direct link.
6. Lead sends `hi`, `/start`, `/create`, or any first message.
7. Zolara recognizes the lead and starts the project-creation flow.
8. Lead creates the managed `@[project]_bot`.
9. Zolara confirms project bot activation and gives next setup actions.

Important Telegram constraint: a bot cannot contact a Telegram user first. The web profile can whitelist the username, but the user must still open/send a message to `@Zolara_bot` before Zolara can DM them.

### B. Project member entry
1. Member receives direct project bot link, or creates a web profile first.
2. Member finds/clicks `@[project]_bot`.
3. Member sends `hi`, `/start`, or clicks the deep link.
4. The project bot starts or resumes onboarding in the private chat.
5. Onboarding stores role, interests, availability, communication style, and consent/commitment.

### C. Group setup
1. After all/most members complete onboarding, lead creates the main Telegram group or uses an existing group.
2. Lead adds `@[project]_bot` to the group, ideally as admin with invite-link permission.
3. Zolara detects/records the group.
4. Zolara sends each onboarded member a group join link when available.
5. Project bot posts a group introduction:
   - project summary
   - how Zolara works
   - what happens in main chat vs private chats
   - commands / next action

Telegram constraint: bots cannot create Telegram groups by themselves. They can create invite links only after being added to a group with the right permissions.

### D. Ongoing loop
1. Main group is the shared coordination surface: announcements, summaries, reports, results, decisions, agenda, next steps.
2. Each round starts from the lead/admin or later an agreed group action.
3. Members answer privately in 1:1 chats with the project bot to avoid interruption, performance, and groupthink.
4. Zolara synthesizes private responses.
5. Results, next steps, timeline, unresolved questions, and reaction buttons are posted back to the main group.
6. Group reactions/feedback influence the next round, meeting agenda, or action plan.

## Logic gaps in the proposed flow

1. **Whitelist does not equal contact permission**
   - Web form can authorize a Telegram username, but Telegram still requires the user to message the bot first.
   - Required UX: after form submit, show a prominent `Open @Zolara_bot` button and explain “send hi to connect.”

2. **Telegram username is mutable and not a stable identity**
   - Users can change usernames. Stable identity is Telegram user ID, available only after bot contact.
   - Required model: store pending lead/member profile by normalized username/email, then bind it to Telegram `from.id` when they message the bot.

3. **“Send hi starts flow” is not fully implemented**
   - Current lead `/create` works, but plain “hi” on `@Zolara_bot` goes through AI/help, not guaranteed project creation.
   - Current project bot plain `/start` can route, but plain “hi” from a non-member is likely AI fallback/help, not onboarding.
   - Required behavior: first-message router should detect authorized/pending users and start the correct flow without requiring exact commands.

4. **Member onboarding by searching project bot needs a fallback**
   - Deep link contains `claim_<projectId>`. Search + hi has no payload.
   - Because a project bot is dedicated to one project, it can infer `projectId`, but it still needs to create a claim/onboarding state for unknown users.
   - Required behavior: unknown user DM to project bot should offer “Join this project” and start the claim gate.

5. **“When everybody completed onboarding” needs an operational threshold**
   - The system may not know the intended team roster unless imported/declared.
   - Required behavior: lead can either set expected member count/list or manually press “Continue with current onboarded members.”

6. **Group creation and invite distribution need permissions/fallbacks**
   - Bots cannot create groups.
   - Bot can create group invite links only if added to the group and allowed to invite users.
   - Required fallback: if no group/permissions, post reports to lead/admin DM and show exact setup instructions.

7. **Main chat intro needs to happen exactly once per project/group**
   - Required idempotency: store intro-posted marker per project/group to avoid repeated welcome spam.

8. **Round start authority needs clear roles**
   - Who can start a round: owner/admin only for MVP.
   - Later: group-triggered suggestions can be added, but admin confirmation should remain for tester safety.

9. **Private answers need privacy promise at point of answer**
   - Members should be reminded that private responses become synthesized themes, not raw public quotes unless configured.

10. **Ongoing loop needs a visible state machine**
   - Group and dashboard should show: setup → onboarding → ready → gathering → synthesizing → report posted → reacting → next round.

## Current implementation audit

### Already present / partially working
- Static landing page exists at `/` and `/landing-page`.
- Lead can use `@Zolara_bot` and `/create` initiation flow.
- Managed bot finalization exists: `finalizeProjectBot()` calls `getManagedBotToken`, encrypts token, sets webhook, stores active bot.
- Project bot deep-link claim flow exists: `/start claim_<projectId>`.
- Member onboarding O1-O6 exists and stores profile data.
- Admin `/invite` exists and now provides member onboarding link plus group invite link when bot permissions allow.
- Project bot can be added to groups and group ID can be stored.
- Round manager, question sending, response collection, synthesis, report posting, and reaction buttons exist.
- Admin `/dashboard` shows onboarding, validation, latest round, next action, and now reaction summary.
- PM2 lifecycle worker is scheduled every minute via `cron_restart: '* * * * *'`.
- Existing OpenClaw tester-readiness cron runs every 30 minutes.

### Missing / needs transformation

#### 1. Web profile + whitelist system
- Missing login/profile page.
- Missing email + Telegram username form.
- Missing pending whitelist/authorization table/state.
- Missing binding from submitted Telegram username to Telegram user ID after first bot contact.

#### 2. Lead first-message router
- Need route for `hi`/any message from whitelisted lead to start project creation.
- Need route for unknown non-whitelisted user: explain how to apply/connect from landing page.
- Need route for known lead with existing projects: show dashboard/next action rather than generic AI.

#### 3. Member first-message router
- Need unknown-user private message to `@[project]_bot` to start claim/onboarding even without deep-link payload.
- Need optional profile prefill if member came from web profile.

#### 4. Group setup assistant
- Need setup state after onboarding: “create/use group, add bot, grant invite permission.”
- Need automatic DM to onboarded members with group invite when available.
- Need one-time group intro message with project summary/process/commands.
- Need fallback if group invite cannot be created.

#### 5. Ongoing main-chat loop expansion
- Need group report format to include results, next steps, timeline, unresolved questions, and agenda.
- Need admin DM fallback when no group configured.
- Need group-facing current-state/next-step command or pinned intro.
- Need reaction upsert semantics if strict one-vote-per-member is desired.

#### 6. Stable production webhook
- Need named Cloudflare Tunnel/fixed hostname before external testers.
- Current random tunnel approach is not safe for tester rollout.

## Transformation roadmap for existing 30-minute readiness cron

Do not add a competing cron. Use the existing `c1f203b8-5dd4-4e26-9a9a-9be9ec9c244f` readiness cron and advance one safe slice per run.

### Phase 1 — Audit and routing foundations
1. Add this audit to docs and worklog.
2. Add lead/member first-message routing plan to `TESTER_READINESS_SECURITY_PLAN.md`.
3. Implement project bot unknown-user “Join this project?” start path.
4. Test onboarding starts from plain `hi` to a project bot.

### Phase 2 — Web intake and authorization
1. Add DB/state model for pending web profiles: email, Telegram username, role (`lead`/`member`), status, bound Telegram ID.
2. Add minimal landing/profile form endpoint.
3. Add safe validation and rate limits.
4. Bind profile to Telegram ID on first bot message.

### Phase 3 — Lead creation from any first message
1. If whitelisted lead sends `hi`, start `/create` flow.
2. If known lead has project, show dashboard/next action.
3. If unknown, show landing/profile CTA.

### Phase 4 — Group setup assistant
1. Add post-onboarding admin setup prompt.
2. Add group permission check and invite-link creation.
3. DM onboarded members the group invite link.
4. Post one-time group intro and store idempotency marker.

### Phase 5 — Ongoing loop hardening
1. Add admin DM fallback for reports.
2. Expand report template with results, next steps, timeline, questions, agenda.
3. Upsert report reactions per member/round.
4. Run full E2E smoke with stable webhook.

## Scheduling decision

No new cron should be created right now. Existing schedules:
- OpenClaw 30-minute tester-readiness cron: use this for gradual roadmap implementation.
- PM2 lifecycle worker every minute: keep for round deadlines only.

Keeping one product-readiness cron avoids mixed plans, duplicate edits, and conflicting priorities.
