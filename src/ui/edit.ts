import type { Kind, Txn } from '../types';
import { CATEGORIES, categoryCounted, KIND_LABEL } from '../categorize/categories';
import { detectMethod } from '../categorize/engine';
import { app, askConfirm, toast, update } from './app';
import { dayLabel, esc, inrFull, accountLabel } from './format';
import { mountSplitTags, readSplitTags, splitTagsFor } from './splitTags';

const SOURCE_LABEL: Record<Txn['source'], string> = {
  default: 'Guessed from the payment type',
  rule: 'Matched a built-in rule',
  self: 'Your own name or account is in the narration',
  pair: 'Matched a transfer in your other account',
  ai: 'Suggested by the AI check and accepted by you',
  learned: 'From your earlier correction',
  manual: 'Set by you',
};

export function openEditSheet(t: Txn) {
  let kind: Kind = t.kind;
  let category = t.category;
  let title = t.merchantName;
  let counted = !t.excluded;
  const st = splitTagsFor(t);
  const similarFor = (k: Kind) => app.state.txns.filter((x) => x.merchantKey === t.merchantKey && x.id !== t.id &&
    (k === 'spend' || k === 'income' ? x.direction === t.direction : true));
  const account = app.state.accounts.find((a) => a.id === t.accountId);

  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  const close = () => backdrop.remove();
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

  const draw = () => {
    const cats = CATEGORIES[kind];
    const similar = similarFor(kind);
    if (!cats.includes(category)) { category = cats[0]; counted = categoryCounted(app.state.settings, kind, category); }
    backdrop.innerHTML = `<div class="sheet" role="dialog" aria-label="Edit transaction">
      <div class="grab"></div>
      <div class="row between">
        <h2 class="ellipsis" style="margin:0">${esc(t.merchantName)}</h2>
        <span class="num amt ${t.direction}" style="font-size:18px;font-weight:650">${t.direction === 'credit' ? '+' : '−'}${inrFull(t.amount)}</span>
      </div>
      <div class="small muted">${esc(dayLabel(t.date))} · ${esc(account ? accountLabel(account) : t.accountId)} · ${esc(detectMethod(t.description.toUpperCase()))}</div>
      <div class="desc-box">${esc(t.description)}</div>

      <label class="field"><span>Title</span><input type="text" id="title" value="${esc(title)}" maxlength="40" placeholder="${esc(t.merchantName)}"></label>
      <label class="field"><span>Date</span><input type="date" id="date" value="${esc(t.date)}" max="2100-12-31"></label>

      <label class="field"><span>Type</span></label>
      <div class="seg" style="margin:-6px 0 12px">
        ${(Object.keys(CATEGORIES) as Kind[]).filter((k) => k !== 'ignore').map((k) => `<button data-k="${k}" class="${k === kind ? 'on' : ''}">${esc(KIND_LABEL[k])}</button>`).join('')}
      </div>
      <label class="field"><span>Category</span>
        <select id="cat">${cats.map((c) => `<option ${c === category ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
      </label>
      <label class="row small" style="margin-bottom:12px;align-items:flex-start">
        <input type="checkbox" id="remember" checked style="margin-top:3px">
        <span>Always use this type, category and title for <strong>${esc(t.merchantName)}</strong>${similar.length ? ` and update ${similar.length} other transaction${similar.length > 1 ? 's' : ''}` : ''}</span>
      </label>
      <label class="row small" style="margin-bottom:12px"><input type="checkbox" id="counted" ${counted ? 'checked' : ''}><span>Counted in totals</span></label>
      <label class="field"><span>Note</span><input type="text" id="note" value="${esc(t.note ?? '')}" placeholder="Optional"></label>
      <div id="st-box"></div>
      <p class="tiny" style="margin-top:-4px">${esc(SOURCE_LABEL[t.source])}${st.parts ? ' · When split, the totals use the parts; the type above is for this payee\'s rule.' : ''}</p>
      <p class="small bad" id="e-err" hidden></p>
      <div class="row">
        <button class="btn grow" id="cancel">Cancel</button>
        <button class="btn primary grow" id="save">Save</button>
      </div>
      <div class="row" style="margin-top:10px"><button class="btn danger grow" id="del">Delete this transaction</button></div>
    </div>`;
    backdrop.querySelector<HTMLInputElement>('#title')!.addEventListener('input', (e) => {
      title = (e.target as HTMLInputElement).value;
    });
    backdrop.querySelectorAll<HTMLElement>('[data-k]').forEach((b) => b.addEventListener('click', () => {
      kind = b.dataset.k as Kind;
      draw();
    }));
    backdrop.querySelector<HTMLSelectElement>('#cat')!.addEventListener('change', (e) => {
      category = (e.target as HTMLSelectElement).value;
      counted = categoryCounted(app.state.settings, kind, category);
      backdrop.querySelector<HTMLInputElement>('#counted')!.checked = counted;
    });
    backdrop.querySelector<HTMLInputElement>('#counted')!.addEventListener('change', (e) => {
      counted = (e.target as HTMLInputElement).checked;
    });
    mountSplitTags(backdrop.querySelector<HTMLElement>('#st-box')!, st, () => t.amount, () => ({ kind, category }));
    backdrop.querySelector('#cancel')!.addEventListener('click', close);
    backdrop.querySelector('#del')!.addEventListener('click', async () => {
      if (!(await askConfirm(`Delete ${t.merchantName} (${inrFull(t.amount)}, ${dayLabel(t.date)})? It leaves every total, and uploading or rescanning the statement won't bring it back.`, 'Delete'))) return;
      close();
      await update((s) => ({
        ...s,
        // a self transfer it was paired with is no longer paired
        txns: s.txns.filter((x) => x.id !== t.id).map((x) => (x.pairId === t.id ? { ...x, pairId: undefined } : x)),
        settings: { ...s.settings, deletedTxns: [...new Set([...(s.settings.deletedTxns ?? []), t.id])] },
      }));
      toast('Deleted');
    });
    backdrop.querySelector('#save')!.addEventListener('click', async () => {
      const extra = readSplitTags(st, t.amount);
      if (extra.error) {
        const err = backdrop.querySelector<HTMLElement>('#e-err')!;
        err.textContent = extra.error; err.hidden = false; return;
      }
      const remember = backdrop.querySelector<HTMLInputElement>('#remember')!.checked;
      const note = backdrop.querySelector<HTMLInputElement>('#note')!.value.trim() || undefined;
      const excluded = !backdrop.querySelector<HTMLInputElement>('#counted')!.checked;
      const newTitle = title.trim().slice(0, 40) || t.merchantName;
      const newDate = backdrop.querySelector<HTMLInputElement>('#date')!.value;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(newDate)) {
        const err = backdrop.querySelector<HTMLElement>('#e-err')!;
        err.textContent = 'Choose a date'; err.hidden = false; return;
      }
      const renamed = newTitle !== t.merchantName;
      close();
      await update((s) => {
        const direction = kind === 'spend' || kind === 'income' ? t.direction : undefined;
        const sameRule = (r: { key: string; direction?: string }) => r.key === t.merchantKey && (!direction || !r.direction || r.direction === direction);
        const oldRule = s.rules.find(sameRule);
        const ruleTitle = renamed ? newTitle : oldRule?.title;
        const rules = remember
          ? [...s.rules.filter((r) => !sameRule(r)), { key: t.merchantKey, name: t.merchantName, kind, category, direction, createdAt: Date.now(), ...(ruleTitle ? { title: ruleTitle } : {}) }]
          : s.rules;
        const titled = renamed ? { merchantName: newTitle, titleSet: 'manual' as const } : {};
        const txns = s.txns.map((x) => {
          if (x.id === t.id) return { ...x, ...titled, kind, category, source: 'manual' as const, note, excluded, tags: extra.tags, splits: extra.splits, date: newDate };
          if (remember && x.merchantKey === t.merchantKey && (!direction || x.direction === direction)) {
            // Types you set by hand on other rows stay; the new title applies to all of them.
            return x.source === 'manual' ? { ...x, ...titled } : { ...x, ...titled, kind, category, source: 'learned' as const };
          }
          return x;
        });
        return { ...s, rules, txns: newDate !== t.date ? [...txns].sort((a, b) => b.date.localeCompare(a.date)) : txns };
      });
      // the site's Money Brain keeps it too (Setup → What it has learned)
      try {
        const mb = (globalThis as unknown as { MoneyBrain?: { learn: (a: string, t: string, k: string, v: string, o?: object) => void } }).MoneyBrain;
        if (remember && mb) mb.learn('money', 'category', t.merchantName, `${kind}/${category}`, { weight: 3, label: `${t.merchantName} → ${category}`, why: 'You filed it by hand' });
      } catch { /* the brain is optional */ }
      const n = similarFor(kind).length;
      toast(remember && n ? `Updated ${n + 1} transactions` : 'Saved');
    });
  };
  draw();
  document.body.append(backdrop);
}
