import type { AppState } from './types';
import { hash } from './parse/util';

export const DEFAULT_USERNAME = 'admin';
export const DEFAULT_PASSWORD = 'admin';
const SESSION_KEY = 'expense-tracker-signed-in';
let memorySession = false;

/** SHA-256 where available (secure pages), otherwise the app's simple hash. */
export async function hashPassword(username: string, password: string): Promise<string> {
  const input = `expense-tracker|${username.toLowerCase()}|${password}`;
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return `h:${hash(input)}`;
  }
}

export async function checkLogin(state: AppState, username: string, password: string): Promise<boolean> {
  const u = username.trim();
  if (!state.auth) return u.toLowerCase() === DEFAULT_USERNAME && password === DEFAULT_PASSWORD;
  return u.toLowerCase() === state.auth.username.toLowerCase() && (await hashPassword(u, password)) === state.auth.passwordHash;
}

export async function withCredentials(state: AppState, username: string, password: string): Promise<AppState> {
  const u = username.trim();
  return { ...state, auth: { username: u, passwordHash: await hashPassword(u, password) } };
}

export function isSignedIn(): boolean {
  try {
    return sessionStorage.getItem(SESSION_KEY) === '1' || memorySession;
  } catch {
    return memorySession;
  }
}

export function setSignedIn(on: boolean) {
  memorySession = on;
  try {
    if (on) sessionStorage.setItem(SESSION_KEY, '1');
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // Private mode: the in-memory flag still works for this visit.
  }
}

export function usernameOf(state: AppState): string {
  return state.auth?.username ?? DEFAULT_USERNAME;
}
