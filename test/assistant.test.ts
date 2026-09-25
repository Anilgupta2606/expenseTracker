import { afterEach, describe, expect, it, vi } from 'vitest';
import { answer, applyPlan, planRequest, sanitize, targets, type AssistantPlan } from '../src/assistant';
import { emptyState } from '../src/store';
import type { AppState, Txn } from '../src/types';

const txn = (over: Partial<Txn>): Txn => ({
  id: over.id ?? Math.random().toString(36).slice(2), accountId: 'HDFC-1234', importId: 'i', date: '2026-08-10', amount: 100, direction: 'debit',
  description: 'UPI-X', kind: 'spend', category: 'Food & Dining', source: 'rule', merchantKey: 'X', merchantName: 'X', importedAt: 0, ...over,
});

const state = (): AppState => ({
  ...emptyState(),
  accounts: [{ id: 'HDFC-1234', bank: 'HDFC', number: '1234' }],
  txns: [
    txn({ id: 'a', kind: 'transfer', category: 'Self Transfer', amount: 20000, merchantName: 'Anil Gupta', merchantKey: 'ANIL GUPTA' }),
    txn({ id: 'b', kind: 'transfer', category: 'Self Transfer', amount: 5000, direction: 'credit', merchantName: 'Anil Gupta', merchantKey: 'ANIL GUPTA' }),
    txn({ id: 'c', amount: 300, merchantName: 'Swiggy', merchantKey: 'SWIGGY', date: '2026-08-02' }),
    txn({ id: 'd', amount: 500, merchantName: 'Swiggy', merchantKey: 'SWIGGY', date: '2026-07-20' }),
    txn({ id: 'e', amount: 80, merchantName: 'Rakesh jai', merchantKey: 'RAKESH JAI', category: 'Payments to People' }),
  ],
});

const plan = (p: Partial<AssistantPlan>): AssistantPlan => ({ intent: 'change', reply: '', filter: {}, remember: false, ...p });

describe('assistant changes', () => {
  it('moves all self transfers to not counted', () => {
    const s = state();
    const p = plan({ filter: { categories: ['Self Transfer'] }, action: { type: 'set_counted', counted: false } });
    const ids = targets(s, p).map((t) => t.id);
    expect(ids).toEqual(['a', 'b']);
    const next = applyPlan(s, p, new Set(ids));
    expect(next.txns.filter((t) => t.excluded).map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('only changes the rows that were previewed', () => {
    const s = state();
    const p = plan({ filter: { payees: ['swiggy'] }, action: { type: 'set_counted', counted: false } });
    const next = applyPlan(s, p, new Set(['c']));
    expect(next.txns.find((t) => t.id === 'd')!.excluded).toBeFalsy();
  });

  it('changes type and remembers it for the payee', () => {
    const s = state();
    const p = plan({ filter: { payees: ['Rakesh jai'] }, action: { type: 'set_type', kind: 'spend', category: 'Groceries' }, remember: true });
    const next = applyPlan(s, p, new Set(targets(s, p).map((t) => t.id)));
    expect(next.txns.find((t) => t.id === 'e')).toMatchObject({ category: 'Groceries', source: 'manual' });
    expect(next.rules).toEqual([expect.objectContaining({ key: 'RAKESH JAI', kind: 'spend', category: 'Groceries', direction: 'debit' })]);
  });

  it('renames and remembers the title', () => {
    const s = state();
    const p = plan({ filter: { payees: ['Rakesh jai'] }, action: { type: 'set_title', title: 'Rakesh Kirana' }, remember: true });
    const next = applyPlan(s, p, new Set(['e']));
    expect(next.txns.find((t) => t.id === 'e')).toMatchObject({ merchantName: 'Rakesh Kirana', titleSet: 'manual' });
    expect(next.rules[0].title).toBe('Rakesh Kirana');
  });

  it('switches a whole category off for now and future uploads', () => {
    const s = state();
    const p = plan({ action: { type: 'category_counted', kind: 'spend', category: 'Food & Dining', counted: false } });
    const ids = targets(s, p).map((t) => t.id);
    expect(ids).toEqual(['c', 'd']);
    const next = applyPlan(s, p, new Set(ids));
    expect(next.settings.categoryCounted).toEqual({ 'spend:Food & Dining': false });
    expect(next.txns.filter((t) => t.excluded).map((t) => t.id)).toEqual(['c', 'd']);
  });
});

describe('assistant questions', () => {
  it('filters by month and adds up on the device', () => {
    const s = state();
    const rows = targets(s, plan({ intent: 'question', filter: { payees: ['Swiggy'], from: '2026-08-01', to: '2026-08-31' } }));
    expect(answer(rows)).toMatchObject({ count: 1, moneyOut: 300, moneyIn: 0 });
    const all = answer(s.txns, 'by_payee');
    expect(all.groups![0]).toMatchObject({ label: 'Anil Gupta', out: 20000, in: 5000, count: 2 });
  });
});

describe('talking to Gemini', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends the request, categories and payee titles but no amounts or account numbers', async () => {
    let sent = '';
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body)).contents[0].parts[0].text;
      const out = { intent: 'change', reply: 'Marking self transfers as not counted.', filter: { categories: ['Self Transfer'] }, action: { type: 'set_counted', counted: false }, remember: false };
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] } }] }), { status: 200 });
    }));
    const s = { ...state(), settings: { ...state().settings, geminiKey: 'k' } };
    const p = await planRequest('move all self transfers to not counted', s, 0, '2026-09-25');
    expect(p).toMatchObject({ intent: 'change', action: { type: 'set_counted', counted: false }, filter: { categories: ['Self Transfer'] } });
    expect(sent).toContain('move all self transfers to not counted');
    expect(sent).toContain('"Swiggy"');
    expect(sent).not.toContain('20000');
    expect(sent).not.toContain('1234');
  });

  it('fills in what a smaller model left out', () => {
    const p = sanitize({ intent: 'change', reply: '', filter: {}, action: { type: 'category_counted', kind: 'cc_bill', title: 'Credit Card Bill' } }, 'never count credit card bills');
    expect(p.action).toEqual({ type: 'category_counted', kind: 'cc_bill', category: 'Credit Card Bill', counted: false });
    expect(sanitize({ intent: 'change', reply: '', filter: {}, action: { type: 'set_counted' } }, 'always include Swiggy').action).toEqual({ type: 'set_counted', counted: true });
    expect(sanitize({ intent: 'change', reply: '', filter: {}, action: { type: 'set_type', kind: 'investment' } }, 'mark as investment').action).toEqual({ type: 'set_type', kind: 'investment', category: 'Other Investment' });
  });

  it('turns a change without a usable action into a question back', () => {
    expect(sanitize({ intent: 'change', reply: 'Which ones?', filter: {}, action: { type: 'set_title', title: ' ' } }).intent).toBe('unclear');
  });
});

it('a row matching either a payee title or the search words is in', () => {
  const s = state();
  s.txns.push(txn({ id: 'g', merchantName: 'Mutual Fun', description: 'UPI/MUTUAL FUN/groww.iccl1.br' }));
  const rows = targets(s, { intent: 'change', reply: '', remember: false, filter: { payees: ['Swiggy'], text: 'groww' } });
  expect(rows.map((t) => t.id).sort()).toEqual(['c', 'd', 'g']);
});

it('reads "paid" as money out for questions', () => {
  expect(sanitize({ intent: 'question', reply: '', filter: {} }, 'top payees I paid in July').filter.direction).toBe('debit');
});

it('answers leave out rows that are not counted unless asked about them', () => {
  expect(sanitize({ intent: 'question', reply: '', filter: {} }, 'top payees').filter.counted).toBe(true);
  expect(sanitize({ intent: 'question', reply: '', filter: { counted: false } }, 'which are not counted').filter.counted).toBe(false);
});
