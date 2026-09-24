export type Kind = 'spend' | 'income' | 'investment' | 'transfer' | 'cc_bill';
export type Direction = 'debit' | 'credit';

/** Where a transaction's category came from, strongest last. */
export type CategorySource = 'default' | 'rule' | 'self' | 'pair' | 'ai' | 'learned' | 'manual';

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
  importedAt: number;
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
  createdAt: number;
}

export interface Settings {
  ownNames: string[];
  /** People whose transfers count as self transfers (e.g. spouse). */
  familyNames: string[];
  aiApiKey?: string;
  aiModel: string;
}

export interface AppState {
  accounts: Account[];
  txns: Txn[];
  rules: LearnedRule[];
  settings: Settings;
}
