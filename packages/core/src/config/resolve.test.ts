import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULTS, interpolate, merge, resolveConfig } from './resolve.js';

/**
 * Config, tested through `resolveConfig` — the only entry point anything uses. The two grep tests
 * at the bottom are the ones that keep this tool transferable; they are cheap and they are the
 * only thing standing between "works anywhere" and "works here".
 */

describe('resolveConfig', () => {
  it('returns a valid config from nothing at all', () => {
    expect(resolveConfig().config.repository.dir).toBe('.devflow');
  });

  it('layers file over defaults', () => {
    const { config } = resolveConfig({ file: { repository: { dir: '.ai' } } });
    expect(config.repository.dir).toBe('.ai');
    // Untouched siblings survive: a file that sets one key must not blank the rest of its section.
    expect(config.repository.houseRuleFiles).toEqual(DEFAULTS.repository.houseRuleFiles);
  });

  it('layers flags over file', () => {
    const { config } = resolveConfig({
      file: { observability: { verbosity: 'quiet' } },
      flags: { observability: { verbosity: 'verbose' } },
    });
    expect(config.observability.verbosity).toBe('verbose');
  });

  it('replaces arrays instead of merging them element-wise', () => {
    // Merged element-wise, an array can never be shortened — a repository wanting one house-rule
    // file could not drop the other two.
    const { config } = resolveConfig({ file: { repository: { houseRuleFiles: ['RULES.md'] } } });
    expect(config.repository.houseRuleFiles).toEqual(['RULES.md']);
  });

  it('rejects a value the schema does not allow, naming the path', () => {
    expect(() => resolveConfig({ file: { budgets: { runMicroUsd: -1 } } })).toThrow(/runMicroUsd/);
  });

  it('completes a half-specified section rather than rejecting it', () => {
    const { config } = resolveConfig({ file: { budgets: { maxRetries: 3 } } });
    expect(config.budgets.maxRetries).toBe(3);
    expect(config.budgets.runMicroUsd).toBe(DEFAULTS.budgets.runMicroUsd);
  });
});

describe('environment references', () => {
  it('resolves ${VAR} from the environment', () => {
    const { config } = resolveConfig({ env: { DEVFLOW_OUTLINE_MODEL: 'some-model' } });
    expect(config.models.roles.outline?.model).toBe('some-model');
  });

  it('reports an unresolved reference instead of shipping the placeholder', () => {
    // A config that passes "${DEVFLOW_OUTLINE_MODEL}" through as a model name fails at the
    // provider with a confusing error. Failing here names the variable.
    const { unresolved } = resolveConfig({ env: {} });
    expect(unresolved).toContain('DEVFLOW_OUTLINE_MODEL');
  });

  it('treats an empty environment variable as unset', () => {
    const { unresolved } = resolveConfig({ env: { DEVFLOW_OUTLINE_MODEL: '' } });
    expect(unresolved).toContain('DEVFLOW_OUTLINE_MODEL');
  });

  const interpolations: ReadonlyArray<[string, Record<string, string>, string]> = [
    ['${A}', { A: 'x' }, 'x'],
    ['${A:-fallback}', {}, 'fallback'],
    ['${A:-fallback}', { A: 'x' }, 'x'],
    ['${A:-}', {}, ''],
    ['plain text', {}, 'plain text'],
    ['${A} and ${B}', { A: 'x' }, '${A} and ${B}'],
    ['$NOTBRACED', { NOTBRACED: 'x' }, '$NOTBRACED'],
  ];

  it.each(interpolations)('interpolates %s', (raw, env, expected) => {
    expect(interpolate(raw, env).value).toBe(expected);
  });
});

describe('provenance', () => {
  const find = (settings: readonly { path: string; from: string }[], path: string) =>
    settings.find((s) => s.path === path)?.from;

  it('records where every value came from', () => {
    const { settings } = resolveConfig({
      file: { repository: { dir: '.ai' } },
      flags: { observability: { verbosity: 'verbose' } },
      env: { DEVFLOW_OUTLINE_MODEL: 'm' },
    });
    expect(find(settings, 'repository.dir')).toBe('file');
    expect(find(settings, 'observability.verbosity')).toBe('flag');
    expect(find(settings, 'models.roles.outline.model')).toBe('env');
    expect(find(settings, 'budgets.maxRetries')).toBe('default');
  });

  it('covers every leaf, so nothing a run used is unaccounted for', () => {
    const { settings, config } = resolveConfig({ env: {} });
    for (const path of ['repository.dir', 'budgets.runMicroUsd', 'knowledge.store', 'execution.silenceMs']) {
      expect(find(settings, path), path).toBeDefined();
    }
    expect(config.knowledge.store).toBe('jsonl');
  });
});

describe('merge', () => {
  it('is deep for objects', () => {
    expect(merge({ a: { b: 1, c: 2 } }, { a: { c: 3 } })).toEqual({ a: { b: 1, c: 3 } });
  });

  it('ignores undefined so an absent flag does not blank a value', () => {
    expect(merge({ a: 1 }, { a: undefined })).toEqual({ a: 1 });
  });

  it('replaces a primitive with an object and vice versa', () => {
    expect(merge({ a: 1 }, { a: { b: 2 } })).toEqual({ a: { b: 2 } });
    expect(merge({ a: { b: 2 } }, { a: 1 })).toEqual({ a: 1 });
  });
});

/**
 * The transferability guards. DevFlow has to be the same application in a repository nobody here
 * has seen, for a company nobody here works at.
 */
describe('what must never appear in the domain', () => {
  const SRC = join(import.meta.dirname, '..', '..', '..');

  const sources = (dir: string, acc: string[] = []): string[] => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (e === 'node_modules' || e === 'dist' || e === 'coverage') continue;
      if (statSync(p).isDirectory()) sources(p, acc);
      else if (e.endsWith('.ts') && !e.endsWith('.test.ts')) acc.push(p);
    }
    return acc;
  };

  const files = sources(join(SRC, 'core', 'src')).concat(sources(join(SRC, 'contracts', 'src')));

  it('finds sources to check, so a passing grep means something', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  /** Our own package scope is not a customer's name. Everything else in an import is. */
  const withoutOwnScope = (src: string) => src.replaceAll('@omnitech/devflow-contracts', '<self>');

  it.each([
    // A model name in the domain is a model name that has to be edited to change providers.
    [
      'model or provider literals',
      /\b(gpt-|claude-[0-9]|glm-|gemini-|llama-|mistral|openai|anthropic|openrouter|lm[_-]?studio)\b/i,
    ],
    // A customer or colleague in the defaults is something the next company has to delete.
    ['organisation or person names', /\b(copia|legion|desoleary|qualtrics)\b/i],
  ])('no %s', (_name, pattern) => {
    const offenders = files.filter((f) => pattern.test(withoutOwnScope(readFileSync(f, 'utf8'))));
    expect(offenders.map((f) => f.slice(SRC.length + 1))).toEqual([]);
  });
});
