import { beforeEach, describe, expect, it, vi } from 'vitest';
import { baseOf, mergeStates, open, seal, saveSyncConfig, syncConfig, syncNow, markLocalChange, SYNC_FILE } from '../src/sync';
import { emptyState } from '../src/store';
import type { AppState, Txn } from '../src/types';

const t = (id: string, over: Partial<Txn> = {}): Txn => ({ id, accountId: 'A', importId: 'i', date: '2026-07-05', amount: 100, direction: 'debit',
  description: '', kind: 'spend', category: 'Food & Dining', source: 'rule', merchantKey: 'K', merchantName: id, importedAt: 0, ...over });
const st = (ids: string[], over: Partial<AppState> = {}): AppState => ({ ...emptyState(), txns: ids.map((id) => t(id)), ...over });

// A tiny in-memory localStorage and GitHub.
const mem = new Map<string, string>();
vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => mem.set(k, v), removeItem: (k: string) => mem.delete(k) });
let gist: string | null = null;
vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
  const body = init.body ? JSON.parse(String(init.body)) : undefined;
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.endsWith('/gists?per_page=100')) return json(gist ? [{ id: 'g1', files: { [SYNC_FILE]: {} } }] : []);
  if (url.endsWith('/gists') && init.method === 'POST') { gist = body.files[SYNC_FILE].content; return json({ id: 'g1' }); }
  if (url.endsWith('/gists/g1') && init.method === 'PATCH') { gist = body.files[SYNC_FILE].content; return json({}); }
  if (url.endsWith('/gists/g1')) return json({ files: gist ? { [SYNC_FILE]: { content: gist } } : {} });
  return json({}, 404);
});

describe('sync encryption', () => {
  it('round-trips and rejects the wrong passphrase', async () => {
    const env = await seal(st(['a', 'b']), 'correct horse', 'r1');
    expect(env.data).not.toContain('Food');
    expect((await open(env, 'correct horse')).txns.map((x) => x.id)).toEqual(['a', 'b']);
    await expect(open(env, 'wrong pass')).rejects.toThrow(/passphrase/);
  });
});

describe('merging two devices', () => {
  it('keeps additions from both sides and deletions from either', () => {
    const base = baseOf(st(['a', 'b', 'c']));
    const local = st(['a', 'b', 'phone-new']); // c deleted on this device
    const remote = st(['b', 'c', 'laptop-new']); // a deleted on the other
    expect(mergeStates(local, remote, base).txns.map((x) => x.id).sort()).toEqual(['b', 'laptop-new', 'phone-new']);
  });
});

describe('syncNow', () => {
  beforeEach(() => { mem.clear(); gist = null; });
  it('pushes from one device and pulls on the other, then merges concurrent edits', async () => {
    let laptop = st(['a']);
    let phone = emptyState();
    const laptopCfg = { token: 't', pass: 'passphrase1' };
    // Each device keeps its own local settings: swap them in and out of the fake storage.
    const as = async (dev: 'laptop' | 'phone', fn: () => Promise<unknown>) => {
      const saved = new Map(mem); mem.clear();
      for (const [k, v] of (store[dev])) mem.set(k, v);
      await fn();
      store[dev] = new Map(mem); mem.clear();
      for (const [k, v] of saved) mem.set(k, v);
    };
    const store: Record<string, Map<string, string>> = { laptop: new Map(), phone: new Map() };
    await as('laptop', async () => { saveSyncConfig(laptopCfg); expect(await syncNow(() => laptop, async (s) => { laptop = s; })).toBe('pushed'); });
    await as('phone', async () => { saveSyncConfig(laptopCfg); expect(await syncNow(() => phone, async (s) => { phone = s; })).toBe('merged'); });
    expect(phone.txns.map((x) => x.id)).toEqual(['a']);
    // Both change before syncing again.
    await new Promise((r) => setTimeout(r, 5));
    laptop = { ...laptop, txns: [...laptop.txns, t('from-laptop')] };
    phone = { ...phone, txns: [...phone.txns, t('from-phone')] };
    // The phone's first sync saved a new version, so the laptop combines rather than overwrites.
    await as('laptop', async () => { markLocalChange(); expect(await syncNow(() => laptop, async (s) => { laptop = s; })).toBe('merged'); });
    await as('phone', async () => { markLocalChange(); expect(await syncNow(() => phone, async (s) => { phone = s; })).toBe('merged'); });
    await as('laptop', async () => { expect(await syncNow(() => laptop, async (s) => { laptop = s; })).toBe('pulled'); expect(syncConfig()?.syncedAt).toBeTruthy(); });
    expect(laptop.txns.map((x) => x.id).sort()).toEqual(['a', 'from-laptop', 'from-phone']);
    expect(gist).not.toContain('from-phone');
  });
});
