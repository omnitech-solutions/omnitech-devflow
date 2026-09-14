import { ModelOutputInvalid } from '@omnitech/devflow-core';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { extractJson, type OpenRouterCall, OpenRouterModelClient } from './openrouter-model.js';

/**
 * The OpenRouter adapter, tested through an injected `fetch`.
 *
 * Injected rather than mocked at the module level: every branch worth having here is a shape the
 * provider can return — a fenced reply, a refusal, a response with no cost — and those are
 * reachable only by controlling the response. Nothing in this file reaches the network.
 */

const schema = z.strictObject({ answer: z.string() });

const reply = (content: string, cost?: number, ok = true, status = 200): typeof globalThis.fetch =>
  vi.fn(
    async () =>
      new Response(
        ok
          ? JSON.stringify({
              choices: [{ message: { content } }],
              ...(cost === undefined ? {} : { usage: { cost } }),
            })
          : content,
        { status },
      ),
  ) as unknown as typeof globalThis.fetch;

const client = (fetchImpl: typeof globalThis.fetch, over: Record<string, unknown> = {}) =>
  new OpenRouterModelClient({
    apiKey: 'test-key',
    models: { outline: 'm/outline', expansion: 'm/expansion', audit: 'm/audit' },
    fetch: fetchImpl,
    ...over,
  });

describe('a well-formed answer', () => {
  it('parses into the requested schema', async () => {
    const out = await client(reply('{"answer":"yes"}', 0.002)).complete({
      role: 'expansion',
      prompt: 'p',
      schema,
    });
    expect(out.value).toEqual({ answer: 'yes' });
  });

  it('reports the cost the provider charged, as integer microUsd', async () => {
    // Money is never a float here. $0.0023 is 2300 microUsd, and rounding happens once, at the edge.
    const out = await client(reply('{"answer":"yes"}', 0.0023)).complete({
      role: 'expansion',
      prompt: 'p',
      schema,
    });
    expect(out.cost).toEqual({ microUsd: 2300 });
    expect(Number.isInteger(out.cost.microUsd)).toBe(true);
  });

  it('keeps the raw text for the audit trail', async () => {
    const out = await client(reply('{"answer":"yes"}', 0)).complete({
      role: 'expansion',
      prompt: 'p',
      schema,
    });
    expect(out.raw).toBe('{"answer":"yes"}');
  });

  it('records zero rather than inventing a cost the provider did not report', async () => {
    // An estimated cost is a budget built on guesses. Zero plus a logged call reads as
    // "unpriced model", which is true and visible; an estimate reads as fact and is not.
    const out = await client(reply('{"answer":"yes"}')).complete({ role: 'expansion', prompt: 'p', schema });
    expect(out.cost.microUsd).toBe(0);
  });
});

describe('the model chosen for a role', () => {
  it('comes from configuration, never from this adapter', async () => {
    const fetchImpl = reply('{"answer":"ok"}', 0);
    await client(fetchImpl).complete({ role: 'audit', prompt: 'p', schema });
    const body = JSON.parse((vi.mocked(fetchImpl).mock.calls[0]![1] as RequestInit).body as string);
    expect(body.model).toBe('m/audit');
  });

  it('fails with a fixable message when a role is unbound', async () => {
    // Better than defaulting to some model nobody chose and billing for it.
    const bare = new OpenRouterModelClient({
      apiKey: 'k',
      models: { outline: 'm/o', audit: 'm/a' } as never,
      fetch: reply('{}', 0),
    });
    await expect(bare.complete({ role: 'expansion', prompt: 'p', schema })).rejects.toThrow(
      /no model is configured for the "expansion" role/,
    );
  });

  it('asks the provider to report usage, so cost is read and not inferred', async () => {
    const fetchImpl = reply('{"answer":"ok"}', 0);
    await client(fetchImpl).complete({ role: 'expansion', prompt: 'p', schema });
    const body = JSON.parse((vi.mocked(fetchImpl).mock.calls[0]![1] as RequestInit).body as string);
    expect(body.usage).toEqual({ include: true });
  });
});

describe('a reply that is not only JSON', () => {
  it('reads through a ``` fence', async () => {
    // Models fence answers however firmly the prompt says not to. Spending a retry on a reply that
    // is correct is waste.
    const out = await client(reply('```json\n{"answer":"fenced"}\n```', 0)).complete({
      role: 'expansion',
      prompt: 'p',
      schema,
    });
    expect(out.value.answer).toBe('fenced');
  });

  it('reads through surrounding prose', async () => {
    const out = await client(reply('Sure! {"answer":"prose"} Hope that helps.', 0)).complete({
      role: 'expansion',
      prompt: 'p',
      schema,
    });
    expect(out.value.answer).toBe('prose');
  });
});

describe('a reply that does not satisfy the schema', () => {
  it('is re-asked with what was wrong, not re-sent unchanged', async () => {
    // Sending the identical prompt again and hoping is not a retry strategy.
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      const content = call === 1 ? '{"wrong":"shape"}' : '{"answer":"second time"}';
      return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { cost: 0.001 } }), {
        status: 200,
      });
    }) as unknown as typeof globalThis.fetch;

    const out = await client(fetchImpl).complete({ role: 'expansion', prompt: 'p', schema });
    expect(out.value.answer).toBe('second time');
    const second = JSON.parse((vi.mocked(fetchImpl).mock.calls[1]![1] as RequestInit).body as string);
    expect(second.messages[0].content).toContain('could not be parsed');
    expect(second.messages[0].content).toContain('answer');
  });

  it('bills for every attempt, because every attempt was charged', async () => {
    const out = await client(
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ choices: [{ message: { content: '{"answer":"x"}' } }], usage: { cost: 0.001 } }),
            {
              status: 200,
            },
          ),
      ) as unknown as typeof globalThis.fetch,
    ).complete({ role: 'expansion', prompt: 'p', schema });
    expect(out.cost.microUsd).toBe(1000);
  });

  it('throws ModelOutputInvalid once the retries are spent', async () => {
    await expect(
      client(reply('{"wrong":"shape"}', 0.001), { schemaRetries: 1 }).complete({
        role: 'expansion',
        prompt: 'p',
        schema,
      }),
    ).rejects.toBeInstanceOf(ModelOutputInvalid);
  });

  it('never returns an unparsed value', async () => {
    // The property the whole adapter exists to hold: raw model text does not become a domain
    // artifact without passing its schema first.
    const result = await client(reply('not json at all', 0), { schemaRetries: 0 })
      .complete({ role: 'expansion', prompt: 'p', schema })
      .catch((error: unknown) => error);
    expect(result).toBeInstanceOf(ModelOutputInvalid);
  });
});

describe('when the provider refuses', () => {
  it('keeps the provider’s own explanation instead of only a status code', async () => {
    await expect(
      client(reply('{"error":{"message":"insufficient credits"}}', undefined, false, 402)).complete({
        role: 'expansion',
        prompt: 'p',
        schema,
      }),
    ).rejects.toThrow(/402.*insufficient credits/s);
  });

  it('says so when the response shape is not one this adapter knows', async () => {
    const odd = vi.fn(
      async () => new Response(JSON.stringify({ unexpected: true }), { status: 200 }),
    ) as unknown as typeof globalThis.fetch;
    await expect(client(odd).complete({ role: 'expansion', prompt: 'p', schema })).rejects.toThrow(
      /shape this adapter does not recognise/,
    );
  });

  it('treats a missing content field as an empty answer rather than crashing', async () => {
    const empty = vi.fn(
      async () => new Response(JSON.stringify({ choices: [{}] }), { status: 200 }),
    ) as unknown as typeof globalThis.fetch;
    await expect(
      client(empty, { schemaRetries: 0 }).complete({ role: 'expansion', prompt: 'p', schema }),
    ).rejects.toBeInstanceOf(ModelOutputInvalid);
  });
});

describe('observability', () => {
  it('announces every call, including the ones that failed their schema', async () => {
    // A run that spends money silently cannot be audited while it is happening, which is when it
    // matters.
    const calls: OpenRouterCall[] = [];
    await client(reply('{"wrong":"shape"}', 0.001), { schemaRetries: 1, onCall: (c) => calls.push(c) })
      .complete({ role: 'expansion', prompt: 'p', schema })
      .catch(() => undefined);
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.ok === false)).toBe(true);
    expect(calls[0]).toMatchObject({ role: 'expansion', model: 'm/expansion', attempt: 0 });
    expect(calls[0]!.detail).toContain('answer');
  });

  it('reports the cost of each call, not the running total', async () => {
    const calls: OpenRouterCall[] = [];
    await client(reply('{"answer":"x"}', 0.005), { onCall: (c) => calls.push(c) }).complete({
      role: 'expansion',
      prompt: 'p',
      schema,
    });
    expect(calls[0]!.cost).toEqual({ microUsd: 5000 });
  });
});

describe('defaults', () => {
  it('uses the documented OpenRouter endpoint when none is given', async () => {
    // The default is the one branch here nobody exercises by accident, and pointing it at the
    // wrong host is the kind of mistake that only shows up as a bill.
    const fetchImpl = reply('{"answer":"ok"}', 0);
    await new OpenRouterModelClient({
      apiKey: 'k',
      models: { outline: 'o', expansion: 'e', audit: 'a' },
      fetch: fetchImpl,
    }).complete({ role: 'expansion', prompt: 'p', schema });
    expect(vi.mocked(fetchImpl).mock.calls[0]![0]).toBe('https://openrouter.ai/api/v1/chat/completions');
  });

  it('honours an endpoint that is given', async () => {
    const fetchImpl = reply('{"answer":"ok"}', 0);
    await client(fetchImpl, { endpoint: 'http://127.0.0.1:9/x' }).complete({
      role: 'expansion',
      prompt: 'p',
      schema,
    });
    expect(vi.mocked(fetchImpl).mock.calls[0]![0]).toBe('http://127.0.0.1:9/x');
  });
});

describe('extractJson', () => {
  it.each([
    ['plain', '{"a":1}', { a: 1 }],
    ['fenced', '```json\n{"a":1}\n```', { a: 1 }],
    ['unlabelled fence', '```\n{"a":1}\n```', { a: 1 }],
    ['prose around it', 'here you go: {"a":1} done', { a: 1 }],
    ['leading whitespace', '   {"a":1}   ', { a: 1 }],
  ])('reads %s', (_what, input, expected) => {
    expect(extractJson(input)).toEqual(expected);
  });

  it('hands back the raw text when there is no JSON in it', () => {
    // So the schema's own error explains what was expected, rather than a JSON.parse message that
    // says nothing about what the model was asked for.
    expect(extractJson('I cannot help with that.')).toBe('I cannot help with that.');
  });
});
