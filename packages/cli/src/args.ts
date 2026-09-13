/**
 * Argument parsing, deliberately small.
 *
 * `--key value` and `--key=value` and bare `--flag`. Dotted keys become nested objects, so
 * `--budgets.runMicroUsd 500000` is a config override with no special case in any command — the
 * same shape the config resolver already takes as its `flags` layer.
 */

export interface ParsedArgs {
  readonly command: string;
  readonly positionals: readonly string[];
  readonly flags: Readonly<Record<string, unknown>>;
  /** Dotted flags, nested. Handed straight to the config resolver. */
  readonly overrides: Record<string, unknown>;
}

const numeric = (v: string): unknown => (/^-?\d+$/.test(v) ? Number(v) : v);

function nest(target: Record<string, unknown>, dotted: string, value: unknown): void {
  const parts = dotted.split('.');
  let node = target;
  for (const part of parts.slice(0, -1)) {
    const next = node[part];
    node[part] = typeof next === 'object' && next !== null ? next : {};
    node = node[part] as Record<string, unknown>;
  }
  node[parts[parts.length - 1] as string] = value;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const [command = 'help', ...rest] = argv;
  const positionals: string[] = [];
  const flags: Record<string, unknown> = {};
  const overrides: Record<string, unknown> = {};

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] as string;
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    let key: string;
    let value: unknown;
    if (eq !== -1) {
      key = body.slice(0, eq);
      value = numeric(body.slice(eq + 1));
    } else {
      key = body;
      const next = rest[i + 1];
      // A bare flag is `true`. Only consume the next token when it is not itself a flag, so
      // `--verbose --json` does not swallow `--json` as the value of `--verbose`.
      if (next !== undefined && !next.startsWith('--')) {
        value = numeric(next);
        i += 1;
      } else {
        value = true;
      }
    }
    flags[key] = value;
    if (key.includes('.')) nest(overrides, key, value);
  }

  return { command, positionals, flags, overrides };
}
