// Dates, overdue handling, attention flags, freshness and dashboard ordering.
import type { DateInfo, Flag, Freshness, OrderGroup, Tile } from '../../shared/types';
import type { MilestoneRow, ProjectBundle, SourceRow } from '../rows';
import { daysBetween } from '../time';
import { clip } from '../util';

export const DUE_SOON_DAYS = 7;
export const STALE_AFTER_HOURS = 3;

/**
 * The best date for a milestone: the earliest of a confirmed deadline and a manual
 * target (a deadline wins ties); otherwise an AI-suggested date. Deadlines are only
 * ever changed by an explicit human edit, so an overdue deadline stays overdue.
 */
export function effectiveDate(m: MilestoneRow, today: string): DateInfo | null {
  const firm: DateInfo[] = [];
  if (m.deadline) firm.push(mk(m.deadline, 'deadline', today, m));
  if (m.target_date) firm.push(mk(m.target_date, 'target', today, m));
  if (firm.length) return firm.sort((a, b) => a.date.localeCompare(b.date) || (a.kind === 'deadline' ? -1 : 1))[0];
  if (m.suggested_date) return { ...mk(m.suggested_date, 'suggested', today, m), basis: m.suggested_basis };
  return null;
}

function mk(date: string, kind: DateInfo['kind'], today: string, m: MilestoneRow): DateInfo {
  const days = daysBetween(today, date);
  return { date, kind, days, overdue: days < 0 && m.state !== 'done' && kind !== 'suggested' };
}

export function nextMilestone(ms: MilestoneRow[]): MilestoneRow | null {
  const open = [...ms].sort((a, b) => a.position - b.position).filter((m) => m.state !== 'done');
  return open.find((m) => m.confirmed === 1) ?? open[0] ?? null;
}

const fmtDays = (d: number) => (d === 0 ? 'today' : d === 1 ? 'tomorrow' : d > 0 ? `in ${d} days` : `${-d} day${d === -1 ? '' : 's'} ago`);

export function computeFlags(b: ProjectBundle, today: string, opts: { showSuggestions: boolean; now: Date }): Flag[] {
  const flags: Flag[] = [];
  for (const m of b.milestones) {
    if (m.state === 'done') continue;
    if (m.deadline && m.deadline < today) {
      flags.push({ kind: 'overdue_deadline', severity: 'urgent', label: `Deadline passed: ${clip(m.title, 60)} (${fmtDays(daysBetween(today, m.deadline))})` });
    } else if (m.target_date && m.target_date < today) {
      flags.push({ kind: 'target_missed', severity: 'warn', label: `Target missed: ${clip(m.title, 60)} (${fmtDays(daysBetween(today, m.target_date))})` });
    }
  }
  for (const s of b.steps) {
    if (!s.done && s.due_date && s.due_date < today) {
      flags.push({ kind: 'step_overdue', severity: s.needs_decision ? 'urgent' : 'warn', label: `Overdue: ${clip(s.title, 60)}` });
    }
  }
  const blockers = b.issues.filter((i) => i.kind === 'blocker' && !i.resolved);
  if (b.project.status === 'blocked' || blockers.length) {
    const sev = b.project.status === 'blocked' || blockers.some((x) => x.severity === 'high') ? 'urgent' : 'warn';
    flags.push({ kind: 'blocked', severity: sev, label: blockers[0] ? `Blocked: ${clip(blockers[0].title, 70)}` : 'Blocked' });
  }
  for (const s of b.steps) {
    if (!s.done && s.needs_decision) flags.push({ kind: 'decision', severity: 'warn', label: `Decision needed: ${clip(s.title, 60)}` });
  }
  if (b.project.needs_attention) {
    flags.push({ kind: 'attention', severity: 'warn', label: b.project.attention_note ? clip(b.project.attention_note, 80) : 'Needs your attention' });
  }
  const nm = nextMilestone(b.milestones);
  const nd = nm ? effectiveDate(nm, today) : null;
  if (nm && nd && nd.kind !== 'suggested' && nd.days >= 0 && nd.days <= DUE_SOON_DAYS) {
    flags.push({ kind: 'due_soon', severity: 'info', label: `${nd.kind === 'deadline' ? 'Deadline' : 'Target'} ${fmtDays(nd.days)}: ${clip(nm.title, 50)}` });
  }
  const bad = b.sources.filter((s) => s.connection === 'error' || s.connection === 'needs_setup');
  if (bad.length) flags.push({ kind: 'source_error', severity: 'warn', label: `${bad.length} source${bad.length > 1 ? 's' : ''} unavailable — showing last known state` });
  else if (freshness(b, opts.now).state === 'stale') flags.push({ kind: 'stale', severity: 'info', label: 'Sources not checked recently' });
  if (b.project.needs_review) flags.push({ kind: 'needs_review', severity: 'info', label: 'Source changed — needs review' });
  if (opts.showSuggestions && b.pendingSuggestions > 0) {
    flags.push({ kind: 'suggestions', severity: 'info', label: `${b.pendingSuggestions} suggestion${b.pendingSuggestions > 1 ? 's' : ''} to review` });
  }
  return flags;
}

export function attentionLevel(flags: Flag[]): Tile['attention'] {
  if (flags.some((f) => f.severity === 'urgent')) return 'urgent';
  if (flags.some((f) => f.severity === 'warn')) return 'attention';
  return 'normal';
}

const ACTION_KINDS = new Set(['overdue_deadline', 'target_missed', 'step_overdue', 'blocked', 'decision', 'attention']);

export function orderGroup(b: ProjectBundle, flags: Flag[], nextDate: DateInfo | null): OrderGroup {
  if (b.project.pinned) return 'pinned';
  if (b.project.lifecycle === 'paused') return 'paused';
  if (flags.some((f) => ACTION_KINDS.has(f.kind))) return 'action';
  if (nextDate) return 'upcoming';
  return 'other';
}

const GROUP_RANK: Record<OrderGroup, number> = { pinned: 0, action: 1, upcoming: 2, other: 3, paused: 4 };
const PRIORITY_RANK = { high: 0, medium: 1, low: 2 } as const;

function actionScore(t: Tile): number {
  return t.flags.reduce((s, f) => s + (ACTION_KINDS.has(f.kind) ? (f.severity === 'urgent' ? 10 : 3) : 0), 0);
}

/** Pinned → needs my action (overdue/blocked/decisions) → upcoming milestones → the rest → paused. */
export function compareTiles(a: Tile, b: Tile): number {
  const g = GROUP_RANK[a.order_group] - GROUP_RANK[b.order_group];
  if (g) return g;
  const da = a.next_milestone?.date?.date ?? '9999-12-31';
  const db = b.next_milestone?.date?.date ?? '9999-12-31';
  switch (a.order_group) {
    case 'action': {
      const s = actionScore(b) - actionScore(a);
      if (s) return s;
      break;
    }
    case 'upcoming':
      if (da !== db) return da.localeCompare(db);
      break;
  }
  if (a.order_group !== 'pinned') {
    const p = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    if (p) return p;
  }
  if (da !== db) return da.localeCompare(db);
  return a.name.localeCompare(b.name);
}

const FETCHED_KINDS = new Set(['web', 'github', 'notion']);

export function freshness(b: Pick<ProjectBundle, 'project' | 'sources'>, now: Date): Freshness {
  const srcs = b.sources;
  const fetched = srcs.filter((s) => FETCHED_KINDS.has(s.kind));
  const problems = fetched.filter((s) => s.connection === 'error' || s.connection === 'needs_setup');
  const out: Freshness = {
    state: 'fresh',
    label: '',
    last_checked_at: b.project.last_checked_at,
    last_evidence_at: b.project.last_evidence_at,
    connected: fetched.filter((s) => s.connection === 'connected').length,
    reference_only: srcs.filter((s) => s.kind === 'reference').length,
    snapshots: srcs.filter((s) => s.kind === 'snapshot').length,
    problems: problems.length,
  };
  if (fetched.length === 0) {
    const snap = srcs.filter((s) => s.kind === 'snapshot' && s.as_of).sort((x, y) => (y.as_of ?? '').localeCompare(x.as_of ?? ''))[0];
    out.state = 'manual_only';
    out.label = snap ? `No live source · snapshot ${snap.as_of}` : out.reference_only ? 'Reference links only — not connected' : 'Manual updates only';
    return out;
  }
  if (problems.length) {
    out.state = 'error';
    out.label = `${problems.length} source${problems.length > 1 ? 's' : ''} unavailable · last known state shown`;
    return out;
  }
  const lastOk = latest(fetched.map((s) => s.last_success_at));
  if (!lastOk) {
    out.state = 'never_checked';
    out.label = 'Not checked yet';
    return out;
  }
  if (now.getTime() - Date.parse(lastOk) > STALE_AFTER_HOURS * 3_600_000) {
    out.state = 'stale';
    out.label = 'Stale — not checked recently';
    return out;
  }
  out.label = 'Live';
  return out;
}

function latest(xs: (string | null)[]): string | null {
  return xs.filter((x): x is string => Boolean(x)).sort().pop() ?? null;
}

export function sourceStatusNote(s: SourceRow): string {
  switch (s.connection) {
    case 'reference_only':
      return s.last_error || 'Reference link — this app cannot read it, so it is not checked automatically.';
    case 'needs_setup':
      return s.last_error || 'Needs credentials before it can be checked.';
    case 'error':
      return `Last check failed: ${s.last_error || 'unknown error'}. Showing last known state.`;
    case 'connected':
      return s.kind === 'snapshot' ? `Pasted snapshot as of ${s.as_of ?? 'unknown date'}.` : 'Connected — checked hourly.';
    default:
      return s.kind === 'snapshot' ? `Pasted snapshot as of ${s.as_of ?? 'unknown date'}.` : 'Not checked yet.';
  }
}
