// Personal/Work separation, "Only me" restriction, view-only enforcement, authentication.
import { beforeEach, describe, expect, it } from 'vitest';
import { harness, idByName, OUTSIDER, OWNER, RENATA, seed, WORK_EDITOR, WORK_VIEWER, type Harness } from './helpers';

const SECRET_WORDS = ['Zephyr', 'Gift'];

async function setup(opts: { llm?: boolean } = {}) {
  const h = await harness(opts);
  await seed(h, [
    { space: 'work', name: 'Work Alpha', status_summary: 'Visible work project', milestones: [{ title: 'Alpha kickoff' }], next_steps: [{ title: 'Alpha next', is_primary: true }] },
    { space: 'work', name: 'Zephyr Acquisition', only_me: true, status_summary: 'Zephyr confidential', milestones: [{ title: 'Zephyr diligence', deadline: '2026-10-01' }], next_steps: [{ title: 'Zephyr call', needs_decision: true }], issues: [{ kind: 'blocker', title: 'Zephyr blocker' }] },
    { space: 'personal', name: 'Home Garden', milestones: [{ title: 'Plant herbs' }] },
    { space: 'personal', name: 'Anniversary Gift Plan', only_me: true, milestones: [{ title: 'Gift booked', deadline: '2026-10-06' }] },
    { space: 'work', name: 'Zephyr Archive', only_me: true, lifecycle: 'archived' },
  ]);
  const alpha = await idByName(h, 'Work Alpha');
  const zephyr = await idByName(h, 'Zephyr Acquisition');
  // The owner records a genuine dependency between a shared project and an "Only me" one.
  expect((await h.op(OWNER, 'add_dependency', { project_id: alpha, depends_on_id: zephyr, note: 'Zephyr dependency' })).status).toBe(200);
  return { h, alpha, zephyr, garden: await idByName(h, 'Home Garden'), gift: await idByName(h, 'Anniversary Gift Plan') };
}

function expectNoSecrets(payload: unknown) {
  const s = JSON.stringify(payload);
  for (const w of SECRET_WORDS) expect(s, `leaked "${w}"`).not.toContain(w);
}

describe('authentication', () => {
  let h: Harness;
  beforeEach(async () => ({ h } = await setup()));

  it('rejects anonymous, forged, expired and foreign-audience tokens', async () => {
    expect((await h.json(null, 'GET', '/api/me')).status).toBe(401);
    expect((await h.req(null, 'GET', '/')).status).toBe(401); // the UI shell itself is protected
    const good = await h.signer.issue(OWNER, { now: h.clock.now });
    const [a, b] = good.split('.');
    const forged = `${a}.${b}.${'A'.repeat(342)}`;
    const expired = await h.signer.issue(OWNER, { now: new Date(h.clock.now.getTime() - 48 * 3600_000), ttlSec: 60 });
    const wrongAud = await h.signer.issue(OWNER, { aud: 'another-app', now: h.clock.now });
    const wrongIss = await h.signer.issue(OWNER, { iss: 'https://evil.cloudflareaccess.com', now: h.clock.now });
    for (const t of [forged, expired, wrongAud, wrongIss, 'garbage']) {
      const r = await h.req(null, 'GET', '/api/me', undefined, { cookie: `CF_Authorization=${t}` });
      expect(r.status).toBe(401);
    }
    const ok = await h.req(null, 'GET', '/api/me', undefined, { 'cf-access-jwt-assertion': good });
    expect(ok.status).toBe(200);
  });

  it('rejects signed-in people who were not invited', async () => {
    const r = await h.json(OUTSIDER, 'GET', '/api/me');
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('not_invited');
  });

  it('fails closed when Access is not configured', async () => {
    const h2 = await harness();
    h2.deps.config.accessAud = '';
    expect((await h2.json(OWNER, 'GET', '/api/me')).status).toBe(503);
  });

  it('requires the CSRF header and same origin for browser mutations', async () => {
    const pid = await idByName(h, 'Work Alpha');
    const noHeader = await h.json(OWNER, 'POST', '/api/ops', { op: 'set_pinned', args: { project_id: pid, pinned: true } }, { 'x-requested-with': '' });
    expect(noHeader.status).toBe(403);
    const crossOrigin = await h.json(OWNER, 'POST', '/api/ops', { op: 'set_pinned', args: { project_id: pid, pinned: true } }, { origin: 'https://evil.example' });
    expect(crossOrigin.status).toBe(403);
  });
});

describe('Personal / Work separation', () => {
  it('Renata sees only shared Personal projects', async () => {
    const { h, alpha, zephyr, garden, gift } = await setup();
    const me = await h.json(RENATA, 'GET', '/api/me');
    expect(me.body.spaces).toEqual([{ space: 'personal', can_edit: false }]);
    const dash = await h.json(RENATA, 'GET', '/api/dashboard?space=personal');
    expect(dash.body.tiles.map((t: any) => t.name)).toEqual(['Home Garden']);
    expect(dash.body.counts).toEqual({ active: 1, paused: 0, archive: 0 });
    expect((await h.json(RENATA, 'GET', '/api/dashboard?space=work')).status).toBe(404);
    expect((await h.json(RENATA, 'GET', '/api/map?space=work')).status).toBe(404);
    expect((await h.json(RENATA, 'GET', `/api/projects/${alpha}`)).status).toBe(404);
    expect((await h.json(RENATA, 'GET', `/api/projects/${zephyr}`)).status).toBe(404);
    expect((await h.json(RENATA, 'GET', `/api/projects/${gift}`)).status).toBe(404);
    expect((await h.json(RENATA, 'GET', `/api/projects/${garden}`)).status).toBe(200);
    expect((await h.json(RENATA, 'GET', '/api/search?q=Alpha')).body.results).toEqual([]);
  });

  it('work invitees cannot see Personal at all', async () => {
    const { h, garden } = await setup();
    for (const who of [WORK_VIEWER, WORK_EDITOR]) {
      expect((await h.json(who, 'GET', '/api/dashboard?space=personal')).status).toBe(404);
      expect((await h.json(who, 'GET', `/api/projects/${garden}`)).status).toBe(404);
      expect((await h.json(who, 'GET', '/api/search?q=Garden')).body.results).toEqual([]);
    }
  });

  it('Personal access can only be granted to allow-listed people', async () => {
    const { h } = await setup();
    const r = await h.json(OWNER, 'POST', '/api/admin/users', { email: 'colleague2@test.example', spaces: [{ space: 'personal' }] });
    expect(r.status).toBe(400);
    const user = await h.db.first<{ id: string }>('SELECT id FROM users WHERE email = ?', [WORK_VIEWER]);
    const g = await h.json(OWNER, 'POST', '/api/admin/grants', { user_id: user!.id, space: 'personal', access: 'view' });
    expect(g.status).toBe(400);
  });

  it('dependencies cannot cross spaces', async () => {
    const { h, alpha, garden } = await setup();
    const r = await h.op(OWNER, 'add_dependency', { project_id: alpha, depends_on_id: garden });
    expect(r.status).toBe(400);
  });
});

describe('"Only me" projects are invisible to everyone else', () => {
  it('owner sees them; others never get names, details, counts or links', async () => {
    const { h, alpha, zephyr, gift } = await setup({ llm: true });
    const own = await h.json(OWNER, 'GET', '/api/dashboard?space=work');
    expect(own.body.tiles.map((t: any) => t.name).sort()).toEqual(['Work Alpha', 'Zephyr Acquisition']);
    expect(own.body.counts.archive).toBe(1);

    for (const who of [RENATA, WORK_VIEWER, WORK_EDITOR]) {
      const me = (await h.json(who, 'GET', '/api/me')).body;
      const payloads: unknown[] = [me];
      for (const s of me.spaces.map((x: any) => x.space)) {
        const dash = await h.json(who, 'GET', `/api/dashboard?space=${s}`);
        expect(dash.body.counts.archive).toBe(0);
        payloads.push(dash.body, (await h.json(who, 'GET', `/api/archive?space=${s}`)).body, (await h.json(who, 'GET', `/api/map?space=${s}`)).body);
      }
      for (const q of ['Zephyr', 'Gift', 'diligence', 'blocker']) payloads.push((await h.json(who, 'GET', `/api/search?q=${q}`)).body);
      for (const id of [zephyr, gift]) {
        const r = await h.json(who, 'GET', `/api/projects/${id}`);
        expect(r.status).toBe(404);
        payloads.push(r.body);
        // Direct operations against a hidden project look exactly like a non-existent one.
        const op = await h.op(who, 'set_pinned', { project_id: id, pinned: true });
        expect(op.status).toBe(404);
        payloads.push(op.body);
      }
      if (me.spaces.some((x: any) => x.space === 'work')) {
        const detail = await h.json(who, 'GET', `/api/projects/${alpha}`);
        expect(detail.status).toBe(200);
        expect(detail.body.depends_on).toEqual([]);
        payloads.push(detail.body);
      }
      payloads.push((await h.json(who, 'GET', '/api/summary')).body);
      expectNoSecrets(payloads);
    }
  });

  it('the change-detection etag does not reveal activity on hidden projects', async () => {
    const { h, zephyr } = await setup();
    const before = (await h.json(WORK_VIEWER, 'GET', '/api/version?space=work')).body.etag;
    expect((await h.op(OWNER, 'update_project', { project_id: zephyr, status_summary: 'changed' })).status).toBe(200);
    const after = (await h.json(WORK_VIEWER, 'GET', '/api/version?space=work')).body.etag;
    expect(after).toBe(before);
    const ownerBefore = (await h.json(OWNER, 'GET', '/api/version?space=work')).body.etag;
    await h.op(OWNER, 'update_project', { project_id: zephyr, status_summary: 'changed again' });
    expect((await h.json(OWNER, 'GET', '/api/version?space=work')).body.etag).not.toBe(ownerBefore);
  });

  it('natural-language interpretation never sees hidden projects', async () => {
    const { h, alpha } = await setup({ llm: true });
    h.llm.commandReply = { calls: [], text: 'Which project?' };
    await h.json(WORK_EDITOR, 'POST', '/api/assistant/command', { text: 'please do something clever', project_id: alpha });
    expect(h.llm.commandCalls.length).toBe(1);
    expectNoSecrets(h.llm.commandCalls[0].context);
  });

  it('only the owner can toggle Only me, and turning it off restores visibility', async () => {
    const { h, alpha, zephyr } = await setup();
    expect((await h.op(WORK_EDITOR, 'set_only_me', { project_id: alpha, enabled: true })).status).toBe(403);
    expect((await h.op(OWNER, 'set_only_me', { project_id: alpha, enabled: true })).status).toBe(200);
    expect((await h.json(WORK_VIEWER, 'GET', `/api/projects/${alpha}`)).status).toBe(404);
    expect((await h.op(OWNER, 'set_only_me', { project_id: zephyr, enabled: false })).status).toBe(200);
    const z = await h.json(WORK_VIEWER, 'GET', `/api/projects/${zephyr}`);
    expect(z.status).toBe(200);
    // History about the restricted period stays owner-only.
    expect(JSON.stringify(z.body.history)).not.toContain('Only me');
  });

  it('MCP tools respect the restriction', async () => {
    const { h } = await setup();
    const tok = (await h.json(WORK_EDITOR, 'POST', '/api/tokens', { name: 'assistant', scope: 'write' })).body.token;
    const call = async (method: string, params: unknown) =>
      (await h.json(null, 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method, params }, { authorization: `Bearer ${tok}` })).body;
    const list = await call('tools/call', { name: 'list_projects', arguments: {} });
    expect(list.result.content[0].text).toContain('Work Alpha');
    expectNoSecrets(list);
    expectNoSecrets(await call('tools/call', { name: 'search_projects', arguments: { query: 'Zephyr' } }));
    expectNoSecrets(await call('tools/call', { name: 'get_daily_summary', arguments: {} }));
  });
});

describe('view-only users cannot edit', () => {
  it('rejects every mutation path for viewers', async () => {
    const { h, alpha, garden } = await setup();
    const targets: [string, string][] = [
      [WORK_VIEWER, alpha],
      [RENATA, garden],
    ];
    for (const [who, pid] of targets) {
      for (const [op, args] of [
        ['update_project', { project_id: pid, status: 'blocked' }],
        ['set_pinned', { project_id: pid, pinned: true }],
        ['set_lifecycle', { project_id: pid, lifecycle: 'paused' }],
        ['flag_blocked', { project_id: pid, reason: 'x' }],
        ['add_milestone', { project_id: pid, title: 'm' }],
        ['add_next_step', { project_id: pid, title: 's' }],
        ['add_source', { project_id: pid, url: 'https://example.test/x' }],
        ['set_target_date', { project_id: pid, date: '2026-10-15' }],
        ['create_project', { space: 'work', name: 'nope' }],
      ] as const) {
        const r = await h.op(who, op, args);
        expect(r.status, `${who} ${op}`).toBe(403);
      }
      expect((await h.json(who, 'POST', '/api/refresh', {})).status).toBe(403);
      const nl = await h.json(who, 'POST', '/api/assistant/command', { text: 'Pin this project', project_id: pid });
      expect(nl.body.operations).toEqual([]);
      const applied = await h.json(who, 'POST', '/api/assistant/apply', { operations: [{ op: 'set_pinned', args: { project_id: pid, pinned: true } }] });
      expect(applied.body.applied[0].ok).toBe(false);
      expect((await h.json(who, 'GET', '/api/admin/users')).status).toBe(403);
    }
    // Nothing changed.
    const p = await h.db.first<{ pinned: number; version: number }>('SELECT pinned, version FROM projects WHERE id = ?', [alpha]);
    expect(p!.pinned).toBe(0);
  });

  it('viewer tokens never get write tools, even with write scope', async () => {
    const { h, alpha } = await setup();
    const tok = (await h.json(WORK_VIEWER, 'POST', '/api/tokens', { name: 'x', scope: 'write' })).body.token;
    const auth = { authorization: `Bearer ${tok}` };
    const tools = (await h.json(null, 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, auth)).body.result.tools.map((t: any) => t.name);
    expect(tools).toContain('list_projects');
    expect(tools).not.toContain('set_pinned');
    const r = (await h.json(null, 'POST', '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'set_pinned', arguments: { project_id: alpha, pinned: true } } }, auth)).body;
    expect(r.result.isError).toBe(true);
    expect((await h.json(null, 'POST', '/api/ops', { op: 'set_pinned', args: { project_id: alpha, pinned: true } }, auth)).status).toBe(403);
  });

  it('read-scoped tokens cannot write even for the owner; revoked tokens stop working', async () => {
    const { h, alpha } = await setup();
    const t = (await h.json(OWNER, 'POST', '/api/tokens', { name: 'ro', scope: 'read' })).body;
    const auth = { authorization: `Bearer ${t.token}` };
    expect((await h.json(null, 'GET', '/api/dashboard?space=work', undefined, auth)).status).toBe(200);
    expect((await h.json(null, 'POST', '/api/ops', { op: 'set_pinned', args: { project_id: alpha, pinned: true } }, auth)).status).toBe(403);
    await h.json(OWNER, 'DELETE', `/api/tokens/${t.id}`);
    expect((await h.json(null, 'GET', '/api/dashboard?space=work', undefined, auth)).status).toBe(401);
  });

  it('editors can edit content but not owner-only controls', async () => {
    const { h, alpha } = await setup();
    expect((await h.op(WORK_EDITOR, 'set_pinned', { project_id: alpha, pinned: true })).status).toBe(200);
    expect((await h.op(WORK_EDITOR, 'update_project', { project_id: alpha, status: 'at_risk' })).status).toBe(200);
    expect((await h.op(WORK_EDITOR, 'set_lifecycle', { project_id: alpha, lifecycle: 'paused' })).status).toBe(200);
    expect((await h.op(WORK_EDITOR, 'set_lifecycle', { project_id: alpha, lifecycle: 'archived' })).status).toBe(403);
    expect((await h.op(WORK_EDITOR, 'create_project', { space: 'work', name: 'x' })).status).toBe(403);
    expect((await h.op(WORK_EDITOR, 'delete_project', { project_id: alpha, confirm_name: 'Work Alpha' })).status).toBe(403);
  });
});
