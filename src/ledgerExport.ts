import type { Txn } from './types';

/** What the 16-Year Ledger's "Paste from expense tracker" box reads. */
export interface LedgerExport {
  ledgerImport: 'expense-tracker';
  v: 1;
  exportedAt: string;
  months: { month: string; invested: number; redeemed: number; byType: Record<string, number> }[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Money put into (and taken out of) investments each month, by type, from
 * every counted investment transaction. Amounts only: no names, narrations
 * or account numbers.
 */
export function buildLedgerExport(txns: Txn[], today = new Date()): LedgerExport {
  const byMonth = new Map<string, { invested: number; redeemed: number; byType: Record<string, number> }>();
  for (const t of txns) {
    if (t.kind !== 'investment' || t.excluded) continue;
    const m = t.date.slice(0, 7);
    const e = byMonth.get(m) ?? { invested: 0, redeemed: 0, byType: {} };
    if (t.direction === 'debit') {
      e.invested += t.amount;
      e.byType[t.category] = (e.byType[t.category] ?? 0) + t.amount;
    } else {
      e.redeemed += t.amount;
    }
    byMonth.set(m, e);
  }
  return {
    ledgerImport: 'expense-tracker',
    v: 1,
    exportedAt: today.toISOString().slice(0, 10),
    months: [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, e]) => ({
      month,
      invested: r2(e.invested),
      redeemed: r2(e.redeemed),
      byType: Object.fromEntries(Object.entries(e.byType).map(([k, v]) => [k, r2(v)])),
    })),
  };
}
