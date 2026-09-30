import type { Settings } from '../types';

/**
 * Several free AI services behind one call, the way ATS does it: each request goes to the
 * first service in your order that has a key and is not resting; a service that is out of
 * free quota rests for 15 minutes (yellow in Settings) and the next one answers. Every
 * service here accepts calls straight from the browser (checked: Gemini, Groq, Cerebras,
 * Mistral, OpenRouter; Anthropic with its browser header), so nothing needs a server.
 * Keys stay on this device (and in the encrypted sync, like the Gemini key always has).
 */

export type ProviderId = 'gemini' | 'groq' | 'cerebras' | 'mistral' | 'openrouter' | 'anthropic' | 'ollama';

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  free: boolean;
  /** Where to get a key (or how to set it up). */
  signup: string;
  signupUrl?: string;
  placeholder: string;
  /** Models tried in this order; the first that answers is kept for the session. */
  models: string[];
  keyless?: boolean;
  note?: string;
}

export const PROVIDERS: ProviderInfo[] = [
  { id: 'gemini', name: 'Google Gemini', free: true, signup: 'aistudio.google.com/apikey - free, no card', signupUrl: 'https://aistudio.google.com/apikey',
    placeholder: 'AIza…', models: ['gemini-flash-latest', 'gemini-flash-lite-latest'] },
  { id: 'groq', name: 'Groq', free: true, signup: 'console.groq.com/keys - free, no card', signupUrl: 'https://console.groq.com/keys',
    placeholder: 'gsk_…', models: ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile', 'openai/gpt-oss-20b'] },
  { id: 'cerebras', name: 'Cerebras', free: true, signup: 'cloud.cerebras.ai - free tier', signupUrl: 'https://cloud.cerebras.ai',
    placeholder: 'csk-…', models: ['gpt-oss-120b', 'llama-3.3-70b', 'llama3.1-8b'] },
  { id: 'mistral', name: 'Mistral', free: true, signup: 'console.mistral.ai - free "Experiment" plan', signupUrl: 'https://console.mistral.ai/api-keys',
    placeholder: 'key', models: ['mistral-small-latest', 'mistral-medium-latest', 'ministral-8b-latest'] },
  { id: 'openrouter', name: 'OpenRouter', free: true, signup: 'openrouter.ai/keys - free models, small daily limit', signupUrl: 'https://openrouter.ai/keys',
    placeholder: 'sk-or-…', models: ['openrouter/free', 'meta-llama/llama-3.3-70b-instruct:free'] },
  { id: 'anthropic', name: 'Anthropic Claude', free: false, signup: 'console.anthropic.com - paid, per use', signupUrl: 'https://console.anthropic.com/settings/keys',
    placeholder: 'sk-ant-…', models: ['claude-haiku-4-5-20251001'], note: 'Paid: every answer costs a little. Off unless you add a key.' },
  { id: 'ollama', name: 'Local (Ollama)', free: true, signup: 'ollama.com - runs on this computer', signupUrl: 'https://ollama.com',
    placeholder: 'http://localhost:11434', models: [], keyless: true,
    note: 'This computer only (not the phone). Start Ollama with OLLAMA_ORIGINS set to this site\'s address so the browser may call it.' },
];

export const providerInfo = (id: ProviderId) => PROVIDERS.find((p) => p.id === id)!;

/** Out of quota, busy, retired, cut off: another service (or model) may still answer. */
export class AiUnavailable extends Error {
  constructor(message: string, readonly status: number, readonly limit = false) { super(message); }
}

/* ------------------------------------------------------------------ keys and order */

/** The site's AI hub (Money Home → AI, the same browser): keys and "which AI goes first" shared by all the apps. */
interface Hub { keys?: Partial<Record<string, string>>; first?: string; fallback?: boolean }
export function hubAi(): Hub {
  try { return JSON.parse(localStorage.getItem('money-ai') || '{}') as Hub; } catch { return {}; }
}

/** On the site with Money Home's Setup (or once Setup has been used in this browser), the keys and the first
 *  choice are set there, once for every app; a copy elsewhere keeps its own. */
export function sharedSetup(): boolean {
  try {
    return /(^|\.)anilgupta2606\.github\.io$/.test(location.hostname) || !!localStorage.getItem('money-setup') || !!localStorage.getItem('money-ai');
  } catch { return false; }
}

/** With the shared Setup its key wins (so a key changed there is used here at once); otherwise the one typed here. */
export function keyOf(s: Settings, id: ProviderId): string | undefined {
  const own = id === 'gemini' ? s.geminiKey || s.aiKeys?.gemini : s.aiKeys?.[id];
  const hub = hubAi().keys?.[id];
  const k = sharedSetup() ? (hub && hub.trim() ? hub : own) : (own && own.trim() ? own : hub);
  return k && k.trim() ? k.trim() : undefined;
}
/** The services in order: the one picked first in Setup leads, then your order here, then any not yet ordered. */
export function orderOf(s: Settings): ProviderId[] {
  const known = PROVIDERS.map((p) => p.id);
  let saved = (s.aiOrder ?? []).filter((x): x is ProviderId => known.includes(x as ProviderId));
  const first = hubAi().first as ProviderId | undefined;
  if (first && known.includes(first) && (sharedSetup() || !saved.length)) saved = [first, ...saved.filter((x) => x !== first)];
  return [...saved, ...known.filter((x) => !saved.includes(x))];
}
export const isOn = (s: Settings, id: ProviderId) => !(s.aiOff ?? []).includes(id);
/** Services that can answer: switched on and with a key (Ollama: an address). */
export const usable = (s: Settings) => orderOf(s).filter((id) => isOn(s, id) && Boolean(keyOf(s, id)));
export const hasAi = (s: Settings) => usable(s).length > 0;
export const aiNames = (s: Settings) => usable(s).map((id) => providerInfo(id).name);

/* ------------------------------------------------------------------ resting (yellow) */

const REST_KEY = 'et-ai-rest';
const REST_MS = 15 * 60 * 1000;
type RestMap = Partial<Record<ProviderId, { until: number; why: string }>>;
const readRest = (): RestMap => { try { return JSON.parse(localStorage.getItem(REST_KEY) || '{}') as RestMap; } catch { return {}; } };
const writeRest = (m: RestMap) => { try { localStorage.setItem(REST_KEY, JSON.stringify(m)); } catch { /* storage blocked */ } };
export function restingUntil(id: ProviderId, now = Date.now()): { until: number; why: string } | null {
  const r = readRest()[id];
  return r && r.until > now ? r : null;
}
export function rest(id: ProviderId, why: string, ms = REST_MS) { const m = readRest(); m[id] = { until: Date.now() + ms, why }; writeRest(m); }
export function wake(id: ProviderId) { const m = readRest(); delete m[id]; writeRest(m); }

/* ------------------------------------------------------------------ calls */

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Gemini's schema (types in capitals) as a plain JSON schema for the others. */
export function toJsonSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toJsonSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) out[k] = k === 'type' && typeof v === 'string' ? v.toLowerCase() : toJsonSchema(v);
  return out;
}

/** The JSON object in a reply, even when a model wraps it in prose or ```json fences. */
export function parseJson<T>(text: string): T {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(t) as T; } catch { /* look for the object */ }
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try { return JSON.parse(t.slice(a, b + 1)) as T; } catch { /* fall through */ }
  }
  throw new AiUnavailable('The answer was cut off or was not valid JSON.', 502);
}

async function post(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctl.signal });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new AiUnavailable('No answer in time.', 504);
    throw new AiUnavailable('Could not reach the service (offline, or it blocked the request).', 503);
  } finally { clearTimeout(timer); }
}

async function failure(name: string, res: Response): Promise<never> {
  const body = await res.text().catch(() => '');
  if (res.status === 401 || res.status === 403 || (res.status === 400 && /api[ _-]?key|unauthori[sz]ed|invalid.*key/i.test(body))) {
    throw new Error(`${name} rejected the API key. Check it in Settings.`);
  }
  if (res.status === 429 || /quota|rate.?limit|exhausted|too many/i.test(body)) throw new AiUnavailable(`${name}: free limit reached for now.`, 429, true);
  if (res.status === 404) throw new AiUnavailable(`${name}: model not available to this key.`, 404);
  if (res.status === 402) throw new AiUnavailable(`${name}: no credit left on this account.`, 402, true);
  if (res.status >= 500) throw new AiUnavailable(`${name} is busy right now.`, res.status);
  throw new AiUnavailable(`${name} returned an error (${res.status}).`, res.status);
}

const SYSTEM = (schema: unknown) => 'Reply with a single JSON object and nothing else. It must match this JSON schema:\n' + JSON.stringify(toJsonSchema(schema));

async function callGemini<T>(key: string, model: string, prompt: string, schema: object, timeoutMs: number): Promise<T> {
  const res = await post(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, {},
    { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', responseSchema: schema, temperature: 0 } }, timeoutMs);
  if (!res.ok) await failure('Google Gemini', res);
  const data = await res.json();
  const text: string = data?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? '').join('') ?? '';
  if (!text) throw new AiUnavailable('Gemini returned an empty answer.', 502);
  return parseJson<T>(text);
}

const OPENAI_BASE: Partial<Record<ProviderId, string>> = {
  groq: 'https://api.groq.com/openai/v1', cerebras: 'https://api.cerebras.ai/v1', mistral: 'https://api.mistral.ai/v1', openrouter: 'https://openrouter.ai/api/v1',
};

async function callOpenAiStyle<T>(id: ProviderId, key: string, model: string, prompt: string, schema: object, timeoutMs: number): Promise<T> {
  const name = providerInfo(id).name;
  const base = id === 'ollama' ? `${key.replace(/\/+$/, '')}/v1` : OPENAI_BASE[id]!;
  const headers: Record<string, string> = id === 'ollama' ? {} : { Authorization: `Bearer ${key}` };
  if (id === 'openrouter') { if (typeof location !== 'undefined') headers['HTTP-Referer'] = location.origin; headers['X-Title'] = 'Expense Tracker'; }
  const body = (json: boolean) => ({ model, temperature: 0, max_tokens: 8192, messages: [{ role: 'system', content: SYSTEM(schema) }, { role: 'user', content: prompt }],
    ...(json ? { response_format: { type: 'json_object' } } : {}) });
  let res = await post(`${base}/chat/completions`, headers, body(true), timeoutMs);
  // some models refuse the JSON switch: ask again without it (the system prompt still asks for JSON)
  if (res.status === 400) {
    const txt = await res.clone().text().catch(() => '');
    if (/response_format|json/i.test(txt)) res = await post(`${base}/chat/completions`, headers, body(false), timeoutMs);
  }
  if (!res.ok) await failure(name, res);
  const data = await res.json();
  const choice = data?.choices?.[0];
  const text: string = choice?.message?.content ?? '';
  if (!text) throw new AiUnavailable(`${name} returned an empty answer.`, 502);
  if (choice?.finish_reason === 'length') throw new AiUnavailable(`${name}: the answer was too long and was cut off.`, 502);
  return parseJson<T>(text);
}

async function callAnthropic<T>(key: string, model: string, prompt: string, schema: object, timeoutMs: number): Promise<T> {
  const res = await post('https://api.anthropic.com/v1/messages',
    { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
    { model, max_tokens: 8192, temperature: 0, system: SYSTEM(schema), messages: [{ role: 'user', content: prompt }] }, timeoutMs);
  if (!res.ok) await failure('Anthropic Claude', res);
  const data = await res.json();
  const text: string = (data?.content ?? []).map((c: { text?: string }) => c.text ?? '').join('');
  if (data?.stop_reason === 'max_tokens') throw new AiUnavailable('Claude: the answer was too long and was cut off.', 502);
  return parseJson<T>(text);
}

/** The models a key can use - also a check that the key works. */
export async function listModels(id: ProviderId, key: string): Promise<string[]> {
  const name = providerInfo(id).name;
  let res: Response;
  try {
    if (id === 'gemini') res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(key)}`);
    else if (id === 'anthropic') res = await fetch('https://api.anthropic.com/v1/models', { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' } });
    else if (id === 'ollama') res = await fetch(`${key.replace(/\/+$/, '')}/api/tags`);
    else res = await fetch(`${OPENAI_BASE[id]}/models`, { headers: { Authorization: `Bearer ${key}` } });
  } catch {
    throw new Error(id === 'ollama' ? 'Could not reach Ollama on this computer. Is it running, with OLLAMA_ORIGINS allowing this site?' : `Could not reach ${name}. Check your internet connection.`);
  }
  if (!res.ok) {
    if ([400, 401, 403].includes(res.status)) throw new Error(`${name} rejected this key.`);
    throw new Error(`${name} returned an error (${res.status}).`);
  }
  const data = await res.json();
  if (id === 'gemini') {
    return ((data.models ?? []) as { name: string; supportedGenerationMethods?: string[] }[])
      .filter((m) => m.supportedGenerationMethods?.includes('generateContent')).map((m) => m.name.replace(/^models\//, ''))
      .filter((n) => /^gemini/.test(n) && !/tts|image|audio|live|embed|computer-use|robotics|transcribe|omni|customtools/.test(n));
  }
  if (id === 'ollama') return ((data.models ?? []) as { name: string }[]).map((m) => m.name);
  return ((data.data ?? []) as { id: string }[]).map((m) => m.id);
}

/* ------------------------------------------------------------------ the best model */

/** Not chat models, or not useful for reading statements: never picked. */
const NOT_CHAT = /embed|tts|whisper|audio|speech|transcribe|image|imagen|veo|lyria|dall|vision-only|guard|moderation|ocr|rerank|live|realtime|robotics|computer-use|omni|customtools|aqa|learnlm|search|compound|playai|safeguard/i;
/** Strong, fast general models first (checked Sep 2026); anything not listed is ranked by its size. */
const PREFER = ['gpt-oss-120b', 'kimi-k2', 'qwen3-235b', 'qwen-3-235b', 'llama-4-maverick', 'deepseek-v3', 'llama-3.3-70b', 'mistral-large',
  'mistral-medium', 'qwen3-32b', 'qwen-3-32b', 'llama-4-scout', 'mistral-small', 'gpt-oss-20b', 'gemma-3-27b', 'deepseek-r1', 'ministral-8b', 'llama-3.1-8b', 'llama3.1-8b', 'ministral-3b'];
const sizeB = (m: string) => Number(m.match(/(\d+(?:\.\d+)?)b\b/i)?.[1] ?? 0);
const verOf = (m: string) => Number(m.match(/(\d+(?:\.\d+)?)/)?.[1] ?? 0);
const prefIdx = (m: string) => { const i = PREFER.findIndex((p) => m.toLowerCase().includes(p)); return i < 0 ? PREFER.length : i; };

/**
 * The models a key can use, best first, for this app's job (reading statement rows into JSON):
 * Gemini - the newest stable Flash (Pro has tiny free limits, Lite is weaker, previews come and
 * go); Groq, Cerebras, Mistral, OpenRouter - the strongest general models first, then by size
 * (OpenRouter: only the free ones); Claude - Haiku first (cheapest); Ollama - the smallest first,
 * because an 8 GB laptop stalls on big ones.
 */
export function rankModels(id: ProviderId, names: string[]): string[] {
  const uniq = [...new Set(names)].filter((m) => !NOT_CHAT.test(m));
  if (id === 'gemini') {
    const g = uniq.filter((m) => /^gemini/.test(m) && !/gemma|nano|tuning/.test(m));
    const preview = (m: string) => (/preview|exp|thinking/.test(m) ? 1 : 0);
    const kind = (m: string) => (/lite/.test(m) ? 2 : /flash/.test(m) ? 3 : /pro/.test(m) ? 1 : 0);
    const alias = (m: string) => /-latest$/.test(m);
    // an alias ("gemini-flash-latest") counts as the newest of its kind, placed just after it
    const newest = (k: number) => Math.max(0, ...g.filter((m) => !alias(m) && !preview(m) && kind(m) === k).map(verOf));
    const score = (m: string) => [preview(m), -kind(m), -(alias(m) ? newest(kind(m)) : verOf(m)), alias(m) ? 1 : 0];
    return g.sort((a, b) => { const x = score(a), y = score(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i]; return a.localeCompare(b); });
  }
  if (id === 'anthropic') {
    const tier = (m: string) => (/haiku/.test(m) ? 0 : /sonnet/.test(m) ? 1 : 2);
    return uniq.filter((m) => /^claude/.test(m) && !/opus/.test(m)).sort((a, b) => tier(a) - tier(b) || verOf(b.replace(/^claude-\D*/, '')) - verOf(a.replace(/^claude-\D*/, '')));
  }
  if (id === 'ollama') {
    return uniq.sort((a, b) => (sizeB(a) || 99) - (sizeB(b) || 99));
  }
  let list = uniq;
  if (id === 'openrouter') list = uniq.filter((m) => /:free$/.test(m) || m === 'openrouter/free');
  const ranked = list.filter((m) => m !== 'openrouter/free').sort((a, b) => prefIdx(a) - prefIdx(b) || sizeB(b) - sizeB(a) || a.localeCompare(b));
  return id === 'openrouter' && list.includes('openrouter/free') ? [...ranked.slice(0, 3), 'openrouter/free', ...ranked.slice(3)] : ranked;
}

const MODELS_KEY = 'et-ai-models';
const MODELS_TTL = 24 * 3600 * 1000;
type ModelCache = Partial<Record<ProviderId, { at: number; key: string; models: string[] }>>;
const readModels = (): ModelCache => { try { return JSON.parse(localStorage.getItem(MODELS_KEY) || '{}') as ModelCache; } catch { return {}; } };
const keyTag = (key: string) => key.slice(-6);
/** The ranked list saved by the last check (for Settings), if it belongs to this key. */
export function knownModels(id: ProviderId, key: string | undefined): string[] {
  const c = readModels()[id];
  return c && key && c.key === keyTag(key) ? c.models : [];
}
export function rememberModels(id: ProviderId, key: string, models: string[]) {
  const m = readModels(); m[id] = { at: Date.now(), key: keyTag(key), models };
  try { localStorage.setItem(MODELS_KEY, JSON.stringify(m)); } catch { /* storage blocked */ }
}
/** Ranked models for a key: remembered for a day, else asked for; the built-in list if that fails. */
export async function bestModels(id: ProviderId, key: string): Promise<string[]> {
  const c = readModels()[id];
  if (c && c.key === keyTag(key) && Date.now() - c.at < MODELS_TTL && c.models.length) return c.models;
  try {
    const ranked = rankModels(id, await listModels(id, key));
    if (ranked.length) { rememberModels(id, key, ranked); return ranked; }
  } catch { /* offline, or the list is not open to this key: use the built-in list */ }
  return providerInfo(id).models;
}
/** The model you pinned in Settings, or undefined for Auto (the best available). */
export const pinnedModel = (s: Settings, id: ProviderId) => { const m = s.aiModel?.[id]; return m && m !== 'auto' ? m : undefined; };

/* ------------------------------------------------------------------ the session */

export interface AiAnswerInfo { provider: ProviderId; model: string }

/**
 * Sends prompts to the first service that answers. Keeps using the service and model that
 * answered for the rest of the session; moves on when one is out of quota, busy or retired.
 */
export class AiSession {
  private chosen = new Map<ProviderId, string>();          // the model that answered, per service
  private discovered = new Set<ProviderId>();
  last: AiAnswerInfo | null = null;
  constructor(private settings: Settings, private retryDelay = 2000, private timeoutMs = 90_000) {}

  /** Your pinned model, else the one that answered this session, then the best available, then the
   *  built-in list - at most four tries per service, so a bad day does not mean a long wait. */
  private async modelsFor(id: ProviderId, key: string): Promise<string[]> {
    const ranked = await bestModels(id, key);
    const lead = [pinnedModel(this.settings, id), this.chosen.get(id)].filter((m): m is string => Boolean(m));
    return [...new Set([...lead, ...ranked, ...providerInfo(id).models])].slice(0, Math.max(4, lead.length + 2));
  }

  private async ask<T>(id: ProviderId, key: string, model: string, prompt: string, schema: object): Promise<T> {
    if (id === 'gemini') return callGemini<T>(key, model, prompt, schema, this.timeoutMs);
    if (id === 'anthropic') return callAnthropic<T>(key, model, prompt, schema, this.timeoutMs);
    return callOpenAiStyle<T>(id, key, model, prompt, schema, this.timeoutMs);
  }

  async generate<T>(prompt: string, schema: object): Promise<T> {
    const order = usable(this.settings);
    if (!order.length) throw new Error('Add a free AI key in Settings → AI assistants first.');
    let lastError: unknown = null;
    const skipped: string[] = [];
    for (const id of order) {
      const r = restingUntil(id);
      if (r) { skipped.push(`${providerInfo(id).name} is resting (${r.why})`); continue; }
      const key = keyOf(this.settings, id)!;
      let models = await this.modelsFor(id, key);
      for (let m = 0; m < models.length; m++) {
        const model = models[m];
        try {
          let out: T;
          try { out = await this.ask<T>(id, key, model, prompt, schema); }
          catch (e) {                                           // busy: one more try after a pause
            if (!(e instanceof AiUnavailable) || e.status < 500 || e.status === 502) throw e;
            await wait(this.retryDelay);
            out = await this.ask<T>(id, key, model, prompt, schema);
          }
          this.chosen.set(id, model);
          this.last = { provider: id, model };
          wake(id);
          return out;
        } catch (e) {
          lastError = e;
          if (!(e instanceof AiUnavailable)) { skipped.push((e as Error).message); break; }   // a wrong key: try the next service, report it if none answers
          if (e.limit) { rest(id, e.message); break; }       // out of quota: the whole service rests
          // every listed model is gone: look up what this key can use (once)
          if (e.status === 404 && m === models.length - 1 && !this.discovered.has(id)) {
            this.discovered.add(id);
            const have = await listModels(id, key).catch(() => []);
            models = models.concat(have.filter((x) => !models.includes(x)).slice(0, 3));
          }
        }
      }
    }
    if (skipped.length || !lastError) {
      const why = [...skipped, ...(lastError instanceof AiUnavailable ? [lastError.message] : [])];
      throw new Error(`No AI service could answer: ${why.join('; ')}. Try again later or add another free key in Settings → AI assistants.`);
    }
    throw lastError;
  }
}

export const aiSession = (s: Settings, retryDelay = 2000) => new AiSession(s, retryDelay);
