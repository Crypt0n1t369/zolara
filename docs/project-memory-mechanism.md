# Project Memory & Context-Building Mechanism

> Research synthesis: How Zolara strings together context across sessions to build project knowledge and guide teams toward alignment.

---

## 1. The Core Problem

Zolara has a structural gap: rounds are isolated events. Each round generates a report, but the system has no persistent memory of *why* decisions were made, *what* tensions have recurred, *who* has been working on what, or *how* the team's understanding has evolved.

Between rounds, the bot goes quiet or operates in a shallow "free chat" mode with no project context. This means:

- **Round N+1 questions ignore Round N findings** unless an admin manually summarizes
- **Tensions that recur across 3+ rounds are invisible** — the bot treats each round as a blank slate
- **The project bot has no institutional memory** — onboarding a new member requires the admin to manually brief them
- **The team drifts** without anyone noticing until a major misalignment surfaces

The goal is to build a **persistent project knowledge layer** that:
1. Accumulates insight across rounds without being intrusive
2. Informs question generation so rounds get progressively sharper
3. Surfaces recurring tensions, blind spots, and consensus evolution
4. Reduces the team's coordination overhead over time

---

## 2. What We Know From Research

### 2.1 Memory Architecture (from deep_research_synthesis.md)

Three memory types must work together:

| Type | Storage | Purpose |
|------|---------|---------|
| **Episodic** (what happened) | PostgreSQL — append-only event log | Track engagement, rounds, contributions across time |
| **Semantic** (what does it mean) | pgvector — embeddings of insights, decisions, tensions | RAG retrieval when generating questions or reports |
| **Procedural** (what to do) | PostgreSQL — project config, member profiles, rules | Behavioral guidance for bot responses |

### 2.2 Temporal Decay (from §2.3)

Not all information is equally valuable over time. Recent insights matter more than old ones. Use exponential decay when ranking retrieved context:

```
relevance_score = semantic_similarity × decay_factor(recency)
decay_factor = e^(-λ × age_in_days)
```

Set λ based on project pace (weekly projects: λ=0.1, daily projects: λ=0.3).

### 2.3 Group Observation (from group_interaction.md)

The bot already tracks a 50-message rolling buffer in Redis for conflict detection. This is "ambient context" — low-cost, always-on. Key insight: **don't invoke LLM on every message**, use lightweight heuristics to gate expensive analysis.

### 2.4 User Profiles (from user_profiling_model.md)

Member profiles should be **passively learned** from behavior, not just actively asked. The bot builds a picture of each member over time (communication style, expertise areas, engagement patterns) that shapes how it asks questions and routes tension.

---

## 3. The Zolara Memory Stack

### Layer 1: Round Memory ( Episodic)

Each completed round leaves behind structured artifacts:

```
RoundMemory:
  round_id, project_id, completed_at
  convergence_tier, convergence_score
  themes[]           — what the team converged on
  tensions[]         — what remained in conflict
  blind_spots[]      — what wasn't surfaced
  action_items[]     — what was committed
  participation_rate — who showed up, who didn't
```

**Why this matters:** Round N+1 can compare against Round N. "Your convergence score improved from 62% (operational) to 78% (conditional) — the team is moving toward alignment on X."

### Layer 2: Topic Graph (Semantic + Relational)

Topics discussed across rounds are stored as a graph:

```
TopicNode:
  id, project_id, name (e.g., "studio allocation", "festival budget")
  first_appeared: round_id
  last_appeared: round_id
  alignment_trajectory: improving | stable | degrading | new

TopicEdge:
  from_topic_id, to_topic_id, relationship_type
  (e.g., "related_to", "conflicts_with", "subsumes")
```

**Why this matters:** When a new round starts on "studio policy," the bot can retrieve: "This topic came up in Rounds 2 and 4. It was TENSION in R2, OPERATIONAL consensus in R4 after the rotation system was proposed. What's changed since R4?"

### Layer 3: Member Profiles (Procedural)

Each member accumulates a profile across interactions:

```
MemberProfile:
  telegram_id, project_id
  expertise_tags[]      — inferred from what they write about confidently
  communication_style  — short/detailed, fast/slow, formal/casual
  engagement_trend     — increasing/stable/decreasing
  last_active, rounds_participated
  contribution_quality — rolling average of depth scores
  sensitivities[]      — topics where they tend to push back
```

**Why this matters:** Question personalization. "This member consistently raises execution concerns — next round's questions should anticipate and address those proactively."

### Layer 4: Ambient Group Context (Redis buffer, no LLM)

The existing 50-message rolling buffer feeds into round context when triggered. But we extend its use:

- **Topic drift detection:** If terms appear in group chat that haven't been in a round in 3+ months, flag as "emerging topic"
- **Tension early warning:** If two members consistently disagree in group chat (detected via heuristic), the next round's questions can address that dyad specifically
- **Engagement tracking:** If a normally active member goes silent in group chat (but isn't in a round), gentle check-in prompt on next 1v1

---

## 4. The Mechanism: Progressive Context Accumulation

### 4.1 Between Rounds: Passive Capture (No Intrusion)

The bot does NOT message users between rounds unless triggered. Instead, it captures signal from two sources:

**Source A: Group Chat Observation (Passive)**

When the project bot is in the group with privacy mode off:
1. Messages matching topic keywords (from past round themes/tensions) are flagged
2. Flagged messages are embedded and stored in pgvector as `ambient_signals`
3. No LLM call is made — keyword matching is free
4. On Round N+1 trigger, the last 10 ambient signals are surfaced to question generation

**What users experience:** Nothing. The bot is silent. But their next round questions are better informed.

**Source B: Free Chat 1v1 Insights**

When a user messages the project bot in free chat mode:
1. Bot classifies the message: `question | insight | casual | request`
2. If `insight` or `casual` with substantive content (>50 chars, not a command):
   - Store in `async_insights` table with `source='free_chat'`
   - Embed and store vector for semantic retrieval
   - On next round, surface: "In free chat, Kristaps mentioned X — should we ask the team about this?"
3. If user explicitly shares a tension: ask if they'd like it to become a round topic

**What users experience:** A brief acknowledgment. "Interesting point — I'll keep this in mind for the next round." That's it. No intrusive follow-up.

### 4.2 Round Transition: Context Compression

When a round completes and before the next round starts, a background job runs:

```
Step 1: Pull last 3 rounds' RoundMemory records
Step 2: Pull last 20 async_insights that weren't surfaced in a round
Step 3: Pull last 10 ambient_signals from group buffer
Step 4: Compress into a "Round Context Brief" (~500 words):
        - What's changed since last round (1 sentence)
        - Recurring tensions (list with round numbers)
        - Emerging topics (from group chat or free chat)
        - Member engagement status (who's quiet, who's active)
Step 5: Store as project_context.last_round_summary
Step 6: Inject into next round's question generation prompt
```

**Cost:** 1 Flash-tier LLM call per round transition. Cheap.

### 4.3 During Rounds: Question Personalization

Questions are now generated with:
1. Project-level context (topic graph, past tensions, action items)
2. Member-level context (profile, expertise tags, communication style)
3. Round-level context (ambient signals, recent insights)

This means the same topic produces *different questions for different people*, calibrated to what each member has previously contributed, what's been flagged as a tension for them specifically, and what their communication style is.

### 4.4 After Reports: Decision Logging

When a synthesis report is posted in the group, the bot also stores a structured decision record:

```
Decision:
  project_id, round_id, created_at
  decision_text: string      — "The team agreed to implement a monthly rotation system for studio allocation"
  confidence: high | medium | low  — from convergence_tier
  agreed_by: number          — response_count / member_count
  action_items[]            — from the report
  status: pending | in_progress | completed | abandoned
```

**Why this matters:** The team can ask "what decisions have we made about studio allocation?" and get a clean answer instead of scrolling through old reports.

---

## 5. Non-Intrusive Design Principles

The entire system is governed by a "silent observer" rule:

### 5.1 What the Bot NEVER Does

- **Never sends unsolicited 1v1 messages between rounds.** The user initiates.
- **Never references past rounds in casual conversation unless explicitly asked.** "What did we decide in round 3?" gets an answer. "Remember when you disagreed with Laura?" never happens.
- **Never shares that it's tracking someone.** Member profiles are internal, not announced. Users never know the bot is tracking their communication style.
- **Never surfaces a specific person's insight without their consent.** Async insights are anonymized before going into question prompts.
- **Never comments on engagement decline publicly.** If a member's engagement is dropping, the bot notes it for admin alert (optional), never in group.

### 5.2 What the Bot ONLY Does in Group

- Posts the official synthesis report (structured, not conversational)
- Responds to explicit mentions or questions directed at it
- Posts decision reminders when action items are due (admin-triggered or cron-triggered, not reactive to group chat)
- Reacts to explicit `/report` or `/status` commands from admins

### 5.3 What the Bot Does in 1v1

- Responds to user messages in free chat mode
- Answers "what's the current status?" type questions
- Asks onboarding questions during initiation
- Sends round questions when a round is active
- Sends round reminder if deadline is approaching (one reminder, 24h before deadline)

---

## 6. What the Team Experiences Over Time

### Month 1 (Early Stage)

The bot asks questions. The team responds. Reports get posted. Nothing feels "smart" yet — it's just structured.

But: the bot is capturing everything.

### Month 2 (Building Context)

Round N questions reference something from Round N-1: "Last time we discussed studio allocation, the main concern was公平性. Have things changed?" The team notices. "Wait, it remembered?" This is the first moment of perceived intelligence.

### Month 3 (Pattern Recognition)

The bot surfaces a tension: "This is the 3rd round where scheduling conflicts come up. The team reached operational alignment last time but it came back. Should we try a different approach this round?" Admin decides whether to act.

### Month 4+ (Institutional Memory)

New members onboard faster — the bot can say "here's what the team has decided so far" based on the decision log. Veteran members stop having to re-explain context to newcomers. The team moves faster because there's a shared reference point.

---

## 7. Implementation Priorities

### Phase 1 — Core Memory (this sprint)
- [ ] `async_insights` table in PostgreSQL
- [ ] Store insights from free chat (1v1) with embedding
- [ ] Store ambient signals from group buffer with embedding  
- [ ] Round transition context compression (1 Flash LLM call)
- [ ] Inject context into question generation prompt

### Phase 2 — Topic Graph (next sprint)
- [ ] `topic_nodes` and `topic_edges` tables
- [ ] Auto-extract topics from completed rounds
- [ ] Link recurring tensions across rounds
- [ ] Surface "emerging topics" from group chat keywords

### Phase 3 — Member Profiles (later)
- [ ] Passive profile learning from response behavior
- [ ] Communication style inference from message patterns
- [ ] Engagement trend tracking with decay
- [ ] Question personalization based on profile

### Phase 4 — Decision Log & Institutional Memory (later)
- [ ] Structured decision records from each report
- [ ] Queryable decision history: "what have we decided about X?"
- [ ] Decision status tracking (pending → completed)
- [ ] Admin dashboard for project knowledge visualization

---

## 8. Telegram Constraints We Work Within

From the Telegram Bot API Reference:

1. **Bot cannot initiate 1v1 chat.** Messages are only sent in response to user interaction or via `sendMessage` to an existing conversation thread. This means the "silent observer" between rounds is enforced by Telegram — the bot literally cannot send a check-in message unless the user messaged first.

2. **4,096 character limit per message.** Project context summaries must be compact. The "Round Context Brief" is ~500 words, which fits in 1-2 messages max.

3. **20 messages/minute to a single group.** Rate limiting means context-building cannot involve sending group messages frequently. The ambient buffer is stored silently, retrieved only at round start.

4. **No persistent context window between webhook calls.** Each incoming message is processed independently. All context must be stored in PostgreSQL/Redis and retrieved on demand — nothing lives in memory between requests.

5. **Privacy mode defaults to bot-only messages.** The group observation mode requires the admin to add the bot as a full member with privacy mode disabled. This is an explicit setup step — we cannot silently observe without consent.

---

## 9. Key Design Decisions

### Decision 1: pgvector Embeddings vs. Keyword Storage

We use pgvector for semantic retrieval (tensions, topics, insights) because:
- It's already in the stack (from deep research)
- RAG queries ("what tensions came up around scheduling?") require semantic matching
- Keyword matching alone misses synonyms and contextual similarity

Lightweight keyword matching gates expensive embedding storage — only messages matching known topic keywords get embedded.

### Decision 2: No LLM Call on Group Messages

The existing 50-message buffer heuristic (from group_interaction.md) is correct. We extend it:
- Keyword-matched messages → embed and store (no LLM)
- Heuristic-conflict detected → enqueue background analysis job (separate from webhook, off the critical path)

### Decision 3: Context Compression is One LLM Call at Round Transition

Instead of injecting raw memories into every question generation call, we compress at round boundaries. This keeps question generation prompt bounded and avoids repeated context.

### Decision 4: Member Profiles Are Behavioral, Not Self-Reported

The profile system infers communication style, expertise, and engagement from what members actually write — not from onboarding questions. This is both more accurate and less intrusive.

---

## 10. What Gets Built and When

### Immediate (this sprint — Phase 1)

1. `async_insights` table: `id, project_id, member_id, content, content_embedding, source, surfaced_in_round, include_in_next_round, created_at, expires_at`

2. Store free-chat insights during `handleFreeChatMessage`:
   - Classify message type (LLM or heuristic? Heuristic for now — keyword match on content length + presence of insight signal words like "I think", "I feel", "I've been")
   - Store if substantive, embed, set `include_in_next_round=false`

3. Round transition compression job:
   - Triggered when `round.status` transitions to `complete`
   - Pull last 3 round summaries from `reports` table (already stored)
   - Pull unsurfaced insights from `async_insights` where `surfaced_in_round IS NULL`
   - Flash LLM call: compress into 500-word brief
   - Store in Redis: `project_context:{projectId}` with TTL = 30 days

4. Question generation injects context:
   - At prompt construction time, load `project_context:{projectId}` from Redis
   - Add as "Project Context" section in system prompt (first 500 tokens)

### Next Sprint — Phase 2

5. Topic graph tables: `topic_nodes`, `topic_edges`
6. Auto-extract topics from completed rounds (LLM call as part of synthesis pipeline)
7. Link tensions across rounds by topic similarity
8. Keyword-extract "emerging topics" from group buffer before each round

### Later — Phase 3/4

9. Member profile passive learning (ongoing, incremental)
10. Decision log and queryable history
11. Admin dashboard for knowledge visualization

---

## Summary

Zolara builds project memory through **four silent layers**:

1. **Round Memory** — each round's outcomes stored as structured records
2. **Topic Graph** — tensions and themes tracked across rounds as a graph  
3. **Member Profiles** — behavioral inference from 1v1 and group interactions
4. **Ambient Signals** — keyword-captured insights from group chat without LLM cost

The mechanism is **non-intrusive by design**:
- No unsolicited messages between rounds
- No announcement of what's being tracked
- Context is compressed and retrieved, not streamed continuously
- All memory serves question generation, not conversational show-off

The team gradually experiences Zolara as "getting smarter" — but what they're actually experiencing is **accumulated context that was always there, now being used**.