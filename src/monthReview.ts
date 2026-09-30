import type { AppState, Txn } from './types';
import { aiSession, hasAi } from './ai/providers';
import { summarize } from './plans';
import { recurringPayments, spendAlerts, subscriptions } from './insights';

/**
 * A short AI note on a month: what changed, what drove it, what to watch. The AI gets the
 * month's figures only - totals, categories against their usual, the stand-out payments and
 * subscriptions, payee names - never account numbers or narrations.
 */

export interface MonthReview {
  headline: string;
  points: string[];
  watch: string[];
}

const r0 = (n: number) => Math.round(n);
const prevMonth = (ym: string) => { const [y, m] = ym.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; };
const isSpend = (t: Txn) => (t.kind === 'spend' || (t.kind === 'cc_bill' && !t.pairId)) && !t.excluded;

/** What the AI sees about a month (also its cache key: a new statement means a new review). */
export function reviewInput(state: AppState, month: string, txns: Txn[] = state.txns) {
  const inMonth = txns.filter((t) => t.date.startsWith(month));
  const lastDay = inMonth.reduce((a, t) => (t.date > a ? t.date : a), '');
  const s = summarize(state, month, txns);
  const past: string[] = [];
  for (let m = prevMonth(month), i = 0; i < 3; m = prevMonth(m), i++) if (txns.some((t) => t.date.startsWith(m))) past.push(m);
  const cat = (list: Txn[]) => {
    const r = new Map<string, number>();
    for (const t of list.filter(isSpend)) r.set(t.category, (r.get(t.category) ?? 0) + (t.direction === 'debit' ? t.amount : -t.amount));
    return r;
  };
  const now = cat(inMonth);
  const before = cat(txns.filter((t) => past.some((m) => t.date.startsWith(m))));
  const subs = subscriptions(txns, state.settings.subscriptionMarks ?? {});
  return {
    month,
    statementsUpTo: lastDay,
    plan: s.planSet ? { income: r0(s.plan.income), expectedSpend: r0(s.plan.expectedSpend), expectedInvestment: r0(s.plan.expectedInvestment) } : null,
    spent: r0(s.actual.spend), invested: r0(s.actual.invested), redeemed: r0(s.actual.redeemed), refunds: r0(s.actual.refunds),
    previousMonths: past.map((m) => { const p = summarize(state, m, txns); return { month: m, spent: r0(p.actual.spend), invested: r0(p.actual.invested) }; }),
    categories: [...now.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([category, amount]) => ({ category, amount: r0(amount), usualPerMonth: past.length ? r0((before.get(category) ?? 0) / past.length) : null })),
    biggestPayments: inMonth.filter((t) => isSpend(t) && t.direction === 'debit').sort((a, b) => b.amount - a.amount).slice(0, 6)
      .map((t) => ({ payee: t.merchantName, amount: r0(t.amount), category: t.category, date: t.date })),
    standOut: spendAlerts(txns, month).map((a) => `${a.text} (${a.detail})`),
    subscriptions: { count: subs.length, yearly: r0(subs.reduce((a, x) => a + x.yearly, 0)),
      priceChanges: subs.filter((x) => x.change).map((x) => `${x.name} ${r0(x.change!.from)} → ${r0(x.change!.to)}`),
      chargedAfterCancel: subs.filter((x) => x.chargedAfterCancel).map((x) => x.name) },
    regularPaymentsNotSeen: recurringPayments(txns, lastDay).filter((r) => r.status === 'missing').map((r) => `${r.name} (~${r0(r.amount)}, usually around day ${r.day})`),
  };
}

const PROMPT = (data: unknown) => `You write a short month-end review for one person's expense tracker, in Indian English, amounts in rupees written the Indian way (₹1,20,000).
Use ONLY the figures below; never invent or estimate a number that is not there. If "statementsUpTo" is before the month's end, say the month is not complete.
Return:
- headline: one sentence, the single most important thing about the month.
- points: 3 to 5 short bullets on what changed and why (name the categories and payees that drove it; compare with the previous months and the plan when there is one).
- watch: 1 to 3 short, practical things to keep an eye on next month (a subscription that went up, a regular payment not seen, a category running hot). No investment advice.
Plain sentences, no markdown.

Data:
${JSON.stringify(data)}`;

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    headline: { type: 'STRING' },
    points: { type: 'ARRAY', items: { type: 'STRING' } },
    watch: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['headline', 'points', 'watch'],
};

const CACHE = 'et-ai-month-review';
type Cache = Record<string, { sig: string; at: number; model: string; review: MonthReview }>;
const readCache = (): Cache => { try { return JSON.parse(localStorage.getItem(CACHE) || '{}') as Cache; } catch { return {}; } };
const sigOf = (data: unknown) => { let h = 0; const s = JSON.stringify(data); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return String(h); };

/** The review kept for this month, if the month's figures are still the same. */
export function cachedReview(state: AppState, month: string, txns?: Txn[]) {
  const c = readCache()[month];
  return c && c.sig === sigOf(reviewInput(state, month, txns)) ? c : null;
}

export async function aiMonthReview(state: AppState, month: string, txns?: Txn[], retryDelay = 2000): Promise<{ review: MonthReview; model: string }> {
  if (!hasAi(state.settings)) throw new Error('Add a free AI key in Settings → AI assistants first.');
  const data = reviewInput(state, month, txns);
  const session = aiSession(state.settings, retryDelay);
  const raw = await session.generate<MonthReview>(PROMPT(data), SCHEMA);
  const clean = (xs: unknown, n: number) => (Array.isArray(xs) ? xs : []).map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, n).map((x) => x.slice(0, 300));
  const review = { headline: String(raw.headline ?? '').trim().slice(0, 300), points: clean(raw.points, 5), watch: clean(raw.watch, 3) };
  if (!review.headline && !review.points.length) throw new Error('The AI returned an empty review. Try again.');
  const model = session.last ? `${session.last.name ?? session.last.provider} · ${session.last.model}` : '';
  try {
    const c = readCache(); c[month] = { sig: sigOf(data), at: Date.now(), model, review };
    const keep = Object.keys(c).sort().slice(-12); localStorage.setItem(CACHE, JSON.stringify(Object.fromEntries(keep.map((k) => [k, c[k]]))));
  } catch { /* kept for this visit only */ }
  return { review, model };
}
