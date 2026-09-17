# Crux, read against DevFlow — what to take, what to leave, and what DevFlow-on-Crux would be

Date: 2026-09-16. Status: ORIENTATION. Companion to the README's "If you know MJ's prompt-magic or Forge" table.

Sources: the installed Crux plugin (`~/.claude/plugins/marketplaces/crux/`, v3.12.1 of 2026-09-11 — the public
catalog at bionic-coding.com/crux/catalog is at 3.16.1, expect small drift), the catalog site, and every file
under `packages/` in this repository plus `README.md`, `package.json`, `lefthook.yml`, and `git log`. Every
path cited was read, not inferred. Where DevFlow is described, the description was checked against the code,
including the places where the code and its own comments disagree.

---

## 0. How to read this

- **§1** — the one idea: MJ, Mark and DevFlow are fixing the same failure with fences in different places.
  DevFlow's fence is the earliest of the three.
- **§2** — Crux's vocabulary, each term mapped onto the DevFlow file that already does that job (or the
  port that is declared and not yet wired).
- **§3** — the walk-through: one real, unbuilt DevFlow feature (the gates runner — `gates.recorded` has a
  schema, a config section and a fold, and nothing produces it) carried through both systems side by side.
- **§4** — **what to take.** Seven Crux learnings that fit DevFlow without a framework, ranked by cost.
  Three are one-field or one-file changes.
- **§5** — what to leave, and why DevFlow is already stronger on those axes.
- **§6** — DevFlow-on-Crux: what this repository would be if it had been built with `dev-cycle` from
  phase 0. Honest cost and an honest verdict.

If you have ten minutes: §1, the table in §4, then §6.3.

---

## 1. The one idea: same disease, three fences, and DevFlow's is the earliest

MJ named the disease in his recipe README: *"I claimed all green five times in a row when there were still
real footguns."* Agents self-report, punt real engineering behind confident prose, and build on facts that
were never true. Three systems, three fences:

| | MJ (prompt-magic + dev-recipe) | Mark (Crux) | DevFlow |
|---|---|---|---|
| **Where the fence is** | The **commit boundary** — pre-commit guardians, a law-gate token, HMAC-signed `verify_cmd` results. | The **role boundary** (a reviewer with no `Edit`, a commander with no `Bash`) and the **artifact boundary** (schema-validated books, a run bound to its plan by content hash). | The **claim boundary** — *before* a plan exists. `discover` measures the repo with no model in the loop; `verify` strikes any step whose citation the syntax tree cannot confirm; `run` refuses to spend a token on a step whose claims do not hold, then gates the model's answer through the same check. |
| **What it distrusts** | The agent's *word*: a green must be something the agent cannot write. | The *single perspective*: author ≠ acceptor, implementer ≠ reviewer, one model ≠ a council. | The model's *research*: "who does the research, and when." A model is never asked what the code is; it is told, and its reply is checked. |
| **Where truth lives** | git tags + append-only signed JSON. | The `bionic/` tree: frozen ADRs, immutable run snapshots, append-only `log.md`. | `.devflow/runs/<id>/events.jsonl` — append-only by file mode (`appendFile` only), state is a fold, stored nowhere (`packages/core/src/runs/fold.ts`). |
| **The escape valve** | `BLOCKED: <question>`, once per todo. | A `blocked` prompt (terminal), the 3-round escalation counter, the `iterate` council's "actually architectural" escape verdict. | `needs-operator` with ≥1 named `Blocker` and a resume token (`contracts/src/outcome.ts`); a closed `StopReason` enum so "could not check" never reads as "checked and wrong". |
| **On ADRs** | Dropped — agents used them to punt. | Kept, fenced: body states requirements/postconditions only (§11.D), council-approved, author ≠ acceptor, plus an `invariants/` concern of executable checks. | **Absent as an artifact.** The rationale is in doc comments of unusual quality — every module opens with *"the incident that settled the design"* — and is therefore trapped in source, unqueryable, and unversioned as a decision. §4.1. |
| **The cognitive-clarity dial** | Low clarity → enforce nothing. High → "McDonald's." | Four-rung tier ladder; `objectives.md maturity:`. | One shape for every task: discover → plan → verify → run. Proportionality comes from the human choosing how many steps (`--steps`, default 4). §4.4. |

Three things follow.

**DevFlow's fence is upstream of both.** Crux's citation-shaped check is the ADR `governs.anchor`
(space-folded containment of a quoted span in the ADR body). MJ's is the pattern guardian on code. DevFlow's
is on *the plan itself*, before execution — and it distinguishes `struck` from `unverifiable`, which Crux
approximates with "exit 2 is your environment, not your docs". Neither has a mutation proof
(`packages/core/src/mutation/prove.ts`): `did-not-land` vs `check-has-a-hole` is DevFlow's alone.

**Crux's contribution to DevFlow is not rigor; it is memory and separation.** DevFlow already refuses more
than Crux does. What it lacks is (a) a place where a decision lives once it has been made, (b) a second
reader that is structurally not the first, and (c) proportionality by contract rather than by mood.

**The honest limit is shared.** Crux's own text: *"containment is machine-checked, proportion is a council
judgment."* DevFlow's equivalent: the citation gate is mechanical; whether the *steps* are right is a human
judgment, and `plan` deliberately writes them as `<blanks>`. Both stop where judgment starts, on purpose.

---

## 2. Crux vocabulary, mapped onto what DevFlow already has

| Crux term | What it is | DevFlow's counterpart | State in this repo |
|---|---|---|---|
| **Concern** (7 + 2) | Knowledge domains under `bionic/`. | `.devflow/` — `config`, `tasks/<id>/{task,context,plan}.json` + `<slug>.book.md` + `briefs.md`, `runs/<id>/events.jsonl`, `knowledge.jsonl`. | `setup.ts` writes it; **not run on this repo** — there is no `.devflow/` here. |
| **Inbox** → `process-inbox` | One intake door; classify-then-confirm. | `devflow discover "<sentence or pasted ticket>"` — `intake()` in `discover/intake.ts` is deliberately forgiving. | Built. |
| **Brief** | Pre-decision exploration. | `context.json` + the seven NOTE rows `notesFrom()` writes in MJ's order (`discover/context.ts`). | Built. Two notes (Out of scope, Dependency graph) are left as `<blanks>` for a human. |
| **ADR** | Frozen decision with alternatives. | None. Rationale lives in module doc comments (`fold.ts`, `events.ts`, `verify.ts`, `prove.ts`, `openrouter-model.ts`…). | **Gap.** §4.1. |
| **`governs` rule** | One-line rule anchored to a code path. | The three tests the code describes: no provider/model literals in domain; no organisation names; `core/domain` cannot import Mastra. | **`config.ts:11` says "two tests enforce that by grepping the package"; no such test was found. `README` says a test enforces the Mastra import rule; nothing imports Mastra yet, and no such test exists.** Documented invariants without their checks — the precise thing Crux's `invariants/` concern refuses to allow. §4.2. |
| **Council** | Multi-model, blind, one fork. | `ModelRole` enum `outline \| expansion \| audit` (`contracts/src/roles.ts`); only `expansion` is used (`run.ts`). | `audit` is declared, bound in `DEFAULTS`, and never called. §4.3. |
| **Promptbook** | Plan as validated YAML. | `plan.json` (zod `planSchema`, strictObject) + `<slug>.book.md` (MJ's grammar, `book/parse.ts`). | Built. Two representations; only the book is what `verify`/`run` read. |
| **Run snapshot** | Immutable per-run record bound by `book_content_hash`, stamped `base_commit`. | `events.jsonl` per run, `seq`-ordered, `candidateDigest` per gate record. | Built — but **no event records which book text a run executed against.** §4.5. |
| **`run_autonomy`** / stop points | The plan is the authorization; four stops. | `StopReason` enum, `execution.silenceMs`/`capMs`, `shouldStop()` in `ports/process.ts`. | Ports built; `ProcessRunner` has no adapter and nothing spawns a process yet. |
| **Quality gates** (Prompt 7: command → result token) | Full suite, lint, static, security; tokens recorded. | `verification.gates[]` config, `gates.recorded` event with `scope` + `candidateDigest` + `passed`, `gateFor()` in `fold.ts`. | **Schema, config and fold exist; no command produces the event.** The unbuilt feature §3 uses as its worked example. |
| **Reviewer** (no `Edit`) | Independent verification. | The citation gate re-run on the model's *own* output in `run.ts` (post-gate). | Built for facts; absent for judgment. §4.3. |
| **Journal** / `log-work` | Narrative record; `retrospective` mines it. | `KnowledgeStore` port, verified-only load-forward (`ports/knowledge.ts`). | Port and JSONL location configured; **no code appends to it**. `discover` reads it (`knowledge.forScope`) — from a store nothing writes. |
| **`audit-docs`** / `check-drift` | Graph integrity; regenerator dry-runs. | `plan.json` ↔ `<slug>.book.md` can diverge — `verify` reads only the book. | Not checked. Low priority while a human owns both. |
| **`objectives.md`** | Yardstick for decisions. | README's "The one rule everything else serves". | Prose, not a file the tool reads. Fine. |
| **Tier ladder** | fix-directly / patch / iterate / dev-cycle by a sizing test. | `--steps N`; `estimatedDecisions` per step (a step claiming zero decisions is claiming they were made upstream). | One shape. §4.4. |
| **Night gardener** | Scheduled reviewer of recent work. | — | Not needed at this size. |

---

## 3. The walk-through: the gates runner, in both systems

**The feature.** `verification.gates` is a config section (`{name, command, dir}[]`, discovered from the
repo per its comment, never assumed). `gates.recorded` is a run event carrying `scope: selected | full`,
a `candidateDigest`, and `passed`. `gateFor()` picks the record by digest, preferring `full`. The whole
apparatus exists so a verifier judges by "the gate that ran against *this* content" rather than "the last
record written" — the incident in `events.ts` where a full-scope record was UPSERTed away by a narrower one.
Nothing produces the event. `ProcessRunner` (with `shouldStop` deciding *slow vs stuck*) has no adapter.

That is the next phase, and it is architectural: it introduces the first code path that runs a repository
command, and it decides what a "candidate" is (the working tree? a commit? the diff?). Both systems would
treat it as a decision, not a fix.

### 3.1 In DevFlow, as built

```
devflow setup                         # first time on this repo — writes .devflow/config, .gitignore
devflow discover "add the gates runner: ProcessRunner adapter + devflow gates <task> \
   producing gates.recorded with a candidateDigest of the working tree; slow is not stuck"
```

`intake` pulls symbols (`ProcessRunner`, `candidateDigest`, `shouldStop`) and paths; `discover` asks the
syntax tree where each is defined and referenced, reads house rules (**none — no `CLAUDE.md`/`AGENTS.md`
here; `doctor` would warn**), and writes `context.json` with the source-tree mapping and any probe gaps.

```
devflow plan <id> --steps 5
```

Renders `<slug>.book.md`: seven NOTEs filled from measurement, five TODOs as `<blanks>`. You write the
steps — *what the steps are is a judgment the tool refuses to make*. `verify` refuses while a blank remains.

```
devflow verify <id>
```

Every `\`X\` is defined in \`path\`` / `\`path\` does not call \`X\`` sentence in a TODO body is sent to
the AST. A struck claim fails the step ("fix the plan, not the check"); notes are checked and reported but
do not block. A moved line is reported as `↪ now at line N` — not a failure.

```
devflow run <id> [--dry-run]
```

Per step: pre-gate → expand through the `expansion` role into a brief (`{summary, files, detail,
citations, risks}`) → post-gate the brief's own citations → `step.passed | step.stopped`. Budget checked
before each call. `briefs.md` written. **Nothing edits a file** — by design (`run.ts` header).

Then a human implements from the briefs, runs `pnpm check`, commits. The run log records that briefs were
produced and gated; it does not record that the work landed, what commit it landed in, or whether the
decision ("candidate = working tree") was ever weighed against an alternative.

### 3.2 In Crux, `dev-cycle`

**"Start a cycle for the gates runner."** The skill asks module counts (1 ADR / 1 dev / 1 review = 13
prompts), allocates `PB-0001`, copies the canonical template, validates the book against
`promptbook.schema.json` **before** incrementing any counter, and writes it. Then **"run PB-0001"**:

| # | Who | What it does here | Fence |
|---|---|---|---|
| 1 | commander → planning agents → **architect** | `query-docs` (empty tree), read `ports/process.ts`, `events.ts`, `fold.ts`. Propose **ADR-0001 "A gate record names the content it judged"**: candidate digest is over the working-tree files the gate's `dir` covers; a `selected` scope names its subset; `full` is the stronger claim. Alternatives: digest of `HEAD` (rejected — uncommitted work is the common case); no digest, last-written wins (rejected — the incident). Body: requirements and postconditions only, no `createHash` call, no CLI flag names. | Architect writes only under `bionic/`. |
| 2 | **council** (5 blind reviewers, or 5 parallel Claude agents) | Correctness asks: *does a working-tree digest survive a formatter run?* Security asks: *is `command` from config executed with the operator's shell — injection surface?* → `REQUEST_CHANGES` until the ADR states the postcondition "a gate command is `argv`, never a shell string" (which `CommandSpec.argv: readonly [string, ...string[]]` already encodes — the council would cite it). | Reviewers blind to each other. |
| 3–4 | architect; a **fresh** architect accepts | Body frozen. `log-work` decision entry. | Author ≠ acceptor. |
| 5–8 | **dev-lead** → **developer** (worktree) | Plan: `adapters/src/node-process-runner.ts`, `cli/src/commands/gates.ts`, tests. TDD: `shouldStop` cases first (already pure), then a runner test that *proves slow ≠ stuck* with a fake clock. Quality gates: `pnpm typecheck`, `pnpm lint`, `pnpm test:coverage` — each recorded as `command → result token`. Internal review. | Unrecorded gate = fabrication-by-omission at Prompt 10. |
| 9–11 | **reviewer** ×3 + security ×5 | Correctness re-runs the suite itself. S5 (unsafe shell) checks `argv` never joins into a string. Fix-loop to zero MUST-FIX, 3 rounds max. | Reviewer has `Bash` for verification only, no `Edit`. |
| 12–13 | **historian** | CHANGELOG, `audit-docs`, reflective journal, PR draft (not opened), archive `PB-0001`. | Merge stays human. |

**What Crux produced that DevFlow did not:** ADR-0001 (frozen, with two rejected alternatives on the
record), a `governs` rule `ADR-0001/gate-names-its-content` scoped to `packages/core/src/runs/`, a security
finding surfaced *before* code existed, a journal entry a future `query-docs` can find, and a run snapshot
whose `book_content_hash` proves which plan was executed.

**What DevFlow produced that Crux did not:** a plan whose every factual sentence had been sent to the
syntax tree before a model saw it; a brief whose citations were struck or verified individually; and
zero tokens spent on any step whose premise was false. Crux's Prompt 1 planning agents *read the code*;
nothing checks that what they wrote about it is true.

That asymmetry is the whole of §4 and §5.

---

## 4. What to take — seven Crux learnings, ranked by cost

The filter: each one must (a) close a gap the code itself already names, (b) cost no new framework, and
(c) leave DevFlow's "models propose, deterministic code disposes" rule intact. Nothing below adds a YAML
schema, a council, or an agent roster.

| # | Learning | Cost | Closes |
|---|---|---|---|
| 4.1 | A decision has a file, not a comment | one directory, N short files | rationale trapped in doc comments |
| 4.2 | An invariant has a check, or it is prose | three tests | comments that describe tests that do not exist |
| 4.3 | The second reader is not the first | zero code (a config edit) + one command later | `audit` role declared, never used |
| 4.4 | Rigor is sized by a written test, not by mood | a NOTE row | one shape for every task |
| 4.5 | A run names the plan it ran | one field on one event | book edited after `run` is undetectable |
| 4.6 | A run names the commit it started from | one field on one event | no "what changed since" |
| 4.7 | Dogfood: the tool should be set up in its own repo | `devflow setup` + a `CLAUDE.md` | `doctor` would warn about this repo today |

### 4.1 A decision has a file, not a comment — `docs/decisions/`

The doc comments in this repo are ADRs in everything but location. `events.ts` opens with the UPSERT
incident. `fold.ts` opens with three disagreeing state copies. `verify.ts` opens with the line-number
design being *wrong* and MJ's guardians being the model to copy. `run.ts` states what it deliberately
does not do. `setup.ts` records the *reversal* on committing `tasks/`. That is Context, Decision,
Alternatives, Consequences — written once each, at the point of use, where only a reader of that file
finds it.

Crux's §11.D rule is the useful import, not its machinery: **an ADR body states requirements and
postconditions, never mechanism.** That is exactly the register these comments are already in.

Take: `docs/decisions/NNNN-<slug>.md`, ~15 lines each, the comment lifted nearly verbatim, with one
extra line the comment cannot carry — **status** (`accepted` / `superseded-by`) and **date**. Nine exist
today:

| # | Decision (declarative, as Crux titles them) | Lives today in |
|---|---|---|
| 0001 | Models propose; deterministic code disposes | `README.md` |
| 0002 | Contracts are zod `strictObject`; an unknown key is an error, not a drop | `contracts/src/*.ts`, `contracts.test.ts` |
| 0003 | The run log is append-only; current state is a fold stored nowhere | `events.ts`, `fold.ts`, `store.ts`, `jsonl-run-store.ts` |
| 0004 | A claim anchors to the syntax tree, never to a line number | `gate/verify.ts`, `evidence.ts`, commit `8ebad8b` |
| 0005 | `unverifiable` is not `struck`; "I could not look" is not "I looked" | `evidence.ts`, `ast-grep-inspector.ts` |
| 0006 | Model choice is a role, never a name | `roles.ts`, `config.ts`, `openrouter-model.ts` |
| 0007 | Money is integer micro-USD; cost is read from the provider or recorded unknown, never estimated | `events.ts`, `openrouter-model.ts` |
| 0008 | `run` expands; it does not edit files | `run.ts` |
| 0009 | `tasks/` is committed, `runs/` is ignored — a plan git never sees cannot be reviewed | `setup.ts`, commit `e41740c` |
| 0010 | The `.book.md` grammar is an interop contract with `emit.py`, not a design of ours | `book/parse.ts` |
| 0011 | A green mutation is not evidence until it is shown to have landed | `prove.ts`, commit `f2fff19` |

Leave the comments where they are — they are the best in-context documentation in the repo. The file is
the *index and the status*, not a replacement. When 0004 is someday superseded (a language server instead
of ast-grep), the comment in `verify.ts` changes and the old decision file gains `superseded-by: 0012`.
That is the one thing a comment cannot do.

**Not** Crux's `bionic/adrs/` with frontmatter, counters, a manifest, and `transition-adr`. A directory
and a naming convention. If it ever needs more, that is the day to install Crux.

### 4.2 An invariant has a check, or it is prose — three missing tests

Crux's `invariants/` concern has one rule: a pinned statement is backed by a real check or it is not an
invariant. DevFlow already believes this — and has three places where the belief and the code disagree:

1. `packages/contracts/src/config.ts:11` — *"Two tests enforce that by grepping the package: one for model
   and provider literals, one for organisation names."* No test in the workspace greps for either.
2. `README.md` — *"A test enforces that `core/domain` and `contracts` cannot import from [Mastra]."*
   Nothing imports Mastra; no test asserts the boundary.
3. `packages/adapters/src/jsonl-run-store.ts` — *"a test asserts that writing after a re-open leaves the
   first event byte-for-byte intact."* Worth confirming `adapters.test.ts` holds it (this read did not
   verify that one either way; treat as *unverifiable*, not struck).

Take: write the two missing tests, in the style the repo already uses for `contracts.test.ts` — a table,
one row per rule, reading the package sources and asserting the absence. ~40 lines. Then the comments are
true. This is MJ's "the invariant tests are the police" and Crux's "machine proposes, human ratifies" with
the human already having ratified — in a comment.

### 4.3 The second reader is not the first — use the `audit` role

Crux's reviewer cannot edit; its independence is structural. DevFlow's equivalent for *facts* is the
post-gate on a brief's citations. There is no equivalent for *judgment*: nothing reads a brief and asks
"does this actually do the step, and is the tempting wrong move in `risks` the real one?"

The role already exists. `audit` is in `modelRoleSchema`, has a `DEFAULTS` binding, and is never called.

Take, in two moves, only the first now:

- **Now, zero code:** bind `audit` to a *different* model than `expansion` in `.devflow/config.json`.
  Nothing uses it yet, but the config expresses the intent and the literal-guard test (4.2) keeps it a
  role.
- **Later, one command:** `devflow audit <task>` — for each `✓` brief in `briefs.md`, ask the `audit` role,
  *blind to the expansion prompt*, for `{verdict: approve | request-changes, findings[]}` with the same
  citation grammar, gated the same way. Findings are appended to `briefs.md` under the step; nothing is
  edited. That is Crux's Prompt 9 at a fraction of the ceremony: one model, one pass, one gate — and
  because the model is different, it is the cheapest possible council.

Do not build a fix-loop. A human reads the findings. The moment `audit` can trigger a re-expansion is the
moment the two roles start agreeing with each other.

### 4.4 Rigor is sized by a written test — one NOTE row

Crux's `fix-directly` sizing test is five yes/no questions answered *in writing before the first edit*:
files nameable now? failing test writable first? no contract changes? one instance? no review gate wanted?
A *no* names the tier.

DevFlow has one shape and `--steps N`. The proportionality is real but implicit. Take the written part
only: an eighth NOTE in `notesFrom()`, titled **Sizing**, with the five questions as `<blanks>` — so
`verify` refuses until they are answered, and `plan.json` carries them. A task whose answers are all *yes*
probably wants `--steps 1` and no `run`; one that answers *no* to "no contract changes" wants a decision
file (4.1) before its steps. No new command, no tier enum. The questions do the routing; the human does
the choosing.

### 4.5 A run names the plan it ran — one field

Crux computes `book_content_hash` over the frozen-plan subset at run start; a later edit to the book is
detectable (`audit-docs` CHK-PB-BIND) and a `patch` book's blast-radius check refuses on mismatch.

DevFlow's `candidateDigest` already does this for gate records — but for *the thing under test*, not
for *the plan*. If `<slug>.book.md` is edited after `devflow run`, `show` cannot tell, and `briefs.md`
silently describes a plan that no longer exists.

Take: `plan.created` (or `run.started` in `run` mode) gains `bookDigest: candidateDigestSchema` — sha256
of the book text as read. `show` prints `plan   sha256:ab12… (matches | EDITED SINCE)` by re-hashing the
current file. One field, one line in `show`, and the branded type already exists.

### 4.6 A run names the commit it started from — one field

Crux stamps `base_commit` once at run start so containment can be drawn from `git diff --name-only
--no-renames <base_commit>` rather than from anything the run wrote about itself.

Take: `run.started` gains `baseCommit: string | null` (`git rev-parse HEAD`, null outside a work tree —
`env.branch` already shows git is consulted in `makeEnv`). Recorded, not acted on, today. It is the field
that makes a future "did the implementation stay inside the plan's `landsIn`?" check possible without
trusting the model's `files` list — the same move Crux made, and the one place its containment check is
genuinely mechanical.

### 4.7 Dogfood

`doctor` on this repository today would report: **set up here — warn — no `.devflow/config`**; **house
rules — warn — none found** (it looks for `AGENTS.md`, `CLAUDE.md`, `CONVENTIONS.md`); **search roots —
warn — whole repository**.

Take: `devflow setup` here (it detects `packages/` as a root), and a `CLAUDE.md` of ~20 lines: the one
rule, the four-layer dependency direction, "strictObject everywhere", "no provider literals in domain",
the `pnpm check` gate, and a pointer to `docs/decisions/`. `discover` will then load those rules into
every plan's *Hard rules* note; Claude Code will load them into every session. One file, two consumers.

---

## 5. What to leave — and where DevFlow is already ahead

- **The cycle machinery.** `4N + 4M + 3K + 2`, a 13-prompt floor, YAML partials, `validate-promptbook.py`,
  a 1,300-line `bionic/CLAUDE.md` read every session. For a 6,400-line, 14-commit, one-author repository
  whose pre-push hook already runs typecheck + biome + vitest-with-coverage, this is ceremony without a
  failure to point at. Crux's own `fix-directly` table says it: *"a council over a `split("|")` is
  ceremony, and ceremony has a cost the retrospective can see."*
- **The council.** DevFlow's `run` already refuses to buy a token on a false premise. A council spends
  three models' tokens to *form* a premise. Different problem; 4.3 gets the cheap half.
- **The agent roster.** Ten roles with tool fences matter when subagents *write code*. DevFlow's `run`
  does not, by decision 0008. Until it does, there is nothing to fence.
- **Journal → retrospective → forge-skill.** DevFlow's `KnowledgeStore` is *stricter* than Crux's journal:
  only `verified: true` entries load forward, and nothing from a stopped step ever does — "or the system
  teaches itself its own mistakes and does it with increasing confidence." Keep that rule. The gap is
  that nothing writes the store; the fix is a writer, not Crux.
- **`unverifiable ≠ struck`, and the mutation proof.** Crux has neither. Its nearest is "exit 2 = your
  environment" for scripts, and a reviewer instructed to re-run gates. If Crux took anything from
  DevFlow, it would be `prove.ts`.
- **The claim grammar.** Four sentence shapes a human writes naturally, each anchored to something that
  survives a formatter. Crux's ADR `anchor` is a verbatim span, space-folded — the `contains` kind, without
  the AST kinds. DevFlow's is the more general instrument.

---

## 6. DevFlow-on-Crux — what this repository would be if it had been built that way

### 6.1 The tree

`init docs` would have written `.bionic.yml`, `bionic/` with nine concerns, `manifest.yml`, `ADR-0000`.
Every commit in `git log` maps onto a tier:

| Commit | Tier | Why |
|---|---|---|
| `7a21f45` phase 0 workspace | `author-promptbook` | a sequence, no decision |
| `9cd8056` phase 1 contracts | `dev-cycle` | ADR-0002 (strictObject) |
| `e0b4f34` phase 2 ports and fakes | `dev-cycle` | ADR: "ports name the question, adapters name the tool" |
| `e0b39be` phase 3 citation gate | `dev-cycle` | ADR: line-anchored claims (later superseded) |
| `732c235` phase 4 config with provenance | `dev-cycle` | ADR-0006 roles-not-names; provenance |
| `a48f26d` phase 5 append-only log + fold | `dev-cycle` | ADR-0003 |
| `edc1d83` phase 6 `.book.md` off `emit.py` | `dev-cycle` | ADR-0010 interop contract |
| `b6a8e8b` phase 7 adapters | `dev-cycle`, M=3 | three independent dev loops |
| `bc925db` phase 8 CLI + setup | `dev-cycle` | ADR-0008 run does not edit; ADR-0009 (first version: `tasks/` ignored) |
| `f2fff19` mutation proof | `iterate` | diagnosis: green mutations that never landed; no contract change |
| `8ebad8b` anchor to syntax tree | `dev-cycle` | **supersedes** the phase-3 ADR — Crux's `transition-adr supersede` writes both ends |
| `e41740c` verify notes; repo chooses commits | `dev-cycle` | ADR-0009 **amended**: `tasks/` now committed |
| `d0022d8` devflow run | `dev-cycle` | ADR-0008 |
| `3b2e37d` property invisible to gate | `fix-directly` | files nameable, failing test first, no contract, one instance |

Eleven `dev-cycle` books at 13+ prompts each, one `iterate`, one `fix-directly`, one plain promptbook.
Roughly 150 prompts, ~12 council convocations, ~12 review modules. Against 14 commits.

### 6.2 What the tree would hold that the repo does not

- `bionic/adrs/` — eleven ADRs, two lineage links (a supersession and an amendment) rendered by
  `link-adr-graph`. The *history* of the line-number decision — proposed, accepted, superseded — would be
  three files, not one comment saying "that was wrong".
- `bionic/invariants/` — the literal-guard rules as ratified `INV-000N` with their checks in
  `invariants/checks/` (which is what 4.2's tests are).
- `bionic/journal/2026-09.md` — one reflective entry per cycle: what was hard, what to do differently.
  The `prove.ts` comment ("twice I broke the first matching line in a book, which was inside a NOTE") is a
  journal entry that happens to live in source.
- `bionic/arch/` — derived module graph (the four-layer rule, *measured* from imports rather than asserted
  in a README), API surface (the eight commands), data model (the zod schemas).
- `bionic/promptbooks/archive/` — fourteen books; `runs/` with per-prompt `result` and gate tokens.
- `bionic/adrs/reviews/` — a weekly `review-decisions` report asking whether eleven decisions still serve
  the one rule.

### 6.3 The honest verdict

**Cost.** Roughly 3–5× the wall-clock per phase for the council and review modules; a `bionic/` tree of
~60 files beside 6,400 lines of code; `bionic/CLAUDE.md` in every session's context; an OpenRouter key
and `uv` as prerequisites for the council.

**What it would have caught.** The phase-3 → `8ebad8b` reversal is the interesting case. A Crux council's
*Correctness* dimension on the phase-3 ADR — "are the assumptions verifiable?" — would have asked what
happens to a line-anchored claim when a formatter runs. Perhaps it says `REQUEST_CHANGES`; perhaps the
author writes a paragraph and it passes. The `setup.ts` reversal (`tasks/` ignored → committed) is
similar: a *Consistency* reviewer reading the one rule — "a plan a reviewer can read" — might have caught
that a plan git never sees cannot be reviewed. Might. Crux's own text: proportion is a judgment.

**What it would not have caught.** `3b2e37d` — `property_identifier` invisible to the gate, so `absent`
passed on a lie. That was found by *running the tool against a real component and watching it report zero
symbols* (`intake.ts` comment). No council reads code that carefully; a failing test does.

**Verdict.** For *this* repository at *this* size, Crux's record layer (§4.1, §4.2) is worth having and
costs a directory and three tests. Crux's cycle layer is not — the repo's own gates plus the mutation
proof are already mechanically stronger than Crux's review module, which corroborates gate *tokens* rather
than re-deriving them. The place Crux would become worth its cost is the day `run` is allowed to edit
files: then subagents write code, then a reviewer that structurally cannot edit matters, then the tool
fences earn their context.

Your own sentence from the surveys work, corrected for what DevFlow actually is: **DevFlow measures and
gates, MJ's recipe enforces at the commit, Crux decides and remembers.** All three want the fourth thing
none of them has — the second reader that is not the first. §4.3 is the cheapest version of it.

---

## 7. The seven takes, as a checklist

- [ ] `docs/decisions/0001-…0011-*.md` — one file per decision above, ~15 lines, status + date, comment
      lifted. (§4.1)
- [ ] Two tests: no provider/model/organisation literals in `contracts` + `core`; no Mastra import in
      `core/domain` + `contracts`. Confirm the JSONL byte-intact test exists. (§4.2)
- [ ] `.devflow/config.json`: bind `audit` to a different model than `expansion`. (§4.3, now)
- [ ] `devflow audit <task>` — one pass, blind, gated, appended to `briefs.md`, no loop. (§4.3, later)
- [ ] Eighth NOTE **Sizing** in `notesFrom()` with the five questions as blanks. (§4.4)
- [ ] `bookDigest` on `plan.created`; `show` prints match/EDITED. (§4.5)
- [ ] `baseCommit` on `run.started`. (§4.6)
- [ ] `devflow setup` here; `CLAUDE.md` ~20 lines pointing at `docs/decisions/`. (§4.7)

---

## 8. What was read

Crux (installed plugin): `README.md`, `USER_GUIDE.md`, `CHANGELOG.md` (head), `catalog/{bundles.yml,
models.yml}`, `skills/{dev-cycle, iterate, patch-cycle, fix-directly, whiteboarding, council,
run-promptbook}/SKILL.md`, `templates/{cycle-promptbook-template.yaml, cycle-module-verify.yaml,
ADR-template.md}`, `schemas/run.schema.json`, `agents/{commander, architect, dev-lead, developer, reviewer,
historian, brainstormer}.md`; a project `bionic/CLAUDE.md` §11–§11.D; bionic-coding.com `/crux/` and
`/crux/catalog/`.

This repository: `README.md`, `package.json`, `lefthook.yml`, `git log`; `packages/contracts/src/*`;
`packages/core/src/{gate/verify, discover/intake, discover/context, runs/fold, runs/store, mutation/prove,
book/parse, config/resolve, ports/model, ports/knowledge, ports/inspector, ports/process}.ts`;
`packages/adapters/src/{openrouter-model, jsonl-run-store, ast-grep-inspector}.ts`;
`packages/cli/src/{main, commands/*}.ts` and the tests beside them; `packages/core/src/book/__fixtures__/
example.book.md`. Not read: `packages/cli/src/{args, env, render}.ts`, `packages/core/src/config/load.ts`,
`packages/core/src/ports/__fakes__/*`, `adapters.test.ts`, `cli.test.ts`, `model-wiring.test.ts`.
