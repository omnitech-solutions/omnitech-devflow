import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { type RunEvent, type RunId, runEventSchema } from '@omnitech/devflow-contracts';
import type { Clock, NewRunEvent, RunEventStore } from '@omnitech/devflow-core';

/**
 * The run log on disk, one JSON object per line.
 *
 * Append-only is enforced by the file mode, not by discipline. Every write uses `appendFile`; the
 * module contains no call that can truncate, and a test asserts that writing after a re-open
 * leaves the first event byte-for-byte intact. A store that merely *promises* not to overwrite is
 * one `'w'` away from losing a run's history — which is precisely how a full-scope gate record was
 * lost once already.
 */
export class JsonlRunEventStore implements RunEventStore {
  constructor(
    private readonly dir: string,
    private readonly clock: Clock,
  ) {}

  private file(runId: RunId): string {
    return join(this.dir, runId, 'events.jsonl');
  }

  async append(runId: RunId, event: NewRunEvent): Promise<RunEvent> {
    const existing = await this.read(runId);
    const full = runEventSchema.parse({
      ...event,
      seq: existing.length,
      at: this.clock.now().toISOString(),
      runId,
    });
    const path = this.file(runId);
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(full)}\n`, 'utf8');
    return full;
  }

  async read(runId: RunId): Promise<readonly RunEvent[]> {
    let text: string;
    try {
      text = await readFile(this.file(runId), 'utf8');
    } catch {
      return [];
    }
    const out: RunEvent[] = [];
    for (const [i, line] of text.split('\n').entries()) {
      if (!line.trim()) continue;
      const parsed = runEventSchema.safeParse(JSON.parse(line));
      if (!parsed.success) {
        // A corrupt line is named, not skipped. Silently dropping it would make the fold produce a
        // confident answer from an incomplete history, which is worse than refusing.
        throw new Error(
          `${this.file(runId)}:${i + 1} is not a valid run event — the log is damaged and the ` +
            `run's state cannot be trusted. ${parsed.error.issues.map((x) => x.message).join('; ')}`,
        );
      }
      out.push(parsed.data);
    }
    return out;
  }

  async list(): Promise<readonly RunId[]> {
    try {
      return (await readdir(this.dir, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name as RunId);
    } catch {
      return [];
    }
  }
}
