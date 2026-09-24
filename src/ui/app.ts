import type { AppState, Kind } from '../types';
import { emptyState, saveState } from '../store';

export interface Filters {
  month: string; // 'all' or YYYY-MM
  account: string; // 'all' or account id
  kind: Kind | 'all' | 'review';
  category: string; // '' = any
  search: string;
  groupBy: 'date' | 'category';
}

export const app = {
  state: emptyState(),
  filters: { month: 'all', account: 'all', kind: 'all', category: '', search: '', groupBy: 'date' } as Filters,
};

let renderFn: () => void = () => {};
export function onRender(fn: () => void) { renderFn = fn; }
export function render() { renderFn(); }

export async function update(fn: (s: AppState) => AppState): Promise<void> {
  app.state = fn(app.state);
  render();
  try {
    await saveState(app.state);
  } catch (e) {
    toast(`Could not save: ${(e as Error).message}`);
  }
}

export function navigate(route: string) {
  if (location.hash === route) render();
  else location.hash = route;
}

let toastTimer: number | undefined;
export function toast(message: string) {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  document.body.append(el);
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.remove(), 3500);
}

/** In-page confirmation; native confirm() is blocked in some embedded viewers. */
export function askConfirm(message: string, confirmLabel: string, danger = true): Promise<boolean> {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'sheet-backdrop';
    backdrop.innerHTML = `<div class="sheet" role="alertdialog" aria-modal="true">
      <div class="grab"></div>
      <p style="font-size:16px;margin:4px 0 16px"></p>
      <div class="row"><button class="btn grow" data-no>Cancel</button>
      <button class="btn grow ${danger ? 'danger' : 'primary'}" data-yes></button></div></div>`;
    backdrop.querySelector('p')!.textContent = message;
    backdrop.querySelector('[data-yes]')!.textContent = confirmLabel;
    const done = (v: boolean) => { backdrop.remove(); resolve(v); };
    backdrop.querySelector('[data-no]')!.addEventListener('click', () => done(false));
    backdrop.querySelector('[data-yes]')!.addEventListener('click', () => done(true));
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) done(false); });
    document.body.append(backdrop);
  });
}
