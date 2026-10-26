/**
 * The new design's chat dock: a floating ✦ Ask button that opens a panel with both assistants —
 * this app's Assistant (answers and changes from your statements) and Cygnus AI (the site's AI, which
 * sees every app and the web). Cygnus runs in its own page, embedded here.
 */
import { renderAssistant } from './assistant';

type Tab = 'et' | 'cy';
const CYGNUS = '/ai/chat/';
let tab: Tab = 'et';
let open = false;
let fab: HTMLButtonElement | null = null;
let panel: HTMLElement | null = null;

const ICON = {
  spark: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
};
const svg = (d: string) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

function build() {
  if (fab) return;
  fab = document.createElement('button');
  fab.className = 'nx-fab';
  fab.setAttribute('aria-label', 'Ask the Assistant or Cygnus AI');
  fab.innerHTML = `${svg(ICON.spark)}<span>Ask</span>`;
  fab.addEventListener('click', () => openDock());
  panel = document.createElement('div');
  panel.className = 'nx-dock';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Ask');
  panel.innerHTML = `<header><div class="nx-dh"><b>✦ Ask</b><button data-close aria-label="Close">${svg(ICON.x)}</button></div>
    <div class="nx-tabs" role="tablist"><button role="tab" data-tab="et">Expense Assistant</button><button role="tab" data-tab="cy"><i>✦</i> Cygnus AI</button></div></header>
    <div class="nx-dbody" data-body="et"></div>
    <div class="nx-dbody nx-cy" data-body="cy" hidden><div class="nx-cyframe"></div>
      <p class="nx-cyfoot">Cygnus sees your apps and the web. <a href="${CYGNUS}" target="_blank" rel="noopener">Open full Cygnus ↗</a></p></div>`;
  panel.querySelector('[data-close]')!.addEventListener('click', closeDock);
  panel.querySelectorAll<HTMLElement>('[data-tab]').forEach((b) => b.addEventListener('click', () => { tab = b.dataset.tab as Tab; draw(); }));
  document.body.append(fab, panel);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open) closeDock(); });
}

function draw() {
  if (!panel) return;
  panel.querySelectorAll<HTMLElement>('[data-tab]').forEach((b) => { b.classList.toggle('on', b.dataset.tab === tab); b.setAttribute('aria-selected', String(b.dataset.tab === tab)); });
  const et = panel.querySelector<HTMLElement>('[data-body="et"]')!, cy = panel.querySelector<HTMLElement>('[data-body="cy"]')!;
  et.hidden = tab !== 'et';
  cy.hidden = tab !== 'cy';
  if (tab === 'et') renderAssistant(et);
  else {
    // the Cygnus page is loaded the first time its tab is opened, then kept (with its conversation)
    const box = cy.querySelector('.nx-cyframe')!;
    if (!box.querySelector('iframe')) box.innerHTML = `<iframe src="${CYGNUS}" title="Cygnus AI" allow="clipboard-write; microphone"></iframe>`;
  }
}

export function openDock(which?: Tab) {
  build();
  if (which) tab = which;
  open = true;
  draw();
  panel!.classList.add('open');
  fab!.classList.add('hide');
  setTimeout(() => panel?.querySelector<HTMLInputElement>('#as-q')?.focus(), 250);
}

export function closeDock() {
  open = false;
  panel?.classList.remove('open');
  fab?.classList.remove('hide');
}

/**
 * The new design has the dock (the classic one does not); it is hidden on the Assistant's own screen, and
 * redrawn when the app re-renders so the Assistant's answers appear in it.
 */
export function syncDock(enabled: boolean, visible: boolean) {
  if (!enabled) {
    closeDock();
    fab?.remove(); panel?.remove();
    fab = null; panel = null;
    return;
  }
  build();
  fab!.classList.toggle('gone', !visible);
  if (!visible) closeDock();
  else if (open && tab === 'et') draw();
}
