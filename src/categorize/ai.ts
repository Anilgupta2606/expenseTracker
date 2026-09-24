import Anthropic from '@anthropic-ai/sdk';
import type { Kind, Settings, Txn } from '../types';
import { CATEGORIES, isValidCategory } from './categories';
import { detectMethod } from './engine';

export interface AiSuggestion { id: string; kind: Kind; category: string }

const KINDS = Object.keys(CATEGORIES) as Kind[];
const ALL_CATEGORIES = [...new Set(KINDS.flatMap((k) => CATEGORIES[k]))];

const SYSTEM = `You categorise rows from Indian bank account statements for a personal expense tracker.

Each row has an id, the bank's narration text, amount in INR, direction (debit = money out, credit = money in) and payment method.

Pick a kind and a category for every row:
- spend: money spent on goods, services, bills, taxes, fees, or paid to other people.
- income: salary, reimbursements, interest, dividends, refunds, cashback, money received from other people.
- investment: buying or redeeming mutual funds, stocks, gold, FDs, PPF/NPS, foreign remittances for investing. Use this for both directions.
- transfer: moving money between the account holder's own accounts.
- cc_bill: paying the account holder's credit card bill.

Categories allowed per kind:
${KINDS.map((k) => `- ${k}: ${CATEGORIES[k].join(', ')}`).join('\n')}

Narrations look like "UPI-<payee name>-<vpa>-..." (HDFC) or "UPI/<payee name>/<vpa>/<note>/..." (ICICI). Use the payee name and VPA to recognise merchants. Shop QR codes (paytmqr, bharatpe, q123@ybl) are merchants; plain person names or phone-number VPAs are people. Use "Uncategorised" only when the narration gives no real clue.`;

const SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          kind: { type: 'string', enum: KINDS },
          category: { type: 'string', enum: ALL_CATEGORIES },
        },
        required: ['id', 'kind', 'category'],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
};

async function classifyBatch(client: Anthropic, model: string, txns: Txn[]): Promise<AiSuggestion[]> {
  // Only what's needed to classify: no balances or account numbers.
  const rows = txns.map((t, i) => ({
    id: String(i),
    narration: t.description,
    amount: t.amount,
    direction: t.direction,
    method: detectMethod(t.description.toUpperCase()),
  }));
  const isOpus = model.startsWith('claude-opus');
  const response = await client.beta.messages.create({
    model,
    max_tokens: 16000,
    system: SYSTEM,
    messages: [{ role: 'user', content: JSON.stringify(rows) }],
    output_config: {
      format: { type: 'json_schema', schema: SCHEMA },
      ...(model.startsWith('claude-haiku') ? {} : { effort: 'low' as const }),
    },
    // Opus 5 can decline some requests; let the server retry on a fallback model.
    ...(isOpus ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
  });
  if (response.stop_reason === 'refusal') throw new Error('The model declined to categorise this batch.');
  if (response.stop_reason === 'max_tokens') throw new Error('The response was cut off. Try fewer rows.');
  const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
  const parsed = JSON.parse(text) as { results: { id: string; kind: Kind; category: string }[] };
  return parsed.results.flatMap((r) => {
    const t = txns[Number(r.id)];
    if (!t || !isValidCategory(r.kind, r.category) || r.category === 'Uncategorised') return [];
    return [{ id: t.id, kind: r.kind, category: r.category }];
  });
}

export async function categorizeWithAI(
  txns: Txn[],
  settings: Settings,
  onProgress?: (done: number, total: number) => void,
): Promise<AiSuggestion[]> {
  if (!settings.aiApiKey) throw new Error('Add your Claude API key in Settings first.');
  const client = new Anthropic({ apiKey: settings.aiApiKey, dangerouslyAllowBrowser: true });
  const out: AiSuggestion[] = [];
  const BATCH = 40;
  for (let i = 0; i < txns.length; i += BATCH) {
    onProgress?.(i, txns.length);
    try {
      out.push(...(await classifyBatch(client, settings.aiModel, txns.slice(i, i + BATCH))));
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) throw new Error('The API key was rejected. Check it in Settings.');
      if (e instanceof Anthropic.PermissionDeniedError) throw new Error('This API key cannot use the selected model.');
      if (e instanceof Anthropic.RateLimitError) throw new Error('Rate limited by the API. Wait a minute and try again.');
      if (e instanceof Anthropic.APIError && e.status === 400 && /credit/i.test(e.message)) {
        throw new Error('Your API credit balance is too low. Top up at console.anthropic.com.');
      }
      if (e instanceof Anthropic.APIConnectionError) throw new Error('Could not reach the Claude API. Check your connection.');
      throw e;
    }
  }
  onProgress?.(txns.length, txns.length);
  return out;
}
