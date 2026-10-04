// Scoped data access. Every query that returns project data is filtered by
// projectScope(principal) inside SQL, so restricted projects never leave the database
// layer for users who may not see them.
import type {
  Citation,
  DependencyDTO,
  HistoryDTO,
  Lifecycle,
  MilestoneDTO,
  ProjectDetail,
  SourceDTO,
  Space,
  SuggestionDTO,
  Tile,
} from '../shared/types';
import { canEdit, projectScope, type Principal } from './auth/principal';
import type { Db } from './db';
import { attentionLevel, computeFlags, effectiveDate, freshness, nextMilestone, orderGroup, sourceStatusNote } from './domain/attention';
import { checklistOf, computeProgress, milestoneCompletion } from './domain/progress';
import type { IssueRow, MilestoneRow, NextStepRow, OverrideRow, ProjectBundle, ProjectRow, SourceRow, SuggestionRow } from './rows';
import { bool, parseJson } from './util';

export interface BundleFilter {
  space?: Space;
  lifecycles?: Lifecycle[];
  ids?: string[];
}

function filterSql(principal: Principal, f: BundleFilter): { sql: string; params: unknown[] } {
  const scope = projectScope(principal, 'p');
  const parts = [scope.sql];
  const params = [...scope.params];
  if (f.space) {
    parts.push('p.space = ?');
    params.push(f.space);
  }
  if (f.lifecycles?.length) {
    parts.push(`p.lifecycle IN (${f.lifecycles.map(() => '?').join(', ')})`);
    params.push(...f.lifecycles);
  }
  if (f.ids) {
    if (f.ids.length === 0) parts.push('0 = 1');
    else {
      parts.push(`p.id IN (${f.ids.map(() => '?').join(', ')})`);
      params.push(...f.ids);
    }
  }
  return { sql: parts.join(' AND '), params };
}

/** Projects with all child records, restricted to what `principal` may see. */
export async function loadBundles(db: Db, principal: Principal, f: BundleFilter): Promise<ProjectBundle[]> {
  const w = filterSql(principal, f);
  const child = <T>(table: string, extra = '') =>
    db.all<T>(`SELECT c.* FROM ${table} c JOIN projects p ON p.id = c.project_id WHERE ${w.sql} ${extra}`, w.params);
  const suggestionKinds = principal.isOwner ? "('deadline','dependency','milestone','override_conflict')" : "('deadline','milestone','override_conflict')";
  const [projects, milestones, steps, issues, sources, overrides, sugg] = await Promise.all([
    db.all<ProjectRow>(`SELECT p.* FROM projects p WHERE ${w.sql}`, w.params),
    child<MilestoneRow>('milestones', 'ORDER BY c.position'),
    child<NextStepRow>('next_steps', 'ORDER BY c.position'),
    child<IssueRow>('issues', 'ORDER BY c.created_at'),
    child<SourceRow>('sources', 'ORDER BY c.created_at'),
    child<OverrideRow>('overrides'),
    db.all<{ project_id: string; n: number }>(
      `SELECT c.project_id, COUNT(*) AS n FROM suggestions c JOIN projects p ON p.id = c.project_id
       WHERE ${w.sql} AND c.status = 'pending' AND c.kind IN ${suggestionKinds} GROUP BY c.project_id`,
      w.params,
    ),
  ]);
  const by = <T extends { project_id: string }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) (m.get(r.project_id) ?? m.set(r.project_id, []).get(r.project_id)!).push(r);
    return m;
  };
  const [mm, sm, im, srm, om] = [by(milestones), by(steps), by(issues), by(sources), by(overrides)];
  const sg = new Map(sugg.map((r) => [r.project_id, Number(r.n)]));
  return projects.map((project) => ({
    project,
    milestones: mm.get(project.id) ?? [],
    steps: sm.get(project.id) ?? [],
    issues: im.get(project.id) ?? [],
    sources: srm.get(project.id) ?? [],
    overrides: om.get(project.id) ?? [],
    pendingSuggestions: sg.get(project.id) ?? 0,
  }));
}

/** Returns the project only if `principal` may see it; callers turn null into 404. */
export async function getVisibleProject(db: Db, principal: Principal, id: string): Promise<ProjectRow | null> {
  const scope = projectScope(principal, 'p');
  return db.first<ProjectRow>(`SELECT p.* FROM projects p WHERE p.id = ? AND ${scope.sql}`, [id, ...scope.params]);
}

export async function getBundle(db: Db, principal: Principal, id: string): Promise<ProjectBundle | null> {
  const [b] = await loadBundles(db, principal, { ids: [id] });
  return b ?? null;
}

export function toTile(b: ProjectBundle, principal: Principal, today: string, now: Date): Tile {
  const p = b.project;
  const flags = computeFlags(b, today, { showSuggestions: canEdit(principal, p.space), now });
  const nm = nextMilestone(b.milestones);
  const nd = nm ? effectiveDate(nm, today) : null;
  const openSteps = b.steps.filter((s) => !s.done);
  const primary = openSteps.find((s) => s.is_primary) ?? openSteps[0] ?? null;
  const blockers = b.issues.filter((i) => i.kind === 'blocker' && !i.resolved);
  const sevRank = { high: 0, medium: 1, low: 2 };
  const topBlocker = blockers.sort((x, y) => sevRank[x.severity] - sevRank[y.severity])[0] ?? null;
  return {
    id: p.id,
    space: p.space,
    name: p.name,
    phrase: p.phrase,
    status: p.status,
    status_summary: p.status_summary,
    status_basis: p.status_basis,
    priority: p.priority,
    pinned: bool(p.pinned),
    only_me: principal.isOwner ? bool(p.only_me) : false,
    lifecycle: p.lifecycle,
    canonical_url: p.canonical_url,
    progress: computeProgress(b.milestones),
    next_action: primary
      ? { title: primary.title, assignee: primary.assignee, due_date: primary.due_date, needs_decision: bool(primary.needs_decision), basis: primary.basis }
      : null,
    next_milestone: nm ? { id: nm.id, title: nm.title, date: nd, proposed: nm.confirmed !== 1 } : null,
    blocker: topBlocker ? { title: topBlocker.title, severity: topBlocker.severity, basis: topBlocker.basis } : null,
    flags,
    attention: attentionLevel(flags),
    freshness: freshness(b, now),
    order_group: orderGroup(b, flags, nd),
    version: p.version,
    updated_at: p.updated_at,
  };
}

function citations(s: string, sources: SourceRow[]): Citation[] {
  const list = parseJson<Citation[]>(s, []);
  return (Array.isArray(list) ? list : []).map((c) => ({
    ...c,
    source_title: sources.find((x) => x.id === c.source_id)?.title ?? c.source_title,
  }));
}

export function toMilestoneDTO(m: MilestoneRow, overrides: OverrideRow[], today: string): MilestoneDTO {
  return {
    id: m.id,
    position: m.position,
    title: m.title,
    description: m.description,
    weight: m.weight,
    state: m.state,
    confirmed: m.confirmed === 1,
    evidence: m.evidence,
    evidence_basis: m.evidence_basis,
    evidence_source_id: m.evidence_source_id,
    completed_at: m.completed_at,
    checklist: checklistOf(m),
    deadline: m.deadline,
    deadline_note: m.deadline_note,
    target_date: m.target_date,
    suggested_date: m.suggested_date,
    suggested_basis: m.suggested_basis,
    effective_date: effectiveDate(m, today),
    completion: milestoneCompletion(m),
    overridden: overrides.filter((o) => o.field.startsWith(`milestone:${m.id}:`)).map((o) => o.field.split(':')[2]),
  };
}

export function toSourceDTO(s: SourceRow): SourceDTO {
  return {
    id: s.id,
    kind: s.kind,
    role: s.role,
    title: s.title,
    url: s.url,
    as_of: s.as_of,
    snapshot_text: s.snapshot_text,
    connection: s.connection,
    status_note: sourceStatusNote(s),
    last_checked_at: s.last_checked_at,
    last_success_at: s.last_success_at,
    last_changed_at: s.last_changed_at,
    last_error: s.last_error,
  };
}

async function scopedDependencies(db: Db, principal: Principal, projectId: string, direction: 'out' | 'in'): Promise<DependencyDTO[]> {
  const scope = projectScope(principal, 'o');
  const [mine, other] = direction === 'out' ? ['project_id', 'depends_on_id'] : ['depends_on_id', 'project_id'];
  return db.all<DependencyDTO>(
    `SELECT o.id AS project_id, o.name, o.status, o.lifecycle, d.note
       FROM dependencies d JOIN projects o ON o.id = d.${other}
      WHERE d.${mine} = ? AND ${scope.sql}
      ORDER BY o.name`,
    [projectId, ...scope.params],
  );
}

export async function visibleProjectIds(db: Db, principal: Principal): Promise<Set<string>> {
  const scope = projectScope(principal, 'p');
  const rows = await db.all<{ id: string }>(`SELECT p.id FROM projects p WHERE ${scope.sql}`, scope.params);
  return new Set(rows.map((r) => r.id));
}

export async function loadHistory(db: Db, principal: Principal, projectId: string, limit = 60): Promise<HistoryDTO[]> {
  const rows = await db.all<{ id: string; at: string; actor_type: HistoryDTO['actor_type']; actor_label: string; kind: string; summary: string; detail: string }>(
    'SELECT id, at, actor_type, actor_label, kind, summary, detail FROM history WHERE project_id = ? ORDER BY at DESC, rowid DESC LIMIT ?',
    [projectId, limit],
  );
  const visible = principal.isOwner ? null : await visibleProjectIds(db, principal);
  const out: HistoryDTO[] = [];
  for (const r of rows) {
    const detail = parseJson<Record<string, unknown>>(r.detail, {});
    if (!principal.isOwner) {
      if (detail.owner_only) continue;
      const related = detail.related_project_id;
      if (typeof related === 'string' && !visible!.has(related)) continue;
    }
    out.push({ ...r, detail });
  }
  return out;
}

export async function toDetail(db: Db, principal: Principal, b: ProjectBundle, today: string, now: Date): Promise<ProjectDetail> {
  const p = b.project;
  const editable = canEdit(principal, p.space);
  const [dependsOn, dependents, history, suggestions] = await Promise.all([
    scopedDependencies(db, principal, p.id, 'out'),
    scopedDependencies(db, principal, p.id, 'in'),
    loadHistory(db, principal, p.id),
    editable
      ? db.all<SuggestionRow>(
          `SELECT * FROM suggestions WHERE project_id = ? AND status = 'pending' ${principal.isOwner ? '' : "AND kind <> 'dependency'"} ORDER BY created_at`,
          [p.id],
        )
      : Promise.resolve([] as SuggestionRow[]),
  ]);
  const tile = toTile(b, principal, today, now);
  return {
    ...tile,
    status_detail: p.status_detail,
    needs_attention: bool(p.needs_attention),
    attention_note: p.attention_note,
    needs_review: bool(p.needs_review),
    created_at: p.created_at,
    milestones: [...b.milestones].sort((x, y) => x.position - y.position).map((m) => toMilestoneDTO(m, b.overrides, today)),
    next_steps: b.steps.map((s) => ({
      id: s.id,
      title: s.title,
      assignee: s.assignee,
      due_date: s.due_date,
      needs_decision: bool(s.needs_decision),
      is_primary: bool(s.is_primary),
      done: bool(s.done),
      origin: s.origin,
      basis: s.basis,
      citation: citations(s.citation, b.sources),
    })),
    issues: b.issues.map((i) => ({
      id: i.id,
      kind: i.kind,
      title: i.title,
      detail: i.detail,
      severity: i.severity,
      resolved: bool(i.resolved),
      origin: i.origin,
      basis: i.basis,
      citation: citations(i.citation, b.sources),
      created_at: i.created_at,
    })),
    sources: b.sources.map(toSourceDTO),
    depends_on: dependsOn,
    dependents,
    overrides: b.overrides.map((o) => ({ field: o.field, set_by: o.set_by, set_at: o.set_at, note: o.note })),
    suggestions: suggestions.map(
      (s): SuggestionDTO => ({
        id: s.id,
        kind: s.kind,
        payload: parseJson(s.payload, {}),
        rationale: s.rationale,
        citation: citations(s.citation, b.sources),
        created_at: s.created_at,
      }),
    ),
    history,
    can_edit: editable,
    is_owner: principal.isOwner,
  };
}
