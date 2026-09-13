import { describe, expect, it } from 'vitest';
import { configSources, loadConfig } from './load.js';

/**
 * Layering, tested through `loadConfig` — the only thing the CLI calls. The precedence is the
 * whole point: a personal preference must never silently change what a colleague's run does.
 */

const deps = (files: Record<string, string>, env: Record<string, string | undefined> = {}) => ({
  readFile: async (p: string) => files[p] ?? null,
  env,
  homeDir: '/home/someone',
  repoRoot: '/work/repo',
  join: (...parts: string[]) => parts.join('/'),
});

const GLOBAL = '/home/someone/.devflow/config.json';
const REPO = '/work/repo/.devflow/config.json';

describe('loadConfig', () => {
  it('names where it looks', () => {
    expect(configSources(deps({}))).toEqual({ globalPath: GLOBAL, repoPath: REPO });
  });

  it('runs on defaults when there is no file anywhere', async () => {
    const loaded = await loadConfig(deps({}));
    expect(loaded.files).toEqual([]);
    expect(loaded.config.repository.dir).toBe('.devflow');
  });

  it('lets a repository override a personal preference', async () => {
    // The precedence that matters: a project's settings travel with the checkout.
    const loaded = await loadConfig(
      deps({
        [GLOBAL]: JSON.stringify({ observability: { verbosity: 'quiet' } }),
        [REPO]: JSON.stringify({ observability: { verbosity: 'verbose' } }),
      }),
    );
    expect(loaded.config.observability.verbosity).toBe('verbose');
    expect(loaded.files).toEqual([GLOBAL, REPO]);
  });

  it('deep-merges the two files rather than letting one replace a whole section', async () => {
    // A shallow spread would drop the global budget entirely and the run would use a cap nobody
    // set — silently, which is the worst version of it.
    const loaded = await loadConfig(
      deps({
        [GLOBAL]: JSON.stringify({ budgets: { runMicroUsd: 9_000_000 } }),
        [REPO]: JSON.stringify({ budgets: { maxRetries: 4 } }),
      }),
    );
    expect(loaded.config.budgets).toMatchObject({ runMicroUsd: 9_000_000, maxRetries: 4 });
  });

  it('lets a flag beat both files', async () => {
    const loaded = await loadConfig(deps({ [REPO]: JSON.stringify({ budgets: { maxRetries: 4 } }) }), {
      budgets: { maxRetries: 9 },
    });
    expect(loaded.config.budgets.maxRetries).toBe(9);
  });

  it('reads only the global file when there is no repository one', async () => {
    const loaded = await loadConfig(deps({ [GLOBAL]: JSON.stringify({ budgets: { maxRetries: 7 } }) }));
    expect(loaded.files).toEqual([GLOBAL]);
    expect(loaded.config.budgets.maxRetries).toBe(7);
  });

  it.each([
    ['not json at all', '{ nope'],
    ['a JSON array', '[1, 2, 3]'],
    ['a JSON scalar', '"just a string"'],
    ['JSON null', 'null'],
  ])('refuses %s, naming the file', async (_what, contents) => {
    // Falling back to defaults would be worse than stopping: the run would proceed with settings
    // nobody chose, and the operator would believe the file was in force.
    await expect(loadConfig(deps({ [REPO]: contents }))).rejects.toThrow(/config\.json is not valid/);
  });

  it('resolves environment references from whichever layer set them', async () => {
    const loaded = await loadConfig(
      deps({ [REPO]: JSON.stringify({ repository: { dir: '${DEVFLOW_DIR}' } }) }, { DEVFLOW_DIR: '.ai' }),
    );
    expect(loaded.config.repository.dir).toBe('.ai');
    expect(loaded.settings.find((s) => s.path === 'repository.dir')?.from).toBe('env');
  });
});
