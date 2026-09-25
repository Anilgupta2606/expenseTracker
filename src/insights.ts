import type { Txn } from './types';

/** Month-end review, recurring payments and unpaired transfers, worked out from the rows alone. */

const DAY = 86400000;
const MANUAL = 'MANUAL';

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function prevMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

const isSpend = (t: Txn) => (t.kind === 'spend' || t.kind === 'cc_bill') && t.direction === 'debit' && !t.excluded;

export interface UnusualSpend {
  txn: Txn;
  /** Plain-language reason, e.g. "3× the usual ₹450" or "New payee". */
  reason: string;
}

/**
 * Payments this month that stand out: well above what the same payee usually
 * costs, or a large first payment to someone new.
 */
export function unusualSpends(txns: Txn[], month: string, limit = 5): UnusualSpend[] {
  const before = txns.filter((t) => isSpend(t) && t.date < `${month}-01`);
  const byPayee = new Map<string, number[]>();
  for (const t of before) byPayee.set(t.merchantKey, [...(byPayee.get(t.merchantKey) ?? []), t.amount]);
  // "Large" for a new payee: well above a typical payment over the previous three months.
  const from = prevMonth(prevMonth(prevMonth(month)));
  const recent = before.filter((t) => t.date >= `${from}-01`).map((t) => t.amount);
  const bigNew = Math.max(5000, 3 * median(recent));
  const out: UnusualSpend[] = [];
  for (const t of txns.filter((x) => isSpend(x) && x.date.startsWith(month))) {
    const past = byPayee.get(t.merchantKey) ?? [];
    if (past.length >= 2) {
      const usual = median(past);
      if (t.amount >= 1000 && t.amount >= 2 * usual) out.push({ txn: t, reason: `${(t.amount / usual).toFixed(1).replace(/\.0$/, '')}× the usual ₹${Math.round(usual).toLocaleString('en-IN')}` });
    } else if (!past.length && before.length && t.amount >= bigNew) {
      out.push({ txn: t, reason: 'New payee' });
    }
  }
  return out.sort((a, b) => b.txn.amount - a.txn.amount).slice(0, limit);
}

export interface CategoryShift {
  category: string;
  now: number;
  /** Average of the previous months that had any spending (up to three). */
  usual: number;
  delta: number;
}

/** Spending categories that moved most against their recent average. */
export function categoryShifts(txns: Txn[], month: string, limit = 4): CategoryShift[] {
  const spend = txns.filter(isSpend);
  const months: string[] = [];
  for (let m = prevMonth(month), i = 0; i < 3; m = prevMonth(m), i++) {
    if (spend.some((t) => t.date.startsWith(m))) months.push(m);
  }
  if (!months.length) return [];
  const total = (list: Txn[]) => {
    const r = new Map<string, number>();
    for (const t of list) r.set(t.category, (r.get(t.category) ?? 0) + t.amount);
    return r;
  };
  const now = total(spend.filter((t) => t.date.startsWith(month)));
  const past = total(spend.filter((t) => months.some((m) => t.date.startsWith(m))));
  const cats = new Set([...now.keys(), ...past.keys()]);
  return [...cats]
    .map((category) => {
      const n = now.get(category) ?? 0;
      const usual = (past.get(category) ?? 0) / months.length;
      return { category, now: n, usual, delta: n - usual };
    })
    // Small wobbles aren't news.
    .filter((c) => Math.abs(c.delta) >= 1000 && Math.abs(c.delta) >= 0.25 * Math.max(c.usual, c.now))
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, limit);
}

export interface Recurring {
  key: string;
  name: string;
  kind: Txn['kind'];
  category: string;
  /** Typical amount. */
  amount: number;
  /** Typical day of the month it leaves. */
  day: number;
  months: number;
  /** In the latest month: paid, still to come, or past its usual day with no payment. */
  status: 'paid' | 'due' | 'missing';
  lastDate: string;
}

/**
 * Payments that go out every month for about the same amount: SIPs, rent,
 * EMIs, subscriptions. `asOf` is the last day the statements cover.
 */
export function recurringPayments(txns: Txn[], asOf?: string): Recurring[] {
  const out = txns.filter((t) => t.direction === 'debit' && (t.kind === 'spend' || t.kind === 'investment') && t.accountId !== MANUAL);
  if (!out.length) return [];
  const end = asOf ?? txns.reduce((a, t) => (t.date > a ? t.date : a), '');
  const month = end.slice(0, 7);
  const window: string[] = [];
  for (let m = month, i = 0; i < 6; m = prevMonth(m), i++) window.push(m);
  const groups = new Map<string, Txn[]>();
  for (const t of out) {
    if (!window.includes(t.date.slice(0, 7))) continue;
    groups.set(t.merchantKey, [...(groups.get(t.merchantKey) ?? []), t]);
  }
  const res: Recurring[] = [];
  for (const [key, list] of groups) {
    const seen = new Set(list.map((t) => t.date.slice(0, 7)));
    // Months before this one, so a payment not yet made this month still counts.
    const earlier = window.slice(1).filter((m) => seen.has(m));
    if (earlier.length < 2) continue;
    // Still going: seen last month or this month.
    if (!seen.has(month) && !seen.has(window[1])) continue;
    const amt = median(list.map((t) => t.amount));
    const similar = list.filter((t) => Math.abs(t.amount - amt) <= 0.2 * amt).length;
    if (similar < 0.6 * list.length || amt < 50) continue;
    // Several payments a month to one payee (a grocer, a friend) is a habit, not a bill.
    if (list.length > seen.size * 1.5) continue;
    const day = Math.round(median(list.map((t) => Number(t.date.slice(8, 10)))));
    const latest = [...list].sort((a, b) => b.date.localeCompare(a.date))[0];
    const status = seen.has(month) ? 'paid' : Number(end.slice(8, 10)) > day + 3 ? 'missing' : 'due';
    res.push({ key, name: latest.merchantName, kind: latest.kind, category: latest.category, amount: amt, day, months: seen.size, status, lastDate: latest.date });
  }
  const order = { missing: 0, due: 1, paid: 2 };
  return res.sort((a, b) => order[a.status] - order[b.status] || b.amount - a.amount);
}

export interface UnpairedTransfer {
  out: Txn;
  in: Txn;
}

export const pairKey = (a: Txn, b: Txn) => [a.id, b.id].sort().join('|');

/**
 * Money that left one of your accounts and arrived in another for the same
 * amount within three days, but isn't marked as a self transfer.
 */
export function unpairedTransfers(txns: Txn[], dismissed: string[] = []): UnpairedTransfer[] {
  const skip = new Set(dismissed);
  const open = txns.filter((t) => !t.pairId && t.accountId !== MANUAL && t.amount >= 500 &&
    // You said what it is by hand; leave it.
    !(t.source === 'manual' && t.kind !== 'transfer'));
  const credits = open.filter((t) => t.direction === 'credit');
  const used = new Set<string>();
  const res: UnpairedTransfer[] = [];
  for (const o of open.filter((t) => t.direction === 'debit').sort((a, b) => a.date.localeCompare(b.date))) {
    const d = Date.parse(o.date);
    const c = credits.find((x) => !used.has(x.id) && x.accountId !== o.accountId && x.amount === o.amount &&
      Math.abs(Date.parse(x.date) - d) <= 3 * DAY && !skip.has(pairKey(o, x)));
    if (!c) continue;
    used.add(c.id);
    res.push({ out: o, in: c });
  }
  return res;
}
