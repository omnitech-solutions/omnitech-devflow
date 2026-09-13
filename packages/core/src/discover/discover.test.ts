import { describe, expect, it } from 'vitest';
import { blanks } from '../book/parse.js';
import { DEFAULTS } from '../config/resolve.js';
import { FakeInspector, FakeKnowledgeStore } from '../ports/__fakes__/index.js';
import { discover, notesFrom } from './context.js';
import { intake, slug } from './intake.js';

/**
 * Discovery, tested through `discover` and `notesFrom` — the two things anything else calls.
 * Every case is a way the research could be quietly wrong, because a plan built on a thin brief
 * looks exactly like a plan built on a good one.
 */

const config = DEFAULTS;
const ticketPattern = config.repository.ticketPattern;

const files: Record<string, string> = {
  'AGENTS.md': [
    '# Rules',
    '',
    '0. For structural review use AST tooling; grep may support navigation but must never be the basis of a conclusion.',
    '7. No mock tests. Zero. Tests must exercise the real database and real service boundary.',
  ].join('\n'),
  'src/richText.ts': 'export function installRichTitles() {}\n',
};

const deps = (over: Partial<Parameters<typeof discover>[2]> = {}) => ({
  inspector: new FakeInspector({
    definitions: { installRichTitles: [{ path: 'src/richText.ts', line: 1 }] },
    references: { installRichTitles: [{ path: 'src/Preview.tsx', line: 302 }] },
  }),
  readFile: async (p: string) => files[p] ?? null,
  ...over,
});

describe('intake', () => {
  it('reads a pasted ticket and a typed sentence the same way', () => {
    const task = intake(
      'LGN-2201: respondent drops rich question titles\n\n`src/richText.ts` holds installRichTitles.\nRepro: http://127.0.0.1:5173/x',
      { ticketPattern },
    );
    expect(task.ticketKey).toBe('LGN-2201');
    expect(task.id).toBe('LGN-2201');
    expect(task.title).toBe('respondent drops rich question titles');
    expect(task.paths).toContain('src/richText.ts');
    expect(task.symbols).toContain('installRichTitles');
    expect(task.urls).toEqual(['http://127.0.0.1:5173/x']);
  });

  it('falls back to the branch name for a ticket key', () => {
    // Most people already put the ticket in the branch; asking again is a question with an answer
    // already on screen.
    const task = intake('fix the thing', { ticketPattern, branch: 'desmond/ENG-42-fix-the-thing' });
    expect(task.ticketKey).toBe('ENG-42');
  });

  it('works with no ticket system at all', () => {
    const task = intake('make the preview wider', { ticketPattern });
    expect(task.ticketKey).toBeUndefined();
    expect(task.id).toBe('make-the-preview-wider');
  });

  it('never cuts a title mid-word', () => {
    // "…through the cano" is how a truncation announces nobody thought about it.
    const title = intake(
      'Make the respondent render rich question titles by carrying the stored html through the canonical compile so the published survey keeps it',
      { ticketPattern },
    ).title;
    expect(title.endsWith('…')).toBe(true);
    expect(title).not.toMatch(/can…$|cano…$|canonic…$/);
  });

  it('keeps the text verbatim so a reader can check the interpretation', () => {
    const text = 'LGN-1: a thing\nwith a second line';
    expect(intake(text, { ticketPattern }).text).toBe(text);
  });

  it('does not mistake a sentence for a symbol', () => {
    expect(intake('please make it wider', { ticketPattern }).symbols).toEqual([]);
  });

  it('does not mistake a capitalised sentence opener for a symbol', () => {
    expect(intake('Please make the preview wider', { ticketPattern }).symbols).toEqual([]);
  });

  it.each([
    ['camelCase', 'installRichTitles is missing', 'installRichTitles'],
    ['PascalCase', 'DialogContent caps the width', 'DialogContent'],
    ['backticked', 'see `SOME_CONSTANT` in the file', 'SOME_CONSTANT'],
  ])('finds a %s symbol', (_shape, text, expected) => {
    // PascalCase is every React component, class and type. An earlier pattern required a lowercase
    // first letter and made all of them invisible.
    expect(intake(text, { ticketPattern }).symbols).toContain(expected);
  });

  it.each([
    ['A Title With Spaces', 'a-title-with-spaces'],
    ['trailing---', 'trailing'],
    ['!!!', 'work'],
  ])('slugs %s', (input, expected) => {
    expect(slug(input)).toBe(expected);
  });
});

describe('discover', () => {
  const task = intake('LGN-1: fix `src/richText.ts` where installRichTitles lives', { ticketPattern });

  it('reads the house rules that outrank the plan', async () => {
    const ctx = await discover(task, config, deps());
    expect(ctx.houseRules.file).toBe('AGENTS.md');
    expect(ctx.houseRules.rules).toHaveLength(2);
    expect(ctx.houseRules.rules[0]).toContain('AST tooling');
  });

  it('reports a file that does not exist rather than assuming it does', async () => {
    const t = intake('touch `src/imaginary.ts`', { ticketPattern });
    const ctx = await discover(t, config, deps());
    expect(ctx.files).toContainEqual({ path: 'src/imaginary.ts', exists: false, lines: 0 });
  });

  it('asks the syntax tree where a symbol is defined and called', async () => {
    const ctx = await discover(task, config, deps());
    expect(ctx.symbols[0]).toMatchObject({
      symbol: 'installRichTitles',
      definitions: [{ path: 'src/richText.ts', line: 1 }],
      references: [{ path: 'src/Preview.tsx', line: 302 }],
    });
  });

  it('records a loud gap when the inspector cannot run', async () => {
    // A thinner brief must never read like a cleaner one.
    const ctx = await discover(task, config, deps({ inspector: new FakeInspector({ available: false }) }));
    expect(ctx.symbols).toEqual([]);
    expect(ctx.gaps.join()).toContain('no structural claim in this plan is verified');
  });

  it('records a gap when there are no house rules', async () => {
    const ctx = await discover(task, config, deps({ readFile: async () => null }));
    expect(ctx.gaps.join()).toContain('no house rules found');
  });

  it('loads only verified learnings forward', async () => {
    const knowledge = new FakeKnowledgeStore([
      {
        kind: 'warning',
        scope: '',
        text: 'verified thing',
        source: 'a/1',
        verified: true,
        at: '2026-01-01T00:00:00.000Z',
      },
      {
        kind: 'hint',
        scope: '',
        text: 'unverified thing',
        source: 'a/2',
        verified: false,
        at: '2026-01-01T00:00:00.000Z',
      },
    ]);
    const ctx = await discover(task, config, deps({ knowledge }));
    expect(ctx.knowledge).toEqual(['warning: verified thing']);
  });

  it('loads nothing forward when the config says not to', async () => {
    const off = { ...config, knowledge: { ...config.knowledge, loadForward: false } };
    const ctx = await discover(task, off, deps({ knowledge: new FakeKnowledgeStore([]) }));
    expect(ctx.knowledge).toEqual([]);
  });

  it('counts its probes, so a brief can say how much looking it did', async () => {
    const ctx = await discover(task, config, deps());
    expect(ctx.probes).toBeGreaterThan(3);
  });

  it('narrows to the configured roots', async () => {
    const scoped = { ...config, repository: { ...config.repository, roots: ['src'] } };
    const ctx = await discover(task, scoped, deps());
    expect(ctx.symbols[0]?.definitions).toHaveLength(1);
  });
});

describe('notesFrom', () => {
  const task = intake('LGN-1: fix `src/richText.ts` where installRichTitles lives — see http://x.test/a', {
    ticketPattern,
  });

  it("produces MJ's seven, in his order", async () => {
    const notes = notesFrom(await discover(task, config, deps()));
    expect(notes.map((n) => n.title)).toEqual([
      'Source',
      'Posture',
      'Hard rules',
      'Source-tree mapping',
      'Replication context',
      'Out of scope',
      'Dependency graph',
    ]);
  });

  it('fills the five a machine can know', async () => {
    const notes = notesFrom(await discover(task, config, deps()));
    const body = (t: string) => notes.find((n) => n.title === t)?.body ?? '';
    expect(body('Source')).toContain('LGN-1');
    expect(body('Source')).toContain('http://x.test/a');
    expect(body('Hard rules')).toContain('AST tooling');
    expect(body('Source-tree mapping')).toContain('src/richText.ts:1');
    expect(body('Replication context')).toContain('new ground');
  });

  it('leaves the two a machine cannot know as blanks a human must fill', async () => {
    // Out of scope and the dependency graph are judgements. A plan that guessed them would be a
    // plan asserting something nobody decided.
    const notes = notesFrom(await discover(task, config, deps()));
    const unfilled = notes.filter((n) => blanks(n.body).length > 0).map((n) => n.title);
    expect(unfilled).toEqual(['Out of scope', 'Dependency graph']);
  });

  it('says "no call sites" rather than leaving a cell empty', async () => {
    const t = intake('about someUnusedThing', { ticketPattern });
    const notes = notesFrom(await discover(t, config, deps()));
    expect(notes.find((n) => n.title === 'Source-tree mapping')?.body).toContain('**no call sites**');
  });

  it('puts the gap in the tree note where a reader will see it', async () => {
    const ctx = await discover(task, config, deps({ inspector: new FakeInspector({ available: false }) }));
    expect(notesFrom(ctx).find((n) => n.title === 'Source-tree mapping')?.body).toContain('**Gap:');
  });

  it('reports a missing file in the tree', async () => {
    const t = intake('touch `src/imaginary.ts`', { ticketPattern });
    const notes = notesFrom(await discover(t, config, deps()));
    expect(notes.find((n) => n.title === 'Source-tree mapping')?.body).toContain('DOES NOT EXIST');
  });

  it('surfaces prior learnings when there are any', async () => {
    const knowledge = new FakeKnowledgeStore([
      {
        kind: 'warning',
        scope: '',
        text: 'templates are only set for piped text',
        source: 'a/1',
        verified: true,
        at: '2026-01-01T00:00:00.000Z',
      },
    ]);
    const notes = notesFrom(await discover(task, config, deps({ knowledge })));
    expect(notes.find((n) => n.title === 'Replication context')?.body).toContain('piped text');
  });

  it('handles a task with no files and no symbols', async () => {
    const t = intake('set the licence key in the QA environment', { ticketPattern });
    const notes = notesFrom(await discover(t, config, deps()));
    expect(notes).toHaveLength(7);
  });
});

describe('the shapes a real task actually arrives in', () => {
  it.each([
    ['LGN-1:', 'work'],
    ['One sentence. A second one that should not be in the title.', 'One sentence'],
  ])('titles %j as %j', (text, expected) => {
    expect(intake(text, { ticketPattern }).title).toBe(expected);
  });

  it.each([['   \n  \n'], ['']])('refuses an empty task with a sentence, not a schema dump', (text) => {
    expect(() => intake(text, { ticketPattern })).toThrow(/at least a sentence/);
  });

  it('names a task with no ticket after what it does', () => {
    expect(intake('widen the preview', { ticketPattern }).id).toBe('widen-the-preview');
  });

  it('ignores a branch that carries no ticket', () => {
    expect(intake('do a thing', { ticketPattern, branch: 'main' }).ticketKey).toBeUndefined();
  });
});

describe('notes when there is little to say', () => {
  it('omits the surfaces line when the task named no urls', async () => {
    const t = intake('LGN-1: about `src/richText.ts`', { ticketPattern });
    const notes = notesFrom(await discover(t, config, deps()));
    expect(notes.find((n) => n.title === 'Source')?.body).not.toContain('Surfaces named');
  });

  it('omits the ticket line when there is no ticket', async () => {
    const t = intake('just do the thing', { ticketPattern });
    const notes = notesFrom(await discover(t, config, deps()));
    expect(notes.find((n) => n.title === 'Source')?.body).not.toContain('Ticket:');
  });

  it('says the rule file was found but unparseable rather than claiming none exists', async () => {
    const empty = { ...files, 'AGENTS.md': '# Rules\n\nnothing numbered here\n' };
    const t = intake('LGN-1: a task', { ticketPattern });
    const ctx = await discover(t, config, { ...deps(), readFile: async (p: string) => empty[p] ?? null });
    expect(notesFrom(ctx).find((n) => n.title === 'Hard rules')?.body).toContain(
      'read it before the first step',
    );
  });

  it('reports no house-rules file at all distinctly', async () => {
    const t = intake('LGN-1: a task', { ticketPattern });
    const ctx = await discover(t, config, deps({ readFile: async () => null }));
    expect(notesFrom(ctx).find((n) => n.title === 'Hard rules')?.body).toContain('No house-rules file found');
  });
});
