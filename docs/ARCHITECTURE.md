# Architecture

## Overview

```
 Browser (laptop / phone / 4K projector)          Assistant (Claude Code via MCP, scripts via REST)
        │  Cloudflare Access login (email code)            │  Access service token + personal access token
        ▼                                                  ▼
 ┌──────────────── Cloudflare Worker (src/server/worker.ts) ────────────────┐
 │  Hono app (app.ts) — verifies the Access JWT or token on EVERY request   │
 │  ├─ auth/principal.ts   who you are, what you may see (projectScope)     │
 │  ├─ repo.ts / search.ts scoped queries (restriction applied in SQL)      │
 │  ├─ ops.ts              every change: permissions, overrides, history    │
 │  ├─ assistant/nl.ts     natural-language → previewed operations          │
 │  ├─ assistant/mcp.ts    MCP endpoint (/mcp)                              │
 │  └─ static UI (Preact, dist/client) served only after authentication     │
 │                                                                          │
 │  Cron Trigger "0 * * * *" → summary.ts runScheduled()                    │
 │  ├─ updater/refresh.ts  check sources, detect changes (SHA-256)          │
 │  │   ├─ updater/sources.ts  web / GitHub / Notion / snapshot / reference │
 │  │   ├─ updater/llm.ts      Claude proposes grounded updates             │
 │  │   └─ updater/apply.ts    verify quotes, respect overrides, write      │
 │  └─ summary.ts          07:00 Asia/Hong_Kong daily summary + Resend email│
 └──────────────────────────────┬───────────────────────────────────────────┘
                                ▼
                     Cloudflare D1 (SQLite) — the canonical store
```

The same app code also runs on Node (`dev/node-server.ts`, using `node:sqlite`). That's how the tests, local development and screenshots run. Optionally it can be self-hosted behind Cloudflare Tunnel + Access.

## Source of truth

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| Notion database | Nice editor, mobile apps, API | The server needs its own integration token. "Only me" privacy would still have to be enforced by the app. Automatic updates writing into Notion conflict with manual edits. Rate limits and schema drift. | Good **supporting source** |
| Markdown files in a repo/folder | Version history, assistant-friendly | Clumsy on a phone. Every edit is a commit. Overrides, permissions and history still need an app. A public repo leaks data. | Good **supporting source** |
| **App-managed record (D1)** | One canonical record per project, with milestones, evidence, overrides, history and permissions in one transactional store. Editable from the UI, REST, MCP and natural language. | Needs export for portability (provided: Settings → Export JSON) | **Chosen** |

Each project has **one canonical record** in D1. Supporting documents, decisions and workstreams are attached explicitly as *sources* with a role (`canonical`, `supporting`, `decision`, `workstream`). Sources never create projects. Projects are only added by the owner.

| Source kind | How it's read | Status shown |
|---|---|---|
| `web` | HTTPS GET, HTML → text | connected / error |
| `github` | GitHub contents API (`GITHUB_TOKEN` for private repos) | connected / needs setup / error |
| `notion` | Notion API (`NOTION_TOKEN`, page shared with the integration) | connected / needs setup / error |
| `snapshot` | Text you paste, with an "as of" date | snapshot as of … |
| `reference` | **Never fetched** (ChatGPT, claude.ai, Google Docs, Microsoft 365, signed-in pages) | "reference only — not connected", with the reason |

ChatGPT Spaces/Pages have no supported read API, and signed-in pages are not scraped. Their links are kept as references, and you paste dated snapshots.

## Access control

- **Authentication.** Cloudflare Access sits in front of the hostname, so nothing reaches the Worker without a login. The Worker *also* verifies the Access JWT on every request: RS256 signature against the team's published keys, plus audience, issuer and expiry checks. It fails closed (503) if Access isn't configured. Assistants use personal access tokens (`pd_…`, stored as SHA-256 hashes, revocable, `read` or `write` scope). A token never exceeds its owner's permissions.
- **Authorisation** (`auth/principal.ts`):
  - **Owner** (`OWNER_EMAIL`): everything.
  - **Grants**: per space, `view` (default) or `edit`, given separately.
  - **Personal** grants are honoured only for emails in `PERSONAL_ALLOWED_EMAILS` (you + Renata). This is checked both when granting and on every request.
  - **Editors** can edit content, pin, pause/resume, attach sources and trigger refreshes. Only the owner can add, complete, archive, reopen or delete projects, toggle **Only me**, and manage access.
- **"Only me"** is enforced by one SQL predicate, `projectScope()`: `only_me = 0 AND space IN (granted spaces)` for everyone except the owner. Every read uses it:
  - dashboards, archive, counts, maps (both ends of each edge), search, detail and direct URLs;
  - dependencies, history, suggestions, daily summaries (filtered again when read), the change-detection etag, the context given to the natural-language interpreter, and every MCP tool.

  A hidden project returns **404 exactly like a non-existent one**. History entries about restricted periods, or about hidden related projects, are filtered out.
- **CSRF**: browser writes need a custom header and a same-origin `Origin`.
- **Security headers**: strict CSP, `Referrer-Policy: no-referrer` (so project URLs aren't leaked to linked sites), `X-Frame-Options: DENY`, and `no-store` on API responses.

## Progress (milestone-based, never time-based)

```
overall % = Σ(weight × completion) ÷ Σ(weight)        over milestones you have confirmed
completion = 1 when done · ticked/total sub-steps while in progress · 0 otherwise
```

- Weights default to 1 (equal). You set them per milestone.
- **Unassessed** (no %): no milestones, or only *proposed* ones awaiting your confirmation.
- **Provisional** (hatched bar): a milestone is marked done without recorded evidence, or some proposed milestones aren't confirmed yet.
- **Current-milestone progress** comes from its sub-steps (checklist). This suits large programmes.
- Drafts, proposals and discussions are not implementation. The updater may mark a milestone done only with a verbatim quote that is found in the source text.

## Dates

Each milestone can carry three distinct dates:

| Date | Set by |
|---|---|
| **Deadline** (confirmed) | A person only. Moving an existing one requires a reason, and the move is logged (including "it was overdue"). Deadlines found in sources become *suggestions* for you to confirm. |
| **Target** (yours) | You. |
| **Suggested** | The updater, with its stated basis. It never makes anything "overdue". |

The tile shows the earliest firm date (deadline or target), otherwise the suggestion, each labelled. All calendar dates are Asia/Hong_Kong.

## Ordering

1. **Pinned** projects.
2. **Needs my action**: passed deadline (urgent), blocked, missed target, overdue step, decision needed, attention flag.
3. **Upcoming milestones**, by date.
4. Everything else.
5. Paused projects.

Completed and archived projects live in the reopenable **Archive**.

## Automatic updates

- **Hourly.** A Cron Trigger runs `0 * * * *` UTC, independent of any browser. Each run:
  - checks connected sources (within a per-run budget);
  - compares content hashes. Unchanged means "checked, no changes": no edits and no LLM call;
  - sends changed text, with its added/removed lines and the current record, to Claude using a strict JSON schema;
  - applies the proposal (`updater/apply.ts`) only where grounded:
    - quotes must appear verbatim in the fetched text;
    - fields under manual override are never changed, and a reviewable *override conflict* suggestion is recorded instead;
    - uncited "blockers" are downgraded to anticipated risks;
    - deadlines become suggestions;
    - every change goes into a history entry with citations and a list of what was not applied.
- **Safe to retry.**
  - Each run has a unique idempotency key (`cron:2026-10-04T23`). A retried trigger returns the existing run.
  - A lease lock prevents concurrent runs.
  - Per-project writes are one atomic D1 batch guarded by the project version. A concurrent manual edit forces a re-plan with the fresh overrides.
  - Source hashes only advance when the change was processed, so a failed summary is retried next hour.
- **Failures.** A source that can't be read keeps the last known state, is flagged on the tile ("source unavailable · last known state shown"), and is logged once rather than every hour.
- **No AI key.** Changes are detected and flagged "needs review", and nothing is inferred.
- **Refresh now.** The button (editors and owner) runs the same pipeline immediately.
- **Live screen updates.** Each screen polls a per-user etag every 30 s and reloads only when *its visible data* changed. The projector shows a live indicator and an HK clock.

## Daily summary

`runDailySummaries()` runs inside the hourly job. At the first run at or after **07:00 Asia/Hong_Kong** (23:00 UTC; Hong Kong has no DST) it builds one summary per user, from only the projects that user may see:

- overdue items;
- today's priorities;
- upcoming milestones (14 days);
- significant changes (24 h);
- decisions or actions needed from you.

It's stored once per user per HK date (unique key) and is idempotent. A missed 07:00 run is caught up later that day and marked late. Emails go through Resend with an idempotency key, are retried until noon, and are only sent to people who opted in. The in-app Summary page always works.

## Manual changes and overrides

Editing a status field, milestone state, checklist or an automatic next step/issue records an **override** that the updater respects until someone releases it (Release button in the detail view, or the `release_override` operation). Every operation records who did it (`user`, `assistant`, `auto`, `system`) in the project history.

## Data model (D1)

- **Core records:** `projects`, `milestones` (weight, state, evidence and basis, checklist, deadline/target/suggested dates), `next_steps`, `issues` (blocker / risk / tip, with basis and citations).
- **Sources:** `sources` and `source_content` (last processed text).
- **Relationships and protection:** `dependencies` (same space only, no cycles), `overrides`, `history`, `suggestions`.
- **Operations:** `refresh_runs` (idempotency), `daily_summaries`, `locks`.
- **People:** `users`, `grants`, `api_tokens`.

Schema: `migrations/0001_init.sql`.
