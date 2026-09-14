import { describe, expect, it } from 'vitest';
import { gitignoreFor, ignoredPaths } from './setup.js';

/**
 * What `devflow setup` commits and what it keeps local.
 *
 * The default changed, deliberately: `tasks/` used to be ignored alongside `runs/`, so the book —
 * the plan a reviewer is supposed to read and argue with — was never in the pull request that
 * implemented it. That removes most of the reason for writing a plan down. `runs/` stays ignored;
 * it is one machine's append-only log, it grows without bound, and it is noise in a diff.
 */

describe('the default', () => {
  it('ignores runs and nothing else', () => {
    expect(ignoredPaths({})).toEqual(['runs']);
  });

  it('commits the plans, because a plan git never sees cannot be reviewed', () => {
    expect(ignoredPaths({})).not.toContain('tasks');
  });
});

describe('--ignore', () => {
  it('keeps a path local', () => {
    expect(ignoredPaths({ ignore: 'tasks' })).toEqual(['runs', 'tasks']);
  });

  it('takes a comma-separated list', () => {
    expect(ignoredPaths({ ignore: 'tasks,scratch' })).toEqual(['runs', 'tasks', 'scratch']);
  });

  it('accepts a path DevFlow does not know about', () => {
    // A repository may put something of its own under the DevFlow directory. Having to patch
    // DevFlow to ignore it would be absurd.
    expect(ignoredPaths({ ignore: 'our-own-thing' })).toContain('our-own-thing');
  });

  it('tolerates a trailing slash and surrounding space', () => {
    expect(ignoredPaths({ ignore: ' tasks/ , runs/ ' })).toEqual(['runs', 'tasks']);
  });

  it('does not list the same path twice', () => {
    expect(ignoredPaths({ ignore: 'runs' })).toEqual(['runs']);
  });
});

describe('--keep', () => {
  it('commits something that is ignored by default', () => {
    expect(ignoredPaths({ keep: 'runs' })).toEqual([]);
  });

  it('loses to --ignore when a path is named in both', () => {
    // Someone has contradicted themselves. Resolving toward "keep it local" is the safe reading —
    // committing something the operator also asked to ignore is the harder mistake to undo.
    expect(ignoredPaths({ keep: 'runs', ignore: 'runs' })).toEqual(['runs']);
  });
});

describe('a flag that is not a string', () => {
  it.each([[true], [42], [null], [undefined]])('is ignored rather than crashing setup: %j', (value) => {
    expect(ignoredPaths({ ignore: value, keep: value })).toEqual(['runs']);
  });
});

describe('the generated .gitignore', () => {
  it('says how to change it, in the file itself', () => {
    // The file is read by people, not only by git. Someone finding their plans missing from a PR
    // should learn the fix from the file that caused it.
    const text = gitignoreFor(['runs']);
    expect(text).toContain('devflow setup --force --keep');
    expect(text).toContain('devflow setup --force --ignore');
  });

  it('explains each ignored path rather than just listing it', () => {
    expect(gitignoreFor(['runs'])).toContain('grows without bound');
  });

  it('lists an unknown path without inventing a reason for it', () => {
    const text = gitignoreFor(['our-own-thing']);
    expect(text).toContain('our-own-thing/');
    expect(text).not.toContain('grows without bound');
  });

  it('says so plainly when nothing is ignored', () => {
    expect(gitignoreFor([])).toContain('every DevFlow artifact in this repository is committed');
  });

  it('ends with a newline, as a text file should', () => {
    expect(gitignoreFor(['runs']).endsWith('\n')).toBe(true);
  });
});
