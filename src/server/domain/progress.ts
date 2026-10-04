// Milestone-based progress. Never uses elapsed time or guesses.
//
//   overall % = Σ(weight_i × completion_i) ÷ Σ(weight_i)   over confirmed milestones
//   completion_i = 1                     if the milestone is done
//                = ticked ÷ total items  if it has a checklist (sub-steps)
//                = 0                     otherwise
//
// The result is "unassessed" (no percentage) when there are no confirmed milestones,
// and "provisional" when a milestone is marked done without recorded evidence or
// some proposed milestones are still awaiting confirmation.
import type { Checklist, ProgressInfo } from '../../shared/types';
import type { MilestoneRow } from '../rows';
import { parseJson } from '../util';

export const PROGRESS_EXPLANATION =
  'Overall progress = sum of (milestone weight × completion) ÷ sum of weights, over milestones you have confirmed. ' +
  'A milestone counts as 1 when marked done, as the fraction of ticked checklist items while in progress, and 0 otherwise. ' +
  'Weights default to 1 (equal). Progress is "provisional" when a milestone is done without recorded evidence or proposed milestones are unconfirmed, ' +
  'and "unassessed" when no milestones are confirmed. Elapsed time is never used.';

export function checklistOf(m: Pick<MilestoneRow, 'checklist'>): Checklist[] {
  const items = parseJson<Checklist[]>(m.checklist, []);
  return Array.isArray(items) ? items.filter((i) => i && typeof i.title === 'string') : [];
}

export function milestoneCompletion(m: Pick<MilestoneRow, 'state' | 'checklist'>): number {
  if (m.state === 'done') return 1;
  const items = checklistOf(m);
  if (items.length === 0) return 0;
  return items.filter((i) => i.done).length / items.length;
}

export function computeProgress(all: MilestoneRow[]): ProgressInfo {
  const ms = [...all].sort((a, b) => a.position - b.position);
  const confirmed = ms.filter((m) => m.confirmed === 1);
  const proposed = ms.length - confirmed.length;
  const base = { completed: confirmed.filter((m) => m.state === 'done').length, total: confirmed.length, proposed };

  if (ms.length === 0) {
    return { ...base, percent: null, assessment: 'unassessed', reasons: ['No milestones defined yet.'], current: null };
  }
  if (confirmed.length === 0) {
    return {
      ...base,
      percent: null,
      assessment: 'unassessed',
      reasons: [`${proposed} proposed milestone${proposed === 1 ? '' : 's'} awaiting your confirmation.`],
      current: null,
    };
  }

  const reasons: string[] = [];
  let weightSum = 0;
  let earned = 0;
  for (const m of confirmed) {
    const w = m.weight > 0 ? m.weight : 1;
    weightSum += w;
    earned += w * milestoneCompletion(m);
    if (m.state === 'done' && (!m.evidence.trim() || !m.evidence_basis)) {
      reasons.push(`"${m.title}" is marked done without recorded evidence.`);
    }
  }
  if (proposed > 0) reasons.push(`${proposed} proposed milestone${proposed === 1 ? '' : 's'} not yet confirmed.`);

  const cur = confirmed.find((m) => m.state !== 'done') ?? null;
  const curItems = cur ? checklistOf(cur) : [];
  return {
    ...base,
    percent: Math.round((earned / weightSum) * 100),
    assessment: reasons.length ? 'provisional' : 'assessed',
    reasons,
    current: cur
      ? {
          milestone_id: cur.id,
          title: cur.title,
          percent: curItems.length ? Math.round((curItems.filter((i) => i.done).length / curItems.length) * 100) : null,
        }
      : null,
  };
}
