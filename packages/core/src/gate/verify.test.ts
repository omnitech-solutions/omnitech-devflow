import type { Claim } from '@omnitech/devflow-contracts';
import { describe, expect, it } from 'vitest';
import { FakeInspector } from '../ports/__fakes__/index.js';
import { evidenceAllows, LINE_TOLERANCE, verifyClaim, verifyClaims } from './verify.js';

/**
 * The gate, tested as the function it is. Every case is a claim a model could plausibly write,
 * and the ones that matter most are the near-misses — a claim wrong by nine lines looks exactly
 * like a claim wrong by one until something measures it.
 */

const DIALOG = [
  'function DialogContent({ className, ...props }) {',
  '  return (',
  '    <DialogPrimitive.Content',
  '      className={cn(',
  '        "fixed top-[50%] grid w-full gap-4 sm:max-w-lg",',
  '        className',
  '      )}',
  '    />',
  '  );',
  '}',
];

const inspector = new FakeInspector({
  files: { 'src/ui/dialog.tsx': DIALOG },
  definitions: { installRichTitles: [{ path: 'src/richText.ts', line: 206 }] },
  references: {
    installRichTitles: [
      { path: 'src/Preview.tsx', line: 302 },
      { path: 'src/fidelity.ts', line: 43 },
    ],
  },
});

const claim = (over: Partial<Claim>): Claim => ({
  kind: 'location',
  text: 'the base class list ends in sm:max-w-lg',
  path: 'src/ui/dialog.tsx',
  line: 5,
  fragment: 'sm:max-w-lg',
  ...over,
});

describe('a location claim', () => {
  it('passes when the fragment is on the cited line', async () => {
    expect(await verifyClaim(claim({}), inspector)).toMatchObject({ status: 'verified' });
  });

  it(`passes when the file has shifted by up to ${LINE_TOLERANCE} lines`, async () => {
    // Adding a line above a function shifts every citation below it. Failing a plan because
    // someone ran a formatter would make the gate the enemy.
    expect(await verifyClaim(claim({ line: 5 + LINE_TOLERANCE }), inspector)).toMatchObject({
      status: 'verified',
    });
  });

  it('is struck when the fragment is further away than the tolerance', async () => {
    // A fragment found nine lines from where it was cited is evidence the model was guessing.
    const e = await verifyClaim(claim({ line: 5 + LINE_TOLERANCE + 1 }), inspector);
    expect(e).toMatchObject({ status: 'struck', failure: 'fragment-not-found' });
  });

  it('is struck when the file does not exist', async () => {
    const e = await verifyClaim(claim({ path: 'src/imaginary.tsx' }), inspector);
    expect(e).toMatchObject({ status: 'struck', failure: 'path-missing' });
  });

  it('is struck when the line is past the end of the file', async () => {
    const e = await verifyClaim(claim({ line: 9_000 }), inspector);
    expect(e).toMatchObject({ status: 'struck', failure: 'line-out-of-range' });
  });

  it('tolerates reflowed whitespace in the quoted fragment', async () => {
    // A model quoting source reflows it. Striking a claim that is right about the code and wrong
    // about its wrapping would train people to ignore the gate.
    const e = await verifyClaim(claim({ fragment: 'grid  w-full\n   gap-4' }), inspector);
    expect(e).toMatchObject({ status: 'verified' });
  });

  it('checks the whole file when no line is cited', async () => {
    expect(await verifyClaim(claim({ line: undefined }), inspector)).toMatchObject({ status: 'verified' });
    expect(await verifyClaim(claim({ line: undefined, fragment: 'nowhere' }), inspector)).toMatchObject({
      status: 'struck',
      failure: 'fragment-not-found',
    });
  });

  it('passes a claim that cites a place but quotes nothing', async () => {
    expect(await verifyClaim(claim({ fragment: undefined }), inspector)).toMatchObject({
      status: 'verified',
    });
  });
});

describe('a structural claim', () => {
  const structural = (over: Partial<Claim>): Claim =>
    claim({
      kind: 'structural',
      text: 'installRichTitles is called here',
      path: 'src/Preview.tsx',
      line: 302,
      fragment: undefined,
      query: 'installRichTitles',
      ...over,
    });

  it('passes when the symbol is referenced at the cited place', async () => {
    expect(await verifyClaim(structural({}), inspector)).toMatchObject({ status: 'verified' });
  });

  it('passes for a definition as well as a reference', async () => {
    expect(await verifyClaim(structural({ path: 'src/richText.ts', line: 206 }), inspector)).toMatchObject({
      status: 'verified',
    });
  });

  it('is struck when the symbol is absent from the cited file', async () => {
    // The rule that makes this worth doing: a substring check once reported PASS on a file that
    // mentioned the name only in an import, a comment and a string.
    const e = await verifyClaim(structural({ path: 'src/Respondent.tsx' }), inspector);
    expect(e).toMatchObject({ status: 'struck', failure: 'query-no-match' });
  });

  it('is struck when the symbol is in the file but nowhere near the cited line', async () => {
    const e = await verifyClaim(structural({ line: 900 }), inspector);
    expect(e).toMatchObject({ status: 'struck', failure: 'query-no-match' });
    expect((e as { detail: string }).detail).toContain('302');
  });

  it('passes when the file is right and no line is claimed', async () => {
    expect(await verifyClaim(structural({ line: undefined }), inspector)).toMatchObject({
      status: 'verified',
    });
  });

  it('is struck when it carries no query to ask', async () => {
    const e = await verifyClaim(structural({ query: undefined }), inspector);
    expect(e).toMatchObject({ status: 'struck', failure: 'query-no-match' });
  });
});

describe('when the inspector cannot run', () => {
  const down = new FakeInspector({ available: false });

  it('reports unverifiable, never a pass', async () => {
    // The whole reason the status exists. A checker that cannot run has not passed anything.
    const e = await verifyClaim(claim({}), down);
    expect(e).toMatchObject({ status: 'unverifiable', failure: 'inspector-unavailable' });
  });

  it('does not silently strike either — the claim may well be true', async () => {
    const e = await verifyClaim(claim({}), down);
    expect(e.status).not.toBe('struck');
  });
});

describe('verifyClaims', () => {
  it('counts each outcome and keeps every item', async () => {
    const report = await verifyClaims(
      [claim({}), claim({ path: 'src/gone.tsx' }), claim({ fragment: 'not there' })],
      inspector,
    );
    expect(report).toMatchObject({ verified: 1, struck: 2, unverifiable: 0 });
    expect(report.items).toHaveLength(3);
  });

  it('returns an empty report for no claims', async () => {
    expect(await verifyClaims([], inspector)).toMatchObject({ verified: 0, struck: 0, unverifiable: 0 });
  });
});

describe('evidenceAllows', () => {
  it('blocks on any struck claim', async () => {
    const report = await verifyClaims([claim({}), claim({ path: 'src/gone.tsx' })], inspector);
    expect(evidenceAllows(report)).toBe(false);
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
    // Nothing was wrong, and nothing was proved. Proceeding would be proceeding on nothing.
    const report = await verifyClaims([claim({}), claim({})], new FakeInspector({ available: false }));
    expect(report.unverifiable).toBe(2);
    expect(evidenceAllows(report)).toBe(false);
  });

  it('allows when some claims were checked and the rest were not', async () => {
    const report = { items: [], verified: 2, struck: 0, unverifiable: 1 };
    expect(evidenceAllows(report)).toBe(true);
  });
});
