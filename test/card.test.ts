import { describe, expect, it } from 'vitest';
import { groupLines, type Page } from '../src/parse/layout';
import { detectCardNumber, isCardStatement, parseCardLayout } from '../src/parse/card';

function page(rows: [number, [number, string][]][]): Page {
  return groupLines(rows.flatMap(([y, items]) => items.map(([x, s]) => ({ x, y, w: s.length * 4.5, s }))));
}

// Made-up statements copying common Indian card layouts (fake people, cards and amounts).
const hdfc = page([
  [780, [[30, 'HDFC Bank Credit Card Statement']]],
  [760, [[30, 'Name : RAVI KUMAR'], [300, 'Card No: 4375 XXXX XXXX 1234']]],
  [740, [[30, 'Payment Due Date'], [200, 'Total Dues'], [330, 'Minimum Amount Due']]],
  [728, [[30, '15/09/2026'], [200, '42,300.00'], [330, '2,120.00']]],
  [690, [[30, 'Date'], [110, 'Transaction Description'], [400, 'Reward Points'], [500, 'Amount (in Rs.)']]],
  [670, [[30, '02/08/2026'], [110, 'SWIGGY BANGALORE'], [410, '12'], [505, '1,234.00']]],
  [655, [[30, '05/08/2026'], [110, 'AMAZON PAY INDIA PRIVATE'], [410, '40'], [505, '4,999.00']]],
  [642, [[110, 'LIMITED MUMBAI']]],
  [627, [[30, '10/08/2026'], [110, 'NETBANKING TRANSFER (Ref# 00000000123)'], [505, '25,000.00'], [555, 'Cr']]],
  [612, [[30, '12/08/2026'], [110, 'FLIPKART REFUND'], [505, '899.00 Cr']]],
  [597, [[30, '14/08/2026'], [110, 'IGST-VPS2600000000-RATE 18.0'], [505, '36.00']]],
  [560, [[30, 'Reward Points Summary']]],
  [545, [[30, '20/08/2026'], [110, 'THIS IS NOT A ROW'], [505, '9.00']]],
]);

const icici = page([
  [780, [[30, 'ICICI Bank Credit Card'], [300, 'Credit Limit'], [400, 'Total Amount due']]],
  [760, [[30, '5241 XXXX XXXX 9876']]],
  [700, [[30, 'Date'], [90, 'SerNo.'], [170, 'Transaction Details'], [380, 'Reward'], [430, 'Intl.# amount'], [510, 'Amount (in`)']]],
  [680, [[30, '03/08/2026'], [90, '10000000001'], [170, 'UBER INDIA SYSTEMS PVT'], [385, '4'], [515, '450.00']]],
  [665, [[30, '06/08/2026'], [90, '10000000002'], [170, 'OPENAI *CHATGPT SUBSCR'], [385, '10'], [430, '20.00 USD'], [515, '1,712.40']]],
  [650, [[30, '11/08/2026'], [90, '10000000003'], [170, 'BBPS Payment received'], [515, '15,000.00 CR']]],
]);

const sbi = page([
  [780, [[30, 'SBI Card'], [300, 'Credit Card Number'], [420, 'XXXX XXXX XXXX 5555']]],
  [765, [[30, 'Total Amount Due'], [200, 'Payment Due Date']]],
  [700, [[30, 'Date'], [120, 'Transaction Details'], [480, 'Amount ( ₹ )']]],
  [680, [[30, '04'], [45, 'Aug'], [65, '26'], [120, 'BIGBASKET BANGALORE'], [485, '2,345.00 D']]],
  [665, [[30, '09'], [45, 'Aug'], [65, '26'], [120, 'PAYMENT RECEIVED 000000000001'], [485, '10,000.00 C']]],
]);

const axis = page([
  [780, [[30, 'Axis Bank Credit Card Statement'], [300, 'Payment Due Date']]],
  [700, [[30, 'DATE'], [110, 'TRANSACTION DETAILS'], [330, 'MERCHANT CATEGORY'], [480, 'AMOUNT (Rs.)']]],
  [680, [[30, '07/08/2026'], [110, 'ZOMATO'], [330, 'FOOD'], [485, '640.00 Dr']]],
  [665, [[30, '08/08/2026'], [110, 'CASHBACK'], [485, '64.00 Cr']]],
]);

describe('credit card statements', () => {
  it('knows a card statement from a bank statement', () => {
    expect(isCardStatement([hdfc])).toBe(true);
    expect(isCardStatement([page([[700, [[30, 'Date'], [100, 'Narration'], [300, 'Withdrawal Amt.'], [400, 'Deposit Amt.'], [500, 'Closing Balance']]]])])).toBe(false);
  });

  it('reads HDFC: reward points column, wrapped details, Cr as its own piece or a suffix, and stops at the summary', () => {
    const r = parseCardLayout([hdfc]);
    expect(r.meta).toMatchObject({ bank: 'HDFC', accountType: 'card', accountNumber: '4375 XXXX XXXX 1234' });
    expect(r.txns.map((t) => [t.date, t.description, t.amount, t.direction])).toEqual([
      ['2026-08-02', 'SWIGGY BANGALORE', 1234, 'debit'],
      ['2026-08-05', 'AMAZON PAY INDIA PRIVATE LIMITED MUMBAI', 4999, 'debit'],
      ['2026-08-10', 'NETBANKING TRANSFER (Ref# 00000000123)', 25000, 'credit'],
      ['2026-08-12', 'FLIPKART REFUND', 899, 'credit'],
      ['2026-08-14', 'IGST-VPS2600000000-RATE 18.0', 36, 'debit'],
    ]);
  });

  it('reads ICICI: serial numbers and a foreign-currency column are left out of the details', () => {
    const r = parseCardLayout([icici]);
    expect(r.meta.accountNumber).toBe('5241 XXXX XXXX 9876');
    expect(r.txns.map((t) => [t.description, t.amount, t.direction])).toEqual([
      ['UBER INDIA SYSTEMS PVT', 450, 'debit'],
      ['OPENAI *CHATGPT SUBSCR', 1712.4, 'debit'],
      ['BBPS Payment received', 15000, 'credit'],
    ]);
  });

  it('reads SBI Card: a date in three pieces and D / C markers', () => {
    const r = parseCardLayout([sbi]);
    expect(r.meta.accountNumber).toBe('XXXX XXXX XXXX 5555');
    expect(r.txns.map((t) => [t.date, t.description, t.amount, t.direction])).toEqual([
      ['2026-08-04', 'BIGBASKET BANGALORE', 2345, 'debit'],
      ['2026-08-09', 'PAYMENT RECEIVED 000000000001', 10000, 'credit'],
    ]);
  });

  it('reads Axis: Dr / Cr markers and a merchant category column', () => {
    const r = parseCardLayout([axis]);
    expect(r.txns.map((t) => [t.description, t.amount, t.direction])).toEqual([['ZOMATO', 640, 'debit'], ['CASHBACK', 64, 'credit']]);
  });

  it('finds masked card numbers in the usual forms', () => {
    expect(detectCardNumber('Card No: 4375XXXXXXXX1234')).toBe('4375XXXXXXXX1234');
    expect(detectCardNumber('card ending xxxx-xxxx-xxxx-4321 ok')).toBe('xxxx-xxxx-xxxx-4321');
  });
});

import { parseRows } from '../src/parse/sheet';
describe('credit card spreadsheets', () => {
  it('reads a card export with one Amount column and Cr on credits', () => {
    const r = parseRows([
      ['HDFC Bank Credit Card Statement'], ['Card No', '4375XXXXXXXX1234'], ['Payment Due Date', '15/09/2026'],
      [], ['Date', 'Transaction Details', 'Amount'],
      ['02/08/2026', 'SWIGGY BANGALORE', '1,234.00'],
      ['10/08/2026', 'PAYMENT RECEIVED', '25,000.00 Cr'],
    ]);
    expect(r.meta).toMatchObject({ accountType: 'card', accountNumber: '4375XXXXXXXX1234' });
    expect(r.txns.map((t) => [t.description, t.amount, t.direction])).toEqual([['SWIGGY BANGALORE', 1234, 'debit'], ['PAYMENT RECEIVED', 25000, 'credit']]);
  });
});
