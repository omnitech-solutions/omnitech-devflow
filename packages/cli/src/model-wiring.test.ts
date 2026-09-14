import { resolveConfig } from '@omnitech/devflow-core';
import { afterEach, describe, expect, it } from 'vitest';
import { modelClientFor } from './env.js';

/**
 * How a model client is built from configuration alone.
 *
 * The rule this file protects: nothing in DevFlow picks a model. A role is bound in configuration,
 * and every failure to do so is reported with the setting that would fix it — because the
 * alternative, silently falling back to some default, spends the user's money on a choice they
 * never made.
 */

const loaded = (roles: Record<string, { provider: string; model: string }>) => {
  const base = resolveConfig({ env: {} });
  return {
    ...base,
    files: [],
    config: { ...base.config, models: { roles } },
  } as unknown as Parameters<typeof modelClientFor>[0];
};

const OPENROUTER = {
  outline: { provider: 'openrouter', model: 'z-ai/glm-5.3' },
  expansion: { provider: 'openrouter', model: 'z-ai/glm-5.3-flash' },
  audit: { provider: 'openrouter', model: 'z-ai/glm-5.3' },
};

const priorKey = process.env.OPENROUTER_API_KEY;
afterEach(() => {
  if (priorKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = priorKey;
});

describe('a configuration this build can serve', () => {
  it('builds a client', () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    expect(modelClientFor(loaded(OPENROUTER), () => undefined)).toHaveProperty('complete');
  });
});

describe('a provider this build cannot talk to', () => {
  it('is refused by name, rather than sending the request somewhere unintended', () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    expect(() =>
      modelClientFor(
        loaded({ ...OPENROUTER, audit: { provider: 'anthropic', model: 'claude-opus-5' } }),
        () => undefined,
      ),
    ).toThrow(/only talk to "openrouter".*"anthropic"/s);
  });

  it('names every unknown provider, not just the first', () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    expect(() =>
      modelClientFor(
        loaded({
          outline: { provider: 'anthropic', model: 'a' },
          expansion: { provider: 'openai', model: 'b' },
          audit: { provider: 'openrouter', model: 'c' },
        }),
        () => undefined,
      ),
    ).toThrow(/"anthropic", "openai"/);
  });
});

describe('a missing credential', () => {
  it('says what to export, and that --dry-run needs none', () => {
    // The two things someone in this state actually wants to know.
    delete process.env.OPENROUTER_API_KEY;
    expect(() => modelClientFor(loaded(OPENROUTER), () => undefined)).toThrow(
      /OPENROUTER_API_KEY is not set/,
    );
    expect(() => modelClientFor(loaded(OPENROUTER), () => undefined)).toThrow(/--dry-run/);
  });
});

describe('the lazy model getter', () => {
  it('is not built until something asks for it', async () => {
    // The whole reason it is a getter: `devflow verify`, `devflow show` and `--dry-run` must keep
    // working on a machine that has never had an API key, and they would not if the composition
    // root demanded one to construct the environment at all.
    delete process.env.OPENROUTER_API_KEY;
    const { makeEnv } = await import('./env.js');
    const env = await makeEnv({ models: { roles: OPENROUTER } }, false, () => undefined);
    expect(() => env.model).toThrow(/OPENROUTER_API_KEY is not set/);
  });

  it('builds one once a credential is present', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    const { makeEnv } = await import('./env.js');
    const env = await makeEnv({ models: { roles: OPENROUTER } }, false, () => undefined);
    expect(env.model).toHaveProperty('complete');
  });
});

describe('call announcements', () => {
  it('name the role, the model, the cost, the duration — and why a retry happened', async () => {
    // A run that spends money silently cannot be audited while it is happening, which is the only
    // time an operator can stop it. This drives the composition root's own callback, not a copy of
    // it, so the string an operator actually sees is the string under test.
    process.env.OPENROUTER_API_KEY = 'test-key';
    const lines: string[] = [];
    const { z } = await import('zod');
    const stub = (async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: '{"wrong":1}' } }], usage: { cost: 0.002 } }),
        {
          status: 200,
        },
      )) as unknown as typeof globalThis.fetch;

    const client = modelClientFor(loaded(OPENROUTER), (line) => lines.push(line), stub);
    await client
      .complete({ role: 'expansion', prompt: 'p', schema: z.strictObject({ a: z.number() }) })
      .catch(() => undefined);

    const said = lines.join('\n');
    expect(said).toContain('expansion z-ai/glm-5.3-flash');
    expect(said).toContain('$0.0020');
    expect(said).toContain('retry');
    // The reason, not just the fact. A retry with no cause is a line that teaches nothing.
    expect(said).toContain('a:');
  });

  it('says ok, and adds no reason, when the answer parsed', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    const lines: string[] = [];
    const { z } = await import('zod');
    const stub = (async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: '{"a":1}' } }], usage: { cost: 0.002 } }),
        {
          status: 200,
        },
      )) as unknown as typeof globalThis.fetch;

    await modelClientFor(loaded(OPENROUTER), (line) => lines.push(line), stub).complete({
      role: 'expansion',
      prompt: 'p',
      schema: z.strictObject({ a: z.number() }),
    });
    expect(lines.join('\n')).toContain('attempt 1 ok');
    expect(lines.join('\n')).not.toContain('—');
  });
});
