# Security Notes for Zolara

## Immediate secret-rotation requirement

This repository is now cleaned so `.env`, `node_modules/`, and local agent memory are no longer tracked. However, `.env` was tracked in earlier Git history before the cleanup commit.

Before inviting testers or relying on the GitHub-hosted repository, rotate all secrets that ever appeared in `.env` or project memory:

- Telegram manager bot token (`ZOLARA_BOT_TOKEN`)
- Telegram managed/product bot token (`MANAGED_BOTS_TOKEN`)
- MiniMax API key (`MINIMAX_API_KEY`)
- Webhook secret (`WEBHOOK_SECRET`)
- Encryption key (`ENCRYPTION_KEY`)
- Database/Redis credentials if they were real/shared

After rotation:

1. Update the local `.env` on the runtime host only.
2. Restart Zolara.
3. Run `npm run readiness:check`.
4. Once a stable HTTPS hostname is configured, run:

```bash
DRY_RUN=1 WEBHOOK_BASE_URL=https://<stable-host> npm run webhooks:rehook
WEBHOOK_BASE_URL=https://<stable-host> npm run webhooks:rehook
```

## GitHub repository safety

Current intended repo hygiene:

- `.env` is ignored.
- `.env.example` is safe to commit.
- `node_modules/` is ignored.
- `memory/` is ignored.
- Readiness/smoke scripts must not print tokens, encrypted token blobs, webhook secrets, or raw `.env` values.

GitHub secret scanning is enabled on the public repository, but rotation is still required because old commits can remain accessible.

## Optional history cleanup

After credentials are rotated, history rewrite can remove old secret-bearing blobs for cleanliness. Do this only with coordination because it force-pushes `master` and disrupts anyone with existing clones.
