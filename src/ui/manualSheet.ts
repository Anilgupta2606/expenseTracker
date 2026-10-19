import type { Kind, Txn } from '../types';
import { CATEGORIES, KIND_LABEL } from '../categorize/categories';
import { nameKey } from '../categorize/engine';
import { hash } from '../parse/util';
import { app, askConfirm, toast, update } from './app';
import { esc } from './format';
import { mountSplitTags, readSplitTags, splitTagsFor } from './splitTags';
import { NoMac, macOcr, readReceipt, shrinkPhoto } from '../receipt';

export const MANUAL_ACCOUNT = 'MANUAL';
export const MANUAL_IMPORT = 'manual';
const MODES = ['Cash', 'UPI', 'Card', 'Other'];
const KINDS: Kind[] = ['spend', 'investment', 'income', 'transfer'];

const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Add a cash (or any other) transaction by hand, or edit/delete one added earlier. */
export function openManualSheet(existing?: Txn, defaultDate?: string) {
  let kind: Kind = existing?.kind ?? 'spend';
  let category = existing?.category ?? 'Food & Dining';
  const [modeFromDesc, ...rest] = (existing?.description ?? '').split(': ');
  const mode = existing && MODES.includes(modeFromDesc) ? modeFromDesc : 'Cash';
  const text = existing ? (rest.length ? rest.join(': ') : existing.description) : '';
  const st = splitTagsFor(existing);
  const amountNow = () => parseFloat((backdrop.querySelector<HTMLInputElement>('#m-amount')?.value ?? '').replace(/[^\d.]/g, '')) || 0;

  let scan: { busy?: boolean; msg?: string; bad?: boolean } = {};
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  const close = () => backdrop.remove();
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

  const draw = () => {
    const cats = CATEGORIES[kind];
    if (!cats.includes(category)) category = cats[0];
    const vals = {
      amount: backdrop.querySelector<HTMLInputElement>('#m-amount')?.value ?? (existing ? String(existing.amount) : ''),
      date: backdrop.querySelector<HTMLInputElement>('#m-date')?.value ?? existing?.date ?? defaultDate ?? todayISO(),
      text: backdrop.querySelector<HTMLInputElement>('#m-text')?.value ?? text,
      mode: backdrop.querySelector<HTMLSelectElement>('#m-mode')?.value ?? mode,
      dir: backdrop.querySelector<HTMLSelectElement>('#m-dir')?.value ?? existing?.direction ?? 'debit',
    };
    backdrop.innerHTML = `<div class="sheet" role="dialog" aria-label="${existing ? 'Edit' : 'Add'} transaction">
      <div class="grab"></div>
      <h2>${existing ? 'Edit transaction' : 'Add transaction'}</h2>
      ${existing ? '' : `<div class="scan-row"><label class="btn${scan.busy ? ' busy' : ''}" id="m-scan">📷 ${scan.busy ? 'Reading…' : 'Scan receipt'}
        <input type="file" id="m-scan-in" accept="image/*" capture="environment" hidden ${scan.busy ? 'disabled' : ''}></label>
        ${scan.msg ? `<p class="small ${scan.bad ? 'bad' : 'muted'}" id="m-scan-msg">${esc(scan.msg)}</p>` : ''}</div>`}
      <div class="seg" style="margin-bottom:12px">
        ${KINDS.map((k) => `<button data-k="${k}" class="${k === kind ? 'on' : ''}">${esc(KIND_LABEL[k])}</button>`).join('')}
      </div>
      <label class="field"><span>Amount</span>
        <div class="money"><span>₹</span><input type="text" inputmode="decimal" id="m-amount" value="${esc(vals.amount)}" placeholder="0" autocomplete="off"></div></label>
      <label class="field"><span>What was it for?</span>
        <input type="text" id="m-text" value="${esc(vals.text)}" placeholder="e.g. Vegetables, auto fare" autocomplete="off"></label>
      <div class="row" style="gap:10px;align-items:flex-start">
        <label class="field grow"><span>Date</span><input type="date" id="m-date" value="${esc(vals.date)}"></label>
        <label class="field grow"><span>Paid by</span>
          <select id="m-mode">${MODES.map((m) => `<option ${m === vals.mode ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
      </div>
      <label class="field"><span>Category</span>
        <select id="m-cat">${cats.map((c) => `<option ${c === category ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
      ${kind === 'investment' || kind === 'transfer' ? `<label class="field"><span>Direction</span>
        <select id="m-dir"><option value="debit" ${vals.dir === 'debit' ? 'selected' : ''}>Money out</option><option value="credit" ${vals.dir === 'credit' ? 'selected' : ''}>Money in${kind === 'investment' ? ' (redeemed)' : ''}</option></select></label>` : ''}
      <div id="st-box"></div>
      <p class="small bad" id="m-err" hidden></p>
      <div class="row">
        ${existing ? '<button class="btn danger" id="m-del">Delete</button>' : ''}
        <button class="btn grow" id="m-cancel">Cancel</button>
        <button class="btn primary grow" id="m-save">${existing ? 'Save' : 'Add'}</button>
      </div>
    </div>`;
    backdrop.querySelectorAll<HTMLElement>('[data-k]').forEach((b) => b.addEventListener('click', () => { kind = b.dataset.k as Kind; draw(); }));
    backdrop.querySelector<HTMLInputElement>('#m-scan-in')?.addEventListener('change', async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file || scan.busy) return;
      scan = { busy: true, msg: 'Reading the receipt on your Mac…' }; draw();
      try {
        const lines = await macOcr(await shrinkPhoto(file));
        if (!lines.length) { scan = { msg: 'No text found in that photo — try again closer, with the whole receipt in view.', bad: true }; return; }
        scan = { busy: true, msg: 'Picking out the amount, shop and date…' }; draw();
        const { fields: f, byAi } = await readReceipt(lines, app.state.settings);
        const set = (id: string, v?: string | number) => { const el = backdrop.querySelector<HTMLInputElement>(`#${id}`); if (el && v !== undefined && v !== '') el.value = String(v); };
        kind = 'spend';
        if (f.category) category = f.category;
        set('m-amount', f.amount); set('m-text', f.merchant); set('m-date', f.date);
        const got = [f.amount ? 'amount' : '', f.merchant ? 'shop' : '', f.date ? 'date' : '', f.category ? 'category' : ''].filter(Boolean);
        scan = got.length
          ? { msg: `Filled in ${got.join(', ')}${byAi ? '' : ' (best guess — no AI available)'}. Check them, then tap Add.` }
          : { msg: 'Could not find the total on that receipt — enter it by hand.', bad: true };
      } catch (err) {
        scan = { bad: true, msg: err instanceof NoMac
          ? 'Scanning needs your Mac’s AI to read the receipt, and it is not reachable now (is the Mac on, with Tailscale on here? or its AI not yet updated). Enter it by hand for now.'
          : (err as Error).message || 'Could not read the receipt.' };
      } finally { scan.busy = false; draw(); }
    });
    const split = mountSplitTags(backdrop.querySelector<HTMLElement>('#st-box')!, st, amountNow, () => ({ kind, category }));
    backdrop.querySelector<HTMLInputElement>('#m-amount')!.addEventListener('input', () => split.refresh());
    backdrop.querySelector<HTMLSelectElement>('#m-cat')!.addEventListener('change', (e) => { category = (e.target as HTMLSelectElement).value; });
    backdrop.querySelector('#m-cancel')!.addEventListener('click', close);
    backdrop.querySelector('#m-del')?.addEventListener('click', async () => {
      close();
      if (!(await askConfirm('Delete this transaction?', 'Delete'))) return;
      await update((s) => ({ ...s, txns: s.txns.filter((t) => t.id !== existing!.id) }));
      toast('Deleted');
    });
    backdrop.querySelector('#m-save')!.addEventListener('click', async () => {
      const get = (id: string) => backdrop.querySelector<HTMLInputElement>(`#${id}`)!.value.trim();
      const amount = parseFloat(get('m-amount').replace(/[^\d.]/g, ''));
      const date = get('m-date');
      const what = get('m-text') || category;
      const err = backdrop.querySelector<HTMLElement>('#m-err')!;
      if (!(amount > 0)) { err.textContent = 'Enter an amount above zero.'; err.hidden = false; return; }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { err.textContent = 'Pick a date.'; err.hidden = false; return; }
      const extra = readSplitTags(st, Math.round(amount * 100) / 100);
      if (extra.error) { err.textContent = extra.error; err.hidden = false; return; }
      const direction = kind === 'income' ? 'credit' : kind === 'spend' || kind === 'cc_bill' ? 'debit'
        : (backdrop.querySelector<HTMLSelectElement>('#m-dir')?.value as 'debit' | 'credit') ?? 'debit';
      const now = Date.now();
      const txn: Txn = {
        id: existing?.id ?? `m-${hash(`${now}-${Math.random()}`)}`,
        accountId: MANUAL_ACCOUNT,
        importId: MANUAL_IMPORT,
        date,
        description: `${get('m-mode')}: ${what}`,
        amount: Math.round(amount * 100) / 100,
        direction,
        kind,
        category,
        source: 'manual',
        merchantKey: nameKey(what),
        merchantName: what.slice(0, 40),
        importedAt: existing?.importedAt ?? now,
        note: existing?.note,
        // editing used to drop an unticked Counted; it is kept now
        ...(existing?.excluded ? { excluded: true } : {}),
        ...(extra.tags ? { tags: extra.tags } : {}),
        ...(extra.splits ? { splits: extra.splits } : {}),
      };
      close();
      await update((s) => ({
        ...s,
        txns: [...s.txns.filter((t) => t.id !== txn.id), txn].sort((a, b) => b.date.localeCompare(a.date)),
      }));
      app.filters.month = date.slice(0, 7);
      toast(existing ? 'Saved' : `Added to ${new Date(date).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}`);
    });
  };
  draw();
  document.body.append(backdrop);
}
