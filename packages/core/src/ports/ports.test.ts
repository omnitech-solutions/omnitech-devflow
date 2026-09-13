import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  FakeClock,
  FakeInspector,
  FakeKnowledgeStore,
  FakeModelClient,
  FakeProcessRunner,
} from './__fakes__/index.js';
import { heartbeat, ModelOutputInvalid, type Supervision, shouldStop } from './index.js';

/**
 * Tested through the ports, not around them. Every case here is a failure that actually happened
 * in the tool this one replaces; the comment on each says which.
 */

const NO_LIMIT: Supervision = { silenceMs: 0, capMs: 0 };
const FIVE_MIN: Supervision = { silenceMs: 300_000, capMs: 0 };

describe('supervision: slow is not stuck', () => {
  const cases: ReadonlyArray<{
    name: string;
    elapsed: number;
    sinceOutput: number;
    s: Supervision;
    expected: ReturnType<typeof shouldStop>;
  }> = [
    {
      name: 'quiet but inside the cap',
      elapsed: 60_000,
      sinceOutput: 60_000,
      s: FIVE_MIN,
      expected: 'continue',
    },
    { name: 'silent past the cap', elapsed: 300_000, sinceOutput: 300_000, s: FIVE_MIN, expected: 'silence' },
    // The six-minute thinker. It emitted nothing for 407s and then produced a correct answer; a
    // 300s cap killed it twice before the cap was raised. With the cap off, it must survive.
    {
      name: 'six minutes of legitimate silence, no cap set',
      elapsed: 407_000,
      sinceOutput: 407_000,
      s: NO_LIMIT,
      expected: 'continue',
    },
    // The thirty-three-minute hang: chatty enough to look alive, never going to finish.
    {
      name: 'total wall clock exceeded even while talking',
      elapsed: 2_000_000,
      sinceOutput: 10,
      s: { silenceMs: 0, capMs: 900_000 },
      expected: 'cap',
    },
    {
      name: 'cap is checked before silence',
      elapsed: 900_000,
      sinceOutput: 900_000,
      s: { silenceMs: 300_000, capMs: 900_000 },
      expected: 'cap',
    },
  ];

  it.each(cases)('$name', ({ elapsed, sinceOutput, s, expected }) => {
    expect(shouldStop(elapsed, sinceOutput, s)).toBe(expected);
  });
});

describe('heartbeat', () => {
  it('reports bytes, not just elapsed time', () => {
    // "300s elapsed" printed beside a dead process sixty-six times and read as progress.
    expect(heartbeat(300_000, 0, 300_000)).toBe('300s elapsed, 0 bytes out, NOTHING for 300s');
  });

  it('stays quiet about silence while output is recent', () => {
    expect(heartbeat(30_000, 4_096, 1_000)).toBe('30s elapsed, 4096 bytes out');
  });
});

describe('FakeProcessRunner', () => {
  const spec = (supervision: Supervision) =>
    ({ argv: ['echo', 'hi'] as const, cwd: '/tmp', supervision }) as const;

  it('lets a slow-but-finishing process finish', async () => {
    const clock = new FakeClock();
    const runner = new FakeProcessRunner(clock, {
      chunks: [[407_000, 'the answer']],
      finishAfterMs: 0,
      code: 0,
    });
    const out = await runner.run(spec(NO_LIMIT));
    expect(out).toMatchObject({ kind: 'exited', code: 0, stdout: 'the answer' });
  });

  it('stops a silent process at the cap, and says how little it saw', async () => {
    const clock = new FakeClock();
    const runner = new FakeProcessRunner(clock, {
      chunks: [[600_000, 'too late']],
      finishAfterMs: 0,
      code: 0,
    });
    const out = await runner.run(spec(FIVE_MIN));
    expect(out).toMatchObject({ kind: 'stalled', reason: 'silence', bytesOut: 0 });
  });

  it('distinguishes a stall from an exit code', async () => {
    // Reporting a kill as `exit 125` is what made a killed stage read like a failed one.
    const clock = new FakeClock();
    const runner = new FakeProcessRunner(clock, { chunks: [], finishAfterMs: 600_000, code: 0 });
    const out = await runner.run(spec(FIVE_MIN));
    expect(out.kind).toBe('stalled');
    expect(out).not.toHaveProperty('code');
  });

  it('keeps a chatty process alive under a silence cap', async () => {
    const clock = new FakeClock();
    const runner = new FakeProcessRunner(clock, {
      chunks: [
        [100_000, 'a'],
        [100_000, 'b'],
        [100_000, 'c'],
      ],
      finishAfterMs: 1_000,
      code: 0,
    });
    const seen: string[] = [];
    const out = await runner.run(spec(FIVE_MIN), (c) => seen.push(c));
    expect(out.kind).toBe('exited');
    expect(seen).toEqual(['a', 'b', 'c']);
  });

  it('carries stderr through both outcomes', async () => {
    const clock = new FakeClock();
    const ok = await new FakeProcessRunner(clock, {
      chunks: [],
      finishAfterMs: 1,
      code: 2,
      stderr: 'boom',
    }).run(spec(NO_LIMIT));
    expect(ok).toMatchObject({ kind: 'exited', code: 2, stderr: 'boom' });

    const stalled = await new FakeProcessRunner(new FakeClock(), {
      chunks: [],
      finishAfterMs: 600_000,
      code: 0,
      stderr: 'partial',
    }).run(spec(FIVE_MIN));
    expect(stalled).toMatchObject({ kind: 'stalled', stderr: 'partial' });
  });
});

describe('FakeClock', () => {
  it('sleeps without sleeping', async () => {
    const clock = new FakeClock();
    const before = clock.monotonicMs();
    await clock.sleep(300_000);
    expect(clock.monotonicMs() - before).toBe(300_000);
  });

  it('moves wall clock and monotonic together', () => {
    const clock = new FakeClock(new Date('2026-09-13T14:21:00.000Z'));
    clock.advance(60_000);
    expect(clock.now().toISOString()).toBe('2026-09-13T14:22:00.000Z');
  });
});

describe('FakeInspector', () => {
  const seeded = new FakeInspector({
    definitions: { installRichTitles: [{ path: 'src/richText.ts', line: 206 }] },
    references: { installRichTitles: [{ path: 'src/Preview.tsx', line: 302 }] },
    files: { 'src/dialog.tsx': ['one', 'two', 'three', 'four'] },
  });

  it('answers definitions and references separately', async () => {
    expect(await seeded.definitionsOf('installRichTitles')).toEqual([{ path: 'src/richText.ts', line: 206 }]);
    expect(await seeded.referencesTo('installRichTitles')).toEqual([{ path: 'src/Preview.tsx', line: 302 }]);
  });

  it('returns empty for an unknown symbol, not a lie', async () => {
    expect(await seeded.definitionsOf('nothingHere')).toEqual([]);
    expect(await seeded.referencesTo('nothingHere')).toEqual([]);
  });

  it('reads lines 1-indexed and inclusive, the way a citation names them', async () => {
    expect(await seeded.readLines('src/dialog.tsx', 2, 3)).toEqual(['two', 'three']);
  });

  it('returns null for an unreadable path rather than an empty array', async () => {
    // Empty would mean "the file has no such lines". Null means "there is no file". Evidence
    // depends on the difference: one is `struck`, the other `unverifiable`.
    expect(await seeded.readLines('src/missing.ts', 1, 1)).toBeNull();
  });

  it('can report itself unavailable', async () => {
    expect(await new FakeInspector({ available: false }).available()).toBe(false);
    expect(await seeded.available()).toBe(true);
  });
});

describe('FakeKnowledgeStore', () => {
  const entry = (over: Partial<Parameters<FakeKnowledgeStore['append']>[0]>) => ({
    kind: 'warning' as const,
    scope: 'src/adapter',
    text: 'textTemplates is only populated for piped text',
    source: 'rich-titles/1',
    verified: true,
    at: '2026-09-13T14:21:00.000Z',
    ...over,
  });

  it('loads verified entries whose scope prefixes the query', async () => {
    const store = new FakeKnowledgeStore([entry({})]);
    expect(await store.forScope('src/adapter/runtime.ts')).toHaveLength(1);
  });

  it('never feeds an unverified learning forward', async () => {
    // A learning from an escalated step is kept for a human and never put back into a prompt,
    // or the system teaches itself its own mistakes with increasing confidence.
    const store = new FakeKnowledgeStore([entry({ verified: false })]);
    expect(await store.forScope('src/adapter/runtime.ts')).toEqual([]);
    expect(await store.all()).toHaveLength(1);
  });

  it('ignores entries from an unrelated scope', async () => {
    const store = new FakeKnowledgeStore([entry({ scope: 'server/email' })]);
    expect(await store.forScope('src/adapter')).toEqual([]);
  });

  it('appends rather than replaces', async () => {
    const store = new FakeKnowledgeStore([entry({})]);
    await store.append(entry({ text: 'second' }));
    expect(await store.all()).toHaveLength(2);
  });
});

describe('FakeModelClient', () => {
  const outlineSchema = z.strictObject({ steps: z.array(z.string()) });

  it('parses its scripted answer through the request schema', async () => {
    const model = new FakeModelClient({ outline: [{ steps: ['measure', 'fix'] }] });
    const res = await model.complete({ role: 'outline', prompt: 'plan it', schema: outlineSchema });
    expect(res.value.steps).toEqual(['measure', 'fix']);
    expect(res.cost.microUsd).toBe(1_000);
  });

  it('refuses a scripted answer that does not match the contract', async () => {
    // A fake that returned its script unparsed would let a wrong-shaped expectation pass here and
    // fail only in production, which is the opposite of what a fake is for.
    const model = new FakeModelClient({ outline: [{ nope: true }] });
    await expect(
      model.complete({ role: 'outline', prompt: 'p', schema: outlineSchema }),
    ).rejects.toBeInstanceOf(ModelOutputInvalid);
  });

  it('records which role was asked, and what', async () => {
    const model = new FakeModelClient({ outline: [{ steps: [] }], expansion: [{ steps: ['x'] }] });
    await model.complete({ role: 'outline', prompt: 'first', schema: outlineSchema });
    await model.complete({ role: 'expansion', prompt: 'second', schema: outlineSchema });
    expect(model.calls).toEqual([
      { role: 'outline', prompt: 'first' },
      { role: 'expansion', prompt: 'second' },
    ]);
  });

  it('throws when a role is asked more times than scripted', async () => {
    const model = new FakeModelClient({ outline: [{ steps: [] }] });
    await model.complete({ role: 'outline', prompt: 'p', schema: outlineSchema });
    await expect(model.complete({ role: 'outline', prompt: 'p', schema: outlineSchema })).rejects.toThrow(
      /asked 2 times, 1 scripted/,
    );
  });

  it('throws for a role with no script at all', async () => {
    const model = new FakeModelClient({});
    await expect(model.complete({ role: 'audit', prompt: 'p', schema: outlineSchema })).rejects.toThrow(
      /0 scripted/,
    );
  });
});
