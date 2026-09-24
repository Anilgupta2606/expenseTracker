import { esc, inr } from './format';

export interface MonthPoint { month: string; actual: number; expected: number; planSet: boolean }

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortMonth = (ym: string) => MONTH_SHORT[Number(ym.slice(5, 7)) - 1] + (ym.endsWith('-01') ? ` ${ym.slice(2, 4)}` : '');

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
