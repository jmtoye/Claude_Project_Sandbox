// Progress calculation, dates/overdue handling, ordering and date parsing.
import { describe, expect, it } from 'vitest';
import { computeFlags, effectiveDate, compareTiles } from '../src/server/domain/attention';
import { computeProgress } from '../src/server/domain/progress';
import type { MilestoneRow, ProjectBundle } from '../src/server/rows';
import { hkDate, hkHour, parseHumanDate } from '../src/server/time';
import { harness, idByName, OWNER, seed } from './helpers';

const m = (o: Partial<MilestoneRow>): MilestoneRow => ({
  id: o.id ?? Math.random().toString(36), project_id: 'p', position: 1, title: 'M', description: '', weight: 1, state: 'not_started', confirmed: 1, evidence: '', evidence_basis: '',
  evidence_source_id: null, completed_at: null, checklist: '[]', deadline: null, deadline_note: '', target_date: null, suggested_date: null, suggested_basis: '', created_at: '', updated_at: '', ...o,
});

describe('milestone-based progress', () => {
  it('weights milestones and counts checklist fractions; never uses time', () => {
    const p = computeProgress([
      m({ position: 1, weight: 1, state: 'done', evidence: 'signed off', evidence_basis: 'owner_confirmed' }),
      m({ position: 2, weight: 2, state: 'in_progress', checklist: JSON.stringify([{ id: 'a', title: 'a', done: true }, { id: 'b', title: 'b', done: false }]) }),
      m({ position: 3, weight: 1 }),
    ]);
    // (1×1 + 2×0.5 + 1×0) / 4 = 50%
    expect(p.percent).toBe(50);
    expect(p.assessment).toBe('assessed');
    expect(p.current).toMatchObject({ percent: 50 });
    expect(p.completed).toBe(1);
  });

  it('is unassessed with no milestones or only proposed ones', () => {
    expect(computeProgress([]).percent).toBeNull();
    const proposed = computeProgress([m({ confirmed: 0, state: 'done', evidence: 'x', evidence_basis: 'source_fact' }), m({ confirmed: 0 })]);
    expect(proposed.percent).toBeNull();
    expect(proposed.assessment).toBe('unassessed');
    expect(proposed.reasons[0]).toContain('awaiting your confirmation');
  });

  it('is provisional when something is done without evidence or proposals are pending', () => {
    const p = computeProgress([m({ state: 'done' }), m({ position: 2 })]);
    expect(p.percent).toBe(50);
    expect(p.assessment).toBe('provisional');
    const q = computeProgress([m({ state: 'done', evidence: 'ok', evidence_basis: 'owner_confirmed' }), m({ position: 2, confirmed: 0 })]);
    expect(q.percent).toBe(100);
    expect(q.assessment).toBe('provisional');
  });

  it('an in-progress milestone without sub-steps earns nothing (no guessing)', () => {
    expect(computeProgress([m({ state: 'in_progress' }), m({ position: 2 })]).percent).toBe(0);
  });
});

describe('dates and overdue handling', () => {
  const today = '2026-10-10';
  it('chooses the earliest firm date, falls back to suggestions, and labels the kind', () => {
    expect(effectiveDate(m({ deadline: '2026-10-20', target_date: '2026-10-15' }), today)).toMatchObject({ date: '2026-10-15', kind: 'target', days: 5 });
    expect(effectiveDate(m({ deadline: '2026-10-12', target_date: '2026-10-15' }), today)).toMatchObject({ date: '2026-10-12', kind: 'deadline' });
    expect(effectiveDate(m({ suggested_date: '2026-11-01', suggested_basis: 'b' }), today)).toMatchObject({ kind: 'suggested', basis: 'b', overdue: false });
    expect(effectiveDate(m({ deadline: '2026-10-01' }), today)).toMatchObject({ overdue: true, days: -9 });
    expect(effectiveDate(m({ deadline: '2026-10-01', state: 'done' }), today)!.overdue).toBe(false);
  });

  it('flags passed deadlines as urgent and missed targets as warnings', () => {
    const bundle = (milestones: MilestoneRow[]): ProjectBundle => ({
      project: { status: 'in_progress', needs_attention: 0, needs_review: 0, pinned: 0, lifecycle: 'active' } as never,
      milestones, steps: [], issues: [], sources: [], overrides: [], pendingSuggestions: 0,
    });
    const flags = computeFlags(bundle([m({ title: 'A', deadline: '2026-10-01' }), m({ title: 'B', target_date: '2026-10-05' }), m({ title: 'C', suggested_date: '2026-10-01' })]), today, { showSuggestions: false, now: new Date() });
    expect(flags.map((f) => [f.kind, f.severity])).toEqual([
      ['overdue_deadline', 'urgent'],
      ['target_missed', 'warn'],
    ]);
  });

  it('a confirmed deadline stays overdue: automation cannot move it and a manual move needs a reason that is logged', async () => {
    const h = await harness();
    await seed(h, [{ space: 'work', name: 'D', milestones: [{ title: 'Late', deadline: '2026-10-01' }] }]);
    const id = await idByName(h, 'D');
    let tile = (await h.json(OWNER, 'GET', '/api/dashboard?space=work')).body.tiles[0];
    expect(tile.flags[0].kind).toBe('overdue_deadline');
    const noReason = await h.op(OWNER, 'set_target_date', { project_id: id, date: '2026-11-01', kind: 'deadline' });
    expect(noReason.status).toBe(400);
    const moved = await h.op(OWNER, 'set_target_date', { project_id: id, date: '2026-11-01', kind: 'deadline', note: 'Client agreed extension' });
    expect(moved.status).toBe(200);
    const hist = (await h.json(OWNER, 'GET', `/api/projects/${id}`)).body.history[0].summary;
    expect(hist).toContain('moved 2026-10-01 → 2026-11-01 (it was overdue): Client agreed extension');
    tile = (await h.json(OWNER, 'GET', '/api/dashboard?space=work')).body.tiles[0];
    expect(tile.flags.some((f: any) => f.kind === 'overdue_deadline')).toBe(false);
  });
});

describe('ordering', () => {
  it('pinned → needs my action → upcoming milestones → others → paused', async () => {
    const h = await harness({ start: '2026-10-05T02:00:00Z' });
    await seed(h, [
      { space: 'work', name: 'Later upcoming', milestones: [{ title: 'x', target_date: '2026-11-20' }] },
      { space: 'work', name: 'Nothing scheduled' },
      { space: 'work', name: 'Paused one', lifecycle: 'paused', pinned: false },
      { space: 'work', name: 'Blocked one', status: 'blocked' },
      { space: 'work', name: 'Pinned one', pinned: true },
      { space: 'work', name: 'Soon upcoming', milestones: [{ title: 'x', target_date: '2026-10-08' }] },
      { space: 'work', name: 'Overdue one', milestones: [{ title: 'x', deadline: '2026-10-01' }], priority: 'low' },
      { space: 'work', name: 'Decision one', next_steps: [{ title: 'Pick vendor', needs_decision: true }] },
    ]);
    const tiles = (await h.json(OWNER, 'GET', '/api/dashboard?space=work')).body.tiles;
    expect(tiles.map((t: any) => t.name)).toEqual(['Pinned one', 'Blocked one', 'Overdue one', 'Decision one', 'Soon upcoming', 'Later upcoming', 'Nothing scheduled', 'Paused one']);
    expect([...tiles].sort(compareTiles).map((t: any) => t.name)).toEqual(tiles.map((t: any) => t.name));
  });
});

describe('Hong Kong time', () => {
  it('converts UTC instants to HK dates and hours', () => {
    expect(hkDate(new Date('2026-10-03T16:30:00Z'))).toBe('2026-10-04');
    expect(hkHour(new Date('2026-10-03T23:00:00Z'))).toBe(7);
    expect(hkHour(new Date('2026-10-03T22:59:00Z'))).toBe(6);
  });

  it('parses human dates relative to today', () => {
    const t = '2026-10-04';
    expect(parseHumanDate('15 October', t)).toBe('2026-10-15');
    expect(parseHumanDate('Oct 15', t)).toBe('2026-10-15');
    expect(parseHumanDate('15th October 2027', t)).toBe('2027-10-15');
    expect(parseHumanDate('1 October', t)).toBe('2027-10-01'); // past → next year
    expect(parseHumanDate('15/10', t)).toBe('2026-10-15'); // day/month
    expect(parseHumanDate('2026-12-01', t)).toBe('2026-12-01');
    expect(parseHumanDate('tomorrow', t)).toBe('2026-10-05');
    expect(parseHumanDate('31 February', t)).toBeNull();
    expect(parseHumanDate('someday', t)).toBeNull();
  });
});
