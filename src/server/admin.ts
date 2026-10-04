// Owner administration: invitations, space grants (view by default, edit granted
// separately), personal access tokens, import/export and integration status.
import { z } from 'zod';
import type { Space } from '../shared/types';
import { TOKEN_PREFIX, canOwnerWrite, type Principal } from './auth/principal';
import { authConfigured, emailConfigured, type Deps } from './config';
import type { Stmt } from './db';
import { sourceInsert } from './ops';
import type { IssueRow, MilestoneRow, NextStepRow, ProjectRow, SourceRow } from './rows';
import { latestRun } from './updater/refresh';
import { isIsoDate } from './time';
import { HttpError, b64url, badRequest, forbidden, newId, notFound, sha256Hex } from './util';

function requireOwner(p: Principal) {
  if (!canOwnerWrite(p)) throw forbidden('Only the owner can manage access.');
}

export async function listUsers(deps: Deps, p: Principal) {
  requireOwner(p);
  const users = await deps.db.all<{ id: string; email: string; name: string; status: string; summary_email: number; last_seen_at: string | null; created_at: string }>(
    'SELECT id, email, name, status, summary_email, last_seen_at, created_at FROM users ORDER BY created_at',
  );
  const grants = await deps.db.all<{ user_id: string; space: Space; can_edit: number }>('SELECT user_id, space, can_edit FROM grants');
  return {
    owner_email: deps.config.ownerEmail,
    personal_allowed: [...deps.config.personalAllowed],
    users: users.map((u) => ({
      ...u,
      is_owner: u.email === deps.config.ownerEmail,
      summary_email: u.summary_email === 1,
      grants: grants.filter((g) => g.user_id === u.id).map((g) => ({ space: g.space, can_edit: g.can_edit === 1 })),
    })),
  };
}

const InviteSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  name: z.string().trim().max(80).optional(),
  spaces: z.array(z.object({ space: z.enum(['personal', 'work']), can_edit: z.boolean().default(false) })).min(1),
});

function checkPersonal(deps: Deps, email: string, spaces: { space: Space }[]) {
  if (spaces.some((s) => s.space === 'personal') && !deps.config.personalAllowed.has(email)) {
    throw badRequest(`Personal projects are limited to the people listed in PERSONAL_ALLOWED_EMAILS. Add ${email} there first if this is intended.`);
  }
}

export async function inviteUser(deps: Deps, p: Principal, body: unknown) {
  requireOwner(p);
  const a = InviteSchema.parse(body);
  if (a.email === deps.config.ownerEmail) throw badRequest('That is the owner account.');
  checkPersonal(deps, a.email, a.spaces);
  const now = deps.now().toISOString();
  const existing = await deps.db.first<{ id: string }>('SELECT id FROM users WHERE email = ?', [a.email]);
  const id = existing?.id ?? newId('u_');
  const stmts: Stmt[] = existing
    ? [{ sql: "UPDATE users SET status = 'active', name = COALESCE(NULLIF(?, ''), name) WHERE id = ?", params: [a.name ?? '', id] }]
    : [{ sql: "INSERT INTO users (id, email, name, status, created_at) VALUES (?, ?, ?, 'active', ?)", params: [id, a.email, a.name ?? '', now] }];
  for (const s of a.spaces) {
    stmts.push({
      sql: 'INSERT INTO grants (user_id, space, can_edit, granted_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, space) DO UPDATE SET can_edit = excluded.can_edit',
      params: [id, s.space, s.can_edit ? 1 : 0, now],
    });
  }
  await deps.db.batch(stmts);
  return { id, email: a.email };
}

export async function setGrant(deps: Deps, p: Principal, body: unknown) {
  requireOwner(p);
  const a = z.object({ user_id: z.string(), space: z.enum(['personal', 'work']), access: z.enum(['none', 'view', 'edit']) }).parse(body);
  const u = await deps.db.first<{ email: string }>('SELECT email FROM users WHERE id = ?', [a.user_id]);
  if (!u) throw notFound();
  if (u.email === deps.config.ownerEmail) throw badRequest('The owner always has full access.');
  if (a.access === 'none') {
    await deps.db.run('DELETE FROM grants WHERE user_id = ? AND space = ?', [a.user_id, a.space]);
  } else {
    checkPersonal(deps, u.email, [{ space: a.space }]);
    await deps.db.run(
      'INSERT INTO grants (user_id, space, can_edit, granted_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, space) DO UPDATE SET can_edit = excluded.can_edit',
      [a.user_id, a.space, a.access === 'edit' ? 1 : 0, deps.now().toISOString()],
    );
  }
  return { ok: true };
}

export async function revokeUser(deps: Deps, p: Principal, userId: string) {
  requireOwner(p);
  const u = await deps.db.first<{ email: string }>('SELECT email FROM users WHERE id = ?', [userId]);
  if (!u) throw notFound();
  if (u.email === deps.config.ownerEmail) throw badRequest('The owner cannot be revoked.');
  await deps.db.batch([
    { sql: "UPDATE users SET status = 'revoked' WHERE id = ?", params: [userId] },
    { sql: 'DELETE FROM grants WHERE user_id = ?', params: [userId] },
    { sql: 'UPDATE api_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', params: [deps.now().toISOString(), userId] },
  ]);
  return { ok: true };
}

export async function setSummaryEmail(deps: Deps, p: Principal, enabled: boolean) {
  await deps.db.run('UPDATE users SET summary_email = ? WHERE id = ?', [enabled ? 1 : 0, p.userId]);
  return { ok: true };
}

// ---- personal access tokens (each user manages their own) ----

export async function listTokens(deps: Deps, p: Principal) {
  return deps.db.all('SELECT id, name, prefix, scope, created_at, last_used_at, revoked_at FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC', [p.userId]);
}

export async function createToken(deps: Deps, p: Principal, body: unknown) {
  if (p.via === 'token') throw forbidden('Create tokens from the dashboard, not with another token.');
  const a = z.object({ name: z.string().trim().min(1).max(60), scope: z.enum(['read', 'write']).default('read') }).parse(body);
  const token = TOKEN_PREFIX + b64url(crypto.getRandomValues(new Uint8Array(32)));
  const id = newId('t_');
  await deps.db.run('INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, scope, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
    id, p.userId, a.name, await sha256Hex(token), token.slice(0, 10), a.scope, deps.now().toISOString(),
  ]);
  return { id, token, note: 'Copy this token now; it is not shown again. It carries your own permissions (a read token can never change anything).' };
}

export async function revokeToken(deps: Deps, p: Principal, id: string) {
  const r = await deps.db.run('UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL', [deps.now().toISOString(), id, p.userId]);
  if (!r.changes) throw notFound();
  return { ok: true };
}

// ---- integration status ----

export async function integrationStatus(deps: Deps, p: Principal) {
  requireOwner(p);
  const c = deps.config;
  const run = await latestRun(deps);
  const lastCron = await deps.db.first<{ value: string }>("SELECT value FROM app_meta WHERE key = 'last_cron_at'");
  const runs = await deps.db.all('SELECT id, trigger, status, started_at, finished_at, stats, error FROM refresh_runs ORDER BY started_at DESC LIMIT 15');
  return {
    auth: { configured: authConfigured(c), provider: 'Cloudflare Access', team_domain: c.accessTeamDomain || null },
    llm: { configured: Boolean(c.anthropicKey), model: c.anthropicModel, note: c.anthropicKey ? 'Source changes are summarised with citations.' : 'Not configured: source changes are detected and flagged for review, but nothing is inferred.' },
    email: { configured: emailConfigured(c), provider: 'Resend', from: c.summaryFrom || null, note: emailConfigured(c) ? 'Daily summaries are emailed to users who opted in.' : 'Not configured: set RESEND_API_KEY and SUMMARY_FROM_EMAIL. Summaries are still available in the app.' },
    github: { configured: Boolean(c.githubToken), note: c.githubToken ? 'Private GitHub files can be tracked.' : 'Public GitHub files only (set GITHUB_TOKEN for private repos).' },
    notion: { configured: Boolean(c.notionToken), note: c.notionToken ? 'Notion pages shared with the integration can be tracked.' : 'Not configured: set NOTION_TOKEN.' },
    chatgpt: { configured: false, note: 'Not available: ChatGPT Spaces/Pages have no supported read API. Links are kept as references; paste dated snapshots.' },
    schedule: { cron: 'Hourly at minute 0 (UTC); daily summary at 07:00 Asia/Hong_Kong', last_cron_at: lastCron?.value ?? null, last_run: run },
    runs,
  };
}

// ---- export / import (canonical JSON) ----

export async function exportAll(deps: Deps, p: Principal) {
  requireOwner(p);
  const projects = await deps.db.all<ProjectRow>('SELECT * FROM projects ORDER BY space, name');
  const all = async <T>(t: string) => deps.db.all<T & { project_id: string }>(`SELECT * FROM ${t}`);
  const [ms, st, is, src, dep] = await Promise.all([all<MilestoneRow>('milestones'), all<NextStepRow>('next_steps'), all<IssueRow>('issues'), all<SourceRow>('sources'), all<{ depends_on_id: string; note: string }>('dependencies')]);
  return {
    format: 'project-dashboard/v1',
    exported_at: deps.now().toISOString(),
    projects: projects.map((pr) => ({
      ...pr,
      milestones: ms.filter((x) => x.project_id === pr.id),
      next_steps: st.filter((x) => x.project_id === pr.id),
      issues: is.filter((x) => x.project_id === pr.id),
      sources: src.filter((x) => x.project_id === pr.id),
      dependencies: dep.filter((x) => x.project_id === pr.id).map((d) => ({ depends_on_id: d.depends_on_id, note: d.note })),
    })),
  };
}

const ImportMilestone = z.object({
  title: z.string().min(1),
  description: z.string().default(''),
  weight: z.number().positive().default(1),
  state: z.enum(['not_started', 'in_progress', 'done']).default('not_started'),
  confirmed: z.union([z.boolean(), z.number()]).default(true),
  evidence: z.string().default(''),
  evidence_basis: z.enum(['', 'owner_confirmed', 'source_fact', 'auto_evidence']).default(''),
  checklist: z.array(z.object({ title: z.string(), done: z.boolean().default(false) })).or(z.string()).default([]),
  deadline: z.string().nullable().default(null),
  target_date: z.string().nullable().default(null),
});
const ImportProject = z.object({
  id: z.string().optional(),
  space: z.enum(['personal', 'work']),
  name: z.string().min(1),
  phrase: z.string().default(''),
  status: z.enum(['on_track', 'in_progress', 'at_risk', 'blocked', 'unassessed']).default('unassessed'),
  status_summary: z.string().default(''),
  status_detail: z.string().default(''),
  status_basis: z.enum(['manual', 'source_fact', 'suggestion']).default('manual'),
  priority: z.enum(['high', 'medium', 'low']).default('medium'),
  pinned: z.union([z.boolean(), z.number()]).default(false),
  only_me: z.union([z.boolean(), z.number()]).default(false),
  lifecycle: z.enum(['active', 'paused', 'completed', 'archived']).default('active'),
  canonical_url: z.string().default(''),
  milestones: z.array(ImportMilestone).default([]),
  next_steps: z
    .array(z.object({ title: z.string(), assignee: z.string().default(''), due_date: z.string().nullable().default(null), needs_decision: z.union([z.boolean(), z.number()]).default(false), is_primary: z.union([z.boolean(), z.number()]).default(false), basis: z.enum(['manual', 'source_fact', 'suggestion']).default('manual'), citation: z.any().optional() }))
    .default([]),
  issues: z.array(z.object({ kind: z.enum(['blocker', 'risk', 'tip']), title: z.string(), detail: z.string().default(''), severity: z.enum(['high', 'medium', 'low']).default('medium'), basis: z.enum(['manual', 'source_fact', 'suggestion']).default('manual'), citation: z.any().optional() })).default([]),
  sources: z
    .array(z.object({ kind: z.enum(['web', 'github', 'notion', 'snapshot', 'reference']).optional(), role: z.enum(['canonical', 'supporting', 'decision', 'workstream']).default('supporting'), title: z.string().default(''), url: z.string().default(''), snapshot_text: z.string().default(''), as_of: z.string().nullable().default(null) }))
    .default([]),
  history_note: z.string().optional(),
});

const b = (v: boolean | number) => (v === true || v === 1 ? 1 : 0);
const cite = (c: unknown, srcIds: string[]) => JSON.stringify(Array.isArray(c) ? c.map((x: { source_index?: number; quote?: string; source_id?: string }) => ({ source_id: x.source_id ?? srcIds[x.source_index ?? 0] ?? '', quote: x.quote ?? '' })) : []);

/** Imports projects from the canonical JSON format. Existing ids are skipped (never overwritten). */
export async function importProjects(deps: Deps, p: Principal, body: unknown) {
  requireOwner(p);
  const parsed = z.object({ projects: z.array(ImportProject).min(1).max(100) }).safeParse(body);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const now = deps.now().toISOString();
  const created: string[] = [];
  const skipped: string[] = [];
  for (const pr of parsed.data.projects) {
    if (pr.id && (await deps.db.first('SELECT id FROM projects WHERE id = ?', [pr.id]))) {
      skipped.push(pr.name);
      continue;
    }
    const id = pr.id ?? newId('p_');
    const stmts: Stmt[] = [
      {
        sql: `INSERT INTO projects (id, space, name, phrase, status, status_summary, status_detail, status_basis, priority, pinned, pinned_at, only_me, lifecycle, canonical_url, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [id, pr.space, pr.name, pr.phrase, pr.status, pr.status_summary, pr.status_detail, pr.status_basis, pr.priority, b(pr.pinned), b(pr.pinned) ? now : null, b(pr.only_me), pr.lifecycle, pr.canonical_url, now, now],
      },
    ];
    const srcIds: string[] = [];
    for (const s of pr.sources) {
      const [ins] = sourceInsert({ deps }, id, { url: s.url || undefined, title: s.title, role: s.role, snapshot_text: s.snapshot_text || undefined, as_of: s.as_of ?? undefined });
      srcIds.push(String(ins.params![0]));
      stmts.push(ins);
      if (s.snapshot_text) {
        // The snapshot's content is already reflected in the imported record: mark it processed
        // so the updater does not re-derive (and duplicate) the same facts.
        const text = `Snapshot as of ${s.as_of ?? 'unknown date'}:\n${s.snapshot_text}`;
        const hash = await sha256Hex(text);
        stmts.push(
          { sql: 'UPDATE sources SET content_hash = ?, last_success_at = ?, last_checked_at = ? WHERE id = ?', params: [hash, now, now, srcIds.at(-1)] },
          { sql: 'INSERT INTO source_content (source_id, content_hash, text, fetched_at) VALUES (?, ?, ?, ?)', params: [srcIds.at(-1), hash, text, now] },
        );
      }
    }
    pr.milestones.forEach((m, i) => {
      const checklist = typeof m.checklist === 'string' ? m.checklist : JSON.stringify(m.checklist.map((c) => ({ id: newId('c_'), title: c.title, done: c.done })));
      stmts.push({
        sql: `INSERT INTO milestones (id, project_id, position, title, description, weight, state, confirmed, evidence, evidence_basis, evidence_source_id, completed_at, checklist, deadline, target_date, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [newId('m_'), id, i + 1, m.title, m.description, m.weight, m.state, b(m.confirmed), m.evidence, m.evidence_basis, m.evidence_basis === 'source_fact' ? (srcIds.find((_, j) => pr.sources[j]?.snapshot_text) ?? null) : null, m.state === 'done' ? now : null, checklist, isIsoDate(m.deadline) ? m.deadline : null, isIsoDate(m.target_date) ? m.target_date : null, now, now],
      });
    });
    pr.next_steps.forEach((s, i) =>
      stmts.push({
        sql: `INSERT INTO next_steps (id, project_id, position, title, assignee, due_date, needs_decision, is_primary, origin, basis, citation, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?)`,
        params: [newId('s_'), id, i + 1, s.title, s.assignee, isIsoDate(s.due_date) ? s.due_date : null, b(s.needs_decision), b(s.is_primary), s.basis, cite(s.citation, srcIds), now, now],
      }),
    );
    for (const it of pr.issues) {
      stmts.push({
        sql: `INSERT INTO issues (id, project_id, kind, title, detail, severity, origin, basis, citation, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?)`,
        params: [newId('i_'), id, it.kind, it.title, it.detail, it.severity, it.basis, cite(it.citation, srcIds), now, now],
      });
    }
    stmts.push({
      sql: `INSERT INTO history (id, project_id, at, actor_type, actor_id, actor_label, kind, summary, detail) VALUES (?, ?, ?, 'user', ?, ?, 'created', ?, ?)`,
      params: [newId('h_'), id, now, p.userId, p.name, pr.history_note ?? 'Imported', JSON.stringify(b(pr.only_me) ? { owner_only: true } : {})],
    });
    await deps.db.batch(stmts);
    created.push(pr.name);
  }
  return { created, skipped };
}
