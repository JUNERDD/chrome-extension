import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from 'idb';

export interface StoredEvent {
  id: string;
  sessionId: string;
  seq: number;
  offsetMs: number;
  observedAt: string;
  kind: string;
  tabId: string | null;
  windowId: string | null;
  frameId: string | null;
  documentId: string | null;
  trust: 'extension' | 'untrusted_observation';
  data: Record<string, unknown>;
}

export interface StoredAsset {
  id: string;
  sessionId: string;
  createdAt: string;
  mimeType: string;
  bytes: ArrayBuffer;
  metadata: Record<string, unknown>;
}

export interface StoredSession<TState = unknown> {
  id: string;
  updatedAt: string;
  expiresAt: string;
  state: TState;
}

interface BugtraceDatabase extends DBSchema {
  sessions: {
    key: string;
    value: StoredSession;
    indexes: { 'by-updated-at': string; 'by-expires-at': string };
  };
  events: {
    key: string;
    value: StoredEvent;
    indexes: { 'by-session': string; 'by-session-seq': [string, number] };
  };
  assets: {
    key: string;
    value: StoredAsset;
    indexes: { 'by-session': string };
  };
}

const DATABASE_NAME = 'bugtrace-recorder';
const DATABASE_VERSION = 1;
let databasePromise: Promise<IDBPDatabase<BugtraceDatabase>> | null = null;

export function getDatabase(): Promise<IDBPDatabase<BugtraceDatabase>> {
  databasePromise ??= openDB<BugtraceDatabase>(DATABASE_NAME, DATABASE_VERSION, {
    upgrade(database) {
      const sessions = database.createObjectStore('sessions', { keyPath: 'id' });
      sessions.createIndex('by-updated-at', 'updatedAt');
      sessions.createIndex('by-expires-at', 'expiresAt');

      const events = database.createObjectStore('events', { keyPath: 'id' });
      events.createIndex('by-session', 'sessionId');
      events.createIndex('by-session-seq', ['sessionId', 'seq'], { unique: true });

      const assets = database.createObjectStore('assets', { keyPath: 'id' });
      assets.createIndex('by-session', 'sessionId');
    },
  });
  return databasePromise;
}

export async function putSession<TState>(session: StoredSession<TState>): Promise<void> {
  const database = await getDatabase();
  await database.put('sessions', session as StoredSession);
}

export async function getSession<TState>(sessionId: string): Promise<StoredSession<TState> | undefined> {
  const database = await getDatabase();
  return (await database.get('sessions', sessionId)) as StoredSession<TState> | undefined;
}

export async function listSessions<TState>(): Promise<Array<StoredSession<TState>>> {
  const database = await getDatabase();
  return (await database.getAll('sessions')) as Array<StoredSession<TState>>;
}

export async function appendEvents(events: StoredEvent[]): Promise<void> {
  if (events.length === 0) return;
  const database = await getDatabase();
  const transaction = database.transaction('events', 'readwrite');
  await Promise.all([...events.map((event) => transaction.store.put(event)), transaction.done]);
}

export async function listEvents(sessionId: string): Promise<StoredEvent[]> {
  const database = await getDatabase();
  const events = await database.getAllFromIndex('events', 'by-session', sessionId);
  return events.sort((left, right) => left.seq - right.seq);
}

export async function putAsset(asset: StoredAsset): Promise<void> {
  const database = await getDatabase();
  await database.put('assets', asset);
}

export async function deleteAsset(assetId: string): Promise<void> {
  const database = await getDatabase();
  await database.delete('assets', assetId);
}

export async function deleteEvent(eventId: string): Promise<void> {
  const database = await getDatabase();
  await database.delete('events', eventId);
}

export async function listAssets(sessionId: string): Promise<StoredAsset[]> {
  const database = await getDatabase();
  return database.getAllFromIndex('assets', 'by-session', sessionId);
}

export async function deleteSession(sessionId: string): Promise<void> {
  const database = await getDatabase();
  const transaction = database.transaction(['sessions', 'events', 'assets'], 'readwrite');
  const eventKeys = await transaction.objectStore('events').index('by-session').getAllKeys(sessionId);
  const assetKeys = await transaction.objectStore('assets').index('by-session').getAllKeys(sessionId);
  await Promise.all([
    transaction.objectStore('sessions').delete(sessionId),
    ...eventKeys.map((key) => transaction.objectStore('events').delete(key)),
    ...assetKeys.map((key) => transaction.objectStore('assets').delete(key)),
  ]);
  await transaction.done;
}

export async function cleanupExpiredSessions(now = new Date()): Promise<string[]> {
  const database = await getDatabase();
  const keys = await database.getAllKeysFromIndex(
    'sessions',
    'by-expires-at',
    IDBKeyRange.upperBound(now.toISOString()),
  );
  await Promise.all(keys.map((key) => deleteSession(String(key))));
  return keys.map(String);
}

export async function resetDatabaseForTests(): Promise<void> {
  const existing = databasePromise;
  databasePromise = null;
  if (existing) (await existing).close();
  await deleteDB(DATABASE_NAME);
}
