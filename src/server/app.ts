// HTTP routes. Runs unchanged on Cloudflare Workers (worker.ts) and Node (dev/node-server.ts).
import { Hono, type Context } from 'hono';
import { ZodError } from 'zod';
import type { DashboardResponse, MapResponse, Space, SystemHealth } from '../shared/types';
import { authenticate, canEdit, canView, projectScope, visibleSpaces, type Principal } from './auth/principal';
import { emailConfigured, type Deps } from './config';
import { compareTiles } from './domain/attention';
import { PROGRESS_EXPLANATION } from './domain/progress';
import { executeOp } from './ops';
import { getBundle, loadBundles, toDetail, toTile } from './repo';
import { searchProjects } from './search';
import { getSummary } from './summary';
import { hkDate } from './time';
import { latestRun, runRefresh } from './updater/refresh';
import { HttpError, badRequest, forbidden, notFound, sha256Hex } from './util';
import * as admin from './admin';
import { applyCommand, interpretCommand } from './assistant/nl';
import { handleMcp } from './assistant/mcp';

type Env = { Variables: { principal: Principal; deps: Deps } };

export interface AppOptions {
  /** Serves the built UI (Cloudflare ASSETS binding or a static file handler). */
  assets?: (req: Request, c: Context) => Promise<Response>;
}

const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};

function page(title: string, body: string, status: number): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<body style="background:#16181d;color:#e5e7eb;font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0">
<main style="max-width:520px;padding:24px"><h1 style="font-size:22px;color:#fff">${title}</h1><p>${body}</p></main></body>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
  );
}

async function etagFor(deps: Deps, p: Principal, space: Space): Promise<string> {
  const scope = projectScope(p, 'p');
  const r = await deps.db.first<{ n: number; v: number; u: string | null; c: string | null }>(
    `SELECT COUNT(*) AS n, COALESCE(SUM(p.version), 0) AS v, MAX(p.updated_at) AS u, MAX(p.last_checked_at) AS c FROM projects p WHERE ${scope.sql} AND p.space = ?`,
    [...scope.params, space],
  );
  return (await sha256Hex(`${p.userId}|${space}|${r?.n}|${r?.v}|${r?.u}|${r?.c}|${hkDate(deps.now())}`)).slice(0, 20);
}

async function health(deps: Deps, p: Principal): Promise<SystemHealth> {
  const run = await latestRun(deps);
  const cron = await deps.db.first<{ value: string }>("SELECT value FROM app_meta WHERE key = 'last_cron_at'");
  return {
    last_run: run ? { at: run.finished_at ?? run.started_at, status: run.status, trigger: run.trigger } : null,
    last_cron_at: cron?.value ?? null,
    llm_configured: Boolean(deps.llm),
    email_configured: p.isOwner ? emailConfigured(deps.config) : false,
  };
}

function spaceParam(c: Context<Env>): Space {
  const s = c.req.query('space');
  if (s !== 'personal' && s !== 'work') throw badRequest('space must be personal or work');
  // A space the user cannot see is reported as not found, revealing nothing about it.
  if (!canView(c.get('principal'), s)) throw notFound();
  return s;
}

export function createApp(getDeps: (c: Context) => Deps, opts: AppOptions = {}) {
  const app = new Hono<Env>();

  app.onError((err, c) => {
    const api = c.req.path.startsWith('/api/') || c.req.path === '/mcp';
    if (err instanceof HttpError) {
      if (!api) {
        if (err.code === 'auth_not_configured') return page('Setup required', 'Sign-in (Cloudflare Access) is not configured for this deployment yet. See docs/SETUP.md.', 503);
        if (err.code === 'not_invited') return page('No access', `${err.message} Ask the dashboard owner for an invitation.`, 403);
        if (err.status === 401) return page('Sign in required', 'This dashboard is private. <a style="color:#7fb0ff" href="/">Reload</a> to sign in.', 401);
        return page('Not found', 'Nothing here.', err.status);
      }
      return c.json({ error: err.code, message: err.message }, err.status as 400);
    }
    if (err instanceof ZodError) return c.json({ error: 'bad_request', message: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }, 400);
    console.error('Unhandled error', err);
    return api ? c.json({ error: 'internal', message: 'Something went wrong.' }, 500) : page('Error', 'Something went wrong.', 500);
  });

  app.use('*', async (c, next) => {
    await next();
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) c.res.headers.set(k, v);
    if (c.req.path.startsWith('/api/') || c.req.path === '/mcp') c.res.headers.set('cache-control', 'no-store');
  });

  app.get('/api/health', (c) => c.json({ ok: true }));

  // Authentication for everything else, including the UI shell and static assets.
  app.use('*', async (c, next) => {
    const deps = getDeps(c);
    c.set('deps', deps);
    c.set('principal', await authenticate(deps, c.req.raw));
    // CSRF: browser sessions must send the custom header (cross-site forms cannot) and a same-origin Origin.
    const p = c.get('principal');
    if (p.via !== 'token' && !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      if (c.req.header('x-requested-with') !== 'dashboard') throw forbidden('Missing request header.');
      const origin = c.req.header('origin');
      if (origin && origin !== new URL(c.req.url).origin) throw forbidden('Cross-origin request refused.');
    }
    await next();
  });

  const deps = (c: Context<Env>) => c.get('deps');
  const me = (c: Context<Env>) => c.get('principal');
  const now = (c: Context<Env>) => deps(c).now();

  app.get('/api/me', (c) => {
    const p = me(c);
    return c.json({
      id: p.userId,
      email: p.email,
      name: p.name,
      is_owner: p.isOwner,
      spaces: visibleSpaces(p).map((s) => ({ space: s, can_edit: canEdit(p, s) })),
      via: p.via,
      summary_email: p.summaryEmail,
      progress_explanation: PROGRESS_EXPLANATION,
    });
  });

  app.get('/api/version', async (c) => c.json({ etag: await etagFor(deps(c), me(c), spaceParam(c)) }));

  app.get('/api/dashboard', async (c) => {
    const space = spaceParam(c);
    const d = deps(c);
    const p = me(c);
    const today = hkDate(now(c));
    const bundles = await loadBundles(d.db, p, { space, lifecycles: ['active', 'paused'] });
    const tiles = bundles.map((b) => toTile(b, p, today, now(c))).sort(compareTiles);
    const scope = projectScope(p, 'p');
    const archived = await d.db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM projects p WHERE ${scope.sql} AND p.space = ? AND p.lifecycle IN ('completed', 'archived')`, [...scope.params, space]);
    const res: DashboardResponse = {
      space,
      tiles,
      counts: { active: tiles.filter((t) => t.lifecycle === 'active').length, paused: tiles.filter((t) => t.lifecycle === 'paused').length, archive: Number(archived?.n ?? 0) },
      etag: await etagFor(d, p, space),
      generated_at: now(c).toISOString(),
      today,
      system: await health(d, p),
    };
    return c.json(res);
  });

  app.get('/api/archive', async (c) => {
    const space = spaceParam(c);
    const today = hkDate(now(c));
    const bundles = await loadBundles(deps(c).db, me(c), { space, lifecycles: ['completed', 'archived'] });
    const tiles = bundles.map((b) => toTile(b, me(c), today, now(c))).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return c.json({ space, tiles });
  });

  app.get('/api/map', async (c) => {
    const space = spaceParam(c);
    const p = me(c);
    const d = deps(c);
    const today = hkDate(now(c));
    const bundles = await loadBundles(d.db, p, { space, lifecycles: ['active', 'paused'] });
    const a = projectScope(p, 'a');
    const b = projectScope(p, 'b');
    const edges = await d.db.all<{ from: string; to: string; note: string }>(
      `SELECT d.project_id AS "from", d.depends_on_id AS "to", d.note FROM dependencies d
         JOIN projects a ON a.id = d.project_id JOIN projects b ON b.id = d.depends_on_id
        WHERE ${a.sql} AND ${b.sql} AND a.space = ? AND b.space = ? AND a.lifecycle IN ('active','paused') AND b.lifecycle IN ('active','paused')`,
      [...a.params, ...b.params, space, space],
    );
    const res: MapResponse = {
      nodes: bundles.map((x) => {
        const t = toTile(x, p, today, now(c));
        return { id: t.id, name: t.name, status: t.status, lifecycle: t.lifecycle, attention: t.attention };
      }),
      edges,
    };
    return c.json(res);
  });

  app.get('/api/search', async (c) => {
    const q = c.req.query('q') ?? '';
    const space = c.req.query('space') ? spaceParam(c) : undefined;
    return c.json({ results: await searchProjects(deps(c), me(c), q, space) });
  });

  app.get('/api/projects/:id', async (c) => {
    const b = await getBundle(deps(c).db, me(c), c.req.param('id'));
    if (!b) throw notFound();
    return c.json(await toDetail(deps(c).db, me(c), b, hkDate(now(c)), now(c)));
  });

  app.post('/api/ops', async (c) => {
    const body = await c.req.json<{ op: string; args: unknown }>();
    const p = me(c);
    const actor = p.via === 'token' ? { type: 'assistant' as const, label: `${p.name} (via API)` } : { type: 'user' as const, label: p.name };
    return c.json(await executeOp({ deps: deps(c), principal: p, actor }, body.op, body.args));
  });

  app.post('/api/refresh', async (c) => {
    const p = me(c);
    const d = deps(c);
    const body = await c.req.json<{ project_id?: string }>().catch(() => ({}) as { project_id?: string });
    let ids: string[] | undefined;
    if (body.project_id) {
      const b = await getBundle(d.db, p, body.project_id);
      if (!b) throw notFound();
      if (!canEdit(p, b.project.space)) throw forbidden('View-only access cannot trigger a source check.');
      ids = [b.project.id];
    } else {
      if (!visibleSpaces(p).some((s) => canEdit(p, s))) throw forbidden('View-only access cannot trigger a source check.');
      if (!p.isOwner) ids = (await loadBundles(d.db, p, { lifecycles: ['active', 'paused'] })).filter((b) => canEdit(p, b.project.space)).map((b) => b.project.id);
    }
    const key = c.req.header('idempotency-key') || `manual:${p.userId}:${body.project_id ?? 'all'}:${now(c).toISOString().slice(0, 16)}`;
    const result = await runRefresh(d, { trigger: p.via === 'token' ? 'api' : 'manual', idemKey: `${p.userId}:${key}`.slice(0, 200), requestedBy: p.userId, projectIds: ids });
    return c.json(p.isOwner ? result : { run_id: result.run_id, status: result.status, duplicate: result.duplicate });
  });

  app.get('/api/summary', async (c) => {
    const date = c.req.query('date');
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw badRequest('date must be YYYY-MM-DD');
    return c.json(await getSummary(deps(c), me(c), date));
  });

  app.post('/api/me/preferences', async (c) => {
    const body = await c.req.json<{ summary_email?: boolean }>();
    if (typeof body.summary_email === 'boolean') await admin.setSummaryEmail(deps(c), me(c), body.summary_email);
    return c.json({ ok: true });
  });

  app.post('/api/assistant/command', async (c) => {
    const body = await c.req.json<{ text: string; project_id?: string }>();
    if (!body.text?.trim()) throw badRequest('Say what you would like to change.');
    return c.json(await interpretCommand(deps(c), me(c), body.text.slice(0, 2000), body.project_id));
  });

  app.post('/api/assistant/apply', async (c) => {
    const body = await c.req.json<{ operations: { op: string; args: unknown }[] }>();
    if (!Array.isArray(body.operations) || !body.operations.length) throw badRequest('Nothing to apply.');
    return c.json({ applied: await applyCommand(deps(c), me(c), body.operations, me(c).via === 'token' ? 'assistant' : 'user') });
  });

  app.all('/mcp', (c) => handleMcp(deps(c), me(c), c.req.raw));

  // Tokens (each user, own tokens only)
  app.get('/api/tokens', async (c) => c.json({ tokens: await admin.listTokens(deps(c), me(c)) }));
  app.post('/api/tokens', async (c) => c.json(await admin.createToken(deps(c), me(c), await c.req.json())));
  app.delete('/api/tokens/:id', async (c) => c.json(await admin.revokeToken(deps(c), me(c), c.req.param('id'))));

  // Owner administration
  app.get('/api/admin/users', async (c) => c.json(await admin.listUsers(deps(c), me(c))));
  app.post('/api/admin/users', async (c) => c.json(await admin.inviteUser(deps(c), me(c), await c.req.json())));
  app.post('/api/admin/grants', async (c) => c.json(await admin.setGrant(deps(c), me(c), await c.req.json())));
  app.delete('/api/admin/users/:id', async (c) => c.json(await admin.revokeUser(deps(c), me(c), c.req.param('id'))));
  app.get('/api/admin/status', async (c) => c.json(await admin.integrationStatus(deps(c), me(c))));
  app.get('/api/admin/export', async (c) => c.json(await admin.exportAll(deps(c), me(c))));
  app.post('/api/admin/import', async (c) => c.json(await admin.importProjects(deps(c), me(c), await c.req.json())));

  app.all('/api/*', () => {
    throw notFound();
  });

  // UI shell and static assets — only after authentication succeeded above.
  app.get('*', async (c) => {
    if (!opts.assets) return c.text('UI not built. Run npm run build.', 404);
    return opts.assets(c.req.raw, c);
  });

  return app;
}
