/**
 * Proving a check can fail.
 *
 * A green mutation test — you broke something, the check stayed green — has two possible
 * explanations, and they are not equally likely:
 *
 *   1. the check has a hole, or the code you broke was not load-bearing
 *   2. **your mutation never landed where the check actually looks**
 *
 * (2) is the common one and it is invisible. Observed: editing the first match in a file when the
 * checker reads a later section; editing a NOTE when the checker reads only STEPS; a restore that
 * silently did not happen because `cp` was aliased to `cp -i` and blocked on a prompt nobody
 * answered, so the next run reported success against a file that was still mutated.
 *
 * This module makes (2) impossible to mistake for (1) by requiring the mutation to be proven to
 * have changed **the region the check reads** before its result is allowed to mean anything.
 *
 * Two further design choices remove whole classes of the same bug:
 *
 *   - `proveMutation` operates on **text, not files**. There is nothing to restore, so a restore
 *     cannot silently fail.
 *   - `proveMutationOnFile`, for checks that must read from disk, restores and then **verifies the
 *     restore byte-for-byte**, reporting `restore-failed` rather than returning a verdict it
 *     cannot stand behind.
 */

export type MutationOutcome =
  | {
      /** The mutation did not change what the check reads. Its result says nothing. */
      readonly kind: 'did-not-land';
      readonly why: string;
    }
  | {
      /** The mutation landed and the check still passed. A real hole. */
      readonly kind: 'check-has-a-hole';
      readonly why: string;
    }
  | {
      /** The mutation landed and the check failed. The check holds. */
      readonly kind: 'check-holds';
      readonly why: string;
    }
  | {
      /** The file could not be put back. No verdict is reported, because none can be trusted. */
      readonly kind: 'restore-failed';
      readonly why: string;
    };

export interface MutationSpec {
  /** What the mutation is called, for the report. */
  readonly name: string;
  /** The text before. */
  readonly source: string;
  /** Apply the mutation. Return the same string, or null, when it could not apply. */
  readonly mutate: (source: string) => string | null;
  /**
   * Extract **exactly what the check reads** from a source text.
   *
   * This is the whole mechanism. If a check reads only TODO steps, this returns only TODO steps,
   * and a mutation to a note is then provably outside it. Getting this wrong is the one way to
   * defeat the guard — so it lives beside the check it describes, never beside the mutation.
   */
  readonly region: (source: string) => string;
  /** Run the check against a source. `true` means it passed (green). */
  readonly check: (source: string) => Promise<boolean> | boolean;
}

/**
 * Prove a check can fail, on text.
 *
 * Nothing is written, so nothing has to be restored.
 */
export async function proveMutation(spec: MutationSpec): Promise<MutationOutcome> {
  const after = spec.mutate(spec.source);

  if (after === null) {
    return {
      kind: 'did-not-land',
      why: `${spec.name}: the mutation could not be applied at all — its target was not found in the source`,
    };
  }
  if (after === spec.source) {
    return {
      kind: 'did-not-land',
      why: `${spec.name}: the mutation left the source byte-identical, so nothing was actually broken`,
    };
  }

  const before = spec.region(spec.source);
  const mutated = spec.region(after);
  if (before === mutated) {
    return {
      kind: 'did-not-land',
      why:
        `${spec.name}: the source changed but the part the check reads did not. ` +
        'The check never saw the mutation, so a green result here says nothing about the check. ' +
        'Mutate something inside the checked region.',
    };
  }

  const passed = await spec.check(after);
  return passed
    ? {
        kind: 'check-has-a-hole',
        why: `${spec.name}: the mutation landed in the checked region and the check still passed`,
      }
    : {
        kind: 'check-holds',
        why: `${spec.name}: the mutation landed and the check failed, as it must`,
      };
}

export interface FileMutationSpec extends Omit<MutationSpec, 'source' | 'check'> {
  readonly path: string;
  readonly read: (path: string) => Promise<string>;
  readonly write: (path: string, text: string) => Promise<void>;
  /** Runs the check against whatever is on disk. `true` means it passed. */
  readonly check: () => Promise<boolean> | boolean;
}

/**
 * The same proof for a check that must read from disk.
 *
 * Writes the mutation, runs the check, puts the file back, and then **reads it again** to confirm
 * the restore actually happened. A restore that silently failed once made a later run report
 * success against a file that was still mutated — so the restore is verified rather than assumed,
 * and a failed restore suppresses the verdict entirely.
 */
export async function proveMutationOnFile(spec: FileMutationSpec): Promise<MutationOutcome> {
  const original = await spec.read(spec.path);
  const after = spec.mutate(original);

  if (after === null || after === original) {
    return {
      kind: 'did-not-land',
      why: `${spec.name}: the mutation ${after === null ? 'could not be applied' : 'changed nothing'} in ${spec.path}`,
    };
  }
  if (spec.region(original) === spec.region(after)) {
    return {
      kind: 'did-not-land',
      why:
        `${spec.name}: ${spec.path} changed but the part the check reads did not. ` +
        'The check never saw the mutation. Mutate something inside the checked region.',
    };
  }

  let passed: boolean;
  try {
    await spec.write(spec.path, after);
    passed = await spec.check();
  } finally {
    await spec.write(spec.path, original);
  }

  const restored = await spec.read(spec.path);
  if (restored !== original) {
    return {
      kind: 'restore-failed',
      why:
        `${spec.name}: ${spec.path} was NOT restored — it still differs from the original. ` +
        'No verdict is reported, because a later run would be checking mutated code. Restore it by hand.',
    };
  }

  return passed
    ? { kind: 'check-has-a-hole', why: `${spec.name}: the mutation landed and the check still passed` }
    : { kind: 'check-holds', why: `${spec.name}: the mutation landed and the check failed, as it must` };
}

/** True only when a mutation proved the check works. Every other outcome is a stop. */
export const proved = (outcome: MutationOutcome): boolean => outcome.kind === 'check-holds';
