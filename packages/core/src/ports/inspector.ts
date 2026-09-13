/**
 * Asking questions about source code.
 *
 * Named for what DevFlow wants to know, not for the tool that answers. `definitionsOf` is the
 * domain question; whether ast-grep, ts-morph or a language server answers it belongs in an
 * adapter. The alternative — an `astGrep.run(pattern)` port — would make the pattern language part
 * of the domain and nail the tool in place.
 *
 * `available()` exists because of a specific failure: a structural check that could not run once
 * reported PASS, and "I could not look" read as "I looked". Evidence has a distinct `unverifiable`
 * status for exactly this, and it needs a port that can say so.
 */
export interface SourceLocation {
  readonly path: string;
  /** 1-indexed, as every editor and every error message counts them. */
  readonly line: number;
}

export interface InspectorScope {
  /** Repository-relative roots to search. Empty means the whole repository. */
  readonly roots?: readonly string[];
}

export interface CodeInspector {
  /** Is the underlying tool usable right now? False means results are absent, not empty. */
  available(): Promise<boolean>;
  /** Where a symbol is defined — across every shape the language spells a definition. */
  definitionsOf(symbol: string, scope?: InspectorScope): Promise<readonly SourceLocation[]>;
  /** Where it is called or referenced. Never a substring match. */
  referencesTo(symbol: string, scope?: InspectorScope): Promise<readonly SourceLocation[]>;
  /** The lines themselves, for checking a quoted fragment. `null` when the path is unreadable. */
  readLines(path: string, from: number, to: number): Promise<readonly string[] | null>;
}
