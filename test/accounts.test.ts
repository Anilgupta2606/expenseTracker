import { describe, expect, it } from 'vitest';
import { accountFor } from '../src/importer';
import { emptyState } from '../src/store';
import type { Account, ParseResult } from '../src/types';

const result = (bank: string, accountNumber?: string): ParseResult => ({ meta: { bank, accountNumber }, txns: [], balanceMismatches: 0, warnings: [] });
const withAccounts = (accounts: Account[]) => ({ ...emptyState(), accounts });

describe('account labels', () => {
  it('a new reading corrects a wrongly named bank for the same account', () => {
    const s = withAccounts([{ id: 'HDFC-4441', bank: 'HDFC', number: '055801624441' }]);
    expect(accountFor(result('ICICI', '055801624441'), s, 'x.pdf')).toEqual({ account: { id: 'HDFC-4441', bank: 'ICICI', number: '055801624441' }, isNew: false });
  });
  it('never changes a bank you set yourself', () => {
    const s = withAccounts([{ id: 'HDFC-4441', bank: 'ICICI', bankSet: 'manual', number: '055801624441' }]);
    expect(accountFor(result('HDFC', '055801624441'), s, 'x.pdf').account.bank).toBe('ICICI');
  });
  it('matches on the last four digits when that is all the statement shows', () => {
    const s = withAccounts([{ id: 'HDFC-4441', bank: 'HDFC', number: 'XXXXXXXX4441' }]);
    expect(accountFor(result('ICICI', 'XXXX4441'), s, 'x.pdf')).toMatchObject({ account: { id: 'HDFC-4441', bank: 'ICICI' }, isNew: false });
  });
});
