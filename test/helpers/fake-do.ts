/**
 * Minimal stand-ins for the Cloudflare Durable Object host APIs used by
 * `ServoBrowserSession`, built on top of {@link FakeSqlDatabase}.
 */

import { FakeSqlDatabase } from './fake-sql';

export interface AlarmSpy {
  calls: number[];
}

export interface FakeDurableObjectState {
  id: { toString(): string };
  storage: {
    sql: FakeSqlDatabase;
    setAlarm(at: number | Date): Promise<void>;
    deleteAlarm(): Promise<void>;
  };
  alarms: { set: (number | Date)[]; deleted: number };
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
  waitUntil(): void;
}

export function createFakeDurableObjectState(idString = 'session-do-id'): FakeDurableObjectState {
  const sql = new FakeSqlDatabase();
  sql.createTable('browser_session', ['singleton', 'status', 'created_at', 'updated_at', 'expires_at', 'width', 'height']);
  sql.createTable('browser_snapshot', ['singleton', 'snapshot_json']);
  sql.createTable('browser_asset', ['name', 'chunk_index', 'chunk_text']);
  const alarms = { set: [] as (number | Date)[], deleted: 0 };
  return {
    id: { toString: () => idString },
    storage: {
      sql,
      setAlarm: async (at: number | Date) => { alarms.set.push(at); },
      deleteAlarm: async () => { alarms.deleted += 1; },
    },
    alarms,
    blockConcurrencyWhile: <T>(callback: () => Promise<T>) => callback(),
    waitUntil: () => undefined,
  } as FakeDurableObjectState & { alarms: typeof alarms };
}

/** Cast helper so tests can hand the fake state to the DO constructor. */
export function asDoState(fake: FakeDurableObjectState): DurableObjectState {
  return fake as unknown as DurableObjectState;
}
