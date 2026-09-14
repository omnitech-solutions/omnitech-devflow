import { z } from 'zod';

/**
 * Evidence — a claim a model made, and what happened when deterministic code went and checked it.
 *
 * This is the centre of DevFlow. A model writing "`respondent-runtime.ts:958` strips the markup"
 * is doing the thing models are worst at, and the answer is not a better prompt: it is that no
 * claim becomes a DevFlow artifact until a checker has been to the file and looked.
 *
 * The claim and its verdict are one record on purpose. A shape that stored verified claims and
 * discarded the rest would lose the most useful output this system produces — a plan that says
 * "9 claims verified, 1 struck, and here is the struck one" is worth more than a plan that quietly
 * contains only the 9.
 */

/**
 * How a claim is anchored — and every one of these survives an edit elsewhere in the file.
 *
 * A line number does not. Any insertion above a cited line invalidates the citation without
 * changing whether it is true, so a check anchored to one fails when someone runs a formatter.
 * The alternative is what MJ's own pattern guardians already do: ask the syntax tree a question,
 * and treat `file:line` as the ANSWER rather than as the thing being checked.
 *
 *   defines     the symbol is defined in this file
 *   references  the symbol is called or referenced in this file
 *   absent      the symbol is NOT referenced in this file — often the most valuable claim,
 *               and the one that settled whether the respondent could render rich titles
 *   contains    the file contains this source text, anywhere in it
 *
 * Line numbers are still recorded and displayed, because they are how a reader navigates. They
 * are never what passes or fails.
 */
export const claimKindSchema = z.enum(['defines', 'references', 'absent', 'contains']);
export type ClaimKind = z.infer<typeof claimKindSchema>;

export const claimSchema = z.strictObject({
  kind: claimKindSchema,
  /** What the model asserted, in its own words. Kept verbatim for the audit trail. */
  text: z.string().min(1),
  /** Repository-relative. Absolute paths do not survive being read on another machine. */
  path: z.string().min(1),
  /**
   * Where it was when the claim was written. Recorded for navigation and reported when it has
   * moved — never used to decide whether the claim holds.
   */
  line: z.number().int().positive().optional(),
  /** For `contains`: the source text that must be somewhere in the file. */
  fragment: z.string().optional(),
  /** For `defines`, `references` and `absent`: the symbol to ask the syntax tree about. */
  symbol: z.string().optional(),
});
export type Claim = z.infer<typeof claimSchema>;

/**
 * Why a check failed. A closed set: an open one becomes a free-text field, and a free-text field
 * is how "could not check" and "checked and it was wrong" end up indistinguishable.
 */
export const evidenceFailureSchema = z.enum([
  'path-missing',
  'fragment-not-found',
  'symbol-not-defined-here',
  'symbol-not-referenced-here',
  /** Claimed absent, but it is there. The one that catches a fix that was never applied. */
  'symbol-is-present',
  'claim-incomplete',
  'inspector-unavailable',
]);
export type EvidenceFailure = z.infer<typeof evidenceFailureSchema>;

/**
 * `unverifiable` is deliberately distinct from `struck`.
 *
 * `struck` means we looked and the claim was wrong. `unverifiable` means we could not look — the
 * inspector was missing, the file was binary, the tool timed out. Collapsing them would let a
 * broken checker read as a clean plan, which is the same failure as a guardian that reports PASS
 * because it could not run. "I could not look" is not "I looked".
 */
export const evidenceSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('verified'),
    claim: claimSchema,
    /**
     * Where it actually is now, when that differs from the line the claim recorded. The claim
     * still holds — this is a navigation hint, not a failure.
     */
    movedTo: z.number().int().positive().optional(),
  }),
  z.strictObject({
    status: z.literal('struck'),
    claim: claimSchema,
    failure: evidenceFailureSchema,
    detail: z.string(),
  }),
  z.strictObject({
    status: z.literal('unverifiable'),
    claim: claimSchema,
    failure: evidenceFailureSchema,
    detail: z.string(),
  }),
]);
export type Evidence = z.infer<typeof evidenceSchema>;

/** A whole step's evidence, with the counts the CLI and UI both render. */
export const evidenceReportSchema = z.strictObject({
  items: z.array(evidenceSchema),
  verified: z.number().int().nonnegative(),
  struck: z.number().int().nonnegative(),
  unverifiable: z.number().int().nonnegative(),
});
export type EvidenceReport = z.infer<typeof evidenceReportSchema>;

/** The one place counts are derived, so no caller can compute them a second, different way. */
export function summarise(items: readonly Evidence[]): EvidenceReport {
  return {
    items: [...items],
    verified: items.filter((e) => e.status === 'verified').length,
    struck: items.filter((e) => e.status === 'struck').length,
    unverifiable: items.filter((e) => e.status === 'unverifiable').length,
  };
}
