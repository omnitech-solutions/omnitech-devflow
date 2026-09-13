import type { ModelRole } from '@omnitech/devflow-contracts';
import { type ModelClient, ModelOutputInvalid, type ModelRequest, type ModelResponse } from '../model.js';

export interface FakeModelScript {
  /** What this role returns, in order. A role asked more times than scripted throws. */
  readonly [role: string]: readonly unknown[];
}

/**
 * A model with a script.
 *
 * Two properties the tests depend on. It **parses through the request's schema**, so a test whose
 * scripted answer does not match the contract fails in the test rather than in production — a fake
 * that returned its script unparsed would let a wrong-shaped expectation pass. And it **records
 * every call**, so a test can assert which role was asked and what it was asked, which is how the
 * "no provider branching in the domain" rule stays checkable.
 */
export class FakeModelClient implements ModelClient {
  readonly calls: Array<{ role: ModelRole; prompt: string }> = [];
  private readonly cursor = new Map<string, number>();

  constructor(
    private readonly script: FakeModelScript,
    private readonly costMicroUsd = 1_000,
  ) {}

  async complete<T>(request: ModelRequest<T>): Promise<ModelResponse<T>> {
    this.calls.push({ role: request.role, prompt: request.prompt });
    const queue = this.script[request.role] ?? [];
    const i = this.cursor.get(request.role) ?? 0;
    if (i >= queue.length) {
      throw new Error(
        `FakeModelClient: role "${request.role}" asked ${i + 1} times, ${queue.length} scripted`,
      );
    }
    this.cursor.set(request.role, i + 1);
    const next = queue[i];
    const parsed = request.schema.safeParse(next);
    if (!parsed.success) {
      throw new ModelOutputInvalid(request.role, JSON.stringify(next), parsed.error.message);
    }
    return { value: parsed.data, cost: { microUsd: this.costMicroUsd }, raw: JSON.stringify(next) };
  }
}
