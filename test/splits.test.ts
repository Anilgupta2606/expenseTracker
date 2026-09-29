import { describe, expect, it } from 'vitest';
import { answer, applyPlan, sanitize, targets, type AssistantPlan } from '../src/assistant';
import { buildLedgerExport } from '../src/ledgerExport';
import { actualsFor, summarize } from '../src/plans';
import { expandSplits, normTag, parentId, parseTags, splitLeft, splitProblem, tagTotals, allTags } from '../src/splits';
import { emptyState, migrate } from '../src/store';
import { applyFilters } from '../src/ui/format';
import type { AppState, Txn } from '../src/types';

const txn = (over: Partial<Txn>): Txn => ({
  id: over.id ?? Math.random().toString(36).slice(2), accountId: 'HDFC-1234', importId: 'i', date: '2026-08-10', amount: 100, direction: 'debit',
  description: 'UPI-X', kind: 'spend', category: 'Shopping', source: 'rule', merchantKey: 'X', merchantName: 'X', importedAt: 0, ...over,
});

// ₹1,000 at Amazon: ₹600 of it shopping, ₹400 groceries
const amazon = txn({
  id: 'amz', amount: 1000, merchantName: 'Amazon', merchantKey: 'AMAZON', tags: ['goa trip'],
  splits: [{ amount: 600, kind: 'spend', category: 'Shopping' }, { amount: 400, kind: 'spend', category: 'Groceries', note: 'snacks' }],
});

const filters = { month: 'all', account: 'all', kind: 'all' as const, category: '', search: '', groupBy: 'date' as const, range: 6 };

describe('splitting a transaction', () => {
  it('turns a split payment into its parts for the totals, and leaves others alone', () => {
    const plain = txn({ id: 'p', amount: 250 });
    const rows = expandSplits([amazon, plain]);
    expect(rows.map((r) => [r.id, r.amount, r.category])).toEqual([['amz::0', 600, 'Shopping'], ['amz::1', 400, 'Groceries'], ['p', 250, 'Shopping']]);
    expect(rows[1]).toMatchObject({ splitOf: 'amz', part: 1, note: 'snacks', tags: ['goa trip'], merchantName: 'Amazon', date: '2026-08-10' });
    expect(rows[2]).toBe(plain);
    expect(parentId('amz::1')).toBe('amz');
    expect(parentId('p')).toBe('p');
  });

  it('keeps the month total the same and moves money between categories', () => {
    const whole = txn({ id: 'w', amount: 1000 });
    expect(actualsFor(expandSplits([amazon])).spend).toBe(actualsFor([whole]).spend);
    const groceries = expandSplits([amazon]).filter((t) => t.category === 'Groceries').reduce((a, t) => a + t.amount, 0);
    expect(groceries).toBe(400);
  });

  it('can move part of a payment out of spending (an investment part, a part not counted)', () => {
    const mixed = txn({ id: 'mx', amount: 5000, splits: [{ amount: 1000, kind: 'spend', category: 'Shopping' }, { amount: 4000, kind: 'investment', category: 'Gold' }] });
    const a = actualsFor(expandSplits([mixed]));
    expect(a.spend).toBe(1000);
    expect(a.invested).toBe(4000);
    // Counted belongs to the whole payment: unticked, none of its parts count
    expect(actualsFor(expandSplits([{ ...mixed, excluded: true }])).excluded).toBe(5000);
    // the Ledger export sees only the investment part
    expect(buildLedgerExport(expandSplits([mixed])).months[0]).toMatchObject({ invested: 4000, byType: { Gold: 4000 } });
  });

  it('checks the parts add up before saving', () => {
    expect(splitProblem(1000, amazon.splits!)).toBeNull();
    expect(splitProblem(1000, [{ amount: 1000, kind: 'spend', category: 'Shopping' }])).toMatch(/at least two/);
    expect(splitProblem(1000, [{ amount: 600, kind: 'spend', category: 'Shopping' }, { amount: 300, kind: 'spend', category: 'Groceries' }])).toMatch(/₹100.00 short/);
    expect(splitProblem(1000, [{ amount: 600, kind: 'spend', category: 'Shopping' }, { amount: 500, kind: 'spend', category: 'Groceries' }])).toMatch(/₹100.00 more/);
    expect(splitProblem(1000, [{ amount: 1000, kind: 'spend', category: 'Shopping' }, { amount: 0, kind: 'spend', category: 'Groceries' }])).toMatch(/above zero/);
    expect(splitProblem(1000, [{ amount: 600, kind: 'spend', category: 'Gold' }, { amount: 400, kind: 'spend', category: 'Groceries' }])).toMatch(/category/);
    // paise add up exactly (0.1 + 0.2 is not 0.3 in floating point)
    expect(splitProblem(0.3, [{ amount: 0.1, kind: 'spend', category: 'Shopping' }, { amount: 0.2, kind: 'spend', category: 'Groceries' }])).toBeNull();
    expect(splitLeft(1000, [{ amount: 600 }, { amount: 250.5 }])).toBe(149.5);
  });

  it('shows the parts in the right place in the list filters', () => {
    const rows = expandSplits([amazon, txn({ id: 'p', category: 'Groceries', amount: 50 })]);
    const groceries = applyFilters(rows, { ...filters, kind: 'spend', category: 'Groceries' });
    expect(groceries.map((t) => [t.id, t.amount])).toEqual([['amz::1', 400], ['p', 50]]);
  });

  it('old saved data (no splits, no tags) loads and totals exactly as before', () => {
    const old = [txn({ id: 'a', amount: 120 }), txn({ id: 'b', amount: 80, direction: 'credit' })];
    const s = migrate({ ...emptyState(), txns: old });
    expect(expandSplits(s.txns)).toEqual(s.txns);
    expect(summarize(s, '2026-08', expandSplits(s.txns)).actual).toEqual(summarize(s, '2026-08', s.txns).actual);
  });
});

describe('tags', () => {
  it('stores tags tidy and without repeats', () => {
    expect(normTag('  #Goa   Trip ')).toBe('goa trip');
    expect(parseTags('goa trip, #Office, , GOA TRIP')).toEqual(['goa trip', 'office']);
    expect(normTag('x'.repeat(50))).toHaveLength(30);
  });

  it('lists the tags in use, most used first', () => {
    const list = [txn({ tags: ['office'] }), txn({ tags: ['office', 'goa trip'] }), txn({})];
    expect(allTags(list)).toEqual([{ tag: 'office', count: 2 }, { tag: 'goa trip', count: 1 }]);
  });

  it('totals money per tag, counting a split payment once', () => {
    const hotel = txn({ id: 'h', amount: 3000, category: 'Travel', tags: ['goa trip'] });
    const refund = txn({ id: 'r', amount: 200, direction: 'credit', tags: ['goa trip'] });
    const skipped = txn({ id: 's', amount: 999, tags: ['goa trip'], excluded: true });
    const [goa] = tagTotals(expandSplits([amazon, hotel, refund, skipped]));
    expect(goa).toEqual({ tag: 'goa trip', spent: 3800, invested: 0, moneyIn: 0, count: 3 });
  });

  it('filters and searches by tag', () => {
    const list = [amazon, txn({ id: 'o', tags: ['office'] }), txn({ id: 'n', note: 'office lunch' })];
    expect(applyFilters(list, { ...filters, tag: 'office' }).map((t) => t.id)).toEqual(['o']);
    expect(applyFilters(list, { ...filters, search: '#goa' }).map((t) => t.id)).toEqual(['amz']);
    // the note is searched too
    expect(applyFilters(list, { ...filters, search: 'office' }).map((t) => t.id).sort()).toEqual(['n', 'o']);
  });
});

describe('the assistant with splits and tags', () => {
  const state = (): AppState => ({ ...emptyState(), accounts: [{ id: 'HDFC-1234', bank: 'HDFC', number: '1234' }], txns: [amazon, txn({ id: 'o', amount: 70, category: 'Groceries', tags: ['office'] })] });
  const plan = (p: Partial<AssistantPlan>): AssistantPlan => ({ intent: 'question', reply: '', filter: {}, remember: false, ...p });

  it('answers from the parts: groceries includes the grocery part of the Amazon order', () => {
    const rows = targets(state(), plan({ filter: { categories: ['Groceries'], counted: true } }));
    expect(answer(rows).moneyOut).toBe(470);
  });

  it('filters by tag', () => {
    const rows = targets(state(), plan({ filter: { tags: ['#Goa Trip'] } }));
    expect(answer(rows).moneyOut).toBe(1000);
    expect(sanitize({ intent: 'question', reply: '', filter: { tags: [' #Office', ''] } }).filter.tags).toEqual(['office']);
  });

  it('changes whole transactions, and never retypes a split one', () => {
    const s = state();
    const change = plan({ intent: 'change', action: { type: 'set_type', kind: 'spend', category: 'Travel' } });
    const hit = targets(s, change);
    expect(hit.map((t) => t.id)).toEqual(['o']);
    const after = applyPlan(s, change, new Set(hit.map((t) => t.id)));
    expect(after.txns.find((t) => t.id === 'amz')!.splits).toEqual(amazon.splits);
    const title = plan({ intent: 'change', action: { type: 'set_title', title: 'Amazon India' } });
    expect(targets(s, title).map((t) => t.id)).toEqual(['amz', 'o']);
  });
});
