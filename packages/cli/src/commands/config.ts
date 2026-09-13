import type { Env } from '../env.js';

/**
 * `devflow config show` — the settings this run would actually use, and where each came from.
 *
 * The provenance column is the point. A run once produced a gate record with baselines nobody had
 * recorded, and the reason stayed invisible because there was no way to ask what settings were in
 * force. "Effective value" without "from where" answers half the question.
 */
export function configShow(env: Env): number {
  const { settings, files, unresolved } = env.config;

  env.out('Files read');
  if (files.length === 0) env.out('  none — every value is a shipped default');
  for (const f of files) env.out(`  ${f}`);

  env.out('');
  env.out('Effective settings');
  const width = Math.max(...settings.map((s) => s.path.length));
  for (const s of settings) {
    if (Array.isArray(s.value) && s.value.length === 0) continue;
    env.out(`  ${s.path.padEnd(width)}  ${JSON.stringify(s.value)}  (${s.from})`);
  }

  if (unresolved.length) {
    env.out('');
    env.out('Unresolved environment references');
    for (const name of unresolved) env.out(`  ${name} is not set`);
    env.out('');
    env.out('  A run needing one of these will stop rather than pass the placeholder along.');
  }
  return 0;
}
