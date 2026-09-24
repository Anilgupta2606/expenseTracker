import type { AppState, Kind } from '../types';
import { emptyState, saveState } from '../store';

export interface Filters {
  month: string; // 'all' or YYYY-MM
  account: string; // 'all' or account id
  kind: Kind | 'all' | 'review';
  category: string; // '' = any
  search: string;
}

export const app = {
  state: emptyState(),
  filters: { month: 'all', account: 'all', kind: 'all', category: '', search: '' } as Filters,
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
