// Daily summary at 07:00 Asia/Hong_Kong. Built per user from only the projects that
// user may see (owner summaries include "Only me" projects; nobody else's do), stored
// in-app, and optionally emailed via Resend. Generation is idempotent per user per HK
// date, and later hourly runs catch up if the 07:00 run was missed.
import type { SummaryContent, SummaryItem, SummaryResponse } from '../shared/types';
import { canEdit, principalForEmail, projectScope, type Principal } from './auth/principal';
import { emailConfigured, type Deps } from './config';
import { compareTiles, effectiveDate } from './domain/attention';
import type { ProjectBundle } from './rows';
import { loadBundles, toTile, visibleProjectIds } from './repo';
import { addDays, hkDate, hkParts } from './time';
import { clip, newId, parseJson } from './util';
import { runRefresh } from './updater/refresh';

export const SUMMARY_HOUR_HK = 7;
const UPCOMING_DAYS = 14;

export async function buildSummary(deps: Deps, principal: Principal, date: string): Promise<SummaryContent> {
  const now = deps.now();
  const bundles = await loadBundles(deps.db, principal, { lifecycles: ['active', 'paused'] });
  const out: SummaryContent = { hk_date: date, generated_at: now.toISOString(), overdue: [], priorities: [], upcoming: [], changes: [], decisions: [] };
  const item = (b: ProjectBundle, title: string, extra: Partial<SummaryItem> = {}): SummaryItem => ({ project_id: b.project.id, project_name: b.project.name, title, ...extra });

  for (const b of bundles) {
    for (const m of b.milestones) {
      if (m.state === 'done') continue;
      if (m.deadline && m.deadline < date) out.overdue.push(item(b, m.title, { kind: 'deadline', date: m.deadline, detail: 'Confirmed deadline passed' }));
      else if (m.target_date && m.target_date < date) out.overdue.push(item(b, m.title, { kind: 'target', date: m.target_date, detail: 'Your target date passed' }));
      const d = effectiveDate(m, date);
      if (d && d.days >= 0 && d.days <= UPCOMING_DAYS) {
        out.upcoming.push(item(b, m.title, { kind: d.kind, date: d.date, detail: d.kind === 'suggested' ? `Suggested date${d.basis ? ' — ' + clip(d.basis, 120) : ''}` : d.kind === 'deadline' ? 'Confirmed deadline' : 'Your target' }));
      }
    }
    for (const s of b.steps) {
      if (s.done) continue;
      if (s.due_date && s.due_date < date) out.overdue.push(item(b, s.title, { kind: 'step', date: s.due_date, detail: 'Next step overdue' }));
    }
  }

  // Today's priorities: the primary next action of the highest-ranked projects.
  const tiles = bundles.filter((b) => b.project.lifecycle === 'active').map((b) => ({ b, t: toTile(b, principal, date, now) }));
  tiles.sort((x, y) => compareTiles(x.t, y.t));
  for (const { b, t } of tiles) {
    if (out.priorities.length >= 6) break;
    if (!t.next_action) continue;
    const why = t.pinned ? 'Pinned' : t.flags.find((f) => f.severity !== 'info')?.label ?? (t.next_milestone?.date ? `Next milestone ${t.next_milestone.date.date}` : '');
    out.priorities.push(item(b, t.next_action.title, { detail: why, date: t.next_action.due_date ?? undefined }));
  }
  for (const b of bundles) {
    for (const s of b.steps) if (!s.done && s.due_date === date && !out.priorities.some((p) => p.title === s.title)) out.priorities.push(item(b, s.title, { detail: 'Due today', date }));
  }

  // Decisions/actions needed from this user.
  const mine = (assignee: string) => {
    const a = assignee.trim().toLowerCase();
    return principal.isOwner ? true : Boolean(a) && (a === principal.email || a === principal.name.toLowerCase());
  };
  for (const b of bundles) {
    for (const s of b.steps) if (!s.done && s.needs_decision && mine(s.assignee)) out.decisions.push(item(b, s.title, { kind: 'decision' }));
    if (principal.isOwner) {
      for (const i of b.issues) if (i.kind === 'blocker' && !i.resolved) out.decisions.push(item(b, i.title, { kind: 'blocker', detail: 'Blocker — can you unblock it?' }));
      if (b.project.needs_attention) out.decisions.push(item(b, b.project.attention_note || 'Flagged for your attention', { kind: 'attention' }));
    }
    if (canEdit(principal, b.project.space)) {
      const proposed = b.milestones.filter((m) => m.confirmed !== 1).length;
      if (proposed) out.decisions.push(item(b, `Confirm or adjust ${proposed} proposed milestone${proposed > 1 ? 's' : ''}`, { kind: 'confirm_plan' }));
      if (b.pendingSuggestions) out.decisions.push(item(b, `Review ${b.pendingSuggestions} suggestion${b.pendingSuggestions > 1 ? 's' : ''}`, { kind: 'suggestion' }));
    }
  }

  // Significant changes in the last 24 hours.
  const since = new Date(now.getTime() - 24 * 3_600_000).toISOString();
  const scope = projectScope(principal, 'p');
  const rows = await deps.db.all<{ project_id: string; name: string; at: string; summary: string; kind: string; detail: string }>(
    `SELECT h.project_id, p.name, h.at, h.summary, h.kind, h.detail FROM history h JOIN projects p ON p.id = h.project_id
      WHERE h.at >= ? AND ${scope.sql} AND h.kind IN ('auto_update','milestone','lifecycle','deadline','target','blocker','source','created','suggestion')
      ORDER BY h.at DESC LIMIT 40`,
    [since, ...scope.params],
  );
  const visible = principal.isOwner ? null : await visibleProjectIds(deps.db, principal);
  for (const r of rows) {
    const d = parseJson<Record<string, unknown>>(r.detail, {});
    if (!principal.isOwner && (d.owner_only || (typeof d.related_project_id === 'string' && !visible!.has(d.related_project_id)))) continue;
    if (out.changes.length < 12) out.changes.push({ project_id: r.project_id, project_name: r.name, title: clip(r.summary, 220), date: r.at, kind: r.kind });
  }

  out.overdue.sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
  out.upcoming.sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
  return out;
}

/** Drops items for projects the user can no longer see (visibility may change after generation). */
export async function filterSummary(deps: Deps, principal: Principal, c: SummaryContent): Promise<SummaryContent> {
  if (principal.isOwner) return c;
  const visible = await visibleProjectIds(deps.db, principal);
  const keep = (xs: SummaryItem[]) => xs.filter((x) => visible.has(x.project_id));
  return { ...c, overdue: keep(c.overdue), priorities: keep(c.priorities), upcoming: keep(c.upcoming), changes: keep(c.changes), decisions: keep(c.decisions) };
}

export function nextScheduled(now: Date): string {
  const { date, hour } = hkParts(now);
  const d = hour < SUMMARY_HOUR_HK ? date : addDays(date, 1);
  return `${d}T07:00:00+08:00`;
}

export async function getSummary(deps: Deps, principal: Principal, date?: string): Promise<SummaryResponse> {
  const now = deps.now();
  const today = hkDate(now);
  const target = date ?? today;
  const row = await deps.db.first<{ content: string; late: number; delivery: string; delivery_error: string }>(
    'SELECT content, late, delivery, delivery_error FROM daily_summaries WHERE user_id = ? AND hk_date = ?',
    [principal.userId, target],
  );
  if (row) {
    return { hk_date: target, stored: true, late: row.late === 1, delivery: row.delivery, delivery_error: row.delivery_error, content: await filterSummary(deps, principal, JSON.parse(row.content)), next_scheduled: nextScheduled(now) };
  }
  return { hk_date: target, stored: false, late: false, delivery: 'pending', delivery_error: '', content: await buildSummary(deps, principal, target), next_scheduled: nextScheduled(now) };
}

// ---- rendering ----------------------------------------------------------------

const SECTIONS: [keyof SummaryContent, string][] = [
  ['overdue', 'Overdue'],
  ['priorities', "Today's priorities"],
  ['upcoming', 'Upcoming milestones (14 days)'],
  ['changes', 'Significant changes (24 h)'],
  ['decisions', 'Decisions and actions needed from you'],
];

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function renderSummaryText(c: SummaryContent, appUrl: string): string {
  const lines = [`Daily project summary — ${c.hk_date} (Hong Kong)`, ''];
  for (const [key, label] of SECTIONS) {
    const items = c[key] as SummaryItem[];
    lines.push(`${label}${items.length ? '' : ': none'}`);
    for (const i of items) lines.push(`  • ${i.project_name}: ${i.title}${i.date && key !== 'changes' ? ` (${i.date})` : ''}${i.detail ? ` — ${i.detail}` : ''}`);
    lines.push('');
  }
  if (appUrl) lines.push(`Open the dashboard: ${appUrl}/summary`);
  return lines.join('\n');
}

export function renderSummaryHtml(c: SummaryContent, appUrl: string): string {
  const sec = SECTIONS.map(([key, label]) => {
    const items = c[key] as SummaryItem[];
    const body = items.length
      ? `<ul style="margin:6px 0 0;padding-left:18px">${items
          .map((i) => `<li style="margin:4px 0"><b>${esc(i.project_name)}</b>: ${esc(i.title)}${i.date && key !== 'changes' ? ` <span style="color:#9aa1ad">(${esc(i.date)})</span>` : ''}${i.detail ? ` <span style="color:#9aa1ad">— ${esc(i.detail)}</span>` : ''}</li>`)
          .join('')}</ul>`
      : '<p style="margin:6px 0 0;color:#9aa1ad">None.</p>';
    return `<h3 style="margin:20px 0 0;font-size:15px;color:#f3f4f6">${label}</h3>${body}`;
  }).join('');
  return `<div style="background:#16181d;color:#e5e7eb;font-family:-apple-system,Segoe UI,Roboto,sans-serif;padding:24px;border-radius:12px;max-width:680px">
<h2 style="margin:0;font-size:18px;color:#fff">Daily project summary · ${esc(c.hk_date)}</h2>${sec}
${appUrl ? `<p style="margin-top:24px"><a style="color:#7fb0ff" href="${esc(appUrl)}/summary">Open the dashboard</a></p>` : ''}</div>`;
}

// ---- scheduling + delivery ----------------------------------------------------------

async function sendEmail(deps: Deps, to: string, subject: string, html: string, text: string, idemKey: string): Promise<void> {
  const res = await deps.fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${deps.config.resendKey}`, 'content-type': 'application/json', 'idempotency-key': idemKey },
    body: JSON.stringify({ from: deps.config.summaryFrom, to: [to], subject, html, text }),
  });
  if (!res.ok) throw new Error(`Resend HTTP ${res.status}: ${clip(await res.text(), 200)}`);
}

export interface SummaryRunResult {
  skipped?: 'before_07';
  generated: number;
  sent: number;
  failed: number;
}

export async function runDailySummaries(deps: Deps): Promise<SummaryRunResult> {
  const now = deps.now();
  const { date, hour } = hkParts(now);
  const result: SummaryRunResult = { generated: 0, sent: 0, failed: 0 };
  if (hour < SUMMARY_HOUR_HK) return { ...result, skipped: 'before_07' };
  const users = await deps.db.all<{ id: string; email: string; summary_email: number }>("SELECT id, email, summary_email FROM users WHERE status = 'active'");
  for (const u of users) {
    let principal: Principal;
    try {
      principal = await principalForEmail(deps, u.email, 'dev');
    } catch {
      continue;
    }
    if (!principal.isOwner && Object.keys(principal.grants).length === 0) continue;
    let row = await deps.db.first<{ id: string; delivery: string; content: string }>('SELECT id, delivery, content FROM daily_summaries WHERE user_id = ? AND hk_date = ?', [u.id, date]);
    if (!row) {
      const content = await buildSummary(deps, principal, date);
      const ins = await deps.db.run(
        `INSERT INTO daily_summaries (id, user_id, hk_date, generated_at, late, content) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, hk_date) DO NOTHING`,
        [newId('ds_'), u.id, date, now.toISOString(), hour > SUMMARY_HOUR_HK ? 1 : 0, JSON.stringify(content)],
      );
      if (ins.changes) result.generated++;
      row = await deps.db.first('SELECT id, delivery, content FROM daily_summaries WHERE user_id = ? AND hk_date = ?', [u.id, date]);
    }
    if (!row || !(row.delivery === 'pending' || (row.delivery === 'failed' && hour < 12))) continue;
    let delivery = 'sent';
    let err = '';
    if (!u.summary_email) delivery = 'disabled';
    else if (!emailConfigured(deps.config)) delivery = 'not_configured';
    else {
      try {
        const content = await filterSummary(deps, principal, JSON.parse(row.content));
        await sendEmail(deps, u.email, `Project summary · ${date}`, renderSummaryHtml(content, deps.config.appUrl), renderSummaryText(content, deps.config.appUrl), `daily-${u.id}-${date}`);
        result.sent++;
      } catch (e) {
        delivery = 'failed';
        err = clip(String((e as Error)?.message ?? e), 300);
        result.failed++;
      }
    }
    await deps.db.run('UPDATE daily_summaries SET delivery = ?, delivered_at = ?, delivery_error = ? WHERE id = ?', [delivery, delivery === 'sent' ? now.toISOString() : null, err, row.id]);
  }
  return result;
}

export async function runScheduled(deps: Deps): Promise<{ refresh: unknown; summaries: unknown }> {
  const now = deps.now();
  await deps.db.run("INSERT INTO app_meta (key, value) VALUES ('last_cron_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [now.toISOString()]);
  let refresh: unknown;
  let summaries: unknown;
  try {
    refresh = await runRefresh(deps, { trigger: 'cron', idemKey: `cron:${now.toISOString().slice(0, 13)}` });
  } catch (e) {
    refresh = { error: String(e) };
  }
  try {
    summaries = await runDailySummaries(deps);
  } catch (e) {
    summaries = { error: String(e) };
  }
  return { refresh, summaries };
}
