// Natural-language commands, the MCP endpoint (with the official MCP client), and persistence.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app';
import { harness, idByName, OWNER, seed, WORK_EDITOR, WORK_VIEWER } from './helpers';

async function setup(llm = false) {
  const h = await harness({ llm, start: '2026-10-04T02:00:00Z' });
  await seed(h, [
    { space: 'work', name: 'Supplier Portal', milestones: [{ title: 'Contract signed' }, { title: 'Pilot launched' }] },
    { space: 'work', name: 'Budget Review' },
  ]);
  return { h, id: await idByName(h, 'Supplier Portal') };
}

const cmd = (h: any, text: string, project_id?: string, who = OWNER) => h.json(who, 'POST', '/api/assistant/command', { text, project_id });

describe('natural-language commands (rule interpreter, no API key needed)', () => {
  it('understands the example requests and previews before applying', async () => {
    const { h, id } = await setup();
    const cases: [string, string, Record<string, unknown>][] = [
      ['Add project Kitchen refit to Work', 'create_project', { name: 'Kitchen refit', space: 'work' }],
      ['Mark this milestone complete', 'complete_milestone', { project_id: id }],
      ['Mark the pilot launched milestone complete', 'complete_milestone', { project_id: id }],
      ['Flag this as blocked while we wait for the supplier', 'flag_blocked', { project_id: id, reason: 'Waiting for the supplier' }],
      ['Pin this project', 'set_pinned', { project_id: id, pinned: true }],
      ['Change the target to 15 October', 'set_target_date', { project_id: id, date: '2026-10-15', kind: 'target' }],
      ['Make this project visible only to me', 'set_only_me', { project_id: id, enabled: true }],
      ['Pause budget review', 'set_lifecycle', { lifecycle: 'paused' }],
    ];
    for (const [text, op, args] of cases) {
      const r = await cmd(h, text, id);
      expect(r.status, text).toBe(200);
      expect(r.body.interpreter, text).toBe('rules');
      expect(r.body.operations[0]?.op, text).toBe(op);
      expect(r.body.operations[0].args, text).toMatchObject(args);
      expect(r.body.operations[0].description.length).toBeGreaterThan(5);
    }
    // Preview did not change anything.
    expect((await h.db.first<any>('SELECT pinned FROM projects WHERE id = ?', [id])).pinned).toBe(0);
    const preview = (await cmd(h, 'Pin this project', id)).body.operations;
    const applied = await h.json(OWNER, 'POST', '/api/assistant/apply', { operations: preview });
    expect(applied.body.applied[0]).toMatchObject({ ok: true });
    expect((await h.db.first<any>('SELECT pinned FROM projects WHERE id = ?', [id])).pinned).toBe(1);
  });

  it('asks for clarification instead of guessing', async () => {
    const { h } = await setup();
    expect((await cmd(h, 'Pin this project')).body.clarification).toContain('Which project');
    expect((await cmd(h, 'Add this project to Work')).body.clarification).toContain('called');
    expect((await cmd(h, 'Flag this as blocked', await idByName(h, 'Budget Review'))).body.clarification).toContain('blocked by');
    expect((await cmd(h, 'Do my laundry')).body.operations).toEqual([]);
  });

  it('respects the requesting user permissions', async () => {
    const { h, id } = await setup();
    expect((await cmd(h, 'Pin this project', id, WORK_VIEWER)).body.clarification).toContain('view-only');
    const r = await cmd(h, 'Make this project visible only to me', id, WORK_EDITOR);
    const applied = await h.json(WORK_EDITOR, 'POST', '/api/assistant/apply', { operations: r.body.operations });
    expect(applied.body.applied[0].ok).toBe(false);
  });

  it('falls back to the LLM with only permitted tools and validates its output', async () => {
    const { h, id } = await setup(true);
    h.llm.commandReply = { calls: [{ name: 'update_project', input: { project_id: id, priority: 'high' } }, { name: 'set_only_me', input: { project_id: id, enabled: true } }], text: '' };
    const r = await cmd(h, 'This one is really important now', id, WORK_EDITOR);
    expect(r.body.interpreter).toBe('llm');
    expect(r.body.operations.map((o: any) => o.op)).toEqual(['update_project']); // owner-only tool rejected
    const toolNames = h.llm.commandCalls[0].tools.map((t) => t.name);
    expect(toolNames).not.toContain('set_only_me');
    expect(toolNames).not.toContain('create_project');
  });
});

describe('MCP endpoint (official MCP TypeScript client)', () => {
  it('lists tools, reads and writes with the token holder permissions', async () => {
    const { h, id } = await setup();
    const token = (await h.json(OWNER, 'POST', '/api/tokens', { name: 'Claude Code', scope: 'write' })).body.token;
    const app = createApp(() => h.deps);
    const transport = new StreamableHTTPClientTransport(new URL('http://dash.test/mcp'), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
      fetch: async (url, init) => app.request(String(url), init as RequestInit),
    });
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(transport);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['list_projects', 'get_project', 'search_projects', 'get_daily_summary', 'set_pinned', 'complete_milestone', 'set_only_me', 'create_project']));
    const list = await client.callTool({ name: 'list_projects', arguments: { space: 'work' } });
    expect((list.content as any)[0].text).toContain('Supplier Portal');
    const pin = await client.callTool({ name: 'set_pinned', arguments: { project_id: id, pinned: true } });
    expect(pin.isError).toBe(false);
    const hist = await h.db.first<{ actor_type: string; actor_label: string }>("SELECT actor_type, actor_label FROM history WHERE project_id = ? AND summary = 'Pinned'", [id]);
    expect(hist).toEqual({ actor_type: 'assistant', actor_label: 'owner (via MCP)' });
    const bad = await client.callTool({ name: 'set_pinned', arguments: { project_id: 'nope', pinned: true } });
    expect(bad.isError).toBe(true);
    await client.close();
  });

  it('rejects MCP calls without a valid token', async () => {
    const { h } = await setup();
    const r = await h.json(null, 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { authorization: 'Bearer pd_invalid' });
    expect(r.status).toBe(401);
  });
});

describe('cross-device persistence', () => {
  it('an edit made through one app instance is visible from another (shared durable store)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dash-'));
    const path = join(dir, 'shared.sqlite');
    try {
      const laptop = await harness({ dbPath: path });
      await seed(laptop, [{ space: 'work', name: 'Shared Project' }]);
      const id = await idByName(laptop, 'Shared Project');
      expect((await laptop.op(OWNER, 'update_project', { project_id: id, status_summary: 'Edited on the laptop' })).status).toBe(200);
      laptop.db.close();
      // A different "device": new app instance, new DB connection, new sign-in.
      const projector = await harness({ dbPath: path });
      const tile = (await projector.json(OWNER, 'GET', '/api/dashboard?space=work')).body.tiles[0];
      expect(tile.status_summary).toBe('Edited on the laptop');
      projector.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects stale writes with 409 instead of silently overwriting', async () => {
    const { h, id } = await setup();
    const v = (await h.json(OWNER, 'GET', `/api/projects/${id}`)).body.version;
    expect((await h.op(OWNER, 'update_project', { project_id: id, status_summary: 'first', expected_version: v })).status).toBe(200);
    expect((await h.op(OWNER, 'update_project', { project_id: id, status_summary: 'second', expected_version: v })).status).toBe(409);
  });
});
