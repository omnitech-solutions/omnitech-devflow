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
export interface RunEventStore {
  /** Appends. Assigns `seq` itself so two writers cannot pick the same one. */
  append(runId: RunId, event: Omit<RunEvent, 'seq' | 'at' | 'runId'>): Promise<RunEvent>;
  read(runId: RunId): Promise<readonly RunEvent[]>;
  list(): Promise<readonly RunId[]>;
}

/** In-memory store. The real one writes JSONL; nothing above this line knows that. */
export class MemoryRunEventStore implements RunEventStore {
  private readonly runs = new Map<string, RunEvent[]>();

  constructor(private readonly clock: Clock) {}

  async append(runId: RunId, event: Omit<RunEvent, 'seq' | 'at' | 'runId'>): Promise<RunEvent> {
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
