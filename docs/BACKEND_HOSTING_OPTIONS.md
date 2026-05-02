# Backend Hosting Options for Zolara Webhooks

GitHub Pages can host the static landing page, but it cannot run the Zolara backend. Telegram webhooks require an HTTPS service that accepts POST requests, runs the Node/Hono app, and can reach Postgres, Redis, and secrets.

## Recommendation for first testers

Use one of these two paths:

1. **Fastest from current host: named Cloudflare Tunnel**
   - Keep Zolara/PM2/Postgres/Redis on this ThinkPad host.
   - Finish `docs/STABLE_WEBHOOK_RUNBOOK.md`.
   - Best when we want minimum application migration.

2. **Cleaner production-like path: small VPS or container platform**
   - Deploy the Node app with the included `Dockerfile`.
   - Use managed Postgres + Redis or run them on the VPS.
   - Set `WEBHOOK_BASE_URL` to the platform HTTPS URL/custom domain.
   - Best when we want to remove tunnel fragility.

## GitHub Pages scope

Safe for:
- Static landing page
- Docs/marketing copy
- A redirect page to Telegram

Not suitable for:
- `/webhook/zolara`
- `/webhook/projectbot/:tokenHash`
- Telegram Bot API webhook POSTs
- Lifecycle worker execution
- DB/Redis-backed flows

## Container deploy checklist

Container status: `docker build -t zolara:test .` has been verified locally after removing the non-portable local `file:../self-healing-agent/dist` package dependency. Self-healing remains optional at runtime; if the package is absent, the server logs that it is running without it.


Required environment variables:

```env
NODE_ENV=production
PORT=3000
DATABASE_URL=postgresql://...
REDIS_URL=redis://...
ZOLARA_BOT_TOKEN=...
MANAGED_BOTS_TOKEN=...
WEBHOOK_BASE_URL=https://<stable-hostname>
WEBHOOK_SECRET=<random-secret>
MINIMAX_API_KEY=...
ENCRYPTION_KEY=<32+ chars>
ZOLARA_HOSTING_MODE=external
```

Deploy steps:

```bash
npm run build
npm run readiness:check
```

Then on the hosting platform:

1. Build from `Dockerfile`.
2. Expose port `3000` over HTTPS.
3. Set all required environment variables.
4. Run DB migrations/push as appropriate.
5. Start the web process with `npm start`.
6. Schedule lifecycle worker every minute using platform cron/background worker equivalent:
   ```bash
   npm run lifecycle:once
   ```
   If the platform supports a separate always-on worker process but not cron, run:
   ```bash
   npm run lifecycle:loop
   ```
   This calls the one-shot worker every 60 seconds by default (`LIFECYCLE_WORKER_INTERVAL_SECONDS` can override it). PM2 deployments should keep using the checked-in `cron_restart` one-shot worker instead.
7. Rehook active project bots to the stable `WEBHOOK_BASE_URL` after public `/health` passes. First run a safe dry-run:
   ```bash
   DRY_RUN=1 WEBHOOK_BASE_URL=https://<stable-hostname> scripts/rehook-all.sh
   WEBHOOK_BASE_URL=https://<stable-hostname> scripts/rehook-all.sh
   ```
   The script refuses random `trycloudflare.com` URLs and reserved/example hostnames by default. Active rows without project-bot credentials are skipped when they have no bot username; active rows with a bot username but missing credentials still fail the rehook.
8. Verify:
   ```bash
   ZOLARA_HOSTING_MODE=external npm run readiness:check
   ZOLARA_HOSTING_MODE=external npm run smoke:status
   ```

`ZOLARA_HOSTING_MODE=external` tells readiness/smoke checks not to require local Cloudflare named-tunnel files or PM2 tunnel runtime. They still require HTTPS `WEBHOOK_BASE_URL` and working public `/health`.

## Platform notes

- **VPS**: easiest mental model; reuse PM2 configs and named Cloudflare/DNS or direct Nginx/Caddy TLS.
- **Render/Railway/Fly**: good for HTTPS web process; make sure Redis/Postgres are persistent and a recurring worker can run every minute.
- **GitHub Pages + backend elsewhere**: good split if landing page needs public hosting, but webhooks still need the backend host.
