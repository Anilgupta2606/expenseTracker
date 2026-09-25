import type { Account, CategorySource, Kind, LearnedRule, ParsedTxn, Settings, Txn } from '../types';
import { UNCATEGORISED } from './categories';
import {
  COMPANY_MARKERS, MERCHANT_MARKERS, MERCHANT_RULES, PRIORITY_RULES, TRANSFER_METHOD, type Rule,
} from './rules';

export interface Merchant {
  name: string; // display name
  key: string; // grouping key for learning
  vpa?: string;
  method: string;
}

const norm = (s: string) => s.toUpperCase().replace(/\s+/g, ' ').trim();

/** Grouping key: ICICI truncates payee names to 10 chars, so keys use the same. */
export function nameKey(name: string): string {
  return norm(name).replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 10).trim();
}

function title(s: string): string {
  return s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

export function detectMethod(d: string): string {
  if (/\bUPI\b/.test(d)) return 'UPI';
  if (/\bIMPS\b|\bMMT\b/.test(d)) return 'IMPS';
  if (/\bNEFT\b/.test(d)) return 'NEFT';
  if (/\bRTGS\b/.test(d)) return 'RTGS';
  if (/\bN?ACH\b|\bECS\b|\bNACH\b/.test(d)) return 'Auto-debit';
  if (/\bATM\b|\bNWD\b|\bATW\b|CASH/.test(d)) return 'Cash';
  if (/\bPOS\b|\bVPS\b|\bIPS\b|DEBIT CARD|\bECOM\b|\bONL\b/.test(d)) return 'Card';
  if (/\bCHQ\b|CHEQUE|\bCLG\b/.test(d)) return 'Cheque';
  if (/\bCMS\b/.test(d)) return 'CMS';
  if (/BILLPAY|\bBBPS\b|\bBIL\b/.test(d)) return 'Bill pay';
  return 'Other';
}

/** Pulls the payee / payer name out of a bank narration. */
export function extractMerchant(description: string): Merchant {
  // ICICI prefixes a short label line such as "Credit trxn" or "NACH trxn".
  const d = norm(description).replace(/^[A-Z]+ TRXN /, '');
  const method = detectMethod(d);
  let name = '';
  let vpa: string | undefined;
  let m: RegExpMatchArray | null;

  if ((m = d.match(/UPI\/([^/]+)\/([^/]*)\//))) {
    // ICICI: UPI/NAME/VPA/NOTE/BANK/REF
    name = m[1]; vpa = m[2] || undefined;
  } else if ((m = d.match(/UPI-(.+?)-([A-Z0-9._\-]+@[A-Z0-9.]+)/))) {
    // HDFC: UPI-NAME-VPA-IFSC-REF-NOTE
    name = m[1]; vpa = m[2];
  } else if ((m = d.match(/MMT\/IMPS\/\d+\/[^/]*\/([^/]+)/))) {
    name = m[1];
  } else if ((m = d.match(/IMPS-\d+-([^-]+)-/))) {
    name = m[1];
  } else if ((m = d.match(/(?:NEFT|RTGS)(?: CR| DR)?-[A-Z0-9]+-([^-]+)/))) {
    name = m[1];
  } else if ((m = d.match(/^N?ACH\/([^/]+)/))) {
    name = m[1].replace(/\d{6,}/g, '');
  } else if ((m = d.match(/(?:ACH|NACH)[ /]?(?:D|C|DR|CR)?[- /]+([A-Z][A-Z0-9 .&]+)/))) {
    name = m[1];
  } else if ((m = d.match(/CMS\/\s*(?:CMS\d+\/)?([^/]+)/))) {
    name = m[1];
  } else if (/^RFX\b/.test(d)) {
    name = 'Foreign remittance';
  } else if ((m = d.match(/^(?:POS|ECOM|VPS|IPS)\s*(?:[0-9X*]{8,}\s*)?(.+)/))) {
    name = m[1];
  } else {
    name = d;
  }
  name = name
    .replace(/\b[A-Z]*\d{6,}[A-Z0-9]*\b/g, ' ') // reference numbers
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[-/ ]+|[-/ ]+$/g, '');
  if (!name) name = d.split(/[-/ ]/)[0] || d;
  const key = nameKey(name) || nameKey(vpa ?? d);
  return { name: title(name).slice(0, 40), key, vpa: vpa?.toLowerCase(), method };
}

export interface Context {
  settings: Settings;
  accounts: Account[];
  rules: LearnedRule[];
}

interface Result {
  kind: Kind; category: string; source: CategorySource; excluded?: boolean; title?: string;
  /** A match on a merchant name only, which the AI reader may overrule. */
  weak?: boolean;
}

function matchRule(rules: Rule[], d: string, dir: string): Rule | undefined {
  return rules.find((r) => (!r.dir || r.dir === dir) && r.re.test(d));
}

function containsName(d: string, name: string): boolean {
  const n = norm(name).replace(/[^A-Z ]/g, '').trim();
  if (n.length < 3) return false;
  // ICICI truncates to 10 characters; HDFC sometimes drops spaces.
  return d.includes(n) || d.includes(n.slice(0, 10)) || d.replace(/ /g, '').includes(n.replace(/ /g, ''));
}

function isOwnTransfer(d: string, ctx: Context, accountId?: string): boolean {
  if (!TRANSFER_METHOD.test(d) || COMPANY_MARKERS.test(d)) return false;
  const names = [...ctx.settings.ownNames, ...ctx.settings.familyNames,
    ...ctx.accounts.map((a) => a.holderName ?? '')].filter(Boolean);
  if (names.some((n) => containsName(d, n))) return true;
  return ctx.accounts.some((a) => {
    if (a.id === accountId) return false;
    const last4 = a.number.replace(/\D/g, '').slice(-4);
    return last4.length === 4 && new RegExp(`(?:X|\\*|\\d)${last4}\\b`).test(d);
  });
}

function looksLikePerson(merchant: Merchant, d: string): boolean {
  if (merchant.method !== 'UPI' && merchant.method !== 'IMPS') return false;
  const vpa = (merchant.vpa ?? '').toUpperCase();
  if (MERCHANT_MARKERS.test(vpa) || MERCHANT_MARKERS.test(d) || COMPANY_MARKERS.test(d)) return false;
  if (/^\d{10}@/.test(vpa)) return true;
  // Person names are one to three alphabetic words.
  return /^[A-Z]+( [A-Z]+){0,2}$/.test(norm(merchant.name));
}

export function categorize(t: ParsedTxn, merchant: Merchant, ctx: Context, accountId?: string): Result {
  const d = norm(t.description);
  const learned = ctx.rules.find((r) => r.key === merchant.key && (!r.direction || r.direction === t.direction));
  if (learned) return { kind: learned.kind, category: learned.category, source: 'learned', excluded: learned.excluded, title: learned.title };

  const pr = matchRule(PRIORITY_RULES, d, t.direction);
  if (pr) return { kind: pr.kind, category: pr.category, source: 'rule' };

  if (isOwnTransfer(d, ctx, accountId)) return { kind: 'transfer', category: 'Self Transfer', source: 'self' };

  const mr = matchRule(MERCHANT_RULES, d, 'debit');
  if (mr) {
    if (t.direction === 'debit') return { kind: mr.kind, category: mr.category, source: 'rule', weak: true };
    return { kind: 'income', category: 'Refund & Cashback', source: 'rule', weak: true };
  }

  if (looksLikePerson(merchant, d)) {
    return t.direction === 'debit'
      ? { kind: 'spend', category: 'Payments to People', source: 'default' }
      : { kind: 'income', category: 'Received from People', source: 'default' };
  }
  return t.direction === 'debit'
    ? { kind: 'spend', category: UNCATEGORISED, source: 'default' }
    : { kind: 'income', category: UNCATEGORISED, source: 'default' };
}

/** Categories that a cross-account match may upgrade to a self transfer. */
const PAIRABLE = new Set([UNCATEGORISED, 'Payments to People', 'Received from People', 'Self Transfer']);
const WEAK_SOURCES = new Set<CategorySource>(['default', 'self', 'pair', 'rule']);

/**
 * Money leaving one of your accounts and arriving in another (same amount,
 * within 3 days) is a self transfer, whatever the narration says.
 */
export function pairTransfers(txns: Txn[]): void {
  const DAY = 86400000;
  const open = txns.filter((t) => !t.pairId && WEAK_SOURCES.has(t.source) && PAIRABLE.has(t.category));
  const credits = open.filter((t) => t.direction === 'credit');
  for (const out of open.filter((t) => t.direction === 'debit')) {
    const outDate = Date.parse(out.date);
    const match = credits.find((c) => !c.pairId && c.accountId !== out.accountId && c.amount === out.amount &&
      Math.abs(Date.parse(c.date) - outDate) <= 3 * DAY &&
      // Two payments to/from other people that happen to match aren't enough.
      [c.category, out.category].some((cat) => cat === 'Self Transfer' || cat === UNCATEGORISED));
    if (!match) continue;
    for (const [a, b] of [[out, match], [match, out]] as const) {
      a.pairId = b.id;
      a.kind = 'transfer';
      a.category = 'Self Transfer';
      if (a.source !== 'self') a.source = 'pair';
    }
  }
}
