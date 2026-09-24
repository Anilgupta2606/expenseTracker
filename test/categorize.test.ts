import { describe, expect, it } from 'vitest';
import { categorize, extractMerchant, pairTransfers, type Context } from '../src/categorize/engine';
import { emptyState } from '../src/store';
import type { Direction, Txn } from '../src/types';

const ctx: Context = {
  settings: { ...emptyState().settings, ownNames: ['RAVI KUMAR'] },
  accounts: [
    { id: 'HDFC-1234', bank: 'HDFC', number: '50100000001234', holderName: 'RAVI KUMAR' },
    { id: 'ICICI-9876', bank: 'ICICI', number: '000000009876', holderName: 'RAVI KUMAR' },
  ],
  rules: [],
};

function cat(description: string, direction: Direction = 'debit', accountId = 'HDFC-1234', c = ctx) {
  const t = { date: '2026-07-01', description, amount: 100, direction };
  const r = categorize(t, extractMerchant(description), c, accountId);
  return `${r.kind}/${r.category}`;
}

describe('categorize', () => {
  it('keeps self transfers apart from spend', () => {
    expect(cat('IMPS-618200000001-RAVI KUMAR-ICIC-XXXXXXXX9876-IMPS TRANSACTION')).toBe('transfer/Self Transfer');
    expect(cat('RAVI KUMAR MMT/IMPS/618200000001/IMPS transactio/RAVI KUMAR/HDFC Bank', 'credit', 'ICICI-9876')).toBe('transfer/Self Transfer');
    expect(cat('NEFT DR-SBIN0001-SOMEONE-XXXXXX9876', 'debit')).toBe('transfer/Self Transfer');
  });

  it('does not treat salary or company credits with your name as self transfers', () => {
    expect(cat('NEFT CR-CITI0000004-ACME - PAYROLL-RAVI KUMAR-CITIN267 SALARY FOR JUL', 'credit')).toBe('income/Salary');
    expect(cat('NEFT CR-CITI0000004-ACME INDIA PRIVATE LIMITED-RAVI KUMAR-CITIN2669', 'credit')).toBe('income/Uncategorised');
  });

  it('separates credit card bills from spend', () => {
    expect(cat('UPI-INDMONEY CREDIT CARD-INDMONEYCC.BDPG@HDFCBANK-HDFC0MERUPI-618500000002-PAY')).toBe('cc_bill/Credit Card Bill');
    expect(cat('IB BILLPAY DR-HDFC97-361010XXXX1353')).toBe('cc_bill/Credit Card Bill');
    expect(cat('UPI/CRED Club/cred.club@axisb/payment on CRED/AXIS BANK/123')).toBe('cc_bill/Credit Card Bill');
  });

  it('recognises investments both ways', () => {
    expect(cat('MUTUAL FUN UPI/MUTUAL FUN/groww.iccl1.br/Paid Via E/HDFC BANK/619')).toBe('investment/Mutual Funds');
    expect(cat('GROWW INVE UPI/GROWW INVE/groww.payu.brk/UPIIntent/HDFC BANK/655')).toBe('investment/Stocks');
    expect(cat('Credit trxn CMS/ GROWW WITHDRAW REQ RAVI KUMAR/NEXTBILLION TE', 'credit')).toBe('investment/Stocks');
    expect(cat('RTGS trxn RTGS-HDFCR5202607-TMF REDEMPTION POOL A/C-006', 'credit')).toBe('investment/Mutual Funds');
    expect(cat('UPI/MMTC PAMP/mmtcpamp@axisb/UPI/AXIS BANK/619')).toBe('investment/Gold');
    expect(cat('ACH D- ICCL MF SIP-0001234')).toBe('investment/Mutual Funds');
    expect(cat('RFX 200726BTT00068 USD102.43@97.2675')).toBe('investment/US Stocks / Foreign');
  });

  it('categorises merchants and refunds', () => {
    expect(cat('UPI/Swiggy/swiggy@icici/Payment fo/ICICI BANK/618')).toBe('spend/Food & Dining');
    expect(cat('UPI/Netflix/netflix.bdauto/Execution/HDFC BANK/103')).toBe('spend/Subscriptions');
    expect(cat('UPI-CBDT TIN 2 0-CBDTTIN@HDFCBANK-HDFC0MERUPI-619213596268-UPIINTENT')).toBe('spend/Taxes');
    expect(cat('200726BTT00068 DPO2720145616380 CGST')).toBe('spend/Bank Charges');
    expect(cat('UPI-AIRTEL PREPAID RECHARGE-AIRTEL@PAYTM-X-1')).toBe('spend/Mobile & Internet');
    expect(cat('UPI/AMAZON/amazon@apl/refund/AXIS/1', 'credit')).toBe('income/Refund & Cashback');
    expect(cat('NACH trxn ACH/TMPVL DIV 09072026/1601717', 'credit')).toBe('income/Dividend');
  });

  it('tells people from shop QR codes', () => {
    expect(cat('RAJU UPI/RAJU/8920953181@ybl/Sent using/Punjab Nat/3096')).toBe('spend/Payments to People');
    expect(cat('UPI/Some Friend/friend12@oksbi/Payment fr/AXIS/375', 'credit')).toBe('income/Received from People');
    expect(cat('UPI/Corner Shop/paytmqr6vjts5@/Sent using/YES BANK/618')).toBe('spend/Uncategorised');
  });

  it('treats family members as self transfers when configured', () => {
    const withFamily = { ...ctx, settings: { ...ctx.settings, familyNames: ['PRIYA SHARMA'] } };
    expect(cat('UPI-PRIYA SHARMA-PRIYA605@OKHDFCBANK-HDFC0000619-3099-SENT USING PAYTM U')).toBe('spend/Payments to People');
    expect(cat('UPI-PRIYA SHARMA-PRIYA605@OKHDFCBANK-HDFC0000619-3099-SENT USING PAYTM U', 'debit', 'HDFC-1234', withFamily)).toBe('transfer/Self Transfer');
  });

  it('applies learned rules first, per direction', () => {
    const key = extractMerchant('UPI/Corner Shop/paytmqr6vjts5@/Sent using/YES BANK/618').key;
    const learned = { ...ctx, rules: [{ key, kind: 'spend' as const, category: 'Groceries', direction: 'debit' as const, createdAt: 0 }] };
    expect(cat('UPI/Corner Shop/paytmqr999@/Sent using/YES BANK/1', 'debit', 'HDFC-1234', learned)).toBe('spend/Groceries');
    expect(cat('UPI/Corner Shop/paytmqr999@/Sent using/YES BANK/1', 'credit', 'HDFC-1234', learned)).not.toBe('spend/Groceries');
  });
});

describe('extractMerchant', () => {
  it('pulls payee names from HDFC and ICICI narrations', () => {
    expect(extractMerchant('UPI-JAIN TOYS-PAYTM-655@PAYTM-X-1').name).toBe('Jain Toys');
    expect(extractMerchant('JAIN TOYS UPI/JAIN TOYS/paytm-65522971/Sent using/YES').name).toBe('Jain Toys');
    // ICICI truncates names to 10 characters; keys match across banks.
    expect(extractMerchant('UPI-PRIYA SHARMA-PRIYA@OKHDFCBANK-X').key).toBe(extractMerchant('UPI/PRIYA SHAR/priya@o/UPI/HDFC').key);
  });
});

describe('pairTransfers', () => {
  const base = { description: 'x', merchantKey: 'k', merchantName: 'x', importedAt: 0, importId: 'i1', source: 'default' as const };
  it('links money out of one account and into another', () => {
    const txns: Txn[] = [
      { ...base, id: 'a', accountId: 'HDFC-1234', date: '2026-07-01', amount: 5000, direction: 'debit', kind: 'spend', category: 'Uncategorised' },
      { ...base, id: 'b', accountId: 'ICICI-9876', date: '2026-07-02', amount: 5000, direction: 'credit', kind: 'income', category: 'Uncategorised' },
      { ...base, id: 'c', accountId: 'ICICI-9876', date: '2026-07-02', amount: 700, direction: 'credit', kind: 'income', category: 'Received from People' },
      { ...base, id: 'd', accountId: 'HDFC-1234', date: '2026-07-02', amount: 700, direction: 'debit', kind: 'spend', category: 'Payments to People' },
    ];
    pairTransfers(txns);
    expect(txns[0]).toMatchObject({ kind: 'transfer', pairId: 'b' });
    expect(txns[1]).toMatchObject({ kind: 'transfer', pairId: 'a' });
    // Two unrelated payments to/from people with the same amount stay as they are.
    expect(txns[2].kind).toBe('income');
    expect(txns[3].kind).toBe('spend');
  });
});
