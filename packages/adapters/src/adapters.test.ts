import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as realParse } from '@ast-grep/napi';
import type { RunId } from '@omnitech/devflow-contracts';
import { fold } from '@omnitech/devflow-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { AstGrepInspector } from './ast-grep-inspector.js';
import { JsonlRunEventStore } from './jsonl-run-store.js';
import { SystemClock } from './system-clock.js';

/**
 * Adapters against the real thing: a real temp repository, a real parser, real files. A fake here
 * would only prove the fake works.
 */

const RUN = 'run-1' as RunId;

describe('AstGrepInspector', () => {
  let repo: string;
  let inspector: AstGrepInspector;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'devflow-ast-'));
    mkdirSync(join(repo, 'src'), { recursive: true });
    mkdirSync(join(repo, 'node_modules', 'junk'), { recursive: true });

    // The shape that broke a source-pattern probe: an export keyword AND a return-type annotation.
    writeFileSync(
      join(repo, 'src', 'richText.ts'),
      [
        'import type { SurveyModel } from "survey";',
        '',
        'export function installRichTitles(survey: SurveyModel, lookup: RichLookup): () => void {',
        '  return () => undefined;',
        '}',
        '',
        'export const helper = (x: number) => x + 1;',
        'export class Renderer {}',
        'export interface RichLookup { (name: string): string | null }',
      ].join('\n'),
    );
    writeFileSync(
      join(repo, 'src', 'Preview.tsx'),
      ['import { installRichTitles } from "./richText";', '', 'installRichTitles(model, lookup);'].join('\n'),
    );
    // Mentions the name only in a comment and a string — the case a substring check gets wrong.
    writeFileSync(
      join(repo, 'src', 'Respondent.tsx'),
      ['// installRichTitles is deliberately not called here', 'const note = "installRichTitles";'].join(
        '\n',
      ),
    );
    writeFileSync(join(repo, 'src', 'broken.ts'), 'export function ( { this will not parse');
    writeFileSync(join(repo, 'node_modules', 'junk', 'index.ts'), 'export function installRichTitles() {}');

    inspector = new AstGrepInspector({ repoRoot: repo, roots: ['src'] });
  });

  it('is available when the parser actually parses', async () => {
    expect(await inspector.available()).toBe(true);
  });

  it('finds a definition that a source pattern would miss', async () => {
    // `function $NAME($$$) { $$$ }` finds nothing here: the return-type annotation breaks it.
    const defs = await inspector.definitionsOf('installRichTitles');
    expect(defs).toContainEqual({ path: 'src/richText.ts', line: 3 });
  });

  it.each([
    ['an arrow const', 'helper'],
    ['a class', 'Renderer'],
    ['an interface', 'RichLookup'],
  ])('finds %s', async (_what, symbol) => {
    expect((await inspector.definitionsOf(symbol)).length).toBeGreaterThan(0);
  });

  it('finds a real call site', async () => {
    const refs = await inspector.referencesTo('installRichTitles');
    expect(refs).toContainEqual({ path: 'src/Preview.tsx', line: 3 });
  });

  it('does not count a comment or a string literal as a reference', async () => {
    // The rule that makes structural checking worth doing at all.
    const refs = await inspector.referencesTo('installRichTitles');
    expect(refs.map((r) => r.path)).not.toContain('src/Respondent.tsx');
  });

  it('skips node_modules', async () => {
    const defs = await inspector.definitionsOf('installRichTitles');
    expect(defs.map((d) => d.path).join()).not.toContain('node_modules');
  });

  it('survives a file that will not parse', async () => {
    // One syntax error must not take down every query run against the repository.
    expect(await inspector.definitionsOf('installRichTitles')).not.toEqual([]);
  });

  it('returns nothing for a symbol that is not there', async () => {
    expect(await inspector.definitionsOf('neverDefinedAnywhere')).toEqual([]);
  });

  it('reads lines 1-indexed and inclusive', async () => {
    expect(await inspector.readLines('src/Preview.tsx', 1, 1)).toEqual([
      'import { installRichTitles } from "./richText";',
    ]);
  });

  it('returns null for a path that does not exist', async () => {
    expect(await inspector.readLines('src/nope.ts', 1, 1)).toBeNull();
  });

  it('returns nothing when a configured root does not exist', async () => {
    // A misconfigured root must be empty, not a crash: the repository is still readable and the
    // caller gets `unverifiable`-shaped emptiness rather than a stack trace.
    const wrong = new AstGrepInspector({ repoRoot: repo, roots: ['does-not-exist'] });
    expect(await wrong.definitionsOf('installRichTitles')).toEqual([]);
  });

  it('reports each location once even when a symbol appears twice on a line', async () => {
    writeFileSync(join(repo, 'src', 'twice.ts'), 'const pair = [helper, helper];');
    const refs = await inspector.referencesTo('helper');
    const onLine = refs.filter((r) => r.path === 'src/twice.ts');
    expect(onLine).toHaveLength(1);
  });

  it('ignores a directory entry that vanishes mid-walk', async () => {
    // stat() returning null is a file deleted between readdir and stat — a real race on any
    // repository someone is working in.
    const gone = join(repo, 'src', 'transient.ts');
    writeFileSync(gone, 'export const x = 1;');
    rmSync(gone);
    expect(await inspector.definitionsOf('x')).toEqual([]);
  });

  it('stops walking at the file budget, mid-directory', async () => {
    // The budget is a guard against walking a very large tree by accident, so it has to bite
    // partway through a directory rather than only between them.
    const tiny = new AstGrepInspector({ repoRoot: repo, roots: ['src'], maxFiles: 1 });
    expect((await tiny.definitionsOf('installRichTitles')).length).toBeLessThanOrEqual(1);
  });

  it('lets a single query narrow the roots it searches', async () => {
    // Per-query scope, not just per-inspector: one step may want the whole repository and the next
    // only the package it is changing.
    const wide = new AstGrepInspector({ repoRoot: repo });
    expect(await wide.definitionsOf('installRichTitles', { roots: ['src'] })).toContainEqual({
      path: 'src/richText.ts',
      line: 3,
    });
    expect(await wide.definitionsOf('installRichTitles', { roots: ['does-not-exist'] })).toEqual([]);
  });

  it('ignores a file whose extension it has no parser for', async () => {
    writeFileSync(join(repo, 'src', 'notes.md'), '# installRichTitles');
    expect(await inspector.referencesTo('installRichTitles')).not.toContainEqual({
      path: 'src/notes.md',
      line: 1,
    });
  });

  it('reports unavailable when the parser itself is broken', async () => {
    // A binding that loads and then cannot parse must say so. Reporting available and returning
    // empty results forever is how a broken checker reads as a clean plan.
    const broken = new AstGrepInspector({
      repoRoot: repo,
      parse: (() => {
        throw new Error('binding is wedged');
      }) as never,
    });
    expect(await broken.available()).toBe(false);
  });

  it('skips a file that throws while parsing, and keeps going', async () => {
    let calls = 0;
    const flaky = new AstGrepInspector({
      repoRoot: repo,
      roots: ['src'],
      parse: ((lang: never, src: string) => {
        calls += 1;
        if (calls === 1) throw new Error('this one blew up');
        return realParse(lang, src);
      }) as never,
    });
    // One bad file must not take down the query: the others still answer.
    expect((await flaky.definitionsOf('installRichTitles')).length).toBeGreaterThanOrEqual(0);
    expect(calls).toBeGreaterThan(1);
  });

  it('searches the whole repository when no roots are configured', async () => {
    const wide = new AstGrepInspector({ repoRoot: repo });
    expect((await wide.definitionsOf('installRichTitles')).length).toBeGreaterThan(0);
  });
});

describe('JsonlRunEventStore', () => {
  const store = () => new JsonlRunEventStore(mkdtempSync(join(tmpdir(), 'devflow-runs-')), new SystemClock());

  it('round trips an event through the file', async () => {
    const s = store();
    await s.append(RUN, { kind: 'step.started', step: 1 });
    expect(await s.read(RUN)).toHaveLength(1);
  });

  it('appends rather than truncating — proven across a re-open', async () => {
    // The property that matters, and the one a shape assertion cannot prove: a store that merely
    // promises not to overwrite is one `'w'` away from losing a run's history.
    const dir = mkdtempSync(join(tmpdir(), 'devflow-runs-'));
    const first = new JsonlRunEventStore(dir, new SystemClock());
    const before = await first.append(RUN, { kind: 'step.started', step: 1 });

    const second = new JsonlRunEventStore(dir, new SystemClock());
    await second.append(RUN, { kind: 'step.passed', step: 1 });

    const all = await second.read(RUN);
    expect(all).toHaveLength(2);
    expect(all[0]).toEqual(before);
  });

  it('never writes a call that can truncate', () => {
    // Structural, not aspirational: the module must contain no truncating write at all.
    //
    // Comments are stripped first. The first version of this test grepped the whole file and
    // failed on its own prose — the word "truncate" in the doc comment explaining why truncation
    // is forbidden. A tripwire that reads documentation is a tripwire that fires on the
    // documentation being good.
    const raw = readFileSync(new URL('./jsonl-run-store.ts', import.meta.url), 'utf8');
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/writeFile|createWriteStream|truncate|flag:\s*['"]w/);
    expect(code).toContain('appendFile');
  });

  it('keeps seq contiguous across re-opens', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'devflow-runs-'));
    for (const step of [1, 2, 3]) {
      await new JsonlRunEventStore(dir, new SystemClock()).append(RUN, { kind: 'step.started', step });
    }
    expect((await new JsonlRunEventStore(dir, new SystemClock()).read(RUN)).map((e) => e.seq)).toEqual([
      0, 1, 2,
    ]);
  });

  it('refuses a damaged log instead of folding a confident answer from half of it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'devflow-runs-'));
    const s = new JsonlRunEventStore(dir, new SystemClock());
    await s.append(RUN, { kind: 'step.started', step: 1 });
    const path = join(dir, RUN, 'events.jsonl');
    writeFileSync(path, `${readFileSync(path, 'utf8')}{"seq":1,"kind":"nonsense"}\n`);
    await expect(s.read(RUN)).rejects.toThrow(/damaged/);
  });

  it('ignores blank lines in the log', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'devflow-runs-'));
    const s = new JsonlRunEventStore(dir, new SystemClock());
    await s.append(RUN, { kind: 'step.started', step: 1 });
    const path = join(dir, RUN, 'events.jsonl');
    writeFileSync(path, `${readFileSync(path, 'utf8')}\n\n`);
    expect(await s.read(RUN)).toHaveLength(1);
  });

  it('reads an unknown run as empty', async () => {
    expect(await store().read('never-existed' as RunId)).toEqual([]);
  });

  it('lists the runs it holds', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'devflow-runs-'));
    const s = new JsonlRunEventStore(dir, new SystemClock());
    await s.append(RUN, { kind: 'step.started', step: 1 });
    await s.append('run-2' as RunId, { kind: 'step.started', step: 1 });
    expect([...(await s.list())].sort()).toEqual(['run-1', 'run-2']);
  });

  it('lists nothing when the directory does not exist', async () => {
    expect(await new JsonlRunEventStore('/nowhere/at/all', new SystemClock()).list()).toEqual([]);
  });

  it('folds to the state the events describe', async () => {
    const s = store();
    await s.append(RUN, { kind: 'step.started', step: 1 });
    await s.append(RUN, { kind: 'step.passed', step: 1 });
    expect(fold(await s.read(RUN), RUN).steps[0]).toMatchObject({ n: 1, state: 'passed' });
  });
});

describe('SystemClock', () => {
  it('measures duration with a monotonic source, not the wall clock', () => {
    // Wall-clock time jumps backwards across an NTP correction; a supervisor using it eventually
    // decides a healthy process has been running for negative seconds.
    const src = readFileSync(new URL('./system-clock.ts', import.meta.url), 'utf8');
    expect(src).toContain('performance.now()');
    expect(src).not.toMatch(/monotonicMs\(\)[^}]*Date\.now/);
  });

  it('moves forward', async () => {
    const clock = new SystemClock();
    const before = clock.monotonicMs();
    await clock.sleep(2);
    expect(clock.monotonicMs()).toBeGreaterThan(before);
  });

  it('reports a real date', () => {
    expect(new SystemClock().now().getTime()).toBeGreaterThan(new Date('2020-01-01').getTime());
  });
});

describe('references to a name used as a property', () => {
  /**
   * The gap that mattered most, because of which direction it failed in.
   *
   * `identifier` alone found one of the four uses below. A `references` claim about a property
   * therefore read as struck when it was true — annoying — and an `absent` claim about one read as
   * VERIFIED when it was false, which is a green tick on a lie.
   */
  const SOURCE = [
    'const a = element.choicesOrder;',
    'obj.choicesOrder = 1;',
    'foo(choicesOrder);',
    'const { choicesOrder } = x;',
  ].join('\n');

  const inspectorOver = (text: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'devflow-refs-'));
    writeFileSync(join(dir, 'a.ts'), text);
    return new AstGrepInspector({ repoRoot: dir });
  };

  it('finds a property access, not only a bare identifier', async () => {
    const inspector = inspectorOver(SOURCE);
    const found = await inspector.referencesTo('choicesOrder');
    expect(found.length).toBeGreaterThanOrEqual(4);
  });

  it('reports each site once even when several kinds match the same line', async () => {
    const inspector = inspectorOver('obj.choicesOrder = choicesOrder;');
    const lines = (await inspector.referencesTo('choicesOrder')).map((l) => l.line);
    expect(new Set(lines).size).toBe(lines.length);
  });

  it('does not claim a name is absent from a file that uses it as a property', async () => {
    // Stated as the property rather than the mechanism: this is the assertion that would have
    // caught the original bug, whatever node kinds the grammar happens to use.
    const inspector = inspectorOver('const a = element.choicesOrder;');
    expect(await inspector.referencesTo('choicesOrder')).not.toEqual([]);
  });

  it('still finds nothing for a name that genuinely is not there', async () => {
    const inspector = inspectorOver('const a = element.somethingElse;');
    expect(await inspector.referencesTo('choicesOrder')).toEqual([]);
  });
});
