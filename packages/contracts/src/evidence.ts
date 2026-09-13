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

/** How a claim can be anchored. `structural` re-runs through the syntax tree, never grep. */
export const claimKindSchema = z.enum(['location', 'structural', 'command']);
export type ClaimKind = z.infer<typeof claimKindSchema>;

export const claimSchema = z.strictObject({
  kind: claimKindSchema,
  /** What the model asserted, in its own words. Kept verbatim for the audit trail. */
  text: z.string().min(1),
  /** Repository-relative. Absolute paths do not survive being read on another machine. */
  path: z.string().min(1),
  /** 1-indexed, as every editor and every error message counts them. */
  line: z.number().int().positive().optional(),
  /** The source the claim says is there. Checked within a tolerance, not byte-exact. */
  fragment: z.string().optional(),
  /** For `structural`: the query that must still match. */
  query: z.string().optional(),
});
export type Claim = z.infer<typeof claimSchema>;

/**
 * Why a check failed. A closed set: an open one becomes a free-text field, and a free-text field
 * is how "could not check" and "checked and it was wrong" end up indistinguishable.
 */
export const evidenceFailureSchema = z.enum([
  'path-missing',
  'line-out-of-range',
  'fragment-not-found',
  'query-no-match',
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
  z.strictObject({ status: z.literal('verified'), claim: claimSchema }),
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
