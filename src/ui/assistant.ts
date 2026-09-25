import type { AppState, Txn } from '../types';
import { KIND_LABEL } from '../categorize/categories';
import { answer, applyPlan, describeAction, planRequest, targets, wouldChange, type AssistantPlan } from '../assistant';
import { app, navigate, render, toast, update } from './app';
import { dayLabel, esc, inr, inrFull } from './format';

interface Entry {
  request: string;
  status: 'thinking' | 'ready' | 'applied' | 'cancelled' | 'undone' | 'error';
  plan?: AssistantPlan;
  /** Rows the change will touch, fixed when the preview is shown. */
  ids?: string[];
  before?: Pick<AppState, 'txns' | 'rules' | 'settings'>;
  error?: string;
}

const history: Entry[] = [];

const EXAMPLES = [
  'Move all self transfers to not counted',
  'How much did I spend on food last month?',
  'Mark all Groww payments as Mutual Funds and remember it',
  'Rename Rakesh jai to Rakesh Kirana from now on',
  'Top 5 payees I paid in August',
  'Which transactions are not counted?',
];

async function ask(request: string) {
  const entry: Entry = { request, status: 'thinking' };
  history.push(entry);
  render();
  try {
    entry.plan = await planRequest(request, app.state);
    const plan = entry.plan;
    // Only rows the change would actually alter; the rest are already that way.
    entry.ids = targets(app.state, plan)
      .filter((t) => plan.intent !== 'change' || !plan.action || plan.remember || wouldChange(t, plan.action, app.state.settings))
      .map((t) => t.id);
    entry.status = 'ready';
  } catch (e) {
    entry.status = 'error';
    entry.error = (e as Error).message;
  }
  render();
}

function rowsHtml(rows: Txn[], limit = 12): string {
  const shown = [...rows].sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit);
  return `<div class="as-rows">${shown.map((t) => `<div class="as-row${t.excluded ? ' ignored' : ''}">
      <span class="grow"><span class="ellipsis" style="display:block">${esc(t.merchantName)}</span>
      <span class="tiny">${esc(dayLabel(t.date))} · ${esc(KIND_LABEL[t.kind])} / ${esc(t.category)}${t.excluded ? ' · not counted' : ''}</span></span>
      <span class="num amt ${t.direction}">${t.direction === 'credit' ? '+' : '−'}${inrFull(t.amount)}</span>
    </div>`).join('')}
    ${rows.length > limit ? `<div class="tiny" style="padding:6px 2px">…and ${rows.length - limit} more</div>` : ''}</div>`;
}

function entryHtml(e: Entry, i: number): string {
  const you = `<div class="as-you">${esc(e.request)}</div>`;
  if (e.status === 'thinking') return `${you}<div class="as-bot"><span class="spinner"></span>Thinking…</div>`;
  if (e.status === 'error') {
    return `${you}<div class="as-bot bad">${esc(e.error ?? 'Something went wrong.')}${/Settings/.test(e.error ?? '') ? ' <button class="link-btn" data-go-settings>Open Settings</button>' : ''}</div>`;
  }
  const plan = e.plan!;
  const byId = new Map(app.state.txns.map((t) => [t.id, t]));
  const rows = (e.ids ?? []).map((id) => byId.get(id)).filter((t): t is Txn => Boolean(t));
  let body = `<p style="margin:0 0 8px">${esc(plan.reply || 'Here you go.')}</p>`;

  if (plan.intent === 'question') {
    const a = answer(rows, plan.measure);
    body += `<div class="as-stats">
      <div><span class="tiny">Transactions</span><strong class="num">${a.count}</strong></div>
      <div><span class="tiny">Money out</span><strong class="num">${inr(a.moneyOut)}</strong></div>
      <div><span class="tiny">Money in</span><strong class="num">${inr(a.moneyIn)}</strong></div>
    </div>`;
    if (a.groups?.length) {
      body += `<table class="simple" style="margin-top:8px">${a.groups.slice(0, 10).map((g) => `<tr><td>${esc(g.label)} <span class="tiny">(${g.count})</span></td>
        <td class="num">${g.out ? `−${inr(g.out)}` : ''}${g.out && g.in ? ' / ' : ''}${g.in ? `+${inr(g.in)}` : ''}</td></tr>`).join('')}</table>`;
    }
    if (rows.length && (plan.measure === 'list' || rows.length <= 12)) body += rowsHtml(rows, plan.measure === 'list' ? 25 : 12);
    if (!rows.length) body += '<p class="small muted" style="margin:6px 0 0">No transactions match.</p>';
    else body += `<button class="btn small-btn" style="margin-top:8px" data-open-txns="${i}">Open these ${rows.length} in Transactions</button>`;
    body += '<p class="tiny" style="margin:8px 0 0">Worked out on this device from your transactions.</p>';
  } else if (plan.intent === 'change' && plan.action) {
    const what = describeAction(plan.action);
    if (e.status === 'ready') {
      body += rows.length
        ? `<p class="small" style="margin:0 0 6px"><strong>${rows.length}</strong> transaction${rows.length > 1 ? 's' : ''} will change: ${esc(what)}${plan.remember ? ', and remembered for these payees' : ''}.</p>${rowsHtml(rows)}
          <div class="row" style="margin-top:10px"><button class="btn grow" data-cancel="${i}">Cancel</button><button class="btn primary grow" data-confirm="${i}">Confirm</button></div>`
        : plan.action.type === 'category_counted'
          ? `<p class="small" style="margin:0 0 6px">No transactions in ${esc(plan.action.category)} yet; this sets it for future uploads.</p>
            <div class="row" style="margin-top:10px"><button class="btn grow" data-cancel="${i}">Cancel</button><button class="btn primary grow" data-confirm="${i}">Confirm</button></div>`
          : targets(app.state, plan).length
            ? `<p class="small ok" style="margin:0">✓ Already done: all ${targets(app.state, plan).length} matching transactions are already that way.</p>`
            : '<p class="small muted" style="margin:0">No transactions match, so nothing would change. Try naming the payee, category or month differently.</p>';
    } else if (e.status === 'applied') {
      // Undo puts everything back as it was, so only the latest change offers it.
      const latest = history.map((h) => h.status).lastIndexOf('applied') === i;
      body += `<p class="small ok" style="margin:0">✓ Done: ${esc(what)} (${rows.length} transaction${rows.length === 1 ? '' : 's'}).${latest ? ` <button class="link-btn" data-undo="${i}">Undo</button>` : ''}</p>`;
    } else if (e.status === 'undone') {
      body += '<p class="small muted" style="margin:0">Undone.</p>';
    } else {
      body += '<p class="small muted" style="margin:0">Cancelled; nothing changed.</p>';
    }
  }
  return `${you}<div class="as-bot">${body}</div>`;
}

export function renderAssistant(root: HTMLElement) {
  const hasKey = Boolean(app.state.settings.geminiKey);
  root.innerHTML = `
    <h1>Assistant</h1>
    <p class="small muted" style="margin:-6px 0 14px">Ask a question or tell it what to change. Every change is shown first and happens only when you tap Confirm.</p>
    ${hasKey ? '' : '<div class="card small">The assistant uses your free Gemini key. <button class="link-btn" data-go-settings>Add it in Settings</button></div>'}
    <div class="as-log">${history.map(entryHtml).join('')}</div>
    ${history.length ? '' : `<div class="chips as-examples">${EXAMPLES.map((x) => `<button class="chip" data-example="${esc(x)}">${esc(x)}</button>`).join('')}</div>`}
    <form class="as-input" autocomplete="off">
      <input type="text" id="as-q" placeholder="e.g. Move all self transfers to not counted" ${hasKey ? '' : 'disabled'} enterkeyhint="send">
      <button class="btn primary" ${hasKey ? '' : 'disabled'}>Send</button>
    </form>
    <p class="tiny" style="margin:6px 4px">Sent to Google Gemini: your request, category names and payee titles. Amounts, dates, balances and account numbers stay on this device; the app finds the rows and does the maths itself.</p>
  `;
  const input = root.querySelector<HTMLInputElement>('#as-q')!;
  root.querySelector('form')!.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const q = input.value.trim();
    if (!q || history.some((h) => h.status === 'thinking')) return;
    input.value = '';
    void ask(q);
  });
  root.querySelectorAll<HTMLElement>('[data-example]').forEach((b) => b.addEventListener('click', () => {
    input.value = b.dataset.example!;
    input.focus();
  }));
  root.querySelectorAll('[data-go-settings]').forEach((b) => b.addEventListener('click', () => navigate('#settings')));
  root.querySelectorAll<HTMLElement>('[data-open-txns]').forEach((b) => b.addEventListener('click', () => {
    const e = history[Number(b.dataset.openTxns)];
    // Show exactly the answer's rows: clear the other filters so none are hidden.
    Object.assign(app.filters, { month: 'all', account: 'all', kind: 'all', category: '', search: '', picked: { label: e.request.length > 40 ? `${e.request.slice(0, 38)}…` : e.request, ids: e.ids ?? [] } });
    navigate('#txns');
  }));
  root.querySelectorAll<HTMLElement>('[data-cancel]').forEach((b) => b.addEventListener('click', () => {
    history[Number(b.dataset.cancel)].status = 'cancelled';
    render();
  }));
  root.querySelectorAll<HTMLElement>('[data-confirm]').forEach((b) => b.addEventListener('click', async () => {
    const e = history[Number(b.dataset.confirm)];
    const { txns, rules, settings } = app.state;
    e.before = { txns, rules, settings };
    e.status = 'applied';
    await update((s) => applyPlan(s, e.plan!, new Set(e.ids)));
    toast('Done');
  }));
  root.querySelectorAll<HTMLElement>('[data-undo]').forEach((b) => b.addEventListener('click', async () => {
    const e = history[Number(b.dataset.undo)];
    if (!e.before) return;
    const before = e.before;
    e.status = 'undone';
    await update((s) => ({ ...s, ...before }));
    toast('Undone');
  }));
  root.querySelector('.as-log > :last-child')?.scrollIntoView({ block: 'nearest' });
}
