// Source connectors. Each tracked project can reference sources the owner adds
// explicitly. Only kinds with a real, credentialed or public read path are fetched;
// everything else is a reference link with an honest "not connected" state.
import type { Connection, SourceKind } from '../../shared/types';
import type { Config } from '../config';
import type { SourceRow } from '../rows';
import { parseJson } from '../util';

export const MAX_SOURCE_CHARS = 200_000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_BYTES = 3_000_000;

const UNREADABLE_HOSTS: { test: RegExp; note: string }[] = [
  {
    test: /(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$/,
    note: 'ChatGPT Spaces and Pages cannot be read by this app: there is no supported API, and signed-in pages are not scraped. Paste a dated snapshot, or keep the canonical record in a connected source.',
  },
  { test: /(^|\.)claude\.ai$/, note: 'Claude conversations and artifacts are private to your account and cannot be read by this app. Paste a dated snapshot instead.' },
  { test: /(^|\.)docs\.google\.com$|(^|\.)drive\.google\.com$/, note: 'Google Docs/Drive is not connected (it would need a Google OAuth integration, which is not implemented). Paste a snapshot or publish the doc to the web.' },
  { test: /(^|\.)sharepoint\.com$|(^|\.)onedrive\.live\.com$|(^|\.)1drv\.ms$/, note: 'Microsoft 365 documents need Microsoft Graph credentials, which are not implemented. Paste a snapshot instead.' },
];

export interface Classified {
  kind: SourceKind;
  connection: Connection;
  note: string;
  config: Record<string, string>;
}

/** Decides how a URL can be tracked. */
export function classifyUrl(raw: string, config: Pick<Config, 'notionToken'>): Classified {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { kind: 'reference', connection: 'reference_only', note: 'Not a valid web address; kept as a reference.', config: {} };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { kind: 'reference', connection: 'reference_only', note: 'Only http(s) links can be checked.', config: {} };
  }
  const host = url.hostname.toLowerCase();
  const unreadable = UNREADABLE_HOSTS.find((h) => h.test.test(host));
  if (unreadable) return { kind: 'reference', connection: 'reference_only', note: unreadable.note, config: {} };

  if (host === 'github.com') {
    const m = url.pathname.match(/^\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/);
    if (m) return { kind: 'github', connection: 'pending', note: '', config: { owner: m[1], repo: m[2], ref: m[3], path: decodeURIComponent(m[4]) } };
  }
  if (host === 'raw.githubusercontent.com') {
    const m = url.pathname.match(/^\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/);
    if (m) return { kind: 'github', connection: 'pending', note: '', config: { owner: m[1], repo: m[2], ref: m[3], path: decodeURIComponent(m[4]) } };
  }
  if (/(^|\.)notion\.so$|(^|\.)notion\.site$/.test(host)) {
    const id = url.pathname.replace(/-/g, '').match(/([0-9a-f]{32})(?:$|[/?#])/i)?.[1];
    if (!id) return { kind: 'reference', connection: 'reference_only', note: 'Could not find a Notion page id in this link.', config: {} };
    return config.notionToken
      ? { kind: 'notion', connection: 'pending', note: '', config: { page_id: id } }
      : { kind: 'notion', connection: 'needs_setup', note: 'Notion is not connected: set the NOTION_TOKEN secret and share the page with that integration.', config: { page_id: id } };
  }
  return { kind: 'web', connection: 'pending', note: '', config: {} };
}

export type FetchOutcome =
  | { ok: true; text: string; truncated: boolean; title?: string }
  | { ok: false; connection: Exclude<Connection, 'connected' | 'pending'>; error: string };

export interface SourceFetchDeps {
  fetch: typeof fetch;
  config: Pick<Config, 'githubToken' | 'notionToken'>;
}

async function timedFetch(f: typeof fetch, url: string, init: RequestInit = {}): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await f(url, { ...init, signal: ctrl.signal, redirect: 'follow' });
  } finally {
    clearTimeout(t);
  }
}

function limit(text: string): { text: string; truncated: boolean } {
  return text.length > MAX_SOURCE_CHARS ? { text: text.slice(0, MAX_SOURCE_CHARS), truncated: true } : { text, truncated: false };
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };

export function htmlToText(html: string): { text: string; title?: string } {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim();
  const text = html
    .replace(/<(script|style|noscript|svg|template|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|blockquote|pre|table|ul|ol)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .split('\n')
    .map((l) => l.replace(/[ \t\f\v ]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
  return { text, title: title ? htmlToTextInline(title) : undefined };
}

function htmlToTextInline(s: string) {
  return s.replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
}

async function readCapped(res: Response): Promise<string> {
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > MAX_BYTES) throw new Error(`Document is too large (${Math.round(len / 1e6)} MB)`);
  return res.text();
}

async function fetchWeb(src: SourceRow, deps: SourceFetchDeps): Promise<FetchOutcome> {
  const res = await timedFetch(deps.fetch, src.url, { headers: { 'user-agent': 'ProjectDashboard/1.0 (+source check)', accept: 'text/html,text/plain,text/markdown,application/json;q=0.9,*/*;q=0.5' } });
  if (res.status === 401 || res.status === 403) return { ok: false, connection: 'error', error: `HTTP ${res.status}: the page requires sign-in or denies access` };
  if (!res.ok) return { ok: false, connection: 'error', error: `HTTP ${res.status}` };
  const finalUrl = res.url || src.url;
  const body = await readCapped(res);
  const type = res.headers.get('content-type') ?? '';
  if (/html/i.test(type) || /^\s*<(!doctype|html)/i.test(body)) {
    const { text, title } = htmlToText(body);
    const looksLikeLogin = /\/(login|signin|sign-in|auth)\b/i.test(new URL(finalUrl).pathname) || (/type=["']?password/i.test(body) && text.length < 3000);
    if (looksLikeLogin) return { ok: false, connection: 'error', error: 'The page redirected to a sign-in screen; this app does not read signed-in pages' };
    return { ok: true, ...limit(text), title };
  }
  if (/^(text\/|application\/(json|xml|markdown))/i.test(type) || !type) return { ok: true, ...limit(body.trim()) };
  return { ok: false, connection: 'error', error: `Unsupported content type: ${type}` };
}

async function fetchGithub(src: SourceRow, deps: SourceFetchDeps): Promise<FetchOutcome> {
  const c = parseJson<Record<string, string>>(src.config, {});
  if (!c.owner || !c.repo || !c.path) return { ok: false, connection: 'error', error: 'GitHub source is missing owner/repo/path' };
  const url = `https://api.github.com/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}/contents/${c.path
    .split('/')
    .map(encodeURIComponent)
    .join('/')}${c.ref ? `?ref=${encodeURIComponent(c.ref)}` : ''}`;
  const headers: Record<string, string> = { accept: 'application/vnd.github.raw+json', 'user-agent': 'ProjectDashboard/1.0', 'x-github-api-version': '2022-11-28' };
  if (deps.config.githubToken) headers.authorization = `Bearer ${deps.config.githubToken}`;
  const res = await timedFetch(deps.fetch, url, { headers });
  if ((res.status === 404 || res.status === 401 || res.status === 403) && !deps.config.githubToken) {
    return { ok: false, connection: 'needs_setup', error: `GitHub returned ${res.status}. For a private repository set the GITHUB_TOKEN secret (read-only, contents scope).` };
  }
  if (!res.ok) return { ok: false, connection: 'error', error: `GitHub HTTP ${res.status}` };
  return { ok: true, ...limit((await readCapped(res)).trim()) };
}

interface NotionRichText {
  plain_text?: string;
}
interface NotionBlock {
  type: string;
  has_children?: boolean;
  id: string;
  [k: string]: unknown;
}

async function fetchNotion(src: SourceRow, deps: SourceFetchDeps): Promise<FetchOutcome> {
  if (!deps.config.notionToken) return { ok: false, connection: 'needs_setup', error: 'Set the NOTION_TOKEN secret and share the page with that integration.' };
  const c = parseJson<Record<string, string>>(src.config, {});
  const headers = { authorization: `Bearer ${deps.config.notionToken}`, 'notion-version': '2022-06-28', accept: 'application/json' };
  const page = await timedFetch(deps.fetch, `https://api.notion.com/v1/pages/${c.page_id}`, { headers });
  if (page.status === 404 || page.status === 403) return { ok: false, connection: 'needs_setup', error: 'Notion page not shared with the integration (Share → Connections).' };
  if (!page.ok) return { ok: false, connection: 'error', error: `Notion HTTP ${page.status}` };
  const lines: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const res = await timedFetch(deps.fetch, `https://api.notion.com/v1/blocks/${c.page_id}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`, { headers });
    if (!res.ok) return { ok: false, connection: 'error', error: `Notion blocks HTTP ${res.status}` };
    const body = (await res.json()) as { results: NotionBlock[]; has_more: boolean; next_cursor: string | null };
    for (const b of body.results) {
      const data = b[b.type] as { rich_text?: NotionRichText[]; checked?: boolean } | undefined;
      const text = (data?.rich_text ?? []).map((t) => t.plain_text ?? '').join('');
      if (!text) continue;
      const prefix = b.type.startsWith('heading') ? '# ' : b.type === 'to_do' ? (data?.checked ? '[x] ' : '[ ] ') : b.type.includes('list') ? '• ' : '';
      lines.push(prefix + text);
    }
    cursor = body.has_more ? (body.next_cursor ?? undefined) : undefined;
  } while (cursor && ++pages < 20);
  return { ok: true, ...limit(lines.join('\n')) };
}

export async function fetchSource(src: SourceRow, deps: SourceFetchDeps): Promise<FetchOutcome> {
  try {
    switch (src.kind) {
      case 'reference':
        return { ok: false, connection: 'reference_only', error: classifyUrl(src.url, deps.config).note || 'Reference link only.' };
      case 'snapshot':
        return { ok: true, text: `Snapshot as of ${src.as_of ?? 'unknown date'}:\n${src.snapshot_text}`, truncated: false };
      case 'web':
        return await fetchWeb(src, deps);
      case 'github':
        return await fetchGithub(src, deps);
      case 'notion':
        return await fetchNotion(src, deps);
    }
  } catch (err) {
    const msg = (err as Error)?.name === 'AbortError' ? 'Timed out' : String((err as Error)?.message ?? err);
    return { ok: false, connection: 'error', error: msg.slice(0, 300) };
  }
}

/** Lines added/removed between two versions of a source (order-insensitive, cheap). */
export function lineDiff(oldText: string, newText: string): { added: string[]; removed: string[] } {
  const norm = (t: string) => t.split('\n').map((l) => l.trim()).filter(Boolean);
  const a = norm(oldText);
  const b = norm(newText);
  const as = new Set(a);
  const bs = new Set(b);
  return { added: b.filter((l) => !as.has(l)), removed: a.filter((l) => !bs.has(l)) };
}

/** Normalises text for citation checks: case, whitespace, quotes and dashes. */
export function normaliseForQuote(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’`´]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

export function quoteIsGrounded(quote: string, sourceText: string): boolean {
  const q = normaliseForQuote(quote);
  return q.length >= 8 && normaliseForQuote(sourceText).includes(q);
}
