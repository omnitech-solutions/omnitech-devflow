import { type Task, taskSchema } from '@omnitech/devflow-contracts';

/**
 * What a human typed, parsed.
 *
 * Deliberately forgiving. Someone pasting a ticket should not have to reformat it, and someone
 * typing one line should not have to fill a form. Anything this misses gets added by hand to the
 * plan — a parser that demands structure is a parser people route around.
 *
 * The ticket pattern is configuration, never a constant, so `LGN-`, `ENG-` and no ticket system at
 * all are the same code path.
 */

const URL_RE = /https?:\/\/[^\s<>)\]"']+/g;
/** A backticked path, or a bare one with a code-ish extension. */
const PATH_RE = /`([^`\s]+\.[a-z]{1,4})`|\b([\w./-]+\.(?:tsx?|jsx?|py|rb|go|rs|java|md))\b/g;
/**
 * Backticked identifiers, or a bare name with an internal lowercase→uppercase transition.
 *
 * That transition is what makes `DialogContent` and `installRichTitles` symbols while leaving
 * ordinary sentence words alone. The first version required a lowercase FIRST letter, which meant
 * every React component, class and type — all PascalCase — was silently invisible. Found by
 * running the tool against a real component and watching it report zero symbols.
 */
const SYMBOL_RE = /`([A-Za-z_][A-Za-z0-9_]{3,})`|\b([A-Za-z][a-zA-Z0-9]*[a-z][A-Z][a-zA-Z0-9]*)\b/g;

/** Common words that survive the camelCase test but are never symbols. */
const NOT_SYMBOLS = new Set(['javaScript', 'typeScript']);

export interface IntakeOptions {
  readonly ticketPattern: string;
  /** Used when the text carries no ticket — most people already put it in the branch name. */
  readonly branch?: string;
}

/** The first sentence, ticket prefix stripped. Books are named for what they do. */
function titleOf(text: string): string {
  // `intake` refuses empty text before this runs, so there is always a non-blank line and always
  // a first sentence. Fallbacks here would be unreachable — and an unreachable fallback is a claim
  // about the code that is not true.
  const first = (text.split('\n').find((l) => l.trim()) as string).trim();
  const withoutKey = first.replace(/^\s*\[?[A-Z][A-Z0-9]{1,9}-\d+\]?\s*[:\-–—]?\s*/, '');
  const sentence = (withoutKey.split(/(?<=[a-z])\.\s/)[0] as string).trim().replace(/\.$/, '');
  if (!sentence) return 'work';
  if (sentence.length <= 90) return sentence;
  // Never mid-word: "…through the cano" is how a truncation announces nobody thought about it.
  return `${sentence
    .slice(0, 90)
    .replace(/\s+\S*$/, '')
    .replace(/[,:;]$/, '')}…`;
}

/** Captured group 1 or 2, or the whole match when the pattern captures nothing. */
const matches = (text: string, re: RegExp): string[] => {
  const out: string[] = [];
  for (const m of text.matchAll(re)) {
    const value = m[1] ?? m[2] ?? m[0];
    if (value) out.push(value);
  }
  return [...new Set(out)];
};

export class EmptyTask extends Error {
  constructor() {
    super('a task needs at least a sentence saying what you want done');
    this.name = 'EmptyTask';
  }
}

export function intake(text: string, options: IntakeOptions): Task {
  // Caught here rather than by the schema, so the operator gets a sentence instead of a validation
  // dump about a field they never typed.
  if (!text.trim()) throw new EmptyTask();
  const ticketRe = new RegExp(options.ticketPattern);
  const fromText = ticketRe.exec(text)?.[1];
  const fromBranch = options.branch ? ticketRe.exec(options.branch.toUpperCase())?.[1] : undefined;
  const ticketKey = fromText ?? fromBranch;
  const title = titleOf(text);

  const urls = matches(text, URL_RE);
  const paths = matches(text, PATH_RE);
  // Symbols are harvested from text with paths and urls removed. `src/richText.ts` contains a
  // perfectly good camelCase match, and reporting `richText` as a symbol sends the inspector
  // looking for something nobody named.
  const withoutLocations = [...paths, ...urls].reduce((acc, loc) => acc.split(loc).join(' '), text);

  return taskSchema.parse({
    // A ticket key is the natural id when there is one; otherwise the title, slugged, so two
    // different tasks cannot collide on a generic word.
    id: ticketKey ?? slug(title),
    text: text.trim(),
    title,
    ...(ticketKey === undefined ? {} : { ticketKey }),
    urls,
    paths,
    symbols: matches(withoutLocations, SYMBOL_RE)
      .filter((s) => !NOT_SYMBOLS.has(s))
      .slice(0, 12),
  });
}

export function slug(text: string, max = 48): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s.slice(0, max).replace(/-+$/, '') || 'work';
}
