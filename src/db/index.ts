/**
 * db/index.ts — IndexedDB initialization and schema management.
 * Zero business logic. Zero knowledge of Gateway or Zustand.
 */

import { openDB, deleteDB, type IDBPDatabase } from 'idb';

export const DB_VERSION = 4;

let _db: IDBPDatabase | null = null;
let _dbUserId: string | null = null;

export function dbName(userId: string): string {
  return `novaic_local_${userId}`;
}

export async function getDb(userId: string): Promise<IDBPDatabase> {
  if (_db && _dbUserId === userId) return _db;
  if (_db) { _db.close(); _db = null; }

  _dbUserId = userId;
  _db = await openDB(dbName(userId), DB_VERSION, {
    upgrade(db, oldVersion) {
      // v1 → v2: clean slate — drop all old stores, recreate fresh
      if (oldVersion < 2) {
        for (const name of Array.from(db.objectStoreNames)) {
          db.deleteObjectStore(name);
        }
        const msgStore = db.createObjectStore('messages', { keyPath: 'id' });
        msgStore.createIndex('by_agent_ts',         ['agentId', 'timestamp']);
        msgStore.createIndex('by_agent_updated_at', ['agentId', 'updated_at']);

        const logStore = db.createObjectStore('logs', { keyPath: 'id' });
        logStore.createIndex('by_agent_id', ['agent_id', 'id']);

        db.createObjectStore('prefs', { keyPath: 'key' });
      }

      // v2 → v3: add file cache store
      if (oldVersion < 3) {
        db.createObjectStore('files', { keyPath: 'id' });
      }

      // v3 → v4: add agents and devices stores for list caching
      if (oldVersion < 4) {
        db.createObjectStore('agents', { keyPath: 'id' });
        db.createObjectStore('devices', { keyPath: 'id' });
      }
    },
  });
  return _db;
}

/** Reset cached DB handle — call on logout so next login opens the right DB. */
export function resetDb(): void {
  if (_db) { _db.close(); _db = null; }
  _dbUserId = null;
}

/**
 * Clear local IndexedDB cache for the given user.
 * Deletes messages, logs, prefs, files. Next getDb() will recreate an empty DB.
 * Call resetDb() first so no open connections block deletion.
 */
export async function clearLocalDb(userId: string): Promise<void> {
  resetDb();
  await deleteDB(dbName(userId), {
    blocked() {
      console.warn('[DB] clearLocalDb blocked by open connections; retry after closing other tabs');
    },
  });
}
