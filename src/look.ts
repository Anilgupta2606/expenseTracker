/** The new design or the classic one; remembered on this device. */
export type Look = 'new' | 'classic';

const KEY = 'et-look';

export function getLook(): Look {
  try {
    return localStorage.getItem(KEY) === 'classic' ? 'classic' : 'new';
  } catch {
    return 'new';
  }
}

export function applyLook(look = getLook()) {
  document.documentElement.setAttribute('data-look', look);
}

export function setLook(look: Look) {
  try { localStorage.setItem(KEY, look); } catch { /* private mode: applies for this visit only */ }
  applyLook(look);
}
