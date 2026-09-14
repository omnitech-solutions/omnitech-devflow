import { join } from 'node:path';
import type { RunId, TaskId } from '@omnitech/devflow-contracts';
import { blanks, evidenceAllows, parseBook, undisciplinedTodos, verifyClaims } from '@omnitech/devflow-core';
import { type Env, readMaybe, taskDir } from '../env.js';
import { evidenceLine } from '../render.js';
import { claimsIn } from './claims.js';

/**
 * `devflow verify <task>` — send the plan's claims back to the code.
 *
 * This is the gate the whole tool exists for. Every claim is checked against something that
 * survives an edit — a definition, a reference, the absence of one, or a piece of source text —
 * so a correct plan does not go red because someone ran a formatter.
 */

export { claimsIn };

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
  let claimed = 0;
  env.out('Evidence');
  for (const row of parsed.rows.filter((r) => r.type === 'todo')) {
    stepNo += 1;
    const claims = claimsIn(row.body);
    claimed += claims.length;
    const report = await verifyClaims(claims, env.inspector);
    await env.runs.append(runId, { kind: 'evidence.checked', step: stepNo, report });
    struck += report.struck;

    const mark = report.struck ? '✗' : claims.length ? '✓' : '·';
    env.out(`  ${mark} step ${stepNo}  ${row.title}`);
    env.out(`      ${claims.length ? evidenceLine(report) : 'no citations'}`);
    for (const item of report.items) {
      if (item.status === 'struck' || item.status === 'unverifiable') {
        env.out(`      ${item.status === 'struck' ? '✗' : '?'} ${item.detail}`);
      } else if (item.movedTo !== undefined) {
        // Not a warning. The claim holds; the code simply moved under it, and the line the plan
        // recorded would now send a reader to the wrong place. Saying so is the whole reason the
        // gate keeps line numbers at all.
        //
        // `claim.text` rather than the symbol: it is the only field guaranteed non-empty, so there
        // is no fallback branch here that no input can reach. `moved()` in the gate is the single
        // writer of `movedTo` and only sets it when the claim recorded a line, so `claim.line` is
        // present whenever this runs.
        env.out(`      ↪ now at line ${item.movedTo}, not ${item.claim.line} — ${item.claim.text}`);
      }
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

  // Notes, checked too.
  //
  // They were not, for a long time, and the consequence was worse than a gap: the notes are where
  // discovery writes its source-tree mapping — "`EmailDeliveryAdapter` is defined in
  // `delivery.ts:518`" — so the plan's most factual claims were the only ones nobody checked. It
  // also produced a genuinely misleading failure. Mutating a citation in a note left the gate green
  // because the gate did not read notes, which looks exactly like a hole in the gate.
  //
  // Notes are reported separately and do NOT block. A note is context, not an instruction an
  // executor acts on, and a stale note should not stop work the way a wrong step must. It is still
  // shown, loudly, because a wrong fact in the briefing is how a correct step gets written against
  // the wrong world.
  const noteRows = parsed.rows.filter((r) => r.type === 'note' || r.type === 'audit');
  const noteReports = await Promise.all(
    noteRows.map(async (row) => ({ row, report: await verifyClaims(claimsIn(row.body), env.inspector) })),
  );
  const noteClaims = noteReports.reduce((n, { report }) => n + report.items.length, 0);
  const noteStruck = noteReports.reduce((n, { report }) => n + report.struck, 0);

  if (noteClaims > 0) {
    env.out('');
    env.out(`Notes — ${noteClaims} claim(s) checked, ${noteStruck} wrong (context, so this does not block)`);
    for (const { row, report } of noteReports) {
      if (report.items.length === 0) continue;
      env.out(`  ${report.struck ? '✗' : '✓'} ${row.title}  ${evidenceLine(report)}`);
      for (const item of report.items) {
        if (item.status === 'verified') continue;
        env.out(`      ${item.status === 'struck' ? '✗' : '?'} ${item.detail}`);
      }
    }
    if (noteStruck > 0) {
      env.out('');
      env.out('  A wrong fact in the briefing is how a correct step gets written against the wrong');
      env.out('  world. Worth fixing before the steps are executed, even though it is not blocking.');
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

  if (claimed === 0 && noteClaims > 0) {
    // The notes were checked and the steps cite nothing. Worth its own sentence: the plan has been
    // held against the code, but the part an executor will actually act on has not.
    env.out(`Notes hold, but no STEP cites the code — the part an executor acts on is unchecked.`);
    await env.runs.append(runId, { kind: 'run.finished', outcome: 'completed' });
    return 0;
  }

  if (claimed === 0) {
    // Not a pass. A plan whose every step cites nothing has not been checked against anything,
    // and printing "every citation holds" over it is precisely the false green this gate exists to
    // prevent — the reader would take a clean run as confirmation the plan matches the code.
    // It is not an error either: an operator step ("rotate the key in QA") has nothing to cite.
    // So: exit 0, and say plainly that nothing was checked.
    env.out(`Nothing was checked — no step cites the code.`);
    env.out(`  This is not a pass. It means verify had no claim to test.`);
    env.out(`  Anchor one, and it will be checked:`);
    env.out('    `src/thing.ts` defines `theSymbol`');
    env.out('    `src/other.tsx` does not call `theSymbol`');
    env.out('    `src/thing.ts` contains `some source text`');
    await env.runs.append(runId, { kind: 'run.finished', outcome: 'completed' });
    return 0;
  }

  env.out(`Every citation holds — ${claimed} claim(s) across ${stepNo} step(s).`);
  await env.runs.append(runId, { kind: 'run.finished', outcome: 'completed' });
  return 0;
}
