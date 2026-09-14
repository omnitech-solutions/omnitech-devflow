import { type Claim, type Evidence, type EvidenceReport, summarise } from '@omnitech/devflow-contracts';
import { parseBook } from '../book/parse.js';
import type { CodeInspector, SourceLocation } from '../ports/inspector.js';

/**
 * The citation gate. Models propose; this disposes.
 *
 * Every check is anchored to something that **survives an edit**: a definition, a reference, the
 * absence of a reference, or a piece of source text. Never a line number.
 *
 * That was the original design and it was wrong. Any insertion above a cited line invalidates the
 * citation without changing whether it is true, so running a formatter would have struck a plan
 * full of correct claims — and a gate that cries wolf is a gate people learn to skip. The model to
 * copy was already in MJ's pattern guardians: ask the syntax tree a question, and treat `file:line`
 * as the ANSWER rather than as the thing being checked.
 *
 * Line numbers are still recorded and reported. When one has moved, the claim still holds and the
 * new location is shown, because that is exactly the moment a reader wants to know.
 */

/**
 * Exactly the text the gate **blocks on**: the body of every TODO row, and nothing else.
 *
 * Notes are verified too, and reported — a wrong fact in the briefing is how a correct step gets
 * written against the wrong world. They do not appear here because they do not block: a note is
 * context, not an instruction an executor acts on. This function answers "what can turn the gate
 * red", which is the only question a mutation proof is entitled to ask.
 *
 * Exported because a mutation proof must be able to ask "did my edit land where the check looks?"
 * without guessing. It is guessing that produced the failure this exists to prevent — twice I broke
 * the first matching line in a book, which was inside a NOTE, watched the gate stay green, and
 * nearly reported a hole in the gate. The gate had never seen the edit: it does not read NOTEs.
 *
 * One definition, used by the gate's caller and by the proof, so the two cannot disagree about
 * where the gate is looking. `gate-proof.test.ts` holds them together.
 */
export function checkedRegion(book: string): string {
  return parseBook(book)
    .rows.filter((r) => r.type === 'todo')
    .map((r) => r.body)
    .join('\n');
}

/** Whitespace-insensitive containment — a model quoting source reflows it. */
function contains(text: string, needle: string): boolean {
  return text.replace(/\s+/g, ' ').includes(needle.replace(/\s+/g, ' ').trim());
}

const at = (locations: readonly SourceLocation[], path: string): readonly SourceLocation[] =>
  locations.filter((l) => l.path === path);

/**
 * Definitions and references as one list, each place named once.
 *
 * A definition is also a reference, so the two lists overlap and a naive concat prints the same
 * line twice: "testRecipient IS in delivery.ts — at 186, 545, 186, 545, 546, 548" was the real
 * output. A reader counts those and believes there are six sites.
 */
function union(...groups: ReadonlyArray<readonly SourceLocation[]>): readonly SourceLocation[] {
  const seen = new Set<string>();
  return groups.flat().filter((l) => {
    const key = `${l.path}:${l.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** A claim's recorded line, and where the thing actually is now. */
function moved(claim: Claim, found: readonly SourceLocation[]): { movedTo?: number } {
  const first = found[0];
  if (!first || claim.line === undefined || first.line === claim.line) return {};
  return { movedTo: first.line };
}

async function wholeFile(claim: Claim, inspector: CodeInspector): Promise<string | null> {
  const lines = await inspector.readLines(claim.path, 1, Number.MAX_SAFE_INTEGER);
  return lines === null ? null : lines.join('\n');
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

  if (claim.kind === 'contains') {
    if (!claim.fragment) {
      return {
        status: 'struck',
        claim,
        failure: 'claim-incomplete',
        detail: 'a `contains` claim quotes nothing',
      };
    }
    const text = await wholeFile(claim, inspector);
    if (text === null) {
      return { status: 'struck', claim, failure: 'path-missing', detail: `no such file: ${claim.path}` };
    }
    return contains(text, claim.fragment)
      ? { status: 'verified', claim }
      : {
          status: 'struck',
          claim,
          failure: 'fragment-not-found',
          detail: `${claim.path} does not contain ${JSON.stringify(claim.fragment)} anywhere`,
        };
  }

  const symbol = claim.symbol;
  if (!symbol) {
    return {
      status: 'struck',
      claim,
      failure: 'claim-incomplete',
      detail: `a \`${claim.kind}\` claim names no symbol to look for`,
    };
  }

  const [defs, refs] = await Promise.all([inspector.definitionsOf(symbol), inspector.referencesTo(symbol)]);

  if (claim.kind === 'defines') {
    const here = at(defs, claim.path);
    return here.length
      ? { status: 'verified', claim, ...moved(claim, here) }
      : {
          status: 'struck',
          claim,
          failure: 'symbol-not-defined-here',
          detail: elsewhere(symbol, claim.path, defs, 'defined'),
        };
  }

  if (claim.kind === 'references') {
    const here = at(union(defs, refs), claim.path);
    return here.length
      ? { status: 'verified', claim, ...moved(claim, here) }
      : {
          status: 'struck',
          claim,
          failure: 'symbol-not-referenced-here',
          detail: elsewhere(symbol, claim.path, union(defs, refs), 'referenced'),
        };
  }

  // `absent` — the claim is that the symbol is NOT used here. Often the most valuable one in a
  // plan: "Respondent.tsx never calls installRichTitles" is what settled a whole design question,
  // and it is also the claim that goes red the moment someone lands the fix, which is correct.
  const here = at(union(defs, refs), claim.path);
  return here.length === 0
    ? { status: 'verified', claim }
    : {
        status: 'struck',
        claim,
        failure: 'symbol-is-present',
        detail: `${symbol} IS in ${claim.path} — at line ${here.map((h) => h.line).join(', ')}`,
      };
}

/** Where the symbol actually lives, so a struck claim points somewhere useful. */
function elsewhere(symbol: string, path: string, found: readonly SourceLocation[], verb: string): string {
  if (found.length === 0) return `${symbol} is ${verb} nowhere that was searched`;
  const places = [...new Set(found.map((f) => f.path))].slice(0, 3).join(', ');
  return `${symbol} is not ${verb} in ${path} — it is in ${places}`;
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
