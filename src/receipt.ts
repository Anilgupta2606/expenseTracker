/**
 * SCAN A RECEIPT: the photo's text is read on your Mac (Apple's Vision, the AI helper's POST /ocr — on this Mac or
 * through Tailscale), then your AI picks out the amount, shop, date and category to fill in Add transaction. Nothing
 * is saved until you tap Add. No Mac: a clear message (this app has no in-browser OCR to fall back to).
 */
import type { Settings } from './types';
import { aiSession, hasAi } from './ai/providers';
import { CATEGORIES } from './categorize/categories';

export interface ReceiptFields { amount?: number; merchant?: string; date?: string; category?: string }
export class NoMac extends Error {}

const MAC_URL = 'http://127.0.0.1:8899';
interface MacHub { macUp?: (base?: string, force?: boolean) => Promise<boolean>; macFetch?: (p: string, o?: RequestInit) => Promise<Response> }
const hub = (): MacHub | null => { try { return (globalThis as unknown as { MoneyAI?: MacHub }).MoneyAI ?? null; } catch { return null; } };

/** The picture's text, read on the Mac: lines top to bottom. Throws NoMac when the Mac cannot be reached. */
export async function macOcr(image: Blob, fetchFn: typeof fetch = fetch.bind(globalThis)): Promise<string[]> {
  const h = hub();
  const body = JSON.stringify({ image: await blobToBase64(image) });
  const opts: RequestInit = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body };
  let res: Response;
  try {
    // the shared engine knows where the Mac is from this device (127.0.0.1, or its Tailscale address and sign-in)
    if (h?.macFetch && h.macUp) {
      if (!(await h.macUp())) throw new NoMac('');
      res = await h.macFetch('/ocr', opts);
    } else res = await fetchFn(MAC_URL + '/ocr', opts);
  } catch (e) {
    throw new NoMac(e instanceof NoMac ? '' : (e as Error).message);
  }
  const d = (await res.json().catch(() => ({}))) as { lines?: { text: string }[]; error?: string };
  if (res.status === 404 || res.status === 401 || res.status === 403) throw new NoMac(d.error || `HTTP ${res.status}`);
  if (!res.ok) throw new Error(d.error || `Your Mac could not read the receipt (HTTP ${res.status}).`);
  return (d.lines ?? []).map((l) => String(l.text ?? '').trim()).filter(Boolean);
}

async function blobToBase64(b: Blob): Promise<string> {
  const bytes = new Uint8Array(await b.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const SCHEMA = {
  type: 'object',
  properties: {
    amount: { type: 'number', description: 'the total paid, in rupees' },
    merchant: { type: 'string' },
    date: { type: 'string', description: 'YYYY-MM-DD, or empty' },
    category: { type: 'string', enum: CATEGORIES.spend },
  },
  required: ['amount', 'merchant', 'date', 'category'],
};
const PROMPT = (lines: string[], today: string) => `This is the text of a shop receipt or bill, read from a photo (line by line, top to bottom; the reading may have small mistakes).
Pick out:
- amount: the final total paid (grand total / net amount / total incl. tax), a number without the currency sign. Not a subtotal, tax line, change or tendered amount.
- merchant: the shop or company name as a person would say it (e.g. "Cafe Coffee Day", not the address or GSTIN).
- date: the bill date as YYYY-MM-DD. Indian receipts write dates day first (14/10/26 is 2026-10-14). Today is ${today}; a receipt is never in the future. Empty if there is none.
- category: the best one of: ${CATEGORIES.spend.join(', ')}.
Reply with JSON only.

Receipt text:
${lines.slice(0, 120).join('\n').slice(0, 6000)}`;

/** Keeps only sensible values from the AI's answer (or the built-in guess). */
export function cleanFields(raw: Partial<Record<keyof ReceiptFields, unknown>>, today: string): ReceiptFields {
  const out: ReceiptFields = {};
  const amount = typeof raw.amount === 'number' ? raw.amount : parseFloat(String(raw.amount ?? '').replace(/[^\d.]/g, ''));
  if (amount > 0 && amount < 1e8) out.amount = Math.round(amount * 100) / 100;
  const m = String(raw.merchant ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (m) out.merchant = m;
  const d = String(raw.date ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d)) && d <= today && d >= '2000-01-01') out.date = d;
  const c = String(raw.category ?? '');
  if (CATEGORIES.spend.includes(c)) out.category = c;
  return out;
}

/** Without an AI: the total line's amount, the first date and the first line (usually the shop's name). */
export function guessFields(lines: string[], today: string): ReceiptFields {
  const num = (s: string) => { const all = [...s.matchAll(/(\d{1,3}(?:,\d{2,3})+|\d+)(\.\d{1,2})?/g)].map((x) => parseFloat(x[0].replace(/,/g, ''))); return all.length ? all[all.length - 1] : 0; };
  const totals = lines.filter((l) => /\b(grand\s*total|net\s*(amount|payable)|total\s*(amount|payable|due)?|amount\s*(paid|payable))\b/i.test(l) && !/sub\s*-?\s*total|tax|gst/i.test(l));
  const amount = totals.length ? num(totals[totals.length - 1]) : 0;
  let date = '';
  for (const l of lines) {
    const x = /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b/.exec(l);
    if (x) { const y = x[3].length === 2 ? '20' + x[3] : x[3]; date = `${y}-${x[2].padStart(2, '0')}-${x[1].padStart(2, '0')}`; break; }
  }
  const merchant = lines.find((l) => /[a-z]{3}/i.test(l) && !/invoice|receipt|bill|gstin|tax|date|phone|tel/i.test(l)) ?? '';
  return cleanFields({ amount, date, merchant }, today);
}

/** Lines of a receipt -> the fields for Add transaction: by your AI when there is one, else the built-in guess. */
export async function readReceipt(lines: string[], settings: Settings, today = localToday()): Promise<{ fields: ReceiptFields; byAi: boolean }> {
  if (!lines.length) return { fields: {}, byAi: false };
  if (hasAi(settings)) {
    try {
      const raw = await aiSession(settings).generate<Partial<Record<keyof ReceiptFields, unknown>>>(PROMPT(lines, today), SCHEMA);
      const fields = cleanFields(raw ?? {}, today);
      if (fields.amount || fields.merchant) return { fields, byAi: true };
    } catch { /* the built-in guess below */ }
  }
  return { fields: guessFields(lines, today), byAi: false };
}

export const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/** A phone photo made small enough to send (longest side 2000 px, JPEG). */
export async function shrinkPhoto(file: Blob, maxSide = 2000): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions);
    const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    const b = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', 0.88));
    return b ?? file;
  } catch { return file; }                       // the Mac reads HEIC itself
}
