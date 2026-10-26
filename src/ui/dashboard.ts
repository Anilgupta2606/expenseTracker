import type { Kind, Txn } from '../types';
import { currentMonth, summarize, summarizeAll, type MonthSummary } from '../plans';
import { app, navigate, render, toast, update } from './app';
import { aiMonthReview, cachedReview } from '../monthReview';
import { hasAi } from '../ai/providers';
import { buildLedgerExport } from '../ledgerExport';
import { expandSplits, tagTotals } from '../splits';
import { categoryCounted } from '../categorize/categories';
import { categoryShifts, pairKey, recurringPayments, spendAlerts, subscriptions, unpairedTransfers, unusualSpends, type SpendAlert, type UnpairedTransfer } from '../insights';
import { donutChart, monthlyChart, shortMonth, toSlices, trendChart, type MonthPoint } from './charts';
import { applyFilters, dayLabel, esc, inr, inrFull, kindVar, monthLabel, monthShort, accountLabel } from './format';
import { MANUAL_ACCOUNT, openManualSheet } from './manualSheet';
import { openPlanSheet } from './planSheet';
import { getLook } from '../look';
import { getTheme, setTheme } from '../theme';
import { openDock } from './chatDock';

function byCategory(txns: Txn[]): { category: string; total: number; count: number }[] {
  const m = new Map<string, { total: number; count: number }>();
  for (const t of txns) {
    const e = m.get(t.category) ?? { total: 0, count: 0 };
    e.total += t.amount;
    e.count++;
    m.set(t.category, e);
  }
  return [...m.entries()].map(([category, v]) => ({ category, ...v })).sort((a, b) => b.total - a.total);
}

/** Months that have transactions (statement or added by hand). Newest first. */
export function availableMonths(): string[] {
  return [...new Set(app.state.txns.map((t) => t.date.slice(0, 7)))].sort().reverse();
}

function accountSelect(): string {
  const { state, filters } = app;
  const hasManual = state.txns.some((t) => t.accountId === MANUAL_ACCOUNT);
  if (state.accounts.length + (hasManual ? 1 : 0) < 2) return '';
  return `<select data-filter="account" aria-label="Account" class="toolbar-select">
    <option value="all">All accounts</option>
    ${state.accounts.map((a) => `<option value="${esc(a.id)}" ${filters.account === a.id ? 'selected' : ''}>${esc(accountLabel(a))}</option>`).join('')}
    ${hasManual ? `<option value="${MANUAL_ACCOUNT}" ${filters.account === MANUAL_ACCOUNT ? 'selected' : ''}>Added by hand</option>` : ''}
  </select>`;
}

/** Month + account filters used by the Transactions screen. */
export function filterBar(allowAll = true): string {
  const { filters } = app;
  const months = availableMonths();
  return `
    <div class="toolbar">
      <select data-filter="month" aria-label="Month" class="toolbar-select">
        ${allowAll ? `<option value="all" ${filters.month === 'all' ? 'selected' : ''}>All time</option>` : ''}
        ${months.map((m) => `<option value="${m}" ${filters.month === m ? 'selected' : ''}>${monthLabel(m)}</option>`).join('')}
      </select>
      ${accountSelect()}
    </div>`;
}

export function bindFilterBar(root: HTMLElement) {
  root.querySelectorAll<HTMLSelectElement>('select[data-filter]').forEach((el) => {
    el.addEventListener('change', () => {
      (app.filters as unknown as Record<string, string>)[el.dataset.filter!] = el.value;
      render();
    });
  });
}

const signed = (n: number) => `${n < 0 ? '−' : ''}${inr(Math.abs(n))}`;

function section(title: string, body: string, opts: { note?: string; action?: string; wide?: boolean } = {}): string {
  return `<section class="panel${opts.wide ? ' wide' : ''}">
    <header class="panel-head"><div><h2>${esc(title)}</h2>${opts.note ? `<p class="panel-note">${opts.note}</p>` : ''}</div>${opts.action ?? ''}</header>
    ${body}
  </section>`;
}

/** Money per tag for the month on screen (or all time); a tag opens its transactions. */
function tagsPanel(txns: Txn[], all: boolean): string {
  const rows = tagTotals(txns);
  if (!rows.length && !app.state.txns.some((t) => t.tags?.length)) return '';
  return section('Tags', rows.length ? `<table class="simple data">
      <thead><tr><th>Tag</th><th class="r">Spent</th><th class="r">Invested</th></tr></thead>
      <tbody>${rows.map((r) => `<tr><td><a href="#txns" data-kind="all" data-tag="${esc(r.tag)}">#${esc(r.tag)}</a> <span class="tiny">· ${r.count}</span></td>
        <td class="num r">${r.spent ? inr(r.spent) : '—'}</td><td class="num r">${r.invested ? inr(r.invested) : '—'}</td></tr>`).join('')}</tbody>
    </table>` : `<p class="muted small">No tagged transactions ${all ? 'yet' : 'this month'}.</p>`,
  { note: 'Add tags on any transaction (tap it). Spent is net of refunds; rows not counted are left out.' });
}

function meter(actual: number, expected: number, color: string): string {
  if (expected <= 0) return '<div class="meter"></div>';
  const pct = Math.min(actual / expected, 1.5);
  return `<div class="meter" aria-hidden="true">
    <div class="meter-fill" style="width:${(Math.min(pct, 1) / 1.5) * 100}%;background:${color}"></div>
    ${pct > 1 ? `<div class="meter-over" style="left:${(1 / 1.5) * 100}%;width:${((pct - 1) / 1.5) * 100}%"></div>` : ''}
    <div class="meter-target" style="left:${(1 / 1.5) * 100}%"></div>
  </div>`;
}

/** Four headline numbers for the month, each compared with the plan. */
function kpis(s: MonthSummary): string {
  const { plan, actual } = s;
  const tile = (kind: Kind | 'saved', label: string, value: string, sub: string, attrs = '') => `
    <div class="kpi" ${attrs}>
      <div class="kpi-label">${kind === 'saved' ? '' : `<span class="dot" style="background:${kindVar(kind)}"></span>`}${esc(label)}</div>
      <div class="kpi-value num ${kind === 'saved' && s.planSet ? (s.saved >= 0 ? 'ok' : 'bad') : ''}">${value}</div>
      <div class="kpi-sub">${sub}</div>
    </div>`;
  const noPlan = '<span class="muted">No target set</span>';
  const vsPlan = s.saved - s.plannedSaving;
  return `<div class="kpis">
    ${tile('income', 'Income', s.planSet ? inr(plan.income) : '—', s.planSet ? (s.month === 'all' ? 'Your monthly incomes added up' : 'Set by you') : '<button class="link-btn" data-plan>Set income</button>')}
    ${tile('spend', 'Spent', inr(actual.spend), plan.expectedSpend > 0
      ? (s.spendOver > 0 ? `<span class="pill bad">▲ ${inr(s.spendOver)} over</span>` : `<span class="pill ok">▼ ${inr(-s.spendOver)} under</span>`)
      : noPlan, 'data-kind="spend" role="link" tabindex="0"')}
    ${tile('investment', 'Invested', inr(actual.invested), plan.expectedInvestment > 0
      ? (s.investOver >= 0 ? `<span class="pill ok">✓ ${inr(s.investOver)} ahead</span>` : `<span class="pill warn">▼ ${inr(-s.investOver)} short</span>`)
      : noPlan, 'data-kind="investment" role="link" tabindex="0"')}
    ${tile('saved', s.planSet && s.saved < 0 ? 'Overspent' : 'Saved', s.planSet ? inr(Math.abs(s.saved)) : '—', s.planSet
      ? `Plan ${signed(s.plannedSaving)} · <span class="${vsPlan >= 0 ? 'ok' : 'bad'}">${vsPlan >= 0 ? '+' : '−'}${inr(Math.abs(vsPlan))}</span>`
      : 'Income − spent − invested')}
  </div>`;
}

function budgetPanel(s: MonthSummary): string {
  if (!s.planSet) {
    return section('Budget', `<p class="small muted">Add your income and how much you expect to spend and invest. The app then shows whether you are over or under.</p>
      <button class="btn primary" data-plan>Set income &amp; targets</button>`);
  }
  const row = (label: string, kind: Kind, actual: number, expected: number) => {
    const pct = expected > 0 ? Math.round((actual / expected) * 100) : 0;
    return `<div class="budget-row">
      <div class="row between"><span class="budget-label"><span class="dot" style="background:${kindVar(kind)}"></span>${label}</span>
        <span class="num small"><strong>${inr(actual)}</strong> <span class="muted">/ ${expected > 0 ? inr(expected) : 'no target'}</span></span></div>
      ${meter(actual, expected, kindVar(kind))}
      <div class="tiny">${expected > 0 ? `${pct}% of ${kind === 'spend' ? 'budget used' : 'target reached'}` : ''}</div>
    </div>`;
  };
  return section('Budget', `
    ${row('Spending', 'spend', s.actual.spend, s.plan.expectedSpend)}
    ${row('Investing', 'investment', s.actual.invested, s.plan.expectedInvestment)}
    <dl class="facts">
      <div><dt>Income</dt><dd class="num">${inr(s.plan.income)}</dd></div>
      <div><dt>Planned saving</dt><dd class="num">${signed(s.plannedSaving)}</dd></div>
      <div><dt>Actual saving</dt><dd class="num ${s.saved >= 0 ? 'ok' : 'bad'}">${signed(s.saved)}</dd></div>
    </dl>`, { action: '<button class="btn small-btn" data-plan>Edit plan</button>' });
}

function glancePanel(s: MonthSummary, txns: Txn[], prev: MonthSummary | undefined, cats: { category: string; total: number }[]): string {
  const spendTxns = txns.filter((t) => (t.kind === 'spend' || (t.kind === 'cc_bill' && !t.pairId)) && t.direction === 'debit' && !t.excluded);
  const biggest = [...spendTxns].sort((a, b) => b.amount - a.amount)[0];
  const manual = txns.filter((t) => t.accountId === MANUAL_ACCOUNT).length;
  const days = new Set(spendTxns.map((t) => t.date)).size;
  const lines: string[] = [];
  lines.push(`Spent <strong>${inr(s.actual.spend)}</strong> in ${spendTxns.length} payment${spendTxns.length === 1 ? '' : 's'} over ${days} day${days === 1 ? '' : 's'}; invested <strong>${inr(s.actual.invested)}</strong>.`);
  if (cats[0]) lines.push(`Top categories: ${cats.slice(0, 3).map((c) => `${esc(c.category)} <span class="num">${inr(c.total)}</span>`).join(', ')}.`);
  if (biggest) lines.push(`Largest spend: ${esc(biggest.merchantName)}, <span class="num">${inr(biggest.amount)}</span> on ${new Date(biggest.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}.`);
  if (prev) {
    const d = s.actual.spend - prev.actual.spend;
    const di = s.actual.invested - prev.actual.invested;
    lines.push(`Versus ${shortMonth(prev.month)}: spending <span class="${d > 0 ? 'bad' : 'ok'}">${d >= 0 ? '▲' : '▼'} ${inr(Math.abs(d))}</span>, investing <span class="${di >= 0 ? 'ok' : 'bad'}">${di >= 0 ? '▲' : '▼'} ${inr(Math.abs(di))}</span>.`);
  }
  if (s.planSet) {
    lines.push(s.saved >= 0
      ? `Kept <strong class="ok">${inr(s.saved)}</strong> of your ${inr(s.plan.income)} income.`
      : `Spent and invested <strong class="bad">${inr(-s.saved)}</strong> more than your ${inr(s.plan.income)} income.`);
  }
  if (manual) lines.push(`${manual} transaction${manual === 1 ? '' : 's'} added by hand.`);
  return section('Month at a glance', `<ul class="glance">${lines.map((l) => `<li>${l}</li>`).join('')}</ul>`);
}

/** Shows these rows on their own in Transactions. */
function openPicked(label: string, ids: string[]) {
  Object.assign(app.filters, { month: 'all', account: 'all', kind: 'all', category: '', search: '', picked: { label, ids } });
  navigate('#txns');
}

/** The AI's note on the month, when there is one (or the button to ask for it). */
let reviewBusy = '';
let reviewError: { month: string; msg: string } | null = null;
function aiReviewBlock(month: string, txns: Txn[]): string {
  const c = cachedReview(app.state, month, txns);
  if (c) {
    return `<div class="ai-review"><p class="ai-review-head">${esc(c.review.headline)}</p>
      ${c.review.points.length ? `<ul>${c.review.points.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
      ${c.review.watch.length ? `<p class="tiny" style="margin:8px 0 4px">Keep an eye on</p><ul class="watch">${c.review.watch.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
      <p class="tiny" style="margin:8px 0 0">AI review${c.model ? ` by ${esc(c.model)}` : ''}, ${esc(new Date(c.at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }))}. It sees totals, categories and payee names only. <button class="linkish" data-ai-review="${esc(month)}" data-again="1">Write it again</button></p></div>`;
  }
  if (!hasAi(app.state.settings)) return `<p class="tiny" style="margin:12px 0 0">Add a free AI key in <a href="#settings">Settings → AI assistants</a> for a written review of the month.</p>`;
  const err = reviewError?.month === month ? `<p class="small bad" style="margin:6px 0 0">${esc(reviewError.msg)}</p>` : '';
  return `<div style="margin-top:12px"><button class="btn small-btn" data-ai-review="${esc(month)}" ${reviewBusy === month ? 'disabled' : ''}>${reviewBusy === month ? '<span class="spinner"></span>Writing the review…' : '✦ AI review of the month'}</button>${err}</div>`;
}

/** Month-end review: what moved against the usual, payments that stand out, and the AI's note. */
function reviewPanel(month: string, txns: Txn[]): string {
  const shifts = categoryShifts(txns, month);
  const odd = unusualSpends(txns, month);
  const body = `${!shifts.length && !odd.length ? '<p class="muted small" style="margin:0">Nothing unusual by the numbers against the months before.</p>' : ''}${shifts.length ? `<p class="tiny" style="margin:0 0 6px">Against your average of the months before</p>
    <ul class="movements">${shifts.map((c) => `<li class="mv-row"><span class="grow"><span class="mv-label">${esc(c.category)}</span>
      <span class="tiny">${inr(c.now)} vs usual ${inr(c.usual)}</span></span>
      <span class="num ${c.delta > 0 ? 'bad' : 'ok'}">${c.delta > 0 ? '▲' : '▼'} ${inr(Math.abs(c.delta))}</span></li>`).join('')}</ul>` : ''}
    ${odd.length ? `<p class="tiny" style="margin:12px 0 6px">Payments that stand out</p>
    <ul class="movements">${odd.map((u) => `<li class="mv-row"><span class="grow"><span class="mv-label">${esc(u.txn.merchantName)}</span>
      <span class="tiny">${esc(dayLabel(u.txn.date))} · ${esc(u.reason)}</span></span>
      <span class="num">${inrFull(u.txn.amount)}</span></li>`).join('')}</ul>
    <button class="btn small-btn" style="margin-top:8px" data-open-odd="${esc(odd.map((u) => u.txn.id).join(','))}">Open in Transactions</button>` : ''}
    ${aiReviewBlock(month, txns)}`;
  return section('Month in review', body);
}

const ordinal = (d: number) => `${d}${d % 10 === 1 && d !== 11 ? 'st' : d % 10 === 2 && d !== 12 ? 'nd' : d % 10 === 3 && d !== 13 ? 'rd' : 'th'}`;

/** Bills and SIPs that go out every month, and whether this month's has left yet. */
function recurringPanel(txns: Txn[], timeline = false): string {
  const list = recurringPayments(txns);
  if (!list.length) return '';
  const missing = list.filter((r) => r.status === 'missing').length;
  const total = list.reduce((a, r) => a + r.amount, 0);
  const badge = { paid: '<span class="badge ok-badge">Paid</span>', due: '<span class="badge">Due</span>', missing: '<span class="badge warn">Not seen</span>' };
  const asOf = txns.reduce((a, t) => (t.date > a ? t.date : a), '');
  const today = Number(asOf.slice(8, 10)) || 1;
  // the month as a line, each payment a dot on its day
  const line = timeline ? `<div class="nx-days" aria-hidden="true"><span class="ln"></span>${list.slice(0, 12).map((r) => `<span class="dot" style="left:${((r.day - 1) / 30) * 100}%;background:${kindVar(r.kind)}" title="${esc(r.name)} · ${ordinal(r.day)}"></span>`).join('')}
    ${[1, 10, 20, 31].map((d) => `<span class="tick" style="left:${((d - 1) / 30) * 100}%">${d}</span>`).join('')}<span class="today" style="left:${((Math.min(today, 31) - 1) / 30) * 100}%"></span></div>` : '';
  return section('Recurring payments', `${line}<ul class="movements">${list.slice(0, 12).map((r) => `<li><a href="#txns" data-recurring="${esc(r.key)}">
      <span class="dot" style="background:${kindVar(r.kind)}"></span>
      <span class="grow"><span class="mv-label">${esc(r.name)}</span><span class="tiny">${esc(r.category)} · around the ${ordinal(r.day)} · ${r.months} months</span></span>
      <span class="rec-side"><span class="num">${inr(r.amount)}</span>${badge[r.status]}</span></a></li>`).join('')}</ul>`,
  { note: `About ${inr(total)} a month in ${list.length} regular payment${list.length === 1 ? '' : 's'}${missing ? `; <strong class="bad">${missing} not seen</strong> yet in ${esc(monthLabel(asOf.slice(0, 7)))}` : ''}. Statements up to ${esc(dayLabel(asOf))}.` });
}

/** Unusual spending in the month: open each one, or dismiss it for good. */
function openAlertsSheet(month: string, alerts: SpendAlert[]) {
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  const draw = (list: SpendAlert[]) => {
    backdrop.innerHTML = `<div class="sheet" role="dialog" aria-label="Unusual spending"><div class="grab"></div>
      <h2>Unusual spending, ${esc(monthLabel(month))}</h2>
      <p class="small muted" style="margin-top:-4px">Against the months before. Open one to see its transactions; dismiss it if it was expected.</p>
      ${list.length ? list.map((a, i) => `<div class="pair-card">
        <strong>${esc(a.text)}</strong><div class="small muted">${esc(a.detail)}</div>
        <div class="row" style="margin-top:8px;gap:8px"><button class="btn grow small-btn" data-alert-dismiss="${i}">Expected — dismiss</button><button class="btn primary grow small-btn" data-alert-open="${i}">Open</button></div>
      </div>`).join('') : '<p class="small ok">Nothing unusual left.</p>'}
      <button class="btn grow" data-close style="margin-top:10px;width:100%">Done</button></div>`;
    backdrop.querySelector('[data-close]')!.addEventListener('click', () => backdrop.remove());
    backdrop.querySelectorAll<HTMLElement>('[data-alert-open]').forEach((b) => b.addEventListener('click', () => {
      const a = list[Number(b.dataset.alertOpen)];
      backdrop.remove();
      openPicked(a.text, a.ids);
    }));
    backdrop.querySelectorAll<HTMLElement>('[data-alert-dismiss]').forEach((b) => b.addEventListener('click', async () => {
      const a = list[Number(b.dataset.alertDismiss)];
      await update((st) => ({ ...st, settings: { ...st.settings, dismissedAlerts: [...(st.settings.dismissedAlerts ?? []), a.id].slice(-300) } }));
      draw(list.filter((x) => x !== a));
    }));
  };
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });
  draw(alerts);
  document.body.append(backdrop);
}

/** Subscriptions and service bills: what each costs a year, when it is next due, and your keep / cancel choice. */
function subscriptionsPanel(txns: Txn[]): string {
  const list = subscriptions(txns, app.state.settings.subscriptionMarks ?? {});
  if (!list.length) return '';
  const yearly = list.reduce((a, s) => a + s.yearly, 0);
  const cancel = list.filter((s) => s.mark === 'cancel');
  const flags = (s: (typeof list)[number]) => [
    s.chargedAfterCancel ? `<span class="badge warn">Charged ${esc(dayLabel(s.chargedAfterCancel))}, after you chose to cancel</span>` : '',
    s.change ? `<span class="badge ${s.change.to > s.change.from ? 'warn' : 'ok-badge'}">${s.change.to > s.change.from ? 'Price up' : 'Price down'} ${inr(s.change.from)} → ${inr(s.change.to)} since ${esc(monthShort(s.change.since.slice(0, 7)))}</span>` : '',
  ].join('');
  const pick = (s: (typeof list)[number]) => `<span class="sub-pick" role="group" aria-label="Keep or cancel ${esc(s.name)}">
    <button class="chip-btn ${s.mark === 'keep' ? 'on' : ''}" data-sub-mark="keep" data-sub="${esc(s.key)}" aria-pressed="${s.mark === 'keep'}">Keep</button>
    <button class="chip-btn ${s.mark === 'cancel' ? 'on bad' : ''}" data-sub-mark="cancel" data-sub="${esc(s.key)}" aria-pressed="${s.mark === 'cancel'}">Plan to cancel</button></span>`;
  return section('Subscriptions', `<ul class="movements subs">${list.map((s) => `<li class="sub-row">
      <a href="#txns" data-sub-open="${esc(s.key)}" class="sub-main"><span class="grow"><span class="mv-label">${esc(s.name)}</span>
        <span class="tiny">${esc(s.category)} · ${s.cycle === 'monthly' ? `${inr(s.latest)} a month` : `${inr(s.latest)} a year`} · next about ${esc(dayLabel(s.nextDue))}</span></span>
        <span class="rec-side"><span class="num">${inr(s.yearly)}</span><span class="tiny">a year</span></span></a>
      <div class="sub-foot">${flags(s)}${pick(s)}</div></li>`).join('')}</ul>
    <p class="tiny" style="margin:8px 0 0">Not sure you still use one? Mark it <strong>Plan to cancel</strong> — if it is charged again after that, it shows here in red.</p>`,
  { note: `About <strong>${inr(yearly)}</strong> a year (${inr(Math.round(yearly / 12))} a month) in ${list.length} subscription${list.length === 1 ? '' : 's'} and service bill${list.length === 1 ? '' : 's'}${cancel.length ? `; ${cancel.length} you plan to cancel would save ${inr(cancel.reduce((a, s) => a + s.yearly, 0))} a year` : ''}.` });
}

/** Marks a same-amount pair across two of your accounts as a self transfer (or leaves it be). */
function openPairsSheet(pairs: UnpairedTransfer[]) {
  const accounts = app.state.accounts;
  const bank = (id: string) => { const a = accounts.find((x) => x.id === id); return a ? accountLabel(a) : id; };
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  const draw = (list: UnpairedTransfer[]) => {
    backdrop.innerHTML = `<div class="sheet" role="dialog" aria-label="Transfers between your accounts"><div class="grab"></div>
      <h2>Transfers between your accounts?</h2>
      <p class="small muted" style="margin-top:-4px">The same amount left one account and reached another within three days. If it was your own money moving, mark it as a self transfer so it isn't counted twice.</p>
      ${list.length ? list.map((p, i) => `<div class="pair-card">
        <div class="row" style="justify-content:space-between"><strong class="num">${inrFull(p.out.amount)}</strong><span class="tiny">${esc(dayLabel(p.out.date))}${p.in.date !== p.out.date ? ` → ${esc(dayLabel(p.in.date))}` : ''}</span></div>
        <div class="small">Out of ${esc(bank(p.out.accountId))}: ${esc(p.out.merchantName)} <span class="tiny">(${esc(p.out.category)})</span></div>
        <div class="small">Into ${esc(bank(p.in.accountId))}: ${esc(p.in.merchantName)} <span class="tiny">(${esc(p.in.category)})</span></div>
        <div class="row" style="margin-top:8px;gap:8px"><button class="btn grow small-btn" data-notpair="${i}">Not a transfer</button><button class="btn primary grow small-btn" data-pair="${i}">Self transfer</button></div>
      </div>`).join('') : '<p class="small ok">All sorted.</p>'}
      <button class="btn grow" data-close style="margin-top:10px;width:100%">Done</button></div>`;
    backdrop.querySelector('[data-close]')!.addEventListener('click', () => backdrop.remove());
    backdrop.querySelectorAll<HTMLElement>('[data-pair]').forEach((b) => b.addEventListener('click', async () => {
      const p = list[Number(b.dataset.pair)];
      const counted = categoryCounted(app.state.settings, 'transfer', 'Self Transfer');
      await update((s) => ({ ...s, txns: s.txns.map((t) => t.id === p.out.id || t.id === p.in.id
        ? { ...t, kind: 'transfer', category: 'Self Transfer', source: 'manual', pairId: t.id === p.out.id ? p.in.id : p.out.id, excluded: !counted }
        : t) }));
      toast('Marked as a self transfer');
      draw(list.filter((x) => x !== p));
    }));
    backdrop.querySelectorAll<HTMLElement>('[data-notpair]').forEach((b) => b.addEventListener('click', async () => {
      const p = list[Number(b.dataset.notpair)];
      await update((s) => ({ ...s, settings: { ...s.settings, notPairs: [...(s.settings.notPairs ?? []), pairKey(p.out, p.in)] } }));
      draw(list.filter((x) => x !== p));
    }));
  };
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });
  draw(pairs);
  document.body.append(backdrop);
}

/**
 * Copies every month's investment totals (all accounts, counted rows only)
 * for the 16-Year Ledger's "Paste from expense tracker" box. Where the
 * clipboard is refused, the text is shown ready to copy by hand.
 */
async function copyForLedger() {
  // a split payment's investment part counts; its other parts do not
  const ledger = buildLedgerExport(expandSplits(app.state.txns));
  const text = JSON.stringify(ledger);
  const months = ledger.months.length;
  try {
    await navigator.clipboard.writeText(text);
    toast(`Copied ${months} month${months === 1 ? '' : 's'} of investments. Paste it on the Ledger's Overview.`);
  } catch {
    const backdrop = document.createElement('div');
    backdrop.className = 'sheet-backdrop';
    backdrop.innerHTML = `<div class="sheet" role="dialog" aria-label="Copy for Ledger"><div class="grab"></div>
      <h2>Copy for Ledger</h2>
      <p class="small muted" style="margin-top:-4px">Select all of this, copy it, and paste it on the Ledger's Overview.</p>
      <textarea readonly rows="6" style="width:100%;font-family:ui-monospace,monospace;font-size:12px"></textarea>
      <button class="btn grow" data-close style="margin-top:10px">Done</button></div>`;
    backdrop.querySelector('textarea')!.value = text;
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });
    backdrop.querySelector('[data-close]')!.addEventListener('click', () => backdrop.remove());
    document.body.append(backdrop);
    backdrop.querySelector('textarea')!.select();
  }
}

type PieMode = 'both' | 'spend' | 'investment';
const PIE_MODES: { value: PieMode; label: string }[] = [
  { value: 'both', label: 'Both' }, { value: 'spend', label: 'Spending' }, { value: 'investment', label: 'Investment' },
];
let pieMode: PieMode = (() => {
  try { const v = localStorage.getItem('pie-mode'); return v === 'spend' || v === 'investment' ? v : 'both'; } catch { return 'both'; }
})();

type CatTotal = { category: string; total: number; count: number; kind: Kind };

/** Where the month's money went: spending categories, investment types, or both in one donut. */
function categoryPanel(spendCats: CatTotal[], investCats: CatTotal[]): string {
  const both = pieMode === 'both';
  // In "Both", investment slices carry a prefix so "Other Investment" and spend categories never blur.
  const items: (CatTotal & { label: string })[] = [
    ...(pieMode !== 'investment' ? spendCats.map((c) => ({ ...c, label: c.category })) : []),
    ...(pieMode !== 'spend' ? investCats.map((c) => ({ ...c, label: both ? `Invest · ${c.category}` : c.category })) : []),
  ];
  const byLabel = new Map(items.map((c) => [c.label, c]));
  const slices = toSlices(items.map((c) => ({ category: c.label, total: c.total, count: c.count })));
  const total = items.reduce((a, c) => a + c.total, 0) || 1;
  const centre = pieMode === 'spend' ? 'spent' : pieMode === 'investment' ? 'invested' : 'spent + invested';
  const empty = pieMode === 'spend' ? 'No spending here.' : pieMode === 'investment' ? 'No investments here.' : 'No spending or investments here.';
  const body = slices.length ? `<div class="pie-wrap">
      ${donutChart(slices, centre)}
      <div class="pie-legend">
        ${slices.map((sl) => {
          const c = byLabel.get(sl.label);
          const link = c ? `data-kind="${c.kind}" data-category="${esc(c.category)}"` : '';
          return `<a class="pie-row" href="#txns" ${link}>
          <i class="sw" style="background:${sl.color}"></i>
          <span class="grow ellipsis">${esc(sl.label)} <span class="tiny">· ${sl.count}</span></span>
          <span class="num">${inr(sl.value)}</span><span class="tiny num pct">${Math.round((sl.value / total) * 100)}%</span>
        </a>`;
        }).join('')}
      </div>
    </div>` : `<p class="muted small">${empty}</p>`;
  const toggle = `<span class="seg-toggle" role="group" aria-label="Show in chart">
    ${PIE_MODES.map((m) => `<button data-pie="${m.value}" class="${pieMode === m.value ? 'on' : ''}" aria-pressed="${pieMode === m.value}">${m.label}</button>`).join('')}
  </span>`;
  const title = pieMode === 'spend' ? 'Spending by category' : pieMode === 'investment' ? 'Investments by type' : 'Spending & investments';
  return section(title, body, { note: 'Tap a category to see its transactions.', action: toggle });
}

const RANGES: { value: number; label: string }[] = [{ value: 6, label: '6M' }, { value: 12, label: '12M' }, { value: 0, label: 'All' }];

function rangeToggle(): string {
  return `<span class="seg-toggle" role="group" aria-label="Months shown">
    ${RANGES.map((r) => `<button data-range="${r.value}" class="${app.filters.range === r.value ? 'on' : ''}" aria-pressed="${app.filters.range === r.value}">${r.label}</button>`).join('')}
  </span>`;
}

function historyTable(rows: MonthSummary[]): string {
  const withData = rows.filter((r) => r.planSet || r.actual.spend || r.actual.invested).reverse();
  if (!withData.length) return '<p class="muted small">No months yet.</p>';
  const diff = (n: number, goodWhenPositive: boolean) =>
    `<div class="tiny ${(n >= 0) === goodWhenPositive ? 'ok' : 'bad'}">${n >= 0 ? '+' : '−'}${inr(Math.abs(n))}</div>`;
  return `<div class="table-scroll"><table class="simple data">
    <thead><tr><th>Month</th><th class="r">Income</th><th class="r">Spent</th><th class="r">Invested</th><th class="r">Saved</th></tr></thead>
    <tbody>${withData.map((r) => `<tr data-month="${r.month}" class="click${r.month === app.filters.month ? ' sel' : ''}">
      <td>${esc(monthShort(r.month))}</td>
      <td class="num r">${r.planSet ? inr(r.plan.income) : '—'}</td>
      <td class="num r">${inr(r.actual.spend)}${r.planSet && r.plan.expectedSpend ? diff(r.spendOver, false) : ''}</td>
      <td class="num r">${inr(r.actual.invested)}${r.planSet && r.plan.expectedInvestment ? diff(r.investOver, true) : ''}</td>
      <td class="num r ${r.planSet ? (r.saved >= 0 ? 'ok' : 'bad') : ''}">${r.planSet ? signed(r.saved) : '—'}</td>
    </tr>`).join('')}</tbody>
  </table></div>
  <p class="tiny" style="margin:8px 0 0">Small figures are the difference from your plan. Tap a row to open that month.</p>`;
}

let monthDefaulted = false;

/* ---------- the new design ---------- */

type TrendMode = 'spent' | 'invested' | 'both';
let trendMode: TrendMode = (() => {
  try { const v = localStorage.getItem('et-trend'); return v === 'invested' || v === 'both' ? v : 'spent'; } catch { return 'spent'; }
})();

const css = (name: string, fallback: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

/** A small ring for the hero: how much of the budget or target is used. */
function ring(actual: number, expected: number, color: string): string {
  const r = 22, c = 2 * Math.PI * r, p = expected > 0 ? actual / expected : 0;
  return `<svg viewBox="0 0 54 54" aria-hidden="true"><circle cx="27" cy="27" r="${r}" fill="none" stroke="rgb(255 255 255 / .1)" stroke-width="6"/>
    <circle class="nx-arc" cx="27" cy="27" r="${r}" fill="none" stroke="${color}" stroke-width="6" stroke-linecap="round" stroke-dasharray="0 ${c.toFixed(1)}"
      data-full="${(c * Math.min(1, p)).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 27 27)" style="filter:drop-shadow(0 0 4px ${color})"/>
    <text x="27" y="31" text-anchor="middle">${expected > 0 ? Math.round(p * 100) + '%' : '—'}</text></svg>`;
}

interface HeroData { s: MonthSummary; month: string; all: boolean; months: string[]; older?: string; newer?: string; count: number; asOf: string }

function heroHtml({ s, month, all, months, older, newer, count, asOf }: HeroData): string {
  const name = all ? 'all time' : monthLabel(month).split(' ')[0];
  const planned = s.planSet;
  const vsPlan = s.saved - s.plannedSaving;
  const big = planned ? Math.abs(s.saved) : s.actual.spend;
  const kick = planned ? (s.saved < 0 ? `Overspent ${all ? '' : 'in '}${name}` : `Saved ${all ? '' : 'in '}${name}`) : `Spent ${all ? '' : 'in '}${name}`;
  const lead = planned
    ? `<b>${s.plan.income > 0 ? Math.round((s.saved / s.plan.income) * 100) : 0}%</b> of your income ${s.saved < 0 ? 'over' : 'kept'} — <b class="${vsPlan >= 0 ? 'nx-good' : 'nx-bad'}">${vsPlan >= 0 ? '+' : '−'}${inr(Math.abs(vsPlan))}</b> ${vsPlan >= 0 ? 'more' : 'less'} than the plan. `
    : 'Set your income and targets to see what you saved. ';
  const gauge = (label: string, actual: number, expected: number, color: string, over: number, good: boolean) => `<div class="nx-mg">${ring(actual, expected, color)}<div>
      <div class="t">${label}</div><div class="v num"><span data-count="${Math.round(actual)}">${inr(0)}</span>${expected > 0 ? ` <span class="of">/ ${inr(expected)}</span>` : ''}</div>
      ${expected > 0 ? `<span class="pill ${good ? 'ok' : 'bad'}">${good ? '✓' : '▲'} ${inr(Math.abs(over))} ${label.startsWith('Spending') ? (good ? 'under' : 'over') : (good ? 'ahead' : 'short')}</span>` : '<span class="tiny">no target</span>'}</div></div>`;
  return `<header class="nx-hero"><div class="nx-hin">
    <div class="nx-top"><h1>Overview</h1>
      <div class="month-switch" role="group" aria-label="Month">
        <button class="icon-btn" data-goto="${older ?? ''}" ${older ? '' : 'disabled'} aria-label="Previous month">‹</button>
        <select data-filter="month" aria-label="Month">
          <option value="all" ${all ? 'selected' : ''}>All time</option>
          ${months.map((m) => `<option value="${m}" ${month === m ? 'selected' : ''}>${monthLabel(m)}</option>`).join('')}
        </select>
        <button class="icon-btn" data-goto="${newer ?? ''}" ${newer ? '' : 'disabled'} aria-label="Next month">›</button>
      </div>
      ${accountSelect()}
      <button class="nx-ib" data-nx-theme title="Light or dark" aria-label="Switch between light and dark"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg></button>
      <button class="nx-add" data-add>＋ Add</button></div>
    <div class="nx-hgrid">
      <div>
        <div class="nx-kick">${esc(kick)}</div>
        <div class="nx-big"><span data-count="${Math.round(big)}">${inr(0)}</span>${planned ? `<small>of ${inr(s.plan.income)} income</small>` : ''}</div>
        <p class="nx-lead">${lead}${count} transaction${count === 1 ? '' : 's'}${asOf ? `, statements up to ${esc(dayLabel(asOf))}` : ''}.</p>
        ${planned ? `<div class="nx-minig">
          ${gauge('Spending budget', s.actual.spend, s.plan.expectedSpend, css('--k-spend', '#f0a35c'), s.spendOver, s.spendOver <= 0)}
          ${gauge('Investing target', s.actual.invested, s.plan.expectedInvestment, css('--k-investment', '#6fb3ee'), s.investOver, s.investOver >= 0)}
        </div><button class="nx-link" data-plan>Edit plan</button>` : `<button class="nx-add" data-plan style="margin-top:16px">Set income &amp; targets</button>`}
        <button class="nx-askbar" data-nx-ask><span class="sp">✦</span><span class="grow">Ask about ${esc(all ? 'your money' : name)} — “where did my money go?”</span><kbd>Ask</kbd></button>
      </div>
      <div class="nx-flow" id="nx-flow"><canvas></canvas>
        <div class="nx-src">${planned ? `Income<b>${inr(s.plan.income)}</b>` : `Out<b>${inr(s.actual.spend + s.actual.invested)}</b>`}</div>
        ${jarsOf(s).map((j, i) => `<div class="nx-jarl" data-jar="${i}" style="--c:${j.color}"><span>${esc(j.label)}</span><b class="num">${j.value < 0 ? '−' : ''}${inr(Math.abs(j.value))}</b>
          <small>${planned && s.plan.income > 0 ? `${Math.round((j.value / s.plan.income) * 100)}% of income` : ''}</small></div>`).join('')}
      </div>
    </div></div></header>`;
}

function jarsOf(s: MonthSummary) {
  const jars = [
    { label: 'Spent', value: Math.max(0, s.actual.spend), color: css('--k-spend', '#f0a35c') },
    { label: 'Invested', value: s.actual.invested, color: css('--k-investment', '#6fb3ee') },
  ];
  if (s.planSet) jars.push({ label: s.saved < 0 ? 'Overspent' : 'Saved', value: s.saved, color: s.saved < 0 ? css('--bad', '#ef7a66') : css('--nx-saved', '#4cc38a') });
  return jars;
}

function trendPanel(history: MonthSummary[], month: string, allCount: number): string {
  const points = (pick: (r: MonthSummary) => [number, number]): MonthPoint[] =>
    history.map((r) => { const [actual, expected] = pick(r); return { month: r.month, actual, expected, planSet: r.planSet }; });
  const chart = !history.length ? '<p class="muted small">No data yet.</p>'
    : trendMode === 'both' ? trendChart(history.map((r) => ({ month: r.month, spend: Math.max(r.actual.spend, 0), invest: r.actual.invested })), month, true)
    : trendMode === 'invested' ? monthlyChart(points((r) => [r.actual.invested, r.plan.expectedInvestment]), month, kindVar('investment'), 'Invested')
    : monthlyChart(points((r) => [Math.max(r.actual.spend, 0), r.plan.expectedSpend]), month, kindVar('spend'), 'Spent');
  const tabs = `<span class="seg-toggle" role="group" aria-label="Chart">${([['spent', 'Spent'], ['invested', 'Invested'], ['both', 'Both']] as [TrendMode, string][])
    .map(([v, l]) => `<button data-trend="${v}" class="${trendMode === v ? 'on' : ''}" aria-pressed="${trendMode === v}">${l}</button>`).join('')}</span>`;
  const note = trendMode === 'both' ? 'Spent and invested each month. Hover a month for its numbers; tap to open it.'
    : `${trendMode === 'spent' ? 'Spending against your budget' : 'Investing against your target'} each month. Tap a month to open it.`;
  return section(`${history.length} month${history.length === 1 ? '' : 's'}`, chart, { note: `${note} Showing ${history.length} of ${allCount}.`, action: `<span class="nx-acts">${tabs}${rangeToggle()}</span>` });
}

/** Numbers count up, rings sweep, cards rise in as they come into view and lean a little towards the pointer. */
let seenMonth = '';
function animateNew(root: HTMLElement, key: string) {
  const first = key !== seenMonth;
  seenMonth = key;
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  root.querySelectorAll<HTMLElement>('[data-count]').forEach((el) => {
    const to = Number(el.dataset.count);
    if (!first || calm) { el.textContent = inr(to); return; }
    const t0 = performance.now();
    const step = (now: number) => { const k = Math.min(1, (now - t0) / 1300); el.textContent = inr(to * (1 - Math.pow(1 - k, 4))); if (k < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  });
  const arcs = root.querySelectorAll<SVGCircleElement>('.nx-arc');
  if (!first || calm) arcs.forEach((a) => { a.style.transition = 'none'; a.setAttribute('stroke-dasharray', a.dataset.full!); });
  else setTimeout(() => arcs.forEach((a) => a.setAttribute('stroke-dasharray', a.dataset.full!)), 80);
  const cards = root.querySelectorAll<HTMLElement>('.nx-grid .panel, .nx-more .panel');
  if (!first || calm) cards.forEach((c) => c.classList.add('in'));
  else {
    const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { threshold: 0.08 });
    cards.forEach((c, i) => { c.style.transitionDelay = `${(i % 2) * 0.08}s`; io.observe(c); });
  }
  if (matchMedia('(hover: hover) and (pointer: fine)').matches && !calm) cards.forEach((c) => {
    c.addEventListener('pointermove', (e) => {
      const r = c.getBoundingClientRect(), x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
      c.classList.add('tilt');
      c.style.transitionDelay = '0s';
      c.style.setProperty('--ry', `${((x - 0.5) * 3).toFixed(2)}deg`);
      c.style.setProperty('--rx', `${((0.5 - y) * 3).toFixed(2)}deg`);
      c.style.setProperty('--gx', `${x * 100}%`);
      c.style.setProperty('--gy', `${y * 100}%`);
    });
    c.addEventListener('pointerleave', () => { c.classList.remove('tilt'); c.style.setProperty('--rx', '0deg'); c.style.setProperty('--ry', '0deg'); });
  });
}

export function renderDashboard(root: HTMLElement) {
  const { state, filters } = app;
  if (!state.txns.length) {
    root.innerHTML = `<div class="page-head"><div><h1>Overview</h1><p class="page-sub">Nothing here yet</p></div>
        <button class="btn primary" data-add>+ Add transaction</button></div>
      <section class="panel">
        <header class="panel-head"><div><h2>Get started</h2></div></header>
        <ol class="steps">
          <li><strong>Upload a statement.</strong> PDF or Excel from HDFC, ICICI and most other banks - bank accounts and credit cards.</li>
          <li><strong>Set your monthly plan.</strong> Income, expected spend and expected investment.</li>
          <li><strong>Add cash spends</strong> by hand whenever you need to.</li>
        </ol>
        <div class="row wrap" style="gap:8px">
          <a class="btn primary" href="#upload">Upload statement</a>
          <button class="btn" data-plan>Set income &amp; targets</button>
        </div>
      </section>`;
    root.querySelector('[data-plan]')!.addEventListener('click', () => openPlanSheet(currentMonth()));
    root.querySelector('[data-add]')!.addEventListener('click', () => openManualSheet());
    return;
  }

  const months = availableMonths();
  // Opens on the latest month; "All time" stays once you pick it.
  if (!monthDefaulted || (filters.month !== 'all' && !months.includes(filters.month))) {
    filters.month = months[0];
    monthDefaulted = true;
  }
  const month = filters.month;
  const all = month === 'all';
  const idx = months.indexOf(month);
  const newer = all ? undefined : months[idx - 1];
  const older = all ? undefined : months[idx + 1];

  // The Overview follows only the account picker; search and type chips belong to the Transactions list.
  // Totals see a split payment as its parts; subscriptions and repeat payments look at whole payments.
  const whole = applyFilters(state.txns, { ...filters, month: 'all', search: '', tag: '' }, { kind: false });
  const scoped = expandSplits(whole);
  const allMonths = [...months].reverse();
  const inRange = filters.range ? allMonths.slice(-filters.range) : allMonths;
  const history = inRange.map((m) => summarize(state, m, scoped));
  const s = all ? summarizeAll(state, months, scoped) : summarize(state, month, scoped);
  const prev = older ? summarize(state, older, scoped) : undefined;
  const txns = all ? scoped : scoped.filter((t) => t.date.startsWith(month));
  const of = (k: Kind, dir: 'debit' | 'credit') => txns.filter((t) => t.kind === k && t.direction === dir && !t.excluded);
  const review = txns.filter((t) => t.category === 'Uncategorised');
  const unpaired = unpairedTransfers(state.txns, state.settings.notPairs);
  // alerts for the month on screen ("All time": the latest month)
  const alertMonth = all ? months[0] : month;
  const alerts = spendAlerts(scoped, alertMonth, state.settings.dismissedAlerts ?? []);
  // Card bill payments count as spending; they appear as their own category.
  const spendCats = [
    ...byCategory(of('spend', 'debit')).map((c) => ({ ...c, kind: 'spend' as Kind })),
    ...byCategory(of('cc_bill', 'debit').filter((t) => !t.pairId)).map((c) => ({ ...c, kind: 'cc_bill' as Kind })),
  ].sort((a, b) => b.total - a.total);
  // Money put into each investment type this month (the pie shows what went in, not redemptions).
  const investedCats = byCategory(of('investment', 'debit')).map((c) => ({ ...c, kind: 'investment' as Kind }));
  const invCats = byCategory([...of('investment', 'debit'), ...of('investment', 'credit')]
    .map((t) => ({ ...t, amount: t.direction === 'debit' ? t.amount : -t.amount })));
  const points = (pick: (r: MonthSummary) => [number, number]): MonthPoint[] =>
    history.map((r) => { const [actual, expected] = pick(r); return { month: r.month, actual, expected, planSet: r.planSet }; });
  const anyPlan = history.some((r) => r.planSet);

  const movements = [
    { kind: 'transfer' as Kind, label: 'Self transfers', value: s.actual.transfers, note: 'Between your own accounts' },
    { kind: 'cc_bill' as Kind, label: 'Card bills, spending from the card', value: s.actual.cardCovered, note: 'Its purchases come from the card statement' },
    { kind: 'ignore' as Kind, label: 'Not counted by you', value: s.actual.excluded, note: 'Rows with Counted unticked', filter: 'excluded' },
    { kind: 'investment' as Kind, label: 'Redeemed investments', value: s.actual.redeemed, note: 'Money back from investments' },
    { kind: 'income' as Kind, label: 'Credits in statements', value: s.actual.credits, note: 'Your income entry is used instead' },
  ].filter((m) => m.value > 0);

  const asOf = whole.reduce((a, t) => (t.date > a ? t.date : a), '');
  const banners = `
    ${review.length ? `<a class="banner" href="#txns" data-kind="review"><span><strong>${review.length}</strong> transaction${review.length > 1 ? 's' : ''} need${review.length > 1 ? '' : 's'} a category</span><span>Review ›</span></a>` : ''}
    ${unpaired.length ? `<button class="banner" data-pairs style="width:100%;border:0;cursor:pointer;text-align:left"><span><strong>${unpaired.length}</strong> possible self transfer${unpaired.length > 1 ? 's' : ''} between your accounts ${unpaired.length > 1 ? 'aren’t' : 'isn’t'} marked</span><span>Review ›</span></button>` : ''}
    ${alerts.length ? `<button class="banner alert-banner" data-alerts style="width:100%;border:0;cursor:pointer;text-align:left"><span><strong>${alerts.length}</strong> unusual spend${alerts.length > 1 ? 's' : ''} in ${esc(monthLabel(alertMonth))}: ${esc(alerts[0].text)}${alerts.length > 1 ? ` and ${alerts.length - 1} more` : ''}</span><span>Review ›</span></button>` : ''}`;
  const notCounted = section('Not counted as spend', movements.length ? `<ul class="movements">${movements.map((m) => `
        <li><a href="#txns" data-kind="${'filter' in m ? m.filter : m.kind}"><span class="dot" style="background:${kindVar(m.kind)}"></span>
          <span class="grow"><span class="mv-label">${esc(m.label)}</span><span class="tiny">${esc(m.note)}</span></span>
          <span class="num">${inr(m.value)}</span></a></li>`).join('')}</ul>` : '<p class="muted small">Nothing here.</p>');
  const byType = section('Investments by type', invCats.length ? `<table class="simple data">
        <thead><tr><th>Type</th><th class="r">Net invested</th></tr></thead>
        <tbody>${invCats.map((c) => `<tr><td><a href="#txns" data-kind="investment" data-category="${esc(c.category)}">${esc(c.category)}</a></td><td class="num r">${signed(c.total)}</td></tr>`).join('')}</tbody>
      </table>
      <p class="tiny" style="margin:8px 0 0">Negative means more was redeemed than invested.</p>` : '<p class="muted small">No investments here.</p>',
    { action: scoped.some((t) => t.kind === 'investment') ? '<button class="btn small-btn" data-ledger-copy title="Copy every month\'s investment totals to paste into your 16-Year Ledger">Copy for Ledger</button>' : '' });
  const isNew = getLook() === 'new';
  const rec = isNew ? recurringPanel(whole, true) : '';
  const subs = isNew ? subscriptionsPanel(whole) : '';

  if (isNew) root.innerHTML = `
    ${heroHtml({ s, month, all, months, older, newer, count: txns.length, asOf })}
    <div class="nx-banners">${banners}</div>
    <div class="nx-grid">
      <div class="nx-c7">${categoryPanel(spendCats, investedCats)}</div>
      ${all ? '' : `<div class="nx-c5">${reviewPanel(month, scoped)}</div>`}
      <div class="${all ? 'nx-c5' : 'nx-c7'}">${trendPanel(history, month, allMonths.length)}</div>
      ${rec || subs ? `<div class="nx-c5">${rec || subs}</div>` : ''}
      ${rec && subs ? `<div class="nx-c6">${subs}</div>` : ''}
      <div class="${rec && subs ? 'nx-c6' : 'nx-c12'}">${section('Monthly history', historyTable(history), { action: rangeToggle() })}</div>
    </div>
    <details class="nx-more"><summary>＋ More for ${esc(all ? 'all time' : monthLabel(month))}<span>Month at a glance · Tags · Not counted · Investments by type</span></summary>
      <div class="grid-2">${glancePanel(s, txns, prev, spendCats)}${tagsPanel(txns, all)}${notCounted}${byType}</div></details>`;
  else root.innerHTML = `
    <div class="page-head">
      <div><h1>Overview</h1><p class="page-sub">${txns.length} transaction${txns.length === 1 ? '' : 's'} ${all ? `across ${months.length} month${months.length === 1 ? '' : 's'}` : `in ${esc(monthLabel(month))}`}</p></div>
      <button class="btn primary" data-add>+ Add transaction</button>
    </div>

    <div class="toolbar">
      <div class="month-switch" role="group" aria-label="Month">
        <button class="icon-btn" data-goto="${older ?? ''}" ${older ? '' : 'disabled'} aria-label="Previous month">‹</button>
        <select data-filter="month" aria-label="Month">
          <option value="all" ${all ? 'selected' : ''}>All time</option>
          ${months.map((m) => `<option value="${m}" ${month === m ? 'selected' : ''}>${monthLabel(m)}</option>`).join('')}
        </select>
        <button class="icon-btn" data-goto="${newer ?? ''}" ${newer ? '' : 'disabled'} aria-label="Next month">›</button>
      </div>
      ${accountSelect()}
    </div>

    ${banners}

    ${kpis(s)}

    <div class="grid-2">
      ${budgetPanel(s)}
      ${glancePanel(s, txns, prev, spendCats)}
      ${all ? '' : reviewPanel(month, scoped)}
      ${recurringPanel(whole)}
      ${subscriptionsPanel(whole)}
      ${categoryPanel(spendCats, investedCats)}
      ${tagsPanel(txns, all)}
      ${section('Spend and investment trend', history.length
        ? ((pts) => `<div class="trend-narrow">${trendChart(pts, month)}</div><div class="trend-wide">${trendChart(pts, month, true)}</div>`)(
            history.map((r) => ({ month: r.month, spend: Math.max(r.actual.spend, 0), invest: r.actual.invested })))
        : '<p class="muted small">No data yet.</p>', { note: `Showing ${history.length} of ${allMonths.length} month${allMonths.length === 1 ? '' : 's'}. Hover a month for its numbers; tap to open it.`, action: rangeToggle(), wide: true })}
    </div>

    ${anyPlan ? `<div class="grid-2">
      ${section('Spent vs budget', monthlyChart(points((r) => [Math.max(r.actual.spend, 0), r.plan.expectedSpend]), month, kindVar('spend'), 'Spent'))}
      ${section('Invested vs target', monthlyChart(points((r) => [r.actual.invested, r.plan.expectedInvestment]), month, kindVar('investment'), 'Invested'))}
    </div>` : ''}

    <div class="grid-2">
      ${section('Not counted as spend', movements.length ? `<ul class="movements">${movements.map((m) => `
        <li><a href="#txns" data-kind="${'filter' in m ? m.filter : m.kind}"><span class="dot" style="background:${kindVar(m.kind)}"></span>
          <span class="grow"><span class="mv-label">${esc(m.label)}</span><span class="tiny">${esc(m.note)}</span></span>
          <span class="num">${inr(m.value)}</span></a></li>`).join('')}</ul>` : '<p class="muted small">Nothing here.</p>')}
      ${section('Investments by type', invCats.length ? `<table class="simple data">
        <thead><tr><th>Type</th><th class="r">Net invested</th></tr></thead>
        <tbody>${invCats.map((c) => `<tr><td><a href="#txns" data-kind="investment" data-category="${esc(c.category)}">${esc(c.category)}</a></td><td class="num r">${signed(c.total)}</td></tr>`).join('')}</tbody>
      </table>
      <p class="tiny" style="margin:8px 0 0">Negative means more was redeemed than invested.</p>` : '<p class="muted small">No investments here.</p>',
        { action: scoped.some((t) => t.kind === 'investment') ? '<button class="btn small-btn" data-ledger-copy title="Copy every month\'s investment totals to paste into your 16-Year Ledger">Copy for Ledger</button>' : '' })}
    </div>

    ${section('Monthly history', historyTable(history), { action: rangeToggle() })}
  `;

  bindFilterBar(root);
  root.querySelector('[data-add]')!.addEventListener('click', () => openManualSheet(undefined, all || month === currentMonth() ? undefined : `${month}-01`));
  // Plans are per month; from "All time" the button edits the latest month's.
  root.querySelectorAll('[data-plan]').forEach((b) => b.addEventListener('click', () => openPlanSheet(all ? months[0] : month)));
  root.querySelectorAll<HTMLElement>('[data-goto]').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.goto) { filters.month = b.dataset.goto; render(); }
  }));
  root.querySelector('[data-ledger-copy]')?.addEventListener('click', () => void copyForLedger());
  root.querySelector('[data-pairs]')?.addEventListener('click', () => openPairsSheet(unpaired));
  root.querySelector('[data-alerts]')?.addEventListener('click', () => openAlertsSheet(alertMonth, alerts));
  root.querySelectorAll<HTMLElement>('[data-ai-review]').forEach((b) => b.addEventListener('click', async () => {
    const m = b.dataset.aiReview!;
    if (b.dataset.again) { try { const c = JSON.parse(localStorage.getItem('et-ai-month-review') || '{}'); delete c[m]; localStorage.setItem('et-ai-month-review', JSON.stringify(c)); } catch { /* ignore */ } }
    reviewBusy = m; reviewError = null; render();
    try { await aiMonthReview(app.state, m, scoped); }
    catch (e) { reviewError = { month: m, msg: (e as Error).message }; }
    finally { reviewBusy = ''; render(); }
  }));
  root.querySelector<HTMLElement>('[data-open-odd]')?.addEventListener('click', (e) => openPicked(`Stand-out payments, ${monthShort(month)}`, (e.currentTarget as HTMLElement).dataset.openOdd!.split(',')));
  root.querySelectorAll<HTMLElement>('[data-recurring]').forEach((el) => el.addEventListener('click', (e) => {
    e.preventDefault();
    const key = el.dataset.recurring!;
    const rows = scoped.filter((t) => t.merchantKey === key && t.direction === 'debit');
    openPicked(rows[0]?.merchantName ?? 'Recurring', rows.map((t) => t.id));
  }));
  root.querySelectorAll<HTMLElement>('[data-sub-open]').forEach((el) => el.addEventListener('click', (e) => {
    e.preventDefault();
    const rows = scoped.filter((t) => t.merchantKey === el.dataset.subOpen && t.direction === 'debit');
    openPicked(rows[0]?.merchantName ?? 'Subscription', rows.map((t) => t.id));
  }));
  root.querySelectorAll<HTMLElement>('[data-sub-mark]').forEach((b) => b.addEventListener('click', async () => {
    const key = b.dataset.sub!, mark = b.dataset.subMark as 'keep' | 'cancel';
    const cur = app.state.settings.subscriptionMarks?.[key];
    const today = new Date().toISOString().slice(0, 10);
    await update((st) => {
      const marks = { ...(st.settings.subscriptionMarks ?? {}) };
      if (cur?.mark === mark) delete marks[key]; else marks[key] = { mark, at: today };
      return { ...st, settings: { ...st.settings, subscriptionMarks: marks } };
    });
    toast(cur?.mark === mark ? 'Choice cleared' : mark === 'cancel' ? 'Marked to cancel — you will see it here if it is charged again' : 'Marked to keep');
  }));
  root.querySelectorAll<HTMLElement>('[data-pie]').forEach((b) => b.addEventListener('click', () => {
    pieMode = b.dataset.pie as PieMode;
    try { localStorage.setItem('pie-mode', pieMode); } catch { /* remembered for this visit only */ }
    render();
  }));
  root.querySelectorAll<HTMLElement>('[data-trend]').forEach((b) => b.addEventListener('click', () => {
    trendMode = b.dataset.trend as TrendMode;
    try { localStorage.setItem('et-trend', trendMode); } catch { /* remembered for this visit only */ }
    render();
  }));
  root.querySelector('[data-nx-theme]')?.addEventListener('click', () => {
    const dark = getTheme() === 'dark' || (getTheme() === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    setTheme(dark ? 'light' : 'dark');
    render();
  });
  root.querySelector('[data-nx-ask]')?.addEventListener('click', () => openDock('et'));
  if (isNew) {
    animateNew(root, `${month}|${filters.account}`);
    const box = root.querySelector<HTMLElement>('#nx-flow');
    if (box) void import('./jars3d').then(({ mountJars }) => { if (box.isConnected) mountJars(box, s.planSet ? s.plan.income : s.actual.spend + s.actual.invested, jarsOf(s)); })
      .catch(() => box.classList.add('no3d'));
  }
  root.querySelectorAll<HTMLElement>('[data-range]').forEach((b) => b.addEventListener('click', () => {
    filters.range = Number(b.dataset.range);
    render();
  }));
  root.querySelectorAll<HTMLElement>('[data-month]').forEach((el) => {
    const pick = () => { filters.month = el.dataset.month!; render(); };
    el.addEventListener('click', pick);
    el.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') pick(); });
  });
  root.querySelectorAll<HTMLElement>('[data-kind]').forEach((el) => {
    const go = (e: Event) => {
      e.preventDefault();
      filters.kind = el.dataset.kind as Kind | 'review';
      filters.category = el.dataset.category ?? '';
      filters.tag = el.dataset.tag ?? '';
      navigate('#txns');
    };
    el.addEventListener('click', go);
    el.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') go(e); });
  });
}
