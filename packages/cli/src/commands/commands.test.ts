import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunId, TaskId } from '@omnitech/devflow-contracts';
import { MemoryRunEventStore, resolveConfig } from '@omnitech/devflow-core';
import { FakeClock, FakeInspector } from '@omnitech/devflow-core/testing';
import { describe, expect, it } from 'vitest';
import type { Env } from '../env.js';
import { discover } from './discover.js';
import { doctor } from './doctor.js';
import { show } from './show.js';
import { claimsIn, verify } from './verify.js';

/**
 * The command paths that only appear when the environment is wrong.
 *
 * Constructed with fakes rather than a temp repository, because "the code inspector cannot parse"
 * and "a step already passed" are states you cannot stage on disk — and they are exactly the
 * states a reader most needs the output to be right about.
 */

const envWith = (over: Partial<Env> = {}): Env => {
  const lines: string[] = [];
  const clock = new FakeClock();
  const env = {
    repoRoot: '/work/repo',
    config: { ...resolveConfig({ env: {} }), files: [] },
    clock,
    inspector: new FakeInspector(),
    runs: new MemoryRunEventStore(clock),
    branch: 'main',
    verbose: false,
    out: (l: string) => lines.push(l),
    ...over,
  } as unknown as Env & { said: () => string };
  env.said = () => lines.join('\n');
  return env;
};

describe('doctor when the inspector cannot run', () => {
  it('says STOP, explains the consequence, and names the fix', async () => {
    // The one blocking check: with no inspector, every structural claim would come back
    // unverifiable, so a plan would look clean while proving nothing.
    const env = envWith({ inspector: new FakeInspector({ available: false }) });
    const code = await doctor(env);
    const said = (env as Env & { said: () => string }).said();
    expect(code).toBe(1);
    expect(said).toContain('STOP');
    expect(said).toContain('every structural claim would be unverifiable');
    expect(said).toContain('pnpm install');
    expect(said).toContain('1 blocking');
  });

  it('reports zero blocking when it can', async () => {
    const env = envWith();
    expect(await doctor(env)).toBe(0);
    expect((env as Env & { said: () => string }).said()).toContain('0 blocking');
  });
});

describe('show, once work has actually happened', () => {
  const RUN = 'T-1-2026-01-01T00-00-00-000Z' as RunId;

  it('marks execution active once a step has passed', async () => {
    const env = envWith();
    await env.runs.append(RUN, { kind: 'run.started', taskId: 'T-1' as TaskId, mode: 'run' });
    await env.runs.append(RUN, { kind: 'step.started', step: 1 });
    await env.runs.append(RUN, { kind: 'step.passed', step: 1 });
    await show(env, 'T-1', false);
    expect((env as Env & { said: () => string }).said()).toContain('● execution');
  });

  it('shows a dash for a run that recorded no start', async () => {
    const env = envWith();
    await env.runs.append(RUN, { kind: 'step.started', step: 1 });
    await show(env, 'T-1', false);
    expect((env as Env & { said: () => string }).said()).toContain('started    —');
  });
});

describe('claimsIn', () => {
  it('reads "X is defined in path"', () => {
    expect(claimsIn('`installRichTitles` is defined in `src/richText.ts:206`')).toEqual([
      {
        kind: 'defines',
        text: expect.any(String),
        path: 'src/richText.ts',
        line: 206,
        symbol: 'installRichTitles',
      },
    ]);
  });

  it('reads the same claim written the other way round', () => {
    expect(claimsIn('`src/richText.ts` defines `installRichTitles`')).toEqual([
      expect.objectContaining({ kind: 'defines', path: 'src/richText.ts', symbol: 'installRichTitles' }),
    ]);
  });

  it('reads "path calls X"', () => {
    expect(claimsIn('`src/Preview.tsx` calls `installRichTitles`')).toEqual([
      expect.objectContaining({ kind: 'references', path: 'src/Preview.tsx', symbol: 'installRichTitles' }),
    ]);
  });

  it('reads "path contains `text`"', () => {
    expect(claimsIn('`src/ui/dialog.tsx` contains `sm:max-w-lg`')).toEqual([
      expect.objectContaining({ kind: 'contains', path: 'src/ui/dialog.tsx', fragment: 'sm:max-w-lg' }),
    ]);
  });

  it('does not read a negative claim as its own opposite', () => {
    // Load-bearing, and the reason `absent` is matched before `references`: "does not call X"
    // literally contains "call `X`". Matched in the other order, one sentence would produce two
    // contradictory claims and the step would fail against itself.
    expect(claimsIn('`src/Respondent.tsx` does not call `installRichTitles`')).toEqual([
      expect.objectContaining({ kind: 'absent', path: 'src/Respondent.tsx', symbol: 'installRichTitles' }),
    ]);
  });

  it('reads a claim per sentence, not just the first', () => {
    expect(claimsIn('`a/b.ts` defines `foo`, and `c/d.tsx` calls `foo`')).toHaveLength(2);
  });

  it('reads the same claim stated twice as one', () => {
    expect(claimsIn('`a/b.ts` defines `foo`. To repeat: `a/b.ts` defines `foo`.')).toHaveLength(1);
  });

  it('makes no claim from a bare pointer', () => {
    // Changed deliberately. "see `src/a.ts:65`" used to become a claim that the gate would pass by
    // checking a line number — which proved nothing and read as evidence. Nothing is asserted here,
    // so nothing is claimed, and `verify` says "no citations" instead of showing a green tick.
    expect(claimsIn('see `src/a.ts:65` for the detail')).toEqual([]);
  });

  it('ignores prose that merely looks like a path', () => {
    expect(claimsIn('the ratio was 3:1 and the file is elsewhere')).toEqual([]);
  });

  it('ignores a claim-shaped sentence about something that is not a file', () => {
    // A path names a file. Without the extension test this reads as a claim about a file called
    // `notes`, which verify would then strike as path-missing — a red mark on ordinary prose.
    expect(claimsIn('`notes` defines `theTerm` for the rest of this plan')).toEqual([]);
  });
});

describe('notes are checked, and reported apart from the steps', () => {
  const bookWith = (note: string, step: string) =>
    `---\nname: T\n---\n\n# T\n\n## NOTE — Source-tree mapping\n\n${note}\n\n## TODO 1 — do the thing\n\n${step}\n`;

  const onDisk = (taskId: string, book: string): string => {
    const dir = mkdtempSync(join(tmpdir(), 'devflow-notes-'));
    const taskRoot = join(dir, '.devflow', 'tasks', taskId);
    mkdirSync(taskRoot, { recursive: true });
    writeFileSync(join(taskRoot, 'plan.json'), JSON.stringify({ slug: 's' }));
    writeFileSync(join(taskRoot, 's.book.md'), book);
    return dir;
  };

  const inspector = new FakeInspector({
    definitions: { theThing: [{ path: 'src/thing.ts', line: 12 }] },
  });

  it('reports a wrong claim in a note', async () => {
    // The gap that mattered most: discovery writes its source-tree mapping into the notes, so the
    // plan's most factual claims were the only ones nobody checked.
    const dir = onDisk(
      'T-20',
      bookWith('`src/elsewhere.ts` defines `theThing`.', '`src/thing.ts` defines `theThing`.'),
    );
    const env = envWith({ repoRoot: dir, inspector });
    await verify(env, 'T-20');
    const said = (env as Env & { said: () => string }).said();
    expect(said).toContain('Notes — 1 claim(s) checked, 1 wrong');
    expect(said).toContain('it is in src/thing.ts');
  });

  it('does not block on it — a note is context, not an instruction', async () => {
    // A stale briefing should not stop work the way a wrong step must, so the exit code stays 0
    // and the step's own verdict is what decides.
    const dir = onDisk(
      'T-21',
      bookWith('`src/elsewhere.ts` defines `theThing`.', '`src/thing.ts` defines `theThing`.'),
    );
    const env = envWith({ repoRoot: dir, inspector });
    expect(await verify(env, 'T-21')).toBe(0);
    expect((env as Env & { said: () => string }).said()).toContain('does not block');
  });

  it('says why it is worth fixing anyway', async () => {
    const dir = onDisk(
      'T-22',
      bookWith('`src/elsewhere.ts` defines `theThing`.', '`src/thing.ts` defines `theThing`.'),
    );
    const env = envWith({ repoRoot: dir, inspector });
    await verify(env, 'T-22');
    expect((env as Env & { said: () => string }).said()).toContain('written against the wrong');
  });

  it('lists only the notes that actually cite something', async () => {
    // A book has many notes — Source, Posture, Hard rules, Out of scope. Most are prose. Printing
    // a row for each would bury the one note that has a fact in it.
    const book =
      '---\nname: T\n---\n\n# T\n\n## NOTE — Posture\n\nProse, no citations.\n\n' +
      '## NOTE — Source-tree mapping\n\n`src/thing.ts` defines `theThing`.\n\n' +
      '## TODO 1 — do it\n\n`src/thing.ts` defines `theThing`.\n';
    const env = envWith({ repoRoot: onDisk('T-25', book), inspector });
    await verify(env, 'T-25');
    const said = (env as Env & { said: () => string }).said();
    expect(said).toContain('Source-tree mapping');
    expect(said).not.toContain('Posture');
  });

  it('marks an unverifiable note claim with ? rather than ✗', async () => {
    // Same distinction the steps make. "I could not look" is not "I looked and the briefing was
    // wrong", and a reader deciding whether to trust the plan needs to know which one happened.
    const env = envWith({
      repoRoot: onDisk('T-26', bookWith('`src/thing.ts` defines `theThing`.', 'no citations here')),
      inspector: new FakeInspector({ available: false }),
    });
    await verify(env, 'T-26');
    const said = (env as Env & { said: () => string }).said();
    expect(said).toContain('? the code inspector could not run');
    expect(said).not.toContain('✗ the code inspector');
  });

  it('stays quiet when the notes cite nothing', async () => {
    const dir = onDisk(
      'T-23',
      bookWith('Some prose with no citations.', '`src/thing.ts` defines `theThing`.'),
    );
    const env = envWith({ repoRoot: dir, inspector });
    await verify(env, 'T-23');
    expect((env as Env & { said: () => string }).said()).not.toContain('Notes —');
  });

  it('calls out a plan whose notes hold but whose steps cite nothing', async () => {
    // Reads as a clean run otherwise, and it is the more dangerous shape: the briefing was checked
    // and the part an executor will act on was not.
    const dir = onDisk('T-24', bookWith('`src/thing.ts` defines `theThing`.', 'Just do it.'));
    const env = envWith({ repoRoot: dir, inspector });
    expect(await verify(env, 'T-24')).toBe(0);
    const said = (env as Env & { said: () => string }).said();
    expect(said).toContain('no STEP cites the code');
    expect(said).not.toContain('Every citation holds');
  });
});

describe('verify, on a book that is not quite what DevFlow wrote', () => {
  it('falls back to the slug when the book has lost its name', async () => {
    // Books are meant to be hand-edited; someone deleting the frontmatter name must not crash the
    // one command that tells them whether their edits hold up.
    const dir = mkdtempSync(join(tmpdir(), 'devflow-verify-'));
    const taskRoot = join(dir, '.devflow', 'tasks', 'T-9');
    mkdirSync(taskRoot, { recursive: true });
    writeFileSync(join(taskRoot, 'plan.json'), JSON.stringify({ slug: 'the-slug' }));
    writeFileSync(
      join(taskRoot, 'the-slug.book.md'),
      '---\nslug: the-slug\n---\n\n# T\n\n## TODO 1 — a step\n\nnothing cited\n',
    );

    const env = envWith({ repoRoot: dir });
    await verify(env, 'T-9');
    expect((env as Env & { said: () => string }).said()).toContain('T-9 — the-slug');
  });

  it('marks an unverifiable claim with ? rather than ✗', async () => {
    // "I could not look" is not "I looked and it was wrong", and the two must not share a symbol.
    const dir = mkdtempSync(join(tmpdir(), 'devflow-verify-'));
    const taskRoot = join(dir, '.devflow', 'tasks', 'T-10');
    mkdirSync(taskRoot, { recursive: true });
    writeFileSync(join(taskRoot, 'plan.json'), JSON.stringify({ slug: 's' }));
    writeFileSync(
      join(taskRoot, 's.book.md'),
      '---\nname: T\n---\n\n# T\n\n## TODO 1 — a step\n\n`src/a.ts` defines `theCap`\n',
    );

    const env = envWith({ repoRoot: dir, inspector: new FakeInspector({ available: false }) });
    await verify(env, 'T-10');
    const said = (env as Env & { said: () => string }).said();
    expect(said).toContain('? ');
    expect(said).not.toContain('✗ ');
  });
});

describe('discover outside a checkout', () => {
  it('passes no branch rather than an empty one', async () => {
    // `branchOf` returns undefined when git cannot answer. Passing `branch: undefined` through to
    // intake would make it build a RegExp against nothing; omitting the key is the contract.
    const dir = mkdtempSync(join(tmpdir(), 'devflow-nogit-'));
    const env = envWith({ repoRoot: dir, branch: undefined });
    expect(await discover(env, 'a task with no ticket and no branch')).toBe(0);
    expect((env as Env & { said: () => string }).said()).toContain('a task with no ticket and no branch');
  });
});
