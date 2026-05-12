---
name: council-review
description: Run a multi-model "council" code review where Gemini and Claude independently review a diff, then Claude synthesises a consolidated report flagging disagreements. Use when the user asks for a "council review", "joint review", "multi-model review", "second opinion", or wants to review changes with both Gemini and Claude. Works on any git repo.
---

# Council Review

Runs **Gemini 3.1 Pro** and **Claude Opus 4.7** independently on the same diff, then has Claude synthesise the two reviews — deduplicating findings, marking disagreements as `DISPUTED`, and adding a "what both missed" pass.

## When to use

- User says "council review", "joint review", "second opinion on this diff", "have Gemini and Claude review", or similar.
- User wants higher-confidence review than a single model — pre-merge, security-sensitive changes, or large refactors.
- Works on any repo with a git diff. No framework assumptions.

## Prerequisites

- `GEMINI_API_KEY` must be set in the environment.
- The `claude` CLI must be installed and logged in. The script invokes `claude -p` (non-interactive print mode) for the Claude side, so no `ANTHROPIC_API_KEY` is required — the CLI uses your existing Claude Code login.

If `GEMINI_API_KEY` is missing, ask the user to set it. If `claude` isn't on PATH or isn't logged in, ask before running.

Optional overrides: `ANTHROPIC_MODEL` (passed to `claude --model`, default `claude-opus-4-7`), `GEMINI_MODEL`, `CLAUDE_BIN` (default `claude`).

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

The final consolidated review prints to stdout. Per-model outputs land in `.council-review/` (gemini.md, claude.md, final.md) in the current working directory.

## What you should do

1. Verify `GEMINI_API_KEY` is set and the `claude` CLI is on PATH. If not, stop and ask.
2. Determine the diff scope from the user's request (current branch, specific commits, PR, staged). If unclear, default to `origin/main...HEAD` and confirm in one short sentence after running.
3. Run the script. It takes ~30–90s — both models run in parallel.
4. Show the user the consolidated review. Don't paraphrase — it's already concise.
5. Mention `.council-review/` for the per-model raw outputs if they want to compare.

## Setting it up in CI

If the user wants this on every PR for a specific repo, add a workflow that runs the same script. The CompeteIQ repo has a working example at `.github/workflows/joint-review.yml` — copy that pattern, but point the workflow at this skill's script (or copy the script into the repo). The repo needs `ANTHROPIC_API_KEY` and `GEMINI_API_KEY` in GitHub Actions secrets.
