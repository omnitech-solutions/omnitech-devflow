import type { DevFlowConfig, Note, Task } from '@omnitech/devflow-contracts';
import type { CodeInspector, SourceLocation } from '../ports/inspector.js';
import type { KnowledgeStore } from '../ports/knowledge.js';

/**
 * The research that happens before a plan exists.
 *
 * Measured against MJ's own playbooks: his execution books run ~6,300 characters per step against
 * ~1,100 for the books that preceded this tool, and the whole difference is research he did first
 * — the file, the line, the constraint's name, the command that finds it again. A step that makes
 * its executor go looking has failed before it starts.
 *
 * Nothing here calls a model. Every fact is read from the repository, and a probe that cannot run
 * says so loudly rather than quietly returning less.
 */

export interface FileFact {
  readonly path: string;
  readonly exists: boolean;
  readonly lines: number;
}

export interface SymbolFact {
  readonly symbol: string;
  readonly definitions: readonly SourceLocation[];
  readonly references: readonly SourceLocation[];
}

export interface DiscoveredContext {
  readonly task: Task;
  readonly houseRules: { readonly file: string | null; readonly rules: readonly string[] };
  readonly files: readonly FileFact[];
  readonly symbols: readonly SymbolFact[];
  readonly knowledge: readonly string[];
  /** Probes that could not run. Named, because a thinner brief must not look like a cleaner one. */
  readonly gaps: readonly string[];
  readonly probes: number;
}

export interface DiscoverDeps {
  readonly inspector: CodeInspector;
  readonly knowledge?: KnowledgeStore;
  /** Reads a repository file. Injected so discovery needs no filesystem of its own. */
  readonly readFile: (path: string) => Promise<string | null>;
}

/** Numbered or bulleted, bold optional. Real rule files are plain `0. For TypeScript…`. */
const RULE_RE = /^\s*(?:\d+[.)]|[-*])\s+\S.{15,}/gm;

export async function discover(
  task: Task,
  config: DevFlowConfig,
  deps: DiscoverDeps,
): Promise<DiscoveredContext> {
  const gaps: string[] = [];
  let probes = 0;

  // House rules first: they outrank anything a plan says, so a plan written without them is
  // written against the wrong constraints.
  let houseFile: string | null = null;
  let rules: string[] = [];
  for (const candidate of config.repository.houseRuleFiles) {
    const text = await deps.readFile(candidate);
    probes += 1;
    if (text === null) continue;
    houseFile = candidate;
    rules = [...text.matchAll(RULE_RE)].map((m) => m[0].trim().replace(/\s+/g, ' ').slice(0, 180));
    break;
  }
  if (!houseFile)
    gaps.push(`no house rules found (looked for ${config.repository.houseRuleFiles.join(', ')})`);

  const files: FileFact[] = [];
  for (const path of task.paths) {
    const text = await deps.readFile(path);
    probes += 1;
    files.push({ path, exists: text !== null, lines: text === null ? 0 : text.split('\n').length });
  }

  const symbols: SymbolFact[] = [];
  const inspectorUp = await deps.inspector.available();
  probes += 1;
  if (!inspectorUp) {
    // The loudest possible gap. Every structural claim in the resulting plan would be unverified,
    // and a brief that is quietly thinner reads exactly like a brief that found less to say.
    gaps.push('the code inspector could not run — no structural claim in this plan is verified');
  } else {
    const scope = config.repository.roots.length ? { roots: config.repository.roots } : undefined;
    for (const symbol of task.symbols) {
      const [definitions, references] = await Promise.all([
        deps.inspector.definitionsOf(symbol, scope),
        deps.inspector.referencesTo(symbol, scope),
      ]);
      probes += 2;
      symbols.push({ symbol, definitions, references });
    }
  }

  // Only verified learnings load forward. One from a step that escalated is kept for a human and
  // never fed back into a plan, or the system teaches itself its own mistakes.
  const knowledge =
    config.knowledge.loadForward && deps.knowledge
      ? (await deps.knowledge.forScope(config.repository.roots[0] ?? '')).map((k) => `${k.kind}: ${k.text}`)
      : [];

  return { task, houseRules: { file: houseFile, rules }, files, symbols, knowledge, gaps, probes };
}

/**
 * The context notes a plan opens with, in MJ's order.
 *
 * Every one is filled from what discovery measured. The three a machine cannot know — what is out
 * of scope, what the posture is, how the steps depend on each other — are left for a human, and
 * `blanks()` refuses to emit while they are unfilled.
 */
export function notesFrom(ctx: DiscoveredContext): readonly Note[] {
  const bullets = (items: readonly string[], empty: string) =>
    items.length ? items.map((i) => `- ${i}`).join('\n') : `- ${empty}`;

  const source = [
    'The task, as given:',
    '',
    `> ${ctx.task.text.split('\n')[0] as string}`,
    ...(ctx.task.ticketKey ? ['', `Ticket: **${ctx.task.ticketKey}**.`] : []),
    ...(ctx.task.urls.length ? ['', 'Surfaces named in the task:', bullets(ctx.task.urls, '')] : []),
  ].join('\n');

  const posture = [
    'Three properties this plan has on purpose:',
    '',
    '1. **Every claim was measured, not remembered.** The file and line citations come from AST',
    '   queries run when this plan was written, and the command that re-derives each is in the step.',
    '2. **A step that needs a decision names it.** A step claiming zero decisions is claiming they',
    '   were made above; a step claiming two must say what both are.',
    '3. **Prohibited is enforcement, not advice.** It names the tempting wrong move, so an executor',
    '   that makes it has disobeyed rather than guessed.',
  ].join('\n');

  const hardRules = ctx.houseRules.file
    ? `From \`${ctx.houseRules.file}\` — these outrank anything in this plan:\n\n${bullets(
        ctx.houseRules.rules,
        'file present but no numbered rules parsed — read it before the first step',
      )}`
    : 'No house-rules file found. Each step carries its own constraints.';

  const tree = [
    'What the task names, as it exists on disk today:',
    '',
    '```',
    ...ctx.files.map((f) =>
      f.exists
        ? `${f.path.padEnd(56)} ${String(f.lines).padStart(5)} lines`
        : `${f.path.padEnd(56)} DOES NOT EXIST`,
    ),
    '```',
    ...(ctx.symbols.length
      ? [
          '',
          '| symbol | defined | called |',
          '|---|---|---|',
          ...ctx.symbols.map(
            (s) =>
              `| \`${s.symbol}\` | ${fmt(s.definitions) || '—'} | ${fmt(s.references) || '**no call sites**'} |`,
          ),
        ]
      : []),
    ...(ctx.gaps.length ? ['', ...ctx.gaps.map((g) => `**Gap: ${g}.**`)] : []),
  ].join('\n');

  const replication = ctx.knowledge.length
    ? `What earlier runs learned about this area:\n\n${bullets(ctx.knowledge, '')}`
    : 'No prior verified learnings for this area — this is new ground.';

  return [
    { title: 'Source', body: source },
    { title: 'Posture', body: posture },
    { title: 'Hard rules', body: hardRules },
    { title: 'Source-tree mapping', body: tree },
    { title: 'Replication context', body: replication },
    {
      title: 'Out of scope',
      body: '<what this plan deliberately does not touch — one line each, with a reason>',
    },
    {
      title: 'Dependency graph',
      body: '<which step must precede which, and one sentence on why that order>',
    },
  ];
}

const fmt = (locations: readonly SourceLocation[]): string =>
  locations.map((l) => `${l.path}:${l.line}`).join(', ');
