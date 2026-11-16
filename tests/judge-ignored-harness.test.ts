import { lstat, mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { judgeHarnessMode, normalizeConfig, readConfig, setConfigValue } from "../src/config.js";
import { pathExists } from "../src/fs-utils.js";
import { runInit } from "../src/init.js";
import { JUDGE_SCHEMA_VERSION, readAcceptanceCriteria, verifyJudgeRecord } from "../src/judge-enforcement.js";
import { runJudgeValidation } from "../src/judge-runner.js";
import { captureJudgeSnapshot, checkJudgeSnapshotCurrentState, loadJudgeSnapshot } from "../src/judge-snapshot.js";
import { runTask } from "../src/task.js";

import { createReviewFixture } from "./helpers/judge-fixtures.js";
import { execFileAsync, tmp, useTempDir } from "./helpers/wep.js";

useTempDir();

const passCommand = 'node -e "process.exit(0)"';

async function git(cwd: string, args: string[]) {
  return (await execFileAsync("git", args, { cwd })).stdout;
}

/**
 * A project whose harness is kept out of Git. With `symlinked`, `.wep` is a link to a directory
 * outside the repository and is excluded through `.git/info/exclude`, which a fresh snapshot
 * repository does not inherit. Otherwise `.wep/` is listed in the project's `.gitignore`.
 */
async function createIgnoredHarnessFixture(
  options: { symlinked?: boolean; mode?: "repo" | "ignored"; otherTask?: boolean } = {},
) {
  const repo = path.join(tmp, "project");
  await mkdir(repo, { recursive: true });
  await runInit({ cwd: repo, target: "codex", nonInteractive: true });
  const task = await runTask("Review with an ignored harness", { cwd: repo, nonInteractive: true });
  const other = options.otherTask ? await runTask("Unrelated task", { cwd: repo, nonInteractive: true }) : undefined;
  const taskFile = path.join(repo, task.taskDir, "task.md");
  const original = await readFile(taskFile, "utf8");
  await writeFile(taskFile, original.replace("```\n```", `\`\`\`\n${passCommand}\n\`\`\``), "utf8");
  if ((options.mode ?? "ignored") === "ignored") await setConfigValue(repo, "agents.judge.harness", "ignored");

  await writeFile(path.join(repo, "app.ts"), "export const value = 1;\n", "utf8");
  await git(repo, ["init"]);
  await git(repo, ["config", "user.email", "tests@example.com"]);
  await git(repo, ["config", "user.name", "wep tests"]);
  if (options.symlinked) {
    const outside = path.join(tmp, "outside", "harness");
    await mkdir(path.dirname(outside), { recursive: true });
    await rename(path.join(repo, ".wep"), outside);
    await symlink(outside, path.join(repo, ".wep"));
    await writeFile(path.join(repo, ".git/info/exclude"), ".wep\n", "utf8");
  } else {
    await writeFile(path.join(repo, ".gitignore"), ".wep/\n", "utf8");
  }
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "base"]);
  expect(await git(repo, ["ls-files", ".wep"])).toBe("");
  await writeFile(path.join(repo, "app.ts"), "export const value = 2;\n", "utf8");
  return { repo, task, other };
}

describe("agents.judge.harness configuration", () => {
  it("defaults to repo and accepts repo or ignored through config set", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    expect(judgeHarnessMode(await readConfig(tmp))).toBe("repo");
    expect(judgeHarnessMode(undefined)).toBe("repo");

    await setConfigValue(tmp, "agents.judge.harness", "ignored");
    const config = await readConfig(tmp);
    expect(config?.agents?.judge?.harness).toBe("ignored");
    expect(judgeHarnessMode(config)).toBe("ignored");

    await setConfigValue(tmp, "agents.judge.harness", "repo");
    expect(judgeHarnessMode(await readConfig(tmp))).toBe("repo");
  });

  it("rejects an unknown mode and the field on another agent", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    await expect(setConfigValue(tmp, "agents.judge.harness", "external")).rejects.toThrow(
      /agents\.judge\.harness must be "repo" or "ignored"/,
    );
    await expect(setConfigValue(tmp, "agents.comprehension.harness", "ignored")).rejects.toThrow(
      /Unsupported config key/,
    );
    expect(() =>
      normalizeConfig({ version: 1, targets: ["codex"], agents: { judge: { harness: "external" } } }),
    ).toThrow(/agents\.judge\.harness must be "repo" or "ignored"/);
    expect(() =>
      normalizeConfig({ version: 1, targets: ["codex"], agents: { comprehension: { harness: "ignored" } } }),
    ).toThrow(/harness is only valid on agents\.judge/);
  });
});

describe("judge snapshot in repo mode", () => {
  it("records no harness field in snapshot metadata", async () => {
    const { task } = await createReviewFixture();
    const snapshot = await captureJudgeSnapshot(tmp, task.taskId, "HEAD");
    const metadata = JSON.parse(await readFile(snapshot.metadataPath, "utf8"));
    expect(Object.hasOwn(metadata, "harness")).toBe(false);
  });

  it("names the Git ignore rule and the setting when the harness is ignored", async () => {
    const { repo, task } = await createIgnoredHarnessFixture({ mode: "repo" });
    const capture = captureJudgeSnapshot(repo, task.taskId, "HEAD");
    await expect(capture).rejects.toThrow(/ignored by Git/);
    await expect(captureJudgeSnapshot(repo, task.taskId, "HEAD")).rejects.toThrow(/agents\.judge\.harness ignored/);
    await expect(captureJudgeSnapshot(repo, task.taskId, "HEAD")).rejects.not.toThrow(/doctor --fix/);
  });
});

describe("judge snapshot in ignored mode", () => {
  it("copies only the harness control files into the snapshot", async () => {
    const { repo, task, other } = await createIgnoredHarnessFixture({ otherTask: true });
    await writeFile(path.join(repo, ".wep/local/note.md"), "local only\n", "utf8");
    await writeFile(path.join(repo, ".wep/review-policy.md"), "- Every change keeps the CLI help in sync.\n", "utf8");

    const snapshot = await captureJudgeSnapshot(repo, task.taskId, "HEAD");
    const wep = path.join(snapshot.worktreePath, ".wep");

    expect(await pathExists(path.join(wep, "policy.json"))).toBe(true);
    expect(await pathExists(path.join(wep, "config.json"))).toBe(true);
    expect(await readFile(path.join(wep, "review-policy.md"), "utf8")).toContain("CLI help");
    expect(await readFile(path.join(snapshot.worktreePath, task.taskDir, "task.md"), "utf8")).toContain(passCommand);
    expect(await pathExists(path.join(snapshot.worktreePath, other?.taskDir ?? "missing"))).toBe(false);
    expect(await pathExists(path.join(wep, "local"))).toBe(false);
    expect(await pathExists(path.join(wep, "manifest.json"))).toBe(false);
    expect(JSON.parse(await readFile(snapshot.metadataPath, "utf8")).harness).toBe("ignored");
    expect((await loadJudgeSnapshot(repo, snapshot.candidate)).id).toBe(snapshot.id);
  });

  it("copies --include-task capsules and still applies blocked-read patterns", async () => {
    const { repo, task, other } = await createIgnoredHarnessFixture({ otherTask: true });
    if (!other) throw new Error("fixture must create a second task");
    await writeFile(path.join(repo, task.taskDir, ".env"), "TOKEN=never-copy\n", "utf8");

    const snapshot = await captureJudgeSnapshot(repo, task.taskId, "HEAD", [other.taskId]);

    expect(await pathExists(path.join(snapshot.worktreePath, other.taskDir, "task.md"))).toBe(true);
    expect(await pathExists(path.join(snapshot.worktreePath, task.taskDir, ".env"))).toBe(false);
    expect((await loadJudgeSnapshot(repo, snapshot.candidate)).id).toBe(snapshot.id);
  });

  it("copies real files when .wep is a symlink outside the repository", async () => {
    const { repo, task } = await createIgnoredHarnessFixture({ symlinked: true });

    const snapshot = await captureJudgeSnapshot(repo, task.taskId, "HEAD");
    const wep = path.join(snapshot.worktreePath, ".wep");

    expect((await lstat(wep)).isSymbolicLink()).toBe(false);
    expect((await lstat(path.join(wep, "policy.json"))).isFile()).toBe(true);
    expect(await pathExists(path.join(snapshot.worktreePath, task.taskDir, "task.md"))).toBe(true);
    expect((await loadJudgeSnapshot(repo, snapshot.candidate)).id).toBe(snapshot.id);
    expect((await checkJudgeSnapshotCurrentState(repo, snapshot.candidate)).status).toBe("CURRENT");
  });

  it("detects a control file edited inside the snapshot", async () => {
    const { repo, task } = await createIgnoredHarnessFixture();
    const snapshot = await captureJudgeSnapshot(repo, task.taskId, "HEAD");

    const copied = path.join(snapshot.worktreePath, task.taskDir, "acceptance-criteria.md");
    await writeFile(copied, `${await readFile(copied, "utf8")}\n- AC-99: added after capture\n`, "utf8");

    await expect(loadJudgeSnapshot(repo, snapshot.candidate)).rejects.toThrow(/Snapshot integrity check failed/);
  });

  it("moves current state away from CURRENT when the live capsule changes", async () => {
    const { repo, task } = await createIgnoredHarnessFixture({ symlinked: true });
    const snapshot = await captureJudgeSnapshot(repo, task.taskId, "HEAD");
    expect((await checkJudgeSnapshotCurrentState(repo, snapshot.candidate)).status).toBe("CURRENT");

    const live = path.join(repo, task.taskDir, "plan.md");
    await writeFile(live, `${await readFile(live, "utf8")}\nChanged after review.\n`, "utf8");

    const current = await checkJudgeSnapshotCurrentState(repo, snapshot.candidate);
    expect(current.status).not.toBe("CURRENT");
    expect(current.reviewBoundary).not.toBe("CURRENT");
  });

  it("moves current state away from CURRENT when a review policy appears after capture", async () => {
    const { repo, task } = await createIgnoredHarnessFixture();
    const snapshot = await captureJudgeSnapshot(repo, task.taskId, "HEAD");
    expect(await pathExists(path.join(snapshot.worktreePath, ".wep/review-policy.md"))).toBe(false);

    await writeFile(path.join(repo, ".wep/review-policy.md"), "- Added after the review.\n", "utf8");

    expect((await checkJudgeSnapshotCurrentState(repo, snapshot.candidate)).status).not.toBe("CURRENT");
  });

  it("runs the declared validation from the snapshot and verifies the receipt", async () => {
    const { repo, task } = await createIgnoredHarnessFixture({ symlinked: true });
    const snapshot = await captureJudgeSnapshot(repo, task.taskId, "HEAD");

    const run = await runJudgeValidation(repo, task.taskId, snapshot.candidate, { approve: async () => true });
    expect(run.passed).toBe(true);
    expect(run.receipt.commands).toEqual([passCommand]);

    const criteria = (await readAcceptanceCriteria(repo, task.taskId)).ids.map((id) => ({
      id,
      status: "pass",
      evidence: "Checked against the changed files.",
    }));
    const recordPath = path.join(repo, ".wep/local/judge/review.json");
    await mkdir(path.dirname(recordPath), { recursive: true });
    await writeFile(
      recordPath,
      `${JSON.stringify(
        {
          schemaVersion: JUDGE_SCHEMA_VERSION,
          taskId: task.taskId,
          scope: snapshot.scope,
          verdict: "APPROVED",
          tests: [{ command: passCommand, status: "passed" }],
          criteria,
          observations: [],
          receiptDigest: run.receiptDigest,
          reviewedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const verified = await verifyJudgeRecord(repo, recordPath, { receiptDigest: run.receiptDigest });
    expect(verified.reasons).toEqual([]);
    expect(verified.approved).toBe(true);
  });
});
