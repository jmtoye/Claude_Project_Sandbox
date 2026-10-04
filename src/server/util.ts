export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = 'error',
  ) {
    super(message);
  }
}

export const notFound = () => new HttpError(404, 'Not found', 'not_found');
export const forbidden = (msg = 'You do not have permission to do that.') => new HttpError(403, msg, 'forbidden');
export const badRequest = (msg: string) => new HttpError(400, msg, 'bad_request');
export const conflict = (msg = 'This project changed since you loaded it. Reload and try again.') =>
  new HttpError(409, msg, 'conflict');

export function newId(prefix = ''): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return prefix + Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 18);
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(pad);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function parseJson<T>(s: unknown, fallback: T): T {
  if (typeof s !== 'string' || !s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export const bool = (v: unknown) => v === 1 || v === true || v === '1';

/** Runs async tasks with bounded concurrency, preserving order of results. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

export function clip(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…';
}
