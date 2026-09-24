import type { Kind } from '../types';
import { KIND_LABEL } from '../categorize/categories';
import { buildPreview, commitPreview, deleteImport, parseFile, recategorizeAll, type ImportPreview } from '../importer';
import { PasswordNeededError } from '../parse/errors';
import { requestPersistence } from '../store';
import { app, askConfirm, navigate, render, toast, update } from './app';
import { dayLabel, esc, inr, kindVar } from './format';
import { txnRow } from './transactions';

interface Pending { file: File; preview?: ImportPreview; error?: string; needsPassword?: boolean; wrongPassword?: boolean }

let pending: Pending[] = [];
let busy = false;

async function processFile(p: Pending, password?: string) {
  try {
    const result = await parseFile(p.file, password);
    p.needsPassword = false;
    if (!result.txns.length) {
      p.error = result.warnings[0] ?? 'No transactions found.';
      return;
    }
    p.preview = buildPreview(result, app.state, p.file.name);
  } catch (e) {
    if (e instanceof PasswordNeededError) {
      p.needsPassword = true;
      p.wrongPassword = e.incorrect;
    } else {
      p.error = `Could not read this file: ${(e as Error).message}`;
    }
  }
}

function previewCard(p: Pending, i: number): string {
  if (p.needsPassword) {
    return `<div class="card">
      <h2 class="ellipsis">${esc(p.file.name)}</h2>
      <p class="small muted">This PDF is password protected. Banks usually use a mix of your name and date of birth — check the email the statement came with.</p>
      ${p.wrongPassword ? '<p class="small bad">That password did not work.</p>' : ''}
      <div class="row"><input type="password" data-pw="${i}" placeholder="PDF password" autocomplete="off"><button class="btn primary" data-unlock="${i}">Open</button></div>
    </div>`;
  }
  if (p.error) {
    return `<div class="card"><h2 class="ellipsis">${esc(p.file.name)}</h2><p class="bad small">${esc(p.error)}</p>
      <button class="btn" data-remove="${i}">Remove</button></div>`;
  }
  const pv = p.preview!;
  const { result, account, fresh } = pv;
  const dates = result.txns.map((t) => t.date).sort();
  const debits = result.txns.filter((t) => t.direction === 'debit').reduce((a, t) => a + t.amount, 0);
  const credits = result.txns.filter((t) => t.direction === 'credit').reduce((a, t) => a + t.amount, 0);
  const counts = new Map<Kind, number>();
  for (const t of fresh) counts.set(t.kind, (counts.get(t.kind) ?? 0) + 1);
  const review = fresh.filter((t) => t.category === 'Uncategorised').length;
  const hasBalance = result.txns.some((t) => t.balance != null);

  return `<div class="card">
    <div class="row between"><h2 class="ellipsis" style="margin:0">${esc(account.bank)} ••${esc(account.number.slice(-4))}</h2>
      <button class="btn" data-remove="${i}" aria-label="Discard">✕</button></div>
    <p class="small muted" style="margin:4px 0 10px">${esc(p.file.name)}<br>${esc(dates[0])} to ${esc(dates[dates.length - 1])}${account.holderName ? ` · ${esc(account.holderName)}` : ''}</p>
    <table class="simple">
      <tr><td>Rows read</td><td class="num">${result.txns.length}</td></tr>
      <tr><td>Money out / in</td><td class="num">${inr(debits)} / ${inr(credits)}</td></tr>
      <tr><td>Balance check</td><td>${!hasBalance ? '<span class="muted">No balance column</span>'
        : result.balanceMismatches === 0 ? '<span class="ok">✓ Every row adds up</span>'
        : `<span class="bad">${result.balanceMismatches} row(s) don't add up — check them</span>`}</td></tr>
      <tr><td>New</td><td class="num">${fresh.length}${pv.duplicates ? ` <span class="muted">(${pv.duplicates} already imported)</span>` : ''}</td></tr>
    </table>
    ${fresh.length ? `<div class="chips" style="margin-top:10px;flex-wrap:wrap">
      ${[...counts.entries()].map(([k, n]) => `<span class="chip"><span class="dot" style="background:${kindVar(k)}"></span> ${esc(KIND_LABEL[k])} ${n}</span>`).join('')}
      ${review ? `<span class="chip">Needs review ${review}</span>` : ''}
    </div>
    <details><summary class="small" style="cursor:pointer;margin:6px 0">See all ${fresh.length} rows</summary>
      <div class="list" style="margin-top:6px">${fresh.map(txnRow).join('')}</div>
    </details>` : ''}
  </div>`;
}

function uploadedList(): string {
  const { imports, txns, accounts } = app.state;
  if (!imports.length) return '';
  const rows = [...imports].sort((a, b) => b.importedAt - a.importedAt);
  return `<h2 style="margin:22px 4px 8px">Uploaded statements</h2>
    <div class="list">${rows.map((r) => {
      const acc = accounts.find((a) => a.id === r.accountId);
      const n = txns.filter((t) => t.importId === r.id).length;
      return `<div class="txn" style="cursor:default">
        <span class="grow">
          <div class="name ellipsis">${esc(r.fileName)}</div>
          <div class="meta">${esc(acc ? `${acc.bank} ••${acc.number.slice(-4)}` : r.accountId)} · ${esc(r.from)} to ${esc(r.to)} · ${n} rows<br>Uploaded ${esc(dayLabel(new Date(r.importedAt).toISOString().slice(0, 10)))}</div>
        </span>
        <button class="btn danger" data-del-import="${esc(r.id)}">Delete</button>
      </div>`;
    }).join('')}</div>
    <p class="tiny" style="margin:8px 4px">Deleting a statement removes its transactions from every screen. You can upload it again later.</p>`;
}

export function renderImport(root: HTMLElement) {
  const ready = pending.filter((p) => p.preview && p.preview.fresh.length);
  root.innerHTML = `
    <h1>Upload</h1>
    <label class="drop">
      <input type="file" id="file" accept=".pdf,.xls,.xlsx,.csv,application/pdf" multiple>
      <div style="font-size:17px;font-weight:600">Choose statements</div>
      <div class="small muted">PDF, Excel (.xls/.xlsx) or CSV · several at once is fine</div>
    </label>
    <p class="tiny" style="margin:8px 4px 14px">Files are read on this device and never uploaded anywhere.</p>
    ${busy ? '<div class="card small muted">Reading…</div>' : ''}
    ${pending.map(previewCard).join('')}
    ${ready.length ? `<button class="btn primary block" id="save">Save ${ready.reduce((a, p) => a + p.preview!.fresh.length, 0)} transactions</button>` : ''}
    ${pending.length && !ready.length && !busy && pending.every((p) => p.preview) ? '<p class="muted small">Nothing new to save.</p>' : ''}
    ${uploadedList()}
  `;
  root.querySelectorAll<HTMLElement>('[data-del-import]').forEach((b) => b.addEventListener('click', async () => {
    const rec = app.state.imports.find((i) => i.id === b.dataset.delImport);
    if (!rec) return;
    const n = app.state.txns.filter((t) => t.importId === rec.id).length;
    if (!(await askConfirm(`Delete "${rec.fileName}" and its ${n} transactions? Your monthly plans and learned rules stay.`, 'Delete statement'))) return;
    await update((s) => deleteImport(s, rec.id));
    toast('Statement deleted');
  }));

  root.querySelector<HTMLInputElement>('#file')!.addEventListener('change', async (e) => {
    const files = [...((e.target as HTMLInputElement).files ?? [])];
    if (!files.length) return;
    busy = true;
    render();
    for (const file of files) {
      const p: Pending = { file };
      pending.push(p);
      await processFile(p);
    }
    busy = false;
    render();
  });
  root.querySelectorAll<HTMLElement>('[data-remove]').forEach((b) => b.addEventListener('click', () => {
    pending.splice(Number(b.dataset.remove), 1);
    render();
  }));
  root.querySelectorAll<HTMLElement>('[data-unlock]').forEach((b) => b.addEventListener('click', async () => {
    const i = Number(b.dataset.unlock);
    const pw = root.querySelector<HTMLInputElement>(`[data-pw="${i}"]`)!.value;
    busy = true;
    render();
    await processFile(pending[i], pw);
    busy = false;
    render();
  }));
  root.querySelector('#save')?.addEventListener('click', async () => {
    let added = 0;
    await update((s) => {
      let next = s;
      for (const p of pending) {
        if (!p.preview) continue;
        // Rebuild against the latest state so files in one batch pair with each other.
        const pv = buildPreview(p.preview.result, next, p.file.name);
        added += pv.fresh.length;
        next = commitPreview(next, pv);
        const holder = pv.account.holderName;
        if (holder && !next.settings.ownNames.some((n) => n.toUpperCase() === holder)) {
          next = { ...next, settings: { ...next.settings, ownNames: [...next.settings.ownNames, holder] } };
        }
      }
      return recategorizeAll(next);
    });
    pending = [];
    void requestPersistence();
    toast(`Saved ${added} transactions`);
    app.filters.kind = 'all';
    app.filters.category = '';
    navigate('#overview');
  });
}
