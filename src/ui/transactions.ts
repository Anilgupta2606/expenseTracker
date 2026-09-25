import type { Kind, Txn } from '../types';
import { categoryCounted, defaultCategory, KIND_LABEL } from '../categorize/categories';
import { app, render, toast, update } from './app';
import { bindFilterBar, filterBar } from './dashboard';
import { openEditSheet } from './edit';
import { MANUAL_ACCOUNT, openManualSheet } from './manualSheet';
import { applyFilters, dayLabel, esc, initials, inrFull, kindVar } from './format';

const KIND_CHIPS: (Kind | 'all' | 'review' | 'excluded')[] = ['all', 'review', 'spend', 'investment', 'cc_bill', 'income', 'transfer', 'excluded'];

/** Choices for "Counts as", in the order people think about them. */
const COUNTS_AS: { kind: Kind; label: string }[] = [
  { kind: 'spend', label: 'Spending' },
  { kind: 'investment', label: 'Investment' },
  { kind: 'income', label: 'Income' },
  { kind: 'transfer', label: 'Self transfer' },
  { kind: 'cc_bill', label: 'Card bill' },
];

/** Ticks or unticks "Counted", then offers to do the same for similar payments. */
async function setCounted(id: string, counted: boolean) {
  const t = app.state.txns.find((x) => x.id === id);
  if (!t) return;
  await update((s) => ({ ...s, txns: s.txns.map((x) => (x.id === id ? { ...x, excluded: !counted } : x)) }));
  const similar = app.state.txns.filter((x) => x.id !== id && x.merchantKey === t.merchantKey && x.direction === t.direction && Boolean(x.excluded) === counted);
  toast(counted ? `${t.merchantName} is counted again.` : `${t.merchantName} is no longer counted.`, similar.length ? {
    label: `Same for ${similar.length} similar`,
    run: async () => {
      const ids = new Set(similar.map((x) => x.id));
      await update((s) => ({ ...s, txns: s.txns.map((x) => (ids.has(x.id) ? { ...x, excluded: !counted } : x)) }));
      toast(`Updated ${similar.length} more`);
    },
  } : undefined);
}

/** A transaction moved to another type takes that category's Counted setting (Settings → What counts). */
function moveTo(x: Txn, kind: Kind, source: 'manual' | 'learned'): Txn {
  const category = defaultCategory(kind, x.category);
  return { ...x, kind, category, source, excluded: !categoryCounted(app.state.settings, kind, category) };
}

/** Moves one transaction (and optionally similar ones) to another type. */
async function setKind(id: string, kind: Kind) {
  const t = app.state.txns.find((x) => x.id === id);
  if (!t || t.kind === kind) return;
  await update((s) => ({
    ...s,
    txns: s.txns.map((x) => (x.id === id ? moveTo(x, kind, 'manual') : x)),
  }));
  const similar = app.state.txns.filter((x) => x.id !== id && x.merchantKey === t.merchantKey && x.direction === t.direction && x.kind !== kind && x.source !== 'manual');
  const label = COUNTS_AS.find((c) => c.kind === kind)!.label;
  toast(`${t.merchantName} now counts as ${label}.`, {
    label: similar.length ? `Apply to ${similar.length} similar & remember` : 'Remember for this payee',
    run: async () => {
      const direction = kind === 'spend' || kind === 'income' ? t.direction : undefined;
      const ids = new Set(similar.map((x) => x.id));
      await update((s) => ({
        ...s,
        rules: [
          ...s.rules.filter((r) => !(r.key === t.merchantKey && (!direction || !r.direction || r.direction === direction))),
          { key: t.merchantKey, kind, category: defaultCategory(kind, t.category), direction, createdAt: Date.now() },
        ],
        txns: s.txns.map((x) => (ids.has(x.id) ? moveTo(x, kind, 'learned') : x)),
      }));
      toast(similar.length ? `Updated ${similar.length} more and saved as a rule` : 'Saved as a rule for future uploads');
    },
  });
}

export function txnRow(t: Txn): string {
  const account = app.state.accounts.find((a) => a.id === t.accountId);
  const review = t.category === 'Uncategorised';
  return `<div class="txn${t.excluded ? ' ignored' : ''}" data-id="${esc(t.id)}" role="button" tabindex="0">
    <span class="avatar" style="background:${kindVar(t.kind)}">${esc(initials(t.merchantName))}</span>
    <span class="grow">
      <div class="name ellipsis">${esc(t.merchantName)}</div>
      <div class="meta ellipsis">
        <span class="badge${review ? ' warn' : ''}">${esc(review ? 'Needs category' : t.category)}</span>
        ${t.accountId === MANUAL_ACCOUNT ? 'Added by hand' : account && app.state.accounts.length > 1 ? esc(account.bank) : ''}
      </div>
    </span>
    <span class="txn-side">
      <span class="num amt ${t.direction}">${t.direction === 'credit' ? '+' : '−'}${inrFull(t.amount)}</span>
      <span class="row" style="gap:6px">
        <label class="count-box" title="Include in totals"><input type="checkbox" data-counted="${esc(t.id)}" ${t.excluded ? '' : 'checked'}> Counted</label>
        <select class="counts-as" data-counts="${esc(t.id)}" aria-label="Counts as" title="Counts as">
          ${COUNTS_AS.map((c) => `<option value="${c.kind}" ${c.kind === t.kind ? 'selected' : ''}>${c.label}</option>`).join('')}
        </select>
      </span>
    </span>
  </div>`;
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
    <div class="page-head"><div><h1>Transactions</h1><p class="page-sub">“Counts as” sets the type; untick “Counted” to leave a row out of totals. Tap a row for its category.</p></div><button class="btn primary" data-add>+ Add transaction</button></div>
    ${filterBar()}
    <input type="search" placeholder="Search name, category or amount" value="${esc(filters.search)}" id="search" style="margin-bottom:10px">
    <div class="chips">
      ${KIND_CHIPS.map((k) => `<button class="chip${filters.kind === k && !filters.category ? ' on' : ''}" data-kind="${k}">${k === 'all' ? 'All' : k === 'review' ? 'Needs review' : k === 'excluded' ? 'Not counted' : esc(KIND_LABEL[k])}</button>`).join('')}
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
  bindTxnRows(root);
}

type Filters = typeof app.filters;

/** Row taps open the editor; the "Counts as" menu changes the type in place. */
export function bindTxnRows(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>('.txn[data-id]').forEach((el) => {
    const open = () => {
      const t = app.state.txns.find((x) => x.id === el.dataset.id);
      if (t) (t.accountId === MANUAL_ACCOUNT ? openManualSheet(t) : openEditSheet(t));
    };
    el.addEventListener('click', (e) => { if (!(e.target as HTMLElement).closest('.counts-as, .count-box')) open(); });
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === el) open(); });
  });
  root.querySelectorAll<HTMLInputElement>('input[data-counted]').forEach((box) => {
    box.addEventListener('click', (e) => e.stopPropagation());
    box.addEventListener('change', () => void setCounted(box.dataset.counted!, box.checked));
  });
  root.querySelectorAll<HTMLSelectElement>('select[data-counts]').forEach((sel) => {
    sel.addEventListener('click', (e) => e.stopPropagation());
    sel.addEventListener('change', () => void setKind(sel.dataset.counts!, sel.value as Kind));
  });
}
