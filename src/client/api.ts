export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
  const res = await fetch(path, {
    method: opts.method ?? 'GET',
    credentials: 'same-origin',
    headers: {
      accept: 'application/json',
      ...(opts.method && opts.method !== 'GET' ? { 'x-requested-with': 'dashboard' } : {}),
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...opts.headers,
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) throw new ApiError(res.status, data?.error ?? 'error', data?.message ?? `Request failed (${res.status})`);
  return data as T;
}

export const runOp = (op: string, args: Record<string, unknown>) => api<{ message: string }>('/api/ops', { method: 'POST', body: { op, args } });
