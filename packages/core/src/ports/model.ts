import type { ModelRole, Money } from '@omnitech/devflow-contracts';
import type { z } from 'zod';

/**
 * Asking a model for something, by role.
 *
 * The request carries the schema its answer must satisfy. That is not a convenience: a model
 * response is not a domain artifact until it has been parsed into one, and putting the schema in
 * the request means there is no code path where an unparsed response escapes the adapter.
 *
 * `raw` comes back alongside the parsed value so the audit trail keeps what was actually said.
 * Nothing downstream may branch on it.
 */
export interface ModelRequest<T> {
  readonly role: ModelRole;
  readonly prompt: string;
  readonly schema: z.ZodType<T>;
}

export interface ModelResponse<T> {
  readonly value: T;
  readonly cost: Money;
  readonly raw: string;
}

/** Thrown when a response cannot be parsed into the requested schema after the adapter's retries. */
export class ModelOutputInvalid extends Error {
  constructor(
    readonly role: ModelRole,
    readonly raw: string,
    readonly issues: string,
  ) {
    super(`model output for role "${role}" did not match its schema: ${issues}`);
    this.name = 'ModelOutputInvalid';
  }
}

export interface ModelClient {
  complete<T>(request: ModelRequest<T>): Promise<ModelResponse<T>>;
}
