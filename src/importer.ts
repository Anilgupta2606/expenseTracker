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
  const now = Date.now();
  const importId = `${account.id}-${now}-${hash(fileName)}`;
  // Rows already in the app (e.g. the same statement uploaded again) are skipped.
  const { ids, matches } = matchRows(state, account.id, result.txns);
  const fresh: Txn[] = [];
  let duplicates = 0;
  result.txns.forEach((p, i) => {
    if (matches[i]) { duplicates++; return; }
    const merchant = extractMerchant(p.description);
    const c = categorize(p, merchant, ctx, account.id);
    fresh.push({
      ...p, id: ids[i], accountId: account.id,
      kind: c.kind, category: c.category, source: c.source, excluded: c.excluded,
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
    if (t.source === 'manual' || t.source === 'ai') return t;
    const merchant = extractMerchant(t.description);
    const c = categorize(t, merchant, ctx, t.accountId);
    return { ...t, kind: c.kind, category: c.category, source: c.source, excluded: c.source === 'learned' ? c.excluded : t.excluded, pairId: undefined, merchantKey: merchant.key, merchantName: merchant.name };
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
  /** Rows already in the app whose description the new reading corrects. */
  corrected: { id: string; description: string }[];
  /** Rows already in the app that the new reading also found. */
  matched: number;
}

/**
 * Identifies a statement row without its description, so a better reading of
 * the same row (e.g. a fixed payee) is recognised as the same transaction.
 */
export function rowKey(accountId: string, t: { date: string; amount: number; direction: string; balance?: number }): string | null {
  return t.balance == null ? null : [accountId, t.date, t.amount, t.direction, t.balance].join('|');
}

/**
 * Gives every row of a reading an id, and pairs it one-to-one with a
 * transaction already in the app: first by id, then by date, amount and
 * balance with the same description, then by date, amount and balance alone
 * (the same row read with a different description). Rows that look alike, such
 * as a payment, its refund and a second payment on one day, each keep their own
 * match instead of all landing on one saved row.
 */
function matchRows(state: AppState, accountId: string, rows: ParseResult['txns']): { ids: string[]; matches: (Txn | undefined)[] } {
  const seen = new Map<string, number>();
  const ids = rows.map((p, i) => {
    const base = txnId(accountId, p, i);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    // The second identical row in one statement gets its own id.
    return n ? hash(`${base}#${n}`) : base;
  });
  const own = state.txns.filter((t) => t.accountId === accountId);
  const byId = new Map(own.map((t) => [t.id, t]));
  const used = new Set<string>();
  const matches: (Txn | undefined)[] = rows.map(() => undefined);
  const claim = (i: number, t: Txn | undefined) => { if (t && !used.has(t.id)) { used.add(t.id); matches[i] = t; } };
  rows.forEach((_, i) => claim(i, byId.get(ids[i])));
  const byKey = new Map<string, Txn[]>();
  for (const t of own) {
    const k = rowKey(accountId, t);
    if (k) byKey.set(k, [...(byKey.get(k) ?? []), t]);
  }
  const free = (i: number) => (byKey.get(rowKey(accountId, rows[i]) ?? '') ?? []).filter((t) => !used.has(t.id));
  rows.forEach((p, i) => { if (!matches[i]) claim(i, free(i).find((t) => t.description === p.description)); });
  rows.forEach((_, i) => { if (!matches[i]) claim(i, free(i)[0]); });
  return { ids, matches };
}

/** Rows a new reading of a statement found that the app doesn't have yet, and rows it reads differently. */
export function diffRescan(state: AppState, importId: string, result: ParseResult): RescanResult {
  const rec = state.imports.find((i) => i.id === importId);
  if (!rec) return { result, missing: [], corrected: [], matched: 0 };
  const account = state.accounts.find((a) => a.id === rec.accountId) ?? { id: rec.accountId, bank: result.meta.bank, number: rec.accountId };
  const ctx = contextFor(state, account);
  const { ids, matches } = matchRows(state, account.id, result.txns);
  const missing: Txn[] = [];
  const corrected: { id: string; description: string }[] = [];
  let matched = 0;
  result.txns.forEach((p, i) => {
    const same = matches[i];
    if (same) {
      matched++;
      if (same.description !== p.description) corrected.push({ id: same.id, description: p.description });
      return;
    }
    const merchant = extractMerchant(p.description);
    const c = categorize(p, merchant, ctx, account.id);
    missing.push({
      ...p, id: ids[i], accountId: account.id, importId: rec.id, importedAt: Date.now(),
      kind: c.kind, category: c.category, source: c.source, excluded: c.excluded,
      merchantKey: merchant.key, merchantName: merchant.name,
    });
  });
  return { result, missing, corrected, matched };
}

export function applyRescan(state: AppState, importId: string, rescan: RescanResult): AppState {
  const dates = [...state.txns.filter((t) => t.importId === importId), ...rescan.missing].map((t) => t.date).sort();
  const imports = state.imports.map((i) => (i.id === importId ? {
    ...i, rows: rescan.result.txns.length, balanceMismatches: rescan.result.balanceMismatches,
    from: dates[0] ?? i.from, to: dates[dates.length - 1] ?? i.to, rescannedAt: Date.now(),
  } : i));
  // Corrected descriptions get a fresh payee and category, unless you set the type yourself.
  const fixes = new Map(rescan.corrected.map((c) => [c.id, c.description]));
  const updated = state.txns.map((t) => {
    const description = fixes.get(t.id);
    if (description == null) return t;
    const merchant = extractMerchant(description);
    return { ...t, description, merchantKey: merchant.key, merchantName: merchant.name, source: t.source === 'ai' ? 'default' as const : t.source };
  });
  const txns = [...updated, ...rescan.missing].sort((a, b) => b.date.localeCompare(a.date));
  // An older reader could name the wrong bank; the new reading fixes the label.
  const rec = state.imports.find((i) => i.id === importId);
  const bank = rescan.result.meta.bank;
  const accounts = bank && bank !== 'Unknown'
    ? state.accounts.map((a) => (a.id === rec?.accountId ? { ...a, bank } : a))
    : state.accounts;
  return recategorizeAll({ ...state, accounts, imports, txns });
}
