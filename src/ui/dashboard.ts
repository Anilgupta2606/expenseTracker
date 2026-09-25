import type { Kind, Txn } from '../types';
import { currentMonth, summarize, type MonthSummary } from '../plans';
import { app, navigate, render } from './app';
import { donutChart, monthlyChart, shortMonth, toSlices, trendChart, type MonthPoint } from './charts';
import { applyFilters, esc, inr, kindVar, monthLabel, monthShort } from './format';
import { MANUAL_ACCOUNT, openManualSheet } from './manualSheet';
import { openPlanSheet } from './planSheet';

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
    ${state.accounts.map((a) => `<option value="${esc(a.id)}" ${filters.account === a.id ? 'selected' : ''}>${esc(a.bank)} ••${esc(a.number.slice(-4))}</option>`).join('')}
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

function section(title: string, body: string, opts: { note?: string; action?: string } = {}): string {
  return `<section class="panel">
    <header class="panel-head"><div><h2>${esc(title)}</h2>${opts.note ? `<p class="panel-note">${opts.note}</p>` : ''}</div>${opts.action ?? ''}</header>
    ${body}
  </section>`;
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
    ${tile('income', 'Income', s.planSet ? inr(plan.income) : '—', s.planSet ? 'Set by you' : '<button class="link-btn" data-plan>Set income</button>')}
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
  const spendTxns = txns.filter((t) => (t.kind === 'spend' || t.kind === 'cc_bill') && t.direction === 'debit' && !t.excluded);
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

function categoryPanel(spendCats: { category: string; total: number; count: number }[]): string {
  const slices = toSlices(spendCats);
  const total = spendCats.reduce((a, c) => a + c.total, 0) || 1;
  const body = slices.length ? `<div class="pie-wrap">
      ${donutChart(slices, 'spent')}
      <div class="pie-legend">
        ${slices.map((sl) => `<a class="pie-row" href="#txns" data-kind="spend" ${sl.label.startsWith('Other (') ? '' : `data-category="${esc(sl.label)}"`}>
          <i class="sw" style="background:${sl.color}"></i>
          <span class="grow ellipsis">${esc(sl.label)} <span class="tiny">· ${sl.count}</span></span>
          <span class="num">${inr(sl.value)}</span><span class="tiny num pct">${Math.round((sl.value / total) * 100)}%</span>
        </a>`).join('')}
      </div>
    </div>` : '<p class="muted small">No spending in this month.</p>';
  return section('Spending by category', body, { note: 'Tap a category to see its transactions.' });
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

export function renderDashboard(root: HTMLElement) {
  const { state, filters } = app;
  if (!state.txns.length) {
    root.innerHTML = `<div class="page-head"><div><h1>Overview</h1><p class="page-sub">Nothing here yet</p></div>
        <button class="btn primary" data-add>+ Add transaction</button></div>
      <section class="panel">
        <header class="panel-head"><div><h2>Get started</h2></div></header>
        <ol class="steps">
          <li><strong>Upload a statement.</strong> PDF or Excel from HDFC, ICICI and most other banks.</li>
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
  if (!monthDefaulted || filters.month === 'all' || !months.includes(filters.month)) {
    filters.month = months[0];
    monthDefaulted = true;
  }
  const month = filters.month;
  const idx = months.indexOf(month);
  const newer = months[idx - 1];
  const older = months[idx + 1];

  // The Overview follows only the account picker; search and type chips belong to the Transactions list.
  const scoped = applyFilters(state.txns, { ...filters, month: 'all', search: '' }, { kind: false });
  const allMonths = [...months].reverse();
  const inRange = filters.range ? allMonths.slice(-filters.range) : allMonths;
  const history = inRange.map((m) => summarize(state, m, scoped));
  const s = summarize(state, month, scoped);
  const prev = older ? summarize(state, older, scoped) : undefined;
  const txns = scoped.filter((t) => t.date.startsWith(month));
  const of = (k: Kind, dir: 'debit' | 'credit') => txns.filter((t) => t.kind === k && t.direction === dir && !t.excluded);
  const review = txns.filter((t) => t.category === 'Uncategorised');
  // Card bill payments count as spending; they appear as their own category.
  const spendCats = byCategory([...of('spend', 'debit'), ...of('cc_bill', 'debit')]);
  const invCats = byCategory([...of('investment', 'debit'), ...of('investment', 'credit')]
    .map((t) => ({ ...t, amount: t.direction === 'debit' ? t.amount : -t.amount })));
  const points = (pick: (r: MonthSummary) => [number, number]): MonthPoint[] =>
    history.map((r) => { const [actual, expected] = pick(r); return { month: r.month, actual, expected, planSet: r.planSet }; });
  const anyPlan = history.some((r) => r.planSet);

  const movements = [
    { kind: 'transfer' as Kind, label: 'Self transfers', value: s.actual.transfers, note: 'Between your own accounts' },
    { kind: 'ignore' as Kind, label: 'Not counted by you', value: s.actual.excluded, note: 'Rows with Counted unticked', filter: 'excluded' },
    { kind: 'investment' as Kind, label: 'Redeemed investments', value: s.actual.redeemed, note: 'Money back from investments' },
    { kind: 'income' as Kind, label: 'Credits in statements', value: s.actual.credits, note: 'Your income entry is used instead' },
  ].filter((m) => m.value > 0);

  root.innerHTML = `
    <div class="page-head">
      <div><h1>Overview</h1><p class="page-sub">${txns.length} transaction${txns.length === 1 ? '' : 's'} in ${esc(monthLabel(month))}</p></div>
      <button class="btn primary" data-add>+ Add transaction</button>
    </div>

    <div class="toolbar">
      <div class="month-switch" role="group" aria-label="Month">
        <button class="icon-btn" data-goto="${older ?? ''}" ${older ? '' : 'disabled'} aria-label="Previous month">‹</button>
        <select data-filter="month" aria-label="Month">
          ${months.map((m) => `<option value="${m}" ${month === m ? 'selected' : ''}>${monthLabel(m)}</option>`).join('')}
        </select>
        <button class="icon-btn" data-goto="${newer ?? ''}" ${newer ? '' : 'disabled'} aria-label="Next month">›</button>
      </div>
      ${accountSelect()}
    </div>

    ${review.length ? `<a class="banner" href="#txns" data-kind="review"><span><strong>${review.length}</strong> transaction${review.length > 1 ? 's' : ''} need${review.length > 1 ? '' : 's'} a category</span><span>Review ›</span></a>` : ''}

    ${kpis(s)}

    <div class="grid-2">
      ${budgetPanel(s)}
      ${glancePanel(s, txns, prev, spendCats)}
      ${categoryPanel(spendCats)}
      ${section('Spend and investment trend', history.length
        ? trendChart(history.map((r) => ({ month: r.month, spend: Math.max(r.actual.spend, 0), invest: r.actual.invested })), month)
        : '<p class="muted small">No data yet.</p>', { note: `Showing ${history.length} of ${allMonths.length} month${allMonths.length === 1 ? '' : 's'}. Tap a month to open it.`, action: rangeToggle() })}
    </div>

    ${anyPlan ? `<div class="grid-2">
      ${section('Spent vs budget', monthlyChart(points((r) => [Math.max(r.actual.spend, 0), r.plan.expectedSpend]), month, kindVar('spend'), 'Spent'))}
      ${section('Invested vs target', monthlyChart(points((r) => [r.actual.invested, r.plan.expectedInvestment]), month, kindVar('investment'), 'Invested'))}
    </div>` : ''}

    <div class="grid-2">
      ${section('Not counted as spend', movements.length ? `<ul class="movements">${movements.map((m) => `
        <li><a href="#txns" data-kind="${'filter' in m ? m.filter : m.kind}"><span class="dot" style="background:${kindVar(m.kind)}"></span>
          <span class="grow"><span class="mv-label">${esc(m.label)}</span><span class="tiny">${esc(m.note)}</span></span>
          <span class="num">${inr(m.value)}</span></a></li>`).join('')}</ul>` : '<p class="muted small">Nothing this month.</p>')}
      ${section('Investments by type', invCats.length ? `<table class="simple data">
        <thead><tr><th>Type</th><th class="r">Net invested</th></tr></thead>
        <tbody>${invCats.map((c) => `<tr><td><a href="#txns" data-kind="investment" data-category="${esc(c.category)}">${esc(c.category)}</a></td><td class="num r">${signed(c.total)}</td></tr>`).join('')}</tbody>
      </table>
      <p class="tiny" style="margin:8px 0 0">Negative means more was redeemed than invested.</p>` : '<p class="muted small">No investments this month.</p>')}
    </div>

    ${section('Monthly history', historyTable(history), { action: rangeToggle() })}
  `;

  bindFilterBar(root);
  root.querySelector('[data-add]')!.addEventListener('click', () => openManualSheet(undefined, month === currentMonth() ? undefined : `${month}-01`));
  root.querySelectorAll('[data-plan]').forEach((b) => b.addEventListener('click', () => openPlanSheet(month)));
  root.querySelectorAll<HTMLElement>('[data-goto]').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.goto) { filters.month = b.dataset.goto; render(); }
  }));
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
      navigate('#txns');
    };
    el.addEventListener('click', go);
    el.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') go(e); });
  });
}
