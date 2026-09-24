import type { AppState } from './types';

const DB_NAME = 'expense-tracker';
const STORE = 'kv';
const KEY = 'state';

export const AI_MODELS = [
  { id: 'claude-opus-5', label: 'Claude Opus 5 (most accurate)' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 (cheapest)' },
];
export const DEFAULT_MODEL = AI_MODELS[0].id;

export function emptyState(): AppState {
  return {
    accounts: [],
    txns: [],
    rules: [],
    settings: { ownNames: [], familyNames: [], aiModel: DEFAULT_MODEL },
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
    const base = emptyState();
    return value ? { ...base, ...value, settings: { ...base.settings, ...value.settings } } : base;
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
