import type { Kind } from '../types';

export const KIND_LABEL: Record<Kind, string> = {
  spend: 'Spend',
  income: 'Income',
  investment: 'Investment',
  transfer: 'Self transfer',
  cc_bill: 'Card bill',
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
};

export const UNCATEGORISED = 'Uncategorised';

export function isValidCategory(kind: Kind, category: string): boolean {
  return CATEGORIES[kind]?.includes(category) ?? false;
}
