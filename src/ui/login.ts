import { checkLogin, setSignedIn } from '../auth';
import { app } from './app';

export const LOGO = `<svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="var(--accent)"/><rect x="7" y="18" width="4" height="7" rx="1.5" fill="#fff" opacity=".7"/><rect x="14" y="13" width="4" height="12" rx="1.5" fill="#fff" opacity=".85"/><rect x="21" y="8" width="4" height="17" rx="1.5" fill="#fff"/></svg>`;

export function renderLogin(root: HTMLElement, onSuccess: () => void) {
  root.innerHTML = `<div class="login-screen">
    <form class="login-card" id="login-form" novalidate>
      <div class="login-brand">${LOGO}<div><div class="brand-name">Expense Tracker</div><div class="tiny">Statements · Budgets · Savings</div></div></div>
      <h1 class="login-title">Sign in</h1>
      <p class="small muted" style="margin:-6px 0 18px">Your data stays on this device.</p>
      <label class="field"><span>Username</span>
        <input type="text" id="login-user" autocomplete="username" autocapitalize="none" spellcheck="false" required></label>
      <label class="field"><span>Password</span>
        <div class="pw-wrap"><input type="password" id="login-pass" autocomplete="current-password" required>
        <button type="button" class="pw-toggle" id="pw-toggle" aria-label="Show password">Show</button></div></label>
      <p class="small bad" id="login-error" role="alert" hidden></p>
      <button class="btn primary block" type="submit" id="login-submit">Sign in</button>
      <p class="tiny" style="margin:14px 0 0;text-align:center">First time? Use <strong>admin</strong> / <strong>admin</strong>, then change it in Settings.</p>
    </form>
  </div>`;
  const form = root.querySelector<HTMLFormElement>('#login-form')!;
  const user = root.querySelector<HTMLInputElement>('#login-user')!;
  const pass = root.querySelector<HTMLInputElement>('#login-pass')!;
  const error = root.querySelector<HTMLElement>('#login-error')!;
  const toggle = root.querySelector<HTMLButtonElement>('#pw-toggle')!;
  toggle.addEventListener('click', () => {
    const show = pass.type === 'password';
    pass.type = show ? 'text' : 'password';
    toggle.textContent = show ? 'Hide' : 'Show';
    toggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!user.value.trim() || !pass.value) {
      error.textContent = 'Enter your username and password.';
      error.hidden = false;
      return;
    }
    if (await checkLogin(app.state, user.value, pass.value)) {
      setSignedIn(true);
      onSuccess();
    } else {
      error.textContent = 'Username or password is incorrect.';
      error.hidden = false;
      pass.value = '';
      pass.focus();
    }
  });
  user.focus();
}
