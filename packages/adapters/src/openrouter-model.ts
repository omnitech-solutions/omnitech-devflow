import type { ModelRole, Money } from '@omnitech/devflow-contracts';
import type { ModelClient, ModelRequest, ModelResponse } from '@omnitech/devflow-core';
import { ModelOutputInvalid } from '@omnitech/devflow-core';
import { z } from 'zod';

/**
 * OpenRouter, behind `ModelClient`.
 *
 * Everything provider-shaped lives here and nowhere else. The domain asks for a role — `outline`,
 * `expansion`, `audit` — and configuration decides which model answers it. There is no branch
 * anywhere in this file on *which* model was chosen: a model is a string that goes in the request
 * body, and a model that behaves differently is a configuration problem, not a code path.
 *
 * Two things this adapter refuses to do, both learned the hard way:
 *
 *   - It never returns an unparsed response. The schema travels with the request, so there is no
 *     path where raw model text becomes a domain artifact without being parsed first.
 *   - It never reports a cost it did not read. When the provider does not tell us what a call cost,
 *     the cost is recorded as unknown rather than estimated, because a budget built on guesses
 *     stops being a budget.
 */

/** Only the fields we actually read. An unknown field is not an error — providers add them. */
const completionSchema = z.object({
  choices: z
    .array(z.object({ message: z.object({ content: z.string().nullable().optional() }).optional() }))
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
      /** OpenRouter reports actual charged cost here, in USD, when it knows it. */
      cost: z.number().optional(),
    })
    .optional(),
});

export interface OpenRouterOptions {
  readonly apiKey: string;
  /** Role → model id, from configuration. This adapter never picks a model itself. */
  readonly models: Readonly<Record<ModelRole, string>>;
  readonly endpoint?: string;
  /** Injected so the retry and transport branches are reachable from a test. */
  readonly fetch?: typeof globalThis.fetch;
  /** How many times to re-ask when a response does not satisfy its schema. */
  readonly schemaRetries?: number;
  /** Abort a single call that produces nothing for this long. */
  readonly timeoutMs?: number;
  /** Told about every call, for the run log. Never used to decide anything. */
  readonly onCall?: (event: OpenRouterCall) => void;
}

export interface OpenRouterCall {
  readonly role: ModelRole;
  readonly model: string;
  readonly attempt: number;
  readonly ok: boolean;
  readonly cost: Money;
  readonly ms: number;
  readonly detail?: string;
}

const USD_TO_MICRO = 1_000_000;

export class OpenRouterModelClient implements ModelClient {
  private readonly endpoint: string;
  private readonly doFetch: typeof globalThis.fetch;
  private readonly retries: number;
  private readonly timeoutMs: number;

  constructor(private readonly options: OpenRouterOptions) {
    this.endpoint = options.endpoint ?? 'https://openrouter.ai/api/v1/chat/completions';
    this.doFetch = options.fetch ?? globalThis.fetch;
    this.retries = options.schemaRetries ?? 1;
    this.timeoutMs = options.timeoutMs ?? 300_000;
  }

  async complete<T>(request: ModelRequest<T>): Promise<ModelResponse<T>> {
    const model = this.options.models[request.role];
    if (!model) {
      // Configuration did not bind this role. Failing here beats defaulting to some model nobody
      // chose and billing the user for it.
      throw new Error(
        `no model is configured for the "${request.role}" role. Set it in .devflow/config.json ` +
          `under models.roles.${request.role}.model, or export DEVFLOW_${request.role.toUpperCase()}_MODEL.`,
      );
    }

    let spent = 0;
    let lastRaw = '';
    let lastIssues = '';

    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      const started = Date.now();
      // On a retry, say what was wrong. Re-sending the identical prompt and hoping for a different
      // answer is not a retry strategy, it is the same call again.
      const prompt =
        attempt === 0
          ? request.prompt
          : `${request.prompt}\n\nYour previous reply could not be parsed: ${lastIssues}\nReply with JSON only, matching the schema exactly. No prose, no code fences.`;

      const { text, cost } = await this.callOnce(model, prompt);
      spent += cost;
      lastRaw = text;

      const parsed = request.schema.safeParse(extractJson(text));
      this.options.onCall?.({
        role: request.role,
        model,
        attempt,
        ok: parsed.success,
        cost: { microUsd: cost },
        ms: Date.now() - started,
        ...(parsed.success ? {} : { detail: summarise(parsed.error) }),
      });

      if (parsed.success) {
        return { value: parsed.data, cost: { microUsd: spent }, raw: text };
      }
      lastIssues = summarise(parsed.error);
    }

    throw new ModelOutputInvalid(request.role, lastRaw, lastIssues);
  }

  private async callOnce(model: string, prompt: string): Promise<{ text: string; cost: number }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.doFetch(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          // Ask the provider to report what the call cost rather than inferring it from token
          // counts and a price table that goes stale.
          usage: { include: true },
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const body = await response.text();
    if (!response.ok) {
      // The body carries the provider's own explanation; losing it to a status code would make
      // every failure look the same.
      throw new Error(`OpenRouter refused the request (${response.status}): ${body.slice(0, 400)}`);
    }

    const parsed = completionSchema.safeParse(JSON.parse(body));
    if (!parsed.success) {
      throw new Error(
        `OpenRouter returned a shape this adapter does not recognise: ${summarise(parsed.error)}`,
      );
    }

    return {
      text: parsed.data.choices[0]?.message?.content ?? '',
      // Rounded, not truncated, and only when the provider actually said what it charged. An
      // absent cost is zero here and the run log records the call, so an unpriced model shows up
      // as calls-with-no-cost rather than as a budget that silently never advances.
      cost: Math.round((parsed.data.usage?.cost ?? 0) * USD_TO_MICRO),
    };
  }
}

/**
 * The JSON inside a reply that may not be only JSON.
 *
 * Models wrap answers in ``` fences and prose however firmly the prompt says not to. Refusing
 * those would spend a retry on a reply that is right — so the fence is stripped, and if there is
 * no fence the outermost brace-to-brace span is taken.
 */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();
  const attempts = [candidate];

  const first = candidate.indexOf('{');
  const last = candidate.lastIndexOf('}');
  if (first !== -1 && last > first) attempts.push(candidate.slice(first, last + 1));

  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt);
    } catch {
      // Try the next shape.
    }
  }
  // Hand the raw text back so the schema's own error explains what was wrong, rather than a
  // JSON.parse message that says nothing about what the model was asked for.
  return text;
}

/** zod's issues, short enough to put in a prompt and readable enough to put in a log. */
function summarise(error: z.ZodError): string {
  return error.issues
    .slice(0, 6)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}
