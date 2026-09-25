import { esc, inr } from './format';

export interface MonthPoint { month: string; actual: number; expected: number; planSet: boolean }

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const shortMonth = (ym: string) => MONTH_SHORT[Number(ym.slice(5, 7)) - 1] + (ym.endsWith('-01') ? ` ${ym.slice(2, 4)}` : '');

function niceMax(v: number): number {
  if (v <= 0) return 1000;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

function compact(n: number): string {
  if (n >= 1e7) return `${+(n / 1e7).toFixed(1)}Cr`;
  if (n >= 1e5) return `${+(n / 1e5).toFixed(1)}L`;
  if (n >= 1e3) return `${+(n / 1e3).toFixed(0)}k`;
  return String(Math.round(n));
}

/**
 * Monthly bars (actual) with a tick for the expected amount. Tapping a month
 * selects it. One chart per measure: spend and investment have different scales.
 */
export function monthlyChart(points: MonthPoint[], selected: string, color: string, label: string): string {
  const W = 340, H = 170, left = 34, right = 6, top = 18, bottom = 22;
  const plotW = W - left - right, plotH = H - top - bottom;
  const max = niceMax(Math.max(...points.map((p) => Math.max(p.actual, p.planSet ? p.expected : 0)), 1));
  const y = (v: number) => top + plotH - (v / max) * plotH;
  const slot = plotW / Math.max(points.length, 1);
  const barW = Math.min(28, slot * 0.56);
  const ticks = [0, max / 2, max];

  const grid = ticks.map((t) => `
    <line x1="${left}" x2="${W - right}" y1="${y(t)}" y2="${y(t)}" class="grid"/>
    <text x="${left - 5}" y="${y(t) + 3.5}" text-anchor="end" class="axis">${compact(t)}</text>`).join('');

  const bars = points.map((p, i) => {
    const cx = left + slot * i + slot / 2;
    const h = Math.max((p.actual / max) * plotH, p.actual > 0 ? 2 : 0);
    const r = Math.min(4, barW / 2, h);
    const x0 = cx - barW / 2, yTop = top + plotH - h, yBase = top + plotH;
    // Rounded at the data end only, square on the baseline.
    const bar = h > 0 ? `<path d="M${x0},${yBase} V${yTop + r} Q${x0},${yTop} ${x0 + r},${yTop} H${x0 + barW - r} Q${x0 + barW},${yTop} ${x0 + barW},${yTop + r} V${yBase} Z" fill="${color}" opacity="${p.month === selected ? 1 : 0.45}"/>` : '';
    const tick = p.planSet && p.expected > 0
      ? `<line x1="${cx - barW / 2 - 4}" x2="${cx + barW / 2 + 4}" y1="${y(p.expected)}" y2="${y(p.expected)}" class="target"/>` : '';
    const value = p.month === selected && p.actual > 0
      ? `<text x="${cx}" y="${Math.min(yTop, p.planSet ? y(p.expected) : yTop) - 5}" text-anchor="middle" class="val">${compact(p.actual)}</text>` : '';
    const tip = `${shortMonth(p.month)}: ${inr(p.actual)}${p.planSet ? ` of ${inr(p.expected)} expected` : ''}`;
    return `<g class="bar-hit" data-month="${p.month}" role="button" tabindex="0" aria-label="${esc(tip)}">
      <title>${esc(tip)}</title>
      <rect x="${cx - slot / 2}" y="${top}" width="${slot}" height="${plotH + bottom}" fill="transparent"/>
      ${bar}${tick}${value}
      <text x="${cx}" y="${H - 6}" text-anchor="middle" class="axis${p.month === selected ? ' sel' : ''}">${shortMonth(p.month)}</text>
    </g>`;
  }).join('');

  return `<div class="chart">
    <div class="legend small"><span><i class="sw" style="background:${color}"></i>${esc(label)}</span><span><i class="sw line"></i>Expected</span></div>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)} by month">${grid}${bars}</svg>
  </div>`;
}

/** Categorical slots in fixed order (validated palette); the 8th slice is always "Other". */
export const SLICE_COLORS = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)', 'var(--c7)'];
export const OTHER_COLOR = 'var(--c-other)';

export interface Slice { label: string; value: number; color: string; count: number }

/** Top 7 categories keep their own colour; the rest fold into "Other". */
export function toSlices(items: { category: string; total: number; count: number }[]): Slice[] {
  const sorted = [...items].sort((a, b) => b.total - a.total).filter((i) => i.total > 0);
  const top = sorted.slice(0, 7);
  const rest = sorted.slice(top.length);
  const slices = top.map((i, k) => ({ label: i.category, value: i.total, count: i.count, color: SLICE_COLORS[k] ?? OTHER_COLOR }));
  if (rest.length === 1) {
    slices.push({ label: rest[0].category, value: rest[0].total, count: rest[0].count, color: OTHER_COLOR });
  } else if (rest.length) {
    slices.push({ label: `Other (${rest.length})`, value: rest.reduce((a, r) => a + r.total, 0), count: rest.reduce((a, r) => a + r.count, 0), color: OTHER_COLOR });
  }
  return slices;
}

/** Donut with a 2px surface gap between slices and the total in the middle. */
export function donutChart(slices: Slice[], centerLabel: string): string {
  const total = slices.reduce((a, s) => a + s.value, 0);
  if (!total) return '';
  const R = 80, r = 52, C = 100;
  let angle = -Math.PI / 2;
  const point = (rad: number, a: number) => `${C + rad * Math.cos(a)},${C + rad * Math.sin(a)}`;
  const arcs = slices.map((s, i) => {
    const sweep = (s.value / total) * Math.PI * 2;
    const a0 = angle, a1 = angle + sweep;
    angle = a1;
    const large = sweep > Math.PI ? 1 : 0;
    const pct = Math.round((s.value / total) * 100);
    const d = slices.length === 1
      ? `M${C},${C - R} A${R},${R} 0 1 1 ${C - 0.01},${C - R} L${C - 0.01},${C - r} A${r},${r} 0 1 0 ${C},${C - r} Z`
      : `M${point(R, a0)} A${R},${R} 0 ${large} 1 ${point(R, a1)} L${point(r, a1)} A${r},${r} 0 ${large} 0 ${point(r, a0)} Z`;
    return `<path d="${d}" fill="${s.color}" class="slice" data-slice="${i}"><title>${esc(s.label)}: ${inr(s.value)} (${pct}%)</title></path>`;
  }).join('');
  return `<svg viewBox="0 0 200 200" class="donut" role="img" aria-label="Share by category">
    ${arcs}
    <text x="${C}" y="${C - 4}" text-anchor="middle" class="donut-total">${compact(total)}</text>
    <text x="${C}" y="${C + 14}" text-anchor="middle" class="axis">${esc(centerLabel)}</text>
  </svg>`;
}

export interface TrendPoint { month: string; spend: number; invest: number }

/**
 * Spend and investment by month as two lines with dots. One rupee axis for
 * both. Tapping a month selects it; the selected month shows its values.
 */
export function trendChart(points: TrendPoint[], selected: string): string {
  const W = 340, H = 190, left = 34, right = 14, top = 22, bottom = 24;
  const plotW = W - left - right, plotH = H - top - bottom;
  const max = niceMax(Math.max(...points.flatMap((p) => [p.spend, p.invest]), 1));
  const y = (v: number) => top + plotH - (Math.max(v, 0) / max) * plotH;
  const step = points.length > 1 ? plotW / (points.length - 1) : 0;
  const x = (i: number) => (points.length > 1 ? left + step * i : left + plotW / 2);
  const ticks = [0, max / 2, max];
  const grid = ticks.map((t) => `
    <line x1="${left}" x2="${W - right}" y1="${y(t)}" y2="${y(t)}" class="grid"/>
    <text x="${left - 5}" y="${y(t) + 3.5}" text-anchor="end" class="axis">${compact(t)}</text>`).join('');
  const series = [
    { key: 'spend' as const, color: 'var(--k-spend)', name: 'Spent' },
    { key: 'invest' as const, color: 'var(--k-investment)', name: 'Invested' },
  ];
  const lines = series.map((s) => `
    <polyline fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"
      points="${points.map((p, i) => `${x(i)},${y(p[s.key])}`).join(' ')}"/>
    ${points.map((p, i) => `<circle cx="${x(i)}" cy="${y(p[s.key])}" r="${p.month === selected ? 5 : 4}" fill="${s.color}" stroke="var(--surface)" stroke-width="2"/>`).join('')}`).join('');

  const hits = points.map((p, i) => {
    const prev = points[i - 1];
    const change = (a: number, b: number) => (prev ? ` (${a >= b ? '▲' : '▼'} ${inr(Math.abs(a - b))})` : '');
    const tip = `${shortMonth(p.month)} — spent ${inr(p.spend)}${prev ? change(p.spend, prev.spend) : ''}, invested ${inr(p.invest)}${prev ? change(p.invest, prev.invest) : ''}`;
    const w = points.length > 1 ? step : plotW;
    const sel = p.month === selected;
    // Label the selected month's values, keeping the two labels from colliding.
    const ys = [y(p.spend), y(p.invest)];
    const [ls, li] = Math.abs(ys[0] - ys[1]) < 14 ? (ys[0] <= ys[1] ? [ys[0] - 9, ys[1] + 16] : [ys[0] + 16, ys[1] - 9]) : [ys[0] - 9, ys[1] - 9];
    const anchor = i === 0 && points.length > 1 ? 'start' : i === points.length - 1 && points.length > 1 ? 'end' : 'middle';
    return `<g class="bar-hit" data-month="${p.month}" role="button" tabindex="0" aria-label="${esc(tip)}">
      <title>${esc(tip)}</title>
      <rect x="${x(i) - w / 2}" y="${top - 12}" width="${w}" height="${plotH + bottom + 12}" fill="transparent"/>
      ${sel ? `<line x1="${x(i)}" x2="${x(i)}" y1="${top}" y2="${top + plotH}" class="crosshair"/>
        <text x="${x(i)}" y="${ls}" text-anchor="${anchor}" class="val">${compact(p.spend)}</text>
        <text x="${x(i)}" y="${li}" text-anchor="${anchor}" class="val">${compact(p.invest)}</text>` : ''}
      <text x="${x(i)}" y="${H - 6}" text-anchor="middle" class="axis${sel ? ' sel' : ''}">${shortMonth(p.month)}</text>
    </g>`;
  }).join('');

  return `<div class="chart">
    <div class="legend small">${series.map((s) => `<span><i class="sw" style="background:${s.color};border-radius:50%"></i>${s.name}</span>`).join('')}</div>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Spent and invested by month">${grid}${hits}${lines}</svg>
  </div>`;
}
