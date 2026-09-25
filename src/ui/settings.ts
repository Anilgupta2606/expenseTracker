import type { AppState, Kind } from '../types';
import { CATEGORIES, categoryCounted, categoryKey, KIND_LABEL } from '../categorize/categories';
import { recategorizeAll } from '../importer';
import { BANK_NAMES } from '../parse/util';

let geminiStatus: { ok: boolean; text: string } | null = null;
import { emptyState, migrate } from '../store';
import { checkLogin, usernameOf, withCredentials } from '../auth';
import { app, askConfirm, render, toast, update } from './app';
import { esc, kindVar } from './format';

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

/** Every category with a Counted switch; changing one updates all its transactions and future uploads. */
function whatCounts(state: AppState): string {
  const kinds: Kind[] = ['spend', 'cc_bill', 'investment', 'income', 'transfer'];
  const n = new Map<string, number>();
  for (const t of state.txns) n.set(categoryKey(t.kind, t.category), (n.get(categoryKey(t.kind, t.category)) ?? 0) + 1);
  return `<div class="card">
    <h2>What counts in totals</h2>
    <p class="small muted" style="margin-top:-4px">Untick a category to leave all its transactions out of spending, investment and income totals, now and in future uploads. You can still tick single transactions back in.</p>
    ${kinds.map((k) => `<div class="count-group">
      <div class="count-head"><span class="dot" style="background:${kindVar(k)}"></span>${esc(KIND_LABEL[k])}</div>
      <div class="count-grid">${CATEGORIES[k].map((c) => {
        const key = categoryKey(k, c);
        return `<label class="count-item"><input type="checkbox" data-catcount="${esc(key)}" ${categoryCounted(state.settings, k, c) ? 'checked' : ''}>
          <span class="grow">${esc(c)}</span><span class="tiny">${n.get(key) ?? ''}</span></label>`;
      }).join('')}</div>
    </div>`).join('')}
  </div>`;
}

export function renderSettings(root: HTMLElement) {
  const { state } = app;
  const s = state.settings;
  const review = state.txns.filter((t) => t.category === 'Uncategorised');

  root.innerHTML = `
    <h1>Settings</h1>

    <div class="card">
      <h2>Sign-in</h2>
      <p class="small muted" style="margin-top:-4px">Signed in as <strong>${esc(usernameOf(state))}</strong>${state.auth ? '' : ' (default login — please change the password)'}. This locks the app screen on this device; it does not encrypt your data.</p>
      <label class="field"><span>Current password</span><input type="password" id="cur-pass" autocomplete="current-password"></label>
      <label class="field"><span>New username</span><input type="text" id="new-user" value="${esc(usernameOf(state))}" autocapitalize="none" spellcheck="false" autocomplete="username"></label>
      <label class="field"><span>New password</span><input type="password" id="new-pass" autocomplete="new-password"></label>
      <label class="field"><span>Repeat new password</span><input type="password" id="new-pass2" autocomplete="new-password"></label>
      <p class="small bad" id="cred-err" hidden></p>
      <button class="btn primary" id="save-cred">Change sign-in</button>
    </div>

    <div class="card">
      <h2>You</h2>
      <p class="small muted" style="margin-top:-4px">Transfers mentioning these names count as <strong>self transfers</strong>, not spend.</p>
      <label class="field"><span>Your name(s) as banks print them</span>
        <input type="text" id="own" value="${esc(s.ownNames.join(', '))}" placeholder="e.g. RAVI KUMAR"></label>
      <label class="field"><span>Family members to treat as self transfer (optional)</span>
        <input type="text" id="family" value="${esc(s.familyNames.join(', '))}" placeholder="e.g. spouse's name"></label>
      <button class="btn primary" id="save-names">Save and re-categorise</button>
    </div>

    ${whatCounts(state)}

    <div class="card">
      <h2>Accounts</h2>
      <p class="small muted" style="margin-top:-4px">If a bank was read wrongly, pick the right one here.</p>
      ${state.accounts.length ? `<table class="simple">
        <tr><th>Account</th><th>Transactions</th><th></th></tr>
        ${state.accounts.map((a) => `<tr><td>
            <select data-bank="${esc(a.id)}" aria-label="Bank for account ending ${esc(a.number.slice(-4))}" class="bank-select">
              ${[...new Set([...BANK_NAMES, a.bank, 'Other'])].map((b) => `<option ${b === a.bank ? 'selected' : ''}>${esc(b)}</option>`).join('')}
            </select> ••${esc(a.number.slice(-4))}<div class="tiny">${esc(a.holderName ?? '')}</div></td>
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
      <h2>Free AI check (Google Gemini)</h2>
      <p class="small muted" style="margin-top:-4px">Optional. On the Upload screen, <strong>AI check</strong> sends a statement's rows to Google Gemini to suggest cleaner payee names and categories and to flag rows that look mixed up. You review every suggestion before anything changes.</p>
      <p class="small muted">What is sent: date, amount, money in/out and the narration, with long numbers (account, phone, reference) replaced by # and your name replaced by SELF. Balances and the PDF itself are never sent. On Google's free tier, Google may use what you send to improve its products.</p>
      <ol class="small muted" style="padding-left:18px;margin:0 0 12px">
        <li>Open <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a> and sign in with a Google account.</li>
        <li>Create an API key (free, no card needed) and paste it below.</li>
      </ol>
      <label class="field"><span>Gemini API key</span><input type="password" id="gkey" value="${esc(s.geminiKey ?? '')}" autocomplete="off" placeholder="AIza…"></label>
      <p class="tiny" style="margin-top:-4px">The app picks the best free Gemini model that is working at the moment, so there is nothing else to set.</p>
      ${geminiStatus ? `<p class="small ${geminiStatus.ok ? 'ok' : 'bad'}">${esc(geminiStatus.text)}</p>` : ''}
      <div class="row wrap"><button class="btn" id="check-gemini">Check key</button><button class="btn primary" id="save-gemini">Save</button>${s.geminiKey ? '<button class="btn danger" id="clear-gemini">Remove key</button>' : ''}</div>
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

  root.querySelector('#save-cred')!.addEventListener('click', async () => {
    const err = root.querySelector<HTMLElement>('#cred-err')!;
    const fail = (m: string) => { err.textContent = m; err.hidden = false; };
    const user = val('new-user').trim();
    const pass = val('new-pass');
    if (!(await checkLogin(app.state, usernameOf(app.state), val('cur-pass')))) return fail('Current password is incorrect.');
    if (!user) return fail('Enter a username.');
    if (pass.length < 4) return fail('Use at least 4 characters for the new password.');
    if (pass !== val('new-pass2')) return fail('The new passwords do not match.');
    const next = await withCredentials(app.state, user, pass);
    await update(() => next);
    toast('Sign-in updated');
  });
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
  root.querySelectorAll<HTMLSelectElement>('select[data-bank]').forEach((sel) => sel.addEventListener('change', async () => {
    const id = sel.dataset.bank!;
    await update((st) => ({ ...st, accounts: st.accounts.map((a) => (a.id === id ? { ...a, bank: sel.value, bankSetByHand: true } : a)) }));
    toast(`Account ••${id.slice(-4)} is now ${sel.value}`);
  }));
  root.querySelectorAll<HTMLInputElement>('[data-catcount]').forEach((box) => box.addEventListener('change', async () => {
    const key = box.dataset.catcount!;
    const counted = box.checked;
    const hits = app.state.txns.filter((t) => categoryKey(t.kind, t.category) === key).length;
    await update((st) => ({
      ...st,
      settings: { ...st.settings, categoryCounted: { ...st.settings.categoryCounted, [key]: counted } },
      txns: st.txns.map((t) => (categoryKey(t.kind, t.category) === key ? { ...t, excluded: !counted } : t)),
    }));
    const name = key.split(':').slice(1).join(':');
    toast(`${name}: ${hits ? `${hits} transaction${hits > 1 ? 's' : ''} ` : ''}${counted ? 'counted' : 'not counted'}${hits ? '' : ' from now on'}`);
  }));
  root.querySelector('#check-gemini')!.addEventListener('click', async () => {
    const key = val('gkey').trim();
    if (!key) { geminiStatus = { ok: false, text: 'Paste your key first.' }; render(); return; }
    geminiStatus = { ok: true, text: 'Checking…' };
    render();
    try {
      const { listGeminiModels } = await import('../categorize/gemini');
      await listGeminiModels(key);
      geminiStatus = { ok: true, text: '✓ Key works and is saved on this device.' };
      // Keep the key in the box after the screen redraws.
      await update((st) => ({ ...st, settings: { ...st.settings, geminiKey: key } }));
    } catch (e) {
      geminiStatus = { ok: false, text: (e as Error).message };
      render();
    }
  });
  root.querySelector('#save-gemini')!.addEventListener('click', async () => {
    const geminiKey = val('gkey').trim() || undefined;
    await update((st) => ({ ...st, settings: { ...st.settings, geminiKey } }));
    toast(geminiKey ? 'Gemini key saved on this device' : 'Saved');
  });
  root.querySelector('#clear-gemini')?.addEventListener('click', async () => {
    await update((st) => ({ ...st, settings: { ...st.settings, geminiKey: undefined } }));
    toast('Gemini key removed');
  });
  root.querySelector('#export')!.addEventListener('click', () => {
    download(`expenses-backup-${new Date().toISOString().slice(0, 10)}.json`, 'application/json', JSON.stringify({ ...app.state, auth: undefined, settings: { ...app.state.settings, geminiKey: undefined } }));
  });
  const restoreFrom = async (textData: string) => {
    try {
      const data = JSON.parse(textData) as AppState;
      if (!Array.isArray(data.txns) || !Array.isArray(data.accounts)) throw new Error('Not a backup file');
      if (!(await askConfirm(`Replace current data with ${data.txns.length} transactions from the backup?`, 'Restore', false))) return;
      await update((st) => ({ ...migrate(data), auth: st.auth, settings: { ...migrate(data).settings, geminiKey: st.settings.geminiKey } }));
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
    const json = JSON.stringify({ ...app.state, auth: undefined, settings: { ...app.state.settings, geminiKey: undefined } });
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
    await update((st) => ({ ...emptyState(), auth: st.auth }));
    toast('All data deleted');
  });
}
