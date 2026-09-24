import './style.css';
import { registerSW } from 'virtual:pwa-register';
import { loadState } from './store';
import { app, onRender } from './ui/app';
import { renderDashboard } from './ui/dashboard';
import { renderImport } from './ui/importView';
import { renderSettings } from './ui/settings';
import { renderTransactions } from './ui/transactions';
import { isSignedIn, setSignedIn, usernameOf } from './auth';
import { LOGO, renderLogin } from './ui/login';

const ICONS = {
  home: '<path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  upload: '<path d="M12 16V4m0 0l-5 5m5-5l5 5M4 20h16"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
};

const ROUTES: { hash: string; label: string; icon: keyof typeof ICONS; view: (root: HTMLElement) => void }[] = [
  { hash: '#overview', label: 'Overview', icon: 'home', view: renderDashboard },
  { hash: '#txns', label: 'Transactions', icon: 'list', view: renderTransactions },
  { hash: '#upload', label: 'Upload', icon: 'upload', view: renderImport },
  { hash: '#settings', label: 'Settings', icon: 'gear', view: renderSettings },
];

const root = document.getElementById('app')!;
let view: HTMLElement | null = null;

function mountShell() {
  root.innerHTML = `<div class="shell">
    <nav class="sidebar" aria-label="Main">
      <div class="side-brand">${LOGO}<span class="brand-name">Expense Tracker</span></div>
      <div class="tabbar">${ROUTES.map((r) => `<a href="${r.hash}" data-hash="${r.hash}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[r.icon]}</svg><span>${r.label}</span></a>`).join('')}</div>
      <div class="side-user"><span class="tiny">Signed in as <strong id="who"></strong></span><button class="link-btn" data-signout>Sign out</button></div>
    </nav>
    <div class="content">
      <header class="appbar">${LOGO}<span class="brand-name">Expense Tracker</span><button class="link-btn" data-signout aria-label="Sign out">Sign out</button></header>
      <main class="app" id="view"></main>
    </div>
  </div>`;
  view = document.getElementById('view')!;
  root.querySelectorAll('[data-signout]').forEach((b) => b.addEventListener('click', () => {
    setSignedIn(false);
    render();
  }));
}

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
  root.querySelector('#who')!.textContent = usernameOf(app.state);
  const hash = ROUTES.some((r) => r.hash === location.hash) ? location.hash : '#overview';
  const route = ROUTES.find((r) => r.hash === hash)!;
  document.querySelectorAll<HTMLElement>('.tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.hash === hash));
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
});

// Offline support where the browser allows a service worker (not inside an embedded frame).
if ('serviceWorker' in navigator && window.top === window) {
  try {
    registerSW({ immediate: true });
  } catch {
    // Works without offline caching.
  }
}
