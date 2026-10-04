// Refresh orchestration: checks tracked sources, detects changes by content hash,
// asks the LLM (when configured) for grounded proposals and applies them.
//
// Safety properties:
//  - Idempotent: every run has a unique idem_key (e.g. cron:2026-10-04T23); a retried
//    trigger with the same key returns the existing run instead of running twice.
//  - Exclusive: a lease lock prevents two refreshes running concurrently.
//  - Atomic per project: applied changes, new source hashes and history are written in
//    one batch guarded by the project version; a concurrent manual edit forces a re-plan
//    against the fresh overrides.
//  - Honest: unchanged sources produce no edits ("checked, no changes"); failing sources
//    keep the last known state and are flagged; without an LLM nothing is inferred.
import type { Deps } from '../config';
import { isGuardFailure, versionGuard, type Stmt } from '../db';
import { systemPrincipal } from '../auth/principal';
import type { ProjectBundle, SourceRow } from '../rows';
import { loadBundles } from '../repo';
import { hkDate } from '../time';
import { clip, mapLimit, newId, sha256Hex } from '../util';
import { planApply } from './apply';
import type { SourceChange, UpdateInput } from './llm';
import { fetchSource, lineDiff, type FetchOutcome } from './sources';

export interface RefreshStats {
  projects: number;
  sources_checked: number;
  sources_changed: number;
  sources_failed: number;
  projects_updated: number;
  llm_calls: number;
  llm_errors: number;
  deferred: number;
}

export interface RefreshResult {
  run_id: string;
  status: 'running' | 'succeeded' | 'partial' | 'failed' | 'skipped';
  duplicate: boolean;
  stats: RefreshStats;
  error?: string;
}

const LOCK_MS = 14 * 60_000;

export async function acquireLock(deps: Deps, name: string, holder: string, ms = LOCK_MS): Promise<boolean> {
  const now = deps.now();
  const r = await deps.db.run(
    `INSERT INTO locks (name, holder, expires_at) VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at
     WHERE locks.expires_at < ?`,
    [name, holder, new Date(now.getTime() + ms).toISOString(), now.toISOString()],
  );
  return r.changes === 1;
}

export async function releaseLock(deps: Deps, name: string, holder: string) {
  await deps.db.run('DELETE FROM locks WHERE name = ? AND holder = ?', [name, holder]);
}

const emptyStats = (): RefreshStats => ({ projects: 0, sources_checked: 0, sources_changed: 0, sources_failed: 0, projects_updated: 0, llm_calls: 0, llm_errors: 0, deferred: 0 });

function needsCheck(s: SourceRow): boolean {
  if (s.kind === 'reference') return false;
  if (s.kind === 'notion' && s.connection === 'needs_setup') return true; // re-check once credentials exist
  return true;
}

export async function runRefresh(
  deps: Deps,
  opts: { trigger: 'cron' | 'manual' | 'api'; idemKey: string; requestedBy?: string; projectIds?: string[] },
): Promise<RefreshResult> {
  const db = deps.db;
  const runId = newId('run_');
  const startedAt = deps.now().toISOString();
  const ins = await db.run(
    `INSERT INTO refresh_runs (id, trigger, idem_key, requested_by, started_at, status) VALUES (?, ?, ?, ?, ?, 'running')
     ON CONFLICT(idem_key) DO NOTHING`,
    [runId, opts.trigger, opts.idemKey, opts.requestedBy ?? null, startedAt],
  );
  if (ins.changes === 0) {
    const existing = await db.first<{ id: string; status: RefreshResult['status']; stats: string; error: string }>(
      'SELECT id, status, stats, error FROM refresh_runs WHERE idem_key = ?',
      [opts.idemKey],
    );
    return { run_id: existing!.id, status: existing!.status, duplicate: true, stats: { ...emptyStats(), ...JSON.parse(existing!.stats || '{}') }, error: existing!.error };
  }

  const stats = emptyStats();
  if (!(await acquireLock(deps, 'refresh', runId))) {
    await db.run("UPDATE refresh_runs SET status = 'skipped', finished_at = ?, error = ? WHERE id = ?", [deps.now().toISOString(), 'Another refresh was already running', runId]);
    return { run_id: runId, status: 'skipped', duplicate: false, stats, error: 'Another refresh was already running' };
  }

  let status: RefreshResult['status'] = 'succeeded';
  let error = '';
  try {
    const sys = systemPrincipal();
    const bundles = await loadBundles(db, sys, { lifecycles: ['active', 'paused'], ids: opts.projectIds });
    const work = bundles
      .flatMap((b) => b.sources.filter(needsCheck).map((s) => ({ b, s })))
      .sort((x, y) => (x.s.last_checked_at ?? '').localeCompare(y.s.last_checked_at ?? ''));
    const chosen = work.slice(0, deps.config.sourceBudget);
    stats.deferred = work.length - chosen.length;
    const fetched = await mapLimit(chosen, 6, async ({ b, s }) => ({ b, s, out: await fetchSource(s, deps) }));
    stats.sources_checked = fetched.length;

    const byProject = new Map<string, { b: ProjectBundle; items: { s: SourceRow; out: FetchOutcome }[] }>();
    for (const f of fetched) {
      const g = byProject.get(f.b.project.id) ?? byProject.set(f.b.project.id, { b: f.b, items: [] }).get(f.b.project.id)!;
      g.items.push({ s: f.s, out: f.out });
    }
    stats.projects = byProject.size;
    const otherProjects = (space: string, id: string) => bundles.filter((x) => x.project.space === space && x.project.id !== id).map((x) => ({ id: x.project.id, name: x.project.name }));

    await mapLimit([...byProject.values()], 3, (g) => processProject(deps, runId, g.b, g.items, stats, otherProjects(g.b.project.space, g.b.project.id)));
    if (stats.sources_failed || stats.llm_errors) status = 'partial';
  } catch (err) {
    status = 'failed';
    error = String((err as Error)?.message ?? err).slice(0, 500);
  } finally {
    await db.run('UPDATE refresh_runs SET status = ?, finished_at = ?, stats = ?, error = ? WHERE id = ?', [status, deps.now().toISOString(), JSON.stringify(stats), error, runId]);
    await releaseLock(deps, 'refresh', runId);
  }
  return { run_id: runId, status, duplicate: false, stats, error: error || undefined };
}

function historyStmt(projectId: string, at: string, kind: string, summary: string, detail: Record<string, unknown>, runId: string, actor = 'auto'): Stmt {
  return {
    sql: `INSERT INTO history (id, project_id, at, actor_type, actor_label, kind, summary, detail, run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [newId('h_'), projectId, at, actor, actor === 'auto' ? 'Automatic update' : 'System', kind, summary, JSON.stringify(detail), runId],
  };
}

async function processProject(
  deps: Deps,
  runId: string,
  bundle: ProjectBundle,
  items: { s: SourceRow; out: FetchOutcome }[],
  stats: RefreshStats,
  otherProjects: { id: string; name: string }[],
): Promise<void> {
  const db = deps.db;
  const now = deps.now().toISOString();
  const today = hkDate(deps.now());
  const p = bundle.project;
  const statusStmts: Stmt[] = [];
  const changes: SourceChange[] = [];
  const changeStmts: Stmt[] = [];

  for (const { s, out } of items) {
    if (!out.ok) {
      stats.sources_failed++;
      statusStmts.push({
        sql: 'UPDATE sources SET connection = ?, last_error = ?, last_checked_at = ?, consecutive_failures = consecutive_failures + 1, updated_at = ? WHERE id = ?',
        params: [out.connection, clip(out.error, 400), now, now, s.id],
      });
      if (s.connection !== out.connection || s.last_error !== clip(out.error, 400)) {
        statusStmts.push(historyStmt(p.id, now, 'source', `Source unavailable: ${s.title} — ${clip(out.error, 160)}. Last known state kept.`, { source_id: s.id }, runId, 'system'));
      }
      continue;
    }
    const hash = await sha256Hex(out.text);
    const recovered = s.connection === 'error' || s.connection === 'needs_setup';
    if (hash === s.content_hash) {
      statusStmts.push({
        sql: "UPDATE sources SET connection = 'connected', last_error = '', consecutive_failures = 0, last_checked_at = ?, last_success_at = ?, updated_at = ? WHERE id = ?",
        params: [now, now, now, s.id],
      });
      if (recovered) statusStmts.push(historyStmt(p.id, now, 'source', `Source available again: ${s.title} (no changes)`, { source_id: s.id }, runId, 'system'));
      continue;
    }
    stats.sources_changed++;
    const prev = await db.first<{ text: string }>('SELECT text FROM source_content WHERE source_id = ?', [s.id]);
    const diff = prev ? lineDiff(prev.text, out.text) : { added: [], removed: [] };
    changes.push({ source_id: s.id, title: s.title, kind: s.kind, as_of: s.as_of, first_time: !prev, added: diff.added.slice(0, 400), removed: diff.removed.slice(0, 400), text: out.text, truncated: out.truncated });
    changeStmts.push(
      {
        sql: "UPDATE sources SET content_hash = ?, connection = 'connected', last_error = '', consecutive_failures = 0, last_checked_at = ?, last_success_at = ?, last_changed_at = ?, updated_at = ? WHERE id = ?",
        params: [hash, now, now, now, now, s.id],
      },
      {
        sql: `INSERT INTO source_content (source_id, content_hash, text, fetched_at, truncated) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(source_id) DO UPDATE SET content_hash = excluded.content_hash, text = excluded.text, fetched_at = excluded.fetched_at, truncated = excluded.truncated`,
        params: [s.id, hash, out.text, now, out.truncated ? 1 : 0],
      },
    );
  }

  // Source health + "checked" timestamp (no project content changes).
  statusStmts.push({ sql: 'UPDATE projects SET last_checked_at = ? WHERE id = ?', params: [now, p.id] });
  await db.batch(statusStmts);
  if (!changes.length) return;

  const changedTitles = changes.map((c) => c.title).join(', ');
  const diffNote = changes.map((c) => (c.first_time ? `${c.title}: first read` : `${c.title}: +${c.added.length}/−${c.removed.length} lines`)).join('; ');

  if (!deps.llm) {
    await commitWithGuard(deps, p.id, p.version, [
      ...changeStmts,
      { sql: 'UPDATE projects SET needs_review = 1 WHERE id = ?', params: [p.id] },
      historyStmt(p.id, now, 'auto_update', `Source changed (${diffNote}). Automatic summarisation is not configured, so nothing was inferred — please review.`, { sources: changes.map((c) => ({ id: c.source_id, title: c.title })) }, runId),
    ]);
    stats.projects_updated++;
    return;
  }

  let proposal;
  try {
    stats.llm_calls++;
    proposal = await deps.llm.proposeUpdate(buildInput(bundle, changes, today, otherProjects));
  } catch (err) {
    stats.llm_errors++;
    const msg = clip(String((err as Error)?.message ?? err), 200);
    // Source hashes are NOT advanced, so the next hourly run retries the summary.
    await commitWithGuard(deps, p.id, p.version, [
      { sql: 'UPDATE projects SET needs_review = 1 WHERE id = ?', params: [p.id] },
      ...(p.needs_review ? [] : [historyStmt(p.id, now, 'auto_update', `Source changed (${changedTitles}) but the automatic summary failed: ${msg}. It will be retried next hour.`, {}, runId)]),
    ]).catch(() => undefined);
    return;
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const fresh = attempt === 0 ? bundle : (await loadBundles(db, systemPrincipal(), { ids: [p.id] }))[0];
    if (!fresh) return;
    const deps2 = await db.all<{ d: string }>('SELECT depends_on_id AS d FROM dependencies WHERE project_id = ?', [p.id]);
    const plan = planApply({ bundle: fresh, proposal, changes, today, now, runId, otherProjects, existingDeps: new Set(deps2.map((r) => r.d)) });
    const summary = plan.material
      ? proposal.change_summary || `Sources updated: ${changedTitles}`
      : `Checked ${changedTitles}: source text changed but nothing material for this project.`;
    const hist = historyStmt(
      p.id,
      now,
      'auto_update',
      summary,
      { applied: plan.applied, suppressed: plan.suppressed, citations: plan.citations, sources: changes.map((c) => ({ id: c.source_id, title: c.title, diff: c.first_time ? 'first read' : `+${c.added.length}/−${c.removed.length}` })), model: deps.llm.model },
      runId,
    );
    try {
      await commitWithGuard(deps, p.id, fresh.project.version, [...plan.stmts, ...changeStmts, hist]);
      stats.projects_updated++;
      return;
    } catch (err) {
      if (!isGuardFailure(err) || attempt === 2) throw err;
    }
  }
}

async function commitWithGuard(deps: Deps, projectId: string, version: number, stmts: Stmt[]) {
  await deps.db.batch([
    versionGuard(projectId, version),
    ...stmts,
    { sql: 'UPDATE projects SET version = version + 1, updated_at = ? WHERE id = ?', params: [deps.now().toISOString(), projectId] },
  ]);
}

export function buildInput(b: ProjectBundle, changes: SourceChange[], today: string, otherProjects: { id: string; name: string }[]): UpdateInput {
  const p = b.project;
  return {
    today,
    project: { id: p.id, name: p.name, space: p.space, phrase: p.phrase, status: p.status, status_summary: p.status_summary, status_detail: p.status_detail, lifecycle: p.lifecycle },
    milestones: [...b.milestones]
      .sort((x, y) => x.position - y.position)
      .map((m) => ({ id: m.id, title: m.title, description: m.description, state: m.state, confirmed: m.confirmed === 1, weight: m.weight, evidence: m.evidence, deadline: m.deadline, target_date: m.target_date, suggested_date: m.suggested_date })),
    next_steps: b.steps.filter((s) => !s.done).map((s) => ({ title: s.title, assignee: s.assignee, origin: s.origin, primary: s.is_primary === 1 })),
    issues: b.issues.filter((i) => !i.resolved).map((i) => ({ kind: i.kind, title: i.title, origin: i.origin })),
    overridden_fields: b.overrides.map((o) => o.field),
    other_projects: otherProjects,
    changes,
  };
}

export async function latestRun(deps: Deps) {
  return deps.db.first<{ id: string; trigger: string; status: string; started_at: string; finished_at: string | null; stats: string; error: string }>(
    'SELECT id, trigger, status, started_at, finished_at, stats, error FROM refresh_runs ORDER BY started_at DESC LIMIT 1',
  );
}
