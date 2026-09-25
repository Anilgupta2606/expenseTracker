/** Light, dark or follow the phone; remembered on this device. */
export type Theme = 'system' | 'light' | 'dark';

const KEY = 'theme';

export function getTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(theme = getTheme()) {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  // The browser bar colour follows too.
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((m) => {
    const dark = m.media.includes('dark');
    m.content = theme === 'system' ? (dark ? '#161b22' : '#ffffff') : theme === 'dark' ? '#161b22' : '#ffffff';
  });
}

export function setTheme(theme: Theme) {
  try { localStorage.setItem(KEY, theme); } catch { /* private mode: applies for this visit only */ }
  applyTheme(theme);
}
