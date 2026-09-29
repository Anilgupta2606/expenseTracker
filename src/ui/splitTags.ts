import type { Kind, SplitPart } from '../types';
import { CATEGORIES, KIND_LABEL } from '../categorize/categories';
import { allTags, parseTags, splitLeft, splitProblem } from '../splits';
import { app } from './app';
import { esc, inrFull } from './format';

/** Types a part can count as (the same choices as "Counts as"). */
const PART_KINDS: Kind[] = ['spend', 'investment', 'income', 'transfer', 'cc_bill'];

/** What the Tags field and the split hold while a sheet is open. */
export interface SplitTags {
  tags: string[];
  parts: SplitPart[] | null;
  /** The first part takes whatever the others leave, until you type into it yourself. */
  autoFirst: boolean;
}

export function splitTagsFor(t?: { tags?: string[]; splits?: SplitPart[] }): SplitTags {
  return { tags: [...(t?.tags ?? [])], parts: t?.splits?.length ? t.splits.map((p) => ({ ...p })) : null, autoFirst: false };
}

const leftText = (left: number) => Math.abs(left) < 0.005 ? '✓ The parts add up to the total.'
  : left > 0 ? `${inrFull(left)} still to assign.` : `${inrFull(-left)} more than the total.`;

/**
 * Tags and "Split this amount" for a transaction sheet, drawn into `box`. `total` reads the
 * payment's amount (the manual sheet's can change while it is open); `start` is the type and
 * category the first part begins with.
 */
export function mountSplitTags(box: HTMLElement, st: SplitTags, total: () => number, start: () => { kind: Kind; category: string }) {
  const fillFirst = () => {
    if (!st.parts || !st.autoFirst) return;
    const rest = st.parts.slice(1).reduce((a, p) => a + Math.round((p.amount || 0) * 100), 0);
    st.parts[0].amount = Math.max(0, Math.round(total() * 100) - rest) / 100;
  };
  const showLeft = () => {
    const el = box.querySelector<HTMLElement>('#st-left');
    if (!el || !st.parts) return;
    const left = splitLeft(total(), st.parts);
    el.textContent = leftText(left);
    el.className = `split-left ${Math.abs(left) < 0.005 ? 'ok' : 'bad'}`;
    const first = box.querySelector<HTMLInputElement>('[data-amt="0"]');
    if (first && st.autoFirst && document.activeElement !== first) first.value = st.parts[0].amount ? String(st.parts[0].amount) : '';
  };
  const draw = () => {
    fillFirst();
    const used = allTags(app.state.txns).map((g) => g.tag).filter((g) => !st.tags.includes(g)).slice(0, 8);
    const parts = st.parts;
    box.innerHTML = `
      <label class="field"><span>Tags</span><input type="text" id="st-tags" value="${esc(st.tags.join(', '))}" placeholder="e.g. goa trip, office - commas between tags" autocomplete="off"></label>
      ${used.length ? `<div class="tag-suggest">${used.map((g) => `<button type="button" class="chip" data-add-tag="${esc(g)}">+ #${esc(g)}</button>`).join('')}</div>` : ''}
      ${parts ? `<label class="field" style="margin-bottom:0"><span>Split into parts</span></label>
        <div class="split-rows">${parts.map((p, i) => `<div class="split-row">
          <div class="money"><span>₹</span><input type="text" inputmode="decimal" data-amt="${i}" value="${p.amount ? String(p.amount) : ''}" placeholder="0" aria-label="Part ${i + 1} amount" autocomplete="off"></div>
          <select data-pkind="${i}" aria-label="Part ${i + 1} type">${PART_KINDS.map((k) => `<option value="${k}" ${k === p.kind ? 'selected' : ''}>${esc(KIND_LABEL[k])}</option>`).join('')}</select>
          <select data-pcat="${i}" aria-label="Part ${i + 1} category">${CATEGORIES[p.kind].map((c) => `<option ${c === p.category ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
          <button type="button" class="btn rm" data-rm="${i}" aria-label="Remove part ${i + 1}" ${parts.length <= 2 ? 'disabled' : ''}>✕</button>
          <input type="text" class="split-note" data-pnote="${i}" value="${esc(p.note ?? '')}" placeholder="Note for this part (optional)" maxlength="60">
        </div>`).join('')}</div>
        <p class="split-left" id="st-left"></p>
        <div class="row wrap" style="gap:8px;margin-bottom:12px">
          <button type="button" class="btn" data-add-part>+ Add part</button>
          <button type="button" class="btn" data-unsplit>Don't split</button>
        </div>`
      : '<button type="button" class="btn" data-split style="margin-bottom:12px">Split this amount…</button>'}`;
    showLeft();

    box.querySelector<HTMLInputElement>('#st-tags')!.addEventListener('input', (e) => { st.tags = parseTags((e.target as HTMLInputElement).value); });
    box.querySelectorAll<HTMLElement>('[data-add-tag]').forEach((b) => b.addEventListener('click', () => {
      st.tags = [...new Set([...parseTags(box.querySelector<HTMLInputElement>('#st-tags')!.value), b.dataset.addTag!])];
      draw();
    }));
    box.querySelector('[data-split]')?.addEventListener('click', () => {
      const s = start();
      const next = CATEGORIES[s.kind].find((c) => c !== s.category) ?? s.category;
      st.parts = [{ amount: total(), kind: s.kind, category: s.category }, { amount: 0, kind: s.kind, category: next }];
      st.autoFirst = true;
      draw();
      box.querySelector<HTMLInputElement>('[data-amt="1"]')?.focus();
    });
    if (!parts) return;
    box.querySelector('[data-unsplit]')!.addEventListener('click', () => { st.parts = null; draw(); });
    box.querySelector('[data-add-part]')!.addEventListener('click', () => {
      const last = parts[parts.length - 1];
      parts.push({ amount: 0, kind: last.kind, category: last.category });
      draw();
      box.querySelector<HTMLInputElement>(`[data-amt="${parts.length - 1}"]`)?.focus();
    });
    box.querySelectorAll<HTMLElement>('[data-rm]').forEach((b) => b.addEventListener('click', () => {
      parts.splice(Number(b.dataset.rm), 1);
      draw();
    }));
    box.querySelectorAll<HTMLInputElement>('[data-amt]').forEach((inp) => inp.addEventListener('input', () => {
      const i = Number(inp.dataset.amt);
      parts[i].amount = Math.round((parseFloat(inp.value.replace(/[^\d.]/g, '')) || 0) * 100) / 100;
      if (i === 0) st.autoFirst = false;
      fillFirst();
      showLeft();
    }));
    box.querySelectorAll<HTMLSelectElement>('[data-pkind]').forEach((sel) => sel.addEventListener('change', () => {
      const p = parts[Number(sel.dataset.pkind)];
      p.kind = sel.value as Kind;
      if (!CATEGORIES[p.kind].includes(p.category)) p.category = CATEGORIES[p.kind][0];
      draw();
    }));
    box.querySelectorAll<HTMLSelectElement>('[data-pcat]').forEach((sel) => sel.addEventListener('change', () => { parts[Number(sel.dataset.pcat)].category = sel.value; }));
    box.querySelectorAll<HTMLInputElement>('[data-pnote]').forEach((inp) => inp.addEventListener('input', () => {
      parts[Number(inp.dataset.pnote)].note = inp.value.trim() || undefined;
    }));
  };
  draw();
  // the manual sheet's amount can change under a split in progress
  return { refresh: () => { fillFirst(); showLeft(); } };
}

/** The tags and split to save, or why they cannot be saved. */
export function readSplitTags(st: SplitTags, total: number): { error?: string; tags?: string[]; splits?: SplitPart[] } {
  const tags = st.tags.length ? st.tags : undefined;
  if (!st.parts) return { tags };
  const error = splitProblem(total, st.parts);
  return error ? { error } : { tags, splits: st.parts.map((p) => ({ amount: p.amount, kind: p.kind, category: p.category, ...(p.note ? { note: p.note } : {}) })) };
}
