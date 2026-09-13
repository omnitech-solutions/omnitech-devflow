import type { RunId } from '@omnitech/devflow-contracts';
import { describe, expect, it } from 'vitest';
import { FakeClock } from '../ports/__fakes__/index.js';
import { fold, gateFor } from './fold.js';
import { MemoryRunEventStore, viewOf } from './store.js';

/**
 * Tested through the store and the fold together, because that pair is the thing being claimed:
 * append events, ask for state, get an answer nobody had to keep in sync.
 */

const RUN = 'run-1' as RunId;
const store = () => new MemoryRunEventStore(new FakeClock());

describe('the log is append-only', () => {
  it('offers no way to change what was written', () => {
    // The absence is the design. A store with `update` is a store that will be asked to use it,
    // and the day it is, current state has two possible answers again.
    const s = store();
    expect(s).not.toHaveProperty('update');
    expect(s).not.toHaveProperty('delete');
  });

  it('assigns seq itself, so two writers cannot pick the same one', async () => {
    const s = store();
    const a = await s.append(RUN, { kind: 'step.started', step: 1 });
    const b = await s.append(RUN, { kind: 'step.started', step: 2 });
    expect([a.seq, b.seq]).toEqual([0, 1]);
  });

  it('keeps earlier events byte-for-byte when later ones arrive', async () => {
    const s = store();
    await s.append(RUN, { kind: 'step.started', step: 1 });
    const before = await s.read(RUN);
    await s.append(RUN, { kind: 'step.passed', step: 1 });
    const after = await s.read(RUN);
    expect(after[0]).toEqual(before[0]);
  });

  it('reading does not write', async () => {
    const s = store();
    await s.append(RUN, { kind: 'step.started', step: 1 });
    await viewOf(s, RUN);
    await viewOf(s, RUN);
    expect(await s.read(RUN)).toHaveLength(1);
  });
});

describe('fold', () => {
  it('reports an unseen run as running with nothing in it', () => {
    expect(fold([], RUN)).toMatchObject({ state: 'running', steps: [], seq: -1 });
  });

  it('orders by seq, not by timestamp', () => {
    // Two events in the same millisecond tie, and a clock that steps backwards reorders history.
    const at = '2026-09-13T14:21:00.000Z';
    const view = fold(
      [
        { seq: 1, at, runId: RUN, kind: 'step.passed', step: 1 },
        { seq: 0, at, runId: RUN, kind: 'step.started', step: 1 },
      ],
      RUN,
    );
    expect(view.steps[0]).toMatchObject({ n: 1, state: 'passed' });
  });

  it('counts attempts instead of overwriting them', async () => {
    // "We tried this three times" should be visible, not inferred from a log nobody reads.
    const s = store();
    for (const _ of [1, 2, 3]) await s.append(RUN, { kind: 'step.started', step: 2 });
    const view = await viewOf(s, RUN);
    expect(view.steps[0]).toMatchObject({ n: 2, attempts: 3 });
  });

  it('carries the latest evidence onto the step', async () => {
    const s = store();
    await s.append(RUN, { kind: 'step.started', step: 1 });
    await s.append(RUN, {
      kind: 'evidence.checked',
      step: 1,
      report: { items: [], verified: 9, struck: 0, unverifiable: 1 },
    });
    const view = await viewOf(s, RUN);
    expect(view.steps[0]?.evidence).toMatchObject({ verified: 9, unverifiable: 1 });
  });

  it('sums cost across roles', async () => {
    const s = store();
    await s.append(RUN, { kind: 'cost.recorded', role: 'outline', spent: { microUsd: 11_000 } });
    await s.append(RUN, { kind: 'cost.recorded', role: 'expansion', spent: { microUsd: 43_000 } });
    expect((await viewOf(s, RUN)).spent.microUsd).toBe(54_000);
  });

  it('puts the run in waiting-for-operator when a step needs one', async () => {
    const s = store();
    await s.append(RUN, { kind: 'step.started', step: 4 });
    await s.append(RUN, {
      kind: 'step.stopped',
      step: 4,
      reason: 'needs-operator',
      detail: 'cannot determine the expected contract',
    });
    const view = await viewOf(s, RUN);
    expect(view.state).toBe('waiting-for-operator');
    expect(view.steps[0]).toMatchObject({ state: 'stopped', stoppedBecause: 'needs-operator' });
  });

  it('does not put the run in waiting for a non-operator stop', async () => {
    const s = store();
    await s.append(RUN, { kind: 'step.stopped', step: 1, reason: 'evidence-failed', detail: 'x' });
    expect((await viewOf(s, RUN)).state).toBe('running');
  });

  it.each([
    ['completed', 'completed'],
    ['stopped', 'stopped'],
  ] as const)('finishes as %s', async (outcome, expected) => {
    const s = store();
    await s.append(RUN, { kind: 'run.finished', outcome });
    const view = await viewOf(s, RUN);
    expect(view.state).toBe(expected);
    expect(view.finishedAt).toBeDefined();
  });

  it('records when the run started', async () => {
    const s = store();
    await s.append(RUN, { kind: 'run.started', taskId: 'T-1' as never, mode: 'plan' });
    expect((await viewOf(s, RUN)).startedAt).toBeDefined();
  });

  it('ignores events that carry no state', async () => {
    const s = store();
    await s.append(RUN, { kind: 'context.gathered', probes: 5 });
    await s.append(RUN, { kind: 'plan.created', planId: 'p-1' as never, steps: 4 });
    expect((await viewOf(s, RUN)).steps).toEqual([]);
  });

  it('reports the highest seq folded, so a snapshot can say what it saw', async () => {
    const s = store();
    await s.append(RUN, { kind: 'step.started', step: 1 });
    await s.append(RUN, { kind: 'step.passed', step: 1 });
    expect((await viewOf(s, RUN)).seq).toBe(1);
  });

  it('orders steps by number regardless of arrival', async () => {
    const s = store();
    await s.append(RUN, { kind: 'step.started', step: 3 });
    await s.append(RUN, { kind: 'step.started', step: 1 });
    expect((await viewOf(s, RUN)).steps.map((x) => x.n)).toEqual([1, 3]);
  });
});

describe('two gate records for one run', () => {
  /**
   * The incident this exists for: a full-scope record was written, a later narrower run overwrote
   * the same file, and a verifier rejected the work for a scope it could no longer see.
   */
  const both = async () => {
    const s = store();
    await s.append(RUN, {
      kind: 'gates.recorded',
      scope: 'full',
      candidateDigest: 'digest-A' as never,
      passed: true,
    });
    await s.append(RUN, {
      kind: 'gates.recorded',
      scope: 'selected',
      candidateDigest: 'digest-A' as never,
      passed: false,
    });
    return viewOf(s, RUN);
  };

  it('keeps both', async () => {
    expect((await both()).gates).toHaveLength(2);
  });

  it('does not let the later, narrower run discard the earlier full one', async () => {
    const view = await both();
    expect(gateFor(view, 'digest-A')).toMatchObject({ scope: 'full', passed: true });
  });

  it('picks by digest, never by recency', async () => {
    const s = store();
    await s.append(RUN, {
      kind: 'gates.recorded',
      scope: 'full',
      candidateDigest: 'digest-A' as never,
      passed: true,
    });
    await s.append(RUN, {
      kind: 'gates.recorded',
      scope: 'full',
      candidateDigest: 'digest-B' as never,
      passed: false,
    });
    const view = await viewOf(s, RUN);
    expect(gateFor(view, 'digest-A')?.passed).toBe(true);
    expect(gateFor(view, 'digest-B')?.passed).toBe(false);
  });

  it('returns nothing for a candidate that was never gated', async () => {
    expect(gateFor(await both(), 'digest-never-run')).toBeUndefined();
  });

  it('falls back to a selected-scope record when that is all there is', async () => {
    const s = store();
    await s.append(RUN, {
      kind: 'gates.recorded',
      scope: 'selected',
      candidateDigest: 'digest-C' as never,
      passed: true,
    });
    expect(gateFor(await viewOf(s, RUN), 'digest-C')).toMatchObject({ scope: 'selected' });
  });
});

describe('the store keeps runs apart', () => {
  it('lists what it has', async () => {
    const s = store();
    await s.append(RUN, { kind: 'step.started', step: 1 });
    await s.append('run-2' as RunId, { kind: 'step.started', step: 1 });
    expect([...(await s.list())].sort()).toEqual(['run-1', 'run-2']);
  });

  it(`numbers each run's events from zero`, async () => {
    const s = store();
    await s.append(RUN, { kind: 'step.started', step: 1 });
    const other = await s.append('run-2' as RunId, { kind: 'step.started', step: 1 });
    expect(other.seq).toBe(0);
  });

  it('reads an unknown run as empty rather than throwing', async () => {
    expect(await store().read('never-existed' as RunId)).toEqual([]);
  });
});
