# Zolara

AI-powered consensus engine for Telegram groups.

## Current tester-readiness status

Code, tests, production dependency audit, Render Blueprint validation, and Docker build are covered by GitHub CI.

Live tester readiness still requires operator/account actions:

1. Rotate provider-owned secrets.
2. Choose stable HTTPS hosting:
   - Cloudflare named tunnel: `docs/STABLE_WEBHOOK_RUNBOOK.md`
   - Render/external hosting: `docs/RENDER_DEPLOY_RUNBOOK.md`
3. Follow the final go-live sequence: `docs/FIRST_TESTER_GO_LIVE_CHECKLIST.md`
4. Rehook active project bots only after public `/health` passes.
5. Run the live Telegram E2E smoke path.

## Useful commands

```bash
npm run readiness:check
npm run smoke:status
npm run deploy:render:check
npm run ops:generate-secrets
npm run webhooks:rehook
```

For Render/external hosting diagnostics, prefix readiness/smoke commands with:

```bash
ZOLARA_HOSTING_MODE=external WEBHOOK_BASE_URL=https://<stable-host>
```
