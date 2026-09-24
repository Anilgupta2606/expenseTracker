import type { ParseResult, ParsedTxn, Direction } from '../types';
import { detectAccountNumber, detectBank, detectHolderName, parseAmount, parseDate, round2 } from './util';

export type Cell = string | number | boolean | Date | null | undefined;

const pad = (n: number) => String(n).padStart(2, '0');

function cellDate(c: Cell): string | null {
  if (c instanceof Date) {
    // SheetJS builds dates at local midnight; add 12h so timezone offsets can't shift the day.
    const d = new Date(c.getTime() + 12 * 3600000);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  if (typeof c === 'string') return parseDate(c);
  return null;
}

const text = (c: Cell) => (c == null ? '' : c instanceof Date ? '' : String(c)).trim();

interface Cols {
  date: number; desc: number; ref: number;
  withdrawal: number; deposit: number; balance: number;
  amount: number; drcr: number;
}

function findHeader(rows: Cell[][]): { index: number; cols: Cols } | null {
  for (let i = 0; i < Math.min(rows.length, 60); i++) {
    const cells = rows[i].map((c) => text(c).toLowerCase());
    const find = (re: RegExp, not?: RegExp) => cells.findIndex((c) => re.test(c) && !(not && not.test(c)));
    const dateCandidates = cells.map((c, j) => (/date|\bdt\b/.test(c) ? j : -1)).filter((j) => j >= 0);
    if (!dateCandidates.length) continue;
    // Prefer the transaction date over the value date.
    const date = dateCandidates.find((j) => !/value/.test(cells[j])) ?? dateCandidates[0];
    const cols: Cols = {
      date,
      desc: find(/narration|remarks|description|particulars|details/),
      ref: find(/ref|chq|cheque/),
      withdrawal: find(/withdrawal|debit|\bdr\b/, /dr\s*\/\s*cr|cr\s*\/\s*dr/),
      deposit: find(/deposit|credit|\bcr\b/, /dr\s*\/\s*cr|cr\s*\/\s*dr/),
      balance: find(/balance/),
      amount: find(/amount/, /withdrawal|deposit|debit|credit/),
      drcr: find(/dr\s*\/\s*cr|cr\s*\/\s*dr|^type$|txn type/),
    };
    if (cols.desc < 0) continue;
    if ((cols.withdrawal >= 0 && cols.deposit >= 0) || (cols.amount >= 0 && cols.drcr >= 0)) {
      return { index: i, cols };
    }
  }
  return null;
}

/** Parses rows from an Excel/CSV statement export. */
export function parseRows(rows: Cell[][]): ParseResult {
  const lines = rows.map((r) => r.map(text).filter(Boolean).join('  '));
  const joined = lines.join('\n');
  const meta = {
    bank: detectBank(joined),
    accountNumber: detectAccountNumber(lines.slice(0, 30).join('\n')),
    holderName: detectHolderName(lines.slice(0, 30)),
  };
  const header = findHeader(rows);
  if (!header) {
    return { meta, txns: [], balanceMismatches: 0, warnings: ['Could not find the header row (Date / Narration / Withdrawal / Deposit).'] };
  }
  const c = header.cols;
  const txns: ParsedTxn[] = [];
  let mismatches = 0;
  let prevBalance: number | undefined;

  for (const row of rows.slice(header.index + 1)) {
    const date = cellDate(row[c.date]);
    if (!date) continue;
    let amount: number | null = null;
    let direction: Direction = 'debit';
    if (c.withdrawal >= 0 && c.deposit >= 0) {
      const w = parseAmount(row[c.withdrawal] as string | number);
      const dep = parseAmount(row[c.deposit] as string | number);
      if (w) { amount = w; direction = 'debit'; } else if (dep) { amount = dep; direction = 'credit'; }
    } else {
      amount = parseAmount(row[c.amount] as string | number);
      direction = /^c/i.test(text(row[c.drcr])) ? 'credit' : 'debit';
    }
    if (!amount) continue;
    const balance = c.balance >= 0 ? parseAmount(row[c.balance] as string | number) ?? undefined : undefined;
    if (prevBalance != null && balance != null) {
      const expected = round2(prevBalance + (direction === 'credit' ? amount : -amount));
      if (Math.abs(expected - balance) > 0.011) mismatches++;
    }
    if (balance != null) prevBalance = balance;
    txns.push({
      date,
      description: text(row[c.desc]).replace(/\s+/g, ' '),
      amount: Math.abs(amount),
      direction: amount < 0 ? (direction === 'debit' ? 'credit' : 'debit') : direction,
      balance,
      ref: c.ref >= 0 ? text(row[c.ref]) || undefined : undefined,
    });
  }
  return {
    meta,
    txns,
    balanceMismatches: mismatches,
    warnings: txns.length ? [] : ['No transactions found in this file.'],
  };
}

export async function readSheet(data: ArrayBuffer): Promise<ParseResult> {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(data, { type: 'array', cellDates: true });
  // Use the first sheet that yields transactions.
  let first: ParseResult | null = null;
  for (const name of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json<Cell[]>(wb.Sheets[name], { header: 1, raw: true, defval: null });
    const r = parseRows(rows);
    if (r.txns.length) return r;
    first ??= r;
  }
  return first ?? { meta: { bank: 'Unknown' }, txns: [], balanceMismatches: 0, warnings: ['The file has no sheets.'] };
}
