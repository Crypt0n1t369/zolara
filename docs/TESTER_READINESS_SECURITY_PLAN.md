# Zolara Tester Readiness + Secure Implementation Plan

_Last updated: 2026-05-01_

Purpose: keep feature implementation safe and fast as new tester-facing requirements arrive.

## Research basis

Official docs checked:
- Telegram Bot API: Managed Bots, `managed_bot`, `managed_bot_created`, `getManagedBotToken`, `setWebhook`, `secret_token`, `allowed_updates`.
- Cloudflare Tunnel: named/remotely-managed tunnels with stable published hostnames.
- PM2 restart strategies: `cron_restart`, `autorestart: false` for one-shot workers, restart delay/backoff options.

## Security invariants

1. **No secrets in logs**
   - Never log bot tokens, MiniMax keys, webhook secrets, encrypted token blobs, or raw `.env`.
   - Error logs may include project IDs, bot usernames, Telegram user IDs, and operation names.

2. **Webhook authenticity**
   - Every Telegram webhook must use `X-Telegram-Bot-Api-Secret-Token`.
   - Project bot webhook route must verify both URL token hash and per-project webhook secret.
   - Unknown bot hash or bad secret must not reveal whether a token exists.

3. **Stable public endpoint before testers**
   - Use a named Cloudflare Tunnel/fixed hostname, not a random `trycloudflare.com` URL.
   - After hostname changes, re-register all active project bot webhooks.
   - Verify `/health` through the public URL before smoke tests.

4. **Managed bot creation must be idempotent**
   - Telegram may deliver duplicate/retried updates.
   - Handlers for `managed_bot` and `message.managed_bot_created` must safely finalize once.
   - If a project is already active with the same bot ID, return success instead of failing.

5. **Background work must be idempotent**
   - Lifecycle worker can run every minute; Redis NX locks prevent overlap.
   - Synthesis/report posting must avoid duplicate reports for the same completed round.
   - Failures should be visible in dashboard/admin status.

6. **LLM calls are untrusted outputs**
   - Parse JSON defensively.
   - Validate shape before storing or sending.
   - Keep fallback question/report paths so bad LLM output does not kill the flow.

7. **Tester privacy**
   - Default to anonymous synthesis unless config says otherwise.
   - Do not expose raw private member responses in group reports.
   - Admin dashboards may show participation status, not sensitive answer content by default.

## Implementation order for incoming features

For each feature Kristaps requests:

1. Identify touched flow: creation, onboarding, validation, round gathering, synthesis, report posting, reactions, dashboard, infra.
2. Read the matching spec before editing.
3. Make smallest coherent code change.
4. Add/update a test if the change affects state transitions, callbacks, security, or parsing.
5. Run targeted test first, then broader type/test gate when practical.
6. Manually verify critical Telegram flows when code paths depend on real Telegram updates.
7. Update `WORKLOG.md` with built/tested/current/next.

## Current product-flow roadmap

Kristaps clarified the intended product entry flow on 2026-05-01. The full audit lives in `docs/PROJECT_START_FLOW_AUDIT.md`.

Do **not** create a separate competing product cron. Use the existing 30-minute tester-readiness cron to advance one safe slice per run, in this order:

1. Project bot unknown-user first-message onboarding: allow plain `hi`/any DM to `@[project]_bot` to offer/start member claim without requiring deep-link payload.
2. Web intake/profile model: email + Telegram username + role + pending authorization; bind to Telegram user ID only after user messages bot.
3. Lead first-message router: whitelisted lead sending `hi` to `@Zolara_bot` starts project creation; known lead with projects sees dashboard/next action; unknown users get web/profile CTA.
4. Group setup assistant: guide lead to create/use group, add project bot, grant invite permission, DM onboarded members group invite, post one-time group intro.
5. Ongoing loop hardening: admin DM fallback for reports, richer report/agenda template, reaction upsert semantics, stable-webhook E2E smoke.

## First tester readiness checklist

### P0 — must pass before inviting testers
- [ ] `npm run readiness:check` passes.
- [ ] Stable public `WEBHOOK_BASE_URL` configured.
- [ ] Public `/health` returns 200.
- [ ] Active project bots rehooked successfully.
- [ ] `/create` creates a pending project.
- [ ] Managed bot creation event finalizes exactly once.
- [ ] Project bot responds to `/start claim_<projectId>`.
- [ ] At least two members complete onboarding.
- [ ] `/startround` sends questions by DM.
- [ ] Responses are collected.
- [ ] Lifecycle worker synthesizes after deadline/all responses.
- [ ] Report posts to configured group, or admin DM fallback if no group.
- [ ] No token/key appears in logs.

### P1 — should pass for useful feedback
- [ ] `/dashboard` shows the next blocker clearly.
- [ ] `/next` recommends the correct action.
- [ ] Report reactions persist and can be summarized.
- [ ] Failed webhook/send/LLM/synthesis state is visible to admin.
- [ ] Recovery runbook exists.

## Stable webhook preflight

Run before inviting external testers and before live E2E smoke:

```bash
npm run readiness:check
```

The preflight checks:
- required secret/config variables are present without printing their values
- `WEBHOOK_BASE_URL` is valid HTTPS
- `WEBHOOK_BASE_URL` is not a random `trycloudflare.com` URL
- public `/health` responds
- PM2 lifecycle worker is configured as a one-shot every-minute cron worker

If this fails on `trycloudflare.com`, set up a named Cloudflare Tunnel/fixed hostname, update `WEBHOOK_BASE_URL`, restart the server, and re-register active bot webhooks.

Detailed runbook: `docs/STABLE_WEBHOOK_RUNBOOK.md`.

Note: `scripts/rehook-all.sh` now refuses to re-register tester/prod webhooks to a random `trycloudflare.com` URL. Pass `WEBHOOK_BASE_URL=https://stable-hostname scripts/rehook-all.sh` or update `.env` after the named tunnel is configured.

## Known repo status as of this note

- Managed bot finalization exists in `src/project/managed-bots/creation.ts`.
- Creation event handlers exist in `src/project/index.ts` for `managed_bot_created` and `my_chat_member`.
- Project bot webhook router verifies token hash + secret in `src/server/index.ts`.
- Lifecycle worker is configured in PM2 with `cron_restart: '* * * * *'`.
- Report reaction buttons exist; reaction events are stored in `engagementEvents` but need dashboard/report summary surfacing.
- Main remaining risk is proving the full production-like Telegram path end-to-end with a stable webhook hostname.
