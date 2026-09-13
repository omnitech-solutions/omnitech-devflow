import type { CodeInspector, InspectorScope, SourceLocation } from '../inspector.js';

export interface FakeInspectorSeed {
  readonly definitions?: Readonly<Record<string, readonly SourceLocation[]>>;
  readonly references?: Readonly<Record<string, readonly SourceLocation[]>>;
  /** path → lines, 1-indexed when read. */
  readonly files?: Readonly<Record<string, readonly string[]>>;
  readonly available?: boolean;
}

/**
 * A code inspector with a known answer.
 *
 * `available: false` is the case worth having a fake for at all: it is the only way to test that
 * an unrunnable checker produces `unverifiable` evidence rather than a silent pass.
 */
export class FakeInspector implements CodeInspector {
  constructor(private readonly seed: FakeInspectorSeed = {}) {}

  async available(): Promise<boolean> {
    return this.seed.available ?? true;
  }

  async definitionsOf(symbol: string, _scope?: InspectorScope): Promise<readonly SourceLocation[]> {
    return this.seed.definitions?.[symbol] ?? [];
  }

  async referencesTo(symbol: string, _scope?: InspectorScope): Promise<readonly SourceLocation[]> {
    return this.seed.references?.[symbol] ?? [];
  }

  async readLines(path: string, from: number, to: number): Promise<readonly string[] | null> {
    const lines = this.seed.files?.[path];
    if (!lines) return null;
    // 1-indexed and inclusive, matching how a citation names a line.
    return lines.slice(Math.max(0, from - 1), to);
  }
}
