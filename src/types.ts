export type Kind = 'spend' | 'income' | 'investment' | 'transfer' | 'cc_bill' | 'ignore';
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
  /** The AI reader's cleaned-up payee and category for this row. */
  hint?: AiHint;
}

export interface AiHint {
  payee: string;
  kind: Kind;
  category: string;
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
  /** Which reader produced the rows. */
  reader?: 'ai' | 'local';
  /** Titles and categories were cleaned up by the AI. */
  aiTitles?: boolean;
}

export interface Txn extends ParsedTxn {
  id: string;
  accountId: string;
  kind: Kind;
  category: string;
  source: CategorySource;
  merchantKey: string;
  merchantName: string;
  /** Who set the title shown (merchantName): the AI or you. Unset means it is worked out from the narration. */
  titleSet?: 'ai' | 'manual';
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
  /** The bank was re-read from the stored statement (done once, to fix labels from older versions). */
  bankChecked?: boolean;
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
  /** A title you gave this payee. */
  title?: string;
  createdAt: number;
}

export interface Settings {
  ownNames: string[];
  /** People whose transfers count as self transfers (e.g. spouse). */
  familyNames: string[];
  /** Free Google Gemini key for the optional AI check (stored on this device only). */
  geminiKey?: string;
  /** Your investment plan page, opened from the profile menu. Empty string hides the link. */
  planLink?: string;
  /** @deprecated The app picks the model; kept so old saved data still loads. */
  geminiModel?: string;
  /** Whether each category counts in totals, keyed "kind:Category". Missing means the default. */
  categoryCounted?: Record<string, boolean>;
  /** Same-amount pairs across accounts you said are not a self transfer ("idA|idB"). */
  notPairs?: string[];
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
  /** Read by the AI (checked against the running balance) or by the on-device reader. */
  reader?: 'ai' | 'local';
  /** Titles and categories were cleaned up by the AI. */
  aiTitles?: boolean;
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
