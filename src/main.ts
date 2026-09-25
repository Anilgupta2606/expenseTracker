import './style.css';
import { registerSW } from 'virtual:pwa-register';
import { loadFile, loadState } from './store';
import { app, onRender, toast, update } from './ui/app';
import { renderDashboard } from './ui/dashboard';
import { renderImport } from './ui/importView';
import { renderSettings } from './ui/settings';
import { renderTransactions } from './ui/transactions';
import { renderAssistant } from './ui/assistant';
import { isSignedIn, setSignedIn, usernameOf } from './auth';
import { LOGO, renderLogin } from './ui/login';
import { esc } from './ui/format';
import { applyTheme, getTheme, setTheme, type Theme } from './theme';
import { planLink, planOpener } from './links';

applyTheme();
const initialsOf = (name: string) => (name.trim().slice(0, 2) || '?').toUpperCase();

const ICONS = {
  home: '<path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  upload: '<path d="M12 16V4m0 0l-5 5m5-5l5 5M4 20h16"/>',
  spark: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
};

const ROUTES: { hash: string; label: string; icon: keyof typeof ICONS; view: (root: HTMLElement) => void; inMenu?: boolean }[] = [
  { hash: '#overview', label: 'Overview', icon: 'home', view: renderDashboard },
  { hash: '#txns', label: 'Transactions', icon: 'list', view: renderTransactions },
  { hash: '#upload', label: 'Upload', icon: 'upload', view: renderImport },
  { hash: '#assistant', label: 'Assistant', icon: 'spark', view: renderAssistant },
  // Settings lives in the profile menu, not the tab bar.
  { hash: '#settings', label: 'Settings', icon: 'gear', view: renderSettings, inMenu: true },
];

const root = document.getElementById('app')!;
let view: HTMLElement | null = null;

function mountShell() {
  root.innerHTML = `<div class="shell">
    <nav class="sidebar" aria-label="Main">
      <div class="side-brand">${LOGO}<span class="brand-name">Expense Tracker</span></div>
      <div class="tabbar">${ROUTES.filter((r) => !r.inMenu).map((r) => `<a href="${r.hash}" data-hash="${r.hash}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[r.icon]}</svg><span>${r.label}</span></a>`).join('')}</div>
      <div class="side-user">${profileButton('side')}</div>
    </nav>
    <div class="content">
      <header class="appbar">${LOGO}<span class="brand-name">Expense Tracker</span>${profileButton('top')}</header>
      <main class="app" id="view"></main>
    </div>
  </div>`;
  view = document.getElementById('view')!;
  root.querySelectorAll<HTMLElement>('[data-profile]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleMenu(b);
  }));
}

/** The round avatar that opens the profile menu. */
function profileButton(where: 'top' | 'side'): string {
  return `<button class="profile-btn ${where}" data-profile aria-haspopup="menu" aria-expanded="false" aria-label="Profile, settings and theme">
    <span class="avatar-round" data-initials></span>${where === 'side' ? '<span class="grow"><span class="who" data-who></span><span class="tiny">Settings &amp; theme</span></span>' : ''}
  </button>`;
}

const THEMES: { value: Theme; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

function closeMenu() {
  document.querySelector('.profile-menu')?.remove();
  document.querySelectorAll('[data-profile]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
}

function toggleMenu(anchor: HTMLElement) {
  const open = document.querySelector('.profile-menu');
  closeMenu();
  if (open) return;
  const name = usernameOf(app.state);
  const menu = document.createElement('div');
  menu.className = 'profile-menu';
  menu.setAttribute('role', 'menu');
  const drawMenu = () => {
    const theme = getTheme();
    const link = planLink(app.state.settings);
    menu.innerHTML = `
      <div class="pm-head"><span class="avatar-round">${esc(initialsOf(name))}</span><span><span class="tiny">Signed in as</span><strong style="display:block">${esc(name)}</strong></span></div>
      <a href="#settings" class="pm-item" role="menuitem" data-pm-settings>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS.gear}</svg>Settings</a>
      ${link ? `<a href="${esc(planOpener(link))}" target="_blank" rel="noopener" class="pm-item" role="menuitem" data-pm-plan>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 17l6-6 4 4 8-8M15 7h6v6"/></svg>Investment plan<span class="pm-ext" aria-label="opens in a new tab">↗</span></a>` : ''}
      <div class="pm-label">Theme</div>
      <div class="seg-toggle pm-theme" role="group" aria-label="Theme">${THEMES.map((t) => `<button data-theme-pick="${t.value}" class="${theme === t.value ? 'on' : ''}" aria-pressed="${theme === t.value}">${t.label}</button>`).join('')}</div>
      <button class="pm-item danger" role="menuitem" data-pm-signout>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 17l5-5-5-5M20 12H9M12 21H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h7"/></svg>Sign out</button>`;
    menu.querySelector('[data-pm-settings]')!.addEventListener('click', closeMenu);
    menu.querySelector('[data-pm-plan]')?.addEventListener('click', closeMenu);
    menu.querySelector('[data-pm-signout]')!.addEventListener('click', () => { closeMenu(); setSignedIn(false); render(); });
    menu.querySelectorAll<HTMLElement>('[data-theme-pick]').forEach((b) => b.addEventListener('click', () => {
      setTheme(b.dataset.themePick as Theme);
      drawMenu();
      // Charts read colours when drawn.
      render();
    }));
  };
  drawMenu();
  menu.addEventListener('click', (e) => e.stopPropagation());
  // Open below the top-bar avatar, or above the sidebar one.
  const r = anchor.getBoundingClientRect();
  if (anchor.classList.contains('side')) {
    menu.style.left = `${r.left}px`;
    menu.style.bottom = `${window.innerHeight - r.top + 8}px`;
  } else {
    menu.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
    menu.style.top = `${r.bottom + 8}px`;
  }
  document.body.append(menu);
  anchor.setAttribute('aria-expanded', 'true');
  menu.querySelector<HTMLElement>('[data-pm-settings]')?.focus();
}

document.addEventListener('click', closeMenu);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
window.addEventListener('resize', closeMenu);
window.addEventListener('hashchange', closeMenu);

let lastHash = '';
function render() {
  if (!isSignedIn()) {
    view = null;
    document.body.classList.add('signed-out');
    renderLogin(root, () => { document.body.classList.remove('signed-out'); render(); });
    return;
  }
  document.body.classList.remove('signed-out');
  if (!view) mountShell();
  const name = usernameOf(app.state);
  root.querySelectorAll('[data-who]').forEach((el) => { el.textContent = name; });
  root.querySelectorAll('[data-initials]').forEach((el) => { el.textContent = initialsOf(name); });
  const hash = ROUTES.some((r) => r.hash === location.hash) ? location.hash : '#overview';
  const route = ROUTES.find((r) => r.hash === hash)!;
  document.querySelectorAll<HTMLElement>('.tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.hash === hash));
  document.querySelectorAll<HTMLElement>('[data-profile]').forEach((b) => b.classList.toggle('active', hash === '#settings'));
  const scroll = window.scrollY;
  route.view(view!);
  // Keep the scroll position when re-rendering the same screen.
  window.scrollTo(0, hash === lastHash ? scroll : 0);
  lastHash = hash;
}

onRender(render);
window.addEventListener('hashchange', render);

loadState().then((state) => {
  app.state = state;
  render();
  void recheckBanks();
});

/**
 * Older versions could name the wrong bank (e.g. an ICICI statement full of
 * "HDFC Bank" UPI remarks). Once per account, re-read the bank from a stored
 * statement and fix the label.
 */
async function recheckBanks() {
  const { bankOfFile } = await import('./importer');
  for (const account of app.state.accounts.filter((a) => !a.bankChecked)) {
    const rec = app.state.imports.find((i) => i.accountId === account.id && i.hasFile);
    let bank: string | undefined;
    try {
      const file = rec ? await loadFile(rec.id) : undefined;
      if (file) bank = await bankOfFile(file.data, file.name, file.type);
    } catch { /* unreadable (e.g. password protected): leave the label */ }
    const fixed = bank && bank !== 'Unknown' && bank !== account.bank ? bank : undefined;
    await update((s) => ({ ...s, accounts: s.accounts.map((a) => (a.id === account.id ? { ...a, bankChecked: true, ...(fixed ? { bank: fixed } : {}) } : a)) }));
    if (fixed) toast(`Account ••${account.number.slice(-4)} is ${fixed}, not ${account.bank}; fixed.`);
  }
}

// Offline support where the browser allows a service worker (not inside an embedded frame).
if ('serviceWorker' in navigator && window.top === window) {
  try {
    registerSW({
      immediate: true,
      // Look for a new version when the app is reopened and every hour, not only on a cold start.
      onRegisteredSW(_url, reg) {
        if (!reg) return;
        const check = () => { if (navigator.onLine) void reg.update().catch(() => {}); };
        setInterval(check, 60 * 60 * 1000);
        document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
      },
    });
  } catch {
    // Works without offline caching.
  }
}
