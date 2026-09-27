import { bindSyncCard, syncCard } from './syncUi';
import type { AppState, Kind } from '../types';
import { CATEGORIES, categoryCounted, categoryKey, KIND_LABEL } from '../categorize/categories';
import { recategorizeAll } from '../importer';

const aiStatus: Partial<Record<string, { ok: boolean; text: string }>> = {};
let editingAccount: string | null = null;
const BANK_NAMES = ['HDFC', 'ICICI', 'SBI', 'Axis', 'Kotak', 'IDFC', 'Yes', 'PNB', 'BoB', 'IndusInd', 'AU', 'Federal'];
import { emptyState, migrate } from '../store';
import { checkLogin, usernameOf, withCredentials } from '../auth';
import { app, askConfirm, render, toast, update } from './app';
import { esc, kindVar } from './format';
import { DEFAULT_PLAN_LINK } from '../links';
import { isOn, keyOf, knownModels, listModels, orderOf, pinnedModel, providerInfo, rankModels, rememberModels, restingUntil, wake, type ProviderId } from '../ai/providers';

const splitNames = (s: string) => s.split(/[,\n]/).map((x) => x.trim().toUpperCase()).filter(Boolean);

/** Which service rows are open (the rest show one summary line). Kept while the app is open. */
const aiOpen = new Set<string>();
/** One row per AI service: a summary line that opens into key, check / save / remove and model. */
function aiRows(s: AppState['settings']): string {
  const order = orderOf(s);
  const hm = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `<div class="ai-tools"><button class="link-btn" data-ai-all="open">Expand all</button> · <button class="link-btn" data-ai-all="close">Collapse all</button></div>
  <div class="ai-svc-list">${order.map((id, i) => {
    const p = providerInfo(id), key = keyOf(s, id), on = isOn(s, id), r = restingUntil(id), open = aiOpen.has(id);
    const models = knownModels(id, key), pin = pinnedModel(s, id), best = models[0];
    const dot = !key ? 'none' : !on ? 'off' : r ? 'warn' : 'ok';
    const uses = pin ? `uses ${pin} (pinned)` : best ? `uses ${best}` : key ? 'best model picked on first use' : '';
    const summary = !key ? (p.keyless ? 'not set up' : 'no key') : !on ? 'switched off' : r ? `resting until ${hm(r.until)}` : `ready · ${uses}`;
    const st = aiStatus[id];
    return `<div class="ai-row ${open ? 'open' : ''}" data-ai="${id}">
      <div class="ai-head">
        <button class="ai-toggle" data-ai-toggle="${id}" aria-expanded="${open}" aria-controls="ai-body-${id}">
          <span class="ai-chev" aria-hidden="true">▸</span>
          <span class="ai-dot ${dot}"></span>
          <strong>${i + 1}. ${esc(p.name)}</strong>
          ${p.free ? '<span class="pill ok">free</span>' : '<span class="pill warn">paid</span>'}
          <span class="ai-sum">${esc(summary)}</span>
        </button>
        <button class="btn" data-ai-up="${id}" ${i ? '' : 'disabled'} aria-label="Move ${esc(p.name)} up">↑</button>
        <button class="btn" data-ai-down="${id}" ${i < order.length - 1 ? '' : 'disabled'} aria-label="Move ${esc(p.name)} down">↓</button>
        <label class="small"><input type="checkbox" data-ai-on="${id}" ${on ? 'checked' : ''}> On</label>
      </div>
      <div class="ai-body" id="ai-body-${id}" ${open ? '' : 'hidden'}>
        <p class="tiny muted" style="margin:2px 0 6px">${p.signupUrl ? `Key from <a href="${p.signupUrl}" target="_blank" rel="noopener">${esc(p.signup)}</a>` : esc(p.signup)}${p.note ? ` · ${esc(p.note)}` : ''}${r ? ` · <span class="warn-text">resting: ${esc(r.why)}</span>` : ''}</p>
        <div class="row wrap">
          <input type="password" class="grow" id="ai-key-${id}" value="${esc(key ?? '')}" autocomplete="off" placeholder="${esc(p.keyless ? p.placeholder + ' (its address)' : p.placeholder)}" aria-label="${esc(p.name)} ${p.keyless ? 'address' : 'API key'}">
          <button class="btn" data-ai-check="${id}">Check</button>
          <button class="btn primary" data-ai-save="${id}">Save</button>
          ${key ? `<button class="btn danger" data-ai-clear="${id}">Remove</button>` : ''}
          ${r ? `<button class="btn" data-ai-wake="${id}" title="Try it again now">Wake</button>` : ''}
        </div>
        ${key ? `<label class="field" style="margin-top:8px"><span>Model</span>
          <select id="ai-model-${id}" data-ai-model="${id}">
            <option value="auto" ${pin ? '' : 'selected'}>Auto — the best available${best ? ` (now ${esc(best)})` : ''}</option>
            ${[...new Set([...(pin ? [pin] : []), ...models])].map((m) => `<option value="${esc(m)}" ${m === pin ? 'selected' : ''}>${esc(m)}</option>`).join('')}
          </select></label>
          <p class="tiny muted" style="margin:2px 0 0">${models.length ? `${models.length} usable model${models.length === 1 ? '' : 's'}, best first. Auto moves down this list when one is busy or out of quota.` : 'Press Check to load the models this key can use.'}</p>` : ''}
        ${st ? `<p class="small ${st.ok ? 'ok' : 'bad'}" style="margin:4px 0 0">${esc(st.text)}</p>` : ''}
      </div>
    </div>`;
  }).join('')}</div>`;
}

/** Saves one service's key (Gemini keeps its old field so older backups and devices still read it). */
const withKey = (st: AppState, id: ProviderId, key: string | undefined): AppState => id === 'gemini'
  ? { ...st, settings: { ...st.settings, geminiKey: key, aiKeys: { ...st.settings.aiKeys, gemini: undefined } } }
  : { ...st, settings: { ...st.settings, aiKeys: { ...st.settings.aiKeys, [id]: key } } };
/** A copy for backups: no API keys, no sign-in. */
const noSecrets = (st: AppState) => ({ ...st, auth: undefined, settings: { ...st.settings, geminiKey: undefined, aiKeys: undefined } });

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
      ${state.accounts.length ? `<p class="small muted" style="margin-top:-4px">Bank read wrongly? Tap Edit and pick the right one; later uploads won't change it.</p>
      <table class="simple">
        <tr><th>Account</th><th>Transactions</th><th></th></tr>
        ${state.accounts.map((a) => editingAccount === a.id
          ? `<tr><td colspan="3"><div class="row wrap" style="gap:8px;align-items:flex-end">
              <label class="field grow" style="margin:0"><span>Bank for ••${esc(a.number.slice(-4))}</span>
                <input type="text" id="acct-bank" list="bank-names" value="${esc(a.bank)}" autocomplete="off"></label>
              <datalist id="bank-names">${BANK_NAMES.map((b) => `<option value="${b}">`).join('')}</datalist>
              <button class="btn" data-cancel-account>Cancel</button><button class="btn primary" data-save-account="${esc(a.id)}">Save</button></div></td></tr>`
          : `<tr><td>${esc(a.bank)} ••${esc(a.number.slice(-4))}${a.bankSet === 'manual' ? ' <span class="tiny">(set by you)</span>' : ''}<div class="tiny">${esc(a.holderName ?? '')}</div></td>
          <td class="num">${state.txns.filter((t) => t.accountId === a.id).length}</td>
          <td style="text-align:right;white-space:nowrap"><button class="btn" data-edit-account="${esc(a.id)}">Edit</button> <button class="btn danger" data-del-account="${esc(a.id)}">Delete</button></td></tr>`).join('')}
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
      <h2>Investment plan link</h2>
      <p class="small muted" style="margin-top:-4px">Opened from <strong>Investment plan ↗</strong> in the profile menu. Clear it to hide that item.</p>
      <label class="field"><span>Link</span><input type="url" id="plan-link" value="${esc(s.planLink ?? DEFAULT_PLAN_LINK)}" placeholder="https://…" inputmode="url" autocapitalize="none" spellcheck="false"></label>
      <button class="btn primary" id="save-plan-link">Save link</button>
    </div>

    <div class="card">
      <h2>AI assistants</h2>
      <p class="small muted" style="margin-top:-4px">Optional, free. Used by <strong>AI check</strong> and the AI statement reader on the Upload screen, and by the Assistant. Add keys for as many services as you like: each request goes to the first one in this order that is switched on and not resting; one that runs out of its free limit rests for 15 minutes (yellow) and the next one answers. You review every suggestion before anything changes.</p>
      <p class="small muted">What is sent: date, amount, money in/out and the narration, with long numbers replaced by # and your name by SELF (the statement reader also sends the table's amounts and balances, never your name or account numbers). Free tiers may use what you send to improve their products. Keys are kept on this device (and in your encrypted sync).</p>
      ${aiRows(s)}
    </div>

    ${syncCard()}

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

  bindSyncCard(root);
  root.querySelectorAll<HTMLElement>('[data-edit-account]').forEach((b) => b.addEventListener('click', () => {
    editingAccount = b.dataset.editAccount!;
    render();
    root.querySelector<HTMLInputElement>('#acct-bank')?.select();
  }));
  root.querySelector('[data-cancel-account]')?.addEventListener('click', () => { editingAccount = null; render(); });
  const saveAccount = async () => {
    const id = editingAccount;
    const bank = root.querySelector<HTMLInputElement>('#acct-bank')?.value.trim().slice(0, 30);
    if (!id || !bank) { toast('Type the bank name'); return; }
    editingAccount = null;
    await update((st) => ({ ...st, accounts: st.accounts.map((a) => (a.id === id ? { ...a, bank, bankSet: 'manual', bankChecked: true } : a)) }));
    toast(`Saved as ${bank}`);
  };
  root.querySelector('[data-save-account]')?.addEventListener('click', () => void saveAccount());
  root.querySelector('#acct-bank')?.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') void saveAccount(); });
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
  root.querySelector('#save-plan-link')!.addEventListener('click', async () => {
    const v = val('plan-link').trim();
    if (v && !/^https:\/\//i.test(v)) { toast('Use a full link starting with https://'); return; }
    await update((st) => ({ ...st, settings: { ...st.settings, planLink: v } }));
    toast(v ? 'Investment plan link saved' : 'Investment plan link removed from the menu');
  });
  const aiOrderNow = () => orderOf(app.state.settings);
  root.querySelectorAll<HTMLButtonElement>('[data-ai-up],[data-ai-down]').forEach((btn) => btn.addEventListener('click', async () => {
    const id = (btn.dataset.aiUp ?? btn.dataset.aiDown) as ProviderId, up = btn.dataset.aiUp != null;
    const order = aiOrderNow(), i = order.indexOf(id), j = up ? i - 1 : i + 1;
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    await update((st) => ({ ...st, settings: { ...st.settings, aiOrder: order } }));
  }));
  root.querySelectorAll<HTMLInputElement>('[data-ai-on]').forEach((box) => box.addEventListener('change', async () => {
    const id = box.dataset.aiOn!;
    await update((st) => ({ ...st, settings: { ...st.settings, aiOff: box.checked ? (st.settings.aiOff ?? []).filter((x) => x !== id) : [...new Set([...(st.settings.aiOff ?? []), id])] } }));
  }));
  root.querySelectorAll<HTMLButtonElement>('[data-ai-check]').forEach((btn) => btn.addEventListener('click', async () => {
    const id = btn.dataset.aiCheck as ProviderId, key = val(`ai-key-${id}`).trim(), p = providerInfo(id);
    aiOpen.add(id);
    if (!key) { aiStatus[id] = { ok: false, text: p.keyless ? 'Enter its address first, e.g. http://localhost:11434' : 'Paste your key first.' }; render(); return; }
    aiStatus[id] = { ok: true, text: 'Checking…' };
    render();
    try {
      const models = rankModels(id, await listModels(id, key));
      rememberModels(id, key, models);
      aiStatus[id] = { ok: true, text: models.length ? `✓ Works and is saved on this device. Best model: ${models[0]} (${models.length} usable).` : '✓ Key works and is saved, but none of its models can read statements.' };
      wake(id);
      await update((st) => withKey(st, id, key));
    } catch (e) {
      aiStatus[id] = { ok: false, text: (e as Error).message };
      render();
    }
  }));
  root.querySelectorAll<HTMLButtonElement>('[data-ai-save]').forEach((btn) => btn.addEventListener('click', async () => {
    const id = btn.dataset.aiSave as ProviderId, key = val(`ai-key-${id}`).trim() || undefined;
    await update((st) => withKey(st, id, key));
    toast(key ? `${providerInfo(id).name} key saved on this device` : 'Saved');
  }));
  root.querySelectorAll<HTMLButtonElement>('[data-ai-clear]').forEach((btn) => btn.addEventListener('click', async () => {
    const id = btn.dataset.aiClear as ProviderId;
    delete aiStatus[id];
    await update((st) => withKey(st, id, undefined));
    toast(`${providerInfo(id).name} key removed`);
  }));
  root.querySelectorAll<HTMLButtonElement>('[data-ai-toggle]').forEach((btn) => btn.addEventListener('click', () => {
    const id = btn.dataset.aiToggle!;
    if (aiOpen.has(id)) aiOpen.delete(id); else aiOpen.add(id);
    render();
  }));
  root.querySelectorAll<HTMLButtonElement>('[data-ai-all]').forEach((btn) => btn.addEventListener('click', () => {
    if (btn.dataset.aiAll === 'open') orderOf(app.state.settings).forEach((id) => aiOpen.add(id)); else aiOpen.clear();
    render();
  }));
  root.querySelectorAll<HTMLSelectElement>('[data-ai-model]').forEach((sel) => sel.addEventListener('change', async () => {
    const id = sel.dataset.aiModel!;
    await update((st) => ({ ...st, settings: { ...st.settings, aiModel: { ...st.settings.aiModel, [id]: sel.value === 'auto' ? undefined : sel.value } } }));
    toast(sel.value === 'auto' ? `${providerInfo(id as ProviderId).name}: the best available model` : `${providerInfo(id as ProviderId).name}: always ${sel.value}`);
  }));
  root.querySelectorAll<HTMLButtonElement>('[data-ai-wake]').forEach((btn) => btn.addEventListener('click', () => { wake(btn.dataset.aiWake as ProviderId); render(); }));
  root.querySelector('#export')!.addEventListener('click', () => {
    download(`expenses-backup-${new Date().toISOString().slice(0, 10)}.json`, 'application/json', JSON.stringify(noSecrets(app.state)));
  });
  const restoreFrom = async (textData: string) => {
    try {
      const data = JSON.parse(textData) as AppState;
      if (!Array.isArray(data.txns) || !Array.isArray(data.accounts)) throw new Error('Not a backup file');
      if (!(await askConfirm(`Replace current data with ${data.txns.length} transactions from the backup?`, 'Restore', false))) return;
      await update((st) => ({ ...migrate(data), auth: st.auth,
        settings: { ...migrate(data).settings, geminiKey: st.settings.geminiKey, aiKeys: st.settings.aiKeys, aiOrder: st.settings.aiOrder, aiOff: st.settings.aiOff } }));
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
    const json = JSON.stringify(noSecrets(app.state));
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
