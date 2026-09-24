import type { Kind, Txn } from '../types';
import { KIND_LABEL } from '../categorize/categories';
import { app, render } from './app';
import { bindFilterBar, filterBar } from './dashboard';
import { openEditSheet } from './edit';
import { MANUAL_ACCOUNT, openManualSheet } from './manualSheet';
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
        ${esc(KIND_LABEL[t.kind])}${t.accountId === MANUAL_ACCOUNT ? ' · Added by hand' : account && app.state.accounts.length > 1 ? ` · ${esc(account.bank)}` : ''}
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
  // Category groups: biggest money movement first, each with its subtotal.
  const byCat = new Map<string, Txn[]>();
  for (const t of txns) {
    const key = `${KIND_LABEL[t.kind]} · ${t.category}`;
    byCat.set(key, [...(byCat.get(key) ?? []), t]);
  }
  const net = (list: Txn[]) => list.reduce((a, t) => a + (t.direction === 'debit' ? -t.amount : t.amount), 0);
  const catGroups = [...byCat.entries()].sort((a, b) => Math.abs(net(b[1])) - Math.abs(net(a[1])));
  const out = txns.filter((t) => t.direction === 'debit').reduce((a, t) => a + t.amount, 0);
  const inn = txns.filter((t) => t.direction === 'credit').reduce((a, t) => a + t.amount, 0);

  root.innerHTML = `
    <div class="row between"><h1>Transactions</h1><button class="btn primary" data-add>+ Add</button></div>
    ${filterBar()}
    <input type="search" placeholder="Search name, category or amount" value="${esc(filters.search)}" id="search" style="margin-bottom:10px">
    <div class="chips">
      ${KIND_CHIPS.map((k) => `<button class="chip${filters.kind === k && !filters.category ? ' on' : ''}" data-kind="${k}">${k === 'all' ? 'All' : k === 'review' ? 'Needs review' : esc(KIND_LABEL[k])}</button>`).join('')}
      ${filters.category ? `<button class="chip on" data-kind="${filters.kind}" data-clear-cat>${esc(filters.category)} ✕</button>` : ''}
    </div>
    <div class="row between small muted wrap" style="margin:0 4px 4px">
      <span>${txns.length} transactions · <span class="num">Out ${inrFull(out)} · In ${inrFull(inn)}</span></span>
      <span class="seg-toggle" role="group" aria-label="Group by">
        <button data-group="date" class="${filters.groupBy === 'date' ? 'on' : ''}">By date</button>
        <button data-group="category" class="${filters.groupBy === 'category' ? 'on' : ''}">By category</button>
      </span>
    </div>
    ${!txns.length ? '<div class="card empty">No transactions match.</div>'
      : filters.groupBy === 'category'
        ? catGroups.map(([cat, list]) => `
          <div class="cat-head"><span>${esc(cat)} <span class="tiny">· ${list.length}</span></span><span class="num">${net(list) < 0 ? '−' : '+'}${inrFull(Math.abs(net(list)))}</span></div>
          <div class="list">${list.map(txnRow).join('')}</div>`).join('')
        : [...byDay.entries()].map(([day, list]) => `
          <div class="day">${esc(dayLabel(day))}</div>
          <div class="list">${list.map(txnRow).join('')}</div>`).join('')}
  `;
  bindFilterBar(root);
  root.querySelector('[data-add]')!.addEventListener('click', () => openManualSheet(undefined, filters.month !== 'all' ? `${filters.month}-01` : undefined));
  const search = root.querySelector<HTMLInputElement>('#search')!;
  search.addEventListener('input', () => {
    filters.search = search.value;
    const pos = search.selectionStart;
    render();
    const again = document.querySelector<HTMLInputElement>('#search');
    again?.focus();
    again?.setSelectionRange(pos, pos);
  });
  root.querySelectorAll<HTMLElement>('[data-group]').forEach((el) => el.addEventListener('click', () => {
    filters.groupBy = el.dataset.group as Filters['groupBy'];
    render();
  }));
  root.querySelectorAll<HTMLElement>('.chip').forEach((el) => el.addEventListener('click', () => {
    filters.kind = el.dataset.kind as Filters['kind'];
    filters.category = '';
    render();
  }));
  root.querySelectorAll<HTMLElement>('.txn').forEach((el) => el.addEventListener('click', () => {
    const t = state.txns.find((x) => x.id === el.dataset.id);
    if (t) (t.accountId === MANUAL_ACCOUNT ? openManualSheet(t) : openEditSheet(t));
  }));
}

type Filters = typeof app.filters;
