import { describe, expect, it } from 'vitest';
import { buildLedgerExport } from '../src/ledgerExport';
import type { Txn } from '../src/types';

const t = (over: Partial<Txn>): Txn => ({ id: Math.random().toString(36), accountId: 'a', importId: 'i', date: '2026-07-05', amount: 100, direction: 'debit',
  description: 'secret narration 055801624441', kind: 'investment', category: 'Mutual Funds', source: 'rule', merchantKey: 'K', merchantName: 'Groww', importedAt: 0, ...over });

describe('investments for the Ledger', () => {
  it('adds up counted investments per month and type, amounts only', () => {
    const out = buildLedgerExport([
      t({ amount: 5000 }), t({ amount: 7500, category: 'Stocks' }), t({ amount: 4117.82, direction: 'credit' }),
      t({ date: '2026-08-02', amount: 5000 }), t({ amount: 999, excluded: true }), t({ amount: 300, kind: 'spend', category: 'Shopping' }),
    ], new Date('2026-09-25'));
    expect(out).toEqual({ ledgerImport: 'expense-tracker', v: 1, exportedAt: '2026-09-25', months: [
      { month: '2026-07', invested: 12500, redeemed: 4117.82, byType: { 'Mutual Funds': 5000, Stocks: 7500 } },
      { month: '2026-08', invested: 5000, redeemed: 0, byType: { 'Mutual Funds': 5000 } },
    ] });
    expect(JSON.stringify(out)).not.toMatch(/secret|055801624441|Groww/);
  });
});
