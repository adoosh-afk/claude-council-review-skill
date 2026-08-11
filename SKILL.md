---
name: council-review
description: Run a multi-model "council" code review where Gemini, Claude, and Codex independently review a diff in parallel, then Claude synthesises a consolidated report flagging disagreements. Use when the user asks for a "council review", "joint review", "multi-model review", "second opinion", or wants to review changes with multiple models. Works on any git repo.
---

# Council Review

Runs **Gemini 3.1 Pro**, **Claude Opus 4.7**, and **Codex** (OpenAI) independently on the same diff in parallel, then has Claude synthesise the three reviews — deduplicating findings, marking disagreements as `DISPUTED`, and adding a "what all missed" pass.

## When to use

- User says "council review", "joint review", "second opinion on this diff", "have the council review", or similar.
- User wants higher-confidence review than a single model — pre-merge, security-sensitive changes, or large refactors.
- Works on any repo with a git diff. No framework assumptions.

## Prerequisites

- `GEMINI_API_KEY` must be set in the environment.
- The `claude` CLI must be installed and logged in. The script invokes `claude -p` (non-interactive print mode) for the Claude side, so no `ANTHROPIC_API_KEY` is required — the CLI uses your existing Claude Code login.
- The `codex` CLI must be installed and logged in. The script invokes `codex exec --skip-git-repo-check --output-last-message <tmp> -` for the Codex side, so no `OPENAI_API_KEY` is required — the CLI uses your existing Codex login.

If `GEMINI_API_KEY` is missing, ask the user to set it. If `claude` or `codex` isn't on PATH / isn't logged in, either ask before running or skip that reviewer (`COUNCIL_SKIP=codex`). The script needs at least 2 reviewers to run.

Optional overrides:
- `ANTHROPIC_MODEL` (default `opus`) — passed to `claude --model`
- `GEMINI_MODEL` (default `gemini-flash-latest`)
- `CODEX_MODEL` (default unset → uses your `~/.codex/config.toml` default) — passed to `codex exec -m`

### Model selection

The two defaults are **latest-tracking aliases**, not pinned versions, so the council does not
quietly review with a superseded model months after a new release. `opus` is the Claude CLI's
documented "alias for the latest model" of that tier; `gemini-flash-latest` is a floating alias on
the Gemini API (`gemini-pro-latest` also exists). Codex has neither — it has no `models`
subcommand and no `latest` alias, and under ChatGPT-account auth an explicit `-m gpt-5.6` is
rejected with `400 ... not supported when using Codex with a ChatGPT account`, so leaving
`CODEX_MODEL` unset and letting it inherit `~/.codex/config.toml` is both the working option and
the one that tracks whatever you have moved to.

**Pin a concrete id when you need a reproducible or verifiable reviewer.** The `-latest` aliases
report an opaque version string from the Gemini metadata endpoint, so you cannot confirm which
concrete model answered. For a governance-relevant run, pin explicitly (e.g.
`GEMINI_MODEL=gemini-3.6-flash`) and record it.

> **Trap: a sourced `.env` silently downgrades the council.** If you keep `GEMINI_API_KEY` in a
> file like `~/.gemini/.env` and that file also exports `GEMINI_MODEL`, then sourcing it for the
> key also overrides the model — every run in that shell uses the pinned model instead of the
> default, with no warning beyond the banner. Export the model **after** sourcing the env file:
>
> ```bash
> set -a; . ~/.gemini/.env; set +a
> export GEMINI_MODEL=gemini-3.6-flash   # must come after, or the .env value wins
> ```
>
> The script prints `> Models: claude=… (default|from $VAR), gemini=…, codex=…` at start so you
> can see which values were inherited. Check that line before trusting a review.
- `CLAUDE_BIN` (default `claude`)
- `CODEX_BIN` (default `codex`)
- `COUNCIL_SKIP` (default empty) — comma-separated reviewer names to skip (`gemini`, `claude`, `codex`). Useful when one CLI is rate-limited or temporarily down.

## How to run

The script is bundled with this skill at `scripts/council-review.mjs` (relative to this SKILL.md). Invoke it with `node`. Diff source options:

**Review the current branch vs main**
```bash
node ~/.claude/skills/council-review/scripts/council-review.mjs --base origin/main --head HEAD
```

**Review a specific PR (locally checked out)**
```bash
gh pr checkout <PR>
node ~/.claude/skills/council-review/scripts/council-review.mjs --base "origin/$(gh pr view --json baseRefName -q .baseRefName)" --head HEAD
```

**Review a pre-existing patch file**
```bash
node ~/.claude/skills/council-review/scripts/council-review.mjs --diff path/to/diff.patch
```

**Review staged changes**
```bash
git diff --cached > /tmp/staged.patch
node ~/.claude/skills/council-review/scripts/council-review.mjs --diff /tmp/staged.patch
```

The final consolidated review prints to stdout. Per-model outputs land in `.council-review/` (`gemini.md`, `claude.md`, `codex.md`, `final.md`, `run-id.txt`) in the current working directory — ephemeral, intended for the immediate PR comment.

**Opt-in persistent artefact** (CLAUDE.md Rule 29 convention used by Modelsmith and similar repos): if the repo has a `docs/council-review/` directory at its working-tree root, the script ALSO writes the full council to `docs/council-review/<run-id>/`:
- `SYNTHESIS.md` — the consolidated review (the canonical artefact)
- `gemini.md`, `claude.md`, `codex.md` — per-model raw outputs
- `diff.patch` — the diff that was reviewed
- `run-meta.json` — run timestamp, repo, base/head refs, models used, any per-model failures

Implementation PRs can then cite `docs/council-review/<run-id>/SYNTHESIS.md` in their bodies as committed evidence — durable beyond the GitHub comment lifetime. To opt in, just `mkdir docs/council-review && touch docs/council-review/.gitkeep` in the repo.

## What you should do

1. Verify `GEMINI_API_KEY` is set and both the `claude` and `codex` CLIs are on PATH. If one of the CLIs is missing or rate-limited, suggest `COUNCIL_SKIP=<name>` rather than failing the whole run.
2. Determine the diff scope from the user's request (current branch, specific commits, PR, staged). If unclear, default to `origin/main...HEAD` and confirm in one short sentence after running.
3. Run the script. It takes ~45–120s — all reviewers run in parallel; the synthesis step adds another ~20-30s.
4. Show the user the consolidated review. Don't paraphrase — it's already concise.
5. Mention `.council-review/` for the per-model raw outputs if they want to compare. If any reviewer failed mid-run, surface the failure (the script logs them as `WARN` and continues with whoever succeeded, provided at least 2 reviewers returned).

## Setting it up in CI

If the user wants this on every PR for a specific repo, add a workflow that runs the same script. The CompeteIQ repo has a working example at `.github/workflows/joint-review.yml` — copy that pattern, but point the workflow at this skill's script (or copy the script into the repo). The repo needs `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, and `OPENAI_API_KEY` (or a Codex CLI token if you prefer the CLI route) in GitHub Actions secrets.
