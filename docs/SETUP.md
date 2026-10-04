# Setup and deployment (Cloudflare)

Everything below runs from **your computer**. The build environment used to create this app could not reach Cloudflare, so it hasn't been deployed yet. Expect about 30–45 minutes the first time.

## Costs

| Service | Plan | Cost | Notes |
|---|---|---|---|
| Cloudflare Workers + Cron | Free | $0 | 100k requests/day, **10 ms CPU per invocation**. Workers Paid is **$5/month** (30 s CPU). Upgrade if Settings → Recent source checks shows failed runs or you see error 1102. |
| Cloudflare D1 | Free | $0 | 5 GB, 5M row reads/day. Far more than 20 projects need. |
| Cloudflare Access (Zero Trust) | Free | $0 | Up to 50 users. Cloudflare may ask for a payment card when activating the free plan; it isn't charged. |
| Claude API (optional) | Pay as you go | ~$1–10/month | Called **only when a source actually changes**: ~$0.05–0.20 per change on `claude-opus-5-5` ($4/$20 per million tokens), about half on `claude-sonnet-5-5`. Hourly checks without changes cost nothing. |
| Resend (optional) | Free | $0 | 3,000 emails/month, 100/day. Needs DNS records on your sending domain. |

Live screens poll every 30 s, about 2,900 requests/day per open screen, which is well inside the free tier.

## 1. Prerequisites
- Node.js 22.5+ and git. Clone this repository, keep it **private**, and run `npm install`.
- A Cloudflare account (free).

## 2. Create the database and deploy
```bash
npm run setup:cloudflare     # wrangler login, D1 create, migrations, build, deploy
```
This prints your Worker URL (e.g. `https://project-dashboard.<you>.workers.dev`). Until Access is configured (step 3), every request returns **503 "Setup required"**: the app fails closed.

Optional: to use a custom hostname such as `projects.yourdomain.com` (the domain must be on Cloudflare DNS), add it under Workers → project-dashboard → Settings → Domains & Routes.

## 3. Protect it with Cloudflare Access
1. In the Cloudflare dashboard, go to **Zero Trust**. Choose a team name, e.g. `jtoye`; your team domain is `jtoye.cloudflareaccess.com`. Pick the Free plan.
2. **Settings → Authentication → Login methods**: keep **One-time PIN** (emailed code). Optionally add Google.
3. **Access → Applications → Add → Self-hosted**:
   - **Domain**: your Worker hostname (the workers.dev hostname or your custom domain). For workers.dev you can instead use Worker → Settings → Domains & Routes → workers.dev → **Enable Cloudflare Access**.
   - **Session duration**: e.g. 1 month. Longer sessions mean fewer logins on the projector machine.
   - **Policy "People"** (Action **Allow**). Include → Emails:
     - your email;
     - Renata's email;
     - each invited colleague, or an "Emails ending in @yourcompany.com" rule.
   - **Policy "Assistant"** (Action **Service Auth**, optional, for MCP/REST from Claude Code). Include → Service Token. Create one first under Access → Service credentials → Service Tokens.
4. Open the application's **Overview** tab and copy the **Application Audience (AUD) Tag**.
5. Edit `wrangler.toml` `[vars]`:
   ```toml
   OWNER_EMAIL = "you@yourdomain.com"                # the address you sign in with
   PERSONAL_ALLOWED_EMAILS = "renata@example.com"    # Renata's sign-in address
   ACCESS_TEAM_DOMAIN = "jtoye.cloudflareaccess.com"
   ACCESS_AUD = "<the AUD tag>"
   APP_URL = "https://project-dashboard.<you>.workers.dev"
   ```
6. Run `npm run deploy`.

Access stops strangers at the edge. The app then checks the signed identity itself, and only people you **invite in the app** see anything.

## 4. First sign-in and the initial project
1. Open the URL and sign in with your email code. The first sign-in with `OWNER_EMAIL` creates the owner account.
2. Go to **Settings → Import / export → Import JSON…** and choose `data/initial-projects.json`. This adds the initial Work project, built from its dated snapshot.
3. Open the project and review the **proposed milestones** (weights default to 1). Then **Confirm proposed milestones**. Until you do, progress shows as *Unassessed*, because nothing is inferred.

## 5. Invite people
In **Settings → People & access**, invite Renata with Personal set to **View only** (or **Can edit**). Invite colleagues with Work set to View only, and grant edit separately when needed. Each person also has to pass the Access policy from step 3. Revoking access in the app takes effect immediately.

## 6. Optional integrations (secrets are never in the repo or the browser)
```bash
npx wrangler secret put ANTHROPIC_API_KEY   # AI summaries of source changes + NL fallback
npx wrangler secret put RESEND_API_KEY      # daily summary emails
npx wrangler secret put GITHUB_TOKEN        # read-only token for private GitHub source files
npx wrangler secret put NOTION_TOKEN        # Notion internal integration; share each page with it
```
- **AI model**: `ANTHROPIC_MODEL` in `[vars]` (default `claude-opus-5-5`). The server-side refusal fallback (`fallbacks: "default"`) is enabled for current models.
- **Email (Resend)**:
  1. Add and verify your sending domain in Resend; it gives you DNS records to create.
  2. Set `SUMMARY_FROM_EMAIL = "Projects <summary@yourdomain.com>"` in `[vars]` and redeploy.
  3. Each person opts in on the Summary page (the owner is opted in by default).

## 7. Projector
On the computer connected to the projector:
1. Open `https://<host>/?space=work&projector=1`, or click **Projector**. It hides all editing controls, enters full screen and fits every tile on one screen.
2. Bookmark it. Use a long Access session (step 3).
3. Leave the screen on. It refreshes itself every 30 s when data changes.

Press Esc to exit. To switch between Personal and Work, use the tabs; they never alternate on their own.

## 8. Check it is running
**Settings → Integrations & schedule** shows:
- the last scheduled run;
- recent source checks;
- which integrations are connected.

`npx wrangler tail` streams logs, including each hourly `scheduled {…}` result.

## Local development
```bash
SEED=synthetic npm run dev     # http://localhost:8787/__dev/login — 20+ SYNTHETIC test projects in .local/
npm run check                  # typecheck + 74 tests + browser tests (4K projector layout)
```
Synthetic data only ever goes into the local `.local/` database, never into the deployed dashboard.
