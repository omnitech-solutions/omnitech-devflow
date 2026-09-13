import { z } from 'zod';
import { taskIdSchema } from './ids.js';

/**
 * A task, as a human gave it.
 *
 * Deliberately forgiving. Someone pasting a ticket should not have to reformat it, and someone
 * typing one line should not have to fill a form. Anything the parser misses is added by hand to
 * the plan — a parser that demands structure is a parser people route around.
 *
 * `ticketKey` is not Linear-shaped. The prefix pattern is configuration, so `LGN-`, `ENG-` and no
 * ticket system at all are the same code path.
 */
export const taskSchema = z.strictObject({
  id: taskIdSchema,
  /** Verbatim, always kept — the plan quotes it back so a reader can check the interpretation. */
  text: z.string().min(1),
  title: z.string().min(1),
  ticketKey: z.string().min(1).optional(),
  /** Surfaces named in the task: a dev server, a staging page, a reference implementation. */
  urls: z.array(z.string().url()),
  /** Repository-relative paths the human named. Whether they exist is a finding, not an input. */
  paths: z.array(z.string().min(1)),
  /** Identifiers worth asking the syntax tree about. */
  symbols: z.array(z.string().min(1)),
});
export type Task = z.infer<typeof taskSchema>;
