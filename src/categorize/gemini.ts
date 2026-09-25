import type { Kind, Settings, Txn } from '../types';
import { CATEGORIES, isValidCategory } from './categories';

/**
 * Google's aliases for its current free Flash and Flash-Lite models, best
 * first. They survive model retirements; the next one is tried when a model
 * is busy, retired or out of free quota.
 */
export const GEMINI_MODELS = ['gemini-flash-latest', 'gemini-flash-lite-latest'];

/** An error another model may not have: retired (404), busy (5xx) or out of free quota (429). */
class ModelUnavailable extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Text models this key can use; also checks that the key works. */
export async function listGeminiModels(key: string): Promise<string[]> {
  let res: Response;
  try {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(key)}`);
  } catch {
    throw new Error('Could not reach Google Gemini. Check your internet connection.');
  }
  if (!res.ok) {
    if (res.status === 400 || res.status === 401 || res.status === 403) throw new Error('Google rejected this API key. Copy it again from aistudio.google.com/apikey.');
    throw new Error(`Gemini returned an error (${res.status}).`);
  }
  const data = await res.json() as { models?: { name: string; supportedGenerationMethods?: string[] }[] };
  return (data.models ?? [])
    .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
    .map((m) => m.name.replace(/^models\//, ''))
    .filter((n) => /^gemini/.test(n) && !/tts|image|audio|live|embed|computer-use|robotics|transcribe|omni|customtools/.test(n));
}

const KINDS: Kind[] = ['spend', 'investment', 'income', 'transfer', 'cc_bill'];
const ALL_CATEGORIES = [...new Set(KINDS.flatMap((k) => CATEGORIES[k]))];

export interface AiSuggestion {
  id: string;
  payee: string;
  kind: Kind;
  category: string;
  /** The row's text looks like it mixes two payees (probably read from the wrong line). */
  mixed: boolean;
  note: string;
}

/**
 * What leaves the device: date, amount, direction and the narration with
 * long numbers (account, phone, reference numbers) and your own names masked.
 * Balances and account numbers are never sent.
 */
export function maskRow(t: Txn, ownNames: string[]): { date: string; amount: number; direction: string; text: string } {
  let text = t.description.replace(/\d{5,}/g, (m) => '#'.repeat(Math.min(m.length, 6)));
  for (const n of ownNames) {
    const name = n.trim();
    if (name.length >= 3) text = text.replace(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), 'SELF');
    if (name.length > 10) text = text.replace(new RegExp(name.slice(0, 10).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), 'SELF');
  }
  return { date: t.date, amount: t.amount, direction: t.direction, text };
}

const PROMPT = `You check rows read from an Indian bank statement for a personal expense tracker.
Each row has an index i, date, amount (INR), direction (debit = money out, credit = money in) and the narration text.
Numbers are masked with #; "SELF" is the account holder.

For every row return:
- payee: the real merchant or person, cleaned up (e.g. "Swiggy", "DSB Hospitality", "Rakesh Jain"). ICICI narrations start with a short payee label followed by "UPI/<payee>/<vpa>/...": use the UPI payee.
- kind: spend, investment, income, transfer (between SELF's own accounts) or cc_bill (paying SELF's credit card bill).
- category, one of the allowed categories for that kind:
${KINDS.map((k) => `  ${k}: ${CATEGORIES[k].join(', ')}`).join('\n')}
- mixed: true if the narration seems to contain text from two different transactions (for example the leading label names one payee but the UPI part names another).
- note: a few words when you are unsure or mixed is true, otherwise "".
Hospitality businesses are usually restaurants or hotels, not hospitals. Use "Uncategorised" only when the text gives no clue.`;

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    rows: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          i: { type: 'INTEGER' },
          payee: { type: 'STRING' },
          kind: { type: 'STRING', enum: KINDS },
          category: { type: 'STRING', enum: ALL_CATEGORIES },
          mixed: { type: 'BOOLEAN' },
          note: { type: 'STRING' },
        },
        required: ['i', 'payee', 'kind', 'category', 'mixed', 'note'],
      },
    },
  },
  required: ['rows'],
};

async function callGemini(key: string, model: string, rows: ReturnType<typeof maskRow>[]): Promise<{ i: number; payee: string; kind: Kind; category: string; mixed: boolean; note: string }[]> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: `${PROMPT}\n\nRows:\n${JSON.stringify(rows.map((r, i) => ({ i, ...r })))}` }] }],
        generationConfig: { responseMimeType: 'application/json', responseSchema: SCHEMA, temperature: 0 },
      }),
    });
  } catch {
    throw new Error('Could not reach Google Gemini. Check your internet connection.');
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 400 && /API key/i.test(body)) throw new Error('Google rejected the API key. Check it in Settings.');
    if (res.status === 403) throw new Error('This API key is not allowed to use Gemini. Create a new key at aistudio.google.com.');
    if (res.status === 404) throw new ModelUnavailable(`Model "${model}" is not available to this key.`, 404);
    if (res.status === 429) throw new ModelUnavailable('Free Gemini limit reached for now. Wait a minute (or until tomorrow) and try again.', 429);
    if (res.status >= 500) throw new ModelUnavailable('Google\'s free Gemini servers are busy right now. Try again in a few minutes.', res.status);
    throw new Error(`Gemini returned an error (${res.status}).`);
  }
  const data = await res.json();
  const text: string = data?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? '').join('') ?? '';
  if (!text) throw new Error('Gemini returned an empty answer. Try again.');
  return (JSON.parse(text) as { rows: { i: number; payee: string; kind: Kind; category: string; mixed: boolean; note: string }[] }).rows;
}

/** Asks one model, retrying once when it is busy. */
async function askModel(key: string, model: string, rows: ReturnType<typeof maskRow>[], retryDelay: number) {
  try {
    return await callGemini(key, model, rows);
  } catch (e) {
    if (!(e instanceof ModelUnavailable) || e.status < 500) throw e;
    await wait(retryDelay);
    return callGemini(key, model, rows);
  }
}

/** Flash models the key lists, newest first; used only if Google retires both aliases. */
async function discoveredModels(key: string, tried: string[]): Promise<string[]> {
  const names = await listGeminiModels(key).catch(() => []);
  const version = (n: string) => Number(n.match(/gemini-(\d+(?:\.\d+)?)/)?.[1] ?? 0);
  return names
    .filter((n) => /flash/.test(n) && !/preview|exp|thinking/.test(n) && !tried.includes(n))
    .sort((a, b) => version(b) - version(a) || Number(/lite/.test(a)) - Number(/lite/.test(b)))
    .slice(0, 3);
}

export async function checkWithGemini(txns: Txn[], settings: Settings, onProgress?: (done: number, total: number) => void, retryDelay = 2000): Promise<AiSuggestion[]> {
  if (!settings.geminiKey) throw new Error('Add your free Gemini API key in Settings first.');
  const key = settings.geminiKey;
  let models = [...GEMINI_MODELS];
  let discovered = false;
  const out: AiSuggestion[] = [];
  const BATCH = 60;
  for (let s = 0; s < txns.length; s += BATCH) {
    onProgress?.(s, txns.length);
    const batch = txns.slice(s, s + BATCH);
    const masked = batch.map((t) => maskRow(t, settings.ownNames));
    let rows;
    let lastError: unknown;
    for (let m = 0; m < models.length && !rows; m++) {
      const model = models[m];
      try {
        rows = await askModel(key, model, masked, retryDelay);
        // Keep using the model that answered for the remaining batches.
        models = [model, ...models.filter((x) => x !== model)];
      } catch (e) {
        if (!(e instanceof ModelUnavailable)) throw e;
        lastError = e;
        // Every known model is gone: look up what this key can use.
        if (m === models.length - 1 && !discovered && e.status === 404) {
          discovered = true;
          models.push(...await discoveredModels(key, models));
        }
      }
    }
    if (!rows) throw lastError;
    for (const r of rows) {
      const t = batch[r.i];
      if (!t || !KINDS.includes(r.kind) || !isValidCategory(r.kind, r.category)) continue;
      out.push({ id: t.id, payee: (r.payee || t.merchantName).slice(0, 40), kind: r.kind, category: r.category, mixed: Boolean(r.mixed), note: r.note ?? '' });
    }
  }
  onProgress?.(txns.length, txns.length);
  return out;
}
