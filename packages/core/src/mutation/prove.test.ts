import { describe, expect, it } from 'vitest';
import { parseBook } from '../book/parse.js';
import { type MutationOutcome, proved, proveMutation, proveMutationOnFile } from './prove.js';

/**
 * The proof that today's failure cannot recur.
 *
 * The failure: a citation inside a NOTE was mutated, the check that reads only STEPS was run, it
 * stayed green, and that green was nearly reported as "the check has a hole". It did not have a
 * hole. The mutation never reached it.
 *
 * The first test below is that exact scenario, and it must come back `did-not-land`.
 */

/** A book with the same citation in a note and in a step — the shape that caused the failure. */
const BOOK = [
  '---',
  'slug: b',
  '---',
  '',
  '# A book',
  '',
  '## NOTE — Source-tree mapping',
  '',
  '| `EmailDeliveryAdapter` | `server/delivery.ts:518` |',
  '',
  '## TODO 1 — add the guard',
  '',
  'The adapter is at `server/delivery.ts:518`.',
  '',
].join('\n');

/** What `verify` actually reads: TODO steps, never notes. */
const stepsOnly = (source: string): string =>
  parseBook(source)
    .rows.filter((r) => r.type === 'todo')
    .map((r) => r.body)
    .join('\n');

/** Stands in for the citation gate: green unless a step cites a line other than 518. */
const gate = (source: string): boolean => !/server\/delivery\.ts:(?!518\b)\d+/.test(stepsOnly(source));

/** Replace the FIRST occurrence — the mistake that started this. */
const firstOccurrence = (source: string) =>
  source.replace('server/delivery.ts:518', 'server/delivery.ts:600');

/** Replace only inside the step. */
const insideTheStep = (source: string) =>
  source.replace(
    'The adapter is at `server/delivery.ts:518`.',
    'The adapter is at `server/delivery.ts:600`.',
  );

describe('the failure that prompted this module', () => {
  it('reports did-not-land when the mutation hits a note and the check reads only steps', async () => {
    // Today's exact bug. The first occurrence of the citation is in the note, so the gate never
    // sees the change — and a green result here means nothing at all.
    const outcome = await proveMutation({
      name: 'first-occurrence',
      source: BOOK,
      mutate: firstOccurrence,
      region: stepsOnly,
      check: gate,
    });

    expect(outcome.kind).toBe('did-not-land');
    expect(outcome.why).toContain('the part the check reads did not');
    expect(proved(outcome)).toBe(false);
  });

  it('never reports a hole for a mutation that did not land', async () => {
    // The property that matters: `did-not-land` and `check-has-a-hole` are different verdicts and
    // the first can never be mistaken for the second.
    const outcome = await proveMutation({
      name: 'first-occurrence',
      source: BOOK,
      mutate: firstOccurrence,
      region: stepsOnly,
      check: gate,
    });
    expect(outcome.kind).not.toBe('check-has-a-hole');
    expect(outcome.kind).not.toBe('check-holds');
  });

  it('proves the check holds once the mutation lands in the right place', async () => {
    const outcome = await proveMutation({
      name: 'inside-the-step',
      source: BOOK,
      mutate: insideTheStep,
      region: stepsOnly,
      check: gate,
    });
    expect(outcome.kind).toBe('check-holds');
    expect(proved(outcome)).toBe(true);
  });
});

describe('every way a mutation can fail to mean anything', () => {
  const spec = (mutate: (s: string) => string | null) => ({
    name: 'm',
    source: BOOK,
    mutate,
    region: stepsOnly,
    check: gate,
  });

  it.each<[string, (s: string) => string | null, string]>([
    ['the target is not in the source', () => null, 'could not be applied'],
    ['the edit produced identical text', (s) => s, 'byte-identical'],
    ['the edit changed only what the check ignores', firstOccurrence, 'the part the check reads'],
  ])('says did-not-land when %s', async (_what, mutate, why) => {
    const outcome = await proveMutation(spec(mutate));
    expect(outcome.kind).toBe('did-not-land');
    expect(outcome.why).toContain(why);
  });

  it('reports a genuine hole when the mutation lands and the check still passes', async () => {
    // A check that looks at nothing passes everything. That IS a hole, and it must be named as one
    // — this is the verdict `did-not-land` must never be confused with.
    const outcome = await proveMutation({
      name: 'blind-check',
      source: BOOK,
      mutate: insideTheStep,
      region: stepsOnly,
      check: () => true,
    });
    expect(outcome.kind).toBe('check-has-a-hole');
    expect(proved(outcome)).toBe(false);
  });

  it('awaits an asynchronous check', async () => {
    const outcome = await proveMutation({
      name: 'async',
      source: BOOK,
      mutate: insideTheStep,
      region: stepsOnly,
      check: async (s) => gate(s),
    });
    expect(outcome.kind).toBe('check-holds');
  });
});

describe('on a file, where a restore can silently fail', () => {
  /** A tiny in-memory disk, so a broken restore can be staged deliberately. */
  const disk = (initial: Record<string, string>) => {
    const files = { ...initial };
    return {
      files,
      read: async (p: string) => files[p] as string,
      write: async (p: string, t: string) => {
        files[p] = t;
      },
    };
  };

  it('restores the file and says the check holds', async () => {
    const d = disk({ 'book.md': BOOK });
    const outcome = await proveMutationOnFile({
      name: 'inside-the-step',
      path: 'book.md',
      read: d.read,
      write: d.write,
      mutate: insideTheStep,
      region: stepsOnly,
      check: () => gate(d.files['book.md'] as string),
    });
    expect(outcome.kind).toBe('check-holds');
    expect(d.files['book.md']).toBe(BOOK);
  });

  it('reports restore-failed instead of a verdict it cannot stand behind', async () => {
    // The `cp -i` failure, staged: the restore silently does not happen. A later run would be
    // checking mutated code and calling it green, which is how this whole class of bug hides.
    const d = disk({ 'book.md': BOOK });
    let writes = 0;
    const outcome = await proveMutationOnFile({
      name: 'restore-blocked',
      path: 'book.md',
      read: d.read,
      write: async (p, t) => {
        writes += 1;
        // The first write (the mutation) lands; the second (the restore) is swallowed.
        if (writes === 1) await d.write(p, t);
      },
      mutate: insideTheStep,
      region: stepsOnly,
      check: () => gate(d.files['book.md'] as string),
    });

    expect(outcome.kind).toBe('restore-failed');
    expect(outcome.why).toContain('was NOT restored');
    expect(proved(outcome)).toBe(false);
  });

  it('names a hole on disk too, rather than only in memory', async () => {
    // The file path must reach the same verdict as the text path: a check that looks at nothing
    // passes everything, and that is a hole wherever it is found.
    const d = disk({ 'book.md': BOOK });
    const outcome = await proveMutationOnFile({
      name: 'blind-check-on-disk',
      path: 'book.md',
      read: d.read,
      write: d.write,
      mutate: insideTheStep,
      region: stepsOnly,
      check: () => true,
    });
    expect(outcome.kind).toBe('check-has-a-hole');
    expect(d.files['book.md']).toBe(BOOK);
  });

  it('restores even when the check throws', async () => {
    const d = disk({ 'book.md': BOOK });
    await expect(
      proveMutationOnFile({
        name: 'throwing-check',
        path: 'book.md',
        read: d.read,
        write: d.write,
        mutate: insideTheStep,
        region: stepsOnly,
        check: () => {
          throw new Error('the check blew up');
        },
      }),
    ).rejects.toThrow('the check blew up');
    // A check that throws must not leave mutated code on disk.
    expect(d.files['book.md']).toBe(BOOK);
  });

  it.each<[string, (s: string) => string | null]>([
    ['it cannot apply', () => null],
    ['it changes nothing', (s) => s],
    ['it misses the checked region', firstOccurrence],
  ])('does not touch the file when the mutation is pointless because %s', async (_why, mutate) => {
    const d = disk({ 'book.md': BOOK });
    let writes = 0;
    const outcome = await proveMutationOnFile({
      name: 'pointless',
      path: 'book.md',
      read: d.read,
      write: async (p, t) => {
        writes += 1;
        await d.write(p, t);
      },
      mutate,
      region: stepsOnly,
      check: () => true,
    });
    expect(outcome.kind).toBe('did-not-land');
    // Nothing was written, so there is nothing that could have been left behind.
    expect(writes).toBe(0);
    expect(d.files['book.md']).toBe(BOOK);
  });
});

describe('proved()', () => {
  it.each<[MutationOutcome['kind'], boolean]>([
    ['check-holds', true],
    ['check-has-a-hole', false],
    ['did-not-land', false],
    ['restore-failed', false],
  ])('%s counts as proved: %s', (kind, expected) => {
    expect(proved({ kind, why: '' } as MutationOutcome)).toBe(expected);
  });
});
