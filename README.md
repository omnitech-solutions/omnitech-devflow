# DevFlow

Turns a task — a sentence, or a pasted ticket — into a playbook a developer can read, and then
runs it. The research happens **before** the plan exists, so the plan cites real code rather than
sending someone to go and look.

```bash
devflow discover LGN-2201     # gather context: rules, code, history, gates
devflow plan LGN-2201         # a playbook of steps, every claim cited
devflow run LGN-2201          # work the steps
devflow verify LGN-2201       # prove it
devflow show LGN-2201         # everything DevFlow knows about this task
```

## Why it exists

A model asked to "fix the dialog width" spends its turn discovering what the dialog is. A model
given *"`dialog.tsx:65` ends in `sm:max-w-lg`, which tailwind-merge keys separately from
`max-w-lg`, so the override at `VerifiedPreview.tsx:402` never lands — measured 512px"* does the
work instead.

The difference is not prompt quality. It is **who does the research, and when**. DevFlow does it
first, verifies every citation mechanically, and freezes the result into the plan.

## The one rule everything else serves

**Models propose. Deterministic code disposes.**

Every `file:line` a model writes is checked before the step is accepted: the path must exist, the
line must exist, the quoted fragment must actually be there, and structural claims are re-run
through the syntax tree — never grep. A step whose evidence fails is refused with the failure
named, retried once, then handed back to you with its blockers listed.

Nothing a model said becomes a DevFlow artifact without passing that gate.

## Layout

```
packages/
  contracts/   zod schemas + derived types. No logic, no dependencies.
  core/        domain, workflows, ports. Depends on contracts only.
  adapters/    the outside world: model providers, AST tooling, storage.
  cli/         renders results. Holds no orchestration.
```

Workflows are sequenced with [Mastra](https://mastra.ai), which also gives the Studio
visualisation and suspend/resume — the latter is how `waiting-for-operator` works. Mastra
sequences and visualises; it never decides. A test enforces that `core/domain` and `contracts`
cannot import from it.

Model choice is a **role**, never a name: the application asks for `outline` or `expansion`, and
configuration decides what fulfils it. A test greps the domain for provider and model literals and
fails on a hit. Swapping a local model for a hosted one is a config edit, not a code change.

## If you know MJ's prompt-magic or Forge

DevFlow's discipline is borrowed; its vocabulary is its own. The table is for orientation, not
equivalence — the semantics differ, which is exactly why the names do too.

| DevFlow | Roughly, over there |
|---|---|
| `context` | the bearings ritual |
| `evidence` / the citation gate | `substrate_grounded_llm` claim adjudicated by a `pure_function` verifier |
| `passed` | `CONVERGE` |
| `needs-operator` | `ESCALATE`, and MJ's `BLOCKED:` escape valve |
| `evidence-failed` | `REFUSE predicate_failed` |
| `rules` | the law gate |
| `checks` | pattern guardians |
| `knowledge` | the `rsi.knowledge` canon namespace |

**What is kept byte-identical, deliberately**, because these are wire formats rather than
concepts — changing them would break interoperability with tooling that already reads them:

- the `.book.md` grammar and MJ's `emit.py`, vendored unmodified
- phase tags `pm-<slug>-<n>-before` / `-after`
- the `C{N}` commit-subject register
- the `BLOCKED: <question>` line
- guardian output `[FAIL] Check <n>:<name>: BLOCKED at <path>:<line>`

`--verbose` prints the native terms alongside DevFlow's.

For the same orientation against Mark's Crux — where its fence sits relative to this one, what DevFlow
should take from it without a framework, and what this repository would look like built on it — see
[crux-orientation-2026-09-16.md](crux-orientation-2026-09-16.md).

## Status

Early. The workspace skeleton is in place; packages land per the implementation plan.
