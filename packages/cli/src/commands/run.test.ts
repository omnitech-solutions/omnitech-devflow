import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelClient, ModelRequest } from '@omnitech/devflow-core';
import { MemoryRunEventStore, resolveConfig } from '@omnitech/devflow-core';
import { FakeClock, FakeInspector } from '@omnitech/devflow-core/testing';
import { describe, expect, it } from 'vitest';
import type { Env } from '../env.js';
import { run } from './run.js';

/**
 * `devflow run`, with a scripted model.
 *
 * The cases that matter are the ones where money is at stake or a brief could be believed when it
 * should not: a step whose own claims are wrong must not be expanded at all, a brief whose claims
 * are wrong must not read as passing, and a dry run must not send anything.
 */

const BOOK = (step = '`src/thing.ts` defines `theThing`.') =>
  [
    '---',
    'name: A task',
    '---',
    '',
    '# A task',
    '',
    '## TODO 1 — do the thing',
    '',
    '**Depends on:** none',
    '**Lands in:** src/thing.ts',
    '**Estimated decisions:** none',
    '',
    step,
    '',
  ].join('\n');

const inspector = new FakeInspector({
  files: { 'src/thing.ts': ['export function theThing() {}'] },
  definitions: { theThing: [{ path: 'src/thing.ts', line: 1 }] },
});

/** A model that answers with whatever it is told to, and counts how often it was asked. */
class ScriptedModel implements ModelClient {
  calls = 0;
  constructor(
    private readonly answer: unknown,
    private readonly costMicroUsd = 1_000,
  ) {}
  async complete<T>(request: ModelRequest<T>) {
    this.calls += 1;
    return {
      value: request.schema.parse(this.answer),
      cost: { microUsd: this.costMicroUsd },
      raw: JSON.stringify(this.answer),
    };
  }
}

const brief = (citations: string[]) => ({
  summary: 'a summary',
  files: ['src/thing.ts'],
  detail: 'the detail',
  citations,
  risks: ['a risk'],
});

function envFor(book: string, model: ModelClient, overrides: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'devflow-run-'));
  const taskRoot = join(dir, '.devflow', 'tasks', 'T-1');
  mkdirSync(taskRoot, { recursive: true });
  writeFileSync(join(taskRoot, 'plan.json'), JSON.stringify({ slug: 's' }));
  writeFileSync(join(taskRoot, 's.book.md'), book);

  const lines: string[] = [];
  const clock = new FakeClock();
  const env = {
    repoRoot: dir,
    config: { ...resolveConfig({ env: {} }), files: [] },
    clock,
    inspector,
    runs: new MemoryRunEventStore(clock),
    branch: 'main',
    verbose: false,
    out: (l: string) => lines.push(l),
    model,
    ...overrides,
  } as unknown as Env & { said: () => string; dir: string };
  env.said = () => lines.join('\n');
  env.dir = taskRoot;
  return env;
}

describe('a step whose own claims hold', () => {
  it('is expanded, and the brief is checked in turn', async () => {
    const model = new ScriptedModel(brief(['`src/thing.ts` defines `theThing`']));
    const env = envFor(BOOK(), model);
    expect(await run(env, 'T-1', {})).toBe(0);
    expect(model.calls).toBe(1);
    expect(env.said()).toContain('✓ step 1');
    expect(env.said()).toContain('every citation checked');
  });

  it('writes the briefs where a human will find them', async () => {
    const env = envFor(BOOK(), new ScriptedModel(brief(['`src/thing.ts` defines `theThing`'])));
    await run(env, 'T-1', {});
    const written = readFileSync(join(env.dir, 'briefs.md'), 'utf8');
    expect(written).toContain('## ✓ Step 1');
    expect(written).toContain('the detail');
  });
});

describe('a step whose own claims do NOT hold', () => {
  it('is never sent to a model', async () => {
    // The point of gating first. A brief built on a false claim reads as authoritative, and paying
    // to produce one is worse than producing nothing.
    const model = new ScriptedModel(brief([]));
    const env = envFor(BOOK('`src/nowhere.ts` defines `theThing`.'), model);
    expect(await run(env, 'T-1', {})).toBe(1);
    expect(model.calls).toBe(0);
  });

  it('says which claim stopped it, and what it is actually true of', async () => {
    const env = envFor(BOOK('`src/nowhere.ts` defines `theThing`.'), new ScriptedModel(brief([])));
    await run(env, 'T-1', {});
    expect(env.said()).toContain('the step’s own claims do not hold'.replace('’', "'"));
    expect(env.said()).toContain('src/thing.ts');
  });

  it('spends nothing', async () => {
    const env = envFor(BOOK('`src/nowhere.ts` defines `theThing`.'), new ScriptedModel(brief([])));
    await run(env, 'T-1', {});
    expect(env.said()).toContain('Spent $0.0000');
  });
});

describe('a brief that cites something untrue', () => {
  it('is reported as failing rather than presented as a result', async () => {
    // Exactly the claims a model is worst at, so they go through the same gate the plan did.
    const env = envFor(BOOK(), new ScriptedModel(brief(['`src/nowhere.ts` defines `theThing`'])));
    expect(await run(env, 'T-1', {})).toBe(1);
    expect(env.said()).toContain('✗ step 1');
    expect(env.said()).toContain('does not hold');
  });

  it('is still written down, so what was claimed can be read', async () => {
    const env = envFor(BOOK(), new ScriptedModel(brief(['`src/nowhere.ts` defines `theThing`'])));
    await run(env, 'T-1', {});
    expect(readFileSync(join(env.dir, 'briefs.md'), 'utf8')).toContain('## ✗ Step 1');
  });

  it('reports a brief that cited nothing without calling it verified', async () => {
    const env = envFor(BOOK(), new ScriptedModel(brief([])));
    await run(env, 'T-1', {});
    expect(env.said()).toContain('the brief cited nothing');
  });
});

describe('--dry-run', () => {
  it('sends nothing and spends nothing', async () => {
    const model = new ScriptedModel(brief([]));
    const env = envFor(BOOK(), model);
    expect(await run(env, 'T-1', { 'dry-run': true })).toBe(0);
    expect(model.calls).toBe(0);
    expect(env.said()).toContain('nothing was sent');
  });

  it('still checks the step’s claims, so it is a real preflight', async () => {
    const env = envFor(BOOK(), new ScriptedModel(brief([])));
    await run(env, 'T-1', { dryRun: true });
    expect(env.said()).toContain('1/1 claims verified');
    expect(env.said()).toContain('would send');
  });
});

describe('the budget', () => {
  const capped = (micro: number) => {
    const base = resolveConfig({ env: {} });
    return {
      config: {
        ...base,
        files: [],
        config: { ...base.config, budgets: { ...base.config.budgets, runMicroUsd: micro } },
      },
    };
  };

  const TWO_STEPS =
    BOOK() +
    '\n## TODO 2 — and again\n\n**Depends on:** none\n**Lands in:** src/thing.ts\n**Estimated decisions:** none\n\n`src/thing.ts` defines `theThing`.\n';

  it('stops the NEXT step once the cap is reached', async () => {
    const model = new ScriptedModel(brief(['`src/thing.ts` defines `theThing`']), 5_000_000);
    const env = envFor(TWO_STEPS, model, capped(1));
    expect(await run(env, 'T-1', {})).toBe(1);
    expect(model.calls).toBe(1); // the second step was never sent
    expect(env.said()).toContain('budget reached');
  });

  it('says plainly when a single step finished over the cap', async () => {
    // The cap cannot stop a call already in flight, and pretending otherwise would need a price
    // table that goes stale. A visible overrun is the honest outcome.
    const env = envFor(
      BOOK(),
      new ScriptedModel(brief(['`src/thing.ts` defines `theThing`']), 5_000_000),
      capped(1),
    );
    await run(env, 'T-1', {});
    expect(env.said()).toContain('Over by $');
    expect(env.said()).toContain('stepMicroUsd');
  });
});

describe('when the model itself fails', () => {
  it('reports why and stops, rather than carrying on with nothing', async () => {
    const broken: ModelClient = {
      async complete() {
        throw new Error('OpenRouter refused the request (402): insufficient credits');
      },
    };
    const env = envFor(BOOK(), broken);
    expect(await run(env, 'T-1', {})).toBe(1);
    expect(env.said()).toContain('insufficient credits');
  });
});

describe('a plan that is not ready', () => {
  it('refuses while a blank remains, and points at verify', async () => {
    const env = envFor(BOOK('<what to do here>'), new ScriptedModel(brief([])));
    expect(await run(env, 'T-1', {})).toBe(1);
    expect(env.said()).toContain('Not ready');
    expect(env.said()).toContain('devflow verify');
  });

  it('says so when the book has no steps at all', async () => {
    const env = envFor(
      '---\nname: T\n---\n\n# T\n\n## NOTE — just context\n\nnothing.\n',
      new ScriptedModel(brief([])),
    );
    expect(await run(env, 'T-1', {})).toBe(1);
    expect(env.said()).toContain('no TODO steps');
  });
});

describe('a task that was never planned', () => {
  it('points at the command that would fix it', async () => {
    const env = envFor(BOOK(), new ScriptedModel(brief([])));
    expect(await run(env, 'MISSING', {})).toBe(2);
    expect(env.said()).toContain('devflow plan MISSING');
  });

  it('says when the book is gone but the plan is not', async () => {
    const env = envFor(BOOK(), new ScriptedModel(brief([])));
    writeFileSync(join(env.dir, 's.book.md'), '');
    const empty = envFor(BOOK(), new ScriptedModel(brief([])));
    mkdirSync(join(empty.repoRoot, '.devflow', 'tasks', 'T-2'), { recursive: true });
    writeFileSync(
      join(empty.repoRoot, '.devflow', 'tasks', 'T-2', 'plan.json'),
      JSON.stringify({ slug: 'gone' }),
    );
    expect(await run(empty, 'T-2', {})).toBe(2);
    expect(empty.said()).toContain('no book for T-2');
  });
});

describe('output the happy path never shows', () => {
  const unbound = () => {
    const base = resolveConfig({ env: {} });
    return {
      config: {
        ...base,
        files: [],
        config: { ...base.config, models: { roles: {} } },
      },
    };
  };

  it('falls back to the slug when the book has lost its frontmatter name', async () => {
    // Books are meant to be hand-edited. Someone deleting the name must not make `run` print
    // "undefined" as the task's title.
    const noName = BOOK().replace('name: A task\n', '');
    const env = envFor(noName, new ScriptedModel(brief([])));
    await run(env, 'T-1', { 'dry-run': true });
    expect(env.said()).toContain('T-1 — s');
    expect(env.said()).not.toContain('undefined');
  });

  it('says the expansion model is unset rather than printing undefined', async () => {
    const env = envFor(BOOK(), new ScriptedModel(brief([])), unbound());
    await run(env, 'T-1', { 'dry-run': true });
    expect(env.said()).toContain('model      (unset)');
  });

  it('reports a thrown non-Error without crashing on it', async () => {
    // A rejected promise carrying a string is rare and entirely possible; losing it to
    // `error.message` being undefined would turn a real failure into a blank line.
    const odd = {
      async complete() {
        throw 'a bare string';
      },
    } as unknown as ModelClient;
    const env = envFor(BOOK(), odd);
    expect(await run(env, 'T-1', {})).toBe(1);
    expect(env.said()).toContain('a bare string');
  });

  it('marks an unverifiable brief citation with ? rather than X', async () => {
    // Same distinction the plan gate makes: "I could not look" is not "I looked and it was wrong".
    // The step itself must cite nothing, or the PRE gate stops the run before a model is called —
    // a step that is entirely unverifiable has proved nothing and is treated as blocked. That is
    // correct, and it is why this case needs a step with no claims of its own.
    const env = envFor(
      BOOK('Just do the thing.'),
      new ScriptedModel(brief(['`src/thing.ts` defines `theThing`'])),
      {
        inspector: new FakeInspector({ available: false }),
      },
    );
    await run(env, 'T-1', {});
    expect(env.said()).toContain('? the code inspector could not run');
  });

  it('renders an em dash when a brief names no files', async () => {
    const env = envFor(
      BOOK(),
      new ScriptedModel({
        summary: 's',
        files: [],
        detail: 'd',
        citations: ['`src/thing.ts` defines `theThing`'],
        risks: ['r'],
      }),
    );
    await run(env, 'T-1', {});
    expect(readFileSync(join(env.dir, 'briefs.md'), 'utf8')).toContain('**Files:** —');
  });
});
