import { type Claim, type Evidence, type EvidenceReport, summarise } from '@omnitech/devflow-contracts';
import type { CodeInspector } from '../ports/inspector.js';

/**
 * The citation gate. Models propose; this disposes.
 *
 * A model writing "`respondent-runtime.ts:958` strips the markup" is doing the one thing models
 * are worst at, and the answer is not a better prompt. It is that no claim becomes a DevFlow
 * artifact until something has gone to the file and looked.
 *
 * Pure of everything except the inspector, which is injected. No filesystem, no network, no
 * workflow engine — so the whole safety argument is testable as a function.
 */

/**
 * How far from the cited line the fragment may actually be.
 *
 * Not zero, and not large. Files move: a line added above a function shifts every citation below
 * it, and failing a plan because someone ran a formatter would make the gate the enemy. Three is
 * enough to absorb that and far too few to absorb a wrong claim, which is the balance that matters
 * — a fragment found nine lines away is evidence the model was guessing.
 */
export const LINE_TOLERANCE = 3;

/**
 * Whitespace-insensitive containment.
 *
 * A model quoting source will reflow it — different indentation, a line break moved. Comparing
 * raw strings would strike claims that are perfectly correct about the code and merely wrong
 * about how it was wrapped.
 */
function contains(haystack: readonly string[], needle: string): boolean {
  const flat = haystack.join('\n').replace(/\s+/g, ' ');
  return flat.includes(needle.replace(/\s+/g, ' ').trim());
}

async function verifyLocation(claim: Claim, inspector: CodeInspector): Promise<Evidence> {
  const line = claim.line;
  const [from, to] = line
    ? [Math.max(1, line - LINE_TOLERANCE), line + LINE_TOLERANCE]
    : // No line means the claim is about the file, not a place in it: read enough to check.
      [1, 10_000];

  const lines = await inspector.readLines(claim.path, from, to);
  if (lines === null) {
    return { status: 'struck', claim, failure: 'path-missing', detail: `no such file: ${claim.path}` };
  }
  if (lines.length === 0) {
    return {
      status: 'struck',
      claim,
      failure: 'line-out-of-range',
      detail: `${claim.path} has no line ${String(line)}`,
    };
  }
  if (claim.fragment && !contains(lines, claim.fragment)) {
    return {
      status: 'struck',
      claim,
      failure: 'fragment-not-found',
      detail: line
        ? `${claim.path}:${line} (±${LINE_TOLERANCE}) does not contain ${JSON.stringify(claim.fragment)}`
        : `${claim.path} does not contain ${JSON.stringify(claim.fragment)}`,
    };
  }
  return { status: 'verified', claim };
}

/**
 * A structural claim is re-asked of the syntax tree, never of a substring search.
 *
 * The rule exists because a substring check once reported PASS on a file that mentioned the
 * symbol only in an import, a comment and a string literal. "The name appears here" and "this is
 * called here" are different facts, and only one of them is what a plan means.
 */
async function verifyStructural(claim: Claim, inspector: CodeInspector): Promise<Evidence> {
  const symbol = claim.query;
  if (!symbol) {
    return {
      status: 'struck',
      claim,
      failure: 'query-no-match',
      detail: 'a structural claim with no query cannot be checked',
    };
  }

  const [defs, refs] = await Promise.all([inspector.definitionsOf(symbol), inspector.referencesTo(symbol)]);
  const hits = [...defs, ...refs].filter((l) => l.path === claim.path);
  if (hits.length === 0) {
    return {
      status: 'struck',
      claim,
      failure: 'query-no-match',
      detail: `${symbol} is neither defined nor referenced in ${claim.path}`,
    };
  }
  if (claim.line !== undefined && !hits.some((h) => Math.abs(h.line - claim.line!) <= LINE_TOLERANCE)) {
    return {
      status: 'struck',
      claim,
      failure: 'query-no-match',
      detail: `${symbol} is in ${claim.path} but not near line ${claim.line} (found ${hits
        .map((h) => h.line)
        .join(', ')})`,
    };
  }
  return { status: 'verified', claim };
}

/** One claim, checked. */
export async function verifyClaim(claim: Claim, inspector: CodeInspector): Promise<Evidence> {
  if (!(await inspector.available())) {
    // Deliberately `unverifiable`, never `struck` and never a pass. "I could not look" is not
    // "I looked" — the distinction a structural check once lost by reporting PASS when its tool
    // was missing, which is how a broken checker reads as a clean plan.
    return {
      status: 'unverifiable',
      claim,
      failure: 'inspector-unavailable',
      detail: 'the code inspector could not run, so this claim was never checked',
    };
  }
  return claim.kind === 'structural' ? verifyStructural(claim, inspector) : verifyLocation(claim, inspector);
}

/** Every claim in a step, checked, with the counts the CLI and the UI both render. */
export async function verifyClaims(
  claims: readonly Claim[],
  inspector: CodeInspector,
): Promise<EvidenceReport> {
  return summarise(await Promise.all(claims.map((c) => verifyClaim(c, inspector))));
}

/**
 * Whether a step may proceed on its evidence.
 *
 * A struck claim blocks: the model asserted something about the code that is not true, and the
 * rest of the step was written on top of it. An unverifiable claim does not block on its own —
 * the tool being absent is an environment problem, not a wrong plan — but it is reported, and a
 * step that is *entirely* unverifiable has proved nothing and is treated as blocked.
 */
export function evidenceAllows(report: EvidenceReport): boolean {
  if (report.struck > 0) return false;
  const checked = report.verified + report.struck;
  return checked > 0 || report.items.length === 0;
}
