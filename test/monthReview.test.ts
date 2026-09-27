import { describe, expect, it, vi, beforeEach } from 'vitest';
import { emptyState } from '../src/store';
import type { AppState, Txn } from '../src/types';

let n = 0;
const t = (o: Partial<Txn>): Txn => ({ id: `r${n++}`, accountId: 'A', importId: 'i', date: '2026-08-05', amount: 100, direction: 'debit', description: 'x',
  kind: 'spend', category: 'Food & Dining', source: 'rule', merchantKey: 'k', merchantName: 'Payee', importedAt: 0, ...o });

const store: Record<string, string> = {};
beforeEach(() => {
  vi.stubGlobal('localStorage', { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; }, removeItem: (k: string) => { delete store[k]; } });
  for (const k of Object.keys(store)) delete store[k];
});

const state = (): AppState => ({ ...emptyState(), settings: { ...emptyState().settings, aiKeys: { groq: 'gsk_test' }, aiOrder: ['groq'] },
  txns: [
    t({ date: '2026-07-10', amount: 20000, category: 'Food & Dining', merchantKey: 'swg', merchantName: 'Swiggy' }),
    t({ date: '2026-08-10', amount: 30000, category: 'Food & Dining', merchantKey: 'swg', merchantName: 'Swiggy' }),
    t({ date: '2026-08-12', amount: 45000, category: 'Shopping', merchantKey: 'croma', merchantName: 'Croma', accountId: 'X' }),
    t({ date: '2026-08-15', amount: 9999, category: 'Shopping', merchantKey: 'acct', merchantName: 'Secret', description: 'ACCT 50100000001234', excluded: true }),
  ] });

describe('AI month review', () => {
  it('sends the month figures only - no narrations, account numbers or uncounted rows', async () => {
    const { reviewInput } = await import('../src/monthReview');
    const d = reviewInput(state(), '2026-08');
    const s = JSON.stringify(d);
    expect(d.spent).toBe(75000);
    expect(d.categories[0]).toEqual({ category: 'Shopping', amount: 45000, usualPerMonth: 0 });
    expect(d.biggestPayments.map((p) => p.payee)).toEqual(['Croma', 'Swiggy']);
    expect(s).not.toContain('50100000001234');
    expect(s).not.toContain('Secret');
  });

  it('asks the AI once, keeps the answer until the figures change', async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'openai/gpt-oss-120b' }] }), { status: 200 });
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ headline: 'Shopping drove August up.', points: ['Croma ₹45,000.'], watch: ['Swiggy is rising.'] }) }, finish_reason: 'stop' }] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { aiMonthReview, cachedReview } = await import('../src/monthReview');
    const st = state();
    expect(cachedReview(st, '2026-08')).toBeNull();
    const r = await aiMonthReview(st, '2026-08', undefined, 0);
    expect(r.review.headline).toBe('Shopping drove August up.');
    const posted = fetchMock.mock.calls.filter(([u]) => String(u).includes('/chat/completions'));
    expect(posted.length).toBe(1);
    expect(String(posted[0][1]?.body)).toContain('Croma');
    expect(cachedReview(st, '2026-08')!.review.watch).toEqual(['Swiggy is rising.']);
    const changed = { ...st, txns: [...st.txns, t({ date: '2026-08-20', amount: 500, merchantKey: 'new' })] };
    expect(cachedReview(changed, '2026-08')).toBeNull();
    vi.unstubAllGlobals();
  });
});
