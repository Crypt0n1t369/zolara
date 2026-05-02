# First Tester Go-Live Checklist

Use this as the final operator checklist before inviting external testers. It assumes code/CI are green and focuses on the live runtime blockers surfaced by `npm run readiness:check`.

## 1. Rotate secrets first

Because real secrets existed in old Git history, rotate provider-owned credentials before go-live:

- `ZOLARA_BOT_TOKEN` — Telegram manager bot token
- `MANAGED_BOTS_TOKEN` — Telegram managed-bots/product token
- `MINIMAX_API_KEY` — MiniMax API key
- Database/Redis credentials if they were real/shared

Generate fresh Zolara-owned random values:

```bash
npm run ops:generate-secrets
```

Store the generated `WEBHOOK_SECRET` and `ENCRYPTION_KEY` in the runtime host or hosting-provider secret store. Do not commit generated values.

## 2. Choose one stable HTTPS path

### Option A — Current host with Cloudflare named tunnel

Follow `docs/STABLE_WEBHOOK_RUNBOOK.md`:

```bash
cloudflared tunnel login
cloudflared tunnel create zolara-prod
cloudflared tunnel route dns zolara-prod <stable-hostname>
CONFIRM_WRITE=1 WEBHOOK_BASE_URL=https://<stable-hostname> npm run tunnel:prepare-config
ZOLARA_TUNNEL_NAME=zolara-prod pm2 start ecosystem-tunnel.config.cjs --update-env
pm2 save
```

Then update `.env`:

```env
WEBHOOK_BASE_URL=https://<stable-hostname>
ZOLARA_HOSTING_MODE=cloudflare
```

### Option B — Render/external hosting

Follow `docs/RENDER_DEPLOY_RUNBOOK.md` or start from the Blueprint:

```text
https://dashboard.render.com/blueprint/new?repo=https://github.com/Crypt0n1t369/zolara
```

Use rotated secrets for every `sync: false` value and set:

```env
ZOLARA_HOSTING_MODE=external
WEBHOOK_BASE_URL=https://<render-service-or-custom-domain>
```

## 3. Verify public health before touching Telegram webhooks

```bash
curl -fsS https://<stable-host>/health
```

Expected:

```json
{"status":"ok","service":"zolara"}
```

Then run the matching readiness mode:

```bash
# Cloudflare/current-host path
npm run readiness:check

# Render/external path
ZOLARA_HOSTING_MODE=external WEBHOOK_BASE_URL=https://<stable-host> npm run readiness:check
```

## 4. Clean legacy incomplete active row after approval

Dry-run first:

```bash
npm run cleanup:incomplete-active-projects
```

Current known dry-run result is one legacy active row without project-bot credentials:

```text
7767…37c8 Zolara project missing: botUsername, botTokenEncrypted, webhookSecret
```

Only after approval:

```bash
CONFIRM_ARCHIVE=1 npm run cleanup:incomplete-active-projects
```

## 5. Rehook active project bots only after public health passes

Dry-run:

```bash
DRY_RUN=1 WEBHOOK_BASE_URL=https://<stable-host> npm run webhooks:rehook
```

Real run:

```bash
WEBHOOK_BASE_URL=https://<stable-host> npm run webhooks:rehook
```

This sets Telegram webhooks with stable HTTPS URL, `secret_token`, and explicit `allowed_updates`.

## 6. Final diagnostics before inviting testers

```bash
npm run readiness:check
npm run smoke:status
```

For Render/external hosting, prefix both commands with:

```bash
ZOLARA_HOSTING_MODE=external WEBHOOK_BASE_URL=https://<stable-host>
```

Proceed only when readiness passes and smoke status has no blocking failures.

## 7. Live E2E tester smoke

1. Create/select a fresh test project.
2. Confirm managed bot creation activates exactly once.
3. Confirm the project bot webhook is set and matches `WEBHOOK_BASE_URL`.
4. Onboard at least two members.
5. Start one explicit round.
6. Answer questions in member DMs.
7. Let lifecycle worker synthesize.
8. Confirm report posts to group or admin DM fallback.
9. Click report reactions.
10. Confirm `/dashboard`, `/next`, and `npm run smoke:status` reflect report/reaction state.
