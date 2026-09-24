import { describe, expect, it } from 'vitest';
import { checkLogin, withCredentials } from '../src/auth';
import { emptyState } from '../src/store';

describe('sign-in', () => {
  it('accepts admin / admin until changed', async () => {
    const s = emptyState();
    expect(await checkLogin(s, 'admin', 'admin')).toBe(true);
    expect(await checkLogin(s, ' Admin ', 'admin')).toBe(true);
    expect(await checkLogin(s, 'admin', 'wrong')).toBe(false);
  });

  it('uses the new login after a change and stores no plain password', async () => {
    const s = await withCredentials(emptyState(), 'anil', 's3cret!');
    expect(JSON.stringify(s.auth)).not.toContain('s3cret!');
    expect(await checkLogin(s, 'anil', 's3cret!')).toBe(true);
    expect(await checkLogin(s, 'admin', 'admin')).toBe(false);
  });
});
