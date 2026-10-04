// Hourly updates, manual refresh, overrides, grounding, idempotency, failures.
import { describe, expect, it } from 'vitest';
import { runScheduled } from '../src/server/summary';
import { acquireLock, runRefresh } from '../src/server/updater/refresh';
import { emptyProposal, harness, idByName, OWNER, seed, WORK_EDITOR, WORK_VIEWER } from './helpers';

const URL1 = 'https://example.test/status-page';
const PAGE_V1 = '<html><title>Status</title><body><p>Phase one design was approved by the steering group on 1 October.</p><p>Build starts next week.</p></body></html>';
const PAGE_V2 = '<html><body><p>Phase one design was approved by the steering group on 1 October.</p><p>The build was completed and deployed to production on 4 October.</p><p>Go-live deadline is 30 November 2026.</p><p>We are waiting for the security sign-off before rollout.</p></body></html>';

async function setup(llm = true) {
  const h = await harness({ llm });
  await seed(h, [
    {
      space: 'work',
      name: 'Rollout',
      status: 'in_progress',
      status_summary: 'Design phase',
      milestones: [
        { title: 'Design approved', state: 'not_started' },
        { title: 'Build complete', state: 'not_started', deadline: '2026-10-02' },
        { title: 'Go live' },
      ],
      sources: [{ title: 'Status page', url: URL1 }],
    },
  ]);
  const id = await idByName(h, 'Rollout');
  h.web.set(URL1, { body: PAGE_V1 });
  return { h, id };
}

const ms = async (h: any, id: string) => h.db.all('SELECT id, title, state, evidence, evidence_basis, deadline, suggested_date FROM milestones WHERE project_id = ? ORDER BY position', [id]);

describe('hourly checks', () => {
  it('cron runs are idempotent per hour and do not call the LLM when nothing changed', async () => {
    const { h, id } = await setup();
    h.llm.next = () => emptyProposal();
    const first = await runScheduled(h.deps);
    expect((first.refresh as any).status).toBe('succeeded');
    expect((first.refresh as any).stats.sources_changed).toBe(1); // first read
    const again = await runScheduled(h.deps); // same hour: retry-safe
    expect((again.refresh as any).duplicate).toBe(true);
    expect(await h.db.first('SELECT COUNT(*) AS n FROM refresh_runs')).toEqual({ n: 1 });

    h.clock.now = new Date(h.clock.now.getTime() + 3600_000);
    const calls = h.llm.calls.length;
    const next = await runScheduled(h.deps);
    expect((next.refresh as any).stats).toMatchObject({ sources_checked: 1, sources_changed: 0, llm_calls: 0 });
    expect(h.llm.calls.length).toBe(calls);
    const p = await h.db.first<{ last_checked_at: string }>('SELECT last_checked_at FROM projects WHERE id = ?', [id]);
    expect(p!.last_checked_at).toBe(h.clock.now.toISOString()); // "checked, no changes"
  });

  it('applies grounded updates, rejects ungrounded claims and never moves deadlines', async () => {
    const { h, id } = await setup();
    h.llm.next = () => emptyProposal();
    await runRefresh(h.deps, { trigger: 'manual', idemKey: 'a' });
    const [design, build, golive] = await ms(h, id);
    h.web.set(URL1, { body: PAGE_V2 });
    h.llm.next = (input) => {
      expect(input.changes[0].added.join(' ')).toContain('deployed to production');
      return {
        ...emptyProposal(),
        material_change: true,
        change_summary: 'Build completed and deployed; go-live deadline stated; waiting for security sign-off.',
        status: { value: 'blocked', summary: 'Built; waiting for security sign-off before rollout', detail: 'Deployed 4 Oct.', basis: 'source_fact', citations: [{ source_id: input.changes[0].source_id, quote: 'waiting for the security sign-off before rollout' }] },
        milestone_updates: [
          { milestone_id: build.id, state: 'done', evidence: 'Deployed to production 4 Oct', citations: [{ source_id: input.changes[0].source_id, quote: 'The build was completed and deployed to production on 4 October.' }] },
          // Hallucinated evidence: the quote is not in the source → must not be applied.
          { milestone_id: golive.id, state: 'done', evidence: 'Went live', citations: [{ source_id: input.changes[0].source_id, quote: 'The system went live to all users' }] },
          // A draft/approval is not implementation, but a grounded "approved" is fine for an approval milestone.
          { milestone_id: design.id, state: 'done', evidence: 'Approved by steering group', citations: [{ source_id: input.changes[0].source_id, quote: 'Phase one design was approved by the steering group' }] },
        ],
        next_steps: [{ title: 'Chase security sign-off', assignee: '', needs_decision: false, is_primary: true, basis: 'source_fact', citations: [{ source_id: input.changes[0].source_id, quote: 'waiting for the security sign-off' }] }],
        blockers: [
          { title: 'Security sign-off pending', detail: '', severity: 'high', citations: [{ source_id: input.changes[0].source_id, quote: 'waiting for the security sign-off before rollout' }] },
          { title: 'Vendor might go bankrupt', detail: '', severity: 'medium', citations: [] },
        ],
        deadline_findings: [{ milestone_id: golive.id, date: '2026-11-30', quote: 'Go-live deadline is 30 November 2026', source_id: input.changes[0].source_id }],
        date_suggestions: [{ milestone_id: build.id, date: '2026-10-20', basis_explanation: 'n/a' }, { milestone_id: golive.id, date: '2026-11-20', basis_explanation: 'Ten days of buffer before the stated deadline.' }],
      };
    };
    h.clock.now = new Date(h.clock.now.getTime() + 3600_000);
    const r = await runRefresh(h.deps, { trigger: 'cron', idemKey: 'b' });
    expect(r.stats.projects_updated).toBe(1);
    const after = await ms(h, id);
    expect(after.map((m: any) => m.state)).toEqual(['done', 'done', 'not_started']);
    expect(after[1].evidence_basis).toBe('auto_evidence');
    expect(after[1].deadline).toBe('2026-10-02'); // unchanged
    expect(after[2].deadline).toBeNull(); // found deadline is only a suggestion
    expect(after[2].suggested_date).toBe('2026-11-20');
    const sugg = await h.db.all<{ kind: string; payload: string }>("SELECT kind, payload FROM suggestions WHERE project_id = ? AND status = 'pending'", [id]);
    expect(sugg.map((s) => s.kind)).toEqual(['deadline']);
    const p = await h.db.first<any>('SELECT status, status_basis, status_summary FROM projects WHERE id = ?', [id]);
    expect(p).toMatchObject({ status: 'blocked', status_basis: 'source_fact' });
    const issues = await h.db.all<{ kind: string; title: string; basis: string }>('SELECT kind, title, basis FROM issues WHERE project_id = ? ORDER BY title', [id]);
    expect(issues).toEqual([
      { kind: 'blocker', title: 'Security sign-off pending', basis: 'source_fact' },
      { kind: 'risk', title: 'Vendor might go bankrupt', basis: 'suggestion' }, // uncited "blocker" downgraded
    ]);
    const hist = await h.db.first<{ summary: string; detail: string }>("SELECT summary, detail FROM history WHERE project_id = ? AND kind = 'auto_update' ORDER BY at DESC LIMIT 1", [id]);
    expect(hist!.summary).toContain('Build completed');
    expect(JSON.parse(hist!.detail).suppressed.join(' ')).toContain('no verifiable evidence');

    // Accepting the deadline suggestion is an explicit human action.
    const s = await h.db.first<{ id: string }>("SELECT id FROM suggestions WHERE project_id = ? AND status = 'pending'", [id]);
    expect((await h.op(OWNER, 'resolve_suggestion', { project_id: id, suggestion_id: s!.id, accept: true })).status).toBe(200);
    expect((await ms(h, id))[2].deadline).toBe('2026-11-30');
  });

  it('manual overrides survive automatic updates until released', async () => {
    const { h, id } = await setup();
    h.llm.next = () => emptyProposal();
    await runRefresh(h.deps, { trigger: 'manual', idemKey: 'a' });
    // Owner corrects the status manually.
    expect((await h.op(OWNER, 'update_project', { project_id: id, status: 'on_track', status_summary: 'My view: on track' })).status).toBe(200);
    const [, build] = await ms(h, id);
    expect((await h.op(OWNER, 'update_milestone', { project_id: id, milestone_id: build.id, state: 'in_progress' })).status).toBe(200);

    const proposal = (srcId: string) => ({
      ...emptyProposal(),
      material_change: true,
      change_summary: 'x',
      status: { value: 'blocked' as const, summary: 'Waiting for security', detail: '', basis: 'source_fact' as const, citations: [{ source_id: srcId, quote: 'waiting for the security sign-off' }] },
      milestone_updates: [{ milestone_id: build.id, state: 'done' as const, evidence: 'deployed', citations: [{ source_id: srcId, quote: 'deployed to production on 4 October' }] }],
    });
    h.web.set(URL1, { body: PAGE_V2 });
    h.llm.next = (input) => proposal(input.changes[0].source_id);
    await runRefresh(h.deps, { trigger: 'manual', idemKey: 'b' });
    let p = await h.db.first<any>('SELECT status, status_summary FROM projects WHERE id = ?', [id]);
    expect(p).toEqual({ status: 'on_track', status_summary: 'My view: on track' });
    expect((await ms(h, id))[1].state).toBe('in_progress');
    const conflicts = await h.db.all<{ payload: string }>("SELECT payload FROM suggestions WHERE kind = 'override_conflict' AND status = 'pending'");
    expect(conflicts.length).toBe(3); // status, status_summary, milestone state

    // Release the status override → the next automatic change applies.
    expect((await h.op(OWNER, 'release_override', { project_id: id, field: 'status' })).status).toBe(200);
    h.web.set(URL1, { body: PAGE_V2 + '<p>Update: still waiting for the security sign-off.</p>' });
    await runRefresh(h.deps, { trigger: 'manual', idemKey: 'c' });
    p = await h.db.first<any>('SELECT status, status_summary FROM projects WHERE id = ?', [id]);
    expect(p).toEqual({ status: 'blocked', status_summary: 'My view: on track' }); // summary still overridden
  });

  it('a manual edit during the LLM call is never overwritten', async () => {
    const { h, id } = await setup();
    h.llm.next = () => emptyProposal();
    await runRefresh(h.deps, { trigger: 'manual', idemKey: 'a' });
    h.web.set(URL1, { body: PAGE_V2 });
    h.llm.next = (input) => {
      // Simulate the owner editing while the model is thinking.
      void h.deps.db.run("INSERT INTO overrides (project_id, field, set_by, set_at) VALUES (?, 'status', 'Owner', ?)", [id, new Date().toISOString()]);
      void h.deps.db.run("UPDATE projects SET status = 'at_risk', version = version + 1 WHERE id = ?", [id]);
      return { ...emptyProposal(), material_change: true, change_summary: 'x', status: { value: 'on_track', summary: '', detail: '', basis: 'suggestion', citations: [] } };
    };
    await runRefresh(h.deps, { trigger: 'manual', idemKey: 'b' });
    expect((await h.db.first<any>('SELECT status FROM projects WHERE id = ?', [id])).status).toBe('at_risk');
  });

  it('keeps the last known state when a source fails, and records it once', async () => {
    const { h, id } = await setup();
    h.llm.next = () => emptyProposal();
    await runRefresh(h.deps, { trigger: 'manual', idemKey: 'a' });
    h.web.set(URL1, { status: 503, body: 'down' });
    for (const k of ['b', 'c', 'd']) {
      h.clock.now = new Date(h.clock.now.getTime() + 3600_000);
      const r = await runRefresh(h.deps, { trigger: 'cron', idemKey: k });
      expect(r.status).toBe('partial');
    }
    const src = await h.db.first<any>('SELECT connection, last_error, consecutive_failures FROM sources WHERE project_id = ?', [id]);
    expect(src).toMatchObject({ connection: 'error', last_error: 'HTTP 503', consecutive_failures: 3 });
    const hist = await h.db.all("SELECT summary FROM history WHERE project_id = ? AND kind = 'source'", [id]);
    expect(hist.length).toBe(1);
    const tile = (await h.json(OWNER, 'GET', '/api/dashboard?space=work')).body.tiles[0];
    expect(tile.freshness.state).toBe('error');
    expect(tile.flags.some((f: any) => f.kind === 'source_error')).toBe(true);
    expect(tile.status_summary).toBe('Design phase'); // last known state retained
  });

  it('without an LLM it flags changes for review and infers nothing', async () => {
    const { h, id } = await setup(false);
    await runRefresh(h.deps, { trigger: 'manual', idemKey: 'a' });
    const p = await h.db.first<any>('SELECT status, status_summary, needs_review FROM projects WHERE id = ?', [id]);
    expect(p).toEqual({ status: 'in_progress', status_summary: 'Design phase', needs_review: 1 });
    expect((await ms(h, id)).every((m: any) => m.state === 'not_started')).toBe(true);
  });

  it('retries the summary next run when the LLM fails (source hash not advanced)', async () => {
    const { h } = await setup();
    h.llm.fail = 'overloaded';
    await runRefresh(h.deps, { trigger: 'manual', idemKey: 'a' });
    expect(h.llm.calls.length).toBe(1);
    h.llm.fail = null;
    h.llm.next = () => emptyProposal();
    await runRefresh(h.deps, { trigger: 'manual', idemKey: 'b' });
    expect(h.llm.calls.length).toBe(2);
    await runRefresh(h.deps, { trigger: 'manual', idemKey: 'c' });
    expect(h.llm.calls.length).toBe(2);
  });

  it('prevents concurrent refreshes', async () => {
    const { h } = await setup();
    expect(await acquireLock(h.deps, 'refresh', 'someone-else')).toBe(true);
    const r = await runRefresh(h.deps, { trigger: 'manual', idemKey: 'x' });
    expect(r.status).toBe('skipped');
  });

  it('Refresh now: editors may trigger it, viewers may not; reference links are never fetched', async () => {
    const { h, id } = await setup();
    h.llm.next = () => emptyProposal();
    await h.op(OWNER, 'add_source', { project_id: id, url: 'https://chatgpt.com/space/page_abc' });
    const src = await h.db.first<any>("SELECT kind, connection, last_error FROM sources WHERE url LIKE 'https://chatgpt.com%'");
    expect(src.kind).toBe('reference');
    expect(src.connection).toBe('reference_only');
    expect(src.last_error).toContain('cannot be read');
    expect((await h.json(WORK_VIEWER, 'POST', '/api/refresh', {})).status).toBe(403);
    const r = await h.json(WORK_EDITOR, 'POST', '/api/refresh', { project_id: id });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('succeeded');
    expect(h.fetchLog.some((l) => l.includes('chatgpt.com'))).toBe(false);
  });
});
