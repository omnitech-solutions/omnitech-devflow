import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Every package's tests, one runner. A second config is how a suite starts
    // being invisible to the gate that is supposed to be running it.
    include: ['packages/*/src/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
    environment: 'node',
    clearMocks: true,
    coverage: { provider: 'v8', reporter: ['text', 'json-summary'] },
  },
});
