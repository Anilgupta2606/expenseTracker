import { describe, expect, it } from 'vitest';
import { categorize, extractMerchant, type Context } from '../../src/categorize/engine';
import { emptyState } from '../../src/store';
import { FRESH } from './merchants.fresh';

const ctx: Context = { settings: { ...emptyState().settings, ownNames: ['RAVI KUMAR'] }, accounts: [], rules: [] };
describe('the fresh merchant set', () => {
  it('is measured (the score is printed; it guards against a fall below 80%)', () => {
    const misses: string[] = [];
    for (const [text, dir, want] of FRESH) {
      const r = categorize({ date: '2026-09-01', description: text, amount: 499, direction: dir }, extractMerchant(text), ctx);
      if (`${r.kind}/${r.category}` !== want) misses.push(`  ✗ ${text}\n      got ${r.kind}/${r.category}, should be ${want}`);
    }
    console.log(`FRESH MERCHANT SET: ${FRESH.length - misses.length} / ${FRESH.length} = ${Math.round((FRESH.length - misses.length) / FRESH.length * 100)}%\n${misses.join('\n')}`);
    expect((FRESH.length - misses.length) / FRESH.length).toBeGreaterThanOrEqual(0.8);
  });
});
