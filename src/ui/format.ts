import type { Kind, Txn } from '../types';
import type { Filters } from './app';

export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const inrFmt = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const inrExact = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const inr = (n: number) => inrFmt.format(Math.round(n));
export const inrFull = (n: number) => inrExact.format(n);

export function monthLabel(ym: string): string {
  if (ym === 'all') return 'All time';
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
}

export function monthShort(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'short', year: '2-digit' });
}

export function dayLabel(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

export function monthsOf(txns: Txn[]): string[] {
  return [...new Set(txns.map((t) => t.date.slice(0, 7)))].sort().reverse();
}

export function applyFilters(txns: Txn[], f: Filters, opts: { kind?: boolean } = { kind: true }): Txn[] {
  const q = f.search.trim().toLowerCase();
  return txns.filter((t) =>
    (f.month === 'all' || t.date.startsWith(f.month)) &&
    (f.account === 'all' || t.accountId === f.account) &&
    (!opts.kind || f.kind === 'all' || (f.kind === 'review' ? t.category === 'Uncategorised' : f.kind === 'excluded' ? Boolean(t.excluded) : t.kind === f.kind)) &&
    (!opts.kind || !f.category || t.category === f.category) &&
    (!q || t.description.toLowerCase().includes(q) || t.merchantName.toLowerCase().includes(q) || t.category.toLowerCase().includes(q) || String(t.amount).includes(q)),
  );
}

export const kindVar = (k: Kind) => `var(--k-${k})`;

export function initials(name: string): string {
  const parts = name.replace(/[^A-Za-z0-9 ]/g, ' ').trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase();
}
