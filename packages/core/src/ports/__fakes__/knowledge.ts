import type { KnowledgeEntry, KnowledgeStore } from '../knowledge.js';

/** Knowledge in memory. Append-only, like the real thing. */
export class FakeKnowledgeStore implements KnowledgeStore {
  private readonly entries: KnowledgeEntry[] = [];

  constructor(seed: readonly KnowledgeEntry[] = []) {
    this.entries.push(...seed);
  }

  async append(entry: KnowledgeEntry): Promise<void> {
    this.entries.push(entry);
  }

  async forScope(scope: string): Promise<readonly KnowledgeEntry[]> {
    // Verified only. An unverified learning is kept for a human and never fed back into a prompt.
    return this.entries.filter((e) => e.verified && scope.startsWith(e.scope));
  }

  async all(): Promise<readonly KnowledgeEntry[]> {
    return [...this.entries];
  }
}
