import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArgs } from './args.js';
import { HELP, main } from './main.js';
import { evidenceLine, renderResult, say, tick } from './render.js';

/**
 * The CLI, tested by running it — a real temp repository, real files, real git, real parser. The
 * end-to-end block at the bottom is the one that matters: setup → discover → plan → verify, the
 * whole flow, with nothing standing in for anything.
 */

let repo: string;
let lines: string[];
const out = (l: string) => lines.push(l);
const said = () => lines.join('\n');
const run = (...argv: string[]) => main(argv, out);

beforeEach(() => {
  lines = [];
  repo = mkdtempSync(join(tmpdir(), 'devflow-cli-'));
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(
    join(repo, 'AGENTS.md'),
    '# Rules\n\n0. Use AST tooling for structural review; grep must never be the basis of a conclusion.\n7. No mock tests. Zero.\n',
  );
  writeFileSync(
    join(repo, 'src', 'dialog.tsx'),
    [
      'export function DialogContent({ className }: Props) {',
      '  return <div className={cn("grid w-full gap-4 sm:max-w-lg", className)} />;',
      '}',
    ].join('\n'),
  );
  writeFileSync(join(repo, 'src', 'index.ts'), 'export * from "./dialog.js";\n');
  execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main']);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 't@t.test']);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'T']);
  // A commit, because `git rev-parse --abbrev-ref HEAD` fails on a repository that has none — so
  // an uncommitted fixture silently exercises only the no-branch path, which is not what a real
  // checkout looks like.
  execFileSync('git', ['-C', repo, 'add', '-A']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'fixture']);
  process.chdir(repo);
});

afterEach(() => {
  process.chdir(tmpdir());
});

describe('parseArgs', () => {
  it.each([
    [['discover', 'a task'], { command: 'discover', positionals: ['a task'] }],
    [['show'], { command: 'show', positionals: [] }],
    [[], { command: 'help', positionals: [] }],
  ])('reads %j', (argv, expected) => {
    expect(parseArgs(argv)).toMatchObject(expected);
  });

  it('takes --key value and --key=value alike', () => {
    expect(parseArgs(['plan', 'T-1', '--steps', '6']).flags.steps).toBe(6);
    expect(parseArgs(['plan', 'T-1', '--steps=6']).flags.steps).toBe(6);
  });

  it('treats a bare flag as true', () => {
    expect(parseArgs(['show', '--all']).flags.all).toBe(true);
  });

  it('does not swallow the next flag as a value', () => {
    // `--verbose --all` must be two flags, not one flag whose value is "--all".
    const parsed = parseArgs(['show', '--verbose', '--all']);
    expect(parsed.flags).toMatchObject({ verbose: true, all: true });
  });

  it('nests a dotted flag so any setting is overridable with no special case', () => {
    expect(parseArgs(['discover', 'x', '--budgets.runMicroUsd', '500000']).overrides).toEqual({
      budgets: { runMicroUsd: 500000 },
    });
  });
});

describe('render', () => {
  it('says what happened in plain words', () => {
    expect(say('needs-operator', false)).toBe('waiting for you');
  });

  it('adds the internal vocabulary only when asked', () => {
    expect(say('needs-operator', true)).toContain('ESCALATE');
    expect(say('needs-operator', false)).not.toContain('ESCALATE');
  });

  it('counts evidence the way a reader needs it', () => {
    expect(evidenceLine({ items: [], verified: 25, struck: 0, unverifiable: 1 })).toBe(
      '25/26 claims verified · 1 unresolved',
    );
  });

  it.each([
    [{ kind: 'run-completed', runId: 'r' as never, stepsDone: 3 }, 'done — 3 step(s)'],
    [
      {
        kind: 'budget-exceeded',
        runId: 'r' as never,
        spent: { microUsd: 41_000 },
        cap: { microUsd: 2_000_000 },
      },
      '$0.0410 of $2.00',
    ],
    [
      { kind: 'run-failed', runId: 'r' as never, reason: 'gate-failed' as const, detail: 'x' },
      'a check failed',
    ],
  ])('renders %j', (result, expected) => {
    expect(renderResult(result as never, false)).toContain(expected);
  });

  it('lists every blocker a run is waiting on', () => {
    const text = renderResult(
      {
        kind: 'needs-operator',
        runId: 'r' as never,
        blockers: [{ step: 4, question: 'which contract does it expect?' }],
        resumeToken: 't',
      },
      false,
    );
    expect(text).toContain('step 4: which contract does it expect?');
  });
});

describe('help', () => {
  it('is what an unknown command prints', async () => {
    expect(await run('nonsense')).toBe(2);
    expect(said()).toContain('unknown command: nonsense');
    expect(said()).toContain('devflow setup');
  });

  it('lists every command the dispatcher handles', async () => {
    // A command absent from help is a command nobody finds. This caught `go` shipping undocumented
    // in the tool that preceded this one.
    await run('help');
    for (const cmd of ['setup', 'discover', 'plan', 'verify', 'show', 'config show', 'doctor']) {
      expect(HELP, cmd).toContain(cmd);
    }
  });
});

describe('setup', () => {
  it('writes a config naming what it detected', async () => {
    expect(await run('setup')).toBe(0);
    const config = JSON.parse(readFileSync(join(repo, '.devflow', 'config.json'), 'utf8'));
    expect(config.repository.roots).toContain('src');
    expect(config.repository.houseRuleFiles).toContain('AGENTS.md');
    expect(said()).toContain('AGENTS.md');
  });

  it('keeps run state out of everyone else’s diff', async () => {
    await run('setup');
    expect(readFileSync(join(repo, '.devflow', '.gitignore'), 'utf8')).toContain('runs/');
  });

  it('does not overwrite on a second run', async () => {
    await run('setup');
    writeFileSync(join(repo, '.devflow', 'config.json'), '{"budgets":{"maxRetries":9}}');
    lines = [];
    expect(await run('setup')).toBe(0);
    expect(said()).toContain('already set up');
    expect(JSON.parse(readFileSync(join(repo, '.devflow', 'config.json'), 'utf8')).budgets.maxRetries).toBe(
      9,
    );
  });

  it('rewrites when asked', async () => {
    await run('setup');
    writeFileSync(join(repo, '.devflow', 'config.json'), '{"budgets":{"maxRetries":9}}');
    await run('setup', '--force');
    expect(JSON.parse(readFileSync(join(repo, '.devflow', 'config.json'), 'utf8')).budgets).not.toMatchObject(
      {
        maxRetries: 9,
      },
    );
  });
});

describe('config show', () => {
  it('reports where each value came from', async () => {
    await run('setup');
    lines = [];
    expect(await run('config', 'show')).toBe(0);
    expect(said()).toMatch(/repository\.dir\s+"\.devflow"\s+\(default\)/);
    expect(said()).toContain('(file)');
    expect(said()).toContain('config.json');
  });

  it('shows a flag override winning over the file', async () => {
    await run('setup');
    lines = [];
    await run('config', 'show', '--budgets.maxRetries', '5');
    expect(said()).toMatch(/budgets\.maxRetries\s+5\s+\(flag\)/);
  });

  it('names an unresolved environment reference rather than passing the placeholder along', async () => {
    await run('config', 'show');
    expect(said()).toContain('DEVFLOW_OUTLINE_MODEL is not set');
  });

  it('refuses a malformed config instead of running on settings nobody chose', async () => {
    mkdirSync(join(repo, '.devflow'), { recursive: true });
    writeFileSync(join(repo, '.devflow', 'config.json'), '{ not json');
    await expect(run('config', 'show')).rejects.toThrow(/not valid DevFlow configuration/);
  });
});

describe('doctor', () => {
  it('says what is missing and how to fix it', async () => {
    expect(await run('doctor')).toBe(0);
    expect(said()).toContain('set up here');
    expect(said()).toContain('devflow setup');
  });

  it('is clean once set up', async () => {
    await run('setup');
    lines = [];
    expect(await run('doctor')).toBe(0);
    expect(said()).toContain('0 blocking');
  });
});

/** The slug is the plan's business, not the test's. Reading it back keeps them from drifting. */
const bookPathFor = (taskId: string): string => {
  const dir = join(repo, '.devflow', 'tasks', taskId);
  const { slug } = JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8')) as { slug: string };
  return join(dir, `${slug}.book.md`);
};

/**
 * Fill a scaffolded book: the step prompt gets the claims under test, every other `<…>` gets
 * filler so no blank remains to stop `verify`.
 *
 * Keyed on the placeholder's opening words and its closing `>`, never its full prose. Four tests
 * broke silently the last time that prose was reworded — the replace simply missed, the claims were
 * never inserted, and the tests reported the gate failing when the gate had never been handed
 * anything. A test must fail because behaviour changed, not because a sentence did.
 */
const fillBook = (taskId: string, prompt: string): void => {
  const path = bookPathFor(taskId);
  const before = readFileSync(path, 'utf8');
  const filled = before.replace(/<what to do[\s\S]*?>/, prompt);
  if (filled === before) throw new Error('the step-prompt placeholder was not found — fillBook is stale');
  writeFileSync(path, filled.replace(/<[^>]+>/g, 'x'));
};

describe('the whole flow, end to end', () => {
  it('goes setup → discover → plan → verify, and refuses a plan with blanks', async () => {
    expect(await run('setup')).toBe(0);

    lines = [];
    expect(await run('discover', 'LGN-1: the dialog caps at 512px, see `src/dialog.tsx`')).toBe(0);
    expect(said()).toContain('LGN-1');
    expect(said()).toContain('house rules   2 from AGENTS.md');
    expect(said()).toContain('1 of 1 exist');

    lines = [];
    expect(await run('plan', 'LGN-1', '--steps', '2')).toBe(0);
    expect(said()).toContain('notes      7');
    expect(said()).toContain('steps      2');

    // A plan full of placeholders is not ready, and verify says so rather than reporting on
    // placeholder text and calling it evidence.
    lines = [];
    expect(await run('verify', 'LGN-1')).toBe(1);
    expect(said()).toContain('Not ready');
  });

  it('verifies a filled plan and checks every citation against the file', async () => {
    await run('setup');
    await run('discover', 'LGN-2: the dialog caps at 512px, see `src/dialog.tsx`');
    await run('plan', 'LGN-2', '--steps', '1');

    // One of each kind, against the real fixture, through the real ast-grep inspector. Each claim
    // names its own file: "it contains …" reads fine to a human and is invisible to the parser,
    // which is deliberate — an unanchored sentence is not a claim.
    fillBook(
      'LGN-2',
      '`src/dialog.tsx` defines `DialogContent`. `src/dialog.tsx` contains `sm:max-w-lg`. ' +
        '`src/dialog.tsx` calls `cn`. `src/index.ts` does not reference `DialogContent`.',
    );

    lines = [];
    expect(await run('verify', 'LGN-2')).toBe(0);
    expect(said()).toContain('Every citation holds');
    expect(said()).toContain('4/4 claims verified');
  });

  it('holds when the cited line has moved, and says where it moved to', async () => {
    // The failure the old line-anchored gate had by design: adding an import at the top of a file
    // struck every claim below it, none of which had stopped being true. A gate that cries wolf
    // when someone runs a formatter is a gate people learn to skip.
    await run('setup');
    await run('discover', 'LGN-20: about `src/dialog.tsx`');
    await run('plan', 'LGN-20', '--steps', '1');

    fillBook('LGN-20', '`DialogContent` is defined in `src/dialog.tsx:1`.');

    // Now shift it down four lines, exactly as adding imports would.
    const dialog = join(repo, 'src', 'dialog.tsx');
    writeFileSync(dialog, `${'import { cn } from "./cn.js";\n'.repeat(4)}${readFileSync(dialog, 'utf8')}`);

    lines = [];
    expect(await run('verify', 'LGN-20')).toBe(0);
    expect(said()).toContain('Every citation holds');
    expect(said()).toContain('now at line 5');
  });

  it('strikes a citation that does not hold, and says where the symbol actually is', async () => {
    await run('setup');
    await run('discover', 'LGN-3: about `src/dialog.tsx`');
    await run('plan', 'LGN-3', '--steps', '1');

    fillBook('LGN-3', '`src/index.ts` defines `DialogContent`.');

    lines = [];
    expect(await run('verify', 'LGN-3')).toBe(1);
    expect(said()).toContain('do not hold');
    // Not just "wrong" — where it actually is, which is the next thing the reader needs.
    expect(said()).toContain('it is in src/dialog.tsx');
  });

  it('strikes a claim of absence the moment the symbol appears', async () => {
    // The claim that settles design questions — "the respondent never calls this" — and the one
    // that must go red when someone lands the change, so the plan stops describing the old world.
    await run('setup');
    await run('discover', 'LGN-21: about `src/dialog.tsx`');
    await run('plan', 'LGN-21', '--steps', '1');

    fillBook('LGN-21', '`src/index.ts` does not call `DialogContent`.');

    // True as written. Then someone lands the re-export.
    expect(await run('verify', 'LGN-21')).toBe(0);
    writeFileSync(join(repo, 'src', 'index.ts'), 'export { DialogContent } from "./dialog.js";\n');

    lines = [];
    expect(await run('verify', 'LGN-21')).toBe(1);
    expect(said()).toContain('IS in src/index.ts');
  });

  it('shows the task from the log it wrote', async () => {
    await run('setup');
    await run('discover', 'LGN-4: about `src/dialog.tsx`');
    lines = [];
    expect(await run('show', 'LGN-4')).toBe(0);
    expect(said()).toContain('LGN-4');
    expect(said()).toContain('State');
    expect(said()).toContain('✓ discovery');
  });

  it('lists work when asked with no id', async () => {
    await run('setup');
    await run('discover', 'LGN-5: about `src/dialog.tsx`');
    lines = [];
    expect(await run('show')).toBe(0);
    expect(said()).toContain('LGN-5');
  });

  it('says so when there is nothing recorded', async () => {
    await run('setup');
    lines = [];
    expect(await run('show')).toBe(0);
    expect(said()).toContain('nothing yet');
  });
});

describe('commands that need something first', () => {
  it.each([
    [['plan', 'MISSING'], 'devflow discover'],
    [['verify', 'MISSING'], 'devflow plan'],
    [['show', 'MISSING'], 'devflow discover'],
  ])('%j points at what is missing', async (argv, expected) => {
    await run('setup');
    lines = [];
    expect(await run(...(argv as [string, string]))).toBe(2);
    expect(said()).toContain(expected);
  });

  it.each([
    [['discover'], 'a sentence, or a pasted ticket'],
    [['plan'], 'the id devflow discover printed'],
    [['verify'], 'devflow verify <task>'],
  ])('%j asks for its argument', async (argv, expected) => {
    expect(await run(...(argv as [string]))).toBe(2);
    expect(said()).toContain(expected);
  });

  it('corrects an unknown config subcommand', async () => {
    expect(await run('config', 'nonsense')).toBe(2);
    expect(said()).toContain('devflow config show');
  });
});

describe('paths that only appear when something is wrong', () => {
  it('reports a symbol that exists nowhere', async () => {
    await run('setup');
    lines = [];
    await run('discover', 'LGN-9: about someSymbolNobodyDefined');
    expect(said()).toContain('neither defined nor referenced');
  });

  it('reports a file the task names that is not there', async () => {
    await run('setup');
    lines = [];
    await run('discover', 'LGN-10: fix `src/imaginary.ts`');
    expect(said()).toContain('src/imaginary.ts does not exist');
  });

  it('says when there are no prior learnings', async () => {
    await run('setup');
    lines = [];
    await run('discover', 'LGN-11: about `src/dialog.tsx`');
    expect(said()).toContain('prior learnings 0');
  });

  it('reports a plan whose steps are thin', async () => {
    await run('setup');
    await run('discover', 'LGN-12: about `src/dialog.tsx`');
    await run('plan', 'LGN-12', '--steps', '1');
    const book = bookPathFor('LGN-12');
    // Fill every blank but strip the three headers emit.py warns about.
    const filled = readFileSync(book, 'utf8')
      .replace(/<[^>]+>/g, 'x')
      .replace(/\*\*Depends on:\*\*/g, 'Depends on:')
      .replace(/\*\*Lands in:\*\*/g, 'Lands in:')
      .replace(/\*\*Estimated decisions:\*\*/g, 'Estimated decisions:');
    writeFileSync(book, filled);
    lines = [];
    await run('verify', 'LGN-12');
    expect(said()).toContain('Thin steps');
  });

  it('verifies a step that cites nothing without pretending it proved something', async () => {
    await run('setup');
    await run('discover', 'LGN-13: about `src/dialog.tsx`');
    await run('plan', 'LGN-13', '--steps', '1');
    const book = bookPathFor('LGN-13');
    writeFileSync(book, readFileSync(book, 'utf8').replace(/<[^>]+>/g, 'nothing in particular'));
    lines = [];
    expect(await run('verify', 'LGN-13')).toBe(0);
    expect(said()).toContain('no citations');
    // Not an error — an operator step ("rotate the key in QA") has nothing in this repo to cite.
    // But it must not read as a pass either: "Every citation holds" over a plan with no citations
    // is exactly the false green this gate exists to prevent.
    expect(said()).toContain('Nothing was checked');
    expect(said()).toContain('This is not a pass');
    expect(said()).not.toContain('Every citation holds');
  });

  it('says when a task has a plan but no book beside it', async () => {
    await run('setup');
    await run('discover', 'LGN-14: about `src/dialog.tsx`');
    await run('plan', 'LGN-14', '--steps', '1');
    rmSync(bookPathFor('LGN-14'));
    lines = [];
    expect(await run('verify', 'LGN-14')).toBe(2);
    expect(said()).toContain('no book for LGN-14');
  });

  it('shows a run that is waiting for an operator', async () => {
    await run('setup');
    await run('discover', 'LGN-15: about `src/dialog.tsx`');
    await run('plan', 'LGN-15', '--steps', '1');
    await run('verify', 'LGN-15'); // blanks unfilled → needs-operator
    lines = [];
    await run('show', 'LGN-15', '--all');
    expect(said()).toContain('waiting-for-operator');
    expect(said()).toContain('Blocked');
    expect(said()).toContain('blanks unfilled');
  });

  it('shows evidence once a plan has been verified', async () => {
    await run('setup');
    await run('discover', 'LGN-16: about `src/dialog.tsx`');
    await run('plan', 'LGN-16', '--steps', '1');
    fillBook('LGN-16', '`src/dialog.tsx` contains `sm:max-w-lg`.');
    await run('verify', 'LGN-16');
    lines = [];
    await run('show', 'LGN-16', '--all');
    expect(said()).toContain('Evidence');
    expect(said()).toMatch(/step 1\s+1\/1 claims verified/);
  });

  it('offers the earlier runs rather than hiding them', async () => {
    await run('setup');
    await run('discover', 'LGN-17: about `src/dialog.tsx`');
    await run('discover', 'LGN-17: about `src/dialog.tsx` again');
    lines = [];
    await run('show', 'LGN-17');
    expect(said()).toContain('earlier run(s)');
    expect(said()).toContain('--all');
  });

  it('warns in doctor when nothing has been set up', async () => {
    lines = [];
    await run('doctor');
    expect(said()).toContain('How to fix');
    expect(said()).toContain('devflow setup');
  });

  it('warns in doctor when a repository has no house rules', async () => {
    rmSync(join(repo, 'AGENTS.md'));
    lines = [];
    await run('doctor');
    expect(said()).toContain('none found');
  });

  it('reports the whole repository as the search scope when no roots are detected', async () => {
    rmSync(join(repo, 'src', 'index.ts'));
    lines = [];
    await run('setup');
    expect(said()).toContain('whole repository (none detected)');
  });

  it('names an unresolved environment variable in doctor', async () => {
    await run('setup');
    lines = [];
    await run('doctor');
    expect(said()).toContain('DEVFLOW_OUTLINE_MODEL');
  });
});

describe('argument shapes', () => {
  it('keeps a non-numeric --key=value as a string', () => {
    expect(parseArgs(['discover', 'x', '--repository.dir=.ai']).overrides).toEqual({
      repository: { dir: '.ai' },
    });
  });

  it('replaces a scalar when a deeper key arrives after it', () => {
    const parsed = parseArgs(['x', '--a.b', '1', '--a.b.c', '2']);
    expect(parsed.overrides).toEqual({ a: { b: { c: 2 } } });
  });

  it('takes --v as shorthand for verbose', async () => {
    await run('setup');
    await run('discover', 'LGN-18: about `src/dialog.tsx`');
    await run('plan', 'LGN-18', '--steps', '1');
    await run('verify', 'LGN-18');
    lines = [];
    await run('show', 'LGN-18', '--v');
    expect(said()).toContain('ESCALATE');
  });
});

describe('render, every branch a reader can see', () => {
  it.each([
    [{ items: [], verified: 1, struck: 0, unverifiable: 0 }, '1/1 claims verified'],
    [{ items: [], verified: 0, struck: 2, unverifiable: 0 }, '2 wrong'],
    [{ items: [], verified: 1, struck: 1, unverifiable: 1 }, '1 wrong · 1 unresolved'],
  ])('counts %j', (report, expected) => {
    expect(evidenceLine(report)).toContain(expected);
  });

  it('renders a plan that is ready', () => {
    const plan = { steps: [{}, {}], notes: [{}] } as never;
    expect(renderResult({ kind: 'plan-ready', runId: 'r' as never, plan }, false)).toContain('2 step(s)');
  });

  it('lists every verification failure', () => {
    const text = renderResult(
      { kind: 'verification-failed', runId: 'r' as never, failures: ['a gate failed', 'a claim was wrong'] },
      false,
    );
    expect(text).toContain('a gate failed');
    expect(text).toContain('a claim was wrong');
  });

  it.each([
    ['evidence-failed', 'evidence check failed', 'REFUSE predicate_failed'],
    ['no-progress', 'stopped — no progress', 'PIVOT exhausted'],
    ['cancelled', 'cancelled', 'TERMINATE cancelled'],
    ['gate-failed', 'a check failed', 'REFUSE gate_error'],
  ])('says %s plainly, and internally when asked', (reason, plain, internal) => {
    expect(say(reason, false)).toBe(plain);
    expect(say(reason, true)).toContain(internal);
  });

  it('passes an unknown reason through rather than inventing a translation', () => {
    expect(say('something-new', false)).toBe('something-new');
    expect(say('something-new', true)).toBe('something-new');
  });
});

describe('outside a git checkout', () => {
  it('falls back to the working directory rather than failing', async () => {
    // DevFlow has to be usable in a directory nobody has run `git init` in.
    const plain = mkdtempSync(join(tmpdir(), 'devflow-nogit-'));
    process.chdir(plain);
    lines = [];
    expect(await run('setup')).toBe(0);
    expect(said()).toContain(plain);
  });
});

describe('the quieter halves of each branch', () => {
  it('marks a step nobody has reached yet', () => {
    expect(tick('todo')).toBe('○');
    expect(tick('active')).toBe('●');
    expect(tick('done')).toBe('✓');
  });

  it('works outside a checkout, where there is no branch to read a ticket from', async () => {
    // `branchOf` returns undefined outside a checkout, and discover must simply not pass one.
    const plain = mkdtempSync(join(tmpdir(), 'devflow-nogit-'));
    mkdirSync(join(plain, 'src'), { recursive: true });
    writeFileSync(join(plain, 'src', 'a.ts'), 'export const a = 1;\n');
    process.chdir(plain);
    await run('setup');
    lines = [];
    expect(await run('discover', 'no ticket anywhere, just `src/a.ts`')).toBe(0);
    expect(said()).toContain('nothing found');
  });

  it('plans a task that has no ticket key', async () => {
    await run('setup');
    lines = [];
    await run('discover', 'widen the preview, see `src/dialog.tsx`');
    // The id is DevFlow's to derive; reading it back keeps the test from reimplementing the rule.
    const id = (said().split('\n')[0] ?? '').split(' — ')[0] as string;
    lines = [];
    expect(await run('plan', id, '--steps', '1')).toBe(0);
    expect(said()).toContain('steps      1');
  });

  it('detects a root by its package.json as well as its index', async () => {
    mkdirSync(join(repo, 'lib'), { recursive: true });
    writeFileSync(join(repo, 'lib', 'package.json'), '{"name":"lib"}');
    lines = [];
    await run('setup');
    expect(said()).toContain('lib');
  });

  it('prints a gap when the task names nothing it can probe', async () => {
    rmSync(join(repo, 'AGENTS.md'));
    await run('setup');
    lines = [];
    await run('discover', 'set the licence key in the QA environment');
    expect(said()).toContain('no house rules found');
  });
});

describe('devflow run, through the dispatcher', () => {
  it('asks for its argument', async () => {
    lines = [];
    expect(await run('run')).toBe(2);
    expect(said()).toContain('devflow run <task>');
  });

  it('points at plan when the task was never planned', async () => {
    await run('setup');
    lines = [];
    expect(await run('run', 'MISSING')).toBe(2);
    expect(said()).toContain('devflow plan MISSING');
  });

  it('does a dry run without a credential, and sends nothing', async () => {
    // The reason the model client is a lazy getter: `--dry-run` must work on a machine that has
    // never had an API key, and it would not if building the environment demanded one.
    await run('setup');
    await run('discover', 'LGN-30: about `src/dialog.tsx`');
    await run('plan', 'LGN-30', '--steps', '1');
    fillBook('LGN-30', '`src/dialog.tsx` defines `DialogContent`.');
    lines = [];
    expect(await run('run', 'LGN-30', '--dry-run')).toBe(0);
    expect(said()).toContain('would send');
    expect(said()).toContain('nothing was sent');
  });
});
