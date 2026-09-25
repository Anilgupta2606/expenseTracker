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

  it('corrects a description the first reading attached to the wrong row', () => {
    const wrong: ParseResult = { ...full, txns: full.txns.map((t, i) => (i === 1 ? { ...t, description: 'DLF MALL O UPI/ZOMATO/zomato@hdfcbank/X/2' } : t)) };
    const s = commitPreview(emptyState(), buildPreview(wrong, emptyState(), 'jul.pdf'));
    const diff = diffRescan(s, s.imports[0].id, full);
    expect(diff.missing).toHaveLength(0);
    expect(diff.corrected).toHaveLength(1);
    const next = applyRescan(s, s.imports[0].id, diff);
    expect(next.txns).toHaveLength(3);
    expect(next.txns.find((t) => t.amount === 200)!.description).toBe('UPI-ZOMATO-ZOMATO@HDFCBANK-X-2');
  });

  it('does not duplicate rows when the same statement is uploaded again after the reader improves', () => {
    const wrong: ParseResult = { ...full, txns: full.txns.map((t, i) => (i === 1 ? { ...t, description: 'SOMETHING ELSE' } : t)) };
    const s = commitPreview(emptyState(), buildPreview(wrong, emptyState(), 'jul.pdf'));
    expect(buildPreview(full, s, 'jul.pdf').fresh).toHaveLength(0);
  });

  it('finds nothing new when the statement was read completely', () => {
    const s = commitPreview(emptyState(), buildPreview(full, emptyState(), 'jul.pdf'));
    expect(diffRescan(s, s.imports[0].id, full).missing).toHaveLength(0);
  });
});

describe('rows that look alike', () => {
  // A payment, its refund, then a second payment: rows 1 and 3 share date, amount and balance.
  const twins: ParseResult = {
    ...full,
    txns: [
      { date: '2026-08-05', description: 'UPI-SWIGGY-SWIGGY@ICICI-X-11', amount: 100, direction: 'debit', balance: 900 },
      { date: '2026-08-05', description: 'UPI REVERSAL SWIGGY-X-11', amount: 100, direction: 'credit', balance: 1000 },
      { date: '2026-08-05', description: 'UPI-ZOMATO-ZOMATO@HDFCBANK-X-12', amount: 100, direction: 'debit', balance: 900 },
      { date: '2026-08-05', description: 'UPI-ZOMATO-ZOMATO@HDFCBANK-X-12', amount: 0.5, direction: 'debit', balance: 899.5 },
      { date: '2026-08-05', description: 'UPI-ZOMATO-ZOMATO@HDFCBANK-X-12', amount: 0.5, direction: 'debit', balance: 899.5 },
    ],
  };

  it('keeps every row on upload', () => {
    const pv = buildPreview(twins, emptyState(), 'aug.pdf');
    expect(pv.fresh).toHaveLength(5);
    expect(new Set(pv.fresh.map((t) => t.id)).size).toBe(5);
  });

  it('finds nothing to fix when the same file is rescanned, again and again', () => {
    let s = commitPreview(emptyState(), buildPreview(twins, emptyState(), 'aug.pdf'));
    const id = s.imports[0].id;
    for (let round = 0; round < 3; round++) {
      const diff = diffRescan(s, id, twins);
      expect(diff.missing).toHaveLength(0);
      expect(diff.corrected).toHaveLength(0);
      expect(diff.matched).toBe(5);
      s = applyRescan(s, id, diff);
    }
    expect(s.txns).toHaveLength(5);
  });

  it('settles after one correction', () => {
    const wrong = { ...twins, txns: twins.txns.map((t, i) => (i === 2 ? { ...t, description: 'DLF MALL O ZOMATO' } : t)) };
    let s = commitPreview(emptyState(), buildPreview(wrong, emptyState(), 'aug.pdf'));
    const id = s.imports[0].id;
    const first = diffRescan(s, id, twins);
    expect(first.corrected).toHaveLength(1);
    s = applyRescan(s, id, first);
    const second = diffRescan(s, id, twins);
    expect(second.corrected).toHaveLength(0);
    expect(second.missing).toHaveLength(0);
  });

  it('still skips an exact re-upload of the same statement', () => {
    const s = commitPreview(emptyState(), buildPreview(twins, emptyState(), 'aug.pdf'));
    const again = buildPreview(twins, s, 'aug-copy.pdf');
    expect(again.fresh).toHaveLength(0);
    expect(again.duplicates).toBe(5);
  });
});
