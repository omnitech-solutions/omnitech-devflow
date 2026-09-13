import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Every package's tests, one runner. A second config is how a suite starts being invisible to
    // the gate that is supposed to be running it.
    include: ['packages/*/src/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
    environment: 'node',
    clearMocks: true,
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary', 'html'],
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/__fakes__/**', '**/index.ts', '**/dist/**'],
      // The bar a PR is written to. The hooks enforce a lower one (see lefthook.yml): a gate set
      // at the aspiration is a gate people learn to skip, and a skipped gate measures nothing.
      thresholds: { lines: 100, functions: 100, branches: 100, statements: 100 },
    },
  },
});
