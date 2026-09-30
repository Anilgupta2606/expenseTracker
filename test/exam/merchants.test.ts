import { describe, expect, it } from 'vitest';
import { categorize, extractMerchant, type Context } from '../../src/categorize/engine';
import { emptyState } from '../../src/store';
import { CASES } from './merchants.exam';

const ctx: Context = { settings: { ...emptyState().settings, ownNames: ['RAVI KUMAR'] }, accounts: [], rules: [] };
const PASS_MARK = 0.95;

describe('the merchant exam', () => {
  it(`scores at least ${Math.round(PASS_MARK * 100)}%`, () => {
    const misses: string[] = [];
    for (const [text, dir, want] of CASES) {
      const r = categorize({ date: '2026-09-01', description: text, amount: 499, direction: dir }, extractMerchant(text), ctx);
      const got = `${r.kind}/${r.category}`;
      if (got !== want) misses.push(`  ✗ ${text}\n      got ${got}, should be ${want}`);
    }
    const score = (CASES.length - misses.length) / CASES.length;
    console.log(`MERCHANT EXAM: ${CASES.length - misses.length} / ${CASES.length} = ${Math.round(score * 100)}%\n${misses.join('\n')}`);
    expect(score).toBeGreaterThanOrEqual(PASS_MARK);
  });
});
