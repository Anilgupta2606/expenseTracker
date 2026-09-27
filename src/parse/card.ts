import type { Direction, ParsedTxn, ParseResult } from '../types';
import type { Line, Page } from './layout';
import { detectBank, detectHolderName, parseDate, round2 } from './util';

/**
 * Credit card statements. Unlike a bank statement they have no running balance and one
 * amount column, where payments and refunds are marked as credits ("Cr", "CR", "C", a
 * leading "+" or "-", depending on the bank). Laid out as: date, details, sometimes a
 * reward-points or foreign-currency column, then the amount in rupees.
 */

const text = (l: Line) => l.items.map((i) => i.s).join(' ').replace(/\s+/g, ' ').trim();

/** A card statement: says "credit card" and has the card-bill vocabulary. */
export function isCardStatement(pages: Page[]): boolean {
  const t = pages.slice(0, 2).flat().map(text).join('\n');
  return /credit\s*card/i.test(t) && /(total|minimum)\s+(amount\s+)?due|payment\s+due\s+date|credit\s+limit/i.test(t);
}

/** The card number as printed (masked), e.g. "4375 XXXX XXXX 1234". */
export function detectCardNumber(t: string): string | undefined {
  const m = t.match(/\b(\d{4}[\s-]?(?:[X*x•]{4}[\s-]?){2}\d{4})\b/)
    ?? t.match(/\b(\d{4,6}[X*x•]{4,8}\d{4})\b/)
    ?? t.match(/\b((?:[X*x•]{4}[\s-]?){3}\d{4})\b/)
    ?? t.match(/card\s*(?:no|number)\.?\s*[:.]?\s*([0-9X*x•\s-]{8,24}\d{4})/i);
  return m ? m[1].replace(/\s+/g, ' ').trim() : undefined;
}

// the amount at the end of a row: "1,234.00", "1,234.00 Cr", "+ 1,234.00", "₹ 1,234.00 C", "-1,234.00"
const AMOUNT_TAIL = /(?:^|\s)([+-])?\s*(?:₹|Rs\.?|INR)?\s*((?:\d{1,3}(?:,\d{2,3})+|\d+)\.\d{2})\s*(Cr|CR|cr|C|Dr|DR|dr|D)?\s*$/;
const TIME = /^\d{1,2}:\d{2}(?::\d{2})?$/;
const STOP = /^(total\b|minimum amount|reward points? summary|important|end of statement|page \d+ of \d+|\*+\s*end)/i;
const SKIP = /opening balance|previous (balance|statement)|closing balance|^balance\b/i;

interface Cols { amountX: number; cutX: number }

/** The table header: a date column and an amount column, with details between. */
function header(l: Line): Cols | null {
  const t = text(l);
  if (!/\bdate\b/i.test(t) || !/amount/i.test(t) || !/transaction|details|description|particulars|merchant|narration/i.test(t)) return null;
  const amt = l.items.filter((i) => /amount/i.test(i.s));
  const amountX = Math.max(...amt.map((i) => i.x));
  // reward points or a foreign-currency amount sit between the details and the rupee amount
  const extra = l.items.filter((i) => i.x < amountX - 5 && /reward|points|intl|foreign|forex|currency|usd|\bref|category/i.test(i.s));
  return { amountX, cutX: extra.length ? Math.min(...extra.map((i) => i.x)) : amountX };
}

/** Date at the start of the line: one piece ("12/08/2026") or up to three ("12 Aug 2026"). -> [date, pieces used] */
function leadingDate(l: Line): [string, number] | null {
  for (let n = 3; n >= 1; n--) {
    if (l.items.length < n) continue;
    const d = parseDate(l.items.slice(0, n).map((i) => i.s).join(' '));
    if (d) return [d, n];
  }
  // "12/08/2026 14:32" in one piece
  const one = l.items[0]?.s.split(/\s+/)[0] ?? '';
  const d = parseDate(one);
  return d ? [d, 1] : null;
}

export function parseCardLayout(pages: Page[]): ParseResult {
  const all = pages.flat().map(text);
  const joined = all.join('\n');
  const bank = detectBank(joined, all.slice(0, 30).join('\n'));
  const txns: ParsedTxn[] = [];
  const warnings: string[] = [];
  let cols: Cols | null = null;
  for (const page of pages) {
    let last: ParsedTxn | null = null;
    let stopped = false;
    for (const l of page) {
      const h = header(l);
      if (h) { cols = h; last = null; stopped = false; continue; }
      if (!cols || stopped) continue;
      const t = text(l);
      if (STOP.test(t)) { stopped = true; last = null; continue; }
      const lead = leadingDate(l);
      const right = l.items.filter((i) => i.x >= cols!.amountX - 45);
      const amt = right.length ? right.map((i) => i.s).join(' ').match(AMOUNT_TAIL) : null;
      if (lead && amt) {
        const [date, used] = lead;
        const desc = l.items.slice(used).filter((i) => i.x < cols!.cutX - 5 && !TIME.test(i.s) && !(i.x >= cols!.amountX - 45))
          .map((i) => i.s).join(' ').replace(/\s+/g, ' ').trim()
          .replace(/^\d{8,}\s+/, '');                 // a serial / reference number column before the details
        if (!desc || SKIP.test(desc)) { last = null; continue; }
        const [, sign, num, mark] = amt;
        const credit = sign === '+' || sign === '-' || /^c/i.test(mark ?? '');
        const amount = round2(parseFloat(num.replace(/,/g, '')));
        if (!(amount > 0)) continue;
        last = { date, description: desc, amount, direction: (credit ? 'credit' : 'debit') as Direction };
        txns.push(last);
      } else if (!lead && !amt && last) {
        // a wrapped line of the details
        const more = l.items.filter((i) => i.x < cols!.cutX - 5).map((i) => i.s).join(' ').trim();
        if (more && more.length < 80) last.description = `${last.description} ${more}`;
        else last = null;
      } else {
        last = null;
      }
    }
  }
  if (!cols) warnings.push('Could not find the card transactions table (a Date … Amount header).');
  else if (!txns.length) warnings.push('No transactions found in this card statement.');
  return {
    meta: { bank, holderName: detectHolderName(all), accountNumber: detectCardNumber(joined), accountType: 'card' },
    txns, balanceMismatches: 0, warnings,
  };
}

/** A payment towards the card bill (as opposed to a refund or cashback). */
export const CARD_PAYMENT = /payment\s*(received|recd|-|thank)|thank\s*you|bbps|auto\s*-?\s*debit|autopay|\bneft\b|\bimps\b|netbanking|net banking|upi.*(payment|pay)|payment\s+from|cred\b|pay\s*zapp|billdesk/i;
