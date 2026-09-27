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
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      calls++;
      const body = JSON.parse(String(init.body));
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
