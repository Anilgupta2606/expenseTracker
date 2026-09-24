import { describe, expect, it } from 'vitest';
import { applyRescan, buildPreview, commitPreview, diffRescan } from '../src/importer';
import { emptyState } from '../src/store';
import type { ParseResult } from '../src/types';

const full: ParseResult = {
  meta: { bank: 'HDFC', accountNumber: '50100000001234', holderName: 'RAVI KUMAR' },
  balanceMismatches: 0,
  warnings: [],
  txns: [
    { date: '2026-07-01', description: 'UPI-SWIGGY-SWIGGY@ICICI-X-1', amount: 300, direction: 'debit', balance: 9700 },
    { date: '2026-07-02', description: 'UPI-ZOMATO-ZOMATO@HDFCBANK-X-2', amount: 200, direction: 'debit', balance: 9500 },
    { date: '2026-07-03', description: 'NEFT CR-ACME-SALARY JUL', amount: 50000, direction: 'credit', balance: 59500 },
  ],
};

describe('rescanning a statement', () => {
  it('adds only the rows the first reading missed and keeps your edits', () => {
    // First reading missed the Zomato row and flagged a balance gap.
    const first: ParseResult = { ...full, balanceMismatches: 1, txns: [full.txns[0], full.txns[2]] };
    const pv = buildPreview(first, emptyState(), 'jul.pdf');
    let s = commitPreview(emptyState(), pv);
    const id = s.imports[0].id;
    // You changed the Swiggy row by hand.
    s = { ...s, txns: s.txns.map((t) => (t.description.includes('SWIGGY') ? { ...t, kind: 'ignore', category: 'Not counted', source: 'manual' } : t)) };

    const diff = diffRescan(s, id, full);
    expect(diff.missing.map((t) => t.description)).toEqual(['UPI-ZOMATO-ZOMATO@HDFCBANK-X-2']);
    expect(diff.matched).toBe(2);
    expect(diff.missing[0].importId).toBe(id);

    const next = applyRescan(s, id, diff);
    expect(next.txns).toHaveLength(3);
    expect(next.txns.find((t) => t.description.includes('SWIGGY'))!.kind).toBe('ignore');
    expect(next.imports[0]).toMatchObject({ rows: 3, balanceMismatches: 0 });
    expect(next.imports[0].rescannedAt).toBeGreaterThan(0);
  });

  it('finds nothing new when the statement was read completely', () => {
    const s = commitPreview(emptyState(), buildPreview(full, emptyState(), 'jul.pdf'));
    expect(diffRescan(s, s.imports[0].id, full).missing).toHaveLength(0);
  });
});
