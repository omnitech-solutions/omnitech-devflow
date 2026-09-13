import { parseArgs } from './args.js';
import { configShow } from './commands/config.js';
import { discover } from './commands/discover.js';
import { doctor } from './commands/doctor.js';
import { plan } from './commands/plan.js';
import { setup } from './commands/setup.js';
import { show } from './commands/show.js';
import { verify } from './commands/verify.js';
import { makeEnv } from './env.js';

/**
 * The dispatcher. Deliberately thin: parse argv, build the environment once, call one function.
 *
 * No orchestration lives here. A CLI that decides things is a CLI that has to be reimplemented
 * the first time anything else wants to drive DevFlow.
 */

export const HELP = `devflow — turn a task into a plan a developer can read, then prove it

  devflow setup                        make this repository DevFlow-ready
  devflow discover "<task or ticket>"  gather context: rules, code, history
  devflow plan <task>                  render the book; steps left for a human
  devflow verify <task>                send every citation back to the code
  devflow show [task] [--all]          everything DevFlow knows; latest run by default
  devflow config show                  effective settings, and where each came from
  devflow doctor                       what would stop a run, and how to fix it

  --verbose            also print the internal vocabulary
  --<section>.<key> v  override any setting for one invocation
                       e.g. --budgets.runMicroUsd 500000
`;

export async function main(
  argv: readonly string[],
  out: (line: string) => void = console.log,
): Promise<number> {
  const { command, positionals, flags, overrides } = parseArgs(argv);

  if (command === 'help' || flags.help === true) {
    out(HELP);
    return 0;
  }

  const verbose = flags.verbose === true || flags.v === true;
  const env = await makeEnv(overrides, verbose, out);

  switch (command) {
    case 'setup':
      return setup(env, flags);
    case 'discover': {
      const text = positionals.join(' ').trim();
      if (!text) {
        out('devflow discover "<what you want done>"   — a sentence, or a pasted ticket');
        return 2;
      }
      return discover(env, text);
    }
    case 'plan': {
      const taskId = positionals[0];
      if (!taskId) {
        out('devflow plan <task>   — the id devflow discover printed');
        return 2;
      }
      return plan(env, taskId, typeof flags.steps === 'number' ? flags.steps : 4);
    }
    case 'verify': {
      const taskId = positionals[0];
      if (!taskId) {
        out('devflow verify <task>');
        return 2;
      }
      return verify(env, taskId);
    }
    case 'show':
      return show(env, positionals[0], flags.all === true);
    case 'config':
      if (positionals[0] === 'show' || positionals.length === 0) return configShow(env);
      out(`unknown: devflow config ${positionals[0]}. Did you mean "devflow config show"?`);
      return 2;
    case 'doctor':
      return doctor(env);
    default:
      out(`unknown command: ${command}`);
      out('');
      out(HELP);
      return 2;
  }
}
