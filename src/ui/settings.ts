import type { AppState } from '../types';
import { recategorizeAll } from '../importer';
import { AI_MODELS, emptyState } from '../store';
import { app, render, toast, update } from './app';
import { esc } from './format';

const splitNames = (s: string) => s.split(/[,\n]/).map((x) => x.trim().toUpperCase()).filter(Boolean);

function download(name: string, type: string, body: string) {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function toCsv(state: AppState): string {
  const q = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['Date', 'Account', 'Name', 'Type', 'Category', 'Direction', 'Amount', 'Balance', 'Narration', 'Note']];
  for (const t of state.txns) {
    rows.push([t.date, t.accountId, t.merchantName, t.kind, t.category, t.direction, String(t.amount), String(t.balance ?? ''), t.description, t.note ?? '']);
  }
  return rows.map((r) => r.map(q).join(',')).join('\n');
}

let aiStatus = '';

export function renderSettings(root: HTMLElement) {
  const { state } = app;
  const s = state.settings;
  const review = state.txns.filter((t) => t.category === 'Uncategorised');

  root.innerHTML = `
    <h1>Settings</h1>

    <div class="card">
      <h2>You</h2>
      <p class="small muted" style="margin-top:-4px">Transfers mentioning these names count as <strong>self transfers</strong>, not spend.</p>
      <label class="field"><span>Your name(s) as banks print them</span>
        <input type="text" id="own" value="${esc(s.ownNames.join(', '))}" placeholder="e.g. RAVI KUMAR"></label>
      <label class="field"><span>Family members to treat as self transfer (optional)</span>
        <input type="text" id="family" value="${esc(s.familyNames.join(', '))}" placeholder="e.g. spouse's name"></label>
      <button class="btn primary" id="save-names">Save and re-categorise</button>
    </div>

    <div class="card">
      <h2>Accounts</h2>
      ${state.accounts.length ? `<table class="simple">
        <tr><th>Account</th><th>Transactions</th><th></th></tr>
        ${state.accounts.map((a) => `<tr><td>${esc(a.bank)} ••${esc(a.number.slice(-4))}<div class="tiny">${esc(a.holderName ?? '')}</div></td>
          <td class="num">${state.txns.filter((t) => t.accountId === a.id).length}</td>
          <td style="text-align:right"><button class="btn danger" data-del-account="${esc(a.id)}">Delete</button></td></tr>`).join('')}
      </table>` : '<p class="muted small">No accounts yet. Upload a statement to add one.</p>'}
    </div>

    <div class="card">
      <h2>Learned rules</h2>
      <p class="small muted" style="margin-top:-4px">Created when you change a category and keep "Always use this" ticked.</p>
      ${state.rules.length ? `<table class="simple">
        ${state.rules.map((r, i) => `<tr><td>${esc(r.key)}${r.direction ? ` <span class="tiny">(${r.direction === 'debit' ? 'paid' : 'received'})</span>` : ''}</td><td>${esc(r.category)}</td>
          <td style="text-align:right"><button class="btn" data-del-rule="${i}" aria-label="Delete rule">✕</button></td></tr>`).join('')}
      </table>` : '<p class="muted small">None yet.</p>'}
      <button class="btn" id="recat" style="margin-top:10px">Re-run categorisation</button>
    </div>

    <div class="card">
      <h2>AI categorisation (optional)</h2>
      <p class="small muted" style="margin-top:-4px">Sends only the narration, amount and direction of <em>uncategorised</em> rows to Claude with your own API key. This uses API credits from console.anthropic.com, which are separate from a Claude subscription. The key is stored only on this device.</p>
      <label class="field"><span>Claude API key</span>
        <input type="password" id="key" value="${esc(s.aiApiKey ?? '')}" placeholder="sk-ant-…" autocomplete="off"></label>
      <label class="field"><span>Model</span>
        <select id="model">${AI_MODELS.map((m) => `<option value="${m.id}" ${m.id === s.aiModel ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</select></label>
      <div class="row wrap">
        <button class="btn" id="save-ai">Save key</button>
        <button class="btn primary" id="run-ai" ${!s.aiApiKey || !review.length ? 'disabled' : ''}>Categorise ${review.length} with AI</button>
      </div>
      ${aiStatus ? `<p class="small">${esc(aiStatus)}</p>` : ''}
    </div>

    <div class="card">
      <h2>Your data</h2>
      <p class="small muted" style="margin-top:-4px">Stored only in this browser. Export a backup now and then, especially before clearing Safari data.</p>
      <div class="row wrap">
        <button class="btn" id="export">Export backup</button>
        <label class="btn" style="display:inline-flex;align-items:center">Restore backup<input type="file" id="restore" accept="application/json,.json" hidden></label>
        <button class="btn" id="csv">Export CSV</button>
        <button class="btn danger" id="wipe">Delete everything</button>
      </div>
    </div>
    <p class="tiny" style="text-align:center">Expense Tracker · all processing happens on your device</p>
  `;

  const val = (id: string) => root.querySelector<HTMLInputElement | HTMLSelectElement>(`#${id}`)!.value;

  root.querySelector('#save-names')!.addEventListener('click', async () => {
    await update((st) => recategorizeAll({ ...st, settings: { ...st.settings, ownNames: splitNames(val('own')), familyNames: splitNames(val('family')) } }));
    toast('Saved');
  });
  root.querySelector('#recat')!.addEventListener('click', async () => {
    await update(recategorizeAll);
    toast('Re-categorised');
  });
  root.querySelectorAll<HTMLElement>('[data-del-rule]').forEach((b) => b.addEventListener('click', async () => {
    const i = Number(b.dataset.delRule);
    await update((st) => recategorizeAll({ ...st, rules: st.rules.filter((_, j) => j !== i) }));
  }));
  root.querySelectorAll<HTMLElement>('[data-del-account]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.delAccount!;
    if (!confirm(`Delete ${id} and all its transactions?`)) return;
    await update((st) => recategorizeAll({ ...st, accounts: st.accounts.filter((a) => a.id !== id), txns: st.txns.filter((t) => t.accountId !== id) }));
  }));
  root.querySelector('#save-ai')!.addEventListener('click', async () => {
    await update((st) => ({ ...st, settings: { ...st.settings, aiApiKey: val('key').trim() || undefined, aiModel: val('model') } }));
    toast('Saved');
  });
  root.querySelector('#run-ai')!.addEventListener('click', async () => {
    const settings = { ...app.state.settings, aiApiKey: val('key').trim() || app.state.settings.aiApiKey, aiModel: val('model') };
    try {
      const { categorizeWithAI } = await import('../categorize/ai');
      const suggestions = await categorizeWithAI(review, settings, (done, total) => {
        aiStatus = `Working… ${done}/${total}`;
        render();
      });
      const byId = new Map(suggestions.map((x) => [x.id, x]));
      await update((st) => ({
        ...st,
        settings,
        txns: st.txns.map((t) => {
          const sgt = byId.get(t.id);
          return sgt && t.category === 'Uncategorised' ? { ...t, kind: sgt.kind, category: sgt.category, source: 'ai' as const } : t;
        }),
      }));
      aiStatus = `Categorised ${suggestions.length} of ${review.length}. Check them under Transactions — tap one to correct it.`;
    } catch (e) {
      aiStatus = (e as Error).message;
    }
    render();
  });
  root.querySelector('#export')!.addEventListener('click', () => {
    // The API key stays out of backups.
    const { aiApiKey: _key, ...settings } = app.state.settings;
    download(`expenses-backup-${new Date().toISOString().slice(0, 10)}.json`, 'application/json', JSON.stringify({ ...app.state, settings }));
  });
  root.querySelector<HTMLInputElement>('#restore')!.addEventListener('change', async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text()) as AppState;
      if (!Array.isArray(data.txns) || !Array.isArray(data.accounts)) throw new Error('Not a backup file');
      if (!confirm(`Replace current data with ${data.txns.length} transactions from the backup?`)) return;
      const base = emptyState();
      await update((st) => ({ ...base, ...data, settings: { ...base.settings, ...data.settings, aiApiKey: st.settings.aiApiKey } }));
      toast('Backup restored');
    } catch (err) {
      toast(`Could not restore: ${(err as Error).message}`);
    }
  });
  root.querySelector('#csv')!.addEventListener('click', () => {
    download(`expenses-${new Date().toISOString().slice(0, 10)}.csv`, 'text/csv', toCsv(app.state));
  });
  root.querySelector('#wipe')!.addEventListener('click', async () => {
    if (!confirm('Delete all accounts, transactions and rules from this device?')) return;
    await update(() => emptyState());
    toast('All data deleted');
  });
}
