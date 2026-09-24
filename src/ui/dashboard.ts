import type { Kind, Txn } from '../types';
import { app, navigate, render } from './app';
import { applyFilters, esc, inr, kindVar, monthLabel, monthsOf } from './format';

function sum(txns: Txn[]) {
  return txns.reduce((a, t) => a + t.amount, 0);
}

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

export function filterBar(): string {
  const { state, filters } = app;
  const months = monthsOf(state.txns);
  return `
    <div class="row" style="margin-bottom:12px">
      <select data-filter="month" aria-label="Month" class="grow">
        <option value="all" ${filters.month === 'all' ? 'selected' : ''}>All time</option>
        ${months.map((m) => `<option value="${m}" ${filters.month === m ? 'selected' : ''}>${monthLabel(m)}</option>`).join('')}
      </select>
      ${state.accounts.length > 1 ? `
      <select data-filter="account" aria-label="Account" class="grow">
        <option value="all">All accounts</option>
        ${state.accounts.map((a) => `<option value="${esc(a.id)}" ${filters.account === a.id ? 'selected' : ''}>${esc(a.bank)} ••${esc(a.number.slice(-4))}</option>`).join('')}
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

function tile(kind: Kind, label: string, value: number, sub: string, hero = false) {
  return `<a class="tile${hero ? ' hero' : ''}" href="#/txns" data-kind="${kind}">
    <div class="label"><span class="dot" style="background:${kindVar(kind)}"></span>${esc(label)}</div>
    <div class="value num">${inr(value)}</div>
    <div class="sub">${esc(sub)}</div>
  </a>`;
}

let monthDefaulted = false;

export function renderDashboard(root: HTMLElement) {
  const { state, filters } = app;
  if (!state.txns.length) {
    root.innerHTML = `<h1>Expenses</h1>
      <div class="card empty">
        <p style="font-size:17px;color:var(--text)"><strong>Upload your first statement</strong></p>
        <p>PDF or Excel from HDFC, ICICI and most other banks. Everything stays on this device.</p>
        <a class="btn primary" href="#/import" style="display:inline-block;text-decoration:none">Upload statement</a>
      </div>`;
    return;
  }
  // Default to the latest month with data.
  if (!monthDefaulted) {
    filters.month = monthsOf(state.txns)[0] ?? 'all';
    monthDefaulted = true;
  }
  const txns = applyFilters(state.txns, filters, { kind: false });
  const of = (k: Kind, dir?: 'debit' | 'credit') => txns.filter((t) => t.kind === k && (!dir || t.direction === dir));

  const spend = of('spend', 'debit');
  const refunds = of('spend', 'credit');
  const income = of('income', 'credit');
  const invested = of('investment', 'debit');
  const redeemed = of('investment', 'credit');
  const transfers = of('transfer', 'debit');
  const ccBills = of('cc_bill', 'debit');
  const review = txns.filter((t) => t.category === 'Uncategorised');

  const spendCats = byCategory(spend);
  const maxCat = spendCats[0]?.total ?? 1;
  const totalSpend = sum(spend) - sum(refunds);
  const invCats = byCategory([...invested, ...redeemed].map((t) => ({ ...t, amount: t.direction === 'debit' ? t.amount : -t.amount })));

  root.innerHTML = `
    <h1>Expenses</h1>
    ${filterBar()}
    ${review.length ? `<a class="banner" href="#/txns" data-kind="review"><span><strong>${review.length}</strong> transaction${review.length > 1 ? 's' : ''} need${review.length > 1 ? '' : 's'} a category</span><span>Review ›</span></a>` : ''}
    <div class="tiles">
      ${tile('spend', 'Spent', totalSpend, `${spend.length} payments${refunds.length ? ` · ${inr(sum(refunds))} refunded` : ''}`, true)}
      ${tile('income', 'Income', sum(income), `${income.length} credits`)}
      ${tile('investment', 'Invested', sum(invested), redeemed.length ? `${inr(sum(redeemed))} redeemed` : `${invested.length} investments`)}
      ${tile('transfer', 'Self transfers', sum(transfers), 'Between your accounts')}
      ${tile('cc_bill', 'Card bills paid', sum(ccBills), 'Not counted as spend')}
    </div>

    <div class="card">
      <h2>Where the money went</h2>
      ${spendCats.length ? `<div class="bars">
        ${spendCats.map((c) => `
          <a class="bar-row" href="#/txns" data-kind="spend" data-category="${esc(c.category)}">
            <div class="top"><span class="ellipsis">${esc(c.category)} <span class="tiny">· ${c.count}</span></span>
            <span class="num">${inr(c.total)} <span class="tiny">${Math.round((c.total / (sum(spend) || 1)) * 100)}%</span></span></div>
            <div class="bar-track"><div class="bar-fill" style="width:${(c.total / maxCat) * 100}%"></div></div>
          </a>`).join('')}
      </div>` : '<p class="muted">No spending in this period.</p>'}
    </div>

    ${invCats.length ? `<div class="card">
      <h2>Investments</h2>
      <table class="simple">
        <tr><th>Category</th><th style="text-align:right">Net invested</th></tr>
        ${invCats.map((c) => `<tr><td><a href="#/txns" data-kind="investment" data-category="${esc(c.category)}" style="color:inherit">${esc(c.category)}</a></td><td class="num" style="text-align:right">${c.total < 0 ? '−' : ''}${inr(Math.abs(c.total))}</td></tr>`).join('')}
      </table>
      <p class="tiny" style="margin:8px 0 0">Negative means more was redeemed than invested.</p>
    </div>` : ''}

    <p class="tiny" style="text-align:center">${esc(monthLabel(filters.month))} · ${txns.length} transactions</p>
  `;
  bindFilterBar(root);
  root.querySelectorAll<HTMLElement>('[data-kind]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      app.filters.kind = el.dataset.kind as Kind | 'review';
      app.filters.category = el.dataset.category ?? '';
      navigate('#/txns');
    });
  });
}
