import type { Note, Plan } from '@omnitech/devflow-contracts';

/**
 * The `.book.md` format — parsed and rendered exactly as MJ's `emit.py` does it.
 *
 * This is an interop contract, not a design of ours. A book written here must emit through his
 * vendored emitter unchanged, and a book he wrote must parse here. Every rule below was read off
 * `emit.py` rather than inferred:
 *
 *   `_parse_book_md_heading`  — the type prefix, the optional row number, the separator set
 *   `_RECOMMENDED_TODO_HEADERS` — the three headers a TODO body should carry
 *   `_BOOK_MD_TYPE_PREFIXES`  — TODO, NOTE, AUDIT; anything else is freeform
 *
 * Where his parser is lenient, this one is lenient in the same places, because a book that round
 * trips through only one of the two is not interoperable.
 */

export type RowType = 'todo' | 'note' | 'audit' | 'freeform';

export interface ParsedRow {
  readonly type: RowType;
  readonly title: string;
  readonly body: string;
  /** Present only when the heading carried one. TODO rows are renumbered on render. */
  readonly n?: number;
}

export interface ParsedBook {
  readonly frontmatter: Readonly<Record<string, string>>;
  /** Prose between the H1 and the first row heading. */
  readonly preamble: string;
  readonly rows: readonly ParsedRow[];
}

/** Recognised prefixes, longest first so `AUDIT` cannot be shadowed. Mirrors `emit.py`. */
const TYPE_PREFIXES: ReadonlyArray<readonly [string, RowType]> = [
  ['TODO', 'todo'],
  ['NOTE', 'note'],
  ['AUDIT', 'audit'],
];

/** The separators his parser strips, in his order: em dash, en dash, hyphen, colon. */
const SEPARATORS = ['—', '–', '-', ':'] as const;

/** The three headers `_lint_prompt_discipline` warns about when absent. */
export const RECOMMENDED_HEADERS = ['**Depends on:**', '**Lands in:**', '**Estimated decisions:**'] as const;

/**
 * Split an H2 heading into a row type and a title.
 *
 * `## TODO 14 — foo` → `('todo', 'foo')`. An unrecognised prefix falls through to freeform rather
 * than raising, which is what his parser does — a book with an odd heading still emits.
 */
export function parseHeading(heading: string): { type: RowType; title: string; n?: number } {
  const text = heading.trim();
  const upper = text.toUpperCase();

  for (const [prefix, type] of TYPE_PREFIXES) {
    const matches =
      upper === prefix ||
      upper.startsWith(`${prefix} `) ||
      upper.startsWith(`${prefix}—`) ||
      upper.startsWith(`${prefix}-`);
    if (!matches) continue;

    let rest = text.slice(prefix.length).trimStart();
    let n: number | undefined;
    const digits = /^\d+/.exec(rest);
    if (digits) {
      n = Number(digits[0]);
      rest = rest.slice(digits[0].length).trimStart();
    }
    for (const sep of SEPARATORS) {
      if (rest.startsWith(sep)) {
        rest = rest.slice(sep.length).trimStart();
        break;
      }
    }
    return n === undefined ? { type, title: rest } : { type, title: rest, n };
  }
  return { type: 'freeform', title: text };
}

/** YAML-ish frontmatter: `key: value` between `---` fences. Values are strings, as his are. */
export function parseFrontmatter(text: string): { frontmatter: Record<string, string>; body: string } {
  if (!text.startsWith('---')) return { frontmatter: {}, body: text };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { frontmatter: {}, body: text };

  const frontmatter: Record<string, string> = {};
  for (const line of text.slice(3, end).split('\n')) {
    const at = line.indexOf(':');
    if (at === -1) continue;
    const key = line.slice(0, at).trim();
    if (key) frontmatter[key] = line.slice(at + 1).trim();
  }
  // Skip the closing fence and its newline.
  const rest = text.slice(end + 4);
  return { frontmatter, body: rest.startsWith('\n') ? rest.slice(1) : rest };
}

export function parseBook(text: string): ParsedBook {
  const { frontmatter, body } = parseFrontmatter(text);
  const lines = body.split('\n');
  const rows: ParsedRow[] = [];
  const preamble: string[] = [];

  let current: { type: RowType; title: string; n?: number; body: string[] } | null = null;
  const flush = () => {
    if (!current) return;
    const { body: b, ...head } = current;
    rows.push({ ...head, body: b.join('\n').trim() });
    current = null;
  };

  for (const line of lines) {
    const h2 = /^##\s+(.+?)\s*$/.exec(line);
    if (h2) {
      flush();
      const parsed = parseHeading(h2[1] as string);
      current = { ...parsed, body: [] };
      continue;
    }
    if (current) current.body.push(line);
    else if (!/^#\s/.test(line)) preamble.push(line);
  }
  flush();

  return { frontmatter, preamble: preamble.join('\n').trim(), rows };
}

/** TODO rows whose body is missing one of the three headers `emit.py` warns about. */
export function undisciplinedTodos(book: ParsedBook): readonly ParsedRow[] {
  return book.rows.filter((r) => r.type === 'todo' && !RECOMMENDED_HEADERS.every((h) => r.body.includes(h)));
}

/** `<…>` a human still owes. Code spans are stripped first, so an example command is not a blank. */
export function blanks(text: string): readonly string[] {
  return text
    .split('\n')
    .filter((line) => /<[a-z][^>]{2,}>/.test(line.replace(/`[^`]*`/g, '')))
    .map((line) => line.trim());
}

/** Render a DevFlow plan as a `.book.md` his emitter accepts unchanged. */
export function renderBook(plan: Plan, frontmatter: Readonly<Record<string, string>>): string {
  const out: string[] = ['---'];
  for (const [k, v] of Object.entries(frontmatter)) out.push(`${k}: ${v}`);
  out.push('---', '', `# ${plan.title}`, '');

  for (const note of plan.notes) out.push(`## NOTE — ${note.title}`, '', note.body, '');

  for (const step of plan.steps) {
    out.push(`## TODO ${step.n} — ${step.title}`, '');
    out.push(`**Depends on:** ${step.dependsOn.length ? step.dependsOn.join(', ') : 'none'}`);
    out.push('**Lands in:**');
    for (const p of step.landsIn) out.push(`- \`${p}\``);
    const decisions = step.estimatedDecisions.map((d) => d.question).join('; ');
    out.push(
      `**Estimated decisions:** ${step.estimatedDecisions.length}${decisions ? ` (${decisions})` : ''}`,
      '',
      '**Prohibited:**',
    );
    for (const p of step.prohibited) out.push(`- ${p}`);
    out.push(
      '',
      `**Executor:** ${step.executor}`,
      '',
      '### Prompt',
      '',
      step.prompt,
      '',
      '### Acceptance criteria',
      '',
    );
    for (const a of step.acceptanceCriteria) out.push(`- ${a}`);
    out.push('');
  }
  return out.join('\n');
}

/** The note titles a briefed book opens with, in MJ's order. */
export const NOTE_ORDER: readonly string[] = [
  'Source',
  'Posture',
  'Hard rules',
  'Source-tree mapping',
  'Replication context',
  'Out of scope',
  'Dependency graph',
];

export function notesInOrder(notes: readonly Note[]): readonly Note[] {
  const rank = (t: string) => {
    const i = NOTE_ORDER.indexOf(t);
    return i === -1 ? NOTE_ORDER.length : i;
  };
  return [...notes].sort((a, b) => rank(a.title) - rank(b.title));
}
