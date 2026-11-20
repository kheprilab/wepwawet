#!/usr/bin/env node
// Commit and pull request rules shared by the local commit-msg hook and the commit-rules CI job.
//
//   node scripts/commit-rules.mjs message <file>   check one commit message file (commit-msg hook)
//   node scripts/commit-rules.mjs pr               check the pull request in $GITHUB_EVENT_PATH (CI)

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const AI_TOOLS = "claude|codex|copilot|anthropic|openai|chatgpt|cursor|gemini";
const ATTRIBUTION = [
  new RegExp(`co-authored-by:.*\\b(${AI_TOOLS})`, "i"),
  new RegExp(`generated (with|by)\\b.*\\b(${AI_TOOLS})`, "i"),
];
const SUBJECT = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-z0-9-]+\))?!?: .{1,100}$/;
const SUBJECT_HELP =
  "Allowed types: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert. Scope is optional; use ! for breaking changes; subject must be 1-100 characters.";
const EXEMPT_SUBJECT = /^(Merge |fixup! |squash! )/;
const SINGLE_COMMIT_AUTHORS = new Set(["kheprilab-agent[bot]"]);

/** Lines of `text` that attribute work to an AI tool. */
export function findAttribution(text) {
  return (text ?? "").split(/\r?\n/).filter((line) => ATTRIBUTION.some((pattern) => pattern.test(line)));
}

/** Errors for one commit message. Git comment lines are ignored, as git strips them. */
export function checkCommitMessage(message) {
  const lines = message.split(/\r?\n/).filter((line) => !line.startsWith("#"));
  const errors = [];
  if (findAttribution(lines.join("\n")).length > 0) {
    errors.push("remove tool attribution from the commit message.");
  }
  const subject = lines.find((line) => line.trim() !== "") ?? "";
  if (!EXEMPT_SUBJECT.test(subject) && !SUBJECT.test(subject)) {
    errors.push(`use type(scope): subject, e.g. feat(cli): add an option. Got: "${subject}". ${SUBJECT_HELP}`);
  }
  return errors;
}

/** Errors for a pull request: its body, every commit, and the one-commit rule for agent PRs. */
export function checkPullRequest({ author, body, commits }) {
  const errors = [];
  if (findAttribution(body).length > 0) {
    errors.push("PR body: remove tool attribution.");
  }
  for (const { sha, message } of commits) {
    for (const error of checkCommitMessage(message)) {
      errors.push(`commit ${sha.slice(0, 7)}: ${error}`);
    }
  }
  if (SINGLE_COMMIT_AUTHORS.has(author) && commits.length !== 1) {
    errors.push(`${author} pull requests must have exactly one commit; found ${commits.length}.`);
  }
  return errors;
}

function commitsBetween(base, head) {
  const out = execFileSync("git", ["log", "--format=%H%x00%B%x1e", `${base}..${head}`], { encoding: "utf8" });
  return out
    .split("\x1e")
    .map((entry) => entry.replace(/^\n/, ""))
    .filter((entry) => entry.includes("\0"))
    .map((entry) => {
      const [sha, message] = entry.split("\0");
      return { sha, message };
    });
}

function run(argv) {
  const [mode, file] = argv;
  let errors;
  let prefix;
  if (mode === "message" && file) {
    prefix = "commit-msg";
    errors = checkCommitMessage(readFileSync(file, "utf8"));
  } else if (mode === "pr") {
    prefix = "commit-rules";
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8"));
    const pr = event.pull_request;
    errors = checkPullRequest({
      author: pr.user.login,
      body: pr.body,
      commits: commitsBetween(pr.base.sha, pr.head.sha),
    });
  } else {
    console.error("usage: commit-rules.mjs message <file> | commit-rules.mjs pr");
    return 2;
  }
  for (const error of errors) console.error(`${prefix}: ${error}`);
  return errors.length > 0 ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(run(process.argv.slice(2)));
}
