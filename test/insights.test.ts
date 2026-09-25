import { describe, expect, it } from 'vitest';
import { categoryShifts, pairKey, recurringPayments, unpairedTransfers, unusualSpends } from '../src/insights';
import type { Txn } from '../src/types';

let n = 0;
const t = (over: Partial<Txn>): Txn => ({ id: `t${n++}`, accountId: 'A', importId: 'i', date: '2026-07-05', amount: 100, direction: 'debit',
  description: '', kind: 'spend', category: 'Food & Dining', source: 'rule', merchantKey: 'K', merchantName: 'Payee', importedAt: 0, ...over });

describe('month review', () => {
  it('flags a payment far above the payee’s usual and a big new payee', () => {
    const rows = [
      t({ date: '2026-05-03', amount: 500, merchantKey: 'swiggy', merchantName: 'Swiggy' }),
      t({ date: '2026-06-03', amount: 450, merchantKey: 'swiggy', merchantName: 'Swiggy' }),
      t({ date: '2026-06-10', amount: 800, merchantKey: 'shop' }),
      t({ date: '2026-07-03', amount: 1500, merchantKey: 'swiggy', merchantName: 'Swiggy' }),
      t({ date: '2026-07-04', amount: 480, merchantKey: 'swiggy', merchantName: 'Swiggy' }),
      t({ date: '2026-07-09', amount: 42000, merchantKey: 'croma', merchantName: 'Croma' }),
      t({ date: '2026-07-10', amount: 900, merchantKey: 'new-small' }),
    ];
    const u = unusualSpends(rows, '2026-07');
    expect(u.map((x) => [x.txn.merchantName, x.reason])).toEqual([['Croma', 'New payee'], ['Swiggy', '3.2× the usual ₹475']]);
  });

  it('compares categories with the recent average', () => {
    const rows = [
      t({ date: '2026-05-03', amount: 4000 }), t({ date: '2026-06-03', amount: 6000 }),
      t({ date: '2026-07-03', amount: 12000 }),
      t({ date: '2026-06-03', amount: 3000, category: 'Shopping' }),
      t({ date: '2026-07-03', amount: 3100, category: 'Shopping' }),
    ];
    expect(categoryShifts(rows, '2026-07')).toEqual([{ category: 'Food & Dining', now: 12000, usual: 5000, delta: 7000 }, { category: 'Shopping', now: 3100, usual: 1500, delta: 1600 }]);
  });
});

describe('recurring payments', () => {
  const sip = (date: string, amount = 5000) => t({ date, amount, kind: 'investment', category: 'Mutual Funds', merchantKey: 'groww', merchantName: 'Groww SIP' });
  const rent = (date: string) => t({ date, amount: 25000, merchantKey: 'rent', merchantName: 'Rent' });
  it('finds monthly payments and flags the one missing this month', () => {
    const rows = [
      sip('2026-06-05'), sip('2026-07-05'), sip('2026-08-05', 5100), sip('2026-09-05'),
      rent('2026-06-01'), rent('2026-07-01'), rent('2026-08-01'),
      // many payments a month to one grocer is not a bill
      ...['06', '07', '08', '09'].flatMap((m) => [3, 9, 15, 21].map((d) => t({ date: `2026-${m}-${String(d).padStart(2, '0')}`, amount: 400, merchantKey: 'grocer' }))),
      // stopped months ago
      t({ date: '2026-04-10', amount: 199, merchantKey: 'old' }), t({ date: '2026-05-10', amount: 199, merchantKey: 'old' }),
    ];
    const r = recurringPayments(rows, '2026-09-20');
    expect(r.map((x) => [x.name, x.status, x.amount, x.day])).toEqual([['Rent', 'missing', 25000, 1], ['Groww SIP', 'paid', 5000, 5]]);
  });
  it('says due before the usual day', () => {
    const r = recurringPayments([rent('2026-07-20'), rent('2026-08-20')], '2026-09-10');
    expect(r[0].status).toBe('due');
  });
});

describe('unpaired transfers', () => {
  it('matches the same amount leaving one account and reaching another', () => {
    const out = t({ date: '2026-07-01', amount: 20000, accountId: 'HDFC', category: 'Uncategorised' });
    const inn = t({ date: '2026-07-02', amount: 20000, accountId: 'ICICI', direction: 'credit', category: 'Income' });
    const rows = [out, inn,
      t({ date: '2026-07-01', amount: 20000, accountId: 'HDFC', direction: 'credit' }), // same account
      t({ date: '2026-07-01', amount: 300, accountId: 'X', direction: 'credit' }), // too small
      t({ amount: 5000, accountId: 'HDFC', pairId: 'p' }), t({ amount: 5000, accountId: 'ICICI', direction: 'credit', pairId: 'q' }),
    ];
    const u = unpairedTransfers(rows);
    expect(u.map((p) => [p.out.id, p.in.id])).toEqual([[out.id, inn.id]]);
    expect(unpairedTransfers(rows, [pairKey(inn, out)])).toEqual([]);
  });
});
