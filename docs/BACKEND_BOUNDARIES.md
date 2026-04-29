# Backend Boundaries

## Telegram managed bots API boundary

Shared Telegram Managed Bots API calls live in:

- `src/telegram/managed-bots-api.ts`

Manager and project flows must import these helpers through their existing lifecycle modules unless there is a reason to depend directly on the shared boundary:

- `src/manager/managed-bots/lifecycle.ts`
- `src/project/managed-bots/lifecycle.ts`

Those lifecycle modules are compatibility re-export shims. This keeps existing feature code stable while preventing manager/project-specific copies of token lookup, webhook setup, bot info lookup, creation link building, and command menu setup from drifting apart.

When adding a new Telegram API operation that is not specific to one flow, add it to `src/telegram/managed-bots-api.ts` first, then re-export only where needed.
