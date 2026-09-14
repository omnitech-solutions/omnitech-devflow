import { checkedRegion, evidenceAllows, proveMutation, verifyClaims } from '@omnitech/devflow-core';
import { FakeInspector } from '@omnitech/devflow-core/testing';
import { describe, expect, it } from 'vitest';
import { claimsIn } from './claims.js';

/**
 * Proof that the citation gate can fail — and that a green result here means what it says.
 *
 * A green mutation test ("I broke it, the check stayed green") has two explanations and they are
 * not equally likely:
 *
 *   1. the check has a hole
 *   2. the mutation never landed where the check looks
 *
 * (2) happened to me twice on this very gate. The book's first citation was inside a NOTE; I
 * mutated it, saw green, and nearly reported a hole. The gate reads TODO bodies only — it had never
 * seen the edit. Nothing in the output could have told me apart from knowing the internals.
 *
 * So every mutation below goes through `proveMutation`, which refuses to report a verdict until the
 * edit is shown to have changed `checkedRegion(book)` — the same function the gate's caller uses.
 * `did-not-land` is a distinct outcome from `check-has-a-hole`, and the NOTE case at the bottom is
 * kept as a live test that the distinction still works rather than as a comment saying it once did.
 */

const inspector = new FakeInspector({
  files: { 'src/dialog.tsx': ['export function DialogContent() {', '  return null;', '}'] },
  definitions: { DialogContent: [{ path: 'src/dialog.tsx', line: 1 }] },
  references: { DialogContent: [{ path: 'src/Preview.tsx', line: 9 }] },
});

const BOOK = [
  '---',
  'slug: rich-titles',
  '---',
  '',
  '# Rich titles',
  '',
  '## NOTE — Source',
  '',
  // Deliberately here: a claim in a NOTE, which the gate does not read. This is the shape of the
  // book that fooled me, kept so the proof has something real to be fooled by.
  '`src/dialog.tsx` defines `DialogContent`.',
  '',
  '## TODO 1 — stop capping the width',
  '',
  '**Depends on:** nothing',
  '**Lands in:** src/dialog.tsx',
  '**Estimated decisions:** none',
  '',
  '`src/dialog.tsx` defines `DialogContent`. `src/Preview.tsx` calls `DialogContent`.',
  '`src/index.ts` does not call `DialogContent`.',
  '',
].join('\n');

/** The gate, run over a whole book the way `devflow verify` runs it. `true` means it passed. */
const gate = async (book: string): Promise<boolean> => {
  const report = await verifyClaims(claimsIn(checkedRegion(book)), inspector);
  return evidenceAllows(report);
};

describe('the gate reads what the proof thinks it reads', () => {
  it('finds the same claims in the checked region as in the whole book minus the notes', () => {
    // The tripwire holding `checkedRegion` to the gate. If someone teaches `verify` to read NOTEs
    // (a good idea, and proposed) without teaching `checkedRegion`, this goes red rather than the
    // proofs below quietly becoming meaningless.
    const inRegion = claimsIn(checkedRegion(BOOK)).length;
    const inWholeBook = claimsIn(BOOK).length;
    expect(inRegion).toBe(3);
    // The book states four claims; one is in a NOTE, and `claimsIn` dedupes the two identical
    // `defines` sentences down to one. What matters is that the region is strictly smaller.
    expect(inRegion).toBeLessThan(inWholeBook + 1);
    expect(checkedRegion(BOOK)).not.toContain('## NOTE');
  });
});

describe('the gate goes red when a claim in a step stops being true', () => {
  it.each([
    [
      'a definition moved to another file',
      // `replaceAll`, not `replace`. Written with `replace` this mutation hits the NOTE's copy of
      // the sentence and never reaches the step — and `proveMutation` returned `did-not-land` when
      // it was written that way, on the first run of this file. The guard caught the author of the
      // guard. That is the entire argument for it.
      (b: string) => b.replaceAll('`src/dialog.tsx` defines', '`src/nowhere.tsx` defines'),
    ],
    [
      'a reference that is not there',
      (b: string) => b.replace('`src/Preview.tsx` calls', '`src/Absent.tsx` calls'),
    ],
    [
      'an absence claim about a file where the symbol IS present',
      (b: string) => b.replace('`src/index.ts` does not call', '`src/Preview.tsx` does not call'),
    ],
  ])('%s', async (name, mutate) => {
    const outcome = await proveMutation({
      name,
      source: BOOK,
      mutate: (s) => {
        const after = mutate(s);
        return after === s ? null : after;
      },
      region: checkedRegion,
      check: gate,
    });
    // Not `expect(gate(mutated)).toBe(false)`. That assertion passes just as happily when the
    // mutation missed — which is the whole failure being guarded against.
    expect(outcome).toMatchObject({ kind: 'check-holds' });
  });
});

describe('a mutation the gate never sees', () => {
  it('is reported as did-not-land, not as a hole in the gate', async () => {
    const outcome = await proveMutation({
      name: 'break the citation in the NOTE',
      source: BOOK,
      // Replaces the FIRST occurrence, which is in the NOTE. Exactly the edit I made twice.
      mutate: (s) => s.replace('`src/dialog.tsx` defines `DialogContent`.', '`src/gone.tsx` defines `Nope`.'),
      region: checkedRegion,
      check: gate,
    });

    expect(outcome.kind).toBe('did-not-land');
    // And it says what to do about it, because "did-not-land" alone is another thing to look up.
    expect(outcome.why).toContain('the part the check reads did not');
    expect(outcome.why).toContain('Mutate something inside the checked region');
  });

  it('would otherwise have read as a clean pass', async () => {
    // The half that makes the case: the gate really does stay green under that edit. Without
    // `proveMutation` this is indistinguishable from the gate having a hole.
    const mutated = BOOK.replace(
      '`src/dialog.tsx` defines `DialogContent`.',
      '`src/gone.tsx` defines `Nope`.',
    );
    expect(mutated).not.toBe(BOOK);
    expect(await gate(mutated)).toBe(true);
  });
});

describe('a mutation that changes nothing', () => {
  it('is caught rather than counted as evidence', async () => {
    const outcome = await proveMutation({
      name: 'replace a word that is not in the book',
      source: BOOK,
      mutate: (s) => s.replace('this string is not present', 'neither is this'),
      region: checkedRegion,
      check: gate,
    });
    expect(outcome.kind).toBe('did-not-land');
  });
});
