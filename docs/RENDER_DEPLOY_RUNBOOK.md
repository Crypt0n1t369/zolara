# Render Deploy Runbook — Zolara Backend Alternative

Use this if Cloudflare named-tunnel setup is blocked. Render provides the stable HTTPS URL that Telegram webhooks need, so `ZOLARA_HOSTING_MODE=external` should be used.

## What Render must provide

- One Docker web service running `npm start` on port `3000`.
- One persistent Postgres database.
- One persistent Redis instance.
- One recurring worker/cron job that runs `npm run lifecycle:once` every minute, or an always-on worker running `npm run lifecycle:loop` if cron is unavailable.
- Secret environment variables configured in Render, never committed to GitHub.

## Required environment variables

Set these on the Render web service and worker/cron job:

```env
NODE_ENV=production
PORT=3000
DATABASE_URL=<render-postgres-internal-url>
REDIS_URL=<render-redis-internal-url>
ZOLARA_BOT_TOKEN=<rotated-token>
MANAGED_BOTS_TOKEN=<rotated-token>
WEBHOOK_BASE_URL=https://<render-service-or-custom-domain>
WEBHOOK_SECRET=<rotated-random-secret>
MINIMAX_API_KEY=<rotated-key>
ENCRYPTION_KEY=<rotated-32+-char-key>
ZOLARA_HOSTING_MODE=external
```

`ZOLARA_HOSTING_MODE=external` tells readiness/smoke diagnostics not to require local Cloudflare files or PM2 tunnel state. It still requires HTTPS and public `/health`.

## Deploy steps

1. In Render, create a new Web Service from `https://github.com/Crypt0n1t369/zolara`.
2. Use Docker deployment. The checked `Dockerfile` builds and starts the Node/Hono app.
3. Add Postgres and Redis, then wire `DATABASE_URL` and `REDIS_URL`.
4. Add the required rotated secrets above.
5. Deploy the web service and wait for it to become healthy.
6. Verify public health:

```bash
curl -fsS https://<render-service-or-custom-domain>/health
```

Expected:

```json
{"status":"ok","service":"zolara"}
```

7. Run readiness from the host or Render shell using the external mode:

```bash
ZOLARA_HOSTING_MODE=external WEBHOOK_BASE_URL=https://<render-service-or-custom-domain> npm run readiness:check
```

8. Rehook project bots only after public `/health` passes:

```bash
DRY_RUN=1 WEBHOOK_BASE_URL=https://<render-service-or-custom-domain> npm run webhooks:rehook
WEBHOOK_BASE_URL=https://<render-service-or-custom-domain> npm run webhooks:rehook
```

9. Configure the lifecycle schedule:
   - Preferred: cron/recurring job every minute running `npm run lifecycle:once`.
   - Fallback: worker process running `npm run lifecycle:loop`.

10. Final smoke:

```bash
ZOLARA_HOSTING_MODE=external WEBHOOK_BASE_URL=https://<render-service-or-custom-domain> npm run smoke:status
```

Then run the live Telegram E2E path: create/select project → managed bot activates → onboard members → start round → collect responses → lifecycle synthesis → report post/fallback → reactions.

## Safety notes

- Rotate all secrets before entering them into Render because `.env` existed in old Git history.
- Do not use `trycloudflare.com` on Render; use the Render HTTPS service URL or a custom domain.
- Do not run the real rehook command until public `/health` returns `status=ok`.
- Keep `.env` local-only; Render should store secrets in its dashboard/environment settings.
