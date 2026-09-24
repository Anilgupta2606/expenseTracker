import type { Kind } from '../types';

export const KIND_LABEL: Record<Kind, string> = {
  spend: 'Spend',
  income: 'Income',
  investment: 'Investment',
  transfer: 'Self transfer',
  cc_bill: 'Card bill',
  ignore: 'Not counted',
};

export const CATEGORIES: Record<Kind, string[]> = {
  spend: [
    'Food & Dining', 'Groceries', 'Shopping', 'Transport', 'Fuel', 'Travel',
    'Bills & Utilities', 'Mobile & Internet', 'Rent & Housing', 'Health',
    'Education', 'Entertainment', 'Subscriptions', 'Personal Care', 'Insurance',
    'EMI & Loans', 'Taxes', 'Bank Charges', 'Cash Withdrawal', 'Payments to People',
    'Family', 'Gifts & Donations', 'Uncategorised',
  ],
  income: [
    'Salary', 'Reimbursement', 'Interest', 'Dividend', 'Refund & Cashback',
    'Received from People', 'Uncategorised',
  ],
  investment: [
    'Mutual Funds', 'Stocks', 'Gold', 'US Stocks / Foreign', 'Fixed Deposit',
    'PPF / NPS / EPF', 'Other Investment',
  ],
  transfer: ['Self Transfer'],
  cc_bill: ['Credit Card Bill'],
  ignore: ['Not counted'],
};

export const UNCATEGORISED = 'Uncategorised';

export function isValidCategory(kind: Kind, category: string): boolean {
  return CATEGORIES[kind]?.includes(category) ?? false;
}

/** Category to use when a transaction is moved to another type by hand. */
export function defaultCategory(kind: Kind, current: string): string {
  if (CATEGORIES[kind].includes(current)) return current;
  if (kind === 'investment') return 'Other Investment';
  return CATEGORIES[kind].includes(UNCATEGORISED) ? UNCATEGORISED : CATEGORIES[kind][0];
}
