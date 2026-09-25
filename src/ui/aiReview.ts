import type { Txn } from '../types';
import { KIND_LABEL } from '../categorize/categories';
import type { AiSuggestion } from '../categorize/gemini';
import { app, navigate, toast, update } from './app';
import { esc, inrFull } from './format';

interface Change { txn: Txn; s: AiSuggestion; typeChanged: boolean; nameChanged: boolean }

/** Shows the AI's suggestions next to what the app has, and applies only the ticked ones. */
export function openAiReview(suggestions: AiSuggestion[]) {
  const byId = new Map(app.state.txns.map((t) => [t.id, t]));
  const changes: Change[] = suggestions.flatMap((s) => {
    const txn = byId.get(s.id);
    if (!txn) return [];
    const typeChanged = s.kind !== txn.kind || s.category !== txn.category;
    const nameChanged = s.payee.trim().toLowerCase() !== txn.merchantName.trim().toLowerCase();
    // Leave rows you set by hand alone unless the AI thinks the row is mixed up.
    if (txn.source === 'manual' && !s.mixed) return [];
    return typeChanged || nameChanged || s.mixed ? [{ txn, s, typeChanged, nameChanged }] : [];
  });
  const mixed = changes.filter((c) => c.s.mixed).length;
  const fixable = changes.filter((c) => c.typeChanged || c.nameChanged).length;

  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  backdrop.innerHTML = `<div class="sheet" role="dialog" aria-label="AI suggestions">
    <div class="grab"></div>
    <h2>AI suggestions</h2>
    <p class="small muted" style="margin-top:-4px">${changes.length
      ? `${fixable} change${fixable === 1 ? '' : 's'} suggested${mixed ? `, ${mixed} row${mixed > 1 ? 's' : ''} flagged as possibly mixed up (check those against the PDF)` : ''}.${fixable ? ' All are ticked: untick anything you don\'t want, then tap Apply.' : ''}`
      : 'The AI agrees with everything the app already has.'}</p>
    ${fixable > 1 ? '<div class="row" style="gap:8px;margin-bottom:8px"><button class="btn small-btn" data-all>Tick all</button><button class="btn small-btn" data-none>Untick all</button></div>' : ''}
    <div class="ai-list">
      ${changes.map((c, k) => `<label class="ai-item${c.s.mixed ? ' flagged' : ''}">
        ${c.typeChanged || c.nameChanged ? `<input type="checkbox" data-k="${k}" checked>` : '<span class="ai-flag" aria-hidden="true">⚠</span>'}
        <span class="grow">
          <span class="row between"><strong class="ellipsis">${esc(c.s.payee)}</strong><span class="num small">${c.txn.direction === 'credit' ? '+' : '−'}${inrFull(c.txn.amount)}</span></span>
          <span class="tiny">${esc(c.txn.date)} · was <em>${esc(c.txn.merchantName)}</em>, ${esc(KIND_LABEL[c.txn.kind])} / ${esc(c.txn.category)}</span>
          ${c.nameChanged ? `<span class="small">→ title: <strong>${esc(c.s.payee)}</strong></span>` : ''}
          ${c.typeChanged ? `<span class="small">→ ${esc(KIND_LABEL[c.s.kind])} / ${esc(c.s.category)}</span>` : ''}
          ${c.s.mixed ? `<span class="small bad">⚠ Looks mixed up${c.s.note ? `: ${esc(c.s.note)}` : ''}${c.typeChanged || c.nameChanged ? '' : '. Nothing to apply here: tap Rescan on the statement, or fix it by hand in Transactions.'}</span>` : c.s.note ? `<span class="tiny">${esc(c.s.note)}</span>` : ''}
        </span>
      </label>`).join('')}
    </div>
    <div class="row" style="margin-top:12px">
      <button class="btn grow" data-close>${changes.length ? 'Cancel' : 'Close'}</button>
      ${fixable ? `<button class="btn primary grow" data-apply>Apply ${fixable} change${fixable > 1 ? 's' : ''}</button>` : ''}
    </div>
  </div>`;
  const close = () => backdrop.remove();
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  backdrop.querySelector('[data-close]')!.addEventListener('click', close);
  const boxes = () => [...backdrop.querySelectorAll<HTMLInputElement>('input[data-k]')];
  const applyBtn = backdrop.querySelector<HTMLButtonElement>('[data-apply]');
  // Keep the button honest about how many changes a tap will apply.
  const refresh = () => {
    if (!applyBtn) return;
    const n = boxes().filter((b) => b.checked).length;
    applyBtn.textContent = n ? `Apply ${n} change${n > 1 ? 's' : ''}` : 'Nothing ticked';
    applyBtn.disabled = n === 0;
  };
  boxes().forEach((b) => b.addEventListener('change', refresh));
  backdrop.querySelector('[data-all]')?.addEventListener('click', () => { boxes().forEach((b) => { b.checked = true; }); refresh(); });
  backdrop.querySelector('[data-none]')?.addEventListener('click', () => { boxes().forEach((b) => { b.checked = false; }); refresh(); });
  backdrop.querySelector('[data-apply]')?.addEventListener('click', async () => {
    const picked = new Map<string, AiSuggestion>();
    backdrop.querySelectorAll<HTMLInputElement>('input[data-k]').forEach((box) => {
      if (box.checked) { const c = changes[Number(box.dataset.k)]; picked.set(c.txn.id, c.s); }
    });
    close();
    if (!picked.size) return;
    await update((st) => ({
      ...st,
      txns: st.txns.map((t) => {
        const s = picked.get(t.id);
        return s ? { ...t, kind: s.kind, category: s.category, merchantName: s.payee, titleSet: 'ai' as const, source: 'ai' as const } : t;
      }),
    }));
    toast(`Applied ${picked.size} suggestion${picked.size > 1 ? 's' : ''}`, { label: 'View', run: () => navigate('#txns') });
  });
  document.body.append(backdrop);
}
