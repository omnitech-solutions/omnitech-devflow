import type { Claim } from '@omnitech/devflow-contracts';

/**
 * Claims, read out of a step's prose.
 *
 * Four shapes a human or a model writes naturally, each anchored to something that survives an
 * edit elsewhere in the file:
 *
 *   `installRichTitles` is defined in `src/richText.ts`
 *   `src/Preview.tsx` calls `installRichTitles`
 *   `src/Respondent.tsx` does not call `installRichTitles`
 *   `src/dialog.tsx` contains `sm:max-w-lg`
 *
 * A trailing `:42` on a path is accepted and kept — it is how a reader navigates — but it is never
 * what the gate checks. The previous design checked it, which meant running a formatter would
 * strike a plan full of correct claims, and a gate that cries wolf is a gate people skip.
 */

/**
 * A backticked token that might be a path, plus an optional `:42`.
 *
 * Deliberately not `` `([\w./-]+\.[a-z]{1,4})` `` — `.` is inside that character class as well as
 * outside it, so the two overlap and the engine can retry the split exponentially on a long
 * non-matching token. Matching the token linearly and testing the extension in code is both safe
 * and clearer about what the rule actually is.
 */
const PATH = '`([\\w./-]+)(?::(\\d+))?`';
const NAME = '`([A-Za-z_$][\\w$]*)`';
const FRAGMENT = '`([^`\\n]{2,})`';

/** A path names a file. `notes` or `src` is a backticked word, not a citation. */
const looksLikeAFile = (token: string): boolean => /\.[A-Za-z]{1,4}$/.test(token);

interface Pattern {
  readonly kind: Claim['kind'];
  readonly re: RegExp;
  /** Which capture group holds the path: 1 when the path is written first, 3 when second. */
  readonly pathFirst: boolean;
}

/**
 * Order matters exactly once, and it is load-bearing: `absent` is tried before `references`
 * because the positive wording is a substring of the negative one. Without this, "does not call X"
 * would also register as "calls X" and a step would contradict itself.
 */
const PATTERNS: readonly Pattern[] = [
  {
    kind: 'defines',
    re: new RegExp(`${NAME}\\s+is\\s+defined\\s+(?:in|at)\\s+${PATH}`, 'g'),
    pathFirst: false,
  },
  { kind: 'defines', re: new RegExp(`${PATH}\\s+defines\\s+${NAME}`, 'g'), pathFirst: true },
  {
    kind: 'absent',
    re: new RegExp(
      `${PATH}\\s+(?:does\\s+not|never|doesn't)\\s+(?:calls?|references?|uses?|import|imports)\\s+${NAME}`,
      'g',
    ),
    pathFirst: true,
  },
  {
    kind: 'references',
    re: new RegExp(`${PATH}\\s+(?:calls?|references?|uses?|imports?)\\s+${NAME}`, 'g'),
    pathFirst: true,
  },
  {
    kind: 'references',
    re: new RegExp(
      `${NAME}\\s+is\\s+(?:called|referenced|used|imported)\\s+(?:in|at|from|by)\\s+${PATH}`,
      'g',
    ),
    pathFirst: false,
  },
  { kind: 'contains', re: new RegExp(`${PATH}\\s+contains\\s+${FRAGMENT}`, 'g'), pathFirst: true },
];

export function claimsIn(body: string): readonly Claim[] {
  const out: Claim[] = [];
  const seen = new Set<string>();

  for (const { kind, re, pathFirst } of PATTERNS) {
    for (const m of body.matchAll(re)) {
      // path-first: [path, line, other]. symbol-first: [other, path, line].
      const path = (pathFirst ? m[1] : m[2]) as string;
      const line = pathFirst ? m[2] : m[3];
      const other = (pathFirst ? m[3] : m[1]) as string;
      // The sentence has the shape of a claim but does not name a file. Not a claim, and not an
      // error: "`notes` defines `foo`" is ordinary prose about something that is not in the tree.
      if (!looksLikeAFile(path)) continue;

      // One claim per (kind, path, target): a step may say the same thing twice without the gate
      // reporting it as two pieces of evidence.
      const key = `${kind}:${path}:${other}`;
      if (seen.has(key)) continue;
      seen.add(key);

      out.push({
        kind,
        text: m[0],
        path,
        ...(line ? { line: Number(line) } : {}),
        ...(kind === 'contains' ? { fragment: other } : { symbol: other }),
      });
    }
  }
  return out;
}
