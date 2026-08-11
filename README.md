# council-review

A [Claude Code](https://claude.com/claude-code) skill that runs a multi-model "council" code review on a git diff. **Gemini**, **Claude** and **Codex** review the same diff independently in parallel, then Claude synthesises a single consolidated report that deduplicates findings, marks disagreements as `DISPUTED`, and adds a final "what both missed" pass.

Each seat defaults to a **latest-tracking alias** rather than a pinned version, so the council keeps pace with new releases instead of silently reviewing with a superseded model — see [Model selection](#model-selection).

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
  │ (latest)  │         │ (latest)  │         │ (config)  │
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

## Model selection

| Seat | Default | Why |
|---|---|---|
| Claude | `opus` | The Claude CLI's documented alias for the latest model of that tier. |
| Gemini | `gemini-flash-latest` | Floating alias on the Gemini API. `gemini-pro-latest` also exists. |
| Codex | unset → `~/.codex/config.toml` | No `models` subcommand and no `latest` alias exist. Under ChatGPT-account auth an explicit `-m gpt-5.6` returns `400 ... not supported when using Codex with a ChatGPT account`, so inheriting your configured default is both what works and what tracks your current choice. |

Override any seat with `ANTHROPIC_MODEL`, `GEMINI_MODEL` or `CODEX_MODEL`. Pin a concrete id
(`GEMINI_MODEL=gemini-3.6-flash`) when you need the run to be reproducible or auditable — the
`-latest` aliases report an opaque version string, so you cannot confirm which model actually
answered.

> **Trap: a sourced `.env` silently downgrades the council.** If `GEMINI_API_KEY` lives in a file
> such as `~/.gemini/.env` and that file also exports `GEMINI_MODEL`, sourcing it for the key also
> overrides the model, so every run in that shell uses the pinned value. Export the model **after**
> sourcing:
>
> ```bash
> set -a; . ~/.gemini/.env; set +a
> export GEMINI_MODEL=gemini-3.6-flash   # after, or the .env value wins
> ```
>
> Every run now prints its model provenance so this is visible rather than silent:
>
> ```
> > Models: claude=opus (default), gemini=gemini-3.5-flash (from $GEMINI_MODEL), codex=~/.codex/config.toml default (default)
> ```

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
