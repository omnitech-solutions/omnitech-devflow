import type { Dirent } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { Lang, parse } from '@ast-grep/napi';
import type { CodeInspector, InspectorScope, SourceLocation } from '@omnitech/devflow-core';

/**
 * Code questions answered by the syntax tree.
 *
 * Definitions are asked as a **node-kind** question rather than a source pattern. A pattern like
 * `function $NAME($$$) { $$$ }` finds nothing for `export function installRichTitles(…): () => void`
 * — a return-type annotation alone is enough to break it — and the earlier version of this probe
 * reported "no definition" for a function that was defined at a line it had already read. A kind
 * rule does not care about export keywords, return types, or which of the five ways TypeScript
 * spells a definition was used.
 *
 * References are call and identifier sites, never substring hits. A substring check once reported
 * PASS on a file that mentioned a symbol only in an import, a comment and a string literal.
 */

const LANGS: ReadonlyArray<readonly [string, Lang]> = [
  ['.ts', Lang.TypeScript],
  ['.tsx', Lang.Tsx],
  ['.js', Lang.JavaScript],
  ['.jsx', Lang.Tsx],
];

const SKIP = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', '.next', 'vendor']);

const langFor = (file: string): Lang | undefined => LANGS.find(([ext]) => ext === extname(file))?.[1];

/** Every definition shape TypeScript uses, asked by node kind. */
const DEFINITION_KINDS = [
  'function_declaration',
  'function_signature',
  'class_declaration',
  'method_definition',
  'variable_declarator',
  'interface_declaration',
  'type_alias_declaration',
] as const;

/**
 * The parse call, injectable.
 *
 * Not indirection for its own sake: the two failure branches below — a binding that loads but
 * cannot parse, and a file that throws mid-walk — are unreachable from a fixture, and a guard
 * nobody can test is a guard nobody knows works. Injecting the one function makes both real tests.
 */
export type ParseFn = typeof parse;

export interface AstGrepInspectorOptions {
  readonly repoRoot: string;
  /** Defaults to @ast-grep/napi's `parse`. Overridden only by tests. */
  readonly parse?: ParseFn;
  /** Default roots when a query does not name its own. Empty means the whole repository. */
  readonly roots?: readonly string[];
  /** Guard against walking a very large tree by accident. */
  readonly maxFiles?: number;
}

export class AstGrepInspector implements CodeInspector {
  private readonly parse: ParseFn;
  private readonly defaultRoots: readonly string[];
  private readonly budget: number;

  constructor(private readonly options: AstGrepInspectorOptions) {
    // Normalised once. Three chained fallbacks at the call site are three branches that have to
    // be tested to mean anything, and they said nothing a default here does not say better.
    this.parse = options.parse ?? parse;
    this.defaultRoots = options.roots ?? [];
    this.budget = options.maxFiles ?? 5_000;
  }

  async available(): Promise<boolean> {
    try {
      // Prove the parser works rather than that the module imported. A binding that loaded but
      // cannot parse would otherwise report itself healthy and return empty results forever —
      // which is how "I could not look" becomes indistinguishable from "I looked".
      // Parse something trivial and reach into the tree. Checking only that `parse` returned
      // would pass for a binding that hands back an unusable object.
      return this.parse(Lang.TypeScript, 'const a = 1;').root().children().length >= 0;
    } catch {
      // A broken binding must report unavailable, so evidence comes back `unverifiable` rather
      // than silently empty — "I could not look" is not "I looked".
      return false;
    }
  }

  async definitionsOf(symbol: string, scope?: InspectorScope): Promise<readonly SourceLocation[]> {
    return this.search(scope, (root) =>
      DEFINITION_KINDS.flatMap((kind) =>
        root.findAll({ rule: { kind, has: { field: 'name', regex: `^${escapeRegex(symbol)}$` } } }),
      ),
    );
  }

  async referencesTo(symbol: string, scope?: InspectorScope): Promise<readonly SourceLocation[]> {
    return this.search(scope, (root) =>
      root.findAll({ rule: { kind: 'identifier', regex: `^${escapeRegex(symbol)}$` } }),
    );
  }

  async readLines(path: string, from: number, to: number): Promise<readonly string[] | null> {
    try {
      const text = await readFile(join(this.options.repoRoot, path), 'utf8');
      // 1-indexed and inclusive, the way a citation names a line.
      return text.split('\n').slice(Math.max(0, from - 1), to);
    } catch {
      // Unreadable is null, never an empty array. Empty would mean "the file has no such lines";
      // null means "there is no file", and evidence tells those apart.
      return null;
    }
  }

  private async search(
    scope: InspectorScope | undefined,
    find: (
      root: ReturnType<ReturnType<typeof parse>['root']>,
    ) => ReadonlyArray<{ range(): { start: { line: number } } }>,
  ): Promise<readonly SourceLocation[]> {
    const roots = scope?.roots ?? this.defaultRoots;
    const dirs = roots.length ? roots.map((r) => join(this.options.repoRoot, r)) : [this.options.repoRoot];
    const out: SourceLocation[] = [];

    for (const dir of dirs) {
      for (const file of await walk(dir, this.budget, [])) {
        const lang = langFor(file);
        if (!lang) continue;
        let root: ReturnType<ReturnType<typeof parse>['root']>;
        try {
          root = this.parse(lang, readFileSync(file, 'utf8')).root();
        } catch {
          // A file that will not parse is not a match and not a crash. One bad file in a
          // repository must not take down every query run against it.
          continue;
        }
        for (const node of find(root)) {
          out.push({ path: relative(this.options.repoRoot, file), line: node.range().start.line + 1 });
        }
      }
    }
    return dedupe(out);
  }
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const dedupe = (locations: readonly SourceLocation[]): readonly SourceLocation[] => {
  const seen = new Set<string>();
  return locations.filter((l) => {
    const key = `${l.path}:${l.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

async function walk(dir: string, budget: number, acc: string[]): Promise<string[]> {
  // `withFileTypes` gets the entry's kind from the same syscall that listed it. The earlier
  // version called `stat` per entry, which opened a window where a file deleted between the two
  // produced an error nothing could deterministically reproduce — a branch that could never be
  // tested, guarding a race that need not exist.
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    // An unreadable directory is empty, not fatal: one bad path must not fail the whole query.
    return acc;
  }
  for (const entry of entries) {
    if (SKIP.has(entry.name) || acc.length >= budget) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, budget, acc);
    else acc.push(full);
  }
  return acc;
}
