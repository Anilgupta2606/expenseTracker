import { describe, expect, it } from 'vitest';
import { buildPreview, commitPreview, recategorizeAll } from '../src/importer';
import { emptyState, migrate } from '../src/store';
import { categoryCounted } from '../src/categorize/categories';
import type { ParseResult } from '../src/types';

const stmt = (txns: ParseResult['txns']): ParseResult => ({ meta: { bank: 'HDFC', accountNumber: '50100000001234', holderName: 'RAVI KUMAR' }, txns, balanceMismatches: 0, warnings: [] });
const selfRow = { date: '2026-08-01', description: 'IMPS-618240529098-RAVI KUMAR-ICIC-XXXXXXXX4441-IMPS TRANSACTION', amount: 20000, direction: 'debit' as const, balance: 80000 };
const swiggy = { date: '2026-08-02', description: 'UPI-SWIGGY-SWIGGY@ICICI-X-1', amount: 300, direction: 'debit' as const, balance: 79700 };

describe('what counts in totals', () => {
  it('leaves self transfers out by default', () => {
    expect(categoryCounted({}, 'transfer', 'Self Transfer')).toBe(false);
    expect(categoryCounted({}, 'spend', 'Food & Dining')).toBe(true);
    const st = { ...emptyState(), settings: { ...emptyState().settings, ownNames: ['RAVI KUMAR'] } };
    const s = commitPreview(st, buildPreview(stmt([selfRow, swiggy]), st, 'a.pdf'));
    expect(s.txns.find((t) => t.amount === 20000)).toMatchObject({ kind: 'transfer', excluded: true });
    expect(s.txns.find((t) => t.amount === 300)!.excluded).toBeFalsy();
  });

  it('follows your switches for new uploads', () => {
    const st = { ...emptyState(), settings: { ...emptyState().settings, categoryCounted: { 'spend:Food & Dining': false, 'transfer:Self Transfer': true } } };
    const s = commitPreview(st, buildPreview(stmt([swiggy]), st, 'a.pdf'));
    expect(s.txns[0]).toMatchObject({ category: 'Food & Dining', excluded: true });
  });

  it('keeps a single row you ticked back in when everything is re-categorised', () => {
    const st = { ...emptyState(), settings: { ...emptyState().settings, ownNames: ['RAVI KUMAR'] } };
    let s = commitPreview(st, buildPreview(stmt([selfRow]), st, 'a.pdf'));
    s = { ...s, txns: s.txns.map((t) => ({ ...t, excluded: false })) };
    expect(recategorizeAll(s).txns[0].excluded).toBe(false);
  });

  it('applies the new default to self transfers saved by older versions', () => {
    const old = { ...emptyState(), txns: [{ id: 'x', accountId: 'a', importId: 'i', date: '2026-08-01', amount: 5, direction: 'debit', description: 'd', kind: 'transfer', category: 'Self Transfer', source: 'self', merchantKey: 'K', merchantName: 'K', importedAt: 0 }] };
    delete (old.settings as { categoryCounted?: unknown }).categoryCounted;
    const s = migrate(old as never);
    expect(s.txns[0].excluded).toBe(true);
    expect(s.settings.categoryCounted).toEqual({});
    // Only once: a later tick stays.
    const again = migrate({ ...s, txns: s.txns.map((t) => ({ ...t, excluded: false })) });
    expect(again.txns[0].excluded).toBe(false);
  });
});
