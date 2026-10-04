// Regression tests for issues found in the independent security/correctness review.
import { describe, expect, it } from 'vitest';
import { runDailySummaries } from '../src/server/summary';
import { runRefresh } from '../src/server/updater/refresh';
import { isPublicHttpUrl } from '../src/server/updater/sources';
import { emptyProposal, harness, idByName, OWNER, seed, WORK_EDITOR, WORK_VIEWER } from './helpers';

describe('credentialed sources', () => {
  it('only the owner can attach GitHub/Notion sources (read with the owner tokens)', async () => {
    const h = await harness({ env: { GITHUB_TOKEN: 'ghp_owner', NOTION_TOKEN: 'ntn_owner' } });
    await seed(h, [{ space: 'work', name: 'W' }]);
    const id = await idByName(h, 'W');
    for (const url of ['https://github.com/owner/private/blob/main/salaries.md', 'https://www.notion.so/x/Secret-0123456789abcdef0123456789abcdef']) {
      expect((await h.op(WORK_EDITOR, 'add_source', { project_id: id, url })).status).toBe(403);
      expect((await h.op(OWNER, 'add_source', { project_id: id, url })).status).toBe(200);
    }
    expect((await h.op(WORK_EDITOR, 'add_source', { project_id: id, url: 'https://example.com/status' })).status).toBe(200);
    expect((await h.op(WORK_EDITOR, 'add_source', { project_id: id, snapshot_text: 'pasted text', as_of: '2026-10-01' })).status).toBe(200);
  });

  it('refuses non-public and non-http addresses', () => {
    for (const u of ['http://localhost:8787/x', 'http://127.0.0.1/', 'http://10.1.2.3/', 'http://192.168.0.1/', 'http://169.254.169.254/latest', 'http://[::1]/', 'http://intranet/', 'file:///etc/passwd', 'https://user:pw@example.com/']) expect(isPublicHttpUrl(u), u).toBe(false);
    expect(isPublicHttpUrl('https://example.com/status')).toBe(true);
  });

  it('rejects javascript: and other non-http links', async () => {
    const h = await harness();
    await seed(h, [{ space: 'work', name: 'W' }]);
    const id = await idByName(h, 'W');
    expect((await h.op(OWNER, 'update_project', { project_id: id, canonical_url: 'javascript:alert(1)' })).status).toBe(400);
    expect((await h.op(OWNER, 'add_source', { project_id: id, url: 'javascript:alert(1)' })).status).toBe(400);
    expect((await h.op(OWNER, 'create_project', { space: 'work', name: 'X', canonical_url: 'data:text/html,hi' })).status).toBe(400);
  });
});

describe('updater grounding and isolation', () => {
  async function setup(extra: unknown[] = []) {
    const h = await harness({ llm: true });
    await seed(h, [
      { space: 'work', name: 'Visible', status: 'in_progress', status_summary: 'orig', milestones: [{ title: 'Ship it' }], sources: [{ title: 'Snap', snapshot_text: 'The launch has NOT happened yet; testing continues.', as_of: '2026-10-04' }] },
      { space: 'work', name: 'Zephyr Secret', only_me: true },
      ...extra,
    ]);
    const id = await idByName(h, 'Visible');
    // Edit the snapshot so it counts as changed (imported snapshots are marked processed).
    await h.db.run("UPDATE sources SET snapshot_text = snapshot_text || ' Update: still waiting for the security review to finish.' WHERE project_id = ?", [id]);
    return { h, id };
  }

  it('never shows "Only me" project names to the model when processing another project', async () => {
    const { h } = await setup();
    h.llm.next = () => emptyProposal();
    await runRefresh(h.deps, { trigger: 'cron', idemKey: 'a' });
    expect(h.llm.calls.length).toBe(1);
    expect(JSON.stringify(h.llm.calls[0])).not.toContain('Zephyr');
  });

  it('does not change status without a grounded quote from the new text', async () => {
    const { h, id } = await setup();
    h.llm.next = () => ({ ...emptyProposal(), material_change: true, change_summary: 'x', status: { value: 'blocked', summary: 'Blocked!', detail: '', basis: 'suggestion', citations: [] } });
    await runRefresh(h.deps, { trigger: 'cron', idemKey: 'a' });
    const p = await h.db.first<any>('SELECT status, status_summary FROM projects WHERE id = ?', [id]);
    expect(p).toEqual({ status: 'in_progress', status_summary: 'orig' });
    const hist = await h.db.first<{ detail: string }>("SELECT detail FROM history WHERE project_id = ? AND kind = 'auto_update'", [id]);
    expect(JSON.parse(hist!.detail).suppressed.join(' ')).toContain('no quote');
  });

  it('cannot complete a milestone with irrelevant or synthetic quotes', async () => {
    const { h, id } = await setup();
    const [m] = await h.db.all<{ id: string }>('SELECT id FROM milestones WHERE project_id = ?', [id]);
    h.llm.next = (input) => ({
      ...emptyProposal(),
      material_change: true,
      change_summary: 'x',
      milestone_updates: [{ milestone_id: m.id, state: 'done', evidence: 'x', citations: [{ source_id: input.changes[0].source_id, quote: 'Snapshot as of 2026-10-04' }, { source_id: input.changes[0].source_id, quote: 'launch' }] }],
    });
    await runRefresh(h.deps, { trigger: 'cron', idemKey: 'a' });
    expect((await h.db.first<any>('SELECT state FROM milestones WHERE id = ?', [m.id])).state).toBe('not_started');
  });

  it('a concurrent manual edit or deleted source does not fail the run', async () => {
    const h = await harness();
    await seed(h, [{ space: 'work', name: 'P', sources: [{ title: 'Page', url: 'https://example.test/p' }] }]);
    const id = await idByName(h, 'P');
    h.web.set('https://example.test/p', { body: '<p>Version one of the page content.</p>' });
    const realFetch = h.deps.fetch;
    h.deps.fetch = async (u, i) => {
      await h.op(OWNER, 'set_pinned', { project_id: id, pinned: true }); // edit while the source is being read
      return realFetch(u, i);
    };
    const r = await runRefresh(h.deps, { trigger: 'manual', idemKey: 'a' });
    expect(r.status).toBe('succeeded');
    expect(await h.db.first('SELECT pinned, needs_review FROM projects WHERE id = ?', [id])).toEqual({ pinned: 1, needs_review: 1 });

    const h2 = await harness({ llm: true });
    await seed(h2, [{ space: 'work', name: 'Q', sources: [{ title: 'Page', url: 'https://example.test/q' }] }]);
    const q = await idByName(h2, 'Q');
    h2.web.set('https://example.test/q', { body: '<p>Some content for the page here.</p>' });
    h2.llm.next = () => {
      void h2.db.run('DELETE FROM sources WHERE project_id = ?', [q]);
      void h2.db.run('UPDATE projects SET version = version + 1 WHERE id = ?', [q]);
      return { ...emptyProposal(), material_change: true, change_summary: 'x' };
    };
    const r2 = await runRefresh(h2.deps, { trigger: 'manual', idemKey: 'b' });
    expect(r2.status).toBe('succeeded');
  });

  it('one failing project does not abort the run or release the lock early', async () => {
    const h = await harness({ llm: true });
    await seed(h, [
      { space: 'work', name: 'Bad', sources: [{ title: 'B', url: 'https://example.test/bad' }] },
      { space: 'work', name: 'Good', sources: [{ title: 'G', url: 'https://example.test/good' }] },
    ]);
    h.web.set('https://example.test/bad', { body: '<p>bad page content goes here</p>' });
    h.web.set('https://example.test/good', { body: '<p>good page content goes here</p>' });
    h.llm.next = (input) => {
      if (input.project.name === 'Bad') return { ...emptyProposal(), material_change: true, change_summary: 'x', next_steps: [{ title: null as never, assignee: '', needs_decision: false, is_primary: true, basis: 'suggestion', citations: [] }] };
      return { ...emptyProposal(), material_change: true, change_summary: 'Good change applied' };
    };
    const r = await runRefresh(h.deps, { trigger: 'manual', idemKey: 'a' });
    expect(r.status).toBe('partial');
    expect(r.stats.project_errors).toBe(1);
    const good = await idByName(h, 'Good');
    expect((await h.db.first<any>("SELECT summary FROM history WHERE project_id = ? AND kind = 'auto_update'", [good])).summary).toBe('Good change applied');
    expect(await h.db.first('SELECT COUNT(*) AS n FROM locks')).toEqual({ n: 0 });
  });
});

describe('operations', () => {
  it('the cycle check does not reveal hidden projects', async () => {
    const h = await harness();
    await seed(h, [{ space: 'work', name: 'A' }, { space: 'work', name: 'B' }, { space: 'work', name: 'Hidden', only_me: true }]);
    const [a, b, x] = [await idByName(h, 'A'), await idByName(h, 'B'), await idByName(h, 'Hidden')];
    await h.op(OWNER, 'add_dependency', { project_id: b, depends_on_id: x });
    await h.op(OWNER, 'add_dependency', { project_id: x, depends_on_id: a });
    expect((await h.op(WORK_EDITOR, 'add_dependency', { project_id: a, depends_on_id: b })).status).toBe(200);
  });

  it('a stale deadline suggestion cannot overwrite a newer confirmed deadline', async () => {
    const h = await harness();
    await seed(h, [{ space: 'work', name: 'D', milestones: [{ title: 'Go live' }] }]);
    const id = await idByName(h, 'D');
    const m = await h.db.first<{ id: string }>('SELECT id FROM milestones WHERE project_id = ?', [id]);
    await h.db.run("INSERT INTO suggestions (id, project_id, kind, payload, rationale, dedupe_key, created_at) VALUES ('sg1', ?, 'deadline', ?, 'r', 'k', '2026-10-01')", [id, JSON.stringify({ milestone_id: m!.id, date: '2026-11-01', quote: 'q', current: null })]);
    await h.op(OWNER, 'set_target_date', { project_id: id, milestone_id: m!.id, date: '2026-12-15', kind: 'deadline' });
    expect((await h.op(WORK_EDITOR, 'resolve_suggestion', { project_id: id, suggestion_id: 'sg1', accept: true })).status).toBe(409);
    expect((await h.db.first<any>('SELECT deadline FROM milestones WHERE id = ?', [m!.id])).deadline).toBe('2026-12-15');
  });

  it('removing a non-existent dependency changes nothing', async () => {
    const h = await harness();
    await seed(h, [{ space: 'work', name: 'A' }, { space: 'work', name: 'B' }]);
    const [a, b] = [await idByName(h, 'A'), await idByName(h, 'B')];
    const before = await h.db.first<any>('SELECT version FROM projects WHERE id = ?', [a]);
    await h.op(OWNER, 'remove_dependency', { project_id: a, depends_on_id: b });
    expect(await h.db.first<any>('SELECT version FROM projects WHERE id = ?', [a])).toEqual(before);
    expect(await h.db.first("SELECT COUNT(*) AS n FROM history WHERE project_id = ? AND kind = 'dependency'", [a])).toEqual({ n: 0 });
  });
});

describe('tokens, auth and bookkeeping', () => {
  it('read-only tokens cannot revoke tokens or change preferences', async () => {
    const h = await harness();
    const w = (await h.json(OWNER, 'POST', '/api/tokens', { name: 'w', scope: 'write' })).body;
    const r = (await h.json(OWNER, 'POST', '/api/tokens', { name: 'r', scope: 'read' })).body;
    const auth = { authorization: `Bearer ${r.token}` };
    expect((await h.json(null, 'DELETE', `/api/tokens/${w.id}`, undefined, auth)).status).toBe(403);
    expect((await h.json(null, 'POST', '/api/me/preferences', { summary_email: false }, auth)).status).toBe(403);
  });

  it('malformed cookies are a clean 401, not a server error', async () => {
    const h = await harness();
    expect((await h.req(null, 'GET', '/api/me', undefined, { cookie: 'CF_Authorization=%E0%A4%A' })).status).toBe(401);
    expect((await h.req(null, 'GET', '/api/me', undefined, { cookie: 'CF_Authorization=a.b.!!!' })).status).toBe(401);
  });

  it('the daily summary job does not mark people as seen', async () => {
    const h = await harness({ start: '2026-10-05T23:30:00Z' });
    await runDailySummaries(h.deps);
    const v = await h.db.first<{ last_seen_at: string | null }>('SELECT last_seen_at FROM users WHERE email = ?', [WORK_VIEWER]);
    expect(v!.last_seen_at).toBeNull();
  });

  it('import validates everything first and restores dependencies from an export', async () => {
    const h = await harness();
    const bad = await h.json(OWNER, 'POST', '/api/admin/import', { projects: [{ space: 'work', name: 'OK' }, { space: 'work', name: 'Broken', sources: [{ title: 'nothing' }] }] });
    expect(bad.status).toBe(400);
    expect(await h.db.first('SELECT COUNT(*) AS n FROM projects')).toEqual({ n: 0 });
    await seed(h, [{ space: 'work', name: 'A' }, { space: 'work', name: 'B' }]);
    await h.op(OWNER, 'add_dependency', { project_id: await idByName(h, 'A'), depends_on_id: await idByName(h, 'B') });
    const exported = (await h.json(OWNER, 'GET', '/api/admin/export')).body;
    const h2 = await harness();
    const res = await h2.json(OWNER, 'POST', '/api/admin/import', exported);
    expect(res.body).toMatchObject({ created: ['A', 'B'], dependencies: 1 });
  });
});
