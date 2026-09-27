import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiSession, hasAi, orderOf, parseJson, toJsonSchema, usable } from '../src/ai/providers';
import { emptyState } from '../src/store';

const settings = (over: object) => ({ ...emptyState().settings, ...over });
const SCHEMA = { type: 'OBJECT', properties: { rows: { type: 'ARRAY', items: { type: 'INTEGER' } } }, required: ['rows'] };
const gemOk = (obj: unknown) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] }), { status: 200 });
const oaiOk = (text: string) => new Response(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }] }), { status: 200 });

describe('which services are used', () => {
  it('uses only services that are on and have a key, in your order', () => {
    const s = settings({ geminiKey: 'g', aiKeys: { groq: 'q', mistral: '' }, aiOrder: ['groq', 'gemini'], aiOff: [] });
    expect(orderOf(s).slice(0, 2)).toEqual(['groq', 'gemini']);
    expect(usable(s)).toEqual(['groq', 'gemini']);
    expect(usable({ ...s, aiOff: ['groq'] })).toEqual(['gemini']);
    expect(hasAi(emptyState().settings)).toBe(false);
  });
});

describe('answers', () => {
  it('turns Gemini schemas into plain JSON schemas', () => {
    expect(toJsonSchema(SCHEMA)).toEqual({ type: 'object', properties: { rows: { type: 'array', items: { type: 'integer' } } }, required: ['rows'] });
  });
  it('reads JSON wrapped in fences or prose', () => {
    expect(parseJson('```json\n{"rows":[1]}\n```')).toEqual({ rows: [1] });
    expect(parseJson('Here it is: {"rows":[2]} hope that helps')).toEqual({ rows: [2] });
    expect(() => parseJson('{"rows":[1,')).toThrow(/cut off|not valid/);
  });
});

describe('falling back to the next service', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('moves to Groq when Gemini is out of free quota', async () => {
    const hit: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      hit.push(url.split('?')[0]);
      if (url.includes('googleapis')) return new Response('RESOURCE_EXHAUSTED quota', { status: 429 });
      const body = JSON.parse(String(init.body));
      expect(body.messages[0].content).toContain('"type":"object"');       // the schema travels in the system prompt
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer q');
      return oaiOk('{"rows":[7]}');
    }));
    const s = new AiSession(settings({ geminiKey: 'g', aiKeys: { groq: 'q' } }), 0);
    expect(await s.generate<{ rows: number[] }>('p', SCHEMA)).toEqual({ rows: [7] });
    expect(s.last?.provider).toBe('groq');
    expect(hit[0]).toContain('googleapis');
    expect(hit.at(-1)).toContain('api.groq.com');
  });

  it('skips a service whose key is rejected and still answers', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.includes('googleapis') ? new Response('API key not valid', { status: 400 }) : oaiOk('{"rows":[]}'))));
    const s = new AiSession(settings({ geminiKey: 'bad', aiKeys: { mistral: 'm' } }), 0);
    expect(await s.generate('p', SCHEMA)).toEqual({ rows: [] });
    expect(s.last?.provider).toBe('mistral');
  });

  it('asks again without the JSON switch when a model refuses it', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      calls++;
      const body = JSON.parse(String(init!.body));
      return body.response_format ? new Response('response_format json_object not supported', { status: 400 }) : oaiOk('{"rows":[1]}');
    }));
    expect(await new AiSession(settings({ aiKeys: { openrouter: 'o' } }), 0).generate('p', SCHEMA)).toEqual({ rows: [1] });
    expect(calls).toBe(2);
  });

  it('says what went wrong when nothing answers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('quota exceeded', { status: 429 })));
    await expect(new AiSession(settings({ geminiKey: 'g', aiKeys: { groq: 'q' } }), 0).generate('p', SCHEMA)).rejects.toThrow(/limit/);
    await expect(new AiSession(emptyState().settings, 0).generate('p', SCHEMA)).rejects.toThrow(/AI key in Settings/);
  });

  it('keeps Gemini first and unchanged when it answers', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.includes('googleapis') ? gemOk({ rows: [3] }) : oaiOk('{"rows":[9]}'))));
    const s = new AiSession(settings({ geminiKey: 'g', aiKeys: { groq: 'q' } }), 0);
    expect(await s.generate('p', SCHEMA)).toEqual({ rows: [3] });
    expect(s.last).toEqual({ provider: 'gemini', model: 'gemini-flash-latest' });
  });
});

describe('picking the best model', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('Gemini: newest stable Flash first, previews and Pro later, never audio or embedding models', async () => {
    const { rankModels } = await import('../src/ai/providers');
    const got = rankModels('gemini', ['gemini-flash-latest', 'gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.5-flash-lite', 'gemini-2.5-flash',
      'gemini-3-flash-preview', 'gemini-2.5-pro', 'gemini-pro-latest', 'gemini-2.5-flash-preview-tts', 'text-embedding-004', 'gemini-flash-lite-latest']);
    expect(got[0]).toBe('gemini-3.8-flash');
    expect(got.indexOf('gemini-3.8-flash')).toBeLessThan(got.indexOf('gemini-2.5-flash'));
    expect(got.indexOf('gemini-2.5-flash')).toBeLessThan(got.indexOf('gemini-2.5-pro'));
    expect(got.indexOf('gemini-3-flash-preview')).toBeGreaterThan(got.indexOf('gemini-2.5-pro'));
    expect(got).not.toContain('gemini-2.5-flash-preview-tts');
    expect(got).not.toContain('text-embedding-004');
  });
  it('Groq / OpenRouter: strongest general model first; OpenRouter free models only', async () => {
    const { rankModels } = await import('../src/ai/providers');
    expect(rankModels('groq', ['llama-3.1-8b-instant', 'whisper-large-v3', 'openai/gpt-oss-20b', 'llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'meta-llama/llama-guard-4-12b'])
      .slice(0, 3)).toEqual(['openai/gpt-oss-120b', 'llama-3.3-70b-versatile', 'openai/gpt-oss-20b']);
    const or = rankModels('openrouter', ['openai/gpt-4o', 'meta-llama/llama-3.3-70b-instruct:free', 'openrouter/free', 'qwen/qwen3-235b-a22b:free', 'mistralai/mistral-small-3.2-24b-instruct:free']);
    expect(or[0]).toBe('qwen/qwen3-235b-a22b:free');
    expect(or).not.toContain('openai/gpt-4o');
    expect(or).toContain('openrouter/free');
  });
  it('Ollama: the smallest model first on a laptop', async () => {
    const { rankModels } = await import('../src/ai/providers');
    expect(rankModels('ollama', ['qwen3:8b', 'gemma3:4b', 'qwen3:4b', 'nomic-embed-text'])[0]).toMatch(/:4b$/);
  });
  it('a session asks for the key\'s models and uses the best one', async () => {
    const hit: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'llama-3.1-8b-instant' }, { id: 'openai/gpt-oss-120b' }] }), { status: 200 });
      return oaiOk('{"rows":[4]}');
    }));
    const s = new AiSession(settings({ aiKeys: { groq: 'q-best' } }), 0);
    expect(await s.generate('p', SCHEMA)).toEqual({ rows: [4] });
    expect(s.last).toEqual({ provider: 'groq', model: 'openai/gpt-oss-120b' });
    void hit;
  });
});
