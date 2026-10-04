// The real initial project imports cleanly and is presented honestly.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { harness, OWNER, WORK_VIEWER } from './helpers';

const FILE = join(import.meta.dirname, '..', 'data', 'initial-projects.json');

describe.skipIf(!existsSync(FILE))('initial Work project', () => {
  it('imports with no invented progress, deadline or approval', async () => {
    const h = await harness({ start: '2026-10-04T02:00:00Z' });
    const data = JSON.parse(readFileSync(FILE, 'utf8'));
    const spec = data.projects[0];
    const r = await h.json(OWNER, 'POST', '/api/admin/import', data);
    expect(r.body.created).toEqual([spec.name]);
    const tile = (await h.json(OWNER, 'GET', '/api/dashboard?space=work')).body.tiles[0];
    expect(tile.progress.percent).toBeNull(); // plan is a proposal until confirmed
    expect(tile.progress.assessment).toBe('unassessed');
    expect(tile.next_action.title).toBe(spec.next_steps.find((x: any) => x.is_primary).title);
    expect(tile.next_milestone.date).toBeNull(); // no deadline or target recorded
    expect(tile.flags.some((f: any) => f.kind === 'overdue_deadline')).toBe(false);
    expect(tile.freshness.state).toBe('manual_only');
    expect(tile.freshness.label).toContain('snapshot 2026-10-04');

    const d = (await h.json(OWNER, 'GET', `/api/projects/${tile.id}`)).body;
    const ref = d.sources.find((s: any) => s.kind === 'reference');
    expect(ref.connection).toBe('reference_only');
    expect(ref.status_note).toContain('ChatGPT');
    expect(d.next_steps[0].basis).toBe('source_fact');
    expect(d.next_steps[0].citation[0].source_title).toBe(spec.sources.find((x: any) => x.kind === 'snapshot').title);
    expect(d.milestones.every((m: any) => !m.confirmed)).toBe(true);
    expect(d.milestones.every((m: any) => !m.deadline && !m.target_date)).toBe(true);

    // The snapshot is marked as already processed, so the updater will not re-derive it.
    const run = await h.json(OWNER, 'POST', '/api/refresh', {});
    expect(run.body.stats.sources_changed).toBe(0);
    expect(h.fetchLog.some((u) => u.includes('chatgpt.com'))).toBe(false);

    // Once the owner confirms the plan, progress becomes assessable from the recorded evidence.
    expect((await h.op(OWNER, 'confirm_milestones', { project_id: tile.id })).status).toBe(200);
    const after = (await h.json(OWNER, 'GET', '/api/dashboard?space=work')).body.tiles[0];
    const done = spec.milestones.filter((m: any) => m.state === 'done').reduce((a: number, m: any) => a + m.weight, 0);
    const total = spec.milestones.reduce((a: number, m: any) => a + m.weight, 0);
    expect(after.progress).toMatchObject({ percent: Math.round((done / total) * 100), assessment: 'assessed', current: { title: spec.milestones.find((m: any) => m.state !== 'done').title, percent: 0 } });

    // Invited work viewers see it (it is not "Only me").
    expect((await h.json(WORK_VIEWER, 'GET', `/api/projects/${tile.id}`)).status).toBe(200);
  });
});
