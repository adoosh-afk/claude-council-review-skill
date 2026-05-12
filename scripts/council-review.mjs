#!/usr/bin/env node
// Council review: Gemini + Claude + Codex run independently, then Claude synthesises.
//
// Usage:
//   node council-review.mjs --base origin/main --head HEAD
//   node council-review.mjs --diff path/to/diff.patch
//
// Env: GEMINI_API_KEY (required)
//      ANTHROPIC_MODEL (default claude-opus-4-7) — passed to `claude -p --model`
//      GEMINI_MODEL    (default gemini-3.1-pro-preview)
//      CODEX_MODEL     (optional) — passed to `codex exec -m`. If unset, codex uses
//                       whatever model is configured in ~/.codex/config.toml.
//      CLAUDE_BIN      (default `claude`) — Claude Code CLI binary
//      CODEX_BIN       (default `codex`)  — Codex CLI binary
//      COUNCIL_SKIP    (optional, comma-separated) — names of reviewers to skip
//                       ("gemini", "claude", "codex"). Useful when one CLI is
//                       missing or rate-limited.
//
// Claude and Codex calls go through their respective local CLIs (`claude -p`,
// `codex exec`) in non-interactive mode, so neither ANTHROPIC_API_KEY nor
// OPENAI_API_KEY needs to be set — the CLIs use your existing logins.

import { execSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { argv, env, exit, cwd } from "node:process";
import { basename } from "node:path";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = parseArgs(argv.slice(2));
const GEMINI_KEY = env.GEMINI_API_KEY;
const CLAUDE_MODEL = env.ANTHROPIC_MODEL || "claude-opus-4-7";
const GEMINI_MODEL = env.GEMINI_MODEL || "gemini-3.1-pro-preview";
const CODEX_MODEL = env.CODEX_MODEL || null; // null → codex uses its config default
const CLAUDE_BIN = env.CLAUDE_BIN || "claude";
const CODEX_BIN = env.CODEX_BIN || "codex";
const SKIP = new Set((env.COUNCIL_SKIP || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));

if (!SKIP.has("gemini") && !GEMINI_KEY) die("GEMINI_API_KEY is not set (or skip with COUNCIL_SKIP=gemini)");

const diff = args.diff
  ? readFileSync(args.diff, "utf8")
  : execSync(`git diff ${args.base || "origin/main"}...${args.head || "HEAD"}`, {
      maxBuffer: 64 * 1024 * 1024,
    }).toString();

if (!diff.trim()) die("Empty diff — nothing to review.");

const repoName = (() => {
  try {
    return basename(execSync("git rev-parse --show-toplevel").toString().trim());
  } catch {
    return basename(cwd());
  }
})();

const stack = detectStack();

const reviewPrompt = `You are reviewing a pull request for the ${repoName} codebase${stack ? ` (${stack})` : ""}.
Be concrete and concise. For each issue: file:line, severity (CRITICAL/HIGH/MEDIUM/LOW), the problem, and the fix.
Cover: correctness bugs, security (injection/auth/secrets), type-safety, perf regressions, dead code, missing error handling at boundaries, and framework-specific anti-patterns.
Skip nitpicks. Do not restate what the diff does.

DIFF:
\`\`\`diff
${diff}
\`\`\``;

const reviewers = [];
if (!SKIP.has("gemini")) reviewers.push({ name: "gemini", label: GEMINI_MODEL, fn: () => callGemini(reviewPrompt) });
if (!SKIP.has("claude")) reviewers.push({ name: "claude", label: CLAUDE_MODEL, fn: () => callClaude(reviewPrompt) });
if (!SKIP.has("codex")) reviewers.push({ name: "codex", label: CODEX_MODEL || "codex (config default)", fn: () => callCodex(reviewPrompt) });

if (reviewers.length < 2) die(`Need at least 2 reviewers; got ${reviewers.length} after applying COUNCIL_SKIP=${[...SKIP].join(",")}`);

console.error(`> Requesting reviews from: ${reviewers.map((r) => r.label).join(", ")}…`);
const results = await Promise.allSettled(reviewers.map((r) => r.fn()));

const reviews = {};
const failures = [];
results.forEach((res, i) => {
  const name = reviewers[i].name;
  if (res.status === "fulfilled") {
    reviews[name] = res.value;
  } else {
    failures.push(`${name}: ${res.reason?.message || res.reason}`);
  }
});

if (failures.length === reviewers.length) die(`All reviewers failed:\n  ${failures.join("\n  ")}`);
if (failures.length > 0) console.error(`> WARN: skipping failed reviewer(s):\n  ${failures.join("\n  ")}`);

const sectionsForSynthesis = Object.entries(reviews).map(([name, body]) => `=== ${name.toUpperCase()} REVIEW ===\n${body}`).join("\n\n");

const synthesisPrompt = `${Object.keys(reviews).length} independent AI reviewers reviewed the same diff. Produce a single consolidated review:
- Merge findings; deduplicate.
- Flag disagreements explicitly (mark "DISPUTED" — at least one reviewer raised it and at least one did not, and explain which side you think is right).
- When all reviewers agree on a finding, treat it as high-confidence.
- Drop findings that don't hold up against the diff.
- Order by severity. Keep file:line references.
- End with a short "What all reviewers missed" section if you spot anything new from looking at the diff yourself.

${sectionsForSynthesis}

=== DIFF ===
\`\`\`diff
${diff}
\`\`\``;

console.error(`> Synthesising consolidated review with ${CLAUDE_MODEL}…`);
const final = await callClaude(synthesisPrompt);

// Run ID: YYYY-MM-DD-HHMM-<short-rand>. Stable shape lets `docs/council-review/<id>/`
// land cleanly in repos that adopt the Rule-29 artefact-persistence convention.
const runId = (() => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
  return `${stamp}-${randomBytes(2).toString("hex")}`;
})();

// Primary output: ephemeral .council-review/ in cwd (back-compat).
mkdirSync(".council-review", { recursive: true });
for (const [name, body] of Object.entries(reviews)) {
  writeFileSync(`.council-review/${name}.md`, body);
}
writeFileSync(".council-review/final.md", final);
writeFileSync(".council-review/run-id.txt", runId);

// Secondary output: git-tracked persistent location, if the repo opts in by
// having a `docs/council-review/` directory at the working-tree root. The
// SYNTHESIS.md filename matches the convention Codex flagged in the Modelsmith
// decomposition reviews (CLAUDE.md Rule 29). Reviewers + diff are co-located
// so a future PR can cite `docs/council-review/<run-id>/SYNTHESIS.md` as
// committed evidence rather than relying on an ephemeral PR comment.
let persistedDir = null;
try {
  const repoRoot = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
  if (repoRoot && existsSync(join(repoRoot, "docs/council-review"))) {
    persistedDir = join(repoRoot, "docs/council-review", runId);
    mkdirSync(persistedDir, { recursive: true });
    for (const [name, body] of Object.entries(reviews)) {
      writeFileSync(join(persistedDir, `${name}.md`), body);
    }
    writeFileSync(join(persistedDir, "SYNTHESIS.md"), final);
    writeFileSync(join(persistedDir, "diff.patch"), diff);
    // run-meta records what was reviewed + which models took part, so the
    // artefact is auditable on its own without re-running git.
    const meta = {
      runId,
      timestamp: new Date().toISOString(),
      repo: repoName,
      base: args.base || "origin/main",
      head: args.head || "HEAD",
      reviewers: reviewers.map((r) => ({ name: r.name, label: r.label })),
      failures,
    };
    writeFileSync(join(persistedDir, "run-meta.json"), JSON.stringify(meta, null, 2));
  }
} catch {
  // Not in a git repo, or no docs/council-review/ — silently skip persistence.
}

process.stdout.write(final + "\n");
console.error(`\n> Run ID: ${runId}`);
console.error(`> Per-model outputs saved under .council-review/ (${Object.keys(reviews).join(", ")})`);
if (persistedDir) {
  console.error(`> Persisted under ${persistedDir.replace(env.HOME || "~", "~")} (git-tracked)`);
}

// ---------- helpers ----------

function detectStack() {
  const tags = [];
  if (existsSync("package.json")) {
    try {
      const pkg = JSON.parse(readFileSync("package.json", "utf8"));
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      if (deps.next) tags.push("Next.js");
      else if (deps.react) tags.push("React");
      if (deps.typescript || deps["@types/node"]) tags.push("TypeScript");
      else tags.push("JavaScript");
      if (deps.tailwindcss) tags.push("Tailwind");
    } catch {}
  }
  if (existsSync("pyproject.toml") || existsSync("requirements.txt")) tags.push("Python");
  if (existsSync("go.mod")) tags.push("Go");
  if (existsSync("build.gradle") || existsSync("build.gradle.kts") || existsSync("pom.xml"))
    tags.push("Java/JVM");
  if (existsSync("Cargo.toml")) tags.push("Rust");
  return tags.join(" / ");
}

async function callGemini(prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    }),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  const json = await res.json();
  const text = json?.candidates?.[0]?.content?.parts
    ?.map((p) => p.text)
    .filter(Boolean)
    .join("\n");
  if (!text) throw new Error(`Gemini returned no text: ${JSON.stringify(json).slice(0, 500)}`);
  return text;
}

async function callClaude(prompt) {
  // Use the local Claude Code CLI in non-interactive mode (`claude -p`).
  // Prompt is piped via stdin to avoid argv length limits with large diffs.
  const res = spawnSync(
    CLAUDE_BIN,
    [
      "-p",
      "--model", CLAUDE_MODEL,
      "--tools", "",
      "--no-session-persistence",
      "--disable-slash-commands",
      "--permission-mode", "dontAsk",
      "--output-format", "text",
    ],
    {
      input: prompt,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (res.error) throw new Error(`claude CLI failed to launch: ${res.error.message}`);
  if (res.status !== 0) {
    throw new Error(`claude CLI exited ${res.status}: ${(res.stderr || "").slice(0, 1000)}`);
  }
  const text = (res.stdout || "").trim();
  if (!text) throw new Error(`claude CLI returned no text. stderr: ${(res.stderr || "").slice(0, 500)}`);
  return text;
}

async function callCodex(prompt) {
  // Use the local Codex CLI in non-interactive mode (`codex exec`). Prompt is
  // piped via stdin (`-` shorthand) to avoid argv length limits. The final
  // model message is written to a temp file via `--output-last-message` so we
  // don't have to parse the streaming session output.
  const tmpOut = join(tmpdir(), `codex-council-${randomBytes(6).toString("hex")}.txt`);
  const cmd = ["exec", "--skip-git-repo-check", "--output-last-message", tmpOut];
  if (CODEX_MODEL) cmd.push("-m", CODEX_MODEL);
  cmd.push("-"); // read prompt from stdin
  try {
    const res = spawnSync(CODEX_BIN, cmd, {
      input: prompt,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (res.error) throw new Error(`codex CLI failed to launch: ${res.error.message}`);
    if (res.status !== 0) {
      throw new Error(`codex CLI exited ${res.status}: ${(res.stderr || "").slice(0, 1000)}`);
    }
    if (!existsSync(tmpOut)) {
      throw new Error(`codex CLI did not write output file ${tmpOut}. stderr: ${(res.stderr || "").slice(0, 500)}`);
    }
    const text = readFileSync(tmpOut, "utf8").trim();
    if (!text) throw new Error(`codex CLI wrote empty output to ${tmpOut}`);
    return text;
  } finally {
    try { unlinkSync(tmpOut); } catch { /* ignore */ }
  }
}

function parseArgs(arr) {
  const out = {};
  for (let i = 0; i < arr.length; i++) {
    const k = arr[i];
    if (k.startsWith("--")) (out[k.slice(2)] = arr[i + 1]), i++;
  }
  return out;
}

function die(msg) {
  console.error(`error: ${msg}`);
  exit(1);
}
