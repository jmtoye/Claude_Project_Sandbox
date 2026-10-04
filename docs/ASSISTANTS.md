# Assistant integration

Changes can be made in the dashboard, by natural language in the dashboard (**Ask**), or by an assistant over an authenticated interface. Every path runs the same operations (`src/server/ops.ts`) with **the requesting person's own permissions**. View-only users get no write tools, and a `read` token can never write.

## What is supported, honestly

| Assistant / channel | Status |
|---|---|
| **Ask box in the dashboard** | Works. A built-in rule interpreter handles the common phrasings with no AI key; Claude handles the rest when `ANTHROPIC_API_KEY` is set. It always previews, and nothing changes until you press Confirm. |
| **MCP endpoint `/mcp`** (Streamable HTTP, bearer token) | Implemented and tested with the official MCP TypeScript client and with curl inside the Cloudflare runtime. Should work with **Claude Code** (CLI/desktop), which supports remote HTTP MCP servers with custom headers. Not yet tried against a deployed instance, because none exists yet. |
| **REST API** | Works. `POST /api/ops`, `POST /api/assistant/command` and `/apply`, plus the read endpoints. |
| claude.ai / Claude Desktop "custom connectors" | **Not supported yet.** They require OAuth or unauthenticated MCP servers; this server uses bearer tokens. It would need an OAuth layer. |
| **ChatGPT (including this ChatGPT conversation)** | **Not integrated.** No connection to ChatGPT exists. ChatGPT connectors also need OAuth. ChatGPT Pages cannot be read by the app. |

## Create a token
**Settings → Assistant access tokens → Create token.** Choose *Read only*, or *Read & write* (which still carries your permissions). Copy the `pd_…` value; it's shown once. Revoke it from the same place.

## Claude Code (MCP)
If Access protects the whole hostname (recommended), create an Access **service token** and add a "Service Auth" policy for it (docs/SETUP.md, step 3). Then:
```bash
claude mcp add --transport http project-dashboard https://<host>/mcp \
  --header "Authorization: Bearer pd_xxx" \
  --header "CF-Access-Client-Id: <service token id>" \
  --header "CF-Access-Client-Secret: <service token secret>"
```
Then ask Claude Code, for example: "Using project-dashboard, mark the 'Pilot launched' milestone complete with evidence 'pilot live since 12 Oct' and change the target for the next milestone to 15 October."

Tools available:
- **Read:** `list_projects`, `get_project`, `search_projects`, `get_daily_summary`, `interpret_command` (preview only).
- **Refresh:** `refresh_sources` (needs edit access).
- **Write**, one tool per operation, offered only if you can use it:
  - projects: `create_project`, `update_project`, `set_pinned`, `set_lifecycle`, `set_only_me`, `delete_project`;
  - milestones: `add_milestone`, `update_milestone`, `complete_milestone`, `delete_milestone`, `confirm_milestones`, `set_target_date`;
  - next steps: `add_next_step`, `update_next_step`, `delete_next_step`;
  - blockers, risks and tips: `flag_blocked`, `add_issue`, `update_issue`, `delete_issue`;
  - sources and dependencies: `add_source`, `remove_source`, `add_dependency`, `remove_dependency`;
  - review: `release_override`, `resolve_suggestion`.

## REST examples
```bash
H='-H "Authorization: Bearer pd_xxx" -H "CF-Access-Client-Id: …" -H "CF-Access-Client-Secret: …"'
# Interpret, then apply (two steps, like the Ask box)
curl -X POST https://<host>/api/assistant/command $H -H 'content-type: application/json' \
  -d '{"text":"Flag this as blocked while we wait for the supplier","project_id":"p_…"}'
curl -X POST https://<host>/api/assistant/apply $H -H 'content-type: application/json' \
  -d '{"operations":[{"op":"flag_blocked","args":{"project_id":"p_…","reason":"Waiting for the supplier"}}]}'
# Or call an operation directly
curl -X POST https://<host>/api/ops $H -H 'content-type: application/json' \
  -d '{"op":"set_target_date","args":{"project_id":"p_…","date":"2026-10-15","kind":"target"}}'
```

## Natural-language examples (built-in rules, no AI key needed)
- "Add project Kitchen refit to Work"
- "Mark this milestone complete" / "Mark the pilot launched milestone complete"
- "Flag this as blocked while we wait for the supplier"
- "Pin this project" / "Unpin this" / "Pause <name>" / "Archive <name>" / "Reopen <name>"
- "Change the target to 15 October" / "Set the deadline for Go live to 30 Nov because the client agreed"
- "Make this project visible only to me"

"This project" means the one open in the dashboard (or the `project_id` you pass). Ambiguous requests get a clarifying question instead of a guess. Manual and assistant changes become overrides that automatic updates respect.
