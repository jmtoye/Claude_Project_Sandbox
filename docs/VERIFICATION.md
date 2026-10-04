# Verification and status

Run everything with `npm run check` (typecheck, 74 unit/integration tests, 6 browser tests). Test data is **synthetic** and lives only in in-memory or `.local/` databases.

## Requested checks

| Requirement | How it was verified | Result |
|---|---|---|
| Personal/Work separation | `tests/access.test.ts`: Renata sees only Personal; Work invitees get 404 for Personal dashboards, projects, search and maps; Personal grants are refused for non-allow-listed emails; dependencies cannot cross spaces. Re-checked against the real Worker in `wrangler dev` (workerd + local D1). | ✅ |
| "Only me" inaccessible to everyone else | Same file. Every endpoint is checked: dashboard, archive, counts, map, search, detail, direct operations (404), summary, MCP tools, the natural-language interpreter's context, and the change-detection etag. Responses are scanned for the hidden names. A mutation test (removing the `only_me` filter) makes 6 tests fail, so the tests do catch leaks. | ✅ |
| View-only users cannot edit | Every write path is rejected for viewers: REST operations, refresh, natural-language apply, MCP write tools (not even listed), and write-scope tokens. Editors can't use owner-only controls. Also checked in workerd (403). | ✅ |
| Cross-device persistence | `tests/assistant.test.ts`: a write through one app instance and DB connection is read by a fresh instance on the same store; stale writes get 409. In production all devices share one D1 database, exercised in workerd. | ✅ (deployed D1 not yet exercised) |
| Hourly updates and manual refresh | `tests/updater.test.ts`: the cron run is idempotent per hour, "checked, no changes" makes no LLM call, editors can Refresh now and viewers can't, a lock blocks concurrent runs. In workerd, the scheduled handler (`/__scheduled`) ran the refresh and the summaries. | ✅ (Cloudflare's scheduler itself runs only after deploy) |
| Manual overrides survive automatic updates | Status, summary and milestone overrides are kept and an override-conflict suggestion is recorded; releasing the override lets the next update apply. A manual edit *during* the LLM call is preserved by the version guard. | ✅ |
| Progress calculations and overdue handling | `tests/domain.test.ts`: weights, checklist fractions, unassessed/provisional rules, no credit without evidence, effective dates, overdue deadlines urgent vs missed targets as warnings, moving a deadline needs a logged reason, ordering. | ✅ |
| Grounded updates | Hallucinated quotes are rejected, deadlines found in sources become suggestions, uncited blockers become risks, source failure keeps the last known state (logged once), the no-LLM path infers nothing, and LLM failure retries next hour. | ✅ (fake LLM; see below) |
| Daily summary at 07:00 Hong Kong | `tests/summary.test.ts`: nothing at 06:59:59 HKT, generated at 07:00, no duplicates, late catch-up at 09:05, per-user visibility (owner includes Only me; others don't), honest delivery states, Resend payload + idempotency key, retries. | ✅ |
| Projector layout with 20 tiles | `e2e/dashboard.spec.ts` (Chromium): at 3840×2160, 20 Work tiles in a 5×4 grid of about 734×484 px, no scroll, no clipped text, names about 39 px and body text about 26 px, no editing controls. Also passes at 1920×1080 CSS px (200% scaling). Phone (390 px) is a single column with no horizontal overflow. | ✅ — see `docs/screenshots/` |
| Natural-language commands | All six example requests parse correctly with the rule interpreter; previews change nothing until confirmed; owner-only tools are withheld from editors; ambiguous requests get a clarifying question. | ✅ |
| MCP | The official MCP TypeScript client connects, lists tools, reads and writes; actions are attributed "(via MCP)"; invalid tokens get 401. Also checked with curl in workerd. | ✅ (not yet with a live Claude Code session) |
| Initial project | `tests/initial-project.test.ts`: imports with no percentage, deadline or approval; the ChatGPT link stays reference-only and is never fetched; once the plan is confirmed, progress follows the recorded evidence and weights. | ✅ |

## Independent review

A separate review pass audited access control and the updater. Every finding was fixed, and each has a regression test in `tests/review-regressions.test.ts`:

| Severity | Finding | Fix |
|---|---|---|
| High | Editors could attach GitHub/Notion sources and have them read with the owner's credentials | Owner-only |
| Medium | "Only me" names could reach the model while processing other projects | Removed from the model's context |
| Medium | Status could change without evidence | Grounded quote required |
| Medium | Weak quote matching (including the app's own snapshot header) | Stricter matching, and state changes must quote new text |
| Medium | One project's error could abort the whole run | Per-project isolation, rebuilt retries, lock renewal |
| Lower | Cycle check revealed hidden projects; a stale deadline suggestion could override a newer deadline; read tokens could revoke tokens; the summary job marked everyone as "seen"; import validation and dependency restore; malformed-cookie 500s; non-http links; dev login on by default | All fixed |

Two of the fixes were mutation-tested (reverted, confirmed the tests fail, restored).

## What is functional vs not yet

**Working now (in code, verified locally and in the Cloudflare runtime):**
- the dashboard (tiles, detail, editing, overrides, archive/reopen, map, summary, settings, search, projector mode);
- access control and tokens;
- the hourly pipeline and the daily summary;
- the rule-based natural-language commands, MCP and REST;
- import/export.

**Implemented, but not verified against the live third-party service:**
- **Claude API calls** (`updater/llm.ts`). The request shape type-checks against the official SDK; tests use a fake model. Nothing was sent to Anthropic, because no key was available.
- **Resend email.** The HTTP call is mocked in tests.
- **Notion and private GitHub sources.** Mocked in tests.
- **Cloudflare Access login and the production Cron Trigger.** They need your deployment; the same JWT checks are covered with locally signed tokens.

**Not available (honest disconnected states shown in the app):**
- Reading ChatGPT Spaces/Pages (links are reference-only; paste dated snapshots).
- Google Docs and Microsoft 365 sources.
- claude.ai / ChatGPT custom connectors (these need OAuth).
- Push into ChatGPT.

**Demonstration/test-only (never part of the live dashboard):**
- the synthetic projects (`scripts/synthetic.ts`);
- the local sign-in page (`/__dev/login`, which exists only in `dev/node-server.ts`, never in the Worker);
- the local signing-key server (`scripts/local-access.ts`).

## Known limitations
- On the Workers **Free** plan, an invocation gets 10 ms CPU. A refresh that processes large source documents could exceed it. Failed runs are visible in Settings; Workers Paid ($5/month) removes the issue.
- Each hourly run checks up to `REFRESH_SOURCE_BUDGET` sources (default 40); the rest are deferred to the next run, oldest first.
- Pasted snapshots don't change by themselves. Paste a new snapshot, or connect a readable source, to get automatic updates.
