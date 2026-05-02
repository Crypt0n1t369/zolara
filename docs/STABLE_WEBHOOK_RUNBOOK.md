# Stable Webhook Runbook — Zolara Tester Readiness

_Last updated: 2026-05-01_

## Why this exists

External testers must not depend on random `trycloudflare.com` tunnels. Telegram project-bot webhooks need a stable HTTPS URL so managed bots keep receiving updates after restarts.

Use this runbook before inviting testers or running final live E2E smoke.

## Preflight

```bash
cd ~/projects/zolara
npm run readiness:check
```

Passing criteria:
- `WEBHOOK_BASE_URL` is HTTPS
- hostname is not `trycloudflare.com`
- local `/health` responds with `status=ok` so the app is alive on the host
- public `/health` responds with `status=ok` through the stable HTTPS hostname
- PM2 `zolara` is online
- PM2 lifecycle worker is configured and running as a one-shot every-minute cron worker (`cron_restart: '* * * * *'`, `autorestart: false`)
- Cloudflare named-tunnel prerequisites exist on the host: `~/.cloudflared/cert.pem`, `~/.cloudflared/config.yml`, and tunnel credentials JSON

## Configure a named Cloudflare Tunnel

One-time Cloudflare setup, run interactively on the host:

```bash
cloudflared tunnel login
# This opens a browser and writes ~/.cloudflared/cert.pem.
# Without this cert, `cloudflared tunnel list/create/route dns` will fail.

cloudflared tunnel create zolara-prod
# This writes a tunnel credentials JSON under ~/.cloudflared/.

cloudflared tunnel route dns zolara-prod <stable-hostname.example.com>
```

Create or update `~/.cloudflared/config.yml` after `tunnel create` succeeds. Prefer the checked helper so the config is consistent with readiness checks:

```bash
cd ~/projects/zolara
WEBHOOK_BASE_URL=https://<stable-hostname.example.com> npm run tunnel:prepare-config
CONFIRM_WRITE=1 WEBHOOK_BASE_URL=https://<stable-hostname.example.com> npm run tunnel:prepare-config
```

The helper refuses random `trycloudflare.com` hostnames, requires `~/.cloudflared/cert.pem` and tunnel credentials JSON to exist, and prints paths/hostnames only. It writes:

```yaml
tunnel: zolara-prod
credentials-file: /home/drg/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: <stable-hostname.example.com>
    service: http://localhost:3000
  - service: http_status:404
```

Quick host sanity check before PM2 migration:

```bash
cloudflared tunnel list
cloudflared tunnel info zolara-prod
```

Then start the named tunnel:

```bash
cloudflared tunnel run zolara-prod
```

For PM2, use the checked-in `ecosystem-tunnel.config.cjs`, which now runs a named tunnel (`cloudflared tunnel run ${ZOLARA_TUNNEL_NAME:-zolara-prod}`) rather than a quick `--url` tunnel:

```bash
cd ~/projects/zolara
ZOLARA_TUNNEL_NAME=zolara-prod pm2 start ecosystem-tunnel.config.cjs --update-env
pm2 save
```

The readiness check fails if the PM2 tunnel process still uses `cloudflared tunnel --url ...`, because that creates random `trycloudflare.com` hostnames.

Safety note: `scripts/start-zolara.sh` no longer scrapes quick-tunnel PM2 logs in tester/prod mode. It uses the configured `.env` `WEBHOOK_BASE_URL` and only discovers/writes random `trycloudflare.com` URLs when `ALLOW_EPHEMERAL_TUNNEL=1` is explicitly set for local development.

## Update Zolara config

```bash
cd ~/projects/zolara
# edit .env; do not print secrets in chat/logs
WEBHOOK_BASE_URL=https://<stable-hostname.example.com>
```

Restart the server:

```bash
pm2 restart zolara
```

The server startup auto-rehooks active project bots when `WEBHOOK_BASE_URL` is configured.

If needed, manually rehook active project bots. The script refuses random `trycloudflare.com` hosts and, for real runs, verifies public `/health` before calling Telegram `setWebhook`:

```bash
DRY_RUN=1 WEBHOOK_BASE_URL=https://<stable-hostname.example.com> npm run webhooks:rehook
WEBHOOK_BASE_URL=https://<stable-hostname.example.com> npm run webhooks:rehook
```

Only use `SKIP_PUBLIC_HEALTH_CHECK=1` as an intentional emergency override; otherwise a broken tunnel could point project bots at a dead webhook.

## Verify

```bash
npm run readiness:check
npm run lifecycle:once
curl -fsS https://<stable-hostname.example.com>/health
```

`npm run readiness:check` now separates host health from tunnel health. If local `/health` passes but public `/health` fails, fix the Cloudflare Tunnel/DNS/hostname first rather than changing application code.

Expected health response includes:

```json
{"status":"ok","service":"zolara"}
```

## Live Telegram smoke after preflight passes

Before manual Telegram actions, capture the current smoke baseline:

```bash
npm run smoke:status
```

This prints safe, redacted diagnostics only: local/public health, PM2 runtime state including whether cloudflared is still a quick `--url` tunnel, stable-host checks, recent project/member/round/report state, latest report reaction summary, and project-bot webhook host/pending-update status. It intentionally does not print tokens, encrypted tokens, webhook secrets, or raw `.env` values.

Then run the manual path:

1. Create/select a test project.
2. Confirm managed project bot creation activates exactly once.
3. Open project bot invite and complete onboarding with at least two members.
4. Start a round.
5. Answer questions in private DM.
6. Let lifecycle worker synthesize.
7. Confirm report posts to group or admin DM fallback.
8. Click report reactions and verify `/dashboard` summary.
9. Rerun `npm run smoke:status` and compare project state, webhook status, reports, and failure details.

## Rollback / recovery

If the stable hostname fails:

1. Do not invite testers.
2. If `cloudflared tunnel list` says no origin cert, rerun `cloudflared tunnel login` and confirm `~/.cloudflared/cert.pem` exists.
3. Check `cloudflared tunnel list` and `cloudflared tunnel info zolara-prod`.
4. Confirm DNS route points to the named tunnel.
5. Confirm local server responds on `http://localhost:3000/health`.
6. Confirm PM2 is not still running a quick tunnel: `pm2 show cloudflared` should show `tunnel run zolara-prod`, not `tunnel --url http://localhost:3000`.
7. Restart tunnel and server.
8. Rerun `npm run readiness:check`.

Random `trycloudflare.com` may be acceptable only for local/dev experiments. It is a release blocker for testers.
