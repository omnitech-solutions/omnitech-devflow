import type { Claim } from '@omnitech/devflow-contracts';
import { describe, expect, it } from 'vitest';
import { FakeInspector } from '../ports/__fakes__/index.js';
import { evidenceAllows, verifyClaim, verifyClaims } from './verify.js';

/**
 * The gate, tested as the function it is.
 *
 * The organising property of every case: **a claim that is true must stay true when the file is
 * edited elsewhere.** The previous design anchored to line numbers and failed that — running a
 * formatter would have struck a plan full of correct claims, and a gate that cries wolf is a gate
 * people learn to skip.
 */

const DIALOG = [
  'import { cn } from "./utils";',
  '',
  'export function DialogContent({ className }: Props) {',
  '  return <div className={cn("grid w-full gap-4 sm:max-w-lg", className)} />;',
  '}',
];

const inspector = new FakeInspector({
  files: { 'src/dialog.tsx': DIALOG },
  definitions: {
    installRichTitles: [{ path: 'src/richText.ts', line: 206 }],
    DialogContent: [{ path: 'src/dialog.tsx', line: 3 }],
  },
  references: {
    installRichTitles: [
      { path: 'src/Preview.tsx', line: 302 },
      { path: 'src/fidelity.ts', line: 43 },
    ],
  },
});

const claim = (over: Partial<Claim>): Claim => ({
  kind: 'defines',
  text: 'a claim',
  path: 'src/richText.ts',
  symbol: 'installRichTitles',
  ...over,
});

describe('the property that matters: an edit elsewhere must not break a true claim', () => {
  it('holds when the symbol has moved to a different line', async () => {
    // Someone added an import at the top of richText.ts. Every line below shifted. The claim that
    // the file DEFINES the symbol is exactly as true as it was.
    const evidence = await verifyClaim(claim({ line: 40 }), inspector);
    expect(evidence.status).toBe('verified');
  });

  it('reports where it moved to, because that is when a reader wants to know', async () => {
    const evidence = await verifyClaim(claim({ line: 40 }), inspector);
    expect(evidence).toMatchObject({ status: 'verified', movedTo: 206 });
  });

  it('says nothing about movement when the line is still right', async () => {
    expect(await verifyClaim(claim({ line: 206 }), inspector)).not.toHaveProperty('movedTo');
  });

  it('holds when the claim records no line at all', async () => {
    expect((await verifyClaim(claim({}), inspector)).status).toBe('verified');
  });
});

describe('defines', () => {
  it('is struck when the symbol lives in another file, and says which', async () => {
    const e = await verifyClaim(claim({ path: 'src/Respondent.tsx' }), inspector);
    expect(e).toMatchObject({ status: 'struck', failure: 'symbol-not-defined-here' });
    expect((e as { detail: string }).detail).toContain('src/richText.ts');
  });

  it('is struck when the symbol is defined nowhere that was searched', async () => {
    const e = await verifyClaim(claim({ symbol: 'neverDefined' }), inspector);
    expect((e as { detail: string }).detail).toContain('nowhere that was searched');
  });

  it('does not accept a mere reference as a definition', async () => {
    // `Preview.tsx` calls it; it does not define it. Collapsing the two would make the strongest
    // claim in a plan the weakest.
    const e = await verifyClaim(claim({ path: 'src/Preview.tsx' }), inspector);
    expect(e.status).toBe('struck');
  });
});

describe('references', () => {
  it('holds for a call site', async () => {
    const e = await verifyClaim(claim({ kind: 'references', path: 'src/Preview.tsx' }), inspector);
    expect(e.status).toBe('verified');
  });

  it('holds in the file that defines it — defining is using', async () => {
    const e = await verifyClaim(claim({ kind: 'references', path: 'src/richText.ts' }), inspector);
    expect(e.status).toBe('verified');
  });

  it('is struck where the symbol does not appear', async () => {
    const e = await verifyClaim(claim({ kind: 'references', path: 'src/Respondent.tsx' }), inspector);
    expect(e).toMatchObject({ status: 'struck', failure: 'symbol-not-referenced-here' });
  });
});

describe('absent — the claim that settles design questions', () => {
  it('holds when the symbol really is not used there', async () => {
    // "Respondent.tsx never calls installRichTitles" is what settled whether the respondent could
    // render rich titles at all. A gate that cannot express this cannot check the useful half of
    // a plan.
    const e = await verifyClaim(
      claim({ kind: 'absent', path: 'src/Respondent.tsx', symbol: 'installRichTitles' }),
      inspector,
    );
    expect(e.status).toBe('verified');
  });

  it('goes red once the symbol IS there, and says where', async () => {
    // Correct behaviour, not a false alarm: the moment someone lands the fix, the plan's statement
    // of the old world stops being true and the plan needs updating.
    const e = await verifyClaim(
      claim({ kind: 'absent', path: 'src/Preview.tsx', symbol: 'installRichTitles' }),
      inspector,
    );
    expect(e).toMatchObject({ status: 'struck', failure: 'symbol-is-present' });
    expect((e as { detail: string }).detail).toContain('302');
  });

  it('names each place once, even where a definition is also a reference', async () => {
    // Real output before this was deduped: "testRecipient IS in delivery.ts — at 186, 545, 186,
    // 545, 546, 548". A reader counts six sites and there are four.
    const both = new FakeInspector({
      definitions: { foo: [{ path: 'src/a.ts', line: 3 }] },
      references: {
        foo: [
          { path: 'src/a.ts', line: 3 },
          { path: 'src/a.ts', line: 9 },
        ],
      },
    });
    const e = await verifyClaim(claim({ kind: 'absent', path: 'src/a.ts', symbol: 'foo' }), both);
    expect((e as { detail: string }).detail).toBe('foo IS in src/a.ts — at line 3, 9');
  });
});

describe('contains', () => {
  it('finds source text anywhere in the file, not at a line', async () => {
    const e = await verifyClaim(
      claim({ kind: 'contains', path: 'src/dialog.tsx', symbol: undefined, fragment: 'sm:max-w-lg' }),
      inspector,
    );
    expect(e.status).toBe('verified');
  });

  it('tolerates reflowed whitespace, because a model quoting source reflows it', async () => {
    const e = await verifyClaim(
      claim({
        kind: 'contains',
        path: 'src/dialog.tsx',
        symbol: undefined,
        fragment: 'grid  w-full\n  gap-4',
      }),
      inspector,
    );
    expect(e.status).toBe('verified');
  });

  it('is struck when the text is not there', async () => {
    const e = await verifyClaim(
      claim({ kind: 'contains', path: 'src/dialog.tsx', symbol: undefined, fragment: 'max-w-4xl' }),
      inspector,
    );
    expect(e).toMatchObject({ status: 'struck', failure: 'fragment-not-found' });
  });

  it('is struck when the file does not exist', async () => {
    const e = await verifyClaim(
      claim({ kind: 'contains', path: 'src/gone.tsx', symbol: undefined, fragment: 'anything' }),
      inspector,
    );
    expect(e).toMatchObject({ status: 'struck', failure: 'path-missing' });
  });
});

describe('a claim that cannot be checked as written', () => {
  it.each([
    ['contains with nothing quoted', { kind: 'contains' as const, symbol: undefined }],
    ['defines with no symbol', { kind: 'defines' as const, symbol: undefined }],
    ['references with no symbol', { kind: 'references' as const, symbol: undefined }],
    ['absent with no symbol', { kind: 'absent' as const, symbol: undefined }],
  ])('is struck as incomplete: %s', async (_what, over) => {
    const e = await verifyClaim(claim(over), inspector);
    expect(e).toMatchObject({ status: 'struck', failure: 'claim-incomplete' });
  });
});

describe('when the inspector cannot run', () => {
  const down = new FakeInspector({ available: false });

  it('reports unverifiable, never a pass and never a strike', async () => {
    // The whole reason the status exists. A checker that could not run has not passed anything —
    // and it has not disproved anything either.
    const e = await verifyClaim(claim({}), down);
    expect(e).toMatchObject({ status: 'unverifiable', failure: 'inspector-unavailable' });
  });
});

describe('verifyClaims', () => {
  it('counts each outcome and keeps every item', async () => {
    const report = await verifyClaims(
      [claim({}), claim({ path: 'src/nope.ts' }), claim({ kind: 'absent', path: 'src/Respondent.tsx' })],
      inspector,
    );
    expect(report).toMatchObject({ verified: 2, struck: 1, unverifiable: 0 });
    expect(report.items).toHaveLength(3);
  });

  it('returns an empty report for no claims', async () => {
    expect(await verifyClaims([], inspector)).toMatchObject({ verified: 0, struck: 0, unverifiable: 0 });
  });
});

describe('evidenceAllows', () => {
  it('blocks on any struck claim', async () => {
    expect(evidenceAllows(await verifyClaims([claim({}), claim({ path: 'src/nope.ts' })], inspector))).toBe(
      false,
    );
  });

  it('allows when everything checked out', async () => {
    expect(evidenceAllows(await verifyClaims([claim({})], inspector))).toBe(true);
  });

  it('allows a step that made no claims at all', async () => {
    // An operator step — "set the licence key in QA" — cites nothing because there is nothing in
    // this repository to cite. That is not a failure of evidence.
    expect(evidenceAllows(await verifyClaims([], inspector))).toBe(true);
  });

  it('blocks a step whose every claim was unverifiable', async () => {
    const report = await verifyClaims([claim({}), claim({})], new FakeInspector({ available: false }));
    expect(report.unverifiable).toBe(2);
    expect(evidenceAllows(report)).toBe(false);
  });

  it('allows when some claims were checked and the rest were not', () => {
    expect(evidenceAllows({ items: [], verified: 2, struck: 0, unverifiable: 1 })).toBe(true);
  });
});
