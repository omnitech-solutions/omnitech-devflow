import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import {
  claimSchema,
  devflowResultSchema,
  type Evidence,
  evidenceSchema,
  type Money,
  moneySchema,
  planSchema,
  runEventSchema,
  runIdSchema,
  stepSchema,
  summarise,
  type taskIdSchema,
  taskSchema,
} from './index.js';

/**
 * Tested at the level these contracts are actually used: parse or reject. Nothing here reaches
 * into a schema's internals, because the internals are zod's and testing them tests zod.
 *
 * The table is the point. Adding a schema means adding a row, not writing a new describe block —
 * and every schema gets the same unknown-key check for free, which is the one that matters most.
 */

const claim = {
  kind: 'contains' as const,
  text: 'the base class list ends in sm:max-w-lg',
  path: 'src/ui/dialog.tsx',
  // Recorded so a reader can jump there. Never what the gate checks — see claimSchema.
  line: 65,
  fragment: 'sm:max-w-lg',
};

const step = {
  id: 'step-1',
  n: 1,
  title: 'stop stripping the markup',
  dependsOn: [],
  landsIn: ['src/runtime.ts'],
  estimatedDecisions: [{ question: 'which field carries the rich string?' }],
  prohibited: ['passing unsanitised HTML to the DOM'],
  executor: 'agent' as const,
  prompt: 'Replace the strip with the sanitiser the sibling branch already uses.',
  acceptanceCriteria: ['a title carrying <b> survives to element.title'],
  evidence: summarise([{ status: 'verified', claim }]),
};

const plan = {
  id: 'plan-1',
  taskId: 'LGN-2201',
  slug: 'rich-titles',
  title: 'Respondent renders rich question titles',
  createdAt: '2026-09-13T14:21:00.000Z',
  notes: [{ title: 'Source', body: 'the task, as given' }],
  steps: [step],
};

/** One row per schema. `bad` entries each name the rule they are proving. */
const table: ReadonlyArray<{
  name: string;
  schema: z.ZodType;
  good: unknown;
  bad: ReadonlyArray<{ why: string; value: unknown }>;
}> = [
  {
    name: 'claim',
    schema: claimSchema,
    good: claim,
    bad: [
      { why: 'line is 1-indexed, so 0 is not a line', value: { ...claim, line: 0 } },
      { why: 'an empty path is not a path', value: { ...claim, path: '' } },
      { why: 'an unknown kind would silently skip its checker', value: { ...claim, kind: 'vibes' } },
    ],
  },
  // Deliberately NOT here: a `defines` claim with no `symbol`. The schema accepts it and the gate
  // strikes it as `claim-incomplete`. A discriminated union on `kind` could refuse it one layer
  // earlier, but a zod parse error reaches the user as a path-and-code; the gate's message names
  // the claim and says what is missing from it. The better message wins.
  {
    name: 'evidence',
    schema: evidenceSchema,
    good: { status: 'verified', claim },
    bad: [
      {
        why: 'a struck claim must say why, or it is indistinguishable from an unchecked one',
        value: { status: 'struck', claim },
      },
      {
        why: 'a verified claim carrying a failure is a contradiction the type should refuse',
        value: { status: 'verified', claim, failure: 'path-missing', detail: 'x' },
      },
    ],
  },
  {
    name: 'money',
    schema: moneySchema,
    good: { microUsd: 41_000 },
    bad: [
      { why: 'fractions of a minor unit are how budgets drift', value: { microUsd: 0.5 } },
      { why: 'negative spend is not a thing', value: { microUsd: -1 } },
    ],
  },
  {
    name: 'task',
    schema: taskSchema,
    good: {
      id: 'LGN-2201',
      text: 'preview drops rich titles',
      title: 'preview drops rich titles',
      urls: [],
      paths: [],
      symbols: [],
    },
    bad: [
      {
        why: 'a url field that accepts non-urls is a url field in name only',
        value: { id: 'a', text: 'b', title: 'b', urls: ['not a url'], paths: [], symbols: [] },
      },
    ],
  },
  {
    name: 'step',
    schema: stepSchema,
    good: step,
    bad: [{ why: 'step numbers are 1-indexed', value: { ...step, n: 0 } }],
  },
  {
    name: 'plan',
    schema: planSchema,
    good: plan,
    bad: [
      {
        why: 'the slug becomes a filename, so spaces and caps are out',
        value: { ...plan, slug: 'Rich Titles' },
      },
      { why: 'a timestamp that is not one cannot be ordered', value: { ...plan, createdAt: 'yesterday' } },
    ],
  },
  {
    name: 'runEvent',
    schema: runEventSchema,
    good: {
      seq: 0,
      at: '2026-09-13T14:21:00.000Z',
      runId: 'run-1',
      kind: 'run.started',
      taskId: 'LGN-2201',
      mode: 'plan',
    },
    bad: [
      {
        why: 'an unknown event kind would be dropped by the fold in silence',
        value: { seq: 0, at: '2026-09-13T14:21:00.000Z', runId: 'run-1', kind: 'run.exploded' },
      },
      {
        why: 'seq is the ordering key and cannot be negative',
        value: { seq: -1, at: '2026-09-13T14:21:00.000Z', runId: 'run-1', kind: 'step.started', step: 1 },
      },
    ],
  },
  {
    name: 'devflowResult',
    schema: devflowResultSchema,
    good: {
      kind: 'needs-operator',
      runId: 'run-1',
      blockers: [{ step: 4, question: 'what shape does the lookup expect?' }],
      resumeToken: 't',
    },
    bad: [
      {
        why: 'needs-operator with no blocker tells the operator nothing',
        value: { kind: 'needs-operator', runId: 'run-1', blockers: [], resumeToken: 't' },
      },
    ],
  },
];

describe.each(table)('$name', ({ schema, good, bad }) => {
  it('accepts a well-formed value', () => {
    expect(schema.safeParse(good).success).toBe(true);
  });

  it('rejects an unknown key rather than dropping it', () => {
    // strictObject everywhere. A schema that silently discards a field it does not know is how a
    // renamed field becomes a silent no-op instead of an error.
    const withExtra = { ...(good as Record<string, unknown>), somethingNobodyDeclared: true };
    expect(schema.safeParse(withExtra).success).toBe(false);
  });

  it.each(bad)('rejects: $why', ({ value }) => {
    expect(schema.safeParse(value).success).toBe(false);
  });
});

describe('summarise', () => {
  const items: Evidence[] = [
    { status: 'verified', claim },
    { status: 'verified', claim },
    { status: 'struck', claim, failure: 'fragment-not-found', detail: 'line says something else' },
    { status: 'unverifiable', claim, failure: 'inspector-unavailable', detail: 'ast-grep not found' },
  ];

  it('counts each status separately', () => {
    expect(summarise(items)).toMatchObject({ verified: 2, struck: 1, unverifiable: 1 });
  });

  it('keeps struck and unverifiable apart', () => {
    // "I could not look" is not "I looked and it was wrong". Collapsing them lets a broken checker
    // read as a clean plan — the same failure as a guardian reporting PASS because it never ran.
    const r = summarise(items);
    expect(r.struck).not.toBe(r.unverifiable + r.struck);
  });

  it('does not alias its input', () => {
    const input: Evidence[] = [{ status: 'verified', claim }];
    summarise(input).items.push({ status: 'verified', claim });
    expect(input).toHaveLength(1);
  });

  it('produces a report the schema accepts', () => {
    expect(() =>
      planSchema.parse({ ...plan, steps: [{ ...step, evidence: summarise(items) }] }),
    ).not.toThrow();
  });
});

describe('branded ids', () => {
  it('will not let one id be passed where another is expected', () => {
    const runId = runIdSchema.parse('run-1');
    expectTypeOf(runId).not.toMatchTypeOf<z.infer<typeof taskIdSchema>>();
  });
});

describe('money', () => {
  it('is integer minor units, so arithmetic cannot drift', () => {
    const a: Money = moneySchema.parse({ microUsd: 11_000 });
    const b: Money = moneySchema.parse({ microUsd: 43_000 });
    expect(moneySchema.parse({ microUsd: a.microUsd + b.microUsd }).microUsd).toBe(54_000);
  });
});
