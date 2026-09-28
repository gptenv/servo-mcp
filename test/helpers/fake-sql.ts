/**
 * A tiny, deterministic SQL emulator that understands exactly the statements
 * `src/browser-session.ts` executes against Durable Object storage. It is used
 * by the browser-session unit tests to stand in for Cloudflare's SQLite-backed
 * DO storage without requiring a workerd runtime or the Servo WASM artifact.
 */

export interface FakeSqlTable {
  columns: string[];
  rows: Record<string, unknown>[];
}

export class FakeSqlDatabase {
  private readonly tables = new Map<string, FakeSqlTable>();

  createTable(name: string, columns: string[]): void {
    if (!this.tables.has(name)) this.tables.set(name, { columns, rows: [] });
  }

  table(name: string): FakeSqlTable | undefined {
    return this.tables.get(name);
  }

  exec<T = Record<string, unknown>>(sql: string, ...params: unknown[]): { toArray(): T[] } {
    const statement = sql.replace(/\s+/g, ' ').trim();

    if (/^CREATE TABLE IF NOT EXISTS/i.test(statement)) return this.finish([]);

    if (/^SELECT status, created_at, updated_at, expires_at, width, height FROM browser_session WHERE singleton = 1$/i.test(statement)) {
      return this.finish(this.tables.get('browser_session')?.rows ?? []);
    }
    if (/^INSERT INTO browser_session \(singleton, status, created_at, updated_at, expires_at, width, height\) VALUES \(1, \?, \?, \?, \?, \?, \?\)$/i.test(statement)) {
      const [status, createdAt, updatedAt, expiresAt, width, height] = params as [string, number, number, number, number, number];
      this.createTable('browser_session', ['singleton', 'status', 'created_at', 'updated_at', 'expires_at', 'width', 'height']);
      this.tables.get('browser_session')!.rows.push({ singleton: 1, status, created_at: createdAt, updated_at: updatedAt, expires_at: expiresAt, width, height });
      return this.finish([]);
    }
    if (/^UPDATE browser_session SET status = \?, updated_at = \?, expires_at = \? WHERE singleton = 1$/i.test(statement)) {
      const [status, updatedAt, expiresAt] = params as [string, number, number];
      for (const row of this.tables.get('browser_session')?.rows ?? []) {
        row.status = status; row.updated_at = updatedAt; row.expires_at = expiresAt;
      }
      return this.finish([]);
    }
    if (/^UPDATE browser_session SET updated_at = \?, expires_at = \? WHERE singleton = 1 AND status = \?$/i.test(statement)) {
      const [updatedAt, expiresAt, status] = params as [number, number, string];
      for (const row of this.tables.get('browser_session')?.rows ?? []) {
        if (row.status === status) { row.updated_at = updatedAt; row.expires_at = expiresAt; }
      }
      return this.finish([]);
    }
    if (/^INSERT INTO browser_snapshot \(singleton, snapshot_json\) VALUES \(1, \?\) ON CONFLICT\(singleton\) DO UPDATE SET snapshot_json = excluded\.snapshot_json$/i.test(statement)) {
      this.createTable('browser_snapshot', ['singleton', 'snapshot_json']);
      const table = this.tables.get('browser_snapshot')!;
      const json = String(params[0]);
      if (table.rows.length) table.rows[0].snapshot_json = json;
      else table.rows.push({ singleton: 1, snapshot_json: json });
      return this.finish([]);
    }
    if (/^SELECT snapshot_json FROM browser_snapshot WHERE singleton = 1$/i.test(statement)) {
      return this.finish(this.tables.get('browser_snapshot')?.rows ?? []);
    }
    if (/^DELETE FROM browser_snapshot$/i.test(statement)) {
      this.tables.get('browser_snapshot')?.rows.splice(0);
      return this.finish([]);
    }
    if (/^DELETE FROM browser_asset WHERE name = \?$/i.test(statement)) {
      const name = String(params[0]);
      const table = this.tables.get('browser_asset');
      if (table) table.rows = table.rows.filter((row) => row.name !== name);
      return this.finish([]);
    }
    if (/^INSERT INTO browser_asset \(name, chunk_index, chunk_text\) VALUES \(\?, \?, \?\)$/i.test(statement)) {
      const [name, chunkIndex, chunkText] = params as [string, number, string];
      this.createTable('browser_asset', ['name', 'chunk_index', 'chunk_text']);
      this.tables.get('browser_asset')!.rows.push({ name, chunk_index: chunkIndex, chunk_text: chunkText });
      return this.finish([]);
    }
    if (/^SELECT chunk_text FROM browser_asset WHERE name = \? ORDER BY chunk_index$/i.test(statement)) {
      const name = String(params[0]);
      const rows = (this.tables.get('browser_asset')?.rows ?? [])
        .filter((row) => row.name === name)
        .sort((a, b) => Number(a.chunk_index) - Number(b.chunk_index));
      return this.finish(rows);
    }
    if (/^DELETE FROM browser_asset$/i.test(statement)) {
      this.tables.get('browser_asset')?.rows.splice(0);
      return this.finish([]);
    }
    if (/^SELECT DISTINCT name FROM browser_asset WHERE name LIKE \?$/i.test(statement)) {
      const prefix = String(params[0]).replace('%', '');
      const names = [...new Set((this.tables.get('browser_asset')?.rows ?? [])
        .map((row) => String(row.name))
        .filter((name) => name.startsWith(prefix)))];
      return this.finish(names.map((name) => ({ name })));
    }
    if (/^SELECT COUNT\(DISTINCT name\) AS count FROM browser_asset WHERE name LIKE 'font:%'$/i.test(statement)) {
      const names = new Set((this.tables.get('browser_asset')?.rows ?? [])
        .map((row) => String(row.name))
        .filter((name) => name.startsWith('font:')));
      return this.finish([{ count: names.size }]);
    }
    throw new Error(`FakeSqlDatabase: unsupported statement: ${statement}`);
  }

  private finish(rows: Record<string, unknown>[]) {
    const copy = rows.map((row) => ({ ...row }));
    return { toArray: <T>() => copy as T[] };
  }
}
