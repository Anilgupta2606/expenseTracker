import type { Settings } from './types';

/** Your "16-Year Ledger" investment plan, on this same site (it moved from a claude.ai page). */
export const DEFAULT_PLAN_LINK = 'https://anilgupta2606.github.io/InvestmentPlan/';
/** The plan's old claude.ai address: a link still saved as that opens the new site. */
const OLD_PLAN_LINK = /^https:\/\/claude\.ai\/code\/artifact\/6d92f9b1-/i;

/** The investment plan link to show, or null when you cleared it in Settings. */
export function planLink(settings: Settings): string | null {
  const saved = settings.planLink;
  const v = saved === undefined || OLD_PLAN_LINK.test(saved.trim()) ? DEFAULT_PLAN_LINK : saved;
  return /^https:\/\//i.test(v.trim()) ? v.trim() : null;
}

/**
 * The link the profile menu uses: a small page on this site that moves on to
 * the plan by itself. On iPhone a tap straight onto a claude.ai link is handed
 * to the Claude app; stepping through this page usually keeps it in the
 * browser tab. Other links are opened directly.
 */
export function planOpener(link: string): string {
  return /^https:\/\/claude\.ai\//i.test(link) ? `./open-plan.html#${encodeURIComponent(link)}` : link;
}
