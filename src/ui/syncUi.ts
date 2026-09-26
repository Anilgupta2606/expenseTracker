import { forgetSync, markLocalChange, saveSyncConfig, syncConfig, syncNow, type SyncResult } from '../sync';
import { app, onChange, render, toast, update } from './app';
import { esc } from './format';

const MESSAGES: Record<SyncResult, string> = {
  pushed: 'Synced: this device’s data is saved for your other devices.',
  pulled: 'Synced: brought in changes from your other device.',
  merged: 'Synced: combined the changes from both devices.',
  unchanged: 'Already in sync.',
};

let busy = false;
let timer: number | undefined;

/** Runs a sync; quiet ones only speak up when something came in or went wrong. */
export async function runSync(quiet = false): Promise<void> {
  if (!syncConfig() || busy) return;
  if (!navigator.onLine) { if (!quiet) toast('You’re offline. Sync will run when you’re back.'); return; }
  busy = true;
  render();
  try {
    const result = await syncNow(() => app.state, (s) => update(() => s, { fromSync: true }));
    if (!quiet || result === 'pulled' || result === 'merged') toast(MESSAGES[result]);
  } catch (e) {
    toast(`Sync failed: ${(e as Error).message}`);
  } finally {
    busy = false;
    render();
  }
}

/** Every local change is noted and pushed a little later, so a burst of edits goes up once. */
export function startSync() {
  onChange(() => {
    if (!syncConfig()) return;
    markLocalChange();
    clearTimeout(timer);
    timer = window.setTimeout(() => void runSync(true), 15000);
  });
  let lastCheck = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || Date.now() - lastCheck < 60000) return;
    lastCheck = Date.now();
    void runSync(true);
  });
  window.addEventListener('online', () => void runSync(true));
}

function ago(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ms).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

export function syncCard(): string {
  const cfg = syncConfig();
  if (cfg) {
    return `<div class="card" id="sync-card">
      <h2>Sync between devices</h2>
      <p class="small muted" style="margin-top:-4px">On. Encrypted with your sync passphrase and kept in a private GitHub Gist. Syncs when the app opens and shortly after each change.</p>
      <p class="small">${busy ? '<span class="spinner"></span>Syncing…' : cfg.syncedAt ? `Last synced ${esc(ago(cfg.syncedAt))}.` : 'Not synced yet.'}</p>
      ${cfg.lastError ? `<p class="small bad">${esc(cfg.lastError)}</p>` : ''}
      <div class="row wrap"><button class="btn primary" id="sync-now" ${busy ? 'disabled' : ''}>Sync now</button><button class="btn danger" id="sync-off">Turn off on this device</button></div>
      <p class="tiny" style="margin-top:8px">Uploaded statement files stay on the device that read them; their transactions sync.</p>
    </div>`;
  }
  return `<div class="card" id="sync-card">
    <h2>Sync between devices</h2>
    <p class="small muted" style="margin-top:-4px">Keep the same data on your laptop and phone. It is encrypted on this device with a passphrase only you know, then stored in a private GitHub Gist. GitHub can’t read it.</p>
    <ol class="small muted" style="padding-left:18px;margin:0 0 12px">
      <li>On <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">github.com → Fine-grained tokens</a>, create a token with <strong>Account permissions → Gists: Read and write</strong> (or a classic token with the <strong>gist</strong> scope).</li>
      <li>Paste it below with a sync passphrase, and tap Turn on sync.</li>
      <li>On your other device, do the same with the <strong>same token and passphrase</strong>.</li>
    </ol>
    <label class="field"><span>GitHub token</span><input type="password" id="sync-token" autocomplete="off" placeholder="github_pat_… or ghp_…" spellcheck="false" autocapitalize="none"></label>
    <label class="field"><span>Sync passphrase</span><input type="password" id="sync-pass" autocomplete="new-password" placeholder="At least 8 characters"></label>
    <p class="tiny" style="margin-top:-4px">Both stay on this device only. If you forget the passphrase, the synced copy can’t be opened; your data on each device is unaffected.</p>
    <button class="btn primary" id="sync-on">Turn on sync</button>
  </div>`;
}

export function bindSyncCard(root: HTMLElement) {
  root.querySelector('#sync-on')?.addEventListener('click', async () => {
    const token = root.querySelector<HTMLInputElement>('#sync-token')!.value.trim();
    const pass = root.querySelector<HTMLInputElement>('#sync-pass')!.value;
    if (!token) { toast('Paste your GitHub token'); return; }
    if (pass.length < 8) { toast('Use a passphrase of at least 8 characters'); return; }
    saveSyncConfig({ token, pass });
    await runSync();
    // A wrong token or passphrase: stay off so it can be fixed.
    const cfg = syncConfig();
    if (cfg && !cfg.syncedAt) { forgetSync(); render(); }
  });
  root.querySelector('#sync-now')?.addEventListener('click', () => void runSync());
  root.querySelector('#sync-off')?.addEventListener('click', () => {
    forgetSync();
    toast('Sync is off on this device. Your data here is untouched.');
    render();
  });
}
