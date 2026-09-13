import { join } from 'node:path';
import type { Claim, RunId, TaskId } from '@omnitech/devflow-contracts';
import { blanks, evidenceAllows, parseBook, undisciplinedTodos, verifyClaims } from '@omnitech/devflow-core';
import { type Env, readMaybe, taskDir } from '../env.js';
import { evidenceLine } from '../render.js';

/**
 * `devflow verify <task>` — send the plan's claims back to the code.
 *
 * This is the gate the whole tool exists for. A model — or a human — writing
 * "`runtime.ts:958` strips the markup" is doing the thing that is easiest to get wrong and hardest
 * to notice, so nothing is taken on trust: every citation is checked against the file it names.
 */

/**
 * `path:line`, optionally followed by a backticked quotation.
 *
 * The fragment group explicitly refuses to match another `path:line`. Without that, a step citing
 * two places had the SECOND citation swallowed as the first one's quoted fragment — one claim
 * instead of two, silently, which is the worst way for evidence to go missing.
 */
const CITATION = /`([\w./-]+\.[a-z]{1,4}):(\d+)`(?:[^\n`]*`(?!\s*[\w./-]+\.[a-z]{1,4}:\d+`)([^`\n]{4,})`)?/g;

export function claimsIn(body: string): readonly Claim[] {
  const out: Claim[] = [];
  for (const m of body.matchAll(CITATION)) {
    // Both groups are mandatory in CITATION, so a match always carries them.
    const [, path, line, fragment] = m as unknown as [string, string, string, string | undefined];
    out.push({
      kind: 'location',
      text: m[0],
      path,
      line: Number(line),
      ...(fragment ? { fragment } : {}),
    });
  }
  return out;
}

export async function verify(env: Env, taskId: string): Promise<number> {
  const dir = taskDir(env, taskId);
  const planJson = await readMaybe(join(dir, 'plan.json'));
  if (!planJson) {
    env.out(`no plan for ${taskId}. Run: devflow plan ${taskId}`);
    return 2;
  }
  const slug = (JSON.parse(planJson) as { slug: string }).slug;
  const book = await readMaybe(join(dir, `${slug}.book.md`));
  if (!book) {
    env.out(`no book for ${taskId} — expected ${slug}.book.md beside plan.json`);
    return 2;
  }

  const runId = `${taskId}-verify-${env.clock.now().toISOString().replace(/[:.]/g, '-')}` as RunId;
  await env.runs.append(runId, { kind: 'run.started', taskId: taskId as TaskId, mode: 'verify' });

  const parsed = parseBook(book);
  const unfilled = blanks(book);
  const thin = undisciplinedTodos(parsed);

  env.out(`${taskId} — ${parsed.frontmatter.name ?? slug}`);
  env.out('');

  if (unfilled.length) {
    // A blank is not a failed check; it is an unfinished plan. Verifying one would report on
    // placeholder text and call it evidence.
    env.out(`Not ready — ${unfilled.length} blank(s) still to fill`);
    for (const b of unfilled.slice(0, 8)) env.out(`  ${b}`);
    if (unfilled.length > 8) env.out(`  … and ${unfilled.length - 8} more`);
    await env.runs.append(runId, {
      kind: 'step.stopped',
      step: 1,
      reason: 'needs-operator',
      detail: `${unfilled.length} blanks unfilled`,
    });
    return 1;
  }

  let struck = 0;
  let stepNo = 0;
  env.out('Evidence');
  for (const row of parsed.rows.filter((r) => r.type === 'todo')) {
    stepNo += 1;
    const claims = claimsIn(row.body);
    const report = await verifyClaims(claims, env.inspector);
    await env.runs.append(runId, { kind: 'evidence.checked', step: stepNo, report });
    struck += report.struck;

    const mark = report.struck ? '✗' : claims.length ? '✓' : '·';
    env.out(`  ${mark} step ${stepNo}  ${row.title}`);
    env.out(`      ${claims.length ? evidenceLine(report) : 'no citations'}`);
    for (const item of report.items) {
      if (item.status === 'verified') continue;
      env.out(`      ${item.status === 'struck' ? '✗' : '?'} ${item.detail}`);
    }
    if (!evidenceAllows(report)) {
      await env.runs.append(runId, {
        kind: 'step.stopped',
        step: stepNo,
        reason: 'evidence-failed',
        detail: `${report.struck} claim(s) do not hold`,
      });
    }
  }

  if (thin.length) {
    env.out('');
    env.out(`Thin steps — missing a Depends on / Lands in / Estimated decisions header: ${thin.length}`);
    for (const t of thin) env.out(`  ${t.title}`);
  }

  env.out('');
  if (struck) {
    env.out(`${struck} claim(s) do not hold. Fix the plan, not the check.`);
    await env.runs.append(runId, { kind: 'run.finished', outcome: 'stopped' });
    return 1;
  }
  env.out('Every citation holds.');
  await env.runs.append(runId, { kind: 'run.finished', outcome: 'completed' });
  return 0;
}
