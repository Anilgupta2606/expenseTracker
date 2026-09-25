import type { Account, AppState, ParsedTxn, ParseResult, StatementImport, Txn } from './types';
import { categorize, extractMerchant, pairTransfers, type Context } from './categorize/engine';
import { hash } from './parse/util';
import { categoryCounted, isValidCategory } from './categorize/categories';

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

export async function parseFile(file: File, password?: string, settings?: AppState['settings'], onProgress?: (p: ReadProgress) => void): Promise<ParseResult> {
  return readStatement(await file.arrayBuffer(), file.name, file.type, password, settings, onProgress);
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

type Classified = Pick<Txn, 'kind' | 'category' | 'source' | 'excluded' | 'merchantKey' | 'merchantName' | 'titleSet'>;

/**
 * Type, category and title for a statement row. Your learned rules, your own
 * transfers and the sure rules (salary, investments, card bills) win; the AI
 * reader's payee becomes the title, and its category beats the app's guesses
 * and merchant-name matches.
 */
export function classify(p: ParsedTxn, ctx: Context, accountId: string): Classified {
  const merchant = extractMerchant(p.description);
  const c = categorize(p, merchant, ctx, accountId);
  const out: Classified = {
    kind: c.kind, category: c.category, source: c.source, excluded: c.excluded,
    merchantKey: merchant.key, merchantName: merchant.name,
  };
  const hint = p.hint && isValidCategory(p.hint.kind, p.hint.category) ? p.hint : undefined;
  // "SELF" is how your own name reaches the AI; placeholders like "Unknown" aren't titles.
  if (hint?.payee.trim() && !/^(self|unknown|uncategori[sz]ed|n\/?a|none|-)$/i.test(hint.payee.trim())) { out.merchantName = hint.payee.trim().slice(0, 40); out.titleSet = 'ai'; }
  if (hint && (c.source === 'default' || c.weak)) { out.kind = hint.kind; out.category = hint.category; out.source = 'ai'; }
  if (c.title) { out.merchantName = c.title; out.titleSet = 'manual'; }
  // Categories switched off in Settings → What counts are left out of totals.
  if (!categoryCounted(ctx.settings, out.kind, out.category)) out.excluded = true;
  return out;
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
    const { hint: _h, ...row } = p;
    fresh.push({ ...row, ...classify(p, ctx, account.id), id: ids[i], accountId: account.id, importedAt: now, importId });
  });
  // Pair within this statement and against earlier imports (on copies, until committed).
  const earlier = state.txns.map((t) => ({ ...t }));
  pairTransfers([...earlier, ...fresh]);
  countPairs(fresh, state.settings, true);
  countPairs(earlier, state.settings, true);
  const updated = earlier.filter((t, i) => t.pairId !== state.txns[i].pairId);
  const dates = fresh.map((t) => t.date).sort();
  const record: StatementImport = {
    id: importId, fileName, accountId: account.id, from: dates[0] ?? '', to: dates[dates.length - 1] ?? '', importedAt: now,
    rows: result.txns.length, balanceMismatches: result.balanceMismatches, reader: result.reader, aiTitles: result.aiTitles,
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

/** Rows just paired as self transfers follow the Self Transfer Counted setting. */
function countPairs(txns: Txn[], settings: AppState['settings'], inPlace = false): Txn[] {
  const counted = categoryCounted(settings, 'transfer', 'Self Transfer');
  const fix = (t: Txn) => (t.source === 'pair' && t.pairId && t.excluded === counted ? { ...t, excluded: !counted } : t);
  if (!inPlace) return txns.map(fix);
  txns.forEach((t, i) => { txns[i] = fix(t); });
  return txns;
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
    const c = classify({ ...t, hint: undefined }, ctx, t.accountId);
    // A title you typed stays; one from a learned rule beats the AI's.
    const own = t.titleSet === 'manual' || (t.titleSet === 'ai' && c.titleSet !== 'manual');
    // A row that moves to another category follows that category's Counted setting; otherwise your tick stays.
    const moved = c.kind !== t.kind || c.category !== t.category;
    return {
      ...t, kind: c.kind, category: c.category, source: c.source, excluded: moved || c.source === 'learned' ? c.excluded : t.excluded, pairId: undefined,
      merchantKey: c.merchantKey, merchantName: own ? t.merchantName : c.merchantName, titleSet: own ? t.titleSet : c.titleSet,
    };
  });
  pairTransfers(txns);
  return { ...state, txns: countPairs(txns, state.settings) };
}

/** Fewer balance breaks wins; then more rows. */
function better(a: ParseResult, b: ParseResult): boolean {
  if (!b.txns.length) return true;
  if (!a.txns.length) return false;
  if (a.balanceMismatches !== b.balanceMismatches) return a.balanceMismatches < b.balanceMismatches;
  return a.txns.length > b.txns.length;
}

/**
 * Reads a statement with the on-device reader, trying several line-grouping
 * settings, and keeps the reading whose running balance holds best.
 */
export async function parseThorough(data: ArrayBuffer, fileName: string, type: string, password?: string): Promise<ParseResult> {
  return readStatement(data, fileName, type, password);
}

const isPdf = (fileName: string, type: string) => /\.pdf$/i.test(fileName) || type === 'application/pdf';

export interface ReadProgress { stage: 'local' | 'ai-read' | 'ai-titles'; done: number; total: number }

/**
 * Reads a statement. The on-device reader reads the rows; with a Gemini key,
 * the AI reads the table instead when the running balance doesn't add up
 * (only the table, with numbers and names masked), and then the AI cleans up
 * every row's title and category from that row's own text.
 */
export async function readStatement(
  data: ArrayBuffer, fileName: string, type: string, password?: string,
  settings?: AppState['settings'], onProgress?: (p: ReadProgress) => void,
): Promise<ParseResult> {
  let result: ParseResult;
  let items: Awaited<ReturnType<typeof import('./parse/pdf')['readPdfItems']>> | null = null;
  if (!isPdf(fileName, type)) {
    const { readSheet } = await import('./parse/sheet');
    result = { ...(await readSheet(data.slice(0))), reader: 'local' };
  } else {
    const [{ readPdfItems }, { groupLines, parseLayout }] = await Promise.all([import('./parse/pdf'), import('./parse/layout')]);
    onProgress?.({ stage: 'local', done: 0, total: 1 });
    items = await readPdfItems(data.slice(0), password);
    let best: ParseResult | null = null;
    for (const tolerance of [2, 1, 3, 4]) {
      const pages = items.map((p) => groupLines(p, tolerance));
      for (const preLine of [0.75, 0.6, 0.9]) {
        const r = parseLayout(pages, { preLine });
        if (!best || better(r, best)) best = r;
      }
    }
    result = { ...best!, reader: 'local' };
  }
  if (!settings?.geminiKey) return result;

  const [{ scanWithGemini, pickReading }, { GeminiSession, suggestForRows }, { groupLines }] = await Promise.all([
    import('./parse/aiScan'), import('./categorize/gemini'), import('./parse/layout'),
  ]);
  if (items && (result.balanceMismatches > 0 || !result.txns.length)) {
    try {
      const ai = await scanWithGemini(items.map((p) => groupLines(p)), settings, result.meta.holderName,
        (done, total) => onProgress?.({ stage: 'ai-read', done, total }));
      result = pickReading(result, ai);
    } catch (e) {
      result = pickReading(result, null, (e as Error).message);
    }
  }
  if (!result.txns.length) return result;
  try {
    const session = new GeminiSession(settings.geminiKey);
    const found = await suggestForRows(result.txns, [...settings.ownNames, ...(result.meta.holderName ? [result.meta.holderName] : [])], session,
      (done, total) => onProgress?.({ stage: 'ai-titles', done, total }));
    const mixed = found.filter((s) => s?.mixed).length;
    result = {
      ...result,
      aiTitles: true,
      txns: result.txns.map((t, i) => {
        const s = found[i];
        return s ? { ...t, hint: { payee: s.payee, kind: s.kind, category: s.category } } : t;
      }),
      warnings: mixed ? [...result.warnings, `The AI thinks ${mixed} row${mixed > 1 ? 's' : ''} may carry text from another row; check them against the PDF.`] : result.warnings,
    };
  } catch (e) {
    result = { ...result, warnings: [...result.warnings, `AI titles skipped (${(e as Error).message}). You can run AI check later.`] };
  }
  return result;
}

export interface RescanResult {
  result: ParseResult;
  missing: Txn[];
  /** Rows already in the app whose description the new reading corrects. */
  corrected: { id: string; description: string; hint?: ParsedTxn['hint'] }[];
  /** Rows read the same whose title or category the AI would improve. */
  retitled: number;
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
  if (!rec) return { result, missing: [], corrected: [], retitled: 0, matched: 0 };
  const account = state.accounts.find((a) => a.id === rec.accountId) ?? { id: rec.accountId, bank: result.meta.bank, number: rec.accountId };
  const ctx = contextFor(state, account);
  const { ids, matches } = matchRows(state, account.id, result.txns);
  const missing: Txn[] = [];
  const corrected: RescanResult['corrected'] = [];
  let matched = 0, retitled = 0;
  result.txns.forEach((p, i) => {
    const same = matches[i];
    if (same) {
      matched++;
      if (same.description !== p.description) {
        corrected.push({ id: same.id, description: p.description, hint: p.hint });
      } else if (p.hint) {
        const c = classify(p, ctx, account.id);
        const newTitle = same.titleSet !== 'manual' && c.merchantName !== same.merchantName;
        const newType = same.source !== 'manual' && same.source !== 'learned' && (c.kind !== same.kind || c.category !== same.category);
        if (newTitle || newType) { corrected.push({ id: same.id, description: p.description, hint: p.hint }); retitled++; }
      }
      return;
    }
    const { hint: _h, ...row } = p;
    missing.push({ ...row, ...classify(p, ctx, account.id), id: ids[i], accountId: account.id, importId: rec.id, importedAt: Date.now() });
  });
  return { result, missing, corrected, retitled, matched };
}

export function applyRescan(state: AppState, importId: string, rescan: RescanResult): AppState {
  const dates = [...state.txns.filter((t) => t.importId === importId), ...rescan.missing].map((t) => t.date).sort();
  const imports = state.imports.map((i) => (i.id === importId ? {
    ...i, rows: rescan.result.txns.length, balanceMismatches: rescan.result.balanceMismatches, reader: rescan.result.reader, aiTitles: rescan.result.aiTitles || i.aiTitles,
    from: dates[0] ?? i.from, to: dates[dates.length - 1] ?? i.to, rescannedAt: Date.now(),
  } : i));
  // Corrected descriptions get a fresh payee and category, unless you set the type or title yourself.
  const ctx = contextFor(state);
  const fixes = new Map(rescan.corrected.map((c) => [c.id, c]));
  const updated = state.txns.map((t) => {
    const fix = fixes.get(t.id);
    if (!fix) return t;
    const c = classify({ ...t, description: fix.description, hint: fix.hint }, ctx, t.accountId);
    const next = { ...t, description: fix.description, merchantKey: c.merchantKey };
    if (t.titleSet !== 'manual') { next.merchantName = c.merchantName; next.titleSet = c.titleSet; }
    if (t.source !== 'manual') { next.kind = c.kind; next.category = c.category; next.source = c.source; }
    return next;
  });
  const txns = [...updated, ...rescan.missing].sort((a, b) => b.date.localeCompare(a.date));
  // An older reader could name the wrong bank; the new reading fixes the label.
  const rec = state.imports.find((i) => i.id === importId);
  const bank = rescan.result.meta.bank;
  const accounts = bank && bank !== 'Unknown'
    ? state.accounts.map((a) => (a.id === rec?.accountId && !a.bankSetByHand ? { ...a, bank } : a))
    : state.accounts;
  return recategorizeAll({ ...state, accounts, imports, txns });
}
