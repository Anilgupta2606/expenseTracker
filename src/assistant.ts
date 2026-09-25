import type { AppState, Kind, LearnedRule, Txn } from './types';
import { CATEGORIES, categoryCounted, categoryKey, defaultCategory, isValidCategory, KIND_LABEL } from './categorize/categories';
import { AI_KINDS, ALL_CATEGORIES, GeminiSession } from './categorize/gemini';

/** Which transactions a request is about. Every field that is set must match. */
export interface TxnFilter {
  kinds?: Kind[];
  categories?: string[];
  /** Exact titles (payee names) as the app shows them. */
  payees?: string[];
  /** Words to look for in the title or narration. */
  text?: string;
  direction?: 'debit' | 'credit';
  from?: string;
  to?: string;
  minAmount?: number;
  maxAmount?: number;
  banks?: string[];
  counted?: boolean;
}

export type AssistantAction =
  | { type: 'set_counted'; counted: boolean }
  | { type: 'set_type'; kind: Kind; category: string }
  | { type: 'set_title'; title: string }
  /** Switch a whole category on or off in "What counts", for now and future uploads. */
  | { type: 'category_counted'; kind: Kind; category: string; counted: boolean };

export type Measure = 'total' | 'count' | 'list' | 'by_category' | 'by_payee' | 'by_month';

export interface AssistantPlan {
  intent: 'change' | 'question' | 'unclear';
  reply: string;
  filter: TxnFilter;
  action?: AssistantAction;
  measure?: Measure;
  /** Also remember the change for these payees' future transactions. */
  remember: boolean;
}

export function matchFilter(t: Txn, f: TxnFilter, state: Pick<AppState, 'accounts'>): boolean {
  const lower = (s: string) => s.toLowerCase();
  if (f.kinds?.length && !f.kinds.includes(t.kind)) return false;
  if (f.categories?.length && !f.categories.map(lower).includes(lower(t.category))) return false;
  // Payee titles and search words each widen the net: a row matching either is in.
  const byPayee = f.payees?.length ? f.payees.map(lower).includes(lower(t.merchantName)) : undefined;
  let byText: boolean | undefined;
  if (f.text?.trim()) {
    const hay = lower(`${t.merchantName} ${t.description} ${t.note ?? ''}`);
    byText = f.text.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
  }
  if ((byPayee !== undefined || byText !== undefined) && !byPayee && !byText) return false;
  if (f.direction && t.direction !== f.direction) return false;
  if (f.from && t.date < f.from) return false;
  if (f.to && t.date > f.to) return false;
  if (f.minAmount != null && t.amount < f.minAmount) return false;
  if (f.maxAmount != null && t.amount > f.maxAmount) return false;
  if (f.banks?.length) {
    const bank = state.accounts.find((a) => a.id === t.accountId)?.bank ?? (t.accountId === 'MANUAL' ? 'Cash' : '');
    if (!f.banks.map(lower).includes(lower(bank))) return false;
  }
  if (f.counted != null && !t.excluded !== f.counted) return false;
  return true;
}

/** Which rows an action touches: the filtered ones, or the whole category for a "What counts" switch. */
export function targets(state: AppState, plan: AssistantPlan): Txn[] {
  const a = plan.action;
  if (a?.type === 'category_counted') return state.txns.filter((t) => t.kind === a.kind && t.category === a.category);
  return state.txns.filter((t) => matchFilter(t, plan.filter, state));
}

/** Applies a previewed change to exactly these rows. */
export function applyPlan(state: AppState, plan: AssistantPlan, ids: Set<string>): AppState {
  const a = plan.action;
  if (!a) return state;
  const hit = state.txns.filter((t) => ids.has(t.id));
  let { settings, rules } = state;
  const txns = state.txns.map((t) => {
    if (!ids.has(t.id)) return t;
    switch (a.type) {
      case 'set_counted':
        return { ...t, excluded: !a.counted };
      case 'category_counted':
        return { ...t, excluded: !a.counted };
      case 'set_type':
        return { ...t, kind: a.kind, category: a.category, source: 'manual' as const, excluded: !categoryCounted(settings, a.kind, a.category) };
      case 'set_title':
        return { ...t, merchantName: a.title, titleSet: 'manual' as const };
    }
  });
  if (a.type === 'category_counted') {
    settings = { ...settings, categoryCounted: { ...settings.categoryCounted, [categoryKey(a.kind, a.category)]: a.counted } };
  }
  if (plan.remember && (a.type === 'set_type' || a.type === 'set_title')) {
    // One rule per payee (and direction for spending/income), like "Always use this" in the edit sheet.
    const learned = new Map<string, LearnedRule>();
    for (const t of hit) {
      const kind = a.type === 'set_type' ? a.kind : t.kind;
      const category = a.type === 'set_type' ? a.category : t.category;
      const direction = kind === 'spend' || kind === 'income' ? t.direction : undefined;
      const old = rules.find((r) => r.key === t.merchantKey && (!direction || !r.direction || r.direction === direction));
      learned.set(`${t.merchantKey}|${direction ?? ''}`, {
        ...(old ?? {}), key: t.merchantKey, kind, category, direction, createdAt: Date.now(),
        ...(a.type === 'set_title' ? { title: a.title } : old?.title ? { title: old.title } : {}),
      });
    }
    const replaced = (r: LearnedRule) => [...learned.values()].some((n) => n.key === r.key && (!n.direction || !r.direction || r.direction === n.direction));
    rules = [...rules.filter((r) => !replaced(r)), ...learned.values()];
  }
  return { ...state, settings, rules, txns };
}

export interface Answer {
  count: number;
  moneyOut: number;
  moneyIn: number;
  groups?: { label: string; out: number; in: number; count: number }[];
  rows?: Txn[];
}

/** Works out the answer on the device from the matching rows. */
export function answer(rows: Txn[], measure: Measure = 'total'): Answer {
  const sum = (xs: Txn[], dir: 'debit' | 'credit') => Math.round(xs.filter((t) => t.direction === dir).reduce((s, t) => s + t.amount, 0) * 100) / 100;
  const out: Answer = { count: rows.length, moneyOut: sum(rows, 'debit'), moneyIn: sum(rows, 'credit') };
  const groupBy = (key: (t: Txn) => string) => {
    const m = new Map<string, Txn[]>();
    for (const t of rows) m.set(key(t), [...(m.get(key(t)) ?? []), t]);
    return [...m.entries()].map(([label, xs]) => ({ label, out: sum(xs, 'debit'), in: sum(xs, 'credit'), count: xs.length }))
      .sort((a, b) => b.out + b.in - (a.out + a.in));
  };
  if (measure === 'by_category') out.groups = groupBy((t) => t.category);
  if (measure === 'by_payee') out.groups = groupBy((t) => t.merchantName);
  if (measure === 'by_month') out.groups = groupBy((t) => t.date.slice(0, 7)).sort((a, b) => a.label.localeCompare(b.label));
  if (measure === 'list') out.rows = [...rows].sort((a, b) => b.date.localeCompare(a.date));
  return out;
}

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    intent: { type: 'STRING', enum: ['change', 'question', 'unclear'] },
    reply: { type: 'STRING' },
    filter: {
      type: 'OBJECT',
      properties: {
        kinds: { type: 'ARRAY', items: { type: 'STRING', enum: AI_KINDS } },
        categories: { type: 'ARRAY', items: { type: 'STRING', enum: ALL_CATEGORIES } },
        payees: { type: 'ARRAY', items: { type: 'STRING' } },
        text: { type: 'STRING' },
        direction: { type: 'STRING', enum: ['debit', 'credit'] },
        from: { type: 'STRING' },
        to: { type: 'STRING' },
        minAmount: { type: 'NUMBER' },
        maxAmount: { type: 'NUMBER' },
        banks: { type: 'ARRAY', items: { type: 'STRING' } },
        counted: { type: 'BOOLEAN' },
      },
    },
    action: {
      type: 'OBJECT',
      properties: {
        type: { type: 'STRING', enum: ['none', 'set_counted', 'set_type', 'set_title', 'category_counted'] },
        counted: { type: 'BOOLEAN' },
        kind: { type: 'STRING', enum: AI_KINDS },
        category: { type: 'STRING', enum: ALL_CATEGORIES },
        title: { type: 'STRING' },
      },
      required: ['type'],
    },
    measure: { type: 'STRING', enum: ['none', 'total', 'count', 'list', 'by_category', 'by_payee', 'by_month'] },
    remember: { type: 'BOOLEAN' },
  },
  required: ['intent', 'reply', 'filter', 'action', 'measure', 'remember'],
};

/** What the AI knows about your data: names only, no amounts, dates of rows, balances or account numbers. */
export function assistantContext(state: AppState) {
  const counts = new Map<string, number>();
  for (const t of state.txns) counts.set(t.merchantName, (counts.get(t.merchantName) ?? 0) + 1);
  const payees = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 400).map(([n]) => n);
  const banks = [...new Set(state.accounts.map((a) => a.bank))];
  const months = [...new Set(state.txns.map((t) => t.date.slice(0, 7)))].sort();
  return { payees, banks, months };
}

function prompt(request: string, state: AppState, today: string): string {
  const { payees, banks, months } = assistantContext(state);
  return `You turn a request typed into a personal expense tracker (Indian rupees) into a filter plus either a change or a question. The app then finds the matching transactions itself and shows them to the user before changing anything.

Today is ${today}. Months with data: ${months.join(', ') || 'none'}.
Types (kinds) and their categories:
${AI_KINDS.map((k) => `  ${k} (${KIND_LABEL[k]}): ${CATEGORIES[k].join(', ')}`).join('\n')}
Banks: ${banks.join(', ') || 'none'}${state.txns.some((t) => t.accountId === 'MANUAL') ? ', Cash' : ''}
Payee titles in the app: ${JSON.stringify(payees)}

Return:
- intent: "change" to modify transactions, "question" to answer from the data, "unclear" if you can't tell (then ask in reply).
- reply: one short friendly sentence saying what you understood (e.g. "Marking all self transfers as not counted."). Never invent numbers; the app computes them.
- filter: only the fields the request implies. payees must be copied exactly from the payee list (pick every title that fits, e.g. all spellings of a person). Use text for words to find in narrations when no payee fits. Dates as YYYY-MM-DD ("August" means the most recent August with data). direction "debit" = money out, "credit" = money in. counted: true/false only if the request mentions counted / not counted rows.
- action (for changes):
  - set_counted with counted true/false: include or leave out of totals ("move to not counted", "don't count", "exclude").
  - set_type with kind and a category valid for that kind: change type/category ("mark as investment", "these are groceries").
  - set_title with title: rename ("call them Rakesh Kirana").
  - category_counted with kind, category, counted: when the user wants a whole category never / always counted, including future uploads ("never count self transfers", "always leave out Family").
- measure (for questions): total (money out/in), count, list, by_category, by_payee or by_month.
- remember: true when the user wants the change applied to future transactions from the same payees ("always", "from now on", "remember").
For a question, action.type is "none". For a change, measure is "none". Use every filter field the request implies: a category word ("food", "groceries", "rent") means categories; a month means both from and to; "paid", "spent", "sent" mean direction "debit"; "received", "got" mean "credit".

Examples (payees and dates are illustrative):
- "move all self transfers to not counted" → intent change, filter {categories:["Self Transfer"]}, action {type:"set_counted", counted:false}
- "never count credit card bills" → intent change, filter {}, action {type:"category_counted", kind:"cc_bill", category:"Credit Card Bill", counted:false}
- "mark all Groww payments as mutual funds and remember it" → intent change, filter {payees:[every Groww title], direction:"debit"}, action {type:"set_type", kind:"investment", category:"Mutual Funds"}, remember true
- "rename Rakesh jai to Rakesh Kirana from now on" → intent change, filter {payees:["Rakesh jai"]}, action {type:"set_title", title:"Rakesh Kirana"}, remember true
- "how much did I spend on food in July?" → intent question, filter {kinds:["spend"], categories:["Food & Dining"], from:"2026-07-01", to:"2026-07-31", direction:"debit"}, measure total
- "top payees I paid in July" → intent question, filter {from:"2026-07-01", to:"2026-07-31", direction:"debit"}, measure by_payee
- "which transactions are not counted?" → intent question, filter {counted:false}, measure list

Request: ${JSON.stringify(request)}`;
}

export async function planRequest(request: string, state: AppState, retryDelay = 2000, today = new Date().toISOString().slice(0, 10)): Promise<AssistantPlan> {
  const key = state.settings.geminiKey;
  if (!key) throw new Error('Add your free Gemini API key in Settings first.');
  const raw = await new GeminiSession(key, retryDelay).generate<{
    intent: AssistantPlan['intent']; reply: string; filter?: TxnFilter; remember?: boolean; measure?: Measure | null;
    action?: { type: AssistantAction['type'] | 'none'; counted?: boolean; kind?: Kind; category?: string; title?: string } | null;
  }>(prompt(request, state, today), SCHEMA);
  return sanitize(raw, request);
}

/** Keeps only well-formed parts of the AI's answer. */
export function sanitize(raw: {
  intent: AssistantPlan['intent']; reply: string; filter?: TxnFilter; remember?: boolean; measure?: Measure | 'none' | null;
  action?: { type: AssistantAction['type'] | 'none'; counted?: boolean; kind?: Kind; category?: string; title?: string } | null;
}, request = ''): AssistantPlan {
  const f = raw.filter ?? {};
  const filter: TxnFilter = {};
  if (f.kinds?.length) filter.kinds = f.kinds.filter((k) => AI_KINDS.includes(k));
  if (f.categories?.length) filter.categories = f.categories;
  if (f.payees?.length) filter.payees = f.payees;
  if (f.text?.trim()) filter.text = f.text.trim();
  if (f.direction === 'debit' || f.direction === 'credit') filter.direction = f.direction;
  if (f.from && /^\d{4}-\d{2}-\d{2}$/.test(f.from)) filter.from = f.from;
  if (f.to && /^\d{4}-\d{2}-\d{2}$/.test(f.to)) filter.to = f.to;
  if (Number.isFinite(f.minAmount)) filter.minAmount = f.minAmount;
  if (Number.isFinite(f.maxAmount)) filter.maxAmount = f.maxAmount;
  if (f.banks?.length) filter.banks = f.banks;
  if (typeof f.counted === 'boolean') filter.counted = f.counted;
  // Answers leave out what doesn't count (e.g. self transfers) unless you ask about those rows.
  if (raw.intent === 'question' && filter.counted === undefined) filter.counted = true;
  if (!filter.direction && raw.intent === 'question') {
    const out = /\b(paid|pay|spent|spend|sent)\b/i.test(request), inn = /\b(received|got|earned|credited)\b/i.test(request);
    if (out !== inn) filter.direction = out ? 'debit' : 'credit';
  }

  let action: AssistantAction | undefined;
  const a = raw.action;
  // Smaller models sometimes leave out a field or put it in the wrong one; fill in what the request makes plain.
  const counted = typeof a?.counted === 'boolean' ? a.counted
    : /\b(always|include|start counting|count (them|it|these) again)\b/i.test(request) && !/\b(never|don'?t|do not|stop|exclude|not count|leave out|remove)\b/i.test(request);
  const categoryFor = (kind: Kind) => [a?.category, a?.title].find((c): c is string => Boolean(c) && isValidCategory(kind, c!))
    ?? (CATEGORIES[kind].length === 1 ? CATEGORIES[kind][0] : undefined);
  const kind = a?.kind && AI_KINDS.includes(a.kind) ? a.kind : undefined;
  if (a?.type === 'set_counted') action = { type: 'set_counted', counted };
  if (a?.type === 'set_type' && kind) action = { type: 'set_type', kind, category: categoryFor(kind) ?? defaultCategory(kind, '') };
  if (a?.type === 'set_title' && a.title?.trim()) action = { type: 'set_title', title: a.title.trim().slice(0, 40) };
  if (a?.type === 'category_counted' && kind && categoryFor(kind)) action = { type: 'category_counted', kind, category: categoryFor(kind)!, counted };
  let intent = raw.intent;
  if (intent === 'change' && !action) intent = 'unclear';
  const measure = !raw.measure || raw.measure === 'none' ? 'total' : raw.measure;
  return { intent, reply: (raw.reply ?? '').trim(), filter, action, measure, remember: Boolean(raw.remember) };
}

/** Whether the change would actually alter this row (so already-done rows aren't counted as changes). */
export function wouldChange(t: Txn, a: AssistantAction, settings: AppState['settings']): boolean {
  switch (a.type) {
    case 'set_counted':
    case 'category_counted': return Boolean(t.excluded) === a.counted;
    case 'set_type': return t.kind !== a.kind || t.category !== a.category || Boolean(t.excluded) === categoryCounted(settings, a.kind, a.category);
    case 'set_title': return t.merchantName !== a.title;
  }
}

/** A plain description of a change, for the confirm button. */
export function describeAction(a: AssistantAction): string {
  switch (a.type) {
    case 'set_counted': return a.counted ? 'Count them in totals' : 'Mark them not counted';
    case 'set_type': return `Change to ${KIND_LABEL[a.kind]} / ${a.category}`;
    case 'set_title': return `Rename to "${a.title}"`;
    case 'category_counted': return `${a.counted ? 'Count' : 'Stop counting'} all ${a.category}, now and in future uploads`;
  }
}
