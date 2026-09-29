import type { SplitPart, Txn } from './types';
import { CATEGORIES } from './categorize/categories';

/** Separates a split transaction's id from its part number in the rows the totals see. */
const SEP = '::';

export const parentId = (id: string) => id.split(SEP)[0];

const paise = (n: number) => Math.round(n * 100);

/**
 * The rows every total works from: a split transaction becomes one row per part, each with its
 * own amount, type and category (everything else - date, account, Counted, tags - is the
 * payment's). Transactions that are not split pass through unchanged.
 */
export function expandSplits(txns: Txn[]): Txn[] {
  const out: Txn[] = [];
  for (const t of txns) {
    if (!t.splits || t.splits.length < 2) { out.push(t); continue; }
    t.splits.forEach((p, i) => out.push({
      ...t, id: `${t.id}${SEP}${i}`, amount: p.amount, kind: p.kind, category: p.category,
      note: p.note ?? t.note, splits: undefined, splitOf: t.id, part: i,
    }));
  }
  return out;
}

/** Why these parts cannot be saved for a payment of `total`, or null when they can. */
export function splitProblem(total: number, parts: SplitPart[]): string | null {
  if (parts.length < 2) return 'A split needs at least two parts.';
  if (parts.some((p) => !(p.amount > 0))) return 'Every part needs an amount above zero.';
  if (parts.some((p) => !CATEGORIES[p.kind]?.includes(p.category))) return 'Pick a category for every part.';
  const left = paise(total) - parts.reduce((a, p) => a + paise(p.amount), 0);
  if (left > 0) return `The parts are ₹${(left / 100).toFixed(2)} short of the total.`;
  if (left < 0) return `The parts are ₹${(-left / 100).toFixed(2)} more than the total.`;
  return null;
}

/** What is left of `total` after these parts (negative = too much). */
export function splitLeft(total: number, parts: { amount: number }[]): number {
  return (paise(total) - parts.reduce((a, p) => a + paise(p.amount || 0), 0)) / 100;
}

/** A tag as stored: trimmed, single spaces, lower case, at most 30 characters, no leading '#'. */
export function normTag(s: string): string {
  return s.trim().replace(/^#+/, '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 30);
}

/** Tags typed as "goa trip, #office" -> ['goa trip', 'office'], without repeats. */
export function parseTags(text: string): string[] {
  return [...new Set(text.split(',').map(normTag).filter(Boolean))];
}

/** Every tag in use, most used first. */
export function allTags(txns: Txn[]): { tag: string; count: number }[] {
  const m = new Map<string, number>();
  for (const t of txns) for (const g of t.tags ?? []) m.set(g, (m.get(g) ?? 0) + 1);
  return [...m.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

export interface TagTotal { tag: string; spent: number; invested: number; moneyIn: number; count: number }

/**
 * Money per tag over these rows (already expanded): spending net of refunds (card bills that
 * count as spending included), money invested, and other money in. Rows not counted are left out.
 */
export function tagTotals(rows: Txn[]): TagTotal[] {
  const m = new Map<string, TagTotal>();
  const seen = new Map<string, Set<string>>();
  for (const t of rows) {
    if (t.excluded || !t.tags?.length) continue;
    for (const tag of t.tags) {
      const e = m.get(tag) ?? { tag, spent: 0, invested: 0, moneyIn: 0, count: 0 };
      const out = t.direction === 'debit';
      if (t.kind === 'spend' || (t.kind === 'cc_bill' && !t.pairId)) e.spent += out ? t.amount : -t.amount;
      else if (t.kind === 'investment') { if (out) e.invested += t.amount; }
      else if (!out && t.kind === 'income') e.moneyIn += t.amount;
      // a split payment is one transaction, however many parts it has
      const ids = seen.get(tag) ?? new Set<string>();
      const id = t.splitOf ?? t.id;
      if (!ids.has(id)) { ids.add(id); e.count += 1; }
      seen.set(tag, ids);
      m.set(tag, e);
    }
  }
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return [...m.values()].map((e) => ({ ...e, spent: r2(e.spent), invested: r2(e.invested), moneyIn: r2(e.moneyIn) }))
    .sort((a, b) => b.spent + b.invested - (a.spent + a.invested) || a.tag.localeCompare(b.tag));
}
