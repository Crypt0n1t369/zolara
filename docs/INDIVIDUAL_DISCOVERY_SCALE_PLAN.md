# Individual Discovery at Scale — Tonight Plan

_Last updated: 2026-05-02 01:55 Africa/Cairo_

## Goal

Make Zolara useful for individual discovery without compromising the current tester-readiness path. The product should help each member understand their own patterns while still serving the group consensus loop.

This plan fits the existing priorities:
- Do not block P0 stable webhook / E2E smoke.
- Build on existing onboarding, response collection, report reactions, `/my_status`, dashboard, and synthesis flow.
- Keep the first implementation Telegram-first and privacy-safe.
- Avoid big schema redesigns tonight unless strictly necessary.

## Product principle

Zolara should never claim to fully know a person. It should maintain a living, correctable model:

> “Here is what I’m noticing. Is this accurate?”

Every individual insight must be traceable to one of:
1. Declared profile data from onboarding or explicit edits.
2. Observed response/reaction patterns.
3. Current project/round context.
4. User-confirmed correction.

## What scale requires

### 1. A layered individual memory model

Minimum viable layers:

- **Raw evidence**: onboarding answers, round responses, report reactions, corrections.
- **Extracted signals**: values, blockers, communication style, recurring concerns, contribution style.
- **Confidence**: low / medium / high; only explicit confirmation should become high confidence.
- **Scope**:
  - `private_to_member`: visible only to the person.
  - `project_context`: usable to adapt prompts inside that project.
  - `group_synthesis_allowed`: safe aggregate signal, never raw sensitive content.
- **Freshness**: stable trait vs temporary state.

Current storage already has a foundation:
- `users.communicationProfile`
- `members.projectProfile`
- `responses`
- `engagementEvents`

Tonight should start by using these existing JSON fields instead of adding large new tables.

### 2. Consent and correction controls

Required controls before this becomes powerful:

- `/me` — show what Zolara thinks it knows.
- “Remember this” — promote an insight into profile memory.
- “Not quite” / “Refine” — correction path.
- “Forget this” — remove a remembered insight.
- “Private only” — never use in group synthesis.

Without these, individual discovery will feel invasive at scale.

### 3. Async extraction, not webhook-blocking intelligence

At scale, do not run expensive reflection/extraction inline in Telegram webhooks. Webhook handlers should only:
- save the user answer/reaction,
- enqueue or mark pending insight extraction,
- respond quickly.

The lifecycle worker or a future low-priority worker should process extraction. For tonight, the MVP can use deterministic/local extraction and defer LLM-heavy profiling until after P0 E2E is stable.

### 4. Prompt personalization boundary

Personalization should affect the doorway, not the core consensus contract.

Good:
- adapt question wording to communication style,
- remind someone of their own confirmed priorities,
- offer private reflection after they answer.

Bad:
- bias group synthesis toward one person’s inferred traits,
- expose individual private profiles to admins,
- use low-confidence inferences as facts.

## Tonight build plan

### P0 — Do not break tester-readiness

Before and after the feature slice:

```bash
npx tsc --noEmit
npm run readiness:check   # expected to fail until stable Cloudflare hostname is configured
```

If touching dashboard/profile logic, run targeted tests.

### Slice 1 — Individual profile view (`/me`) using existing data

Build a project-bot `/me` command that works in private DM.

It should show:
- onboarding profile summary from `members.projectProfile`,
- current project role/status,
- latest personal round state if available,
- current remembered communication profile from `users.communicationProfile`,
- privacy note: “Only you can see this. Group reports use aggregated/anonymized patterns.”

Why first:
- user-visible profile is the trust foundation,
- uses existing data,
- low risk,
- immediately useful for testers.

### Slice 2 — Post-answer private reflection MVP

After a member answers a round question, send a short deterministic reflection, not a heavy LLM inference yet.

Example:

> “Saved. I’ll use this for the group synthesis. Private reflection: this answer seems to emphasize clarity / risk / momentum. Is that accurate?”

Buttons:
- `✅ Accurate`
- `✏️ Refine`
- `🚫 Don’t remember`

For tonight, store only the button event in `engagementEvents` or `users.communicationProfile.pendingSignals`. Do not overfit.

### Slice 3 — Remember confirmed signal

When user taps `Accurate`, write a small confirmed signal into `users.communicationProfile`:

```ts
{
  individualDiscovery: {
    confirmedSignals: [
      {
        type: 'value' | 'blocker' | 'communication_style' | 'contribution_style',
        label: string,
        confidence: 'high',
        source: 'post_answer_reflection',
        scope: 'private_to_member',
        projectId,
        confirmedAt
      }
    ]
  }
}
```

Keep the first labels simple and deterministic:
- clarity
- speed
- trust
- risk
- alignment
- autonomy
- practical next steps

### Slice 4 — Use confirmed profile lightly in question delivery

When sending a question, include at most one private personalization line if the user has confirmed signals:

> “Given your usual focus on clarity, answer from that lens if useful.”

This is enough to prove the loop without risking manipulative personalization.

### Slice 5 — Tests and runbook

Add tests for pure helpers:
- summarize `/me` profile view from profile JSON,
- extract a simple signal from answer text,
- merge confirmed signal without duplicating endlessly.

Update `WORKLOG.md` and add notes to the tester runbook:
- how to test `/me`,
- how to answer a question and confirm/refine reflection,
- how to verify profile changes.

## Data safety rules

1. Raw private answers must not appear in admin dashboard or group reports.
2. Admin can see participation and aggregate themes, not individual discovery notes.
3. Inferred signals remain low-confidence until confirmed.
4. Confirmed individual profile entries default to private.
5. Any group-level use must be aggregate and anonymized.
6. User correction deletes/overrides inference.

## What not to build tonight

Defer:
- embeddings/vector search,
- complex psychological typology,
- admin-facing individual profiles,
- web UI for profiles,
- LLM-heavy background profiler,
- cross-project identity graph,
- automatic strong claims about personality.

Those can come after stable E2E smoke.

## Success criteria for tonight

Minimum useful completion:
- `/me` works in project bot private DM.
- A member can answer a round question and receive a private reflection prompt.
- A confirmed signal is stored safely and privately.
- Confirmed signal appears in `/me`.
- Typecheck and targeted tests pass.
- Tester-readiness checks remain understood: stable Cloudflare hostname is still the infra blocker unless configured.

## Strategic reason this matters

The group consensus engine becomes much stronger when each person also gets a private self-discovery loop. At scale, this creates a flywheel:

1. Members answer better because prompts feel relevant.
2. Zolara learns confirmed individual lenses.
3. Group synthesis improves because inputs become clearer.
4. Members receive private insights that make participation personally valuable.
5. Teams get better consensus without sacrificing individual privacy.
