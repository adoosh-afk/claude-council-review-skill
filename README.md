# council-review

A [Claude Code](https://claude.com/claude-code) skill that runs a multi-model "council" code review on a git diff. **Gemini 3.1 Pro**, **Claude Opus 4.7**, and **Codex** review the same diff independently in parallel, then Claude synthesises a single consolidated report that deduplicates findings, marks disagreements as `DISPUTED`, and adds a final "what both missed" pass.

Useful when a single model is not enough confidence: pre-merge gates on security-sensitive changes, large refactors, architectural decisions, or any time you want a real second (and third) opinion before shipping.

## How it works

```
                       ┌──────────────┐
                       │   git diff   │
                       └──────┬───────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
        ▼                     ▼                     ▼
  ┌───────────┐         ┌───────────┐         ┌───────────┐
  │  Gemini   │         │  Claude   │         │   Codex   │
  │  3.1 Pro  │         │ Opus 4.7  │         │           │
  └─────┬─────┘         └─────┬─────┘         └─────┬─────┘
        │                     │                     │
        └─────────────────────┼─────────────────────┘
                              │
                              ▼
                       ┌──────────────┐
                       │ Claude       │
                       │ synthesises  │
                       └──────┬───────┘
                              │
                              ▼
                       ┌──────────────┐
                       │ SYNTHESIS.md │
                       └──────────────┘
```

Each reviewer is prompted in isolation with the same diff. The synthesis step sees all three reviews plus the diff and produces the consolidated output. Reviewers run concurrently via `Promise.allSettled`, so a single missing reviewer (auth, rate-limit, network) degrades the run to a partial council instead of aborting.

## Install

Clone into your local Claude Code skills directory:

```bash
git clone https://github.com/adoosh-afk/claude-council-review-skill.git ~/.claude/skills/council-review
```

Claude Code picks it up automatically. Trigger it by asking for a "council review", "joint review", "multi-model review", or "second opinion" on a diff.

## Prerequisites

- **`GEMINI_API_KEY`** in the environment.
- **`claude` CLI** on `PATH` and logged in. The script invokes `claude -p` (non-interactive print mode), so no `ANTHROPIC_API_KEY` is required.
- **`codex` CLI** on `PATH` and logged in. The script invokes `codex exec --skip-git-repo-check`.

Missing any one of these? The corresponding reviewer is skipped, the rest of the council still runs, and `run-meta.json` records which reviewers succeeded.

## Usage

The skill is normally invoked through Claude Code, but the underlying script works standalone:

```bash
# Review current branch vs main
node ~/.claude/skills/council-review/scripts/council-review.mjs --base origin/main --head HEAD

# Review a specific PR (locally checked out)
gh pr checkout 1234
node ~/.claude/skills/council-review/scripts/council-review.mjs \
  --base "origin/$(gh pr view --json baseRefName -q .baseRefName)" --head HEAD

# Review a pre-existing patch file
node ~/.claude/skills/council-review/scripts/council-review.mjs --diff path/to/diff.patch

# Review staged changes
git diff --cached > /tmp/staged.patch
node ~/.claude/skills/council-review/scripts/council-review.mjs --diff /tmp/staged.patch
```

The consolidated review prints to stdout.

## Configuration

All optional, set in the environment:

| Variable | Default | Purpose |
| --- | --- | --- |
| `GEMINI_API_KEY` | _(required for Gemini)_ | Google AI Studio API key. |
| `ANTHROPIC_MODEL` | `claude-opus-4-7` | Passed to `claude --model`. |
| `GEMINI_MODEL` | `gemini-3.1-pro-preview` | Gemini model id. |
| `CODEX_MODEL` | _(Codex default)_ | Passed to `codex exec -m`. |
| `CLAUDE_BIN` | `claude` | Path to the Claude Code CLI binary. |
| `CODEX_BIN` | `codex` | Path to the Codex CLI binary. |
| `COUNCIL_SKIP` | _(none)_ | Comma-separated reviewers to skip: `codex`, `gemini`, `claude`. |

## Output

The script writes per-model raw outputs and the final synthesis to two places:

1. **Always**: `.council-review/` in the current working directory (scratch — gitignore it).
2. **Opt-in, Rule-29 style**: if the host repo already contains a `docs/council-review/` directory, artefacts are also persisted under `docs/council-review/<run-id>/`, where `<run-id>` is a UTC-stamped slug like `2026-05-12-1430-a1b2`.

The persistent layout per run:

```
docs/council-review/2026-05-12-1430-a1b2/
├── gemini.md         # raw Gemini review
├── claude.md         # raw Claude review
├── codex.md          # raw Codex review
├── SYNTHESIS.md      # the consolidated report
├── diff.patch        # exact diff that was reviewed
└── run-meta.json     # base/head, models, reviewer statuses, timestamp
```

This is intended for architectural review trails that live alongside the code they reviewed. Repos with no `docs/council-review/` directory get the legacy scratch behaviour and nothing else.

## CI

The repo at `agentsia-uk/Modelsmith` runs council-review on every PR via GitHub Actions. The pattern is a workflow that invokes the same script with `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, and Codex credentials provided as Actions secrets. Copy that workflow as a starting point if you want this on a different repo.

## Tips

- **Cost.** A council review on a 500-line diff is roughly one $$$ pass on each model. Use it for pre-merge gates and architecture reviews, not for every typo PR.
- **Partial councils.** With `COUNCIL_SKIP=codex` you get the cheaper 2-model pass; with `COUNCIL_SKIP=gemini,codex` you fall back to a Claude-only review (the synthesis step still runs and is useful for cleanup / re-prioritisation).
- **Disputed findings.** A `DISPUTED` flag in `SYNTHESIS.md` means exactly one reviewer raised the issue; the synthesiser explains which side it leans toward, but the human reviewer should look at the raw per-model output for the dissenting case.

## Licence

MIT.
