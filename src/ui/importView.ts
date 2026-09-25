import type { Kind } from '../types';
import { defaultCategory, KIND_LABEL } from '../categorize/categories';
import { applyRescan, buildPreview, commitPreview, deleteImport, diffRescan, parseFile, parseThorough, recategorizeAll, type ImportPreview } from '../importer';
import { PasswordNeededError } from '../parse/errors';
import { deleteFile, loadFile, requestPersistence, saveFile, type StoredFile } from '../store';
import { app, askConfirm, navigate, render, toast, update } from './app';
import { dayLabel, esc, inr, kindVar } from './format';
import { txnRow } from './transactions';

interface Pending { file: File; preview?: ImportPreview; error?: string; needsPassword?: boolean; wrongPassword?: boolean }

let pending: Pending[] = [];
let busy = false;
/** A rescan or AI check that is running, shown on its statement until it finishes. */
let working: { id: string; what: 'rescan' | 'ai'; done: number; total: number } | null = null;

function setWorking(w: typeof working) {
  working = w;
  render();
}

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

/** Asks for a file with a hidden picker (for statements uploaded before files were kept). */
function pickFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept: '.pdf,.xls,.xlsx,.csv,application/pdf' });
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null));
    input.click();
  });
}

/** In-page password prompt for protected PDFs. */
function askPassword(fileName: string, wrong: boolean): Promise<string | null> {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'sheet-backdrop';
    backdrop.innerHTML = `<form class="sheet" novalidate>
      <div class="grab"></div>
      <h2>Password for ${esc(fileName)}</h2>
      ${wrong ? '<p class="small bad">That password did not work.</p>' : '<p class="small muted">This PDF is password protected.</p>'}
      <label class="field"><span>PDF password</span><input type="password" id="rp" autocomplete="off"></label>
      <div class="row"><button type="button" class="btn grow" data-no>Cancel</button><button class="btn primary grow">Open</button></div>
    </form>`;
    const done = (v: string | null) => { backdrop.remove(); resolve(v); };
    backdrop.querySelector('[data-no]')!.addEventListener('click', () => done(null));
    backdrop.querySelector('form')!.addEventListener('submit', (e) => { e.preventDefault(); done(backdrop.querySelector<HTMLInputElement>('#rp')!.value); });
    document.body.append(backdrop);
    backdrop.querySelector<HTMLInputElement>('#rp')!.focus();
  });
}

async function rescan(importId: string) {
  if (working) return;
  const rec = app.state.imports.find((i) => i.id === importId);
  if (!rec) return;
  let file: StoredFile | undefined = await loadFile(importId);
  if (!file) {
    toast('This statement was uploaded before files were kept. Choose the same file to rescan it.');
    const picked = await pickFile();
    if (!picked) return;
    file = { name: picked.name, type: picked.type, data: await picked.arrayBuffer() };
  }
  let password: string | undefined;
  let result;
  for (;;) {
    try {
      setWorking({ id: importId, what: 'rescan', done: 0, total: 0 });
      result = await parseThorough(file.data, file.name, file.type, password);
      break;
    } catch (e) {
      setWorking(null);
      if (e instanceof PasswordNeededError) {
        const pw = await askPassword(file.name, e.incorrect);
        if (pw == null) return;
        password = pw;
        continue;
      }
      toast(`Could not read the file: ${(e as Error).message}`);
      return;
    }
  }
  setWorking(null);
  const diff = diffRescan(app.state, importId, result);
  // Keep the file for next time if it had to be picked again.
  if (!rec.hasFile) {
    await saveFile(importId, file);
    await update((s) => ({ ...s, imports: s.imports.map((i) => (i.id === importId ? { ...i, hasFile: true } : i)) }));
  }
  const balance = result.balanceMismatches === 0 ? 'The running balance adds up on every row.' : `${result.balanceMismatches} row(s) still don't add up to the running balance; check them against the PDF.`;
  const nMiss = diff.missing.length, nFix = diff.corrected.length;
  if (!nMiss && !nFix) {
    await update((s) => applyRescan(s, importId, diff));
    toast(`Nothing to fix: all ${result.txns.length} rows match. ${balance}`);
    return;
  }
  const parts = [
    nMiss ? `${nMiss} missed row${nMiss > 1 ? 's' : ''} to add` : '',
    nFix ? `${nFix} row${nFix > 1 ? 's' : ''} with a corrected description (payee and category will be re-checked; types you set by hand stay)` : '',
  ].filter(Boolean);
  const ok = await askConfirm(`Rescan found ${parts.join(' and ')}. ${balance} Apply?`, 'Apply fixes', false);
  if (!ok) return;
  await update((s) => applyRescan(s, importId, diff));
  toast([nMiss ? `Added ${nMiss}` : '', nFix ? `corrected ${nFix}` : ''].filter(Boolean).join(', '));
}

async function aiCheck(importId: string) {
  if (!app.state.settings.geminiKey) {
    toast('Add your free Gemini API key in Settings first.', { label: 'Open Settings', run: () => navigate('#settings') });
    return;
  }
  const txns = app.state.txns.filter((t) => t.importId === importId);
  if (!txns.length || working) return;
  setWorking({ id: importId, what: 'ai', done: 0, total: txns.length });
  try {
    const [{ checkWithGemini }, { openAiReview }] = await Promise.all([import('../categorize/gemini'), import('./aiReview')]);
    const suggestions = await checkWithGemini(txns, app.state.settings, (done, total) => {
      if (working?.id === importId) setWorking({ id: importId, what: 'ai', done, total });
    });
    setWorking(null);
    openAiReview(suggestions);
  } catch (e) {
    setWorking(null);
    toast((e as Error).message);
  }
}

function progressNote(w: NonNullable<typeof working>): string {
  if (w.what === 'rescan') {
    return `<div class="work-note" role="status"><span class="spinner"></span><div class="grow">Reading the file again with several settings…</div></div>`;
  }
  // Show a little progress before the first batch comes back, so the bar never looks stuck at zero.
  const pct = w.total ? Math.max(8, Math.round((w.done / w.total) * 100)) : 8;
  return `<div class="work-note" role="status"><span class="spinner"></span><div class="grow">
      <div>AI check in progress: Gemini is reading ${w.total} rows${w.done ? ` (${w.done} done)` : ''}. This usually takes 10–60 seconds; keep this page open.</div>
      <div class="work-bar"><span style="width:${pct}%"></span></div>
    </div></div>`;
}

function uploadedList(): string {
  const { imports, txns, accounts } = app.state;
  if (!imports.length) return '';
  const rows = [...imports].sort((a, b) => b.importedAt - a.importedAt);
  return `<h2 style="margin:22px 4px 8px">Uploaded statements</h2>
    <div class="list">${rows.map((r) => {
      const acc = accounts.find((a) => a.id === r.accountId);
      const n = txns.filter((t) => t.importId === r.id).length;
      const check = r.balanceMismatches == null ? ''
        : r.balanceMismatches === 0 ? '<span class="pill ok">✓ Balance adds up</span>'
        : `<span class="pill warn">⚠ ${r.balanceMismatches} gap${r.balanceMismatches > 1 ? 's' : ''} in balance · rescan</span>`;
      return `<div class="upload-row">
        <div class="grow">
          <div class="name ellipsis">${esc(r.fileName)}</div>
          <div class="meta">${esc(acc ? `${acc.bank} ••${acc.number.slice(-4)}` : r.accountId)} · ${esc(r.from)} to ${esc(r.to)} · ${n} rows</div>
          <div class="meta">Uploaded ${esc(dayLabel(new Date(r.importedAt).toISOString().slice(0, 10)))}${r.rescannedAt ? ` · rescanned ${esc(dayLabel(new Date(r.rescannedAt).toISOString().slice(0, 10)))}` : ''}</div>
          ${check ? `<div style="margin-top:6px">${check}</div>` : ''}
        </div>
        <div class="upload-actions">
          <button class="btn small-btn" data-rescan="${esc(r.id)}" ${working ? 'disabled' : ''}>${working?.id === r.id && working.what === 'rescan' ? '<span class="spinner"></span>Rescanning' : 'Rescan'}</button>
          <button class="btn small-btn" data-aicheck="${esc(r.id)}" ${working ? 'disabled' : ''}>${working?.id === r.id && working.what === 'ai' ? '<span class="spinner"></span>Checking' : 'AI check'}</button>
          <button class="btn small-btn danger" data-del-import="${esc(r.id)}" ${working ? 'disabled' : ''}>Delete</button>
        </div>
      </div>${working?.id === r.id ? progressNote(working) : ''}`;
    }).join('')}</div>
    <p class="tiny" style="margin:8px 4px"><strong>Rescan</strong> reads the file again with several settings and adds any rows that were missed; your changes to existing rows stay. <strong>AI check</strong> (optional, free Gemini key in Settings) suggests payee names and categories for you to review. <strong>Delete</strong> removes the statement and its transactions.</p>`;
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
    await deleteFile(rec.id);
    toast('Statement deleted');
  }));
  root.querySelectorAll<HTMLElement>('[data-rescan]').forEach((b) => b.addEventListener('click', () => void rescan(b.dataset.rescan!)));
  root.querySelectorAll<HTMLElement>('[data-aicheck]').forEach((b) => b.addEventListener('click', () => void aiCheck(b.dataset.aicheck!)));

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
  // Tick or untick "Counted" before saving the statement.
  root.querySelectorAll<HTMLInputElement>('input[data-counted]').forEach((box) => box.addEventListener('change', () => {
    for (const p of pending) {
      const t = p.preview?.fresh.find((x) => x.id === box.dataset.counted);
      if (t) t.excluded = !box.checked;
    }
    render();
  }));
  // Change the type of a row before saving the statement.
  root.querySelectorAll<HTMLSelectElement>('select[data-counts]').forEach((sel) => sel.addEventListener('change', () => {
    for (const p of pending) {
      const t = p.preview?.fresh.find((x) => x.id === sel.dataset.counts);
      if (t) {
        t.kind = sel.value as Kind;
        t.category = defaultCategory(t.kind, t.category);
        t.source = 'manual';
      }
    }
    render();
  }));
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
    const toStore: { id: string; file: File }[] = [];
    await update((s) => {
      let next = s;
      for (const p of pending) {
        if (!p.preview) continue;
        // Rebuild against the latest state so files in one batch pair with each other.
        const pv = buildPreview(p.preview.result, next, p.file.name);
        // Keep the types you changed in the preview.
        const edited = new Map(p.preview.fresh.map((t) => [t.id, t]));
        pv.fresh = pv.fresh.map((t) => {
          const o = edited.get(t.id);
          if (!o) return t;
          const typed = o.source === 'manual' ? { kind: o.kind, category: o.category, source: 'manual' as const } : {};
          return { ...t, ...typed, excluded: o.excluded };
        });
        added += pv.fresh.length;
        if (pv.fresh.length) {
          pv.record.hasFile = true;
          toStore.push({ id: pv.record.id, file: p.file });
        }
        next = commitPreview(next, pv);
        const holder = pv.account.holderName;
        if (holder && !next.settings.ownNames.some((n) => n.toUpperCase() === holder)) {
          next = { ...next, settings: { ...next.settings, ownNames: [...next.settings.ownNames, holder] } };
        }
      }
      return recategorizeAll(next);
    });
    pending = [];
    // Keep the original files so statements can be rescanned later.
    for (const f of toStore) {
      await saveFile(f.id, { name: f.file.name, type: f.file.type, data: await f.file.arrayBuffer() });
    }
    void requestPersistence();
    toast(`Saved ${added} transactions`);
    app.filters.kind = 'all';
    app.filters.category = '';
    navigate('#overview');
  });
}
