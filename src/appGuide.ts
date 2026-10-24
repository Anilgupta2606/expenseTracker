import readme from '../README.md?raw';

/** A question about the app itself - where something is, how to do something - not about the transactions. */
export const ABOUT_APP = /\b(where (is|are|can|do)|how (do|can|to)|which (button|tab|page|screen|menu)|button|tab\b|screen|menu|click|i can'?t find|cannot find|settings|what does (the|this) .{1,30} (do|mean|show)|in the app|how does (this|the) app)\b/i;

const clean = (s: string | null | undefined) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** The app guide for the Assistant: the pages (read from the navigation), the buttons on the page open now (with their
 *  tooltips), and the README's user parts - so a new page or button is known the day it is added. */
export function appGuide(doc: Document = document): string {
  const nav = [...doc.querySelectorAll('.tabbar a span')].map((e) => clean(e.textContent)).filter(Boolean);
  const view = doc.getElementById('view');
  const here = view ? clean(view.querySelector('h1')?.textContent) : '';
  const buttons = view ? [...new Set([...view.querySelectorAll('button, a.btn, label')].map((b) => {
    const t = clean(b.textContent).slice(0, 50), tip = clean(b.getAttribute('title') ?? b.getAttribute('aria-label'));
    return t + (tip && tip !== t ? ` (${tip.slice(0, 90)})` : '');
  }).filter(Boolean))].slice(0, 40) : [];
  const parts = readme.split(/\n(?=## )/).filter((p) => !/^## (Hosting|Development)/.test(p));
  return `Pages: ${nav.join(', ')} - the left sidebar on a wide screen, the bottom bar on a phone. Settings (sign-in, AI assistants, sync, backup, what counts) is in the profile menu: the round avatar. ⌂ Money Home goes back to all your apps.
${here ? `The page open now: ${here}; its buttons: ${buttons.join('; ')}` : ''}

${parts.join('\n')}`.slice(0, 9000);
}
