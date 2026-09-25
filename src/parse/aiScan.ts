import type { Kind, ParsedTxn, ParseResult, Settings } from '../types';
import { CATEGORIES, isValidCategory } from '../categorize/categories';
import { AI_KINDS, ALL_CATEGORIES, GeminiSession } from '../categorize/gemini';
import type { Page } from './layout';
import { round2 } from './util';

/** A line of the statement as the AI sees it: the text pieces left to right, separated by " | ". */
const lineCells = (l: Page[number]) => [...l.items].sort((a, b) => a.x - b.x).map((i) => i.s).join(' | ');

const TABLE_HEADER = (l: string) => /\bbalance\b/i.test(l) && /withdrawal|debit|deposit|credit/i.test(l);

/**
 * Only the transactions table leaves the device: on each page, lines above the
 * table header (name, address, account details) are dropped. Returns null when
 * no table header is found, so the on-device reader is used instead.
 */
export function tableLines(pages: Page[]): string[][] | null {
  let seenHeader = false;
  const out = pages.map((page) => {
    const lines = page.map(lineCells);
    const at = lines.findIndex(TABLE_HEADER);
    if (at >= 0) { seenHeader = true; return lines.slice(at); }
    return seenHeader ? lines : [];
  });
  return seenHeader ? out : null;
}

/**
 * Replaces long numbers (account, phone, reference numbers), email addresses
 * and your names with placeholders like [#3] and [@1], and puts them back in
 * whatever the AI returns. Amounts and balances stay: the AI needs them, and
 * the running balance is how its reading is checked.
 */
export function makeMask(names: string[]) {
  const tokens = new Map<string, string>();
  const originals = new Map<string, string>();
  const counts: Record<string, number> = {};
  const tokenFor = (prefix: string, text: string) => {
    const k = `${prefix}${text.toUpperCase()}`;
    let tok = tokens.get(k);
    if (!tok) {
      counts[prefix] = (counts[prefix] ?? 0) + 1;
      tok = `[${prefix}${counts[prefix]}]`;
      tokens.set(k, tok);
      originals.set(tok, text);
    }
    return tok;
  };
  const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const full = [...new Set(names.map((n) => n.trim()).filter((n) => n.length >= 3))].sort((a, b) => b.length - a.length);
  // Also each word of a name (ICICI cuts names short, e.g. "ANIL GUPT").
  const words = [...new Set(full.flatMap((n) => n.split(/\s+/)).filter((w) => w.length >= 4))];
  const nameRes = [...full, ...words].map((n) => new RegExp(`\\b${escapeRe(n)}\\b`, 'gi'));
  return {
    hide(text: string): string {
      let t = text
        .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, (m) => tokenFor('#', m))
        .replace(/\d{9,}/g, (m) => tokenFor('#', m));
      for (const re of nameRes) t = t.replace(re, (m) => tokenFor('@', m));
      return t;
    },
    restore(text: string): string {
      return text.replace(/\[[#@]\d+\]/g, (tok) => originals.get(tok) ?? tok);
    },
  };
}

interface AiRow {
  date: string;
  description: string;
  amount: number;
  direction: 'debit' | 'credit';
  balance: number | null;
  payee: string;
  kind: Kind;
  category: string;
}

const SCAN_PROMPT = `You read the transactions table of an Indian bank statement for a personal expense tracker.
Each line below is one printed line of the table; " | " separates text pieces on the same line, left to right.
Placeholders like [#3] and [@1] stand for hidden numbers and names: copy them exactly as they are.

Return every transaction in the order printed. For each one:
- date: the transaction date as YYYY-MM-DD (Indian statements write day first).
- description: the transaction's full narration / remarks text exactly as printed, with its lines joined by single spaces. Leave out the dates, amounts, balance and page furniture.
- amount: the withdrawal or deposit amount as a positive number.
- direction: "debit" for a withdrawal, "credit" for a deposit.
- balance: the closing balance printed on that row, or null if none.
- payee: the real merchant or person, cleaned up (e.g. "Swiggy", "DSB Hospitality", "Rakesh Jain"). For UPI narrations use the payee inside "UPI/<payee>/..." rather than a short label before it.
- kind: spend, investment, income, transfer (between the account holder's own accounts) or cc_bill (paying the holder's credit card bill).
- category, one of the allowed categories for that kind:
${AI_KINDS.map((k) => `  ${k}: ${CATEGORIES[k].join(', ')}`).join('\n')}

Important:
- Some banks (e.g. ICICI) centre the remarks vertically, so a transaction's remarks start on the line(s) ABOVE the line with its date and amounts and continue below it. A transaction's remarks are: an optional short label line (such as "Rakesh jai", "Credit trxn" or "NACH trxn", often repeating the start of the payee name), then a line starting with a code like UPI/, MMT/, CMS/, ACH/, NEFT, BIL/, then that text's continuation lines. A short label line belongs to the transaction BELOW it, never to the one above. A transaction's remarks end right before the next short label line or the next code line.
- Never give one transaction's remarks to another; the payee in "UPI/<payee>/" and a label above it should agree.
- Skip opening balance, totals, summaries, page headers and footers.
- Hospitality businesses are usually restaurants or hotels, not hospitals. Use "Uncategorised" only when the text gives no clue.`;

const SCAN_SCHEMA = {
  type: 'OBJECT',
  properties: {
    rows: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          date: { type: 'STRING' },
          description: { type: 'STRING' },
          amount: { type: 'NUMBER' },
          direction: { type: 'STRING', enum: ['debit', 'credit'] },
          balance: { type: 'NUMBER', nullable: true },
          payee: { type: 'STRING' },
          kind: { type: 'STRING', enum: AI_KINDS },
          category: { type: 'STRING', enum: ALL_CATEGORIES },
        },
        required: ['date', 'description', 'amount', 'direction', 'balance', 'payee', 'kind', 'category'],
      },
    },
  },
  required: ['rows'],
};

/** Rows whose closing balance doesn't follow from the row before (in either printed order). */
export function countMismatches(txns: ParsedTxn[]): number {
  const count = (rows: ParsedTxn[]) => {
    let n = 0;
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1].balance, cur = rows[i].balance;
      if (prev == null || cur == null) continue;
      const expected = prev + (rows[i].direction === 'credit' ? rows[i].amount : -rows[i].amount);
      if (Math.abs(expected - cur) > 0.011) n++;
    }
    return n;
  };
  return Math.min(count(txns), count([...txns].reverse()));
}

/** Splits pages into requests of about this many lines, on page boundaries. */
function chunks(pages: string[][], maxLines = 220): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  for (const page of pages) {
    if (cur.length && cur.length + page.length > maxLines) { out.push(cur); cur = []; }
    cur.push(...page);
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * Reads the statement's transactions with Gemini. Only the table text goes
 * out, with numbers and names masked; the balance check happens on the device.
 */
export async function scanWithGemini(
  pages: Page[], settings: Settings, holderName: string | undefined,
  onProgress?: (done: number, total: number) => void, retryDelay = 2000,
): Promise<ParsedTxn[] | null> {
  if (!settings.geminiKey) return null;
  const table = tableLines(pages);
  if (!table) return null;
  const mask = makeMask([...settings.ownNames, ...settings.familyNames, holderName ?? '']);
  const session = new GeminiSession(settings.geminiKey, retryDelay);
  const parts = chunks(table.map((lines) => lines.map((l) => mask.hide(l))));
  const txns: ParsedTxn[] = [];
  for (let i = 0; i < parts.length; i++) {
    onProgress?.(i, parts.length);
    const { rows } = await session.generate<{ rows: AiRow[] }>(`${SCAN_PROMPT}\n\nLines:\n${parts[i].join('\n')}`, SCAN_SCHEMA);
    for (const r of rows) {
      const amount = round2(Math.abs(Number(r.amount)));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date) || !(amount > 0) || (r.direction !== 'debit' && r.direction !== 'credit')) continue;
      const hint = AI_KINDS.includes(r.kind) && isValidCategory(r.kind, r.category)
        ? { payee: mask.restore(r.payee ?? '').trim(), kind: r.kind, category: r.category } : undefined;
      txns.push({
        date: r.date,
        description: mask.restore(r.description ?? '').replace(/\s+/g, ' ').trim(),
        amount,
        direction: r.direction,
        balance: r.balance == null || !Number.isFinite(Number(r.balance)) ? undefined : round2(Number(r.balance)),
        hint,
      });
    }
  }
  onProgress?.(parts.length, parts.length);
  return txns;
}

/**
 * The on-device reading is kept while its running balance adds up; the AI's
 * reading of the table is used only when it adds up better (the AI can read
 * amounts right yet attach a label to the wrong row, which no balance check
 * catches).
 */
export function pickReading(local: ParseResult, ai: ParsedTxn[] | null, aiError?: string): ParseResult {
  if (!ai?.length) {
    return { ...local, reader: 'local', warnings: aiError ? [...local.warnings, `AI reading failed (${aiError}); used the on-device reading.`] : local.warnings };
  }
  const aiMismatches = countMismatches(ai);
  if (local.txns.length && aiMismatches >= local.balanceMismatches) {
    return { ...local, reader: 'local', warnings: [...local.warnings, `The AI reading didn't add up better (${aiMismatches} balance gaps); used the on-device reading.`] };
  }
  return { meta: local.meta, txns: ai, balanceMismatches: aiMismatches, warnings: local.warnings, reader: 'ai' };
}
