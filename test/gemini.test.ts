import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkWithGemini, maskRow } from '../src/categorize/gemini';
import { emptyState } from '../src/store';
import type { Txn } from '../src/types';

const txn = (over: Partial<Txn>): Txn => ({
  id: 't1', accountId: 'ICICI-9876', importId: 'imp', date: '2026-08-11', amount: 3400, direction: 'debit',
  description: 'DLF MALL O UPI/DSB HOSPIT/dsbhosp9876543210@icici/Dinner/ICICI BANK/621000000002/RAVI KUMAR',
  kind: 'spend', category: 'Health', source: 'rule', merchantKey: 'DLF MALL O', merchantName: 'Dlf Mall O', importedAt: 0, balance: 5400, ...over,
});

describe('masking before anything is sent', () => {
  it('hides long numbers and your name, and never includes the balance', () => {
    const m = maskRow(txn({}), ['RAVI KUMAR']);
    expect(m.text).not.toMatch(/\d{5,}/);
    expect(m.text).not.toContain('RAVI KUMAR');
    expect(m.text).toContain('SELF');
    expect(JSON.stringify(m)).not.toContain('5400');
    expect(m).toMatchObject({ date: '2026-08-11', amount: 3400, direction: 'debit' });
  });
});

describe('checkWithGemini', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('turns Gemini answers into suggestions and drops invalid ones', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.contents[0].parts[0].text).not.toContain('621000000002');
      const rows = [
        { i: 0, payee: 'DSB Hospitality', kind: 'spend', category: 'Food & Dining', mixed: true, note: 'label says DLF Mall' },
        { i: 1, payee: 'Bad', kind: 'spend', category: 'Mutual Funds', mixed: false, note: '' },
      ];
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ rows }) }] } }] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const settings = { ...emptyState().settings, ownNames: ['RAVI KUMAR'], geminiKey: 'test-key' };
    const out = await checkWithGemini([txn({}), txn({ id: 't2' })], settings);
    expect(out).toEqual([{ id: 't1', payee: 'DSB Hospitality', kind: 'spend', category: 'Food & Dining', mixed: true, note: 'label says DLF Mall' }]);
    expect(String(fetchMock.mock.calls[0][0])).toContain('gemini-2.5-flash:generateContent');
  });

  it('explains common errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('quota', { status: 429 })));
    const settings = { ...emptyState().settings, geminiKey: 'k' };
    await expect(checkWithGemini([txn({})], settings)).rejects.toThrow(/limit/);
    await expect(checkWithGemini([txn({})], emptyState().settings)).rejects.toThrow(/API key in Settings/);
  });
});
