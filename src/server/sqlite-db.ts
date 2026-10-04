// node:sqlite implementation of the Db interface, used for local development,
// tests and optional self-hosting. Not bundled into the Cloudflare Worker.
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normaliseParams, type Db, type Row, type Stmt } from './db';

export class SqliteDb implements Db {
  readonly raw: DatabaseSync;
  constructor(path = ':memory:') {
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  }
  async all<T = Row>(sql: string, params?: unknown[]): Promise<T[]> {
    return this.raw.prepare(sql).all(...(normaliseParams(params) as never[])) as T[];
  }
  async first<T = Row>(sql: string, params?: unknown[]): Promise<T | null> {
    return (this.raw.prepare(sql).get(...(normaliseParams(params) as never[])) as T) ?? null;
  }
  async run(sql: string, params?: unknown[]) {
    const r = this.raw.prepare(sql).run(...(normaliseParams(params) as never[]));
    return { changes: Number(r.changes) };
  }
  async batch(stmts: Stmt[]) {
    const out: { changes: number }[] = [];
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      for (const s of stmts) {
        const r = this.raw.prepare(s.sql).run(...(normaliseParams(s.params) as never[]));
        out.push({ changes: Number(r.changes) });
      }
      this.raw.exec('COMMIT');
    } catch (err) {
      this.raw.exec('ROLLBACK');
      throw err;
    }
    return out;
  }
  /** Applies migrations/*.sql in order, tracking applied files (like wrangler d1 migrations). */
  migrate(dir: string) {
    this.raw.exec('CREATE TABLE IF NOT EXISTS _local_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    const applied = new Set(
      (this.raw.prepare('SELECT name FROM _local_migrations').all() as { name: string }[]).map((r) => r.name),
    );
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (applied.has(file)) continue;
      this.raw.exec('BEGIN');
      try {
        this.raw.exec(readFileSync(join(dir, file), 'utf8'));
        this.raw.prepare('INSERT INTO _local_migrations (name, applied_at) VALUES (?, ?)').run(file, new Date().toISOString());
        this.raw.exec('COMMIT');
      } catch (err) {
        this.raw.exec('ROLLBACK');
        throw err;
      }
    }
  }
  close() {
    this.raw.close();
  }
}
