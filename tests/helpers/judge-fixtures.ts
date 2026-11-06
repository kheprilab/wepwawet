import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";
import { CONTINUATION_SCHEMA_VERSION, type ContinuationRecord } from "../../src/continuation.js";
import { runInit } from "../../src/init.js";
import { JUDGE_SCHEMA_VERSION, createJudgeScope, readAcceptanceCriteria } from "../../src/judge-enforcement.js";
import { captureJudgeSnapshot } from "../../src/judge-snapshot.js";
import { runTask } from "../../src/task.js";

import { execFileAsync, tmp } from "./wep.js";

/** One passing entry per criterion the capsule declares, which is what APPROVED requires. */
export async function passingCriteria(taskId: string) {
  const declaration = await readAcceptanceCriteria(tmp, taskId);
  return declaration.ids.map((id) => ({ id, status: "pass", evidence: "Checked against the changed files." }));
}

export async function createReviewFixture(
  options: { declares?: string[]; claims?: string[]; legacyCapsule?: boolean; checklist?: string } = {},
) {
  await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
  const task = await runTask("Enforce judge approvals", { cwd: tmp, nonInteractive: true });
  // Fill the empty fenced block the generated capsule already ships under `## Validation`;
  // appending a second section would be shadowed by the first one the parser finds. Defaults to
  // a declared `pnpm test` so the fixture is a realistic completed capsule, not an unfinished one.
  const taskFile = path.join(tmp, task.taskDir, "task.md");
  const original = await readFile(taskFile, "utf8");
  if (options.legacyCapsule) {
    await writeFile(taskFile, original.replace(/\n## Validation\n[\s\S]*?(?=\n## )/, "\n"), "utf8");
  } else {
    const declares = options.declares ?? ["pnpm test"];
    const filled = original.replace("```\n```", `\`\`\`\n${declares.join("\n")}\n\`\`\``);
    expect(filled).not.toBe(original);
    await writeFile(taskFile, filled, "utf8");
  }
  if (options.checklist !== undefined) {
    await writeFile(path.join(tmp, task.taskDir, "review-checklist.md"), options.checklist, "utf8");
  }
  await writeFile(path.join(tmp, "app.ts"), "export const value = 1;\n", "utf8");
  await execFileAsync("git", ["init"], { cwd: tmp });
  await execFileAsync("git", ["config", "user.email", "tests@example.com"], { cwd: tmp });
  await execFileAsync("git", ["config", "user.name", "wep tests"], { cwd: tmp });
  await execFileAsync("git", ["add", "."], { cwd: tmp });
  await execFileAsync("git", ["commit", "-m", "base"], { cwd: tmp });
  await writeFile(path.join(tmp, "app.ts"), "export const value = 2;\n", "utf8");
  const scope = await createJudgeScope(tmp, task.taskId, "HEAD", "WORKTREE");
  const record = {
    schemaVersion: JUDGE_SCHEMA_VERSION,
    taskId: task.taskId,
    scope,
    verdict: "APPROVED",
    tests: (options.claims ?? ["pnpm test"]).map((command) => ({ command, status: "passed" })),
    criteria: await passingCriteria(task.taskId),
    observations: [],
    reviewedAt: new Date().toISOString(),
  };
  const recordPath = path.join(tmp, ".wep/local/judge/review.json");
  await mkdir(path.dirname(recordPath), { recursive: true });
  await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return { task, scope, recordPath };
}

export function validContinuationRecord(task: { taskId: string; taskDir: string }): ContinuationRecord {
  return {
    schemaVersion: CONTINUATION_SCHEMA_VERSION,
    task: {
      taskId: task.taskId,
      capsulePath: task.taskDir,
      capsuleDigest: `sha256:${"a".repeat(64)}`,
      capsuleRevision: { gitCommit: null },
    },
    latestExecution: null,
    history: [],
  };
}

export async function writeContinuationSidecar(task: { taskId: string; taskDir: string }, body: string): Promise<void> {
  await writeFile(path.join(tmp, task.taskDir, "continuation.json"), body, "utf8");
}

export async function declareValidation(fenceBody: string) {
  await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
  const task = await runTask("Parse validation declarations", { cwd: tmp, nonInteractive: true });
  const taskFile = path.join(tmp, task.taskDir, "task.md");
  const original = await readFile(taskFile, "utf8");
  const filled = original.replace("```\n```", `\`\`\`\n${fenceBody}\n\`\`\``);
  expect(filled).not.toBe(original);
  await writeFile(taskFile, filled, "utf8");
  return task;
}

export async function createApprovableSnapshotFixture(commands: string[]) {
  const { task } = await createReviewFixture({ declares: commands, claims: [] });
  const snapshot = await captureJudgeSnapshot(tmp, task.taskId, "HEAD");
  const recordPath = path.join(tmp, ".wep/local/judge/approval-review.json");
  await writeFile(
    recordPath,
    `${JSON.stringify(
      {
        schemaVersion: JUDGE_SCHEMA_VERSION,
        taskId: task.taskId,
        scope: snapshot.scope,
        verdict: "APPROVED",
        tests: commands.map((command) => ({ command, status: "passed" })),
        criteria: await passingCriteria(task.taskId),
        observations: [],
        reviewedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return { task, snapshot, recordPath };
}
