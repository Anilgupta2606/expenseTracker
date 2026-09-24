const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

const pad = (n: number) => String(n).padStart(2, '0');

function fullYear(y: number): number {
  return y < 100 ? 2000 + y : y;
}

function valid(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** Parses Indian statement dates (day first) into YYYY-MM-DD. */
export function parseDate(input: string): string | null {
  const s = input.trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return valid(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2}|\d{4})$/);
  if (m) return valid(fullYear(+m[3]), +m[2], +m[1]);
  m = s.match(/^(\d{1,2})[\s\-/]([A-Za-z]{3,4})[a-z]*[\s\-/,]+(\d{2}|\d{4})$/);
  if (m && MONTHS[m[2].toLowerCase()]) return valid(fullYear(+m[3]), MONTHS[m[2].toLowerCase()], +m[1]);
  return null;
}

export const AMOUNT_RE = /^-?(?:\d{1,3}(?:,\d{2,3})+|\d+)\.\d{1,2}(?:\s*(?:CR|DR|Cr|Dr))?$/;

export function parseAmount(input: string | number | undefined | null): number | null {
  if (input == null) return null;
  if (typeof input === 'number') return Number.isFinite(input) ? input : null;
  const s = input.replace(/[₹,\s]|INR|Rs\.?/gi, '').replace(/(CR|DR)$/i, '');
  if (!s || !/^-?\d+(\.\d+)?$/.test(s)) return null;
  return parseFloat(s);
}

export const round2 = (n: number) => Math.round(n * 100) / 100;

/** Stable short hash for dedupe ids. */
export function hash(s: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
}

export function detectBank(text: string): string {
  const t = text.toUpperCase();
  const banks: [string, RegExp][] = [
    ['HDFC', /HDFC BANK/],
    ['ICICI', /ICICI BANK|ICICI\.BANK/],
    ['SBI', /STATE BANK OF INDIA|\bSBI\b/],
    ['Axis', /AXIS BANK/],
    ['Kotak', /KOTAK MAHINDRA/],
    ['IDFC', /IDFC FIRST/],
    ['Yes', /YES BANK LIMITED/],
    ['PNB', /PUNJAB NATIONAL BANK/],
    ['BoB', /BANK OF BARODA/],
    ['IndusInd', /INDUSIND/],
    ['AU', /AU SMALL FINANCE/],
    ['Federal', /FEDERAL BANK/],
  ];
  // Prefer the bank named most often: statements mention other banks in narrations.
  let best = 'Unknown', bestCount = 0;
  for (const [name, re] of banks) {
    const count = (t.match(new RegExp(re.source, 'g')) || []).length;
    if (count > bestCount) { best = name; bestCount = count; }
  }
  return best;
}

export function detectAccountNumber(text: string): string | undefined {
  const m = text.match(/(?:account|a\/c|acct)\s*(?:no|number|num)?\.?\s*[:.\-]?\s*([0-9Xx*]{6,20})/i);
  return m ? m[1] : undefined;
}

export function detectHolderName(lines: string[]): string | undefined {
  for (const l of lines.slice(0, 40)) {
    const m = l.match(/^(?:MR|MRS|MS|MISS|DR|SHRI|SMT)\.?\s+([A-Z][A-Z .]{2,40}?)(?:\s{2,}|\s+(?:Account|Address|Cust)|$)/i);
    if (m) return m[1].trim().toUpperCase();
  }
  return undefined;
}
