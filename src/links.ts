import type { Settings } from './types';

/** Your "16-Year Ledger" investment plan (a private claude.ai page; it opens only when you are signed in there). */
export const DEFAULT_PLAN_LINK = 'https://claude.ai/code/artifact/6d92f9b1-f2cc-42eb-88d5-901bc6a07051';

/** The investment plan link to show, or null when you cleared it in Settings. */
export function planLink(settings: Settings): string | null {
  const v = settings.planLink ?? DEFAULT_PLAN_LINK;
  return /^https:\/\//i.test(v.trim()) ? v.trim() : null;
}
