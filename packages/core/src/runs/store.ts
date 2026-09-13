import type { RunEvent, RunId } from '@omnitech/devflow-contracts';
import type { Clock } from '../ports/clock.js';
import { fold, type RunView } from './fold.js';

/**
 * Where run events are kept. Append-only by contract, not by convention.
 *
 * There is no `update` and no `delete`, and that absence is the design. A store offering them
 * would eventually be asked to use them, and the day it was, current state would have two possible
 * answers again.
 */
/**
 * `Omit` over a discriminated union collapses it into one object with only the shared keys, so
 * `Omit<RunEvent, 'seq'>` accepts `kind` and nothing else. Distributing over the union first keeps
 * every variant's own fields — caught by the compiler the moment a caller tried to append a real
 * event, which is the argument for a typecheck gate beside a test gate.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A run event as a caller writes it: the store assigns seq, at and runId. */
export type NewRunEvent = DistributiveOmit<RunEvent, 'seq' | 'at' | 'runId'>;

export interface RunEventStore {
  /** Appends. Assigns `seq` itself so two writers cannot pick the same one. */
  append(runId: RunId, event: NewRunEvent): Promise<RunEvent>;
  read(runId: RunId): Promise<readonly RunEvent[]>;
  list(): Promise<readonly RunId[]>;
}

/** In-memory store. The real one writes JSONL; nothing above this line knows that. */
export class MemoryRunEventStore implements RunEventStore {
  private readonly runs = new Map<string, RunEvent[]>();

  constructor(private readonly clock: Clock) {}

  async append(runId: RunId, event: NewRunEvent): Promise<RunEvent> {
    const log = this.runs.get(runId) ?? [];
    // seq is assigned here, never by the caller. A caller-chosen seq is a caller-chosen collision.
    const full = { ...event, seq: log.length, at: this.clock.now().toISOString(), runId } as RunEvent;
    log.push(full);
    this.runs.set(runId, log);
    return full;
  }

  async read(runId: RunId): Promise<readonly RunEvent[]> {
    return [...(this.runs.get(runId) ?? [])];
  }

  async list(): Promise<readonly RunId[]> {
    return [...this.runs.keys()] as RunId[];
  }
}

/** Read a run's current state. Folds on every call and writes nothing. */
export async function viewOf(store: RunEventStore, runId: RunId): Promise<RunView> {
  return fold(await store.read(runId), runId);
}
