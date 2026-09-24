import { describe, expect, it } from 'vitest';
import { deleteImport } from '../src/importer';
import { monthRange, planFor, setPlan, summarize } from '../src/plans';
import { emptyState, migrate } from '../src/store';
import type { AppState, Txn } from '../src/types';

const txn = (over: Partial<Txn>): Txn => ({
  id: Math.random().toString(36), accountId: 'HDFC-1234', importId: 'imp1', date: '2026-07-10',
  description: 'x', amount: 100, direction: 'debit', kind: 'spend', category: 'Shopping',
  source: 'rule', merchantKey: 'X', merchantName: 'X', importedAt: 1, ...over,
});

const plan = (income: number, expectedSpend: number, expectedInvestment: number) => ({ income, expectedSpend, expectedInvestment });

describe('monthly plans', () => {
  it('carries a plan forward to later months', () => {
    const plans = { '2026-05': plan(100000, 40000, 20000) };
    expect(planFor(plans, '2026-07')).toMatchObject({ plan: plans['2026-05'], own: false, set: true });
    expect(planFor(plans, '2026-04').set).toBe(false);
  });

  it('keeps history when a later month changes', () => {
    let s: AppState = { ...emptyState(), plans: { '2026-05': plan(100000, 40000, 20000) } };
    const months = ['2026-05', '2026-06', '2026-07', '2026-08'];
    s = setPlan(s, '2026-08', plan(120000, 45000, 30000), months);
    expect(planFor(s.plans, '2026-06').plan.income).toBe(100000);
    expect(planFor(s.plans, '2026-07').plan.income).toBe(100000);
    expect(planFor(s.plans, '2026-08').plan.income).toBe(120000);
    expect(planFor(s.plans, '2026-09').plan.income).toBe(120000);
  });

  it('keeps later months when an earlier month is corrected', () => {
    let s: AppState = { ...emptyState(), plans: { '2026-05': plan(100000, 40000, 20000) } };
    s = setPlan(s, '2026-05', plan(90000, 40000, 20000), ['2026-05', '2026-06', '2026-07']);
    expect(planFor(s.plans, '2026-05').plan.income).toBe(90000);
    expect(planFor(s.plans, '2026-07').plan.income).toBe(100000);
  });

  it('works out saved or overspent from your income', () => {
    const s: AppState = { ...emptyState(), plans: { '2026-07': plan(100000, 40000, 30000) } };
    const txns = [
      txn({ amount: 50000 }), // spend
      txn({ amount: 2000, direction: 'credit' }), // refund
      txn({ amount: 25000, kind: 'investment', category: 'Mutual Funds' }),
      txn({ amount: 20000, kind: 'transfer', category: 'Self Transfer' }), // ignored
      txn({ amount: 150000, direction: 'credit', kind: 'income', category: 'Salary' }), // your entry wins
      txn({ date: '2026-06-30', amount: 99999 }), // other month
    ];
    const r = summarize(s, '2026-07', txns);
    expect(r.actual.spend).toBe(48000);
    expect(r.actual.invested).toBe(25000);
    expect(r.spendOver).toBe(8000);
    expect(r.investOver).toBe(-5000);
    expect(r.saved).toBe(100000 - 48000 - 25000);
    expect(r.plannedSaving).toBe(30000);
  });

  it('lists every month between the first and last', () => {
    const s: AppState = { ...emptyState(), txns: [txn({ date: '2026-05-02' }), txn({ date: '2026-08-02' })] };
    expect(monthRange(s)).toEqual(['2026-05', '2026-06', '2026-07', '2026-08']);
  });
});

describe('uploaded statements', () => {
  it('deletes a statement with its rows and keeps plans', () => {
    const s: AppState = {
      ...emptyState(),
      accounts: [{ id: 'HDFC-1234', bank: 'HDFC', number: '1234' }],
      imports: [
        { id: 'imp1', fileName: 'jul.pdf', accountId: 'HDFC-1234', from: '2026-07-01', to: '2026-07-31', importedAt: 1 },
        { id: 'imp2', fileName: 'aug.pdf', accountId: 'HDFC-1234', from: '2026-08-01', to: '2026-08-31', importedAt: 2 },
      ],
      txns: [txn({ importId: 'imp1' }), txn({ importId: 'imp2', date: '2026-08-05' })],
      plans: { '2026-07': plan(1, 1, 1) },
    };
    const next = deleteImport(s, 'imp1');
    expect(next.imports.map((i) => i.id)).toEqual(['imp2']);
    expect(next.txns).toHaveLength(1);
    expect(next.accounts).toHaveLength(1);
    expect(next.plans['2026-07']).toBeDefined();
    expect(deleteImport(next, 'imp2').accounts).toHaveLength(0);
  });

  it('rebuilds upload records for data saved before they existed', () => {
    const old = { ...emptyState(), imports: undefined, txns: [txn({ importId: undefined as unknown as string, importedAt: 5 })] };
    const m = migrate(old as unknown as AppState);
    expect(m.imports).toHaveLength(1);
    expect(m.txns[0].importId).toBe(m.imports[0].id);
  });
});

describe('changing what a transaction counts as', () => {
  it('leaves "Not counted" rows out of every total', async () => {
    const { actualsFor } = await import('../src/plans');
    const a = actualsFor([
      txn({ amount: 1000 }),
      txn({ amount: 5000, kind: 'ignore', category: 'Not counted' }),
      txn({ amount: 3000, kind: 'investment', category: 'Other Investment' }),
    ]);
    expect(a.spend).toBe(1000);
    expect(a.invested).toBe(3000);
  });

  it('picks a sensible category for the new type', async () => {
    const { defaultCategory } = await import('../src/categorize/categories');
    expect(defaultCategory('investment', 'Shopping')).toBe('Other Investment');
    expect(defaultCategory('spend', 'Mutual Funds')).toBe('Uncategorised');
    expect(defaultCategory('spend', 'Shopping')).toBe('Shopping');
    expect(defaultCategory('ignore', 'Shopping')).toBe('Not counted');
  });
});

describe('card bills and the Counted checkbox', () => {
  it('counts card bill payments as spending', async () => {
    const { actualsFor } = await import('../src/plans');
    const a = actualsFor([txn({ amount: 1000 }), txn({ amount: 20000, kind: 'cc_bill', category: 'Credit Card Bill' })]);
    expect(a.spend).toBe(21000);
    expect(a.cardBills).toBe(20000);
  });

  it('leaves unticked rows out of every total', async () => {
    const { actualsFor } = await import('../src/plans');
    const a = actualsFor([
      txn({ amount: 1000 }),
      txn({ amount: 20000, kind: 'cc_bill', category: 'Credit Card Bill', excluded: true }),
      txn({ amount: 5000, kind: 'investment', category: 'Stocks', excluded: true }),
    ]);
    expect(a.spend).toBe(1000);
    expect(a.invested).toBe(0);
    expect(a.excluded).toBe(25000);
  });

  it('turns the old "Not counted" type into an unticked box', () => {
    const old = { ...emptyState(), txns: [txn({ kind: 'ignore', category: 'Not counted' })], rules: [{ key: 'X', kind: 'ignore' as const, category: 'Not counted', createdAt: 0 }] };
    const m = migrate(old as AppState);
    expect(m.txns[0]).toMatchObject({ kind: 'spend', excluded: true });
    expect(m.rules[0]).toMatchObject({ kind: 'spend', excluded: true });
  });
});
