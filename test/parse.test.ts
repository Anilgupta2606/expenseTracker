import { describe, expect, it } from 'vitest';
import { groupLines, parseLayout, type Page } from '../src/parse/layout';
import { parseRows } from '../src/parse/sheet';
import { parseDate } from '../src/parse/util';

/** Builds a page from [y, [x, text][]] rows, the way pdf.js reports them. */
function page(rows: [number, [number, string][]][]): Page {
  return groupLines(rows.flatMap(([y, items]) => items.map(([x, s]) => ({ x, y, w: s.length * 4.5, s }))));
}

// Synthetic statements that copy the HDFC and ICICI layouts (fake people and numbers).
const hdfcHeader: [number, [number, string][]][] = [
  [745, [[34, 'MR'], [58, 'RAVI KUMAR']]],
  [687, [[340, 'Account No'], [397, ': 50100000001234']]],
  [700, [[28, 'HDFC BANK LIMITED']]],
  [602, [[40, 'Date'], [144, 'Narration'], [284, 'Chq./Ref.No.'], [362, 'Value Dt'], [405, 'Withdrawal Amt.'], [491, 'Deposit Amt.'], [564, 'Closing Balance']]],
];

const hdfcPage1 = page([
  ...hdfcHeader,
  [584, [[34, '01/07/26'], [72, 'IMPS-618200000001-RAVI KUMAR-ICIC-XXXXXX'], [289, '0000618200000001'], [362, '01/07/26'], [438, '20,000.00'], [591, '80,000.00']]],
  [567, [[72, 'XX9876-IMPS TRANSACTION']]],
  [550, [[34, '04/07/26'], [72, 'UPI-INDMONEY CREDIT'], [289, '0000618500000002'], [362, '04/07/26'], [438, '5,000.00'], [591, '75,000.00']]],
  [533, [[68, 'CARD-INDMONEYCC.BDPG']]],
  [516, [[72, '@HDFCBANK-HDFC0MERUPI-618500000002-PAY']]],
  [50, [[28, 'HDFC BANK LIMITED']]],
]);

const hdfcPage2 = page([
  [620, [[34, 'From : 01/07/2026'], [340, 'Statement of account']]],
  [587, [[34, '31/07/26'], [72, 'NEFT CR-CITI0000004-ACME PAYROLL'], [287, 'CITIN26700000003'], [362, '31/07/26'], [512, '1,00,000.00'], [591, '1,75,000.00']]],
  [570, [[72, '-RAVI KUMAR SALARY JUL 2026']]],
  [346, [[68, 'STATEMENT SUMMARY :-']]],
  [336, [[132, 'Opening Balance'], [290, 'Dr Count'], [361, 'Cr Count'], [425, 'Debits'], [501, 'Credits'], [572, 'Closing Bal']]],
  [325, [[144, '1,00,000.00'], [302, '2'], [375, '1'], [418, '25,000.00'], [496, '1,00,000.00'], [574, '1,75,000.00']]],
]);

const icici = page([
  [737, [[74, 'Statement of Transactions in Saving Account no. 000000009876 in INR']]],
  [705, [[20, 'RAVI KUMAR'], [400, 'Your Base Branch: ICICI BANK LIMITED,']]],
  [619, [[60, 'Transaction'], [399, 'Withdrawal'], [474, 'Deposit'], [532, 'Balance']]],
  [614, [[24, 'S No.'], [122, 'Cheque Number'], [247, 'Transaction Remarks']]],
  [609, [[74, 'Date'], [396, 'Amount (INR)'], [462, 'Amount (INR)'], [538, '(INR)']]],
  [594, [[192, 'RAVI KUMAR']]],
  [589, [[30, '1'], [61, '01.07.2026'], [484, '20000.00'], [536, '25000.00']]],
  [584, [[192, 'MMT/IMPS/618200000001/IMPS transactio/RAVI']]],
  [574, [[192, 'KUMAR/HDFC Bank']]],
  [564, [[192, 'Swiggy']]],
  [559, [[30, '2'], [61, '02.07.2026'], [427, '450.00'], [536, '24550.00']]],
  [554, [[192, 'UPI/Swiggy/swiggy@icici/Payment fo/ICICI']]],
  [544, [[192, 'BANK/618300000009/ICI000']]],
  [64, [[230, 'www.icici.bank.in']]],
]);

describe('parseDate', () => {
  it('reads Indian day-first formats', () => {
    expect(parseDate('01/07/26')).toBe('2026-07-01');
    expect(parseDate('31.07.2026')).toBe('2026-07-31');
    expect(parseDate('05-Aug-2026')).toBe('2026-08-05');
    expect(parseDate('5 Aug 2026')).toBe('2026-08-05');
    expect(parseDate('2026-07-31')).toBe('2026-07-31');
    expect(parseDate('32/07/26')).toBeNull();
  });
});

describe('parseLayout (HDFC style)', () => {
  const r = parseLayout([hdfcPage1, hdfcPage2]);

  it('reads metadata', () => {
    expect(r.meta).toMatchObject({ bank: 'HDFC', accountNumber: '50100000001234', holderName: 'RAVI KUMAR' });
  });

  it('reads every row across pages, ignoring the summary table', () => {
    expect(r.txns.map((t) => [t.date, t.direction, t.amount])).toEqual([
      ['2026-07-01', 'debit', 20000],
      ['2026-07-04', 'debit', 5000],
      ['2026-07-31', 'credit', 100000],
    ]);
    expect(r.balanceMismatches).toBe(0);
  });

  it('joins wrapped narrations the way HDFC splits them', () => {
    expect(r.txns[0].description).toBe('IMPS-618200000001-RAVI KUMAR-ICIC-XXXXXXXX9876-IMPS TRANSACTION');
    expect(r.txns[1].description).toBe('UPI-INDMONEY CREDIT CARD-INDMONEYCC.BDPG@HDFCBANK-HDFC0MERUPI-618500000002-PAY');
    expect(r.txns[2].description).toContain('SALARY JUL 2026');
    expect(r.txns[2].ref).toBe('CITIN26700000003');
  });
});

describe('parseLayout (ICICI style)', () => {
  const r = parseLayout([icici]);

  it('reads metadata', () => {
    expect(r.meta).toMatchObject({ bank: 'ICICI', accountNumber: '000000009876', holderName: 'RAVI KUMAR' });
  });

  it('attaches remarks printed above and below the date line', () => {
    expect(r.txns).toHaveLength(2);
    expect(r.txns[0]).toMatchObject({ direction: 'credit', amount: 20000, balance: 25000 });
    expect(r.txns[0].description).toBe('RAVI KUMAR MMT/IMPS/618200000001/IMPS transactio/RAVI KUMAR/HDFC Bank');
    expect(r.txns[1].description.startsWith('Swiggy UPI/Swiggy/swiggy@icici')).toBe(true);
    expect(r.txns[1].description).not.toContain('www.icici');
  });
});

describe('parseLayout (ICICI, long remarks centred on the date)', () => {
  // Row 2's remark is long, so two of its lines sit above its date line.
  const page2 = page([
    [619, [[60, 'Transaction'], [399, 'Withdrawal'], [474, 'Deposit'], [532, 'Balance']]],
    [614, [[24, 'S No.'], [247, 'Transaction Remarks']]],
    [609, [[74, 'Date'], [396, 'Amount (INR)'], [462, 'Amount (INR)'], [538, '(INR)']]],
    [594, [[192, 'DLF MALL O']]],
    [589, [[30, '1'], [61, '10.08.2026'], [427, '1200.00'], [536, '8800.00']]],
    [584, [[192, 'UPI/DLF MALL O/dlfmall@ybl/Parking/YES']]],
    [574, [[192, 'BANK/621000000001/PTM0001']]],
    [564, [[192, 'DSB HOSPIT']]],
    [554, [[192, 'UPI/DSB HOSPIT/dsbhosp@icici/Dinner/ICICI']]],
    [549, [[30, '2'], [61, '11.08.2026'], [427, '3400.00'], [536, '5400.00']]],
    [544, [[192, 'BANK/621000000002/ICI0002/']]],
    [534, [[192, 'LTD/extra remark line one']]],
    [524, [[192, 'extra remark line two']]],
    [514, [[192, 'RAMA MEDIC']]],
    [509, [[30, '3'], [61, '12.08.2026'], [432, '26.00'], [536, '5374.00']]],
    [504, [[192, 'UPI/RAMA MEDIC/mab.0372150297/Sent']]],
  ]);
  it('gives every row its own description', () => {
    const r = parseLayout([page2]);
    expect(r.txns.map((t) => [t.amount, t.description.split(' UPI/')[0]])).toEqual([
      [1200, 'DLF MALL O'],
      [3400, 'DSB HOSPIT'],
      [26, 'RAMA MEDIC'],
    ]);
    expect(r.txns[1].description).toContain('extra remark line two');
    expect(r.txns[0].description).not.toContain('DSB');
  });
});

describe('parseRows (Excel/CSV)', () => {
  it('reads withdrawal/deposit columns', () => {
    const r = parseRows([
      ['HDFC BANK Ltd.'],
      ['Account No : 50100000001234'],
      ['Date', 'Narration', 'Chq./Ref.No.', 'Value Dt', 'Withdrawal Amt.', 'Deposit Amt.', 'Closing Balance'],
      ['********', '********'],
      ['01/07/26', 'UPI-ZOMATO-ZOMATO@HDFCBANK', '0001', '01/07/26', 350, null, 9650],
      ['02/07/26', 'NEFT CR-ACME-SALARY', '0002', '02/07/26', null, '50,000.00', '59,650.00'],
    ]);
    expect(r.meta.bank).toBe('HDFC');
    expect(r.txns.map((t) => [t.date, t.direction, t.amount])).toEqual([
      ['2026-07-01', 'debit', 350],
      ['2026-07-02', 'credit', 50000],
    ]);
    expect(r.balanceMismatches).toBe(0);
  });

  it('reads a single amount column with Dr/Cr', () => {
    const r = parseRows([
      ['Txn Date', 'Value Date', 'Description', 'Amount', 'Dr/Cr', 'Balance'],
      [new Date(2026, 6, 3), new Date(2026, 6, 3), 'ATM WDL', '2000', 'DR', '8000'],
      [new Date(2026, 6, 4), new Date(2026, 6, 4), 'INT PD', '12.5', 'CR', '8012.5'],
    ]);
    expect(r.txns.map((t) => [t.date, t.direction, t.amount])).toEqual([
      ['2026-07-03', 'debit', 2000],
      ['2026-07-04', 'credit', 12.5],
    ]);
  });
});
