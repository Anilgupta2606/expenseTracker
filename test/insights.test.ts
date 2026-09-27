import { describe, expect, it } from 'vitest';
import { categoryShifts, pairKey, recurringPayments, spendAlerts, subscriptions, unpairedTransfers, unusualSpends } from '../src/insights';
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

describe('subscriptions', () => {
  const pay = (key: string, name: string, category: string, date: string, amount: number) => t({ merchantKey: key, merchantName: name, category, date, amount });
  const rows = [
    ...['2026-05-12', '2026-06-12', '2026-07-12', '2026-08-12'].map((d, i) => pay('nflx', 'Netflix', 'Entertainment', d, i < 3 ? 499 : 649)),
    ...['2026-06-03', '2026-07-03', '2026-08-03'].map((d) => pay('jio', 'Jio Fiber', 'Mobile & Internet', d, 1178)),
    ...['2026-06-01', '2026-07-01', '2026-08-01'].map((d) => pay('rent', 'Landlord', 'Rent & Housing', d, 25000)),        // not a subscription
    ...['2026-06-05', '2026-07-05', '2026-08-05'].map((d) => pay('gpt', 'OpenAI ChatGPT', 'Shopping', d, 1950)),           // by name
    pay('prime', 'Amazon Prime', 'Subscriptions', '2025-09-02', 1499), pay('prime', 'Amazon Prime', 'Subscriptions', '2026-09-01', 1499),
    pay('hotel', 'Taj Hotel', 'Travel', '2025-09-02', 9000), pay('hotel', 'Taj Hotel', 'Travel', '2026-09-01', 9500),     // a trip, not a plan
  ];
  it('finds monthly and yearly ones, next due dates, yearly cost and price changes', () => {
    const s = subscriptions(rows, {}, '2026-09-10');
    expect(s.map((x) => [x.name, x.cycle, x.nextDue, x.yearly])).toEqual([
      ['OpenAI ChatGPT', 'monthly', '2026-09-05', 23400],
      ['Jio Fiber', 'monthly', '2026-09-03', 14136],
      ['Netflix', 'monthly', '2026-09-12', 7788],
      ['Amazon Prime', 'yearly', '2027-09-01', 1499],
    ]);
    expect(s.find((x) => x.name === 'Netflix')!.change).toEqual({ from: 499, to: 649, since: '2026-08-12' });
  });
  it('flags one charged after you marked it to cancel', () => {
    const s = subscriptions(rows, { jio: { mark: 'cancel', at: '2026-07-10' }, nflx: { mark: 'keep', at: '2026-07-10' } }, '2026-09-10');
    expect(s[0].name).toBe('Jio Fiber');
    expect(s[0].chargedAfterCancel).toBe('2026-08-03');
    expect(s.find((x) => x.name === 'Netflix')!.mark).toBe('keep');
  });
  it('the next due date keeps to the end of a short month', () => {
    const s = subscriptions(['2026-05-31', '2026-06-30', '2026-07-31', '2026-08-31'].map((d) => pay('x', 'Spotify', 'Subscriptions', d, 119)), {}, '2026-09-05');
    expect(s[0].nextDue).toBe('2026-09-30');
  });
});

describe('unusual spend alerts', () => {
  const months = ['2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07'];
  const base = months.flatMap((m) => [
    t({ date: `${m}-05`, amount: 5000, category: 'Shopping', merchantKey: 'amz', merchantName: 'Amazon' }),
    t({ date: `${m}-10`, amount: 20000, category: 'Food & Dining', merchantKey: 'swg', merchantName: 'Swiggy' }),
  ]);
  it('flags a category far above its average, and the month when the total is too', () => {
    const rows = [...base, t({ date: '2026-08-05', amount: 12000, category: 'Shopping', merchantKey: 'amz', merchantName: 'Amazon' }),
      t({ date: '2026-08-10', amount: 21000, category: 'Food & Dining', merchantKey: 'swg', merchantName: 'Swiggy' })];
    const a = spendAlerts(rows, '2026-08');
    expect(a.map((x) => x.text)).toEqual(['Spending is 1.3× your 6-month average', 'Shopping is 2.4× your 6-month average', 'Amazon: ₹12,000']);
    const b = spendAlerts([...rows, t({ date: '2026-08-20', amount: 9000, category: 'Travel', merchantKey: 'irctc', merchantName: 'IRCTC' })], '2026-08');
    expect(b.map((x) => x.kind)).toEqual(['month', 'category', 'category', 'payee']);
    expect(b[0].text).toBe('Spending is 1.7× your 6-month average');
    expect(b.find((x) => x.category === 'Travel')!.text).toBe('Travel: ₹9,000, new this month');
  });
  it('stays quiet for normal months and small amounts, and forgets dismissed ones', () => {
    expect(spendAlerts([...base, t({ date: '2026-08-05', amount: 5200, category: 'Shopping', merchantKey: 'amz' })], '2026-08')).toEqual([]);
    const rows = [...base, t({ date: '2026-08-05', amount: 12000, category: 'Shopping', merchantKey: 'amz', merchantName: 'Amazon' })];
    const ids = spendAlerts(rows, '2026-08').map((x) => x.id);
    expect(spendAlerts(rows, '2026-08', ids)).toEqual([]);
  });
});
