// Model Context Protocol endpoint (Streamable HTTP transport, JSON responses).
// Lets MCP-capable assistants (verified: Claude Code via `claude mcp add --transport http`)
// read and change the dashboard with the token holder's permissions.
import { z } from 'zod';
import type { Principal } from '../auth/principal';
import { visibleSpaces } from '../auth/principal';
import type { Deps } from '../config';
import { OPS, executeOp, type OpName } from '../ops';
import { getBundle, loadBundles, toDetail, toTile } from '../repo';
import { compareTiles } from '../domain/attention';
import { getSummary } from '../summary';
import { runRefresh } from '../updater/refresh';
import { hkDate } from '../time';
import { HttpError } from '../util';
import { interpretCommand, permittedOps } from './nl';
import { searchProjects } from '../search';
import { canEdit } from '../auth/principal';

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];

interface ReadTool {
  description: string;
  schema: z.ZodType;
  run: (deps: Deps, p: Principal, args: any) => Promise<unknown>;
}

const READ_TOOLS: Record<string, ReadTool> = {
  list_projects: {
    description: 'List tracked projects you can see (ordered as on the dashboard). Optionally filter by space and include archived/completed projects.',
    schema: z.object({ space: z.enum(['personal', 'work']).optional(), include_archive: z.boolean().optional() }),
    async run(deps, p, a) {
      const today = hkDate(deps.now());
      const bundles = await loadBundles(deps.db, p, { space: a.space, lifecycles: a.include_archive ? undefined : ['active', 'paused'] });
      return bundles
        .map((b) => toTile(b, p, today, deps.now()))
        .sort(compareTiles)
        .map((t) => ({
          id: t.id,
          space: t.space,
          name: t.name,
          lifecycle: t.lifecycle,
          status: t.status,
          status_summary: t.status_summary,
          progress: t.progress.percent === null ? `unassessed (${t.progress.reasons.join(' ')})` : `${t.progress.percent}% (${t.progress.assessment})`,
          next_action: t.next_action?.title ?? null,
          next_milestone: t.next_milestone ? { title: t.next_milestone.title, date: t.next_milestone.date } : null,
          blocker: t.blocker?.title ?? null,
          flags: t.flags.map((f) => f.label),
          pinned: t.pinned,
        }));
    },
  },
  get_project: {
    description: 'Full details of one project: status, milestones with evidence, next steps, blockers/risks/tips, sources, dependencies, overrides and recent history.',
    schema: z.object({ project_id: z.string() }),
    async run(deps, p, a) {
      const b = await getBundle(deps.db, p, a.project_id);
      if (!b) throw new HttpError(404, 'Not found');
      const d = await toDetail(deps.db, p, b, hkDate(deps.now()), deps.now());
      return { ...d, history: d.history.slice(0, 20) };
    },
  },
  search_projects: {
    description: 'Search projects you can see by name, status, milestones, next steps and blockers.',
    schema: z.object({ query: z.string().min(1) }),
    run: (deps, p, a) => searchProjects(deps, p, a.query),
  },
  get_daily_summary: {
    description: 'Your daily summary (overdue items, priorities, upcoming milestones, changes, decisions needed). Defaults to today (Asia/Hong_Kong).',
    schema: z.object({ date: z.string().optional() }),
    run: (deps, p, a) => getSummary(deps, p, a.date),
  },
  interpret_command: {
    description: 'Preview how the dashboard would interpret a natural-language request (does not change anything). Apply by calling the returned operations as tools.',
    schema: z.object({ text: z.string().min(1), project_id: z.string().optional() }),
    run: (deps, p, a) => interpretCommand(deps, p, a.text, a.project_id),
  },
  refresh_sources: {
    description: 'Check the tracked sources now (all projects, or one) and apply grounded updates. Requires edit access.',
    schema: z.object({ project_id: z.string().optional() }),
    async run(deps, p, a) {
      if (!(canEdit(p, 'personal') || canEdit(p, 'work'))) throw new HttpError(403, 'View-only access cannot trigger refreshes.');
      let ids: string[] | undefined;
      if (a.project_id) {
        const b = await getBundle(deps.db, p, a.project_id);
        if (!b) throw new HttpError(404, 'Not found');
        if (!canEdit(p, b.project.space)) throw new HttpError(403, 'View-only access cannot trigger refreshes.');
        ids = [b.project.id];
      } else if (!p.isOwner) {
        ids = (await loadBundles(deps.db, p, { lifecycles: ['active', 'paused'] })).filter((b) => canEdit(p, b.project.space)).map((b) => b.project.id);
      }
      return runRefresh(deps, { trigger: 'api', idemKey: `api:${p.userId}:${a.project_id ?? 'all'}:${deps.now().toISOString().slice(0, 16)}`, requestedBy: p.userId, projectIds: ids });
    },
  },
};

function jsonSchema(s: z.ZodType) {
  const js = z.toJSONSchema(s, { target: 'draft-2020-12', io: 'input' }) as Record<string, unknown>;
  delete js.$schema;
  return js;
}

function listTools(p: Principal) {
  const mayRefresh = canEdit(p, 'personal') || canEdit(p, 'work');
  const tools = Object.entries(READ_TOOLS)
    .filter(([name]) => name !== 'refresh_sources' || mayRefresh)
    .map(([name, t]) => ({ name, description: t.description, inputSchema: jsonSchema(t.schema), annotations: { readOnlyHint: name !== 'refresh_sources' } }));
  for (const name of permittedOps(p)) tools.push({ name, description: OPS[name].summary, inputSchema: jsonSchema(OPS[name].schema), annotations: { readOnlyHint: false } });
  return tools;
}

interface RpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, any>;
}

async function handleOne(deps: Deps, p: Principal, req: RpcRequest): Promise<Record<string, unknown> | null> {
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id: req.id ?? null, result });
  const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id: req.id ?? null, error: { code, message } });
  if (req.id === undefined) return null; // notification (e.g. notifications/initialized)
  switch (req.method) {
    case 'initialize': {
      const asked = String(req.params?.protocolVersion ?? '');
      return ok({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[1],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'project-dashboard', version: '1.0.0' },
        instructions:
          `Project dashboard for ${p.name}. Spaces visible: ${visibleSpaces(p).join(', ') || 'none'}. Use list_projects to find project ids. ` +
          'Changes are recorded with you as the actor; view-only users have no write tools. Manual edits create overrides that automatic updates respect.',
      });
    }
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: listTools(p) });
    case 'tools/call': {
      const name = String(req.params?.name ?? '');
      const args = req.params?.arguments ?? {};
      try {
        let result: unknown;
        if (READ_TOOLS[name]) {
          const parsed = READ_TOOLS[name].schema.safeParse(args);
          if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => i.message).join('; '));
          result = await READ_TOOLS[name].run(deps, p, parsed.data);
        } else if (name in OPS) {
          if (!permittedOps(p).includes(name as OpName)) throw new HttpError(403, 'You do not have permission to do that.');
          result = await executeOp({ deps, principal: p, actor: { type: 'assistant', label: `${p.name} (via MCP)` } }, name, args);
        } else return fail(-32602, `Unknown tool: ${name}`);
        return ok({ content: [{ type: 'text', text: JSON.stringify(result, null, 1) }], isError: false });
      } catch (err) {
        const msg = err instanceof HttpError ? err.message : `Error: ${(err as Error).message}`;
        return ok({ content: [{ type: 'text', text: msg }], isError: true });
      }
    }
    default:
      return fail(-32601, `Method not found: ${req.method}`);
  }
}

export async function handleMcp(deps: Deps, p: Principal, request: Request): Promise<Response> {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { allow: 'POST' } });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, { status: 400 });
  }
  const batch = Array.isArray(body) ? body : [body];
  const results = (await Promise.all(batch.map((r) => handleOne(deps, p, r as RpcRequest)))).filter(Boolean);
  if (!results.length) return new Response(null, { status: 202 });
  return Response.json(Array.isArray(body) ? results : results[0]);
}
