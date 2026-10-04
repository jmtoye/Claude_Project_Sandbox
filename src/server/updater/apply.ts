// Turns an LLM update proposal into database statements, enforcing:
//  - every applied fact is backed by a quote that really appears in the fetched source text
//  - fields under a manual override are never changed (a reviewable suggestion is recorded instead)
//  - confirmed deadlines are never changed automatically (found deadlines become suggestions)
//  - milestones only become "done" with verifiable evidence
import type { Citation } from '../../shared/types';
import type { Stmt } from '../db';
import type { MilestoneRow, ProjectBundle } from '../rows';
import { isIsoDate } from '../time';
import { clip, newId } from '../util';
import type { SourceChange, UpdateProposal } from './llm';
import { normaliseForQuote, quoteIsGrounded } from './sources';

export interface ApplyPlan {
  stmts: Stmt[];
  applied: string[];
  suppressed: string[];
  citations: Citation[];
  material: boolean;
}

export function planApply(args: {
  bundle: ProjectBundle;
  proposal: UpdateProposal;
  changes: SourceChange[];
  today: string;
  now: string;
  runId: string;
  otherProjects: { id: string; name: string }[];
  existingDeps: Set<string>;
}): ApplyPlan {
  const { bundle, proposal: prop, changes, today, now, runId } = args;
  const p = bundle.project;
  const texts = new Map(changes.map((c) => [c.source_id, c.text]));
  // State changes (status, milestone completion) must be evidenced by text that is new in
  // this change; old unchanged lines were already considered when they first appeared.
  const newTexts = new Map(changes.map((c) => [c.source_id, c.first_time ? c.text : c.added.join('\n')]));
  const overridden = new Set(bundle.overrides.map((o) => o.field));
  const stmts: Stmt[] = [];
  const applied: string[] = [];
  const suppressed: string[] = [];
  const allCites: Citation[] = [];

  const valid = (cites: Citation[], scope: 'full' | 'new' = 'full') => {
    const pool = scope === 'new' ? newTexts : texts;
    const ok = cites.filter((c) => pool.has(c.source_id) && quoteIsGrounded(c.quote, pool.get(c.source_id)!));
    allCites.push(...ok);
    return ok;
  };
  const suggestion = (kind: string, dedupe: string, payload: unknown, rationale: string, cites: Citation[] = []) =>
    stmts.push({
      sql: `INSERT INTO suggestions (id, project_id, kind, payload, rationale, citation, dedupe_key, created_at, run_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      params: [newId('sg_'), p.id, kind, JSON.stringify(payload), rationale, JSON.stringify(cites), dedupe, now, runId],
    });
  const conflictSuggestion = (field: string, value: string, label: string, extra: Record<string, unknown> = {}, cites: Citation[] = []) => {
    suppressed.push(`${label} (kept your manual value)`);
    suggestion('override_conflict', `${field}=${normaliseForQuote(value).slice(0, 120)}`, { field, value, ...extra }, `Sources suggest ${label}`, cites);
  };

  if (!prop.material_change) {
    return { stmts, applied, suppressed, citations: [], material: false };
  }

  // ---- status ----
  if (prop.status) {
    const cites = valid(prop.status.citations, 'new');
    const basis = prop.status.basis === 'source_fact' ? 'source_fact' : 'suggestion';
    const sets: string[] = [];
    const params: unknown[] = [];
    const fields: [keyof typeof p & string, string][] = [
      ['status', prop.status.value],
      ['status_summary', clip(prop.status.summary.trim(), 300)],
      ['status_detail', prop.status.detail.trim()],
    ];
    for (const [field, value] of fields) {
      if (!value || value === p[field]) continue;
      if (!cites.length) {
        suppressed.push(`${field.replace('_', ' ')} → "${clip(value, 80)}": no quote from the newly changed source text`);
        continue;
      }
      if (overridden.has(field)) {
        conflictSuggestion(field, value, `${field.replace('_', ' ')}: "${clip(value, 80)}"`, {}, cites);
        continue;
      }
      sets.push(`${field} = ?`);
      params.push(value);
      applied.push(field === 'status' ? `Status → ${value.replace('_', ' ')}` : `Updated ${field.replace('_', ' ')}`);
    }
    // The basis label describes the status value, so only relabel it when the value itself changed.
    if (sets.some((x) => x.startsWith('status ='))) {
      sets.push('status_basis = ?');
      params.push(basis);
    }
    if (sets.length) stmts.push({ sql: `UPDATE projects SET ${sets.join(', ')} WHERE id = ?`, params: [...params, p.id] });
  }

  // ---- milestones ----
  const byId = new Map(bundle.milestones.map((m) => [m.id, m]));
  for (const u of prop.milestone_updates) {
    const m = byId.get(u.milestone_id);
    if (!m || u.state === m.state) continue;
    const cites = valid(u.citations, 'new');
    if (!cites.length) {
      suppressed.push(`Milestone "${clip(m.title, 60)}" → ${u.state.replace('_', ' ')}: no verifiable evidence in the newly changed source text`);
      continue;
    }
    if (overridden.has(`milestone:${m.id}:state`)) {
      conflictSuggestion(`milestone:${m.id}:state`, u.state, `milestone "${clip(m.title, 50)}" is ${u.state.replace('_', ' ')}`, { milestone_id: m.id, evidence: u.evidence }, cites);
      continue;
    }
    stmts.push({
      sql: `UPDATE milestones SET state = ?, evidence = ?, evidence_basis = ?, evidence_source_id = ?, completed_at = ?, updated_at = ? WHERE id = ?`,
      params: [u.state, clip(u.evidence, 2000), u.state === 'done' ? 'auto_evidence' : m.evidence_basis, cites[0].source_id, u.state === 'done' ? now : null, now, m.id],
    });
    applied.push(`Milestone "${clip(m.title, 60)}" → ${u.state.replace('_', ' ')}`);
  }

  // ---- date suggestions (never deadlines) ----
  for (const d of prop.date_suggestions) {
    const m = byId.get(d.milestone_id);
    if (!m || m.state === 'done' || !isIsoDate(d.date) || d.date < today || m.suggested_date === d.date) continue;
    if (overridden.has(`milestone:${m.id}:suggested_date`)) {
      suppressed.push(`Suggested date ${d.date} for "${clip(m.title, 50)}"`);
      continue;
    }
    stmts.push({ sql: 'UPDATE milestones SET suggested_date = ?, suggested_basis = ?, updated_at = ? WHERE id = ?', params: [d.date, clip(d.basis_explanation, 500), now, m.id] });
    applied.push(`Suggested date for "${clip(m.title, 50)}": ${d.date}`);
  }

  // ---- deadlines found in sources → owner confirmation ----
  for (const f of prop.deadline_findings) {
    if (!isIsoDate(f.date) || !texts.has(f.source_id) || !quoteIsGrounded(f.quote, texts.get(f.source_id)!)) continue;
    const m: MilestoneRow | undefined = (f.milestone_id ? byId.get(f.milestone_id) : undefined) ?? bundle.milestones.filter((x) => x.state !== 'done').sort((a, b) => a.position - b.position)[0];
    if (!m || m.deadline === f.date) continue;
    const cite = [{ source_id: f.source_id, quote: f.quote }];
    allCites.push(...cite);
    suggestion('deadline', `deadline:${m.id}:${f.date}`, { milestone_id: m.id, milestone_title: m.title, date: f.date, quote: f.quote, current: m.deadline }, `Deadline ${f.date} for "${clip(m.title, 60)}" found in a source`, cite);
    applied.push(`Found deadline ${f.date} for "${clip(m.title, 50)}" — awaiting your confirmation`);
  }

  // ---- next steps (replace automatic ones unless protected) ----
  const manualPrimary = bundle.steps.some((s) => s.origin === 'manual' && !s.done && s.is_primary);
  if (overridden.has('next_steps')) {
    if (prop.next_steps.length) suppressed.push('Next steps (you edited them manually; automatic list not applied)');
  } else {
    stmts.push({ sql: "DELETE FROM next_steps WHERE project_id = ? AND origin = 'auto' AND done = 0", params: [p.id] });
    let pos = 100;
    let primaryUsed = manualPrimary;
    for (const s of prop.next_steps.slice(0, 8)) {
      const cites = valid(s.citations);
      const primary = s.is_primary && !primaryUsed;
      if (primary) primaryUsed = true;
      stmts.push({
        sql: `INSERT INTO next_steps (id, project_id, position, title, assignee, needs_decision, is_primary, origin, basis, citation, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, 'auto', ?, ?, ?, ?)`,
        params: [newId('s_'), p.id, primary ? 0 : pos++, clip(s.title, 300), clip(s.assignee, 80), s.needs_decision ? 1 : 0, primary ? 1 : 0, s.basis === 'source_fact' && cites.length ? 'source_fact' : 'suggestion', JSON.stringify(cites), now, now],
      });
    }
    if (prop.next_steps.length) applied.push(`Next steps refreshed (${prop.next_steps.length})`);
  }

  // ---- blockers, risks and tips ----
  if (overridden.has('issues')) {
    if (prop.blockers.length + prop.risks.length + prop.tips.length) suppressed.push('Blockers/risks/tips (you edited them manually)');
  } else {
    stmts.push({ sql: "DELETE FROM issues WHERE project_id = ? AND origin = 'auto' AND resolved = 0", params: [p.id] });
    const ins = (kind: string, title: string, detail: string, severity: string, basis: string, cites: Citation[]) =>
      stmts.push({
        sql: `INSERT INTO issues (id, project_id, kind, title, detail, severity, origin, basis, citation, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, 'auto', ?, ?, ?, ?)`,
        params: [newId('i_'), p.id, kind, clip(title, 300), clip(detail, 2000), severity, basis, JSON.stringify(cites), now, now],
      });
    for (const b of prop.blockers.slice(0, 5)) {
      const cites = valid(b.citations);
      // An uncited "blocker" is not an established fact: keep it as an anticipated risk instead.
      if (cites.length) ins('blocker', b.title, b.detail, b.severity, 'source_fact', cites);
      else ins('risk', b.title, b.detail, b.severity, 'suggestion', []);
    }
    for (const r of prop.risks.slice(0, 5)) {
      const cites = valid(r.citations);
      ins('risk', r.title, r.detail, r.severity, r.basis === 'source_fact' && cites.length ? 'source_fact' : 'suggestion', cites);
    }
    for (const t of prop.tips.slice(0, 4)) ins('tip', t.title, t.detail, 'low', 'suggestion', []);
    const n = prop.blockers.length + prop.risks.length + prop.tips.length;
    if (n) applied.push(`Blockers/risks/tips refreshed (${prop.blockers.length}/${prop.risks.length}/${prop.tips.length})`);
  }

  // ---- milestone plan ----
  if (prop.proposed_milestones.length) {
    if (bundle.milestones.length === 0) {
      prop.proposed_milestones.slice(0, 12).forEach((m, i) => {
        stmts.push({
          sql: `INSERT INTO milestones (id, project_id, position, title, description, weight, confirmed, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
          params: [newId('m_'), p.id, i + 1, clip(m.title, 200), clip(m.description, 2000), Math.min(10, Math.max(0.1, m.weight || 1)), now, now],
        });
      });
      applied.push(`Proposed ${Math.min(12, prop.proposed_milestones.length)} milestones (awaiting your confirmation)`);
    } else {
      for (const m of prop.proposed_milestones.slice(0, 5)) {
        suggestion('milestone', `milestone:${normaliseForQuote(m.title).slice(0, 80)}`, { title: m.title, description: m.description, weight: m.weight }, `New milestone: ${clip(m.title, 80)} — ${clip(m.rationale, 200)}`);
      }
    }
  }

  // ---- dependencies: only explicit mentions of known projects, owner confirms ----
  const others = new Map(args.otherProjects.map((o) => [o.id, o.name]));
  for (const d of prop.dependency_mentions) {
    if (!others.has(d.project_id) || args.existingDeps.has(d.project_id)) continue;
    if (!texts.has(d.source_id) || !quoteIsGrounded(d.quote, texts.get(d.source_id)!)) continue;
    suggestion('dependency', `dep:${d.project_id}`, { depends_on_id: d.project_id, name: others.get(d.project_id), quote: d.quote }, `May depend on "${others.get(d.project_id)}"`, [{ source_id: d.source_id, quote: d.quote }]);
  }

  // ---- phrase (only fills an empty one) ----
  if (prop.phrase && !p.phrase && !overridden.has('phrase')) {
    stmts.push({ sql: 'UPDATE projects SET phrase = ? WHERE id = ?', params: [clip(prop.phrase.trim(), 80), p.id] });
  }

  stmts.push({ sql: 'UPDATE projects SET last_evidence_at = ?, needs_review = 0 WHERE id = ?', params: [now, p.id] });
  return { stmts, applied, suppressed, citations: dedupeCites(allCites), material: true };
}

function dedupeCites(c: Citation[]): Citation[] {
  const seen = new Set<string>();
  return c.filter((x) => {
    const k = `${x.source_id}|${x.quote}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
