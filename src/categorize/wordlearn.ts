import type { Direction, Kind, LearnedRule } from '../types';

/**
 * Learning that generalises: from the merchants you filed by hand, the words that mean something.
 * When two or more merchants sharing a word ("ANNAPURNA TIFFIN", "SAI TIFFIN CENTRE") were all filed the same way,
 * a new one with that word ("LAXMI TIFFIN HOUSE") is filed that way too. Derived from your learned rules each time,
 * so it syncs and forgets with them.
 */
const STOP = new Set(('PRIVATE LIMITED INDIA INDIAN PVT LTD LLP SERVICES SERVICE SOLUTIONS TECHNOLOGIES TECHNOLOGY ENTERPRISES ENTERPRISE '
  + 'TRADERS TRADING COMPANY CORPORATION GROUP HOLDINGS PAYMENT PAYMENTS BANK UPI NEFT IMPS RTGS TRANSFER ORDER ONLINE RETAIL '
  + 'MUMBAI DELHI NEW BANGALORE BENGALURU PUNE CHENNAI HYDERABAD KOLKATA NOIDA GURGAON GURUGRAM AHMEDABAD JAIPUR LUCKNOW THANE '
  + 'SHRI SREE SRI SAI SHREE JAI MAA BALAJI GANESH KRISHNA LAXMI LAKSHMI DURGA OM NEW THE AND FOR WITH FROM '
  + 'SHARMA GUPTA KUMAR SINGH VERMA JAIN AGARWAL AGGARWAL PATEL SHAH MEHTA REDDY RAO NAIR IYER KHAN YADAV MISHRA').split(' '));
const norm = (s: string) => s.toUpperCase().replace(/[^A-Z ]/g, ' ');
export const wordsOf = (name: string): string[] => [...new Set(norm(name).split(/\s+/).filter((w) => w.length >= 4 && !STOP.has(w)))];

interface WordLesson { kind: Kind; category: string; merchants: number; share: number }
let cache: { rules: LearnedRule[]; map: Map<string, WordLesson> } | null = null;

export function wordLessons(rules: LearnedRule[]): Map<string, WordLesson> {
  if (cache && cache.rules === rules) return cache.map;
  const votes = new Map<string, Map<string, number>>();
  for (const r of rules) {
    if (r.kind === 'transfer' || r.kind === 'cc_bill' || r.category === 'Payments to People' || r.category === 'Received from People') continue;
    for (const w of wordsOf(r.name ?? r.key)) {
      const v = votes.get(w) ?? new Map<string, number>();
      const k = `${r.kind}/${r.category}`;
      v.set(k, (v.get(k) ?? 0) + 1);
      votes.set(w, v);
    }
  }
  const map = new Map<string, WordLesson>();
  for (const [w, v] of votes) {
    const total = [...v.values()].reduce((s, x) => s + x, 0);
    const [top, n] = [...v.entries()].sort((a, b) => b[1] - a[1])[0];
    if (total >= 2 && n / total >= 0.8) {
      const [kind, category] = top.split('/') as [Kind, string];
      map.set(w, { kind, category, merchants: n, share: n / total });
    }
  }
  cache = { rules, map };
  return map;
}

/** A category for a merchant from the words you taught, or null. */
export function byWords(name: string, rules: LearnedRule[], direction: Direction): (WordLesson & { word: string }) | null {
  if (!rules.length) return null;
  const map = wordLessons(rules);
  const hits = wordsOf(name).map((w) => ({ w, l: map.get(w) })).filter((x) => x.l) as { w: string; l: WordLesson }[];
  if (!hits.length) return null;
  const best = hits.sort((a, b) => b.l.merchants - a.l.merchants)[0];
  if (best.l.kind === 'spend' && direction !== 'debit') return null;
  return { ...best.l, word: best.w };
}
