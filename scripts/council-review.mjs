#!/usr/bin/env node
// Council review: Gemini + Claude run independently, then Claude synthesises.
//
// Usage:
//   node council-review.mjs --base origin/main --head HEAD
//   node council-review.mjs --diff path/to/diff.patch
//
// Env: GEMINI_API_KEY (required)
//      ANTHROPIC_MODEL (default claude-opus-4-7) — passed to `claude -p --model`
//      GEMINI_MODEL    (default gemini-3.1-pro-preview)
//      CLAUDE_BIN      (default `claude`) — Claude Code CLI binary
//
// Claude calls go through the local Claude Code CLI (`claude -p`, non-interactive),
// so no ANTHROPIC_API_KEY is needed — the CLI uses your existing login.

import { execSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { argv, env, exit, cwd } from "node:process";
import { basename } from "node:path";

const args = parseArgs(argv.slice(2));
const GEMINI_KEY = env.GEMINI_API_KEY;
const CLAUDE_MODEL = env.ANTHROPIC_MODEL || "claude-opus-4-7";
const GEMINI_MODEL = env.GEMINI_MODEL || "gemini-3.1-pro-preview";
const CLAUDE_BIN = env.CLAUDE_BIN || "claude";

if (!GEMINI_KEY) die("GEMINI_API_KEY is not set");

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

console.error(`> Requesting reviews from ${GEMINI_MODEL} and ${CLAUDE_MODEL}…`);
const [geminiReview, claudeReview] = await Promise.all([
  callGemini(reviewPrompt),
  callClaude(reviewPrompt),
]);

const synthesisPrompt = `Two independent AI reviewers reviewed the same diff. Produce a single consolidated review:
- Merge findings; deduplicate.
- Flag disagreements explicitly (mark "DISPUTED" — one reviewer raised it, the other didn't, and explain which side you think is right).
- Drop findings that don't hold up against the diff.
- Order by severity. Keep file:line references.
- End with a short "What both reviewers missed" section if you spot anything new from looking at the diff yourself.

=== GEMINI REVIEW ===
${geminiReview}

=== CLAUDE REVIEW ===
${claudeReview}

=== DIFF ===
\`\`\`diff
${diff}
\`\`\``;

console.error(`> Synthesising consolidated review with ${CLAUDE_MODEL}…`);
const final = await callClaude(synthesisPrompt);

mkdirSync(".council-review", { recursive: true });
writeFileSync(".council-review/gemini.md", geminiReview);
writeFileSync(".council-review/claude.md", claudeReview);
writeFileSync(".council-review/final.md", final);

process.stdout.write(final + "\n");
console.error("\n> Per-model outputs saved under .council-review/");

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
  if (!res.ok) die(`Gemini ${res.status}: ${await res.text()}`);
  const json = await res.json();
  const text = json?.candidates?.[0]?.content?.parts
    ?.map((p) => p.text)
    .filter(Boolean)
    .join("\n");
  if (!text) die(`Gemini returned no text: ${JSON.stringify(json).slice(0, 500)}`);
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
  if (res.error) die(`claude CLI failed to launch: ${res.error.message}`);
  if (res.status !== 0) {
    die(`claude CLI exited ${res.status}: ${(res.stderr || "").slice(0, 1000)}`);
  }
  const text = (res.stdout || "").trim();
  if (!text) die(`claude CLI returned no text. stderr: ${(res.stderr || "").slice(0, 500)}`);
  return text;
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
