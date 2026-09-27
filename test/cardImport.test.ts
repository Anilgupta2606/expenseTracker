import { describe, expect, it } from 'vitest';
import { buildPreview, commitPreview, recategorizeAll } from '../src/importer';
import { emptyState } from '../src/store';
import { actualsFor } from '../src/plans';
import type { ParseResult } from '../src/types';

const bank: ParseResult = { meta: { bank: 'HDFC', accountNumber: '50100000001234', holderName: 'RAVI KUMAR' }, balanceMismatches: 0, warnings: [], txns: [
  { date: '2026-08-08', description: 'CC 4375XXXXXXXX1234 AUTOPAY SI-TAD', amount: 25000, direction: 'debit', balance: 75000 },
  { date: '2026-08-09', description: 'IB BILLPAY DR-HDFCC5-524100XXXXXX9999', amount: 3000, direction: 'debit', balance: 72000 },   // another card, not imported
  { date: '2026-08-12', description: 'UPI-SWIGGY-SWIGGY@ICICI-X-1', amount: 300, direction: 'debit', balance: 71700 },
] };
const card: ParseResult = { meta: { bank: 'HDFC', accountNumber: '4375 XXXX XXXX 1234', holderName: 'RAVI KUMAR', accountType: 'card' }, balanceMismatches: 0, warnings: [], txns: [
  { date: '2026-08-02', description: 'SWIGGY BANGALORE', amount: 1200, direction: 'debit' },
  { date: '2026-08-05', description: 'AMAZON PAY INDIA', amount: 5000, direction: 'debit' },
  { date: '2026-08-06', description: 'AMAZON PAY INDIA REFUND', amount: 1000, direction: 'credit' },
  { date: '2026-08-10', description: 'NETBANKING TRANSFER (Ref# 00000000123)', amount: 25000, direction: 'credit' },
  { date: '2026-08-14', description: 'IGST-VPS2600000000-RATE 18.0', amount: 36, direction: 'debit' },
  { date: '2026-08-15', description: 'CASHBACK CREDIT', amount: 150, direction: 'credit' },
] };

describe('credit card statements, imported', () => {
  const st0 = emptyState();
  const withBank = commitPreview(st0, buildPreview(bank, st0, 'bank.pdf'));
  const preview = buildPreview(card, withBank, 'card.pdf');
  const st = commitPreview(withBank, preview);
  const cardRows = st.txns.filter((t) => t.accountId === preview.account.id);

  it('makes the card its own account, never the bank account with the same last digits', () => {
    expect(preview.isNewAccount).toBe(true);
    expect(preview.account).toMatchObject({ id: 'HDFC-CC-1234', type: 'card' });
    expect(st.accounts.map((a) => a.id).sort()).toEqual(['HDFC-1234', 'HDFC-CC-1234']);
  });

  it('reads purchases, a refund, fees, cashback and the bill payment for what they are', () => {
    const by = (d: string) => cardRows.find((t) => t.description.startsWith(d))!;
    expect(by('SWIGGY').kind).toBe('spend');
    expect(by('AMAZON PAY INDIA REFUND')).toMatchObject({ kind: 'spend', direction: 'credit' });
    expect(by('IGST')).toMatchObject({ kind: 'spend', category: 'Bank Charges' });
    expect(by('CASHBACK')).toMatchObject({ kind: 'income', category: 'Refund & Cashback' });
    expect(by('NETBANKING')).toMatchObject({ kind: 'cc_bill', category: 'Credit Card Bill' });
  });

  it('pairs the bank payment with the card and stops counting it twice', () => {
    const bill = st.txns.find((t) => t.amount === 25000 && t.direction === 'debit')!;
    const pay = st.txns.find((t) => t.amount === 25000 && t.direction === 'credit')!;
    expect(bill.kind).toBe('cc_bill');
    expect(bill.pairId).toBe(pay.id);
    const a = actualsFor(st.txns.filter((t) => t.date.startsWith('2026-08')));
    // card purchases 1200 + 5000 + 36 - refund 1000, bank Swiggy 300, the other card's bill 3000 (its card isn't imported)
    expect(a.spend).toBe(1200 + 5000 + 36 - 1000 + 300 + 3000);
    expect(a.cardCovered).toBe(25000);
    expect(a.cardBills).toBe(3000);
  });

  it('keeps it that way when everything is re-categorised, and a second upload adds nothing', () => {
    const again = recategorizeAll(st);
    expect(again.txns.find((t) => t.amount === 25000 && t.direction === 'debit')!.pairId).toBeTruthy();
    expect(actualsFor(again.txns).spend).toBe(actualsFor(st.txns).spend);
    const dup = buildPreview(card, st, 'card-again.pdf');
    expect(dup.fresh.length).toBe(0);
    expect(dup.duplicates).toBe(card.txns.length);
  });

  it('without the card statement, the bill still counts as spending (as before)', () => {
    const a = actualsFor(withBank.txns);
    expect(a.spend).toBe(25000 + 3000 + 300);
  });
});
