import type { AppState, MonthPlan, Txn } from './types';

export const EMPTY_PLAN: MonthPlan = { income: 0, expectedSpend: 0, expectedInvestment: 0 };

export function nextMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

export function currentMonth(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

/** The plan for a month: its own entry, or the latest earlier month's (carried forward). */
export function planFor(plans: Record<string, MonthPlan>, month: string): { plan: MonthPlan; own: boolean; set: boolean } {
  if (plans[month]) return { plan: plans[month], own: true, set: true };
  const earlier = Object.keys(plans).filter((m) => m < month).sort().pop();
  return earlier ? { plan: plans[earlier], own: false, set: true } : { plan: EMPTY_PLAN, own: false, set: false };
}

/**
 * Saves a month's plan without changing history: months before it that were
 * inheriting values keep what they showed until now.
 */
export function setPlan(state: AppState, month: string, plan: MonthPlan, activeMonths: string[]): AppState {
  const plans = { ...state.plans };
  for (const m of activeMonths) {
    if (m < month && !plans[m]) {
      const inherited = planFor(state.plans, m);
      if (inherited.set) plans[m] = inherited.plan;
    }
  }
  // Keep later months that were inheriting the old value on the old value.
  const old = planFor(state.plans, month);
  if (old.set) {
    for (const m of activeMonths) {
      if (m > month && !plans[m]) plans[m] = old.plan;
    }
  }
  plans[month] = plan;
  return { ...state, plans };
}

export interface MonthActuals {
  spend: number; // spending minus refunds
  refunds: number;
  invested: number; // money put into investments
  redeemed: number;
  transfers: number;
  cardBills: number;
  credits: number; // income-type credits seen in statements (not used for plans)
}

export function actualsFor(txns: Txn[]): MonthActuals {
  const a: MonthActuals = { spend: 0, refunds: 0, invested: 0, redeemed: 0, transfers: 0, cardBills: 0, credits: 0 };
  for (const t of txns) {
    const out = t.direction === 'debit';
    if (t.kind === 'spend') { if (out) a.spend += t.amount; else a.refunds += t.amount; }
    else if (t.kind === 'investment') { if (out) a.invested += t.amount; else a.redeemed += t.amount; }
    else if (t.kind === 'transfer') { if (out) a.transfers += t.amount; }
    else if (t.kind === 'cc_bill') { if (out) a.cardBills += t.amount; }
    else if (t.kind === 'income' && !out) a.credits += t.amount;
  }
  a.spend -= a.refunds;
  return a;
}

export interface MonthSummary {
  month: string;
  plan: MonthPlan;
  planSet: boolean;
  actual: MonthActuals;
  /** Positive = spent more than expected. */
  spendOver: number;
  /** Positive = invested more than expected. */
  investOver: number;
  /** Income − spend − investment. Negative means overspent. */
  saved: number;
  plannedSaving: number;
}

export function summarize(state: AppState, month: string, txns: Txn[]): MonthSummary {
  const { plan, set } = planFor(state.plans, month);
  const actual = actualsFor(txns.filter((t) => t.date.startsWith(month)));
  return {
    month,
    plan,
    planSet: set,
    actual,
    spendOver: actual.spend - plan.expectedSpend,
    investOver: actual.invested - plan.expectedInvestment,
    saved: plan.income - actual.spend - actual.invested,
    plannedSaving: plan.income - plan.expectedSpend - plan.expectedInvestment,
  };
}

/** Months from the first transaction or plan up to the latest (inclusive), oldest first. */
export function monthRange(state: AppState): string[] {
  const all = [...state.txns.map((t) => t.date.slice(0, 7)), ...Object.keys(state.plans)].sort();
  if (!all.length) return [];
  const out: string[] = [];
  for (let m = all[0]; m <= all[all.length - 1]; m = nextMonth(m)) out.push(m);
  return out;
}
