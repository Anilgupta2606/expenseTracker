import type { Kind, Txn } from '../types';
import { CATEGORIES, KIND_LABEL } from '../categorize/categories';
import { detectMethod } from '../categorize/engine';
import { app, toast, update } from './app';
import { dayLabel, esc, inrFull } from './format';

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
    if (!cats.includes(category)) category = cats[0];
    backdrop.innerHTML = `<div class="sheet" role="dialog" aria-label="Edit transaction">
      <div class="grab"></div>
      <div class="row between">
        <h2 class="ellipsis" style="margin:0">${esc(t.merchantName)}</h2>
        <span class="num amt ${t.direction}" style="font-size:18px;font-weight:650">${t.direction === 'credit' ? '+' : '−'}${inrFull(t.amount)}</span>
      </div>
      <div class="small muted">${esc(dayLabel(t.date))} · ${esc(account ? `${account.bank} ••${account.number.slice(-4)}` : t.accountId)} · ${esc(detectMethod(t.description.toUpperCase()))}</div>
      <div class="desc-box">${esc(t.description)}</div>

      <label class="field"><span>Type</span></label>
      <div class="seg" style="margin:-6px 0 12px">
        ${(Object.keys(CATEGORIES) as Kind[]).filter((k) => k !== 'ignore').map((k) => `<button data-k="${k}" class="${k === kind ? 'on' : ''}">${esc(KIND_LABEL[k])}</button>`).join('')}
      </div>
      <label class="field"><span>Category</span>
        <select id="cat">${cats.map((c) => `<option ${c === category ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
      </label>
      <label class="row small" style="margin-bottom:12px;align-items:flex-start">
        <input type="checkbox" id="remember" checked style="margin-top:3px">
        <span>Always use this for <strong>${esc(t.merchantName)}</strong>${similar.length ? ` and update ${similar.length} other transaction${similar.length > 1 ? 's' : ''}` : ''}</span>
      </label>
      <label class="row small" style="margin-bottom:12px"><input type="checkbox" id="counted" ${t.excluded ? '' : 'checked'}><span>Counted in totals</span></label>
      <label class="field"><span>Note</span><input type="text" id="note" value="${esc(t.note ?? '')}" placeholder="Optional"></label>
      <p class="tiny" style="margin-top:-4px">${esc(SOURCE_LABEL[t.source])}</p>
      <div class="row">
        <button class="btn grow" id="cancel">Cancel</button>
        <button class="btn primary grow" id="save">Save</button>
      </div>
    </div>`;
    backdrop.querySelectorAll<HTMLElement>('[data-k]').forEach((b) => b.addEventListener('click', () => {
      kind = b.dataset.k as Kind;
      draw();
    }));
    backdrop.querySelector<HTMLSelectElement>('#cat')!.addEventListener('change', (e) => {
      category = (e.target as HTMLSelectElement).value;
    });
    backdrop.querySelector('#cancel')!.addEventListener('click', close);
    backdrop.querySelector('#save')!.addEventListener('click', async () => {
      const remember = backdrop.querySelector<HTMLInputElement>('#remember')!.checked;
      const note = backdrop.querySelector<HTMLInputElement>('#note')!.value.trim() || undefined;
      const excluded = !backdrop.querySelector<HTMLInputElement>('#counted')!.checked;
      close();
      await update((s) => {
        const direction = kind === 'spend' || kind === 'income' ? t.direction : undefined;
        const sameRule = (r: { key: string; direction?: string }) => r.key === t.merchantKey && (!direction || !r.direction || r.direction === direction);
        const rules = remember
          ? [...s.rules.filter((r) => !sameRule(r)), { key: t.merchantKey, kind, category, direction, createdAt: Date.now() }]
          : s.rules;
        const txns = s.txns.map((x) => {
          if (x.id === t.id) return { ...x, kind, category, source: 'manual' as const, note, excluded };
          if (remember && x.merchantKey === t.merchantKey && (!direction || x.direction === direction) && x.source !== 'manual') {
            return { ...x, kind, category, source: 'learned' as const };
          }
          return x;
        });
        return { ...s, rules, txns };
      });
      const n = similarFor(kind).length;
      toast(remember && n ? `Updated ${n + 1} transactions` : 'Saved');
    });
  };
  draw();
  document.body.append(backdrop);
}
