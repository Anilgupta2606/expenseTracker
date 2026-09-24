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
  return parseThorough(await file.arrayBuffer(), file.name, file.type, password);
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
  const record: StatementImport = {
    id: importId, fileName, accountId: account.id, from: dates[0] ?? '', to: dates[dates.length - 1] ?? '', importedAt: now,
    rows: result.txns.length, balanceMismatches: result.balanceMismatches,
  };
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

/** Fewer balance breaks wins; then more rows. */
function better(a: ParseResult, b: ParseResult): boolean {
  if (!b.txns.length) return true;
  if (!a.txns.length) return false;
  if (a.balanceMismatches !== b.balanceMismatches) return a.balanceMismatches < b.balanceMismatches;
  return a.txns.length > b.txns.length;
}

/**
 * Reads a statement again, trying several line-grouping settings, and keeps
 * the reading whose running balance holds best.
 */
export async function parseThorough(data: ArrayBuffer, fileName: string, type: string, password?: string): Promise<ParseResult> {
  if (/\.pdf$/i.test(fileName) || type === 'application/pdf') {
    const [{ readPdfItems }, { groupLines, parseLayout }] = await Promise.all([import('./parse/pdf'), import('./parse/layout')]);
    const items = await readPdfItems(data.slice(0), password);
    let best: ParseResult | null = null;
    for (const tolerance of [2, 1, 3, 4]) {
      const pages = items.map((p) => groupLines(p, tolerance));
      for (const preLine of [0.75, 0.6, 0.9]) {
        const r = parseLayout(pages, { preLine });
        if (!best || better(r, best)) best = r;
      }
    }
    return best!;
  }
  const { readSheet } = await import('./parse/sheet');
  return readSheet(data.slice(0));
}

export interface RescanResult {
  result: ParseResult;
  missing: Txn[];
  /** Rows already in the app that the new reading also found. */
  matched: number;
}

/** Rows a new reading of a statement found that the app doesn't have yet. */
export function diffRescan(state: AppState, importId: string, result: ParseResult): RescanResult {
  const rec = state.imports.find((i) => i.id === importId);
  if (!rec) return { result, missing: [], matched: 0 };
  const account = state.accounts.find((a) => a.id === rec.accountId) ?? { id: rec.accountId, bank: result.meta.bank, number: rec.accountId };
  const ctx = contextFor(state, account);
  const existing = new Set(state.txns.map((t) => t.id));
  const missing: Txn[] = [];
  let matched = 0;
  result.txns.forEach((p, i) => {
    const id = txnId(account.id, p, i);
    if (existing.has(id)) { matched++; return; }
    existing.add(id);
    const merchant = extractMerchant(p.description);
    const c = categorize(p, merchant, ctx, account.id);
    missing.push({
      ...p, id, accountId: account.id, importId: rec.id, importedAt: Date.now(),
      kind: c.kind, category: c.category, source: c.source,
      merchantKey: merchant.key, merchantName: merchant.name,
    });
  });
  return { result, missing, matched };
}

export function applyRescan(state: AppState, importId: string, rescan: RescanResult): AppState {
  const dates = [...state.txns.filter((t) => t.importId === importId), ...rescan.missing].map((t) => t.date).sort();
  const imports = state.imports.map((i) => (i.id === importId ? {
    ...i, rows: rescan.result.txns.length, balanceMismatches: rescan.result.balanceMismatches,
    from: dates[0] ?? i.from, to: dates[dates.length - 1] ?? i.to, rescannedAt: Date.now(),
  } : i));
  const txns = [...state.txns, ...rescan.missing].sort((a, b) => b.date.localeCompare(a.date));
  return recategorizeAll({ ...state, imports, txns });
}
