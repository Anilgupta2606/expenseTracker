import type { AppState } from '../types';
import { recategorizeAll } from '../importer';
import { emptyState, migrate } from '../store';
import { app, askConfirm, toast, update } from './app';
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
      <h2>Your data</h2>
      <p class="small muted" style="margin-top:-4px">Stored only in this browser. Export a backup now and then, especially before clearing Safari data.</p>
      <div class="row wrap">
        <button class="btn" id="export">Download backup</button>
        <button class="btn" id="copy-backup">Copy backup</button>
        <label class="btn" style="display:inline-flex;align-items:center">Restore from file<input type="file" id="restore" accept="application/json,.json" hidden></label>
        <button class="btn" id="paste-restore">Restore from text</button>
        <button class="btn" id="csv">Download CSV</button>
        <button class="btn danger" id="wipe">Delete everything</button>
      </div>
      <textarea id="backup-text" rows="4" hidden style="margin-top:10px;font-size:12px"></textarea>
    </div>
    <p class="tiny" style="text-align:center">Expense Tracker · everything stays on this device</p>
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
    if (!(await askConfirm(`Delete ${id} and all its transactions?`, 'Delete account'))) return;
    await update((st) => recategorizeAll({ ...st, accounts: st.accounts.filter((a) => a.id !== id), txns: st.txns.filter((t) => t.accountId !== id), imports: st.imports.filter((i) => i.accountId !== id) }));
  }));
  root.querySelector('#export')!.addEventListener('click', () => {
    download(`expenses-backup-${new Date().toISOString().slice(0, 10)}.json`, 'application/json', JSON.stringify(app.state));
  });
  const restoreFrom = async (textData: string) => {
    try {
      const data = JSON.parse(textData) as AppState;
      if (!Array.isArray(data.txns) || !Array.isArray(data.accounts)) throw new Error('Not a backup file');
      if (!(await askConfirm(`Replace current data with ${data.txns.length} transactions from the backup?`, 'Restore', false))) return;
      await update(() => migrate(data));
      toast('Backup restored');
    } catch (err) {
      toast(`Could not restore: ${(err as Error).message}`);
    }
  };
  root.querySelector<HTMLInputElement>('#restore')!.addEventListener('change', async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (file) await restoreFrom(await file.text());
  });
  root.querySelector('#copy-backup')!.addEventListener('click', async () => {
    const json = JSON.stringify(app.state);
    try {
      await navigator.clipboard.writeText(json);
      toast('Backup copied. Paste it into Notes or a file to keep it.');
    } catch {
      const box = root.querySelector<HTMLTextAreaElement>('#backup-text')!;
      box.value = json;
      box.hidden = false;
      box.select();
      toast('Select all and copy the text below');
    }
  });
  root.querySelector('#paste-restore')!.addEventListener('click', async () => {
    const box = root.querySelector<HTMLTextAreaElement>('#backup-text')!;
    if (box.hidden || !box.value.trim()) {
      box.value = '';
      box.hidden = false;
      box.placeholder = 'Paste a backup here, then tap Restore from text again';
      box.focus();
      return;
    }
    await restoreFrom(box.value);
  });
  root.querySelector('#csv')!.addEventListener('click', () => {
    download(`expenses-${new Date().toISOString().slice(0, 10)}.csv`, 'text/csv', toCsv(app.state));
  });
  root.querySelector('#wipe')!.addEventListener('click', async () => {
    if (!(await askConfirm('Delete all accounts, transactions, monthly plans and rules from this device?', 'Delete everything'))) return;
    await update(() => emptyState());
    toast('All data deleted');
  });
}
