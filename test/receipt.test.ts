import { describe, expect, it, vi } from 'vitest';
import { NoMac, cleanFields, guessFields, macOcr, readReceipt } from '../src/receipt';
import { emptyState } from '../src/store';

const LINES = ['CAFE COFFEE DAY', 'MG Road, Pune', 'GSTIN 27ABCDE1234F1Z5', 'Date: 14/10/26 13:02', 'Cappuccino 180.00', 'Sub Total 180.00', 'CGST 2.5% 4.50', 'Grand Total Rs 212.40', 'Cash 500.00'];
const TODAY = '2026-10-19';

describe('scan receipt', () => {
  it('sends the photo to the Mac\'s /ocr and gets its lines back', async () => {
    const f = vi.fn(async (_u: string, _o?: RequestInit) => new Response(JSON.stringify({ lines: [{ text: 'CAFE' }, { text: ' ' }, { text: 'TOTAL 212.40' }] }), { status: 200 }));
    const lines = await macOcr(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 1, 2])], { type: 'image/jpeg' }), f as unknown as typeof fetch);
    expect(lines).toEqual(['CAFE', 'TOTAL 212.40']);
    expect(f.mock.calls[0][0]).toBe('http://127.0.0.1:8899/ocr');
    expect(JSON.parse(String(f.mock.calls[0][1]!.body)).image).toBe('/9j/AQI=');
  });
  it('the Mac unreachable (or an older helper without /ocr) is told apart from a bad photo', async () => {
    const down = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    await expect(macOcr(new Blob(['x']), down as unknown as typeof fetch)).rejects.toBeInstanceOf(NoMac);
    const old = vi.fn(async () => new Response('{"error":"Not found"}', { status: 404 }));
    await expect(macOcr(new Blob(['x']), old as unknown as typeof fetch)).rejects.toBeInstanceOf(NoMac);
    const bad = vi.fn(async () => new Response('{"error":"Send a picture"}', { status: 400 }));
    await expect(macOcr(new Blob(['x']), bad as unknown as typeof fetch)).rejects.toThrow('Send a picture');
  });
  it('keeps only sensible values from the AI: a real category, a past date, a positive amount', () => {
    expect(cleanFields({ amount: '₹212.40', merchant: '  Cafe  Coffee Day ', date: '2026-10-14', category: 'Food & Dining' }, TODAY))
      .toEqual({ amount: 212.4, merchant: 'Cafe Coffee Day', date: '2026-10-14', category: 'Food & Dining' });
    expect(cleanFields({ amount: -5, merchant: '', date: '2027-01-01', category: 'Coffee' }, TODAY)).toEqual({});
  });
  it('without an AI: the grand total (not the subtotal, tax or cash given), the day-first date and the shop', async () => {
    expect(guessFields(LINES, TODAY)).toEqual({ amount: 212.4, merchant: 'CAFE COFFEE DAY', date: '2026-10-14' });
    const r = await readReceipt(LINES, emptyState().settings, TODAY);
    expect(r.byAi).toBe(false); expect(r.fields.amount).toBe(212.4);
  });
});
