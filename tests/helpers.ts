import { join } from 'node:path';
import { createApp } from '../src/server/app';
import { systemPrincipal, type Principal } from '../src/server/auth/principal';
import { loadConfig, type Deps } from '../src/server/config';
import { SqliteDb } from '../src/server/sqlite-db';
import type { CommandInput, CommandOutput, Llm, UpdateInput, UpdateProposal } from '../src/server/updater/llm';
import { createDevSigner, DEV_AUD, DEV_TEAM, type DevSigner } from '../dev/devauth';
import { importProjects } from '../src/server/admin';

export const OWNER = 'owner@test.example';
export const RENATA = 'renata@test.example';
export const WORK_VIEWER = 'viewer@test.example';
export const WORK_EDITOR = 'editor@test.example';
export const OUTSIDER = 'nobody@test.example';

export class FakeLlm implements Llm {
  readonly model = 'fake-model';
  calls: UpdateInput[] = [];
  commandCalls: CommandInput[] = [];
  next: ((input: UpdateInput) => UpdateProposal) | null = null;
  fail: string | null = null;
  commandReply: CommandOutput = { calls: [], text: '' };
  async proposeUpdate(input: UpdateInput) {
    this.calls.push(input);
    if (this.fail) throw new Error(this.fail);
    if (!this.next) throw new Error('No fake proposal configured');
    return this.next(input);
  }
  async interpretCommand(input: CommandInput) {
    this.commandCalls.push(input);
    return this.commandReply;
  }
}

export function emptyProposal(): UpdateProposal {
  return { material_change: false, change_summary: '', status: null, milestone_updates: [], next_steps: [], blockers: [], risks: [], tips: [], date_suggestions: [], deadline_findings: [], proposed_milestones: [], dependency_mentions: [], phrase: null };
}

export interface Harness {
  deps: Deps;
  db: SqliteDb;
  signer: DevSigner;
  llm: FakeLlm;
  clock: { now: Date };
  web: Map<string, { status?: number; body: string; type?: string }>;
  fetchLog: string[];
  owner: Principal;
  req(email: string | null, method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Response>;
  json<T = any>(email: string | null, method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: T }>;
  op(email: string, op: string, args: Record<string, unknown>): Promise<{ status: number; body: any }>;
}

export async function harness(opts: { llm?: boolean; dbPath?: string; start?: string; env?: Record<string, string> } = {}): Promise<Harness> {
  const db = new SqliteDb(opts.dbPath ?? ':memory:');
  db.migrate(join(import.meta.dirname, '..', 'migrations'));
  const signer = await createDevSigner();
  const clock = { now: new Date(opts.start ?? '2026-10-05T02:00:00Z') };
  const web = new Map<string, { status?: number; body: string; type?: string }>();
  const fetchLog: string[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    fetchLog.push(`${init?.method ?? 'GET'} ${url}`);
    if (url === 'https://api.resend.com/emails') {
      web.set(`resend:${fetchLog.length}`, { body: String(init?.body ?? ''), type: JSON.stringify(init?.headers ?? {}) });
      const r = web.get('resend-response');
      return new Response(r?.body ?? '{"id":"email_1"}', { status: r?.status ?? 200 });
    }
    const hit = web.get(url);
    if (!hit) return new Response('not found', { status: 404 });
    return new Response(hit.body, { status: hit.status ?? 200, headers: { 'content-type': hit.type ?? 'text/html' } });
  };
  const llm = new FakeLlm();
  const deps: Deps = {
    db,
    config: loadConfig({ OWNER_EMAIL: OWNER, PERSONAL_ALLOWED_EMAILS: RENATA, ACCESS_TEAM_DOMAIN: DEV_TEAM, ACCESS_AUD: DEV_AUD, APP_URL: 'https://dash.test', ...opts.env }),
    now: () => new Date(clock.now),
    fetch: fakeFetch,
    jwks: signer.jwks,
    llm: opts.llm ? llm : null,
  };
  const app = createApp(() => deps);
  const tokens = new Map<string, string>();
  const req = async (email: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const h: Record<string, string> = { ...headers };
    if (email) {
      if (!tokens.has(email)) tokens.set(email, await signer.issue(email, { now: clock.now }));
      h.cookie = `CF_Authorization=${tokens.get(email)}`;
    }
    if (method !== 'GET' && !('x-requested-with' in h) && !h.authorization) h['x-requested-with'] = 'dashboard';
    if (body !== undefined) h['content-type'] = 'application/json';
    return app.request(path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  };
  const json = async (email: string | null, method: string, path: string, body?: unknown, headers?: Record<string, string>) => {
    const r = await req(email, method, path, body, headers);
    const text = await r.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* html */
    }
    return { status: r.status, body: parsed as any };
  };
  const h: Harness = {
    deps, db, signer, llm, clock, web, fetchLog,
    owner: { ...systemPrincipal(), name: 'Owner', userId: 'u_owner', email: OWNER },
    req, json,
    op: (email, op, args) => json(email, 'POST', '/api/ops', { op, args }),
  };
  // Owner signs in first (creates the owner record), then invites the test users.
  await json(OWNER, 'GET', '/api/me');
  const owner = await db.first<{ id: string }>('SELECT id FROM users WHERE email = ?', [OWNER]);
  h.owner = { ...h.owner, userId: owner!.id };
  for (const [email, spaces] of [
    [RENATA, [{ space: 'personal', can_edit: false }]],
    [WORK_VIEWER, [{ space: 'work', can_edit: false }]],
    [WORK_EDITOR, [{ space: 'work', can_edit: true }]],
  ] as const) {
    const r = await json(OWNER, 'POST', '/api/admin/users', { email, spaces });
    if (r.status !== 200) throw new Error(`invite failed: ${JSON.stringify(r.body)}`);
  }
  return h;
}

export async function seed(h: Harness, projects: unknown[]) {
  return importProjects(h.deps, h.owner, { projects });
}

export async function idByName(h: Harness, name: string): Promise<string> {
  const r = await h.db.first<{ id: string }>('SELECT id FROM projects WHERE name = ?', [name]);
  if (!r) throw new Error(`no project ${name}`);
  return r.id;
}
