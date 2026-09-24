import type { Kind, Txn } from '../types';
import { currentMonth, summarize, type MonthSummary } from '../plans';
import { app, navigate, render } from './app';
import { donutChart, monthlyChart, shortMonth, toSlices, trendChart, type MonthPoint } from './charts';
import { applyFilters, esc, inr, kindVar, monthLabel, monthShort } from './format';
import { openManualSheet } from './manualSheet';
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

/** Months that have transactions or a plan you entered for that month. Newest first. */
export function availableMonths(): string[] {
  const { txns, plans } = app.state;
  const months = [...new Set([...txns.map((t) => t.date.slice(0, 7)), ...Object.keys(plans)])].sort().reverse();
  return months.length ? months : [currentMonth()];
}

export function filterBar(allowAll = true): string {
  const { state, filters } = app;
  const months = availableMonths();
  return `
    <div class="row" style="margin-bottom:12px">
      <select data-filter="month" aria-label="Month" class="grow">
        ${allowAll ? `<option value="all" ${filters.month === 'all' ? 'selected' : ''}>All time</option>` : ''}
        ${months.map((m) => `<option value="${m}" ${filters.month === m ? 'selected' : ''}>${monthLabel(m)}</option>`).join('')}
      </select>
      ${state.accounts.length + (state.txns.some((t) => t.accountId === 'MANUAL') ? 1 : 0) > 1 ? `
      <select data-filter="account" aria-label="Account" class="grow">
        <option value="all">All accounts</option>
        ${state.accounts.map((a) => `<option value="${esc(a.id)}" ${filters.account === a.id ? 'selected' : ''}>${esc(a.bank)} ••${esc(a.number.slice(-4))}</option>`).join('')}
        ${state.txns.some((t) => t.accountId === 'MANUAL') ? `<option value="MANUAL" ${filters.account === 'MANUAL' ? 'selected' : ''}>Added by hand</option>` : ''}
      </select>` : ''}
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

function meter(actual: number, expected: number, color: string): string {
  if (expected <= 0) return '';
  const pct = Math.min(actual / expected, 1.5);
  return `<div class="meter" aria-hidden="true">
    <div class="meter-fill" style="width:${(Math.min(pct, 1) / 1.5) * 100}%;background:${color}"></div>
    ${pct > 1 ? `<div class="meter-over" style="left:${(1 / 1.5) * 100}%;width:${((pct - 1) / 1.5) * 100}%"></div>` : ''}
    <div class="meter-target" style="left:${(1 / 1.5) * 100}%"></div>
  </div>`;
}

function summaryCard(s: MonthSummary): string {
  const { plan, actual } = s;
  if (!s.planSet) {
    return `<div class="card">
      <h2>Your plan for ${esc(monthLabel(s.month))}</h2>
      <p class="small muted">Add your income and how much you expect to spend and invest. The app then shows whether you overspent or saved.</p>
      <button class="btn primary" data-plan>Set income &amp; targets</button>
    </div>`;
  }
  const saved = s.saved >= 0;
  const spendLine = plan.expectedSpend > 0
    ? (s.spendOver > 0 ? `<span class="pill bad">▲ ${inr(s.spendOver)} over</span>` : `<span class="pill ok">▼ ${inr(-s.spendOver)} under</span>`)
    : '<span class="pill">No target</span>';
  const investLine = plan.expectedInvestment > 0
    ? (s.investOver >= 0 ? `<span class="pill ok">✓ ${inr(s.investOver)} ahead</span>` : `<span class="pill warn">▼ ${inr(-s.investOver)} short</span>`)
    : '<span class="pill">No target</span>';
  const vsPlan = s.saved - s.plannedSaving;

  return `<div class="card summary">
    <div class="row between">
      <span class="eyebrow">${esc(monthLabel(s.month))}</span>
      <button class="link-btn" data-plan>Edit plan</button>
    </div>
    <div class="hero-num ${saved ? 'ok' : 'bad'}">${saved ? 'Saved' : 'Overspent'} <span class="num">${inr(Math.abs(s.saved))}</span></div>
    <p class="small muted" style="margin:2px 0 14px">
      Income ${inr(plan.income)} − spent ${inr(actual.spend)} − invested ${inr(actual.invested)}.
      ${s.plannedSaving !== 0 || vsPlan !== 0 ? `You planned to save ${signed(s.plannedSaving)}, so you are <strong>${vsPlan >= 0 ? `${inr(vsPlan)} better` : `${inr(-vsPlan)} worse`}</strong> than plan.` : ''}
    </p>
    <div class="plan-row">
      <div class="row between"><span><span class="dot" style="background:${kindVar('spend')}"></span> Spent</span>${spendLine}</div>
      <div class="row between small muted"><span class="num">${inr(actual.spend)}</span><span class="num">of ${inr(plan.expectedSpend)} expected</span></div>
      ${meter(actual.spend, plan.expectedSpend, kindVar('spend'))}
    </div>
    <div class="plan-row">
      <div class="row between"><span><span class="dot" style="background:${kindVar('investment')}"></span> Invested</span>${investLine}</div>
      <div class="row between small muted"><span class="num">${inr(actual.invested)}</span><span class="num">of ${inr(plan.expectedInvestment)} expected</span></div>
      ${meter(actual.invested, plan.expectedInvestment, kindVar('investment'))}
    </div>
  </div>`;
}

function historyTable(rows: MonthSummary[]): string {
  const withData = rows.filter((r) => r.planSet || r.actual.spend || r.actual.invested).reverse();
  if (!withData.length) return '';
  return `<div class="table-scroll" style="margin-top:14px"><table class="simple">
      <tr><th>Month</th><th class="r">Income</th><th class="r">Spent</th><th class="r">Invested</th><th class="r">Saved</th></tr>
      ${withData.map((r) => `<tr data-month="${r.month}" class="click${r.month === app.filters.month ? ' sel' : ''}">
        <td>${esc(monthShort(r.month))}</td>
        <td class="num r">${r.planSet ? inr(r.plan.income) : '—'}</td>
        <td class="num r">${inr(r.actual.spend)}${r.planSet && r.plan.expectedSpend ? `<div class="tiny ${r.spendOver > 0 ? 'bad' : 'ok'}">${r.spendOver > 0 ? '+' : '−'}${inr(Math.abs(r.spendOver))}</div>` : ''}</td>
        <td class="num r">${inr(r.actual.invested)}${r.planSet && r.plan.expectedInvestment ? `<div class="tiny ${r.investOver >= 0 ? 'ok' : 'bad'}">${r.investOver >= 0 ? '+' : '−'}${inr(Math.abs(r.investOver))}</div>` : ''}</td>
        <td class="num r ${r.planSet ? (r.saved >= 0 ? 'ok' : 'bad') : ''}">${r.planSet ? signed(r.saved) : '—'}</td>
      </tr>`).join('')}
    </table></div>
    <p class="tiny" style="margin:8px 0 0">Small figures show the difference from what you expected.</p>`;
}

function monthSummary(s: MonthSummary, txns: Txn[], prev: MonthSummary | undefined, cats: { category: string; total: number }[]): string {
  const spendTxns = txns.filter((t) => t.kind === 'spend' && t.direction === 'debit');
  const biggest = [...spendTxns].sort((a, b) => b.amount - a.amount)[0];
  const cashCount = txns.filter((t) => t.accountId === 'MANUAL').length;
  const days = new Set(spendTxns.map((t) => t.date)).size;
  const lines: string[] = [];
  lines.push(`You spent <strong>${inr(s.actual.spend)}</strong> across ${spendTxns.length} payment${spendTxns.length === 1 ? '' : 's'} on ${days} day${days === 1 ? '' : 's'}, and invested <strong>${inr(s.actual.invested)}</strong>.`);
  if (cats[0]) {
    const top = cats.slice(0, 3).map((c) => `${esc(c.category)} ${inr(c.total)}`).join(', ');
    lines.push(`Top categories: ${top}.`);
  }
  if (biggest) lines.push(`Biggest single spend: ${esc(biggest.merchantName)} ${inr(biggest.amount)} on ${new Date(biggest.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}.`);
  if (prev) {
    const d = s.actual.spend - prev.actual.spend;
    const di = s.actual.invested - prev.actual.invested;
    const pm = shortMonth(prev.month);
    lines.push(`Compared with ${pm}: spending ${d >= 0 ? '▲ up' : '▼ down'} ${inr(Math.abs(d))}, investing ${di >= 0 ? '▲ up' : '▼ down'} ${inr(Math.abs(di))}.`);
  }
  if (s.planSet) {
    lines.push(s.saved >= 0
      ? `After spending and investing you kept <strong class="ok">${inr(s.saved)}</strong> of your ${inr(s.plan.income)} income.`
      : `You spent and invested <strong class="bad">${inr(-s.saved)}</strong> more than your ${inr(s.plan.income)} income.`);
  }
  const moved = [s.actual.transfers && `${inr(s.actual.transfers)} moved between your accounts`, s.actual.cardBills && `${inr(s.actual.cardBills)} paid to credit cards`, s.actual.redeemed && `${inr(s.actual.redeemed)} redeemed from investments`].filter(Boolean);
  if (moved.length) lines.push(`Not counted as spend: ${moved.join(', ')}.`);
  if (cashCount) lines.push(`${cashCount} transaction${cashCount === 1 ? ' was' : 's were'} added by hand.`);
  return `<div class="card"><h2>${esc(monthLabel(s.month))} at a glance</h2><ul class="glance">${lines.map((l) => `<li>${l}</li>`).join('')}</ul></div>`;
}

const RANGES: { value: number; label: string }[] = [{ value: 6, label: '6 months' }, { value: 12, label: '12 months' }, { value: 0, label: 'All' }];

let monthDefaulted = false;

export function renderDashboard(root: HTMLElement) {
  const { state, filters } = app;
  const addBtn = '<button class="btn primary" data-add>+ Add</button>';
  if (!state.txns.length && !Object.keys(state.plans).length) {
    root.innerHTML = `<div class="row between"><h1>Overview</h1>${addBtn}</div>
      <div class="card empty">
        <p style="font-size:17px;color:var(--text)"><strong>Upload your first statement</strong></p>
        <p>PDF or Excel from HDFC, ICICI and most other banks, or add cash spends by hand. Everything stays on this device.</p>
        <div class="row" style="justify-content:center;gap:8px;flex-wrap:wrap">
          <a class="btn primary" href="#upload" style="text-decoration:none">Upload statement</a>
          <button class="btn" data-plan>Set income &amp; targets</button>
        </div>
      </div>`;
    root.querySelector('[data-plan]')!.addEventListener('click', () => openPlanSheet(currentMonth()));
    root.querySelector('[data-add]')!.addEventListener('click', () => openManualSheet());
    return;
  }
  const months = availableMonths();
  // The overview is always about one month: default to the latest with transactions.
  if (!monthDefaulted || filters.month === 'all' || !months.includes(filters.month)) {
    filters.month = months.find((m) => state.txns.some((t) => t.date.startsWith(m))) ?? months[0];
    monthDefaulted = true;
  }
  const month = filters.month;
  const scoped = applyFilters(state.txns, { ...filters, month: 'all' }, { kind: false });
  const allMonths = [...months].reverse(); // oldest first, only months with data or a plan
  const inRange = filters.range ? allMonths.slice(-filters.range) : allMonths;
  const history = inRange.map((m) => summarize(state, m, scoped));
  const s = summarize(state, month, scoped);
  const prevMonth = allMonths[allMonths.indexOf(month) - 1];
  const prev = prevMonth ? summarize(state, prevMonth, scoped) : undefined;
  const txns = scoped.filter((t) => t.date.startsWith(month));
  const of = (k: Kind, dir: 'debit' | 'credit') => txns.filter((t) => t.kind === k && t.direction === dir);
  const review = txns.filter((t) => t.category === 'Uncategorised');
  const spendCats = byCategory(of('spend', 'debit'));
  const spendTotal = spendCats.reduce((a, c) => a + c.total, 0) || 1;
  const slices = toSlices(spendCats);
  const invCats = byCategory([...of('investment', 'debit'), ...of('investment', 'credit')]
    .map((t) => ({ ...t, amount: t.direction === 'debit' ? t.amount : -t.amount })));
  const points = (pick: (r: MonthSummary) => [number, number]): MonthPoint[] =>
    history.map((r) => { const [actual, expected] = pick(r); return { month: r.month, actual, expected, planSet: r.planSet }; });
  const anyPlan = history.some((r) => r.planSet);

  root.innerHTML = `
    <div class="row between"><h1>Overview</h1>${addBtn}</div>
    ${filterBar(false)}
    ${review.length ? `<a class="banner" href="#txns" data-kind="review"><span><strong>${review.length}</strong> transaction${review.length > 1 ? 's' : ''} need${review.length > 1 ? '' : 's'} a category</span><span>Review ›</span></a>` : ''}
    ${summaryCard(s)}
    ${monthSummary(s, txns, prev, spendCats)}

    <div class="card">
      <h2>Spending by category</h2>
      ${slices.length ? `<div class="pie-wrap">
        ${donutChart(slices, 'spent')}
        <div class="pie-legend">
          ${slices.map((sl) => `<a class="pie-row" href="#txns" data-kind="spend" ${sl.label.startsWith('Other (') ? '' : `data-category="${esc(sl.label)}"`}>
            <i class="sw" style="background:${sl.color}"></i>
            <span class="grow ellipsis">${esc(sl.label)} <span class="tiny">· ${sl.count}</span></span>
            <span class="num">${inr(sl.value)}</span><span class="tiny num pct">${Math.round((sl.value / spendTotal) * 100)}%</span>
          </a>`).join('')}
        </div>
      </div>` : '<p class="muted">No spending in this month.</p>'}
    </div>

    <div class="card">
      <div class="row between wrap" style="margin-bottom:8px">
        <h2 style="margin:0">Month by month</h2>
        <span class="seg-toggle" role="group" aria-label="Show">
          ${RANGES.map((r) => `<button data-range="${r.value}" class="${filters.range === r.value ? 'on' : ''}">${r.label}</button>`).join('')}
        </span>
      </div>
      ${history.length ? trendChart(history.map((r) => ({ month: r.month, spend: Math.max(r.actual.spend, 0), invest: r.actual.invested })), month) : ''}
      ${anyPlan ? `
      <h2 style="margin-top:18px">Spent vs expected</h2>
      ${monthlyChart(points((r) => [Math.max(r.actual.spend, 0), r.plan.expectedSpend]), month, kindVar('spend'), 'Spent')}
      <h2 style="margin-top:16px">Invested vs expected</h2>
      ${monthlyChart(points((r) => [r.actual.invested, r.plan.expectedInvestment]), month, kindVar('investment'), 'Invested')}` : ''}
      <p class="tiny" style="margin:6px 0 0">Tap a month to open it. Showing ${history.length} of ${allMonths.length} month${allMonths.length === 1 ? '' : 's'}.</p>
      ${historyTable(history)}
    </div>

    <div class="tiles">
      <a class="tile" href="#txns" data-kind="transfer"><div class="label"><span class="dot" style="background:${kindVar('transfer')}"></span>Self transfers</div><div class="value num">${inr(s.actual.transfers)}</div><div class="sub">Not spend</div></a>
      <a class="tile" href="#txns" data-kind="cc_bill"><div class="label"><span class="dot" style="background:${kindVar('cc_bill')}"></span>Card bills paid</div><div class="value num">${inr(s.actual.cardBills)}</div><div class="sub">Not spend</div></a>
      ${s.actual.redeemed ? `<a class="tile" href="#txns" data-kind="investment"><div class="label"><span class="dot" style="background:${kindVar('investment')}"></span>Redeemed</div><div class="value num">${inr(s.actual.redeemed)}</div><div class="sub">Sold investments</div></a>` : ''}
      ${s.actual.credits ? `<a class="tile" href="#txns" data-kind="income"><div class="label"><span class="dot" style="background:${kindVar('income')}"></span>Credits in statement</div><div class="value num">${inr(s.actual.credits)}</div><div class="sub">Your income entry is used instead</div></a>` : ''}
    </div>

    ${invCats.length ? `<div class="card">
      <h2>Investments</h2>
      <table class="simple">
        <tr><th>Category</th><th class="r">Net invested</th></tr>
        ${invCats.map((c) => `<tr><td><a href="#txns" data-kind="investment" data-category="${esc(c.category)}" style="color:inherit">${esc(c.category)}</a></td><td class="num r">${signed(c.total)}</td></tr>`).join('')}
      </table>
      <p class="tiny" style="margin:8px 0 0">Negative means more was redeemed than invested.</p>
    </div>` : ''}
  `;
  bindFilterBar(root);
  root.querySelector('[data-add]')!.addEventListener('click', () => openManualSheet(undefined, month === currentMonth() ? undefined : `${month}-01`));
  root.querySelectorAll('[data-plan]').forEach((b) => b.addEventListener('click', () => openPlanSheet(month)));
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
    el.addEventListener('click', (e) => {
      e.preventDefault();
      filters.kind = el.dataset.kind as Kind | 'review';
      filters.category = el.dataset.category ?? '';
      navigate('#txns');
    });
  });
}
