import type { AppState, StatementImport } from './types';

const DB_NAME = 'expense-tracker';
const STORE = 'kv';
const KEY = 'state';

export function emptyState(): AppState {
  return {
    accounts: [],
    txns: [],
    rules: [],
    settings: { ownNames: [], familyNames: [] },
    plans: {},
    imports: [],
  };
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function loadState(): Promise<AppState> {
  try {
    const db = await open();
    const value = await new Promise<AppState | undefined>((resolve, reject) => {
      const req = db.transaction(STORE).objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return value ? migrate(value) : emptyState();
  } catch {
    return emptyState();
  }
}

export async function saveState(state: AppState): Promise<void> {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(state, KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Asks the browser not to evict our data (iOS clears unused site data otherwise). */
export async function requestPersistence(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

/** Brings data saved by older versions up to the current shape. */
export function migrate(value: Partial<AppState>): AppState {
  const base = emptyState();
  const { aiApiKey: _k, aiModel: _m, ...settings } = (value.settings ?? {}) as AppState['settings'] & { aiApiKey?: string; aiModel?: string };
  const state: AppState = { ...base, ...value, settings: { ...base.settings, ...settings } } as AppState;
  // gemini-2.5-flash stopped answering for free keys; the alias always works.
  if (state.settings.geminiModel === 'gemini-2.5-flash') state.settings = { ...state.settings, geminiModel: undefined };
  state.plans ??= {};
  state.imports ??= [];
  // "Not counted" used to be a type; it is now the Counted checkbox.
  state.txns = state.txns.map((t) => (t.kind === 'ignore'
    ? { ...t, kind: t.direction === 'credit' ? 'income' : 'spend', category: 'Uncategorised', excluded: true } : t));
  state.rules = state.rules.map((r) => (r.kind === 'ignore' ? { ...r, kind: 'spend', category: 'Uncategorised', excluded: true } : r));
  // Older data has no upload records: rebuild one per account and upload time.
  const missing = state.txns.filter((t) => !t.importId);
  if (missing.length) {
    const groups = new Map<string, StatementImport>();
    state.txns = state.txns.map((t) => {
      if (t.importId) return t;
      const id = `${t.accountId}-${t.importedAt}`;
      const g = groups.get(id) ?? { id, fileName: `${t.accountId} statement`, accountId: t.accountId, from: t.date, to: t.date, importedAt: t.importedAt };
      if (t.date < g.from) g.from = t.date;
      if (t.date > g.to) g.to = t.date;
      groups.set(id, g);
      return { ...t, importId: id };
    });
    state.imports = [...state.imports, ...groups.values()];
  }
  return state;
}

/** Original statement files, kept so a statement can be rescanned later. */
export interface StoredFile { name: string; type: string; data: ArrayBuffer }

async function fileOp<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
  });
}

export async function saveFile(importId: string, file: StoredFile): Promise<void> {
  try {
    await fileOp('readwrite', (s) => s.put(file, `file:${importId}`));
  } catch {
    // Storage full or unavailable: rescans will ask for the file instead.
  }
}

export async function loadFile(importId: string): Promise<StoredFile | undefined> {
  try {
    return await fileOp<StoredFile | undefined>('readonly', (s) => s.get(`file:${importId}`));
  } catch {
    return undefined;
  }
}

export async function deleteFile(importId: string): Promise<void> {
  try {
    await fileOp('readwrite', (s) => s.delete(`file:${importId}`));
  } catch {
    // Nothing to clean up.
  }
}
