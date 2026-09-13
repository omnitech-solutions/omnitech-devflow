import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plan } from '@omnitech/devflow-contracts';
import { describe, expect, it } from 'vitest';
import {
  blanks,
  NOTE_ORDER,
  notesInOrder,
  parseBook,
  parseFrontmatter,
  parseHeading,
  renderBook,
  undisciplinedTodos,
} from './parse.js';

/**
 * The book format is an interop contract, so the tests are about agreeing with someone else's
 * parser rather than about our own preferences. The fixture at the bottom is the real
 * `example.book.md` that ships with prompt-magic: if our parser and his disagree about it, ours
 * is wrong.
 */

describe('parseHeading', () => {
  const cases: ReadonlyArray<readonly [string, string, string, number | undefined]> = [
    ['TODO 1 — point this book at a repo', 'todo', 'point this book at a repo', 1],
    ['NOTE — how a book flows', 'note', 'how a book flows', undefined],
    ['AUDIT 5 — cadence retrospective', 'audit', 'cadence retrospective', 5],
    // Every separator his parser strips, in his order.
    ['TODO 2 – en dash', 'todo', 'en dash', 2],
    ['TODO 3 - ascii hyphen', 'todo', 'ascii hyphen', 3],
    ['TODO 4: colon', 'todo', 'colon', 4],
    ['TODO—no space before dash', 'todo', 'no space before dash', undefined],
    ['TODO 14 — a two digit number', 'todo', 'a two digit number', 14],
    ['todo 1 — lowercase prefix', 'todo', 'lowercase prefix', 1],
    ['TODO', 'todo', '', undefined],
    // Unrecognised prefixes fall through rather than raising: a book with an odd heading still
    // emits, which is what his parser does.
    ['Something else entirely', 'freeform', 'Something else entirely', undefined],
  ];

  it.each(cases)('%s', (heading, type, title, n) => {
    expect(parseHeading(heading)).toMatchObject(n === undefined ? { type, title } : { type, title, n });
  });
});

describe('parseFrontmatter', () => {
  it('reads key: value pairs between fences', () => {
    const { frontmatter, body } = parseFrontmatter('---\nslug: example\nname: A Book\n---\n# A Book\n');
    expect(frontmatter).toEqual({ slug: 'example', name: 'A Book' });
    expect(body).toBe('# A Book\n');
  });

  it('keeps a colon inside a value', () => {
    const { frontmatter } = parseFrontmatter('---\nrepo_url: https://example.com/a/b\n---\n');
    expect(frontmatter.repo_url).toBe('https://example.com/a/b');
  });

  it('passes a document with no frontmatter through untouched', () => {
    expect(parseFrontmatter('# No frontmatter\n')).toEqual({ frontmatter: {}, body: '# No frontmatter\n' });
  });

  it('does not treat an unterminated fence as frontmatter', () => {
    const text = '---\nslug: broken\n# never closed\n';
    expect(parseFrontmatter(text).frontmatter).toEqual({});
  });

  it('handles a closing fence with nothing after it', () => {
    expect(parseFrontmatter('---\nslug: a\n---').body).toBe('');
  });

  it('skips lines that are not key: value', () => {
    const { frontmatter } = parseFrontmatter('---\nslug: a\nnot a pair\n: novalue\n---\n');
    expect(frontmatter).toEqual({ slug: 'a' });
  });
});

describe('parseBook', () => {
  const book = [
    '---',
    'slug: demo',
    '---',
    '',
    '# Demo',
    '',
    'Prose before any row.',
    '',
    '## NOTE — context',
    '',
    'Some context.',
    '',
    '## TODO 1 — do the thing',
    '',
    '**Depends on:** none',
    '**Lands in:** src/a.ts',
    '**Estimated decisions:** 0',
    '',
    'Body prose.',
    '',
  ].join('\n');

  it('separates frontmatter, preamble and rows', () => {
    const parsed = parseBook(book);
    expect(parsed.frontmatter.slug).toBe('demo');
    expect(parsed.preamble).toBe('Prose before any row.');
    expect(parsed.rows.map((r) => r.type)).toEqual(['note', 'todo']);
  });

  it('keeps a row body verbatim', () => {
    expect(parseBook(book).rows[1]?.body).toContain('**Estimated decisions:** 0');
  });

  it('handles a book with no rows at all', () => {
    expect(parseBook('# Empty\n\njust prose\n').rows).toEqual([]);
  });

  it('does not treat an H1 as preamble prose', () => {
    expect(parseBook('# Title\n\nprose\n').preamble).toBe('prose');
  });

  it('does not mistake an H3 inside a body for a new row', () => {
    // `### Prompt` and `### Acceptance criteria` live inside a TODO body. Splitting on them would
    // shred every row this tool generates.
    const parsed = parseBook('## TODO 1 — x\n\n### Prompt\n\ndo it\n\n### Acceptance criteria\n\n- done\n');
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]?.body).toContain('### Acceptance criteria');
  });
});

describe('undisciplinedTodos', () => {
  it('flags a TODO missing any of the three headers emit.py warns about', () => {
    const parsed = parseBook('## TODO 1 — thin\n\njust prose\n');
    expect(undisciplinedTodos(parsed)).toHaveLength(1);
  });

  it('passes a TODO carrying all three', () => {
    const parsed = parseBook(
      '## TODO 1 — full\n\n**Depends on:** none\n**Lands in:** a.ts\n**Estimated decisions:** 0\n',
    );
    expect(undisciplinedTodos(parsed)).toEqual([]);
  });

  it('ignores notes, which are not prompts', () => {
    expect(undisciplinedTodos(parseBook('## NOTE — context\n\nprose\n'))).toEqual([]);
  });
});

describe('blanks', () => {
  it('finds a placeholder a human still owes', () => {
    expect(blanks('**Lands in:** <path>\n')).toEqual(['**Lands in:** <path>']);
  });

  it('does not count a placeholder inside a code span', () => {
    // An illustrative command is not an unfilled blank. Getting this wrong made a finished book
    // refuse to emit.
    expect(blanks('run `ast-grep run -p <pattern>` to re-derive it')).toEqual([]);
  });

  it('ignores html-looking text that is not a placeholder', () => {
    expect(blanks('the element is <b> in the preview')).toEqual([]);
  });
});

describe('renderBook', () => {
  const plan: Plan = {
    id: 'plan-1' as never,
    taskId: 'T-1' as never,
    slug: 'demo',
    title: 'Demo',
    createdAt: '2026-09-13T14:21:00.000Z',
    notes: [{ title: 'Source', body: 'the task as given' }],
    steps: [
      {
        id: 's1' as never,
        n: 1,
        title: 'do the thing',
        dependsOn: [],
        landsIn: ['src/a.ts'],
        estimatedDecisions: [{ question: 'which field?' }],
        prohibited: ['editing the guardian to make it pass'],
        executor: 'agent',
        prompt: 'Do it.',
        acceptanceCriteria: ['it is done'],
        evidence: { items: [], verified: 0, struck: 0, unverifiable: 0 },
      },
    ],
  };

  it('round trips: what we render, we parse back', () => {
    const parsed = parseBook(renderBook(plan, { slug: 'demo', name: 'Demo' }));
    expect(parsed.frontmatter.slug).toBe('demo');
    expect(parsed.rows.map((r) => r.type)).toEqual(['note', 'todo']);
    expect(parsed.rows[1]).toMatchObject({ n: 1, title: 'do the thing' });
  });

  it('emits the three headers his linter looks for', () => {
    expect(undisciplinedTodos(parseBook(renderBook(plan, {})))).toEqual([]);
  });

  it('names each decision rather than only counting them', () => {
    // "2 decisions" tells a reader a number; naming them tells them what they are about to be asked.
    expect(renderBook(plan, {})).toContain('**Estimated decisions:** 1 (which field?)');
  });

  it('writes "none" rather than an empty dependency list', () => {
    expect(renderBook(plan, {})).toContain('**Depends on:** none');
  });

  it('lists real dependencies when a step has them', () => {
    const step = plan.steps[0];
    if (!step) throw new Error('fixture lost its step');
    const dependent: Plan = { ...plan, steps: [{ ...step, dependsOn: [1, 2] }] };
    expect(renderBook(dependent, {})).toContain('**Depends on:** 1, 2');
  });

  it('states a zero decision count without an empty bracket', () => {
    // "0 ()" reads like something went missing. A step claiming zero decisions is claiming they
    // were made upstream, and the line should say so cleanly.
    const step = plan.steps[0];
    if (!step) throw new Error('fixture lost its step');
    const decided: Plan = { ...plan, steps: [{ ...step, estimatedDecisions: [] }] };
    expect(renderBook(decided, {})).toContain('**Estimated decisions:** 0\n');
  });

  it('produces a book with no blanks when every field is filled', () => {
    expect(blanks(renderBook(plan, {}))).toEqual([]);
  });
});

describe('notesInOrder', () => {
  it("puts MJ's seven in his order", () => {
    const shuffled = [...NOTE_ORDER].reverse().map((title) => ({ title, body: '' }));
    expect(notesInOrder(shuffled).map((n) => n.title)).toEqual([...NOTE_ORDER]);
  });

  it('keeps an unrecognised note, after the known ones', () => {
    const notes = [
      { title: 'Gates', body: '' },
      { title: 'Source', body: '' },
    ];
    expect(notesInOrder(notes).map((n) => n.title)).toEqual(['Source', 'Gates']);
  });
});

describe("against MJ's own example.book.md", () => {
  const FIXTURE = join(import.meta.dirname, '__fixtures__', 'example.book.md');

  it('parses the shipped demo book the way his emitter does', () => {
    const parsed = parseBook(readFileSync(FIXTURE, 'utf8'));
    expect(parsed.frontmatter).toMatchObject({ slug: 'example' });
    expect(parsed.rows.map((r) => r.type)).toEqual(['note', 'todo', 'todo']);
    expect(parsed.rows[1]).toMatchObject({ n: 1 });
    expect(parsed.rows[2]).toMatchObject({ n: 2, title: 'emit your own first book' });
  });

  it('finds its TODO bodies disciplined, as his linter does', () => {
    expect(undisciplinedTodos(parseBook(readFileSync(FIXTURE, 'utf8')))).toEqual([]);
  });
});
