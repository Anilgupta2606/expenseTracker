import type { Kind, Txn } from '../types';
import { KIND_LABEL } from '../categorize/categories';
import { app, render } from './app';
import { bindFilterBar, filterBar } from './dashboard';
import { openEditSheet } from './edit';
import { applyFilters, dayLabel, esc, initials, inrFull, kindVar } from './format';

const KIND_CHIPS: (Kind | 'all' | 'review')[] = ['all', 'review', 'spend', 'income', 'investment', 'transfer', 'cc_bill'];

export function txnRow(t: Txn): string {
  const account = app.state.accounts.find((a) => a.id === t.accountId);
  const review = t.category === 'Uncategorised';
  return `<button class="txn" data-id="${esc(t.id)}">
    <span class="avatar" style="background:${kindVar(t.kind)}">${esc(initials(t.merchantName))}</span>
    <span class="grow">
      <div class="name ellipsis">${esc(t.merchantName)}</div>
      <div class="meta ellipsis">
        <span class="badge${review ? ' warn' : ''}">${esc(review ? 'Needs category' : t.category)}</span>
        ${esc(KIND_LABEL[t.kind])}${account && app.state.accounts.length > 1 ? ` · ${esc(account.bank)}` : ''}${t.source === 'ai' ? ' · AI' : ''}
      </div>
    </span>
    <span class="num amt ${t.direction}">${t.direction === 'credit' ? '+' : '−'}${inrFull(t.amount)}</span>
  </button>`;
}

export function renderTransactions(root: HTMLElement) {
  const { state, filters } = app;
  const txns = applyFilters(state.txns, filters);
  const byDay = new Map<string, Txn[]>();
  for (const t of txns) byDay.set(t.date, [...(byDay.get(t.date) ?? []), t]);
  const out = txns.filter((t) => t.direction === 'debit').reduce((a, t) => a + t.amount, 0);
  const inn = txns.filter((t) => t.direction === 'credit').reduce((a, t) => a + t.amount, 0);

  root.innerHTML = `
    <h1>Transactions</h1>
    ${filterBar()}
    <input type="search" placeholder="Search name, category or amount" value="${esc(filters.search)}" id="search" style="margin-bottom:10px">
    <div class="chips">
      ${KIND_CHIPS.map((k) => `<button class="chip${filters.kind === k && !filters.category ? ' on' : ''}" data-kind="${k}">${k === 'all' ? 'All' : k === 'review' ? 'Needs review' : esc(KIND_LABEL[k])}</button>`).join('')}
      ${filters.category ? `<button class="chip on" data-kind="${filters.kind}" data-clear-cat>${esc(filters.category)} ✕</button>` : ''}
    </div>
    <div class="row between small muted" style="margin:0 4px 4px">
      <span>${txns.length} transactions</span>
      <span class="num">Out ${inrFull(out)} · In ${inrFull(inn)}</span>
    </div>
    ${txns.length ? [...byDay.entries()].map(([day, list]) => `
      <div class="day">${esc(dayLabel(day))}</div>
      <div class="list">${list.map(txnRow).join('')}</div>`).join('') : '<div class="card empty">No transactions match.</div>'}
  `;
  bindFilterBar(root);
  const search = root.querySelector<HTMLInputElement>('#search')!;
  search.addEventListener('input', () => {
    filters.search = search.value;
    const pos = search.selectionStart;
    render();
    const again = document.querySelector<HTMLInputElement>('#search');
    again?.focus();
    again?.setSelectionRange(pos, pos);
  });
  root.querySelectorAll<HTMLElement>('.chip').forEach((el) => el.addEventListener('click', () => {
    filters.kind = el.dataset.kind as Filters['kind'];
    filters.category = '';
    render();
  }));
  root.querySelectorAll<HTMLElement>('.txn').forEach((el) => el.addEventListener('click', () => {
    const t = state.txns.find((x) => x.id === el.dataset.id);
    if (t) openEditSheet(t);
  }));
}

type Filters = typeof app.filters;
