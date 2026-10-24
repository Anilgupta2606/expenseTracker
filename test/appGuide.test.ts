import { describe, expect, it } from 'vitest';
import { ABOUT_APP, appGuide } from '../src/appGuide';
import { sanitize, targets } from '../src/assistant';
import { emptyState } from '../src/store';

const el = (text: string, title = '') => ({ textContent: text, getAttribute: (k: string) => (k === 'title' ? title : null) });
const fakeDoc = {
  querySelectorAll: (q: string) => (q === '.tabbar a span' ? [el('Overview'), el('Transactions'), el('Upload'), el('Assistant')] : []),
  getElementById: () => ({
    querySelector: () => el('Upload'),
    querySelectorAll: () => [el('Choose statement'), el('Rescan', 'Read the statement again with several settings')],
  }),
} as unknown as Document;

describe('the Assistant knows the app itself', () => {
  it('tells an app question from a data question', () => {
    expect(ABOUT_APP.test('where is the backup button?')).toBe(true);
    expect(ABOUT_APP.test('how do I split a transaction')).toBe(true);
    expect(ABOUT_APP.test('how much did I spend on food in July?')).toBe(false);
    expect(ABOUT_APP.test('move all self transfers to not counted')).toBe(false);
  });

  it('the guide has the pages, the open page’s buttons and the README', () => {
    const g = appGuide(fakeDoc);
    expect(g).toContain('Pages: Overview, Transactions, Upload, Assistant');
    expect(g).toContain('Rescan (Read the statement again with several settings)');
    expect(g).toContain('Monthly plan');
    expect(g).not.toContain('## Development');
  });

  it('a help answer is just the reply: no rows, no change', () => {
    const p = sanitize({ intent: 'help', reply: 'Upload → Rescan.', filter: { categories: ['Food & Dining'] }, action: { type: 'set_counted', counted: false } }, 'where is rescan');
    expect(p).toEqual({ intent: 'help', reply: 'Upload → Rescan.', filter: {}, measure: 'total', remember: false });
    expect(targets(emptyState(), p)).toEqual([]);
  });
});
