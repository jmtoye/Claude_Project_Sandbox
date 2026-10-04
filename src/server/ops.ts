// The operations layer: every change to project data — from the dashboard UI, the
// REST API, MCP tools or natural-language commands — goes through these functions,
// which enforce permissions, record history, protect manual overrides and apply
// optimistic concurrency atomically.
import { z } from 'zod';
import type { Space } from '../shared/types';
import { canEdit, canOwnerWrite, type Principal } from './auth/principal';
import type { Deps } from './config';
import { isGuardFailure, versionGuard, type Stmt } from './db';
import type { IssueRow, MilestoneRow, NextStepRow, ProjectRow } from './rows';
import { getVisibleProject } from './repo';
import { hkDate, isIsoDate } from './time';
import { classifyUrl } from './updater/sources';
import { HttpError, badRequest, bool, conflict, forbidden, newId, notFound, parseJson } from './util';

export interface Actor {
  type: 'user' | 'assistant';
  label: string;
}
export interface OpCtx {
  deps: Deps;
  principal: Principal;
  actor: Actor;
}
export interface OpResult {
  message: string;
  project_id?: string;
  data?: Record<string, unknown>;
}
export type Need = 'edit' | 'owner';

/** Fields the automatic updater may change; a manual edit protects them via an override. */
export const AUTO_PROJECT_FIELDS = ['status', 'status_summary', 'status_detail', 'phrase'] as const;

const date = z.string().refine(isIsoDate, 'Use YYYY-MM-DD');
const pid = z.string().min(1).describe('Project id');
const text = (max: number) => z.string().trim().max(max);
const SPACE = z.enum(['personal', 'work']);
const STATUS = z.enum(['on_track', 'in_progress', 'at_risk', 'blocked', 'unassessed']);
const PRIORITY = z.enum(['high', 'medium', 'low']);

const CONFLICT_RETRY = 'internal_version_conflict';

// ---- helpers --------------------------------------------------------------

async function loadProject(ctx: OpCtx, id: string, need: Need): Promise<ProjectRow> {
  const p = await getVisibleProject(ctx.deps.db, ctx.principal, id);
  if (!p) throw notFound();
  if (need === 'owner' && !canOwnerWrite(ctx.principal)) throw forbidden('Only the owner can do that.');
  if (need === 'edit' && !canEdit(ctx.principal, p.space)) throw forbidden('You have view-only access to this project.');
  return p;
}

const nowIso = (ctx: OpCtx) => ctx.deps.now().toISOString();
const today = (ctx: OpCtx) => hkDate(ctx.deps.now());

function historyStmt(ctx: OpCtx, projectId: string, kind: string, summary: string, detail: Record<string, unknown> = {}): Stmt {
  return {
    sql: `INSERT INTO history (id, project_id, at, actor_type, actor_id, actor_label, kind, summary, detail)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [newId('h_'), projectId, nowIso(ctx), ctx.actor.type, ctx.principal.userId, ctx.actor.label, kind, summary, JSON.stringify(detail)],
  };
}

function overrideStmt(ctx: OpCtx, projectId: string, field: string, note = ''): Stmt {
  return {
    sql: `INSERT INTO overrides (project_id, field, set_by, set_at, note) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(project_id, field) DO UPDATE SET set_by = excluded.set_by, set_at = excluded.set_at, note = excluded.note`,
    params: [projectId, field, ctx.principal.name, nowIso(ctx), note],
  };
}

async function commit(ctx: OpCtx, p: ProjectRow, stmts: Stmt[]): Promise<void> {
  try {
    await ctx.deps.db.batch([
      versionGuard(p.id, p.version),
      ...stmts,
      { sql: 'UPDATE projects SET version = version + 1, updated_at = ? WHERE id = ?', params: [nowIso(ctx), p.id] },
    ]);
  } catch (err) {
    if (isGuardFailure(err)) throw new HttpError(409, 'Concurrent change', CONFLICT_RETRY);
    throw err;
  }
}

async function getMilestone(ctx: OpCtx, projectId: string, id: string): Promise<MilestoneRow> {
  const m = await ctx.deps.db.first<MilestoneRow>('SELECT * FROM milestones WHERE id = ? AND project_id = ?', [id, projectId]);
  if (!m) throw notFound();
  return m;
}

async function nextOpenMilestone(ctx: OpCtx, projectId: string): Promise<MilestoneRow | null> {
  const rows = await ctx.deps.db.all<MilestoneRow>(
    "SELECT * FROM milestones WHERE project_id = ? AND state <> 'done' ORDER BY confirmed DESC, position LIMIT 1",
    [projectId],
  );
  return rows[0] ?? null;
}

function checkExpected(p: ProjectRow, expected?: number) {
  if (expected !== undefined && expected !== p.version) throw conflict();
}

// ---- operation definitions -------------------------------------------------

interface OpDef<S extends z.ZodType> {
  summary: string;
  schema: S;
  run: (ctx: OpCtx, args: z.infer<S>) => Promise<OpResult>;
}
function op<S extends z.ZodType>(def: OpDef<S>): OpDef<S> {
  return def;
}

const expected = z.number().int().optional().describe('Optional: project version the change was based on (409 if it changed).');

export const OPS = {
  create_project: op({
    summary: 'Add a new tracked project to Personal or Work (owner only). Projects are only ever added explicitly.',
    schema: z.object({
      space: SPACE,
      name: text(120).min(1),
      phrase: text(140).optional(),
      canonical_url: text(2000).optional(),
      priority: PRIORITY.optional(),
      status_summary: text(300).optional(),
      only_me: z.boolean().optional(),
    }),
    async run(ctx, a) {
      if (!canOwnerWrite(ctx.principal)) throw forbidden('Only the owner can add projects.');
      const id = newId('p_');
      const now = nowIso(ctx);
      const stmts: Stmt[] = [
        {
          sql: `INSERT INTO projects (id, space, name, phrase, status_summary, priority, only_me, canonical_url, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          params: [id, a.space, a.name, a.phrase ?? '', a.status_summary ?? '', a.priority ?? 'medium', a.only_me ? 1 : 0, a.canonical_url ?? '', now, now],
        },
        historyStmt(ctx, id, 'created', `Project added to ${a.space === 'work' ? 'Work' : 'Personal'}`, a.only_me ? { owner_only: true } : {}),
      ];
      if (a.canonical_url) stmts.push(...sourceInsert(ctx, id, { url: a.canonical_url, role: 'canonical' }));
      await ctx.deps.db.batch(stmts);
      return { message: `Added "${a.name}" to ${a.space === 'work' ? 'Work' : 'Personal'}.`, project_id: id };
    },
  }),

  update_project: op({
    summary: 'Edit project fields. Manual edits to status, status summary/detail and phrase become overrides that automatic updates will not change until released.',
    schema: z.object({
      project_id: pid,
      name: text(120).min(1).optional(),
      phrase: text(140).optional(),
      status: STATUS.optional(),
      status_summary: text(300).optional(),
      status_detail: text(8000).optional(),
      priority: PRIORITY.optional(),
      needs_attention: z.boolean().optional(),
      attention_note: text(300).optional(),
      canonical_url: text(2000).optional(),
      expected_version: expected,
    }),
    async run(ctx, a) {
      const p = await loadProject(ctx, a.project_id, 'edit');
      checkExpected(p, a.expected_version);
      const sets: string[] = [];
      const params: unknown[] = [];
      const changed: Record<string, { from: unknown; to: unknown }> = {};
      const stmts: Stmt[] = [];
      for (const key of ['name', 'phrase', 'status', 'status_summary', 'status_detail', 'priority', 'needs_attention', 'attention_note', 'canonical_url'] as const) {
        const v = a[key];
        if (v === undefined) continue;
        const dbv = typeof v === 'boolean' ? (v ? 1 : 0) : v;
        if ((p as unknown as Record<string, unknown>)[key] === dbv) continue;
        sets.push(`${key} = ?`);
        params.push(dbv);
        changed[key] = { from: (p as unknown as Record<string, unknown>)[key], to: dbv };
        if ((AUTO_PROJECT_FIELDS as readonly string[]).includes(key)) stmts.push(overrideStmt(ctx, p.id, key));
      }
      if (changed.status || changed.status_summary || changed.status_detail) {
        sets.push("status_basis = 'manual'");
      }
      if (!sets.length) return { message: 'No changes.', project_id: p.id };
      stmts.unshift({ sql: `UPDATE projects SET ${sets.join(', ')} WHERE id = ?`, params: [...params, p.id] });
      const names = Object.keys(changed).map((k) => k.replace(/_/g, ' '));
      stmts.push(historyStmt(ctx, p.id, 'edit', `Edited ${names.join(', ')}`, { changed }));
      await commit(ctx, p, stmts);
      return { message: `Updated ${names.join(', ')}.`, project_id: p.id };
    },
  }),

  set_pinned: op({
    summary: 'Pin or unpin a project (pinned projects are shown first).',
    schema: z.object({ project_id: pid, pinned: z.boolean() }),
    async run(ctx, a) {
      const p = await loadProject(ctx, a.project_id, 'edit');
      if (bool(p.pinned) === a.pinned) return { message: a.pinned ? 'Already pinned.' : 'Already unpinned.', project_id: p.id };
      await commit(ctx, p, [
        { sql: 'UPDATE projects SET pinned = ?, pinned_at = ? WHERE id = ?', params: [a.pinned ? 1 : 0, a.pinned ? nowIso(ctx) : null, p.id] },
        historyStmt(ctx, p.id, 'lifecycle', a.pinned ? 'Pinned' : 'Unpinned'),
      ]);
      return { message: `${a.pinned ? 'Pinned' : 'Unpinned'} "${p.name}".`, project_id: p.id };
    },
  }),

  set_lifecycle: op({
    summary: 'Pause, resume, complete, archive or reopen a project. Pause/resume need edit access; complete, archive and reopen are owner-only.',
    schema: z.object({ project_id: pid, lifecycle: z.enum(['active', 'paused', 'completed', 'archived']) }),
    async run(ctx, a) {
      const visible = await loadProject(ctx, a.project_id, 'edit');
      const ownerOnly = a.lifecycle === 'completed' || a.lifecycle === 'archived' || visible.lifecycle === 'completed' || visible.lifecycle === 'archived';
      const p = ownerOnly ? await loadProject(ctx, a.project_id, 'owner') : visible;
      if (p.lifecycle === a.lifecycle) return { message: `Already ${a.lifecycle}.`, project_id: p.id };
      const label = { active: p.lifecycle === 'paused' ? 'Resumed' : 'Reopened', paused: 'Paused', completed: 'Marked complete (moved to archive)', archived: 'Archived' }[a.lifecycle];
      const stmts: Stmt[] = [
        { sql: 'UPDATE projects SET lifecycle = ?, lifecycle_changed_at = ? WHERE id = ?', params: [a.lifecycle, nowIso(ctx), p.id] },
        historyStmt(ctx, p.id, 'lifecycle', label, { from: p.lifecycle, to: a.lifecycle }),
      ];
      if (a.lifecycle === 'completed' || a.lifecycle === 'archived') stmts.push({ sql: 'UPDATE projects SET pinned = 0, pinned_at = NULL WHERE id = ?', params: [p.id] });
      await commit(ctx, p, stmts);
      return { message: `${label}: "${p.name}".`, project_id: p.id };
    },
  }),

  set_only_me: op({
    summary: 'Owner only: when enabled the project is visible only to the owner — hidden from every other user in all views, counts, maps, search and summaries.',
    schema: z.object({ project_id: pid, enabled: z.boolean() }),
    async run(ctx, a) {
      const p = await loadProject(ctx, a.project_id, 'owner');
      if (bool(p.only_me) === a.enabled) return { message: a.enabled ? 'Already visible only to you.' : 'Already visible to others with access.', project_id: p.id };
      await commit(ctx, p, [
        { sql: 'UPDATE projects SET only_me = ? WHERE id = ?', params: [a.enabled ? 1 : 0, p.id] },
        historyStmt(ctx, p.id, 'visibility', a.enabled ? 'Visibility set to Only me' : 'Only me turned off', { owner_only: true }),
      ]);
      return { message: a.enabled ? `"${p.name}" is now visible only to you.` : `"${p.name}" is visible to people with ${p.space} access again.`, project_id: p.id };
    },
  }),

  delete_project: op({
    summary: 'Owner only: permanently delete a project and its history. Prefer archiving.',
    schema: z.object({ project_id: pid, confirm_name: z.string() }),
    async run(ctx, a) {
      const p = await loadProject(ctx, a.project_id, 'owner');
      if (a.confirm_name.trim() !== p.name) throw badRequest('Type the project name exactly to confirm deletion.');
      await ctx.deps.db.run('DELETE FROM projects WHERE id = ?', [p.id]);
      return { message: `Deleted "${p.name}".` };
    },
  }),

  flag_blocked: op({
    summary: 'Mark a project as blocked with the reason (records an actual blocker and sets status to Blocked as a manual override).',
    schema: z.object({ project_id: pid, reason: text(300).min(1), severity: PRIORITY.optional() }),
    async run(ctx, a) {
      const p = await loadProject(ctx, a.project_id, 'edit');
      const now = nowIso(ctx);
      await commit(ctx, p, [
        {
          sql: `INSERT INTO issues (id, project_id, kind, title, severity, origin, basis, created_at, updated_at)
                VALUES (?, ?, 'blocker', ?, ?, 'manual', 'manual', ?, ?)`,
          params: [newId('i_'), p.id, a.reason, a.severity ?? 'high', now, now],
        },
        { sql: "UPDATE projects SET status = 'blocked', status_basis = 'manual' WHERE id = ?", params: [p.id] },
        overrideStmt(ctx, p.id, 'status', a.reason),
        historyStmt(ctx, p.id, 'blocker', `Flagged as blocked: ${a.reason}`),
      ]);
      return { message: `"${p.name}" flagged as blocked: ${a.reason}`, project_id: p.id };
    },
  }),

  add_issue: op({
    summary: 'Record an actual blocker, an anticipated risk, or a useful tip.',
    schema: z.object({ project_id: pid, kind: z.enum(['blocker', 'risk', 'tip']), title: text(300).min(1), detail: text(2000).optional(), severity: PRIORITY.optional() }),
    async run(ctx, a) {
      const p = await loadProject(ctx, a.project_id, 'edit');
      const now = nowIso(ctx);
      await commit(ctx, p, [
        {
          sql: `INSERT INTO issues (id, project_id, kind, title, detail, severity, origin, basis, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, 'manual', 'manual', ?, ?)`,
          params: [newId('i_'), p.id, a.kind, a.title, a.detail ?? '', a.severity ?? 'medium', now, now],
        },
        historyStmt(ctx, p.id, 'issue', `Added ${a.kind}: ${a.title}`),
      ]);
      return { message: `Added ${a.kind} to "${p.name}".`, project_id: p.id };
    },
  }),

  update_issue: op({
    summary: 'Edit, resolve or reopen a blocker/risk/tip.',
    schema: z.object({
      project_id: pid,
      issue_id: z.string(),
      title: text(300).min(1).optional(),
      detail: text(2000).optional(),
      severity: PRIORITY.optional(),
      kind: z.enum(['blocker', 'risk', 'tip']).optional(),
      resolved: z.boolean().optional(),
    }),
    async run(ctx, a) {
      const p = await loadProject(ctx, a.project_id, 'edit');
      const i = await ctx.deps.db.first<IssueRow>('SELECT * FROM issues WHERE id = ? AND project_id = ?', [a.issue_id, p.id]);
      if (!i) throw notFound();
      const now = nowIso(ctx);
      const resolved = a.resolved === undefined ? i.resolved : a.resolved ? 1 : 0;
      const resolvedAt = a.resolved === undefined ? i.resolved_at : a.resolved ? now : null;
      const stmts: Stmt[] = [
        {
          sql: `UPDATE issues SET title = ?, detail = ?, severity = ?, kind = ?, resolved = ?, resolved_at = ?,
                origin = 'manual', basis = CASE WHEN basis = 'suggestion' THEN 'manual' ELSE basis END, updated_at = ? WHERE id = ?`,
          params: [a.title ?? i.title, a.detail ?? i.detail, a.severity ?? i.severity, a.kind ?? i.kind, resolved, resolvedAt, now, i.id],
        },
        historyStmt(ctx, p.id, 'issue', a.resolved === true ? `Resolved: ${i.title}` : a.resolved === false ? `Reopened: ${i.title}` : `Edited: ${i.title}`),
      ];
      if (i.origin === 'auto') stmts.push(overrideStmt(ctx, p.id, 'issues', 'Automatic issue edited manually'));
      await commit(ctx, p, stmts);
      return { message: a.resolved ? 'Resolved.' : 'Updated.', project_id: p.id };
    },
  }),

  delete_issue: op({
    summary: 'Remove a blocker/risk/tip.',
    schema: z.object({ project_id: pid, issue_id: z.string() }),
    async run(ctx, a) {
      const p = await loadProject(ctx, a.project_id, 'edit');
      const i = await ctx.deps.db.first<{ title: string; origin: string }>('SELECT title, origin FROM issues WHERE id = ? AND project_id = ?', [a.issue_id, p.id]);
      if (!i) throw notFound();
      const stmts: Stmt[] = [{ sql: 'DELETE FROM issues WHERE id = ?', params: [a.issue_id] }, historyStmt(ctx, p.id, 'issue', `Removed: ${i.title}`)];
      if (i.origin === 'auto') stmts.push(overrideStmt(ctx, p.id, 'issues', 'Automatic issue removed manually'));
      await commit(ctx, p, stmts);
      return { message: 'Removed.', project_id: p.id };
    },
  }),

  add_milestone: op({
    summary: 'Add a milestone (confirmed). Weight defaults to 1.',
    schema: z.object({
      project_id: pid,
      title: text(200).min(1),
      description: text(2000).optional(),
      weight: z.number().positive().max(100).optional(),
      deadline: date.optional(),
      deadline_note: text(300).optional(),
      target_date: date.optional(),
      position: z.number().int().optional(),
    }),
    async run(ctx, a) {
      const p = await loadProject(ctx, a.project_id, 'edit');
      const max = await ctx.deps.db.first<{ m: number | null }>('SELECT MAX(position) AS m FROM milestones WHERE project_id = ?', [p.id]);
      const now = nowIso(ctx);
      await commit(ctx, p, [
        {
          sql: `INSERT INTO milestones (id, project_id, position, title, description, weight, confirmed, deadline, deadline_note, target_date, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
          params: [newId('m_'), p.id, a.position ?? (max?.m ?? 0) + 1, a.title, a.description ?? '', a.weight ?? 1, a.deadline ?? null, a.deadline_note ?? '', a.target_date ?? null, now, now],
        },
        historyStmt(ctx, p.id, 'milestone', `Added milestone: ${a.title}`),
      ]);
      return { message: `Added milestone "${a.title}".`, project_id: p.id };
    },
  }),

  update_milestone: op({
    summary: 'Edit a milestone: title, weight, state, evidence, checklist (sub-steps), manual target date. Use set_target_date to change a confirmed deadline.',
    schema: z.object({
      project_id: pid,
      milestone_id: z.string(),
      title: text(200).min(1).optional(),
      description: text(2000).optional(),
      weight: z.number().positive().max(100).optional(),
      state: z.enum(['not_started', 'in_progress', 'done']).optional(),
      evidence: text(2000).optional(),
      checklist: z.array(z.object({ id: z.string().optional(), title: text(200).min(1), done: z.boolean() })).max(50).optional(),
      position: z.number().int().optional(),
      target_date: date.nullable().optional(),
      confirmed: z.boolean().optional(),
    }),
    async run(ctx, a) {
      const p = await loadProject(ctx, a.project_id, 'edit');
      const m = await getMilestone(ctx, p.id, a.milestone_id);
      const now = nowIso(ctx);
      const sets: string[] = [];
      const params: unknown[] = [];
      const stmts: Stmt[] = [];
      const notes: string[] = [];
      const set = (col: string, v: unknown) => {
        sets.push(`${col} = ?`);
        params.push(v);
      };
      if (a.title !== undefined && a.title !== m.title) (set('title', a.title), notes.push('title'));
      if (a.description !== undefined) set('description', a.description);
      if (a.weight !== undefined && a.weight !== m.weight) (set('weight', a.weight), notes.push(`weight ${m.weight}→${a.weight}`));
      if (a.position !== undefined) set('position', a.position);
      if (a.confirmed !== undefined && a.confirmed !== (m.confirmed === 1)) (set('confirmed', a.confirmed ? 1 : 0), notes.push(a.confirmed ? 'confirmed' : 'unconfirmed'));
      if (a.checklist !== undefined) {
        set('checklist', JSON.stringify(a.checklist.map((c) => ({ id: c.id ?? newId('c_'), title: c.title, done: c.done }))));
        notes.push('checklist');
        stmts.push(overrideStmt(ctx, p.id, `milestone:${m.id}:checklist`));
      }
      if (a.target_date !== undefined && a.target_date !== m.target_date) {
        set('target_date', a.target_date);
        notes.push(a.target_date ? `target ${m.target_date ?? 'none'}→${a.target_date}` : 'target cleared');
      }
      if (a.state !== undefined && a.state !== m.state) {
        set('state', a.state);
        notes.push(`state ${m.state}→${a.state}`);
        stmts.push(overrideStmt(ctx, p.id, `milestone:${m.id}:state`));
        if (a.state === 'done') {
          set('completed_at', now);
          if (a.evidence === undefined && !m.evidence) {
            set('evidence', `Confirmed complete by ${ctx.principal.name} on ${today(ctx)}.`);
            set('evidence_basis', 'owner_confirmed');
          }
        } else set('completed_at', null);
      }
      if (a.evidence !== undefined && a.evidence !== m.evidence) {
        set('evidence', a.evidence);
        set('evidence_basis', a.evidence ? 'owner_confirmed' : '');
        notes.push('evidence');
        stmts.push(overrideStmt(ctx, p.id, `milestone:${m.id}:state`));
      }
      if (!sets.length) return { message: 'No changes.', project_id: p.id };
      stmts.unshift({ sql: `UPDATE milestones SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, params: [...params, now, m.id] });
      stmts.push(historyStmt(ctx, p.id, 'milestone', `Milestone "${a.title ?? m.title}": ${notes.join(', ') || 'edited'}`));
      await commit(ctx, p, stmts);
      return { message: `Updated milestone "${a.title ?? m.title}".`, project_id: p.id };
    },
  }),

  complete_milestone: op({
    summary: 'Mark a milestone complete, recording the completion evidence (defaults to your confirmation).',
    schema: z.object({ project_id: pid, milestone_id: z.string(), evidence: text(2000).optional() }),
    async run(ctx, a) {
      const p = await loadProject(ctx, a.project_id, 'edit');
      const m = await getMilestone(ctx, p.id, a.milestone_id);
      const evidence = a.evidence?.trim() || `Confirmed complete by ${ctx.principal.name} on ${today(ctx)}.`;
      const now = nowIso(ctx);
      await commit(ctx, p, [
        {
          sql: "UPDATE milestones SET state = 'done', completed_at = ?, evidence = ?, evidence_basis = 'owner_confirmed', evidence_source_id = NULL, confirmed = 1, updated_at = ? WHERE id = ?",
          params: [now, evidence, now, m.id],
        },
        overrideStmt(ctx, p.id, `milestone:${m.id}:state`),
        historyStmt(ctx, p.id, 'milestone', `Milestone complete: ${m.title}`, { evidence }),
      ]);
      return { message: `Marked "${m.title}" complete.`, project_id: p.id };
    },
  }),

  delete_milestone: op({
    summary: 'Remove a milestone.',
    schema: z.object({ project_id: pid, milestone_id: z.string() }),
    async run(ctx, a) {
      const p = await loadProject(ctx, a.project_id, 'edit');
      const m = await getMilestone(ctx, p.id, a.milestone_id);
      await commit(ctx, p, [
        { sql: 'DELETE FROM milestones WHERE id = ?', params: [m.id] },
        { sql: "DELETE FROM overrides WHERE project_id = ? AND field LIKE ?", params: [p.id, `milestone:${m.id}:%`] },
        historyStmt(ctx, p.id, 'milestone', `Removed milestone: ${m.title}`),
      ]);
      return { message: `Removed milestone "${m.title}".`, project_id: p.id };
    },
  }),

  confirm_milestones: op({
    summary: 'Accept all proposed milestones for a project so progress can be assessed.',
    schema: z.object({ project_id: pid }),
    async run(ctx, a) {
      const p = await loadProject(ctx, a.project_id, 'edit');
      const n = await ctx.deps.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM milestones WHERE project_id = ? AND confirmed = 0', [p.id]);
      if (!n?.n) return { message: 'No proposed milestones to confirm.', project_id: p.id };
      await commit(ctx, p, [
        { sql: 'UPDATE milestones SET confirmed = 1, updated_at = ? WHERE project_id = ? AND confirmed = 0', params: [nowIso(ctx), p.id] },
        historyStmt(ctx, p.id, 'milestone', `Confirmed ${n.n} proposed milestone${n.n === 1 ? '' : 's'}`),
      ]);
      return { message: `Confirmed ${n.n} milestone${n.n === 1 ? '' : 's'}.`, project_id: p.id };
    },
  }),

  set_target_date: op({
    summary:
      'Set a date on a milestone (defaults to the next open milestone). kind "target" = your own target; kind "deadline" = a confirmed external deadline. Changing an existing deadline requires a note and is always recorded.',
    schema: z.object({
      project_id: pid,
      milestone_id: z.string().optional(),
      date: date.nullable(),
      kind: z.enum(['target', 'deadline']).default('target'),
      note: text(300).optional(),
    }),
    async run(ctx, a) {
      const p = await loadProject(ctx, a.project_id, 'edit');
      const m = a.milestone_id ? await getMilestone(ctx, p.id, a.milestone_id) : await nextOpenMilestone(ctx, p.id);
      if (!m) throw badRequest('This project has no open milestone. Add a milestone first.');
      const now = nowIso(ctx);
      if (a.kind === 'deadline') {
        if (m.deadline === a.date) return { message: 'Deadline unchanged.', project_id: p.id };
        if (m.deadline && !a.note?.trim()) throw badRequest('Changing a confirmed deadline needs a short reason (it is kept in the history).');
        const wasOverdue = Boolean(m.deadline && m.deadline < today(ctx) && m.state !== 'done');
        await commit(ctx, p, [
          { sql: 'UPDATE milestones SET deadline = ?, deadline_note = ?, updated_at = ? WHERE id = ?', params: [a.date, a.note ?? m.deadline_note, now, m.id] },
          historyStmt(
            ctx,
            p.id,
            'deadline',
            m.deadline ? `Deadline for "${m.title}" moved ${m.deadline} → ${a.date ?? 'none'}${wasOverdue ? ' (it was overdue)' : ''}: ${a.note}` : `Deadline set for "${m.title}": ${a.date}`,
            { milestone_id: m.id, from: m.deadline, to: a.date, was_overdue: wasOverdue, note: a.note ?? '' },
          ),
        ]);
        return { message: `Deadline for "${m.title}" ${a.date ? `set to ${a.date}` : 'cleared'}.`, project_id: p.id };
      }
      if (m.target_date === a.date) return { message: 'Target unchanged.', project_id: p.id };
      await commit(ctx, p, [
        { sql: 'UPDATE milestones SET target_date = ?, updated_at = ? WHERE id = ?', params: [a.date, now, m.id] },
        historyStmt(ctx, p.id, 'target', `Target for "${m.title}": ${m.target_date ?? 'none'} → ${a.date ?? 'none'}`, { milestone_id: m.id, from: m.target_date, to: a.date, note: a.note ?? '' }),
      ]);
      return { message: `Target for "${m.title}" ${a.date ? `set to ${a.date}` : 'cleared'}.`, project_id: p.id };
    },
  }),

  add_next_step: op({
    summary: 'Add a next step. Mark is_primary for the single most important next action; needs_decision when it awaits your decision.',
    schema: z.object({
      project_id: pid,
      title: text(300).min(1),
      assignee: text(80).optional(),
      due_date: date.optional(),
      needs_decision: z.boolean().optional(),
      is_primary: z.boolean().optional(),
    }),
    async run(ctx, a) {
      const p = await loadProject(ctx, a.project_id, 'edit');
      const max = await ctx.deps.db.first<{ m: number | null }>('SELECT MAX(position) AS m FROM next_steps WHERE project_id = ?', [p.id]);
      const now = nowIso(ctx);
      const stmts: Stmt[] = [];
      if (a.is_primary) stmts.push({ sql: 'UPDATE next_steps SET is_primary = 0 WHERE project_id = ?', params: [p.id] });
      stmts.push(
        {
          sql: `INSERT INTO next_steps (id, project_id, position, title, assignee, due_date, needs_decision, is_primary, origin, basis, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual', 'manual', ?, ?)`,
          params: [newId('s_'), p.id, a.is_primary ? 0 : (max?.m ?? 0) + 1, a.title, a.assignee ?? '', a.due_date ?? null, a.needs_decision ? 1 : 0, a.is_primary ? 1 : 0, now, now],
        },
        historyStmt(ctx, p.id, 'next_step', `Added next step: ${a.title}`),
      );
      await commit(ctx, p, stmts);
      return { message: `Added next step to "${p.name}".`, project_id: p.id };
    },
  }),

  update_next_step: op({
    summary: 'Edit a next step, mark it done, or make it the primary next action.',
    schema: z.object({
      project_id: pid,
      step_id: z.string(),
      title: text(300).min(1).optional(),
      assignee: text(80).optional(),
      due_date: date.nullable().optional(),
      needs_decision: z.boolean().optional(),
      is_primary: z.boolean().optional(),
      done: z.boolean().optional(),
    }),
    async run(ctx, a) {
      const p = await loadProject(ctx, a.project_id, 'edit');
      const s = await ctx.deps.db.first<NextStepRow>('SELECT * FROM next_steps WHERE id = ? AND project_id = ?', [a.step_id, p.id]);
      if (!s) throw notFound();
      const now = nowIso(ctx);
      const stmts: Stmt[] = [];
      if (a.is_primary) stmts.push({ sql: 'UPDATE next_steps SET is_primary = 0 WHERE project_id = ?', params: [p.id] });
      stmts.push({
        sql: `UPDATE next_steps SET title = ?, assignee = ?, due_date = ?, needs_decision = ?, is_primary = ?, done = ?, done_at = ?,
              origin = 'manual', updated_at = ? WHERE id = ?`,
        params: [
          a.title ?? s.title,
          a.assignee ?? s.assignee,
          a.due_date === undefined ? s.due_date : a.due_date,
          a.needs_decision === undefined ? s.needs_decision : a.needs_decision ? 1 : 0,
          a.is_primary === undefined ? s.is_primary : a.is_primary ? 1 : 0,
          a.done === undefined ? s.done : a.done ? 1 : 0,
          a.done === undefined ? s.done_at : a.done ? now : null,
          now,
          s.id,
        ],
      });
      if (s.origin === 'auto') stmts.push(overrideStmt(ctx, p.id, 'next_steps', 'Automatic next step edited manually'));
      stmts.push(historyStmt(ctx, p.id, 'next_step', a.done ? `Done: ${s.title}` : `Edited next step: ${a.title ?? s.title}`));
      await commit(ctx, p, stmts);
      return { message: a.done ? `Marked "${s.title}" done.` : 'Next step updated.', project_id: p.id };
    },
  }),

  delete_next_step: op({
    summary: 'Remove a next step.',
    schema: z.object({ project_id: pid, step_id: z.string() }),
    async run(ctx, a) {
      const p = await loadProject(ctx, a.project_id, 'edit');
      const s = await ctx.deps.db.first<NextStepRow>('SELECT * FROM next_steps WHERE id = ? AND project_id = ?', [a.step_id, p.id]);
      if (!s) throw notFound();
      const stmts: Stmt[] = [{ sql: 'DELETE FROM next_steps WHERE id = ?', params: [s.id] }, historyStmt(ctx, p.id, 'next_step', `Removed next step: ${s.title}`)];
      if (s.origin === 'auto') stmts.push(overrideStmt(ctx, p.id, 'next_steps', 'Automatic next step removed manually'));
      await commit(ctx, p, stmts);
      return { message: 'Removed.', project_id: p.id };
    },
  }),

  add_source: op({
    summary:
      'Attach a source to a tracked project: a URL (web page, GitHub file, Notion page — checked hourly when connected; ChatGPT/Google/claude.ai links are kept as reference-only) or a pasted dated snapshot.',
    schema: z.object({
      project_id: pid,
      url: text(2000).optional(),
      title: text(200).optional(),
      role: z.enum(['canonical', 'supporting', 'decision', 'workstream']).optional(),
      snapshot_text: text(100_000).optional(),
      as_of: date.optional(),
    }),
    async run(ctx, a) {
      const p = await loadProject(ctx, a.project_id, 'edit');
      if (!a.url && !a.snapshot_text) throw badRequest('Provide a URL or snapshot text.');
      const stmts = sourceInsert(ctx, p.id, a);
      stmts.push(historyStmt(ctx, p.id, 'source', `Added source: ${a.title || a.url || 'snapshot'}`));
      await commit(ctx, p, stmts);
      return { message: `Source added to "${p.name}".`, project_id: p.id };
    },
  }),

  remove_source: op({
    summary: 'Detach a source from a project.',
    schema: z.object({ project_id: pid, source_id: z.string() }),
    async run(ctx, a) {
      const p = await loadProject(ctx, a.project_id, 'edit');
      const s = await ctx.deps.db.first<{ title: string }>('SELECT title FROM sources WHERE id = ? AND project_id = ?', [a.source_id, p.id]);
      if (!s) throw notFound();
      await commit(ctx, p, [{ sql: 'DELETE FROM sources WHERE id = ?', params: [a.source_id] }, historyStmt(ctx, p.id, 'source', `Removed source: ${s.title}`)]);
      return { message: 'Source removed.', project_id: p.id };
    },
  }),

  add_dependency: op({
    summary: 'Record that a project depends on another project in the same space. Only add genuine dependencies.',
    schema: z.object({ project_id: pid, depends_on_id: z.string(), note: text(300).optional() }),
    async run(ctx, a) {
      const p = await loadProject(ctx, a.project_id, 'edit');
      const other = await getVisibleProject(ctx.deps.db, ctx.principal, a.depends_on_id);
      if (!other) throw notFound();
      if (other.id === p.id) throw badRequest('A project cannot depend on itself.');
      if (other.space !== p.space) throw badRequest('Dependencies must be within the same space (Personal and Work are kept separate).');
      if (await reaches(ctx, other.id, p.id)) throw badRequest('That would create a circular dependency.');
      const detail = { related_project_id: other.id, ...(bool(other.only_me) || bool(p.only_me) ? { owner_only: true } : {}) };
      await commit(ctx, p, [
        { sql: 'INSERT INTO dependencies (project_id, depends_on_id, note, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING', params: [p.id, other.id, a.note ?? '', nowIso(ctx)] },
        historyStmt(ctx, p.id, 'dependency', `Now depends on "${other.name}"`, detail),
      ]);
      return { message: `"${p.name}" now depends on "${other.name}".`, project_id: p.id };
    },
  }),

  remove_dependency: op({
    summary: 'Remove a dependency.',
    schema: z.object({ project_id: pid, depends_on_id: z.string() }),
    async run(ctx, a) {
      const p = await loadProject(ctx, a.project_id, 'edit');
      const other = await getVisibleProject(ctx.deps.db, ctx.principal, a.depends_on_id);
      if (!other) throw notFound();
      await commit(ctx, p, [
        { sql: 'DELETE FROM dependencies WHERE project_id = ? AND depends_on_id = ?', params: [p.id, other.id] },
        historyStmt(ctx, p.id, 'dependency', `No longer depends on "${other.name}"`, { related_project_id: other.id }),
      ]);
      return { message: 'Dependency removed.', project_id: p.id };
    },
  }),

  release_override: op({
    summary: 'Release a manual override so automatic updates may change that field again.',
    schema: z.object({ project_id: pid, field: z.string() }),
    async run(ctx, a) {
      const p = await loadProject(ctx, a.project_id, 'edit');
      const r = await ctx.deps.db.first('SELECT field FROM overrides WHERE project_id = ? AND field = ?', [p.id, a.field]);
      if (!r) return { message: 'No override on that field.', project_id: p.id };
      await commit(ctx, p, [
        { sql: 'DELETE FROM overrides WHERE project_id = ? AND field = ?', params: [p.id, a.field] },
        historyStmt(ctx, p.id, 'override', `Released manual override: ${a.field}`),
      ]);
      return { message: `Override on ${a.field} released.`, project_id: p.id };
    },
  }),

  resolve_suggestion: op({
    summary: 'Accept or dismiss a pending suggestion (deadline found in a source, proposed milestone, dependency, or an automatic change blocked by your override).',
    schema: z.object({ project_id: pid, suggestion_id: z.string(), accept: z.boolean() }),
    async run(ctx, a) {
      const p = await loadProject(ctx, a.project_id, 'edit');
      const s = await ctx.deps.db.first<{ id: string; kind: string; payload: string; rationale: string }>(
        "SELECT id, kind, payload, rationale FROM suggestions WHERE id = ? AND project_id = ? AND status = 'pending'",
        [a.suggestion_id, p.id],
      );
      if (!s) throw notFound();
      if (s.kind === 'dependency' && !ctx.principal.isOwner) throw notFound();
      const payload = parseJson<Record<string, unknown>>(s.payload, {});
      const now = nowIso(ctx);
      const stmts: Stmt[] = [
        { sql: 'UPDATE suggestions SET status = ?, resolved_at = ?, resolved_by = ? WHERE id = ?', params: [a.accept ? 'accepted' : 'dismissed', now, ctx.principal.name, s.id] },
      ];
      let summary = `Dismissed suggestion: ${s.rationale}`;
      if (a.accept) {
        summary = `Accepted suggestion: ${s.rationale}`;
        if (s.kind === 'deadline') {
          const m = await getMilestone(ctx, p.id, String(payload.milestone_id));
          stmts.push({ sql: 'UPDATE milestones SET deadline = ?, deadline_note = ?, updated_at = ? WHERE id = ?', params: [payload.date, `Confirmed from source: “${payload.quote ?? ''}”`, now, m.id] });
        } else if (s.kind === 'milestone') {
          const max = await ctx.deps.db.first<{ m: number | null }>('SELECT MAX(position) AS m FROM milestones WHERE project_id = ?', [p.id]);
          stmts.push({
            sql: 'INSERT INTO milestones (id, project_id, position, title, description, weight, confirmed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)',
            params: [newId('m_'), p.id, (max?.m ?? 0) + 1, String(payload.title), String(payload.description ?? ''), Number(payload.weight) || 1, now, now],
          });
        } else if (s.kind === 'dependency') {
          const other = await getVisibleProject(ctx.deps.db, ctx.principal, String(payload.depends_on_id));
          if (other && other.space === p.space && other.id !== p.id && !(await reaches(ctx, other.id, p.id))) {
            stmts.push({ sql: 'INSERT INTO dependencies (project_id, depends_on_id, note, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING', params: [p.id, other.id, String(payload.quote ?? ''), now] });
          }
        } else if (s.kind === 'override_conflict') {
          stmts.push(...applyOverrideConflict(p.id, payload, now));
        }
      }
      stmts.push(historyStmt(ctx, p.id, 'suggestion', summary, s.kind === 'dependency' ? { owner_only: true } : {}));
      await commit(ctx, p, stmts);
      return { message: a.accept ? 'Suggestion accepted.' : 'Suggestion dismissed.', project_id: p.id };
    },
  }),
} as const;

export type OpName = keyof typeof OPS;
export const OP_NAMES = Object.keys(OPS) as OpName[];

function applyOverrideConflict(projectId: string, payload: Record<string, unknown>, now: string): Stmt[] {
  const field = String(payload.field ?? '');
  const out: Stmt[] = [{ sql: 'DELETE FROM overrides WHERE project_id = ? AND field = ?', params: [projectId, field] }];
  if ((AUTO_PROJECT_FIELDS as readonly string[]).includes(field)) {
    out.push({ sql: `UPDATE projects SET ${field} = ?${field.startsWith('status') ? ", status_basis = 'suggestion'" : ''} WHERE id = ?`, params: [String(payload.value ?? ''), projectId] });
  }
  const m = field.match(/^milestone:([^:]+):state$/);
  if (m && ['not_started', 'in_progress', 'done'].includes(String(payload.value))) {
    out.push({
      sql: "UPDATE milestones SET state = ?, evidence = COALESCE(?, evidence), evidence_basis = CASE WHEN ? = 'done' THEN 'auto_evidence' ELSE evidence_basis END, completed_at = CASE WHEN ? = 'done' THEN ? ELSE NULL END, updated_at = ? WHERE id = ? AND project_id = ?",
      params: [payload.value, payload.evidence ?? null, payload.value, payload.value, now, now, m[1], projectId],
    });
  }
  return out;
}

async function reaches(ctx: OpCtx, from: string, target: string): Promise<boolean> {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === target) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const rows = await ctx.deps.db.all<{ d: string }>('SELECT depends_on_id AS d FROM dependencies WHERE project_id = ?', [cur]);
    stack.push(...rows.map((r) => r.d));
  }
  return false;
}

export function sourceInsert(
  ctx: Pick<OpCtx, 'deps'>,
  projectId: string,
  a: { url?: string; title?: string; role?: string; snapshot_text?: string; as_of?: string },
): Stmt[] {
  const now = ctx.deps.now().toISOString();
  if (a.snapshot_text) {
    return [
      {
        sql: `INSERT INTO sources (id, project_id, kind, role, title, url, snapshot_text, as_of, connection, created_at, updated_at)
              VALUES (?, ?, 'snapshot', ?, ?, ?, ?, ?, 'connected', ?, ?)`,
        params: [newId('src_'), projectId, a.role ?? 'supporting', a.title || `Snapshot ${a.as_of ?? hkDate(ctx.deps.now())}`, a.url ?? '', a.snapshot_text, a.as_of ?? hkDate(ctx.deps.now()), now, now],
      },
    ];
  }
  const c = classifyUrl(a.url!, ctx.deps.config);
  return [
    {
      sql: `INSERT INTO sources (id, project_id, kind, role, title, url, config, connection, last_error, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [newId('src_'), projectId, c.kind, a.role ?? 'supporting', a.title || safeHost(a.url!), a.url, JSON.stringify(c.config), c.connection, c.note, now, now],
    },
  ];
}

function safeHost(u: string) {
  try {
    const url = new URL(u);
    return url.hostname + (url.pathname.length > 1 ? url.pathname : '');
  } catch {
    return u.slice(0, 80);
  }
}

/** Validates arguments and runs an operation, retrying once on an internal version race. */
export async function executeOp(ctx: OpCtx, name: string, rawArgs: unknown): Promise<OpResult> {
  const def = (OPS as Record<string, OpDef<z.ZodType>>)[name];
  if (!def) throw badRequest(`Unknown operation: ${name}`);
  const parsed = def.schema.safeParse(rawArgs ?? {});
  if (!parsed.success) throw badRequest(parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '));
  for (let attempt = 0; ; attempt++) {
    try {
      return await def.run(ctx, parsed.data);
    } catch (err) {
      if (err instanceof HttpError && err.code === CONFLICT_RETRY) {
        if (attempt < 2) continue;
        throw conflict();
      }
      throw err;
    }
  }
}

export function opSchemas(): Record<string, { summary: string; schema: z.ZodType }> {
  return Object.fromEntries(Object.entries(OPS).map(([k, v]) => [k, { summary: v.summary, schema: v.schema as z.ZodType }]));
}

/** Spaces a principal may create projects in (owner only). */
export function creatableSpaces(p: Principal): Space[] {
  return canOwnerWrite(p) ? ['personal', 'work'] : [];
}
