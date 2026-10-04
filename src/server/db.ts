// Minimal async SQL interface implemented by Cloudflare D1 (production) and
// node:sqlite (local development and tests). All queries use positional `?` params.

export type Row = Record<string, unknown>;
export interface Stmt {
  sql: string;
  params?: unknown[];
}

export interface Db {
  all<T = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  first<T = Row>(sql: string, params?: unknown[]): Promise<T | null>;
  run(sql: string, params?: unknown[]): Promise<{ changes: number }>;
  /** Executes all statements atomically: any error rolls back the whole batch. */
  batch(stmts: Stmt[]): Promise<{ changes: number }[]>;
}

export function normaliseParams(params: unknown[] = []): unknown[] {
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    return p;
  });
}

// ---- Cloudflare D1 ---------------------------------------------------------

interface D1Result<T> {
  results?: T[];
  meta?: { changes?: number };
}
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T>(): Promise<D1Result<T>>;
  first<T>(): Promise<T | null>;
  run(): Promise<D1Result<unknown>>;
}
export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatement;
  batch(stmts: D1PreparedStatement[]): Promise<D1Result<unknown>[]>;
}

export class D1Db implements Db {
  constructor(private d1: D1DatabaseLike) {}
  private stmt(sql: string, params?: unknown[]) {
    return this.d1.prepare(sql).bind(...normaliseParams(params));
  }
  async all<T = Row>(sql: string, params?: unknown[]): Promise<T[]> {
    const res = await this.stmt(sql, params).all<T>();
    return res.results ?? [];
  }
  async first<T = Row>(sql: string, params?: unknown[]): Promise<T | null> {
    return (await this.stmt(sql, params).first<T>()) ?? null;
  }
  async run(sql: string, params?: unknown[]) {
    const res = await this.stmt(sql, params).run();
    return { changes: res.meta?.changes ?? 0 };
  }
  async batch(stmts: Stmt[]) {
    if (stmts.length === 0) return [];
    const res = await this.d1.batch(stmts.map((s) => this.stmt(s.sql, s.params)));
    return res.map((r) => ({ changes: r.meta?.changes ?? 0 }));
  }
}

/** Statement that aborts the surrounding batch unless the project is at `version`. */
export function versionGuard(projectId: string, version: number): Stmt {
  return {
    sql: `INSERT INTO _guard (x) SELECT NULL WHERE NOT EXISTS
            (SELECT 1 FROM projects WHERE id = ? AND version = ?)`,
    params: [projectId, version],
  };
}

export function isGuardFailure(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err);
  return /NOT NULL constraint failed: _guard\.x/i.test(msg);
}
