import { join } from 'node:path';
import type { RunId, TaskId } from '@omnitech/devflow-contracts';
import { blanks, evidenceAllows, parseBook, verifyClaims } from '@omnitech/devflow-core';
import { z } from 'zod';
import { type Env, readMaybe, taskDir, writeFileEnsuringDir } from '../env.js';
import { evidenceLine } from '../render.js';
import { claimsIn } from './claims.js';

/**
 * `devflow run <task>` — expand each verified step into an executable brief, and gate what comes
 * back through the same citation check the plan went through.
 *
 * ## What this deliberately does NOT do
 *
 * It does not edit files. A model that writes to a working tree unattended is a different product
 * with a different risk profile, and nothing in the value of DevFlow depends on it. What a step is
 * missing when a human picks it up is not the typing — it is the specifics: which function, which
 * call sites, what breaks if you get it wrong. That is what `run` produces.
 *
 * ## Why it verifies before it spends anything
 *
 * A step whose claims about the code are wrong produces a brief built on those claims. Expanding it
 * costs money and yields something worse than nothing, because it reads as authoritative. So the
 * gate runs first, on every step, and a struck claim stops the run before a single token is bought.
 *
 * ## Why it verifies again afterwards
 *
 * The model's brief makes its own claims about the code. Those are exactly the claims a model is
 * worst at, so they go through the same gate. A brief whose citations do not hold is reported as
 * such and not written into the book.
 */

/**
 * What a step expands into.
 *
 * `citations` is separate from `detail` on purpose. Asking for prose and then mining it for claims
 * gets you whatever the prose happened to contain; asking for the claims as a field gets you claims
 * the model committed to, which the gate can then check one by one.
 */
const briefSchema = z.strictObject({
  summary: z.string().min(1),
  files: z.array(z.string().min(1)),
  detail: z.string().min(1),
  citations: z.array(z.string().min(1)),
  risks: z.array(z.string().min(1)),
});
type Brief = z.infer<typeof briefSchema>;

const PROMPT = (step: { title: string; body: string }, houseRules: string, repoRoot: string): string =>
  [
    'You are expanding one step of an implementation plan into a brief a developer can act on',
    'without going looking for context first.',
    '',
    `Repository root: ${repoRoot}`,
    '',
    houseRules ? `House rules that outrank anything in the step:\n${houseRules}\n` : '',
    `## The step\n\n### ${step.title}\n\n${step.body}`,
    '',
    '## What to return',
    '',
    'JSON only. No prose outside it, no code fences. This exact shape:',
    '',
    '{',
    '  "summary": "one sentence: what this step changes",',
    '  "files": ["path/to/file.ts"],',
    '  "detail": "what to do, concretely. Name functions and call sites.",',
    '  "citations": ["`path/to/file.ts` defines `theSymbol`"],',
    '  "risks": ["the tempting wrong move, and why it is wrong"]',
    '}',
    '',
    'Every entry in "citations" MUST be one of these four sentence shapes, because each is checked',
    'against the real syntax tree and a claim that does not hold fails the step:',
    '',
    '  `theSymbol` is defined in `path/to/file.ts`',
    '  `path/to/file.tsx` calls `theSymbol`',
    '  `path/to/other.tsx` does not call `theSymbol`',
    '  `path/to/file.ts` contains `some source text`',
    '',
    'Do not cite a line number as evidence. Cite the symbol or the source text; a line number is a',
    'navigation hint and is never what passes or fails. Claim only what you are sure of — an',
    'unverifiable citation costs the step, and fewer true claims beat more guessed ones.',
  ]
    .filter(Boolean)
    .join('\n');

export async function run(
  env: Env,
  taskId: string,
  flags: Readonly<Record<string, unknown>>,
): Promise<number> {
  const dir = taskDir(env, taskId);
  const planJson = await readMaybe(join(dir, 'plan.json'));
  if (!planJson) {
    env.out(`no plan for ${taskId}. Run: devflow plan ${taskId}`);
    return 2;
  }
  const slug = (JSON.parse(planJson) as { slug: string }).slug;
  const bookPath = join(dir, `${slug}.book.md`);
  const book = await readMaybe(bookPath);
  if (!book) {
    env.out(`no book for ${taskId} — expected ${slug}.book.md beside plan.json`);
    return 2;
  }

  const unfilled = blanks(book);
  if (unfilled.length) {
    env.out(`${taskId} — Not ready: ${unfilled.length} blank(s) still to fill.`);
    env.out(`  devflow verify ${taskId}  lists them.`);
    return 1;
  }

  const dryRun = flags['dry-run'] === true || flags.dryRun === true;
  const parsed = parseBook(book);
  const steps = parsed.rows.filter((r) => r.type === 'todo');
  if (steps.length === 0) {
    env.out(`${taskId} — the book has no TODO steps to run.`);
    return 1;
  }

  const cap = env.config.config.budgets.runMicroUsd;
  const runId = `${taskId}-run-${env.clock.now().toISOString().replace(/[:.]/g, '-')}` as RunId;
  await env.runs.append(runId, { kind: 'run.started', taskId: taskId as TaskId, mode: 'run' });

  env.out(`${taskId} — ${parsed.frontmatter.name ?? slug}`);
  env.out('');
  env.out(`  steps      ${steps.length}`);
  env.out(`  budget     $${(cap / 1e6).toFixed(2)}`);
  env.out(`  model      ${env.config.config.models.roles.expansion?.model ?? '(unset)'}`);
  if (dryRun) env.out('  dry run    nothing will be sent and nothing will be spent');
  env.out('');

  const houseRules = await houseRuleText(env);
  const briefs: Array<{ n: number; title: string; brief: Brief; holds: boolean }> = [];
  let spent = 0;
  let stopped: string | null = null;

  for (const [index, step] of steps.entries()) {
    const n = index + 1;
    await env.runs.append(runId, { kind: 'step.started', step: n });

    // Gate first. A brief built on a false claim reads as authoritative and is worse than nothing.
    const preClaims = claimsIn(step.body);
    const pre = await verifyClaims(preClaims, env.inspector);
    await env.runs.append(runId, { kind: 'evidence.checked', step: n, report: pre });
    if (!evidenceAllows(pre)) {
      env.out(`  ✗ step ${n}  ${step.title}`);
      env.out(`      ${evidenceLine(pre)} — not expanded, because the step's own claims do not hold`);
      for (const item of pre.items) {
        if (item.status !== 'verified') env.out(`      ✗ ${item.detail}`);
      }
      await env.runs.append(runId, {
        kind: 'step.stopped',
        step: n,
        reason: 'evidence-failed',
        detail: `${pre.struck} claim(s) do not hold`,
      });
      stopped = `step ${n}'s claims do not hold`;
      break;
    }

    if (dryRun) {
      env.out(`  · step ${n}  ${step.title}`);
      env.out(
        `      ${evidenceLine(pre)} · would send ${PROMPT(step, houseRules, env.repoRoot).length} chars`,
      );
      continue;
    }

    if (spent >= cap) {
      stopped = `budget reached before step ${n}`;
      await env.runs.append(runId, {
        kind: 'step.stopped',
        step: n,
        reason: 'budget-exceeded',
        detail: stopped,
      });
      break;
    }

    let brief: Brief;
    try {
      const answer = await env.model.complete({
        role: 'expansion',
        prompt: PROMPT(step, houseRules, env.repoRoot),
        schema: briefSchema,
      });
      brief = answer.value;
      spent += answer.cost.microUsd;
      await env.runs.append(runId, { kind: 'cost.recorded', role: 'expansion', spent: answer.cost });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      env.out(`  ✗ step ${n}  ${step.title}`);
      env.out(`      ${detail}`);
      await env.runs.append(runId, { kind: 'step.stopped', step: n, reason: 'gate-failed', detail });
      stopped = `step ${n} could not be expanded`;
      break;
    }

    // The brief's own claims, through the same gate. These are what a model is worst at.
    const post = await verifyClaims(claimsIn(brief.citations.join('\n')), env.inspector);
    await env.runs.append(runId, { kind: 'evidence.checked', step: n, report: post });
    const holds = evidenceAllows(post) && post.struck === 0;
    briefs.push({ n, title: step.title, brief, holds });

    env.out(`  ${holds ? '✓' : '✗'} step ${n}  ${step.title}`);
    env.out(`      ${brief.summary}`);
    env.out(
      `      ${post.items.length ? evidenceLine(post) : 'the brief cited nothing'} · $${(spent / 1e6).toFixed(4)} so far`,
    );
    for (const item of post.items) {
      if (item.status !== 'verified') env.out(`      ${item.status === 'struck' ? '✗' : '?'} ${item.detail}`);
    }
    await env.runs.append(
      runId,
      holds
        ? { kind: 'step.passed', step: n }
        : {
            kind: 'step.stopped',
            step: n,
            reason: 'evidence-failed',
            detail: `${post.struck} of the brief's claim(s) do not hold`,
          },
    );
  }

  if (!dryRun && briefs.length) {
    const path = join(dir, 'briefs.md');
    await writeFileEnsuringDir(path, renderBriefs(taskId, briefs));
    env.out('');
    env.out(`  ${path}`);
  }

  env.out('');
  env.out(`Spent $${(spent / 1e6).toFixed(4)} of $${(cap / 1e6).toFixed(2)}.`);
  // The cap is checked before each step, which stops the NEXT one — it cannot stop a call already
  // made, and a single-step run can therefore finish over budget without anything having gone
  // wrong. Saying so beats a silent overrun; the alternative is pricing a call before making it,
  // which means a price table that goes stale.
  if (spent > cap) {
    env.out(
      `  Over by $${((spent - cap) / 1e6).toFixed(4)}. The cap stops the next step, not a call already in flight — ` +
        'lower budgets.stepMicroUsd if a single step must not cost this much.',
    );
  }
  const failed = briefs.filter((b) => !b.holds).length;
  if (stopped) {
    env.out(`Stopped: ${stopped}.`);
    await env.runs.append(runId, { kind: 'run.finished', outcome: 'stopped' });
    return 1;
  }
  if (failed) {
    env.out(`${failed} brief(s) cited something that does not hold. Read them before acting on them.`);
    await env.runs.append(runId, { kind: 'run.finished', outcome: 'stopped' });
    return 1;
  }
  env.out(dryRun ? 'Dry run — nothing was sent.' : `${briefs.length} brief(s), every citation checked.`);
  await env.runs.append(runId, { kind: 'run.finished', outcome: 'completed' });
  return 0;
}

/** The repository's own rules, so an expansion cannot propose something the repo forbids. */
async function houseRuleText(env: Env): Promise<string> {
  for (const file of env.config.config.repository.houseRuleFiles) {
    const text = await readMaybe(join(env.repoRoot, file));
    // Enough for the rules, not so much that a long CONTRIBUTING.md crowds out the step.
    if (text) return text.slice(0, 4_000);
  }
  return '';
}

function renderBriefs(
  taskId: string,
  briefs: ReadonlyArray<{ n: number; title: string; brief: Brief; holds: boolean }>,
): string {
  const out: string[] = [
    `# ${taskId} — step briefs`,
    '',
    'Written by `devflow run`. Every citation below was checked against the real files at the time',
    'it was written; a step marked ✗ has at least one that did not hold, and is kept rather than',
    'deleted so you can see what was claimed.',
    '',
  ];
  for (const { n, title, brief, holds } of briefs) {
    out.push(
      `## ${holds ? '✓' : '✗'} Step ${n} — ${title}`,
      '',
      brief.summary,
      '',
      '**Files:** ' + (brief.files.length ? brief.files.map((f) => `\`${f}\``).join(', ') : '—'),
      '',
      brief.detail,
      '',
      '**Citations**',
      ...brief.citations.map((c) => `- ${c}`),
      '',
      '**Risks**',
      ...brief.risks.map((r) => `- ${r}`),
      '',
    );
  }
  return `${out.join('\n')}\n`;
}
