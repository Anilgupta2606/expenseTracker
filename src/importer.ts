import type { Account, AppState, ParseResult, StatementImport, Txn } from './types';
import { categorize, extractMerchant, pairTransfers, type Context } from './categorize/engine';
import { hash } from './parse/util';

export interface ImportPreview {
  result: ParseResult;
  account: Account;
  isNewAccount: boolean;
  fresh: Txn[];
  duplicates: number;
  /** Earlier transactions that got paired with this statement. */
  updated: Txn[];
  record: StatementImport;
}

export async function parseFile(file: File, password?: string): Promise<ParseResult> {
  const data = await file.arrayBuffer();
  if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') {
    const [{ readPdfPages }, { parseLayout }] = await Promise.all([import('./parse/pdf'), import('./parse/layout')]);
    return parseLayout(await readPdfPages(data, password));
  }
  const { readSheet } = await import('./parse/sheet');
  return readSheet(data);
}

export function accountFor(result: ParseResult, state: AppState, fileName: string): { account: Account; isNew: boolean } {
  const { bank, accountNumber, holderName } = result.meta;
  const digits = (accountNumber ?? '').replace(/\D/g, '');
  const last4 = digits.slice(-4) || hash(fileName).slice(0, 4);
  const id = `${bank}-${last4}`;
  const existing = state.accounts.find((a) => a.id === id);
  if (existing) return { account: existing, isNew: false };
  return { account: { id, bank, number: accountNumber ?? last4, holderName }, isNew: true };
}

export function txnId(accountId: string, t: { date: string; amount: number; direction: string; balance?: number; description: string }, seq: number): string {
  // Include the running balance: two identical payments on the same day still differ there.
  return hash([accountId, t.date, t.amount, t.direction, t.balance ?? `#${seq}`, t.description].join('|'));
}

export function contextFor(state: AppState, extraAccount?: Account): Context {
  const accounts = extraAccount && !state.accounts.some((a) => a.id === extraAccount.id)
    ? [...state.accounts, extraAccount]
    : state.accounts;
  return { settings: state.settings, accounts, rules: state.rules };
}

export function buildPreview(result: ParseResult, state: AppState, fileName: string): ImportPreview {
  const { account, isNew } = accountFor(result, state, fileName);
  const ctx = contextFor(state, account);
  const existing = new Set(state.txns.map((t) => t.id));
  const now = Date.now();
  const importId = `${account.id}-${now}-${hash(fileName)}`;
  const fresh: Txn[] = [];
  let duplicates = 0;
  result.txns.forEach((p, i) => {
    const id = txnId(account.id, p, i);
    if (existing.has(id)) { duplicates++; return; }
    existing.add(id);
    const merchant = extractMerchant(p.description);
    const c = categorize(p, merchant, ctx, account.id);
    fresh.push({
      ...p, id, accountId: account.id,
      kind: c.kind, category: c.category, source: c.source,
      merchantKey: merchant.key, merchantName: merchant.name,
      importedAt: now,
      importId,
    });
  });
  // Pair within this statement and against earlier imports (on copies, until committed).
  const earlier = state.txns.map((t) => ({ ...t }));
  pairTransfers([...earlier, ...fresh]);
  const updated = earlier.filter((t, i) => t.pairId !== state.txns[i].pairId);
  const dates = fresh.map((t) => t.date).sort();
  const record: StatementImport = { id: importId, fileName, accountId: account.id, from: dates[0] ?? '', to: dates[dates.length - 1] ?? '', importedAt: now };
  return { result, account, isNewAccount: isNew, fresh, duplicates, updated, record };
}

export function commitPreview(state: AppState, preview: ImportPreview): AppState {
  const accounts = preview.isNewAccount ? [...state.accounts, preview.account] : state.accounts;
  const changed = new Map(preview.updated.map((t) => [t.id, t]));
  const txns = [...state.txns.map((t) => changed.get(t.id) ?? t), ...preview.fresh].sort((a, b) => b.date.localeCompare(a.date));
  const imports = preview.fresh.length ? [...state.imports, preview.record] : state.imports;
  return { ...state, accounts, txns, imports };
}

/** Removes an uploaded statement and every transaction that came from it. */
export function deleteImport(state: AppState, importId: string): AppState {
  const imports = state.imports.filter((i) => i.id !== importId);
  const txns = state.txns.filter((t) => t.importId !== importId);
  // Drop accounts that no longer have any statements.
  const accounts = state.accounts.filter((a) => txns.some((t) => t.accountId === a.id));
  return recategorizeAll({ ...state, imports, txns, accounts });
}

/** Re-runs categorisation for everything the user hasn't set by hand. */
export function recategorizeAll(state: AppState): AppState {
  const ctx = contextFor(state);
  const txns = state.txns.map((t) => {
    if (t.source === 'manual') return t;
    const merchant = extractMerchant(t.description);
    const c = categorize(t, merchant, ctx, t.accountId);
    return { ...t, kind: c.kind, category: c.category, source: c.source, pairId: undefined, merchantKey: merchant.key, merchantName: merchant.name };
  });
  pairTransfers(txns);
  return { ...state, txns };
}
