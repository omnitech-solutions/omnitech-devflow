---
slug: example
name: Prompt-Magic Demo — your first book
---

# Prompt-Magic Demo — your first book

This is a real emitted book, not documentation. Work through the rows top to bottom: each row has a `⧉ copy prompt` button that puts the prompt on your clipboard — paste it into your coding agent (Claude Code, Cursor, etc.), let it run, then mark the row done in the book UI. State lives in your browser's localStorage, keyed to this book, so you can close and reopen freely.

## NOTE — how a book flows

Each TODO row is a self-contained prompt. If your agent supports git phase-tagging (default on), each prompt is bookended by `pm-<slug>-<n>-before` / `-after` git tags in the target repo, so any prompt's work is rollback-able with `git reset --hard pm-<slug>-<n>-before`. If an agent hits a load-bearing ambiguity, it replies `BLOCKED: <question>` instead of guessing — answer and re-issue.

## TODO 1 — point this book at a repo and run the first prompt

**Depends on:** none
**Lands in:** n/a (orientation only)
**Estimated decisions:** 0

Set this book's target repo: click the REPO field in the book header and paste your repo's path or git URL, or edit `repo_url:` in the frontmatter of `specs/example.book.md` and re-emit. Then copy this prompt, paste it into your agent, and watch the phase-start/phase-end git-tag choreography wrap the work.

## TODO 2 — emit your own first book

**Depends on:** 1
**Lands in:** specs/<your-slug>.book.md
**Estimated decisions:** 1

Copy `specs/example.book.md` to `specs/<your-slug>.book.md` (kebab-case slug). Edit the frontmatter (`slug`, `name`, `repo_url`), replace the body with your own TODO list — one `## TODO N — title` heading per prompt, body prose underneath, `## NOTE — title` for section-header notes. Then run:

    python3 emit.py specs/<your-slug>.book.md

That writes `<your-slug>.html` next to INDEX.html and regenerates the INDEX dashboard. Double-click either. Read `_template.README.md` for the full format contract.
