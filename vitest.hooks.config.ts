import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config.js';

/**
 * What pre-commit and pre-push enforce: 80%.
 *
 * Deliberately below the 100% a PR is written to. The hook's job is to stop a commit that has
 * stopped being tested at all, not to adjudicate the last few branches at the moment someone is
 * trying to save their work. The full bar runs in `pnpm check` and in CI.
 */
export default mergeConfig(
  base,
  defineConfig({
    test: { coverage: { thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 } } },
  }),
);
