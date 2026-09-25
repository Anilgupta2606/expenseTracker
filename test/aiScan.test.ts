import { afterEach, describe, expect, it, vi } from 'vitest';
import { countMismatches, makeMask, pickReading, scanWithGemini, tableLines } from '../src/parse/aiScan';
import type { Page } from '../src/parse/layout';
import { applyRescan, buildPreview, commitPreview, diffRescan, recategorizeAll } from '../src/importer';
import { emptyState } from '../src/store';
import type { ParsedTxn, ParseResult } from '../src/types';

const line = (y: number, ...cells: [number, string][]) => ({ y, items: cells.map(([x, s]) => ({ x, w: 10, s })) });

const page: Page = [
  line(800, [40, 'ANIL GUPTA'], [300, 'Your Base Branch: ICICI BANK LIMITED']),
  line(790, [40, 'Statement of Transactions in Saving Account no. 055801624441']),
  line(700, [40, 'Date'], [100, 'Transaction Remarks'], [300, 'Withdrawal'], [360, 'Deposit'], [420, 'Balance']),
  line(690, [100, 'DLF MALL O']),
  line(680, [40, '11.08.2026'], [300, '3400.00'], [420, '5400.00']),
  line(670, [100, 'UPI/DSB HOSPIT/dsbhosp9876543210@icici/Dinner/ANIL GUPTA/621000000002']),
];

describe('what the AI reader sends', () => {
  it('drops everything above the transactions table', () => {
    const t = tableLines([page])!;
    expect(t[0][0]).toMatch(/^Date/);
    expect(t.flat().join('\n')).not.toContain('055801624441');
    expect(t.flat().join('\n')).not.toContain('Base Branch');
  });

  it('gives up when there is no table', () => {
    expect(tableLines([[line(800, [40, 'Hello'])]])).toBeNull();
  });

  it('masks long numbers, emails and names, and restores them exactly', () => {
    const m = makeMask(['ANIL GUPTA']);
    const text = 'UPI/DSB HOSPIT/dsbhosp9876543210@icici/Dinner/ANIL GUPTA/621000000002 anil.g@gmail.com Anil Gupt';
    const hidden = m.hide(text);
    expect(hidden).not.toMatch(/\d{9,}/);
    expect(hidden).not.toMatch(/anil/i);
    expect(hidden).not.toContain('gmail');
    expect(m.restore(hidden)).toBe(text);
  });

  it('keeps amounts and balances', () => {
    expect(makeMask([]).hide('11.08.2026 | 3400.00 | 5,400.00 | 12345678.90')).toBe('11.08.2026 | 3400.00 | 5,400.00 | 12345678.90');
  });
});

describe('reading with Gemini', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads rows, restores masked text and keeps the AI payee and category as hints', async () => {
    let sent = '';
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body)).contents[0].parts[0].text;
      const tokenRef = sent.match(/621000000002|\[#\d+\]/g)!.pop();
      const rows = [{ date: '2026-08-11', description: `DLF MALL O UPI/DSB HOSPIT/x/Dinner/[@1]/${tokenRef}`, amount: 3400, direction: 'debit', balance: 5400, payee: 'DSB Hospitality', kind: 'spend', category: 'Food & Dining' }];
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ rows }) }] } }] }), { status: 200 });
    }));
    const out = await scanWithGemini([page], { ...emptyState().settings, geminiKey: 'k', ownNames: ['ANIL GUPTA'] }, 'ANIL GUPTA', undefined, 0);
    expect(sent).not.toContain('621000000002');
    expect(sent).not.toContain('ANIL GUPTA');
    expect(sent).not.toContain('055801624441');
    expect(out).toEqual([{
      date: '2026-08-11', description: 'DLF MALL O UPI/DSB HOSPIT/x/Dinner/ANIL GUPTA/621000000002', amount: 3400, direction: 'debit', balance: 5400,
      hint: { payee: 'DSB Hospitality', kind: 'spend', category: 'Food & Dining' },
    }]);
  });
});

const row = (date: string, amount: number, direction: 'debit' | 'credit', balance: number, description = 'X'): ParsedTxn => ({ date, amount, direction, balance, description });
const local = (txns: ParsedTxn[], balanceMismatches = countMismatches(txns)): ParseResult => ({ meta: { bank: 'ICICI', accountNumber: '055801624441' }, txns, balanceMismatches, warnings: [] });

describe('choosing between the AI and on-device readings', () => {
  const good = [row('2026-08-01', 100, 'debit', 900), row('2026-08-02', 50, 'credit', 950), row('2026-08-03', 25, 'debit', 925)];

  it('keeps the on-device reading while it adds up', () => {
    const r = pickReading(local(good), good.map((t) => ({ ...t, description: 'AI' })));
    expect(r.reader).toBe('local');
    expect(r.txns[0].description).toBe('X');
  });

  it('keeps the on-device reading when the AI reading breaks the balance', () => {
    const broken = [good[0], { ...good[1], amount: 60 }, good[2]];
    const r = pickReading(local(good), broken);
    expect(r.reader).toBe('local');
    expect(r.warnings.join()).toMatch(/didn't add up/);
  });

  it('keeps the on-device reading when the AI misses rows', () => {
    expect(pickReading(local(good), good.slice(0, 2)).reader).toBe('local');
  });

  it('prefers the AI when the on-device reading has gaps', () => {
    expect(pickReading(local(good.slice(0, 2), 1), good).reader).toBe('ai');
  });

  it('falls back and says why when the AI fails', () => {
    const r = pickReading(local(good), null, 'busy');
    expect(r.reader).toBe('local');
    expect(r.warnings.join()).toMatch(/busy/);
  });
});

describe('titles', () => {
  const hinted: ParseResult = {
    ...local([
      { ...row('2026-08-11', 3400, 'debit', 5400, 'DLF MALL O UPI/DSB HOSPIT/dsbhosp@icici/Dinner'), hint: { payee: 'DSB Hospitality', kind: 'spend', category: 'Food & Dining' } },
      { ...row('2026-08-12', 500, 'debit', 4900, 'UPI/SWIGGY/swiggy@icici/food'), hint: { payee: 'Swiggy Instamart', kind: 'spend', category: 'Groceries' } },
    ]),
    reader: 'ai',
  };

  it('takes the AI payee as the title, and its category where the app only guessed', () => {
    const s = commitPreview(emptyState(), buildPreview(hinted, emptyState(), 'aug.pdf'));
    const dsb = s.txns.find((t) => t.amount === 3400)!;
    expect(dsb).toMatchObject({ merchantName: 'DSB Hospitality', titleSet: 'ai', category: 'Food & Dining' });
    // A merchant-name rule gives way to the AI, which read the whole narration.
    const sw = s.txns.find((t) => t.amount === 500)!;
    expect(sw).toMatchObject({ merchantName: 'Swiggy Instamart', category: 'Groceries', source: 'ai' });
    expect(s.imports[0].reader).toBe('ai');
  });

  it('keeps AI and hand-typed titles when everything is re-categorised', () => {
    let s = commitPreview(emptyState(), buildPreview(hinted, emptyState(), 'aug.pdf'));
    s = { ...s, txns: s.txns.map((t) => (t.amount === 500 ? { ...t, merchantName: 'Groceries run', titleSet: 'manual' as const } : t)) };
    s = recategorizeAll(s);
    expect(s.txns.find((t) => t.amount === 3400)!.merchantName).toBe('DSB Hospitality');
    expect(s.txns.find((t) => t.amount === 500)!.merchantName).toBe('Groceries run');
  });

  it('uses a title you gave a payee for its future transactions', () => {
    const plain: ParseResult = local([row('2026-08-12', 500, 'debit', 4900, 'UPI/RAKESH JAI/paytmqr@paytm/x')]);
    let s = commitPreview(emptyState(), buildPreview(plain, emptyState(), 'a.pdf'));
    const key = s.txns[0].merchantKey;
    s = { ...s, rules: [{ key, kind: 'spend', category: 'Groceries', direction: 'debit', title: 'Rakesh Kirana', createdAt: 0 }] };
    const next = buildPreview(local([row('2026-08-20', 80, 'debit', 4820, 'UPI/RAKESH JAI/paytmqr@paytm/y')]), s, 'b.pdf');
    expect(next.fresh[0]).toMatchObject({ merchantName: 'Rakesh Kirana', titleSet: 'manual', category: 'Groceries' });
  });

  it('a rescan read by the AI fixes titles but not the ones you typed', () => {
    const plain = { ...hinted, txns: hinted.txns.map(({ hint: _h, ...t }) => ({ ...t, description: `WRONG ${t.description}` })), reader: 'local' as const };
    let s = commitPreview(emptyState(), buildPreview(plain, emptyState(), 'aug.pdf'));
    s = { ...s, txns: s.txns.map((t) => (t.amount === 500 ? { ...t, merchantName: 'Mine', titleSet: 'manual' as const } : t)) };
    const id = s.imports[0].id;
    const next = applyRescan(s, id, diffRescan(s, id, hinted));
    expect(next.txns.find((t) => t.amount === 3400)!.merchantName).toBe('DSB Hospitality');
    expect(next.txns.find((t) => t.amount === 500)!.merchantName).toBe('Mine');
    expect(next.imports[0].reader).toBe('ai');
  });
});

it('sure rules beat the AI (a mutual fund SIP stays an investment)', () => {
  const r: ParseResult = { ...local([{ ...row('2026-08-05', 5000, 'debit', 1000, 'ACH D- INDIAN CLEARING CORP-GROWW MF SIP'), hint: { payee: 'Groww', kind: 'spend', category: 'Shopping' } }]), reader: 'ai' };
  const t = buildPreview(r, emptyState(), 'a.pdf').fresh[0];
  expect(t.kind).toBe('investment');
  expect(t.merchantName).toBe('Groww');
});

it('ignores placeholder titles from the AI', () => {
  const r: ParseResult = local([{ ...row('2026-08-05', 560, 'credit', 1560, '00600310040071-2023038741149'), hint: { payee: 'Uncategorised', kind: 'income', category: 'Uncategorised' } }]);
  expect(buildPreview(r, emptyState(), 'a.pdf').fresh[0].titleSet).toBeUndefined();
  const self: ParseResult = local([{ ...row('2026-08-05', 20000, 'credit', 21560, 'MMT/IMPS/618240529098/ANIL GUPTA/HDFC Bank'), hint: { payee: 'SELF', kind: 'transfer', category: 'Self Transfer' } }]);
  expect(buildPreview(self, emptyState(), 'a.pdf').fresh[0].merchantName).not.toBe('SELF');
});
