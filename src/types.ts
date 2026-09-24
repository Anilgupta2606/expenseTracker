export type Kind = 'spend' | 'income' | 'investment' | 'transfer' | 'cc_bill' | 'ignore';
export type Direction = 'debit' | 'credit';

/** Where a transaction's category came from, strongest last. */
export type CategorySource = 'default' | 'rule' | 'self' | 'pair' | 'learned' | 'manual';

export interface ParsedTxn {
  date: string; // YYYY-MM-DD
  description: string;
  amount: number; // always positive
  direction: Direction;
  balance?: number;
  ref?: string;
}

export interface StatementMeta {
  bank: string; // 'HDFC' | 'ICICI' | 'SBI' | ... | 'Unknown'
  accountNumber?: string;
  holderName?: string;
}

export interface ParseResult {
  meta: StatementMeta;
  txns: ParsedTxn[];
  /** Rows where closing balance didn't follow from the previous row. */
  balanceMismatches: number;
  warnings: string[];
}

export interface Txn extends ParsedTxn {
  id: string;
  accountId: string;
  kind: Kind;
  category: string;
  source: CategorySource;
  merchantKey: string;
  merchantName: string;
  /** Linked self-transfer on another account, if matched. */
  pairId?: string;
  note?: string;
  /** Left out of every total when true (the "Counted" checkbox is unticked). */
  excluded?: boolean;
  importedAt: number;
  /** The uploaded statement this row came from. */
  importId: string;
}

export interface Account {
  id: string; // e.g. HDFC-1234
  bank: string;
  number: string;
  holderName?: string;
}

/** A rule learned from the user's corrections. */
export interface LearnedRule {
  key: string; // merchant key it applies to
  kind: Kind;
  category: string;
  /** Spend/income rules only apply to the direction they were learned on. */
  direction?: Direction;
  excluded?: boolean;
  createdAt: number;
}

export interface Settings {
  ownNames: string[];
  /** People whose transfers count as self transfers (e.g. spouse). */
  familyNames: string[];
}

/** Your own numbers for a month. Months without one inherit the latest earlier month. */
export interface MonthPlan {
  income: number;
  expectedSpend: number;
  expectedInvestment: number;
}

/** One uploaded statement file. */
export interface StatementImport {
  id: string;
  fileName: string;
  accountId: string;
  from: string; // YYYY-MM-DD
  to: string;
  importedAt: number;
  /** Rows found in the file and how many broke the running balance. */
  rows?: number;
  balanceMismatches?: number;
  /** The original file is kept on this device for rescans. */
  hasFile?: boolean;
  rescannedAt?: number;
}

export interface AppState {
  accounts: Account[];
  txns: Txn[];
  rules: LearnedRule[];
  settings: Settings;
  /** Keyed by YYYY-MM. */
  plans: Record<string, MonthPlan>;
  imports: StatementImport[];
  /** Sign-in details; missing means the default admin / admin. */
  auth?: { username: string; passwordHash: string };
}
