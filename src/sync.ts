import type { AppState } from './types';
import { migrate } from './store';

/**
 * Keeps the same data on your laptop and phone through a private GitHub Gist.
 * Everything is encrypted on the device (AES-GCM, key from your sync
 * passphrase) before it leaves; GitHub only ever holds unreadable text.
 * The token and passphrase stay in this browser.
 */

export const SYNC_FILE = 'expense-tracker.sync.json';
const CFG_KEY = 'sync-config';
const BASE_KEY = 'sync-base';
const CHANGED_KEY = 'sync-changed-at';
const ITER = 200_000;

export interface SyncConfig {
  token: string;
  pass: string;
  gistId?: string;
  /** The remote version this device last saw. */
  rev?: string;
  syncedAt?: number;
  lastError?: string;
}

/** Ids present after the last sync, so a delete on one device isn't undone by the other. */
export interface SyncBase { txns: string[]; accounts: string[]; imports: string[]; rules: string[] }

interface Envelope {
  app: 'expense-tracker-sync';
  v: 1;
  rev: string;
  savedAt: number;
  salt: string;
  iv: string;
  gz: boolean;
  data: string;
}

/* ---------- device-only settings ---------- */

function read<T>(key: string): T | undefined {
  try { const v = localStorage.getItem(key); return v ? (JSON.parse(v) as T) : undefined; } catch { return undefined; }
}
function write(key: string, v: unknown) {
  try { if (v === undefined) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(v)); } catch { /* storage blocked */ }
}
export const syncConfig = () => read<SyncConfig>(CFG_KEY);
export const saveSyncConfig = (c: SyncConfig | undefined) => write(CFG_KEY, c);
export function forgetSync() { write(CFG_KEY, undefined); write(BASE_KEY, undefined); write(CHANGED_KEY, undefined); }
export function markLocalChange() { write(CHANGED_KEY, Date.now()); }
const localChangedAt = () => read<number>(CHANGED_KEY) ?? 0;

/* ---------- merging ---------- */

const ruleId = (r: AppState['rules'][number]) => `${r.key}|${r.direction ?? ''}`;

export function baseOf(s: AppState): SyncBase {
  return { txns: s.txns.map((t) => t.id), accounts: s.accounts.map((a) => a.id), imports: s.imports.map((i) => i.id), rules: s.rules.map(ruleId) };
}

/**
 * Three-way merge of lists by id: added on either side is kept, deleted on
 * either side stays deleted, and where both still have it this device's copy wins.
 */
function mergeList<T>(local: T[], remote: T[], base: string[], id: (x: T) => string): T[] {
  const inBase = new Set(base);
  const localIds = new Set(local.map(id));
  const remoteIds = new Set(remote.map(id));
  const out = local.filter((x) => remoteIds.has(id(x)) || !inBase.has(id(x)));
  for (const x of remote) if (!localIds.has(id(x)) && !inBase.has(id(x))) out.push(x);
  return out;
}

export function mergeStates(local: AppState, remote: AppState, base: SyncBase): AppState {
  return {
    ...local,
    txns: mergeList(local.txns, remote.txns, base.txns, (t) => t.id),
    accounts: mergeList(local.accounts, remote.accounts, base.accounts, (a) => a.id),
    imports: mergeList(local.imports, remote.imports, base.imports, (i) => i.id),
    rules: mergeList(local.rules, remote.rules, base.rules, ruleId),
    plans: { ...remote.plans, ...local.plans },
    settings: {
      ...remote.settings,
      ...local.settings,
      notPairs: [...new Set([...(remote.settings.notPairs ?? []), ...(local.settings.notPairs ?? [])])],
      categoryCounted: { ...remote.settings.categoryCounted, ...local.settings.categoryCounted },
    },
  };
}

/* ---------- encryption ---------- */

const b64 = (buf: ArrayBuffer | Uint8Array) => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (s: string): Bytes => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function keyFor(pass: string, salt: Bytes): Promise<CryptoKey> {
  const raw = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' }, raw, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

type Bytes = Uint8Array<ArrayBuffer>;

async function pipe(data: Bytes, stream: CompressionStream | DecompressionStream): Promise<Bytes> {
  const out = new Response(new Blob([data]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

export async function seal(state: AppState, pass: string, rev: string): Promise<Envelope> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  let bytes: Bytes = new TextEncoder().encode(JSON.stringify(state)) as Bytes;
  const gz = typeof CompressionStream !== 'undefined';
  if (gz) bytes = await pipe(bytes, new CompressionStream('gzip'));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await keyFor(pass, salt), bytes);
  return { app: 'expense-tracker-sync', v: 1, rev, savedAt: Date.now(), salt: b64(salt), iv: b64(iv), gz, data: b64(data) };
}

export async function open(env: Envelope, pass: string): Promise<AppState> {
  let bytes: Bytes;
  try {
    bytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(env.iv) }, await keyFor(pass, unb64(env.salt)), unb64(env.data)));
  } catch {
    throw new Error('The sync passphrase doesn’t match the one used on your other device.');
  }
  if (env.gz) bytes = await pipe(bytes, new DecompressionStream('gzip'));
  return migrate(JSON.parse(new TextDecoder().decode(bytes)) as AppState);
}

/* ---------- GitHub ---------- */

async function gh(cfg: SyncConfig, path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${cfg.token}`, 'X-GitHub-Api-Version': '2022-11-28', ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
    cache: 'no-store',
  });
  if (res.status === 401) throw new Error('GitHub refused the token. Check it has the Gists permission and hasn’t expired.');
  if (res.status === 403 || res.status === 404) throw new Error(`GitHub said ${res.status}. The token needs “Gists: read and write”.`);
  if (!res.ok) throw new Error(`GitHub error ${res.status}.`);
  return res;
}

interface GistFile { content?: string; truncated?: boolean; raw_url?: string }

async function readRemote(cfg: SyncConfig): Promise<Envelope | null> {
  if (!cfg.gistId) {
    const list = (await (await gh(cfg, '/gists?per_page=100')).json()) as { id: string; files: Record<string, unknown> }[];
    cfg.gistId = list.find((g) => SYNC_FILE in g.files)?.id;
    if (!cfg.gistId) return null;
  }
  const gist = (await (await gh(cfg, `/gists/${cfg.gistId}`)).json()) as { files: Record<string, GistFile> };
  const f = gist.files[SYNC_FILE];
  if (!f) return null;
  const text = f.truncated && f.raw_url ? await (await fetch(f.raw_url, { cache: 'no-store' })).text() : f.content ?? '';
  const env = JSON.parse(text) as Envelope;
  if (env.app !== 'expense-tracker-sync') throw new Error('The sync gist holds something else.');
  return env;
}

async function writeRemote(cfg: SyncConfig, env: Envelope) {
  const files = { [SYNC_FILE]: { content: JSON.stringify(env) } };
  if (cfg.gistId) {
    await gh(cfg, `/gists/${cfg.gistId}`, { method: 'PATCH', body: JSON.stringify({ files }) });
  } else {
    const made = (await (await gh(cfg, '/gists', { method: 'POST', body: JSON.stringify({ description: 'Expense Tracker sync (encrypted)', public: false, files }) })).json()) as { id: string };
    cfg.gistId = made.id;
  }
}

/* ---------- the sync itself ---------- */

export type SyncResult = 'pushed' | 'pulled' | 'merged' | 'unchanged';

let running: Promise<SyncResult> | null = null;

/**
 * Brings this device and the gist together. `apply` puts a new state on this
 * device without counting it as a local change.
 */
export function syncNow(getState: () => AppState, apply: (s: AppState) => Promise<void>): Promise<SyncResult> {
  running ??= run(getState, apply).finally(() => { running = null; });
  return running;
}

async function run(getState: () => AppState, apply: (s: AppState) => Promise<void>): Promise<SyncResult> {
  const cfg = syncConfig();
  if (!cfg) throw new Error('Sync is off.');
  const finish = (s: AppState, rev: string, result: SyncResult) => {
    write(BASE_KEY, baseOf(s));
    saveSyncConfig({ ...cfg, rev, syncedAt: Date.now(), lastError: undefined });
    return result;
  };
  try {
    const remote = await readRemote(cfg);
    const local = getState();
    const changed = localChangedAt() > (cfg.syncedAt ?? 0);
    const newRev = () => crypto.randomUUID();
    if (!remote) {
      const rev = newRev();
      await writeRemote(cfg, await seal(local, cfg.pass, rev));
      return finish(local, rev, 'pushed');
    }
    if (remote.rev === cfg.rev) {
      if (!changed) return finish(local, remote.rev, 'unchanged');
      const rev = newRev();
      await writeRemote(cfg, await seal(local, cfg.pass, rev));
      return finish(local, rev, 'pushed');
    }
    const theirs = await open(remote, cfg.pass);
    if (cfg.rev && !changed) {
      await apply(theirs);
      return finish(theirs, remote.rev, 'pulled');
    }
    // Both sides changed (or this device's first sync): keep everything from both.
    const base = cfg.rev ? read<SyncBase>(BASE_KEY) ?? baseOf(theirs) : { txns: [], accounts: [], imports: [], rules: [] };
    const merged = mergeStates(local, theirs, base);
    await apply(merged);
    const rev = newRev();
    await writeRemote(cfg, await seal(merged, cfg.pass, rev));
    return finish(merged, rev, 'merged');
  } catch (e) {
    saveSyncConfig({ ...cfg, lastError: (e as Error).message });
    throw e;
  }
}
