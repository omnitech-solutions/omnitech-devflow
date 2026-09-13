import { z } from 'zod';

/**
 * What earlier runs learned, for the next one to read.
 *
 * Three kinds, and the shape is append-only like everything else DevFlow persists. JSONL is one
 * implementation; the port says nothing about it.
 *
 * The rule that matters is `verified`. Only verified entries load forward — a learning extracted
 * from a step that escalated is recorded for a human to read but never fed back into a prompt, or
 * the system teaches itself its own mistakes and does it with increasing confidence.
 */
export const knowledgeKindSchema = z.enum(['hint', 'pattern', 'warning']);
export type KnowledgeKind = z.infer<typeof knowledgeKindSchema>;

export const knowledgeEntrySchema = z.strictObject({
  kind: knowledgeKindSchema,
  /** Where it applies: a path prefix, a package name, a subsystem. Matched by prefix. */
  scope: z.string().min(1),
  text: z.string().min(1),
  /** Which run and step produced it, so a reader can go and check. */
  source: z.string().min(1),
  /** False for anything a stopped or escalated step produced. */
  verified: z.boolean(),
  at: z.string().datetime(),
});
export type KnowledgeEntry = z.infer<typeof knowledgeEntrySchema>;

export interface KnowledgeStore {
  append(entry: KnowledgeEntry): Promise<void>;
  /** Verified entries whose scope prefixes the given one. Never returns unverified entries. */
  forScope(scope: string): Promise<readonly KnowledgeEntry[]>;
  /** Everything, verified or not — for `devflow knowledge list`, where a human is reading. */
  all(): Promise<readonly KnowledgeEntry[]>;
}
