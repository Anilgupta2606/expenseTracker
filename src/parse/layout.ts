import type { ParseResult, ParsedTxn, Direction } from '../types';
import {
  AMOUNT_RE, parseAmount, parseDate, round2,
  detectBank, detectAccountNumber, detectHolderName,
} from './util';

/** A piece of text on a PDF page. x grows to the right, y grows upwards. */
export interface Item { x: number; w: number; s: string }
export interface Line { y: number; items: Item[] }
export type Page = Line[];

const lineText = (l: Line) => l.items.map((i) => i.s).join(' ').replace(/\s+/g, ' ').trim();
const center = (i: Item) => i.x + i.w / 2;

const DATE_ITEM_RE = /^\d{1,2}[/.\-](\d{1,2}|[A-Za-z]{3})[/.\-]\d{2,4}$/;
const STOP_RE = /STATEMENT SUMMARY|^OPENING BALANCE|GENERATED ON|END OF STATEMENT|LEGENDS? FOR|^SINCER|THIS IS A (COMPUTER|SYSTEM) GENERATED|^TOTAL\b|^\*?CLOSING BALANCE/i;

interface Columns {
  headerY: number; // y of the lowest header line
  date: number;
  desc: number;
  withdrawal: number; // center x
  deposit: number;
  balance?: number;
  amountLeft: number; // left edge of the first amount column
}

/** Groups raw text items into lines by y position. */
export type RawItem = { x: number; y: number; w: number; s: string };

/** Groups raw text items into lines; `tolerance` is how far apart (in PDF units) items on one line may sit. */
export function groupLines(items: RawItem[], tolerance = 2): Line[] {
  const lines: Line[] = [];
  const sorted = items.filter((i) => i.s.trim()).sort((a, b) => b.y - a.y || a.x - b.x);
  for (const it of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - it.y) <= tolerance) last.items.push({ x: it.x, w: it.w, s: it.s.trim() });
    else lines.push({ y: it.y, items: [{ x: it.x, w: it.w, s: it.s.trim() }] });
  }
  for (const l of lines) l.items.sort((a, b) => a.x - b.x);
  return lines;
}

export function findColumns(page: Page): Columns | null {
  const idx = page.findIndex((l) => {
    const t = lineText(l);
    return /withdrawal|debit/i.test(t) && /deposit|credit/i.test(t);
  });
  if (idx < 0) return null;
  // Headers often wrap over a few lines; take neighbours within 15 units.
  const block = page.filter((l) => Math.abs(l.y - page[idx].y) <= 15);
  const items = block.flatMap((l) => l.items);
  const find = (re: RegExp) => items.filter((i) => re.test(i.s));
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

  const w = find(/withdrawal|debit|\bdr\b/i);
  const d = find(/deposit|credit|\bcr\b/i);
  if (!w.length || !d.length) return null;
  const b = find(/balance/i);
  const dateItems = find(/date|\bdt\b/i);
  // Summary tables ("Opening Balance | Debits | Credits") have no date column.
  if (!dateItems.length) return null;
  const desc = find(/narration|remarks|description|particulars|details/i);
  const withdrawal = avg(w.map(center));
  const deposit = avg(d.map(center));
  return {
    headerY: Math.min(...block.map((l) => l.y)),
    date: Math.min(...dateItems.map((i) => i.x)),
    desc: desc.length ? desc[0].x : Math.min(...w.map((i) => i.x)),
    withdrawal,
    deposit,
    balance: b.length ? avg(b.map(center)) : undefined,
    amountLeft: Math.min(...w.map((i) => i.x), ...d.map((i) => i.x)),
  };
}

/** Lower quartile: robust to the odd large jump (e.g. to a page footer). */
function typicalGap(xs: number[]): number {
  const s = xs.filter((x) => x > 0).sort((a, b) => a - b);
  if (!s.length) return 12;
  return s[Math.floor((s.length - 1) / 4)];
}

interface Row {
  date: string;
  amounts: Item[];
  descLines: { x: number; text: string }[];
  ref?: string;
  cols: Columns;
}

/**
 * Parses a bank statement laid out as a table (date, narration, withdrawal,
 * deposit, balance). Works for HDFC, ICICI and most Indian bank PDFs.
 */
export interface LayoutOptions {
  /** A line this close above a date row (as a share of the normal line gap) belongs to that row. */
  preLine?: number;
}

/** The issuing bank, read from the header above the transactions table (page 1). */
export function statementBank(pages: Page[]): string {
  const joined = pages.flat().map(lineText).join('\n');
  const first = (pages[0] ?? []).map(lineText);
  const tableAt = first.findIndex((l) => /\bbalance\b/i.test(l) && /withdrawal|debit|deposit|credit/i.test(l));
  return detectBank(joined, first.slice(0, tableAt >= 0 ? tableAt : 20).join('\n'));
}

export function parseLayout(pages: Page[], opts: LayoutOptions = {}): ParseResult {
  const preLine = opts.preLine ?? 0.75;
  const allText = pages.flat().map(lineText);
  const joined = allText.join('\n');
  const bank = statementBank(pages);
  const warnings: string[] = [];

  let holderName = detectHolderName(allText);
  if (!holderName) {
    // ICICI: the name is the first item on the line after the statement title.
    const t = pages[0]?.findIndex((l) => /statement of transactions/i.test(lineText(l)));
    if (t != null && t >= 0) {
      const next = pages[0][t + 1]?.items[0]?.s;
      if (next && /^[A-Za-z .]{3,40}$/.test(next)) holderName = next.toUpperCase();
    }
  }

  let cols: Columns | null = null;
  const rows: Row[] = [];

  for (const page of pages) {
    const pageCols = findColumns(page);
    if (pageCols) cols = pageCols;
    if (!cols) continue;
    const c = cols;
    // Body starts under the header. Pages without their own header reuse the last one.
    const top = pageCols ? pageCols.headerY - 1 : c.headerY + 8;
    const body: Line[] = [];
    for (const l of page) {
      if (l.y > top) continue;
      if (STOP_RE.test(lineText(l))) break;
      body.push(l);
    }
    // Spacing between wrapped narration lines of the same row.
    const contGaps: number[] = [];
    const isAnchor = (l: Line) =>
      l.items.some((i) => i.x < c.desc - 2 && DATE_ITEM_RE.test(i.s) && parseDate(i.s)) &&
      l.items.some((i) => i.x >= c.amountLeft - 30 && AMOUNT_RE.test(i.s));
    for (let k = 1; k < body.length; k++) {
      if (!isAnchor(body[k]) && !isAnchor(body[k - 1])) contGaps.push(body[k - 1].y - body[k].y);
    }
    const gap = typicalGap(contGaps.length ? contGaps : body.slice(1).map((l, i) => body[i].y - l.y));

    // Narration starts right after the date column.
    const dateOf = (l: Line) => l.items.find((i) => i.x < c.desc - 2 && DATE_ITEM_RE.test(i.s));
    const anchors = body.filter(isAnchor);
    const descLeft = anchors.length
      ? Math.min(...anchors.map((l) => { const d = dateOf(l)!; return d.x + d.w; })) - 6
      : c.desc - 15;
    const descItems = (l: Line) =>
      l.items.filter((i) => i.x >= descLeft && i.x < c.amountLeft - 30 && !(i !== l.items[0] && DATE_ITEM_RE.test(i.s)));

    const makeRow = (l: Line, before: { x: number; text: string }[]): Row => {
      const dateItem = dateOf(l)!;
      const amounts = l.items.filter((i) => i.x >= c.amountLeft - 30 && AMOUNT_RE.test(i.s));
      const ds = descItems(l).filter((i) => i !== dateItem);
      // Reference numbers sit in their own column between narration and amounts.
      const refItem = ds.length > 1 && /^[A-Z0-9]{10,}$/.test(ds[ds.length - 1].s) ? ds[ds.length - 1] : undefined;
      const text = ds.filter((i) => i !== refItem).map((i) => i.s).join(' ');
      return {
        date: parseDate(dateItem.s)!,
        amounts,
        descLines: [...before, ...(text ? [{ x: ds[0].x, text }] : [])],
        ref: refItem?.s,
        cols: c,
      };
    };

    // Layouts that centre each description around its date line (ICICI) are
    // split by structure: a short payee line followed by "UPI/…", "NEFT-…" etc.
    const blocks = segmentCentered(body, isAnchor, descItems, gap, preLine);
    if (blocks) {
      for (const cont of blocks.continuation) rows[rows.length - 1]?.descLines.push(cont);
      for (const { anchor, lines } of blocks.rows) rows.push(makeRow(anchor, lines));
      continue;
    }

    let pending: { x: number; text: string }[] = [];
    let lastY = Infinity;
    for (let k = 0; k < body.length; k++) {
      const l = body[k];
      if (isAnchor(l)) {
        rows.push(makeRow(l, pending));
        pending = [];
        lastY = l.y;
        continue;
      }
      const items = descItems(l);
      if (!items.length) continue;
      // Footer text far below the last row is not part of the narration.
      if (lastY !== Infinity && lastY - l.y > gap * 2.5) break;
      const entry = { x: items[0].x, text: items.map((i) => i.s).join(' ') };
      lastY = l.y;
      // A line just above an anchor (closer than a normal line gap) belongs to it:
      // ICICI vertically centres the remarks around the date.
      const next = body[k + 1];
      if (next && isAnchor(next) && l.y - next.y < gap * preLine) pending.push(entry);
      else if (rows.length) rows[rows.length - 1].descLines.push(entry);
      else pending.push(entry);
    }
  }

  if (!cols) {
    return { meta: { bank, holderName, accountNumber: detectAccountNumber(joined) }, txns: [], balanceMismatches: 0, warnings: ['Could not find the transactions table (no Withdrawal/Deposit header).'] };
  }

  const txns: ParsedTxn[] = [];
  let mismatches = 0;
  let prevBalance: number | undefined;
  for (const r of rows) {
    const c = r.cols;
    let balance: number | undefined;
    let amountItems = r.amounts;
    if (c.balance != null && amountItems.length >= 2) {
      const last = amountItems[amountItems.length - 1];
      balance = parseAmount(last.s) ?? undefined;
      amountItems = amountItems.slice(0, -1);
    }
    const amtItem = amountItems[amountItems.length - 1];
    if (!amtItem) continue;
    const amount = parseAmount(amtItem.s);
    if (amount == null || amount === 0) continue;
    let direction: Direction = Math.abs(center(amtItem) - c.withdrawal) <= Math.abs(center(amtItem) - c.deposit) ? 'debit' : 'credit';
    if (/DR$/i.test(amtItem.s)) direction = 'debit';
    if (/CR$/i.test(amtItem.s)) direction = 'credit';
    // The running balance is the most reliable signal for direction.
    if (prevBalance != null && balance != null) {
      if (Math.abs(round2(prevBalance - amount) - balance) < 0.011) direction = 'debit';
      else if (Math.abs(round2(prevBalance + amount) - balance) < 0.011) direction = 'credit';
      else mismatches++;
    }
    if (balance != null) prevBalance = balance;
    txns.push({
      date: r.date,
      description: joinDescription(r.descLines, bank),
      amount: Math.abs(amount),
      direction,
      balance,
      ref: r.ref,
    });
  }

  if (!txns.length) warnings.push('No transactions found in this file.');
  return {
    meta: { bank, holderName, accountNumber: detectAccountNumber(joined) },
    txns,
    balanceMismatches: mismatches,
    warnings,
  };
}

/**
 * HDFC prints narrations in fixed-width chunks. A line starting left of the
 * first line is a word wrap inside a chunk (needs a space); a new chunk is a
 * hard split unless the previous chunk was short (its trailing space got trimmed).
 */
function joinDescription(lines: { x: number; text: string }[], bank: string): string {
  if (!lines.length) return '';
  if (bank !== 'HDFC') return lines.map((l) => l.text).join(' ').replace(/\s+/g, ' ').trim();
  const baseX = lines[0].x;
  let out = lines[0].text;
  let chunkLen = lines[0].text.length;
  for (const l of lines.slice(1)) {
    if (l.x < baseX - 1) {
      out += ' ' + l.text;
      chunkLen += 1 + l.text.length;
    } else {
      out += (chunkLen < 39 ? ' ' : '') + l.text;
      chunkLen = l.text.length;
    }
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** First lines of a transaction remark in Indian bank statements. */
const REMARK_START = /^(UPI|MMT|IMPS|NEFT|RTGS|CMS|N?ACH|ECS|BIL|BPAY|BBPS|INFT?|VPS|IPS|POS|ATM|NWD|ATW|CLG|TRF|EBA|SMO|RCHG|DTAX|IDTX|PAVC|LNPY|CCWD|PAYC|TOP|VAT|MAT|NFS|SGB|INT|DD|CHQ|CASH|MB|IB)\s*[/\-:]/i;

interface TextLine { y: number; x: number; text: string }

/**
 * Splits a page whose descriptions are centred on the date line into one
 * block per transaction. Returns null when the layout doesn't look like that
 * or the blocks don't line up one-to-one with the date lines.
 */
function segmentCentered(
  body: Line[],
  isAnchor: (l: Line) => boolean,
  descItems: (l: Line) => Item[],
  gap: number,
  preLine: number,
): { rows: { anchor: Line; lines: TextLine[] }[]; continuation: TextLine[] } | null {
  const anchors = body.filter(isAnchor);
  if (!anchors.length) return null;
  // Only for centred layouts: some description line sits just above a date line.
  const centred = body.some((l, k) => !isAnchor(l) && body[k + 1] && isAnchor(body[k + 1]) && l.y - body[k + 1].y < gap * preLine && descItems(l).length);
  if (!centred) return null;

  // Text lines in reading order, stopping at footer text far below the last row.
  const lines: TextLine[] = [];
  let lastY = Infinity;
  for (const l of body) {
    if (isAnchor(l)) { lastY = l.y; continue; }
    const items = descItems(l);
    if (!items.length) continue;
    if (lastY !== Infinity && lastY - l.y > gap * 2.5) break;
    lines.push({ y: l.y, x: items[0].x, text: items.map((i) => i.s).join(' ') });
    lastY = l.y;
  }
  const isStart = (t: string) => REMARK_START.test(t.trim());
  const isLabel = (k: number) => !isStart(lines[k].text) && lines[k].text.length <= 30 &&
    k + 1 < lines.length && isStart(lines[k + 1].text) && lines[k].y - lines[k + 1].y <= gap * 1.5;

  const blocks: TextLine[][] = [];
  const continuation: TextLine[] = [];
  for (let k = 0; k < lines.length; k++) {
    const begins = isLabel(k) || (isStart(lines[k].text) && !(k > 0 && isLabel(k - 1)));
    if (begins) blocks.push([lines[k]]);
    else if (blocks.length) blocks[blocks.length - 1].push(lines[k]);
    else continuation.push(lines[k]);
  }
  if (!blocks.length) return null;

  // Each block belongs to the date line inside (or right next to) its span.
  const taken = new Set<Line>();
  const rows: { anchor: Line; lines: TextLine[] }[] = [];
  for (const b of blocks) {
    const top = b[0].y + gap * 0.8, bottom = b[b.length - 1].y - gap * 0.8, mid = (b[0].y + b[b.length - 1].y) / 2;
    const candidates = anchors.filter((a) => !taken.has(a) && a.y <= top && a.y >= bottom)
      .sort((a, z) => Math.abs(a.y - mid) - Math.abs(z.y - mid));
    if (!candidates.length) return null;
    taken.add(candidates[0]);
    rows.push({ anchor: candidates[0], lines: b });
  }
  // Date lines without a block keep their own text (if any).
  for (const a of anchors) if (!taken.has(a)) rows.push({ anchor: a, lines: [] });
  rows.sort((a, z) => z.anchor.y - a.anchor.y);
  return { rows, continuation };
}
