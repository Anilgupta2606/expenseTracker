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

export function keyOf(s: Settings, id: ProviderId): string | undefined {
  if (id === 'gemini') return s.geminiKey || s.aiKeys?.gemini;
  const k = s.aiKeys?.[id];
  return k && k.trim() ? k.trim() : undefined;
}
/** The services in your order, then any not yet ordered. */
export function orderOf(s: Settings): ProviderId[] {
  const known = PROVIDERS.map((p) => p.id);
  const saved = (s.aiOrder ?? []).filter((x): x is ProviderId => known.includes(x as ProviderId));
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

  private async modelsFor(id: ProviderId, key: string): Promise<string[]> {
    const base = providerInfo(id).models;
    if (id === 'ollama' && !this.discovered.has(id)) {
      this.discovered.add(id);
      const have = await listModels(id, key).catch(() => []);
      // small models first on a laptop; embedding models cannot answer
      return have.filter((m) => !/embed/i.test(m)).sort((a, b) => (Number(a.match(/(\d+(?:\.\d+)?)b/i)?.[1] ?? 99) - Number(b.match(/(\d+(?:\.\d+)?)b/i)?.[1] ?? 99)));
    }
    const first = this.chosen.get(id);
    return first ? [first, ...base.filter((m) => m !== first)] : base;
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
