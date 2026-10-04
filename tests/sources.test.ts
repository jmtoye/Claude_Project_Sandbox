// Source connectors with a fake network: classification, HTML extraction, GitHub, Notion, sign-in walls.
import { describe, expect, it } from 'vitest';
import type { SourceRow } from '../src/server/rows';
import { classifyUrl, fetchSource, htmlToText, lineDiff, quoteIsGrounded } from '../src/server/updater/sources';

const src = (o: Partial<SourceRow>): SourceRow => ({
  id: 's', project_id: 'p', kind: 'web', role: 'supporting', title: 't', url: '', config: '{}', snapshot_text: '', as_of: null, connection: 'pending',
  last_checked_at: null, last_success_at: null, last_changed_at: null, content_hash: null, last_error: '', consecutive_failures: 0, created_at: '', updated_at: '', ...o,
});

function fakeFetch(routes: Record<string, { status?: number; body: string; type?: string; url?: string }>, seen: { url: string; headers: Record<string, string> }[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, headers: Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {})) });
    const r = routes[url];
    if (!r) return new Response('nope', { status: 404 });
    const res = new Response(r.body, { status: r.status ?? 200, headers: { 'content-type': r.type ?? 'text/html' } });
    if (r.url) Object.defineProperty(res, 'url', { value: r.url });
    return res;
  }) as typeof fetch;
}

describe('classification', () => {
  it('never treats ChatGPT and other signed-in services as readable', () => {
    for (const u of ['https://chatgpt.com/space/page_0000000000000000000000000000000', 'https://chat.openai.com/c/1', 'https://claude.ai/chat/1', 'https://docs.google.com/document/d/x', 'https://acme.sharepoint.com/x']) {
      const c = classifyUrl(u, { notionToken: '' });
      expect(c.kind, u).toBe('reference');
      expect(c.connection).toBe('reference_only');
      expect(c.note.length).toBeGreaterThan(20);
    }
  });
  it('recognises GitHub files and Notion pages', () => {
    expect(classifyUrl('https://github.com/acme/plans/blob/main/projects/alpha.md', { notionToken: '' })).toMatchObject({ kind: 'github', config: { owner: 'acme', repo: 'plans', ref: 'main', path: 'projects/alpha.md' } });
    expect(classifyUrl('https://www.notion.so/acme/Plan-0123456789abcdef0123456789abcdef', { notionToken: '' })).toMatchObject({ kind: 'notion', connection: 'needs_setup' });
    expect(classifyUrl('https://www.notion.so/acme/Plan-0123456789abcdef0123456789abcdef', { notionToken: 'secret' })).toMatchObject({ kind: 'notion', connection: 'pending', config: { page_id: '0123456789abcdef0123456789abcdef' } });
    expect(classifyUrl('https://example.com/status', { notionToken: '' }).kind).toBe('web');
  });
});

describe('fetching', () => {
  const deps = (f: typeof fetch, githubToken = '', notionToken = '') => ({ fetch: f, config: { githubToken, notionToken } });

  it('extracts readable text from HTML and detects sign-in walls', async () => {
    const html = '<html><head><title>Plan &amp; status</title><style>x{}</style></head><body><script>bad()</script><h1>Status</h1><p>Phase&nbsp;1 done.</p><ul><li>Next: build</li></ul></body></html>';
    expect(htmlToText(html)).toEqual({ text: 'Status\nPhase 1 done.\n• Next: build', title: 'Plan & status' });
    const ok = await fetchSource(src({ url: 'https://ex.test/a' }), deps(fakeFetch({ 'https://ex.test/a': { body: html } })));
    expect(ok).toMatchObject({ ok: true, text: 'Status\nPhase 1 done.\n• Next: build' });
    const wall = await fetchSource(src({ url: 'https://ex.test/b' }), deps(fakeFetch({ 'https://ex.test/b': { body: '<form><input type="password"></form>', url: 'https://ex.test/login' } })));
    expect(wall).toMatchObject({ ok: false, connection: 'error' });
    const denied = await fetchSource(src({ url: 'https://ex.test/c' }), deps(fakeFetch({ 'https://ex.test/c': { status: 403, body: '' } })));
    expect(denied).toMatchObject({ ok: false, error: expect.stringContaining('sign-in') });
  });

  it('reads GitHub files with the token, and asks for setup without one', async () => {
    const url = 'https://api.github.com/repos/acme/plans/contents/projects/alpha.md?ref=main';
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const s = src({ kind: 'github', config: JSON.stringify({ owner: 'acme', repo: 'plans', ref: 'main', path: 'projects/alpha.md' }) });
    const ok = await fetchSource(s, deps(fakeFetch({ [url]: { body: '# Alpha\nStatus: green', type: 'text/plain' } }, seen), 'ghp_x'));
    expect(ok).toMatchObject({ ok: true, text: '# Alpha\nStatus: green' });
    expect(seen[0].headers.authorization).toBe('Bearer ghp_x');
    const missing = await fetchSource(s, deps(fakeFetch({})));
    expect(missing).toMatchObject({ ok: false, connection: 'needs_setup' });
  });

  it('reads Notion page blocks as text', async () => {
    const id = '0123456789abcdef0123456789abcdef';
    const blocks = { results: [{ id: 'a', type: 'heading_2', heading_2: { rich_text: [{ plain_text: 'Status' }] } }, { id: 'b', type: 'to_do', to_do: { checked: true, rich_text: [{ plain_text: 'Draft charter' }] } }, { id: 'c', type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ plain_text: 'Review pending' }] } }], has_more: false, next_cursor: null };
    const f = fakeFetch({ [`https://api.notion.com/v1/pages/${id}`]: { body: '{}', type: 'application/json' }, [`https://api.notion.com/v1/blocks/${id}/children?page_size=100`]: { body: JSON.stringify(blocks), type: 'application/json' } });
    const r = await fetchSource(src({ kind: 'notion', config: JSON.stringify({ page_id: id }) }), deps(f, '', 'ntn_x'));
    expect(r).toMatchObject({ ok: true, text: '# Status\n[x] Draft charter\n• Review pending' });
    const noToken = await fetchSource(src({ kind: 'notion', config: JSON.stringify({ page_id: id }) }), deps(f));
    expect(noToken).toMatchObject({ ok: false, connection: 'needs_setup' });
  });

  it('never fetches reference links', async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const r = await fetchSource(src({ kind: 'reference', url: 'https://chatgpt.com/space/page_x' }), deps(fakeFetch({}, seen)));
    expect(r).toMatchObject({ ok: false, connection: 'reference_only' });
    expect(seen).toEqual([]);
  });
});

describe('grounding helpers', () => {
  it('verifies quotes against source text, tolerant of whitespace/quotes but not paraphrase', () => {
    const text = 'The recorded review requires further revisions before departmental circulation.';
    expect(quoteIsGrounded('requires   further revisions', text)).toBe(true);
    expect(quoteIsGrounded('The review approved the programme', text)).toBe(false);
    expect(quoteIsGrounded('review', text)).toBe(false); // too short to count as evidence
  });
  it('computes added and removed lines', () => {
    expect(lineDiff('a\nb\nc', 'a\nc\nd')).toEqual({ added: ['d'], removed: ['b'] });
  });
});
