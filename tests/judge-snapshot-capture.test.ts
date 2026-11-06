import { lstat, mkdir, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pathExists } from "../src/fs-utils.js";
import { runInit } from "../src/init.js";
import { JUDGE_SCHEMA_VERSION, createJudgeScope, verifyJudgeRecord } from "../src/judge-enforcement.js";
import { captureJudgeSnapshot, loadJudgeSnapshot } from "../src/judge-snapshot.js";
import { runTask } from "../src/task.js";

import { createReviewFixture, passingCriteria } from "./helpers/judge-fixtures.js";
import { execFileAsync, tmp, useTempDir } from "./helpers/wep.js";

useTempDir();

describe("judge", () => {
  it("captures an ignored immutable snapshot without changing Git state", async () => {
    const { task } = await createReviewFixture();
    await writeFile(path.join(tmp, "obsolete.ts"), "export const obsolete = true;\n", "utf8");
    await execFileAsync("git", ["add", "obsolete.ts"], { cwd: tmp });
    await execFileAsync("git", ["commit", "-m", "add obsolete fixture"], { cwd: tmp });
    await rm(path.join(tmp, "obsolete.ts"));
    await writeFile(path.join(tmp, "untracked.ts"), "export const untracked = true;\n", "utf8");
    const gitState = async () => ({
      head: (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: tmp })).stdout,
      branch: (await execFileAsync("git", ["branch", "--show-current"], { cwd: tmp })).stdout,
      status: (await execFileAsync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: tmp })).stdout,
      staged: (await execFileAsync("git", ["diff", "--cached", "--binary"], { cwd: tmp })).stdout,
      refs: (await execFileAsync("git", ["for-each-ref", "--format=%(refname) %(objectname)"], { cwd: tmp })).stdout,
      stash: (await execFileAsync("git", ["stash", "list"], { cwd: tmp })).stdout,
    });
    const before = await gitState();

    const snapshot = await captureJudgeSnapshot(tmp, task.taskId, "HEAD");

    expect(await gitState()).toEqual(before);
    expect(snapshot.candidate).toBe(`SNAPSHOT:${snapshot.id}`);
    expect(await readFile(path.join(snapshot.worktreePath, "app.ts"), "utf8")).toContain("value = 2");
    expect(await pathExists(path.join(snapshot.worktreePath, "obsolete.ts"))).toBe(false);
    expect(await readFile(path.join(snapshot.worktreePath, "untracked.ts"), "utf8")).toContain("untracked = true");
    await execFileAsync("git", ["check-ignore", "-q", path.relative(tmp, snapshot.metadataPath)], { cwd: tmp });
  });

  it("rejects an accidentally empty committed boundary before publishing anything", async () => {
    const { task } = await createReviewFixture();
    await execFileAsync("git", ["add", "."], { cwd: tmp });
    await execFileAsync("git", ["commit", "-m", "implementation"], { cwd: tmp });

    await expect(captureJudgeSnapshot(tmp, task.taskId, "HEAD")).rejects.toThrow(
      /empty judge boundary.*HEAD as the base does not include commits.*--base origin\/main/i,
    );
    expect(await readdir(path.join(tmp, ".wep/local/judge/snapshots")).catch(() => [])).toEqual([]);
    expect(
      (await readdir(path.join(tmp, ".wep/local/judge")).catch(() => [])).filter((entry) =>
        entry.startsWith(".capture-"),
      ),
    ).toEqual([]);
  });

  it("allows and integrity-binds an explicitly authorized empty snapshot", async () => {
    const { task } = await createReviewFixture();
    await execFileAsync("git", ["add", "."], { cwd: tmp });
    await execFileAsync("git", ["commit", "-m", "implementation"], { cwd: tmp });

    const snapshot = await captureJudgeSnapshot(tmp, task.taskId, "HEAD", [], true);
    expect(snapshot.emptyBoundaryAuthorized).toBe(true);
    expect(snapshot.scope.changedFiles).toEqual([]);
    expect(snapshot.scope.emptyBoundaryAuthorized).toBe(true);
    expect((await loadJudgeSnapshot(tmp, snapshot.candidate)).metadata.emptyBoundaryAuthorized).toBe(true);

    const metadata = JSON.parse(await readFile(snapshot.metadataPath, "utf8"));
    metadata.emptyBoundaryAuthorized = false;
    await writeFile(snapshot.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    await expect(loadJudgeSnapshot(tmp, snapshot.candidate)).rejects.toThrow(/metadata shape or identity is invalid/);
  });

  it("canonicalizes remote refs, local branches, tags, and hashes to one base identity", async () => {
    const { task } = await createReviewFixture({ declares: ['node -e "process.exit(0)"'] });
    const baseCommit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: tmp })).stdout.trim();
    await execFileAsync("git", ["update-ref", "refs/remotes/origin/main", baseCommit], { cwd: tmp });
    await execFileAsync("git", ["branch", "task-057-base", baseCommit], { cwd: tmp });
    await execFileAsync("git", ["tag", "task-057-tag", baseCommit], { cwd: tmp });

    const scopes = await Promise.all(
      ["origin/main", "task-057-base", "task-057-tag", baseCommit].map((base) =>
        createJudgeScope(tmp, task.taskId, base, "WORKTREE"),
      ),
    );

    for (const scope of scopes) expect(scope.base).toBe(baseCommit);
    expect(scopes[0].baseRef).toBe("origin/main");
    expect(scopes[1].baseRef).toBe("task-057-base");
    expect(scopes[2].baseRef).toBe("task-057-tag");
    expect(scopes[3].baseRef).toBeUndefined();
    expect(new Set(scopes.map((scope) => scope.scopeDigest)).size).toBe(1);
  });

  it("verifies a snapshot after its symbolic remote base ref is absent", async () => {
    const command = 'node -e "process.exit(0)"';
    const { task } = await createReviewFixture({ declares: [command], claims: [command] });
    const baseCommit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: tmp })).stdout.trim();
    await execFileAsync("git", ["update-ref", "refs/remotes/origin/main", baseCommit], { cwd: tmp });
    await execFileAsync("git", ["tag", "task-057-tag", baseCommit], { cwd: tmp });
    const first = await captureJudgeSnapshot(tmp, task.taskId, "origin/main");
    const snapshot = await captureJudgeSnapshot(tmp, task.taskId, "task-057-tag");
    const persisted = JSON.parse(await readFile(snapshot.metadataPath, "utf8"));
    expect(first.id).toBe(snapshot.id);
    expect(first.scope.base).toBe(baseCommit);
    expect(snapshot.scope.base).toBe(baseCommit);
    expect(first.scope.baseRef).toBeUndefined();
    expect(snapshot.scope.baseRef).toBeUndefined();
    expect(persisted.sourceScope.baseRef).toBeUndefined();
    expect(persisted.scope.baseRef).toBeUndefined();
    const recordPath = path.join(tmp, ".wep/local/judge/origin-review.json");
    await writeFile(
      recordPath,
      `${JSON.stringify(
        {
          schemaVersion: JUDGE_SCHEMA_VERSION,
          taskId: task.taskId,
          scope: snapshot.scope,
          verdict: "APPROVED",
          tests: [{ command, status: "passed" }],
          criteria: await passingCriteria(task.taskId),
          observations: [],
          reviewedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await execFileAsync("git", ["update-ref", "-d", "refs/remotes/origin/main"], { cwd: tmp });

    const result = await verifyJudgeRecord(tmp, recordPath, { runTests: true, approve: async () => true });

    expect(result).toMatchObject({ valid: true, approved: true, reasons: [], reexecuted: [{ command, passed: true }] });
    expect(snapshot.scope.base).toBe(baseCommit);
    await execFileAsync("git", ["tag", "-d", "task-057-tag"], { cwd: tmp });
    expect(await execFileAsync("git", ["remote"], { cwd: snapshot.worktreePath })).toMatchObject({ stdout: "" });
  });

  it("rejects an unresolved base before publishing a snapshot", async () => {
    const { task } = await createReviewFixture();

    await expect(captureJudgeSnapshot(tmp, task.taskId, "origin/does-not-exist")).rejects.toThrow(
      "Cannot resolve Git commit: origin/does-not-exist",
    );
    expect(await readdir(path.join(tmp, ".wep/local/judge/snapshots")).catch(() => [])).toEqual([]);
  });

  it("captures an wepwawet package like any consumer project, without building it", async () => {
    const { task } = await createReviewFixture();
    await writeFile(path.join(tmp, "package.json"), JSON.stringify({ name: "wepwawet" }), "utf8");
    await writeFile(path.join(tmp, ".gitignore"), ".wep/local/\ndist/\n", "utf8");
    await mkdir(path.join(tmp, "src"), { recursive: true });
    // Not valid TypeScript: capture compiles nothing, so this source cannot fail it.
    await writeFile(path.join(tmp, "src/index.ts"), "export const =\n", "utf8");

    const snapshot = await captureJudgeSnapshot(tmp, task.taskId, "HEAD");
    const metadata = JSON.parse(await readFile(snapshot.metadataPath, "utf8"));

    expect(await pathExists(path.join(snapshot.worktreePath, "dist"))).toBe(false);
    expect(await pathExists(path.join(tmp, "dist"))).toBe(false);
    expect(metadata).not.toHaveProperty("artifactContentDigest");
    expect(metadata).not.toHaveProperty("artifactIntegrityDigest");
  });

  it.each(["artifactContentDigest", "artifactIntegrityDigest"])(
    "rejects a previous-format snapshot whose metadata carries %s",
    async (field) => {
      const { task } = await createReviewFixture();
      const snapshot = await captureJudgeSnapshot(tmp, task.taskId, "HEAD");
      const metadata = JSON.parse(await readFile(snapshot.metadataPath, "utf8"));
      metadata[field] = `sha256:${"0".repeat(64)}`;
      await writeFile(snapshot.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

      await expect(loadJudgeSnapshot(tmp, snapshot.candidate)).rejects.toThrow(
        /previous format.*capture a new snapshot/,
      );
    },
  );

  it("gives equivalent recaptures the same snapshot ID", async () => {
    const { task } = await createReviewFixture();
    await writeFile(path.join(tmp, "package.json"), JSON.stringify({ name: "wepwawet" }), "utf8");
    await writeFile(path.join(tmp, ".gitignore"), ".wep/local/\ndist/\n", "utf8");
    await mkdir(path.join(tmp, "src"), { recursive: true });
    await writeFile(path.join(tmp, "src/index.ts"), 'export const snapshotBuild = "snapshot build";\n', "utf8");

    const first = await captureJudgeSnapshot(tmp, task.taskId, "HEAD");
    const second = await captureJudgeSnapshot(tmp, task.taskId, "HEAD");

    expect(second.id).toBe(first.id);
    expect(second.candidate).toBe(first.candidate);
  });

  it("does not execute an wep candidate's build script while capturing a snapshot", async () => {
    const { task } = await createReviewFixture();
    const marker = path.join(tmp, "candidate-build-ran.txt");
    const encodedMarker = Buffer.from(marker).toString("base64");
    await writeFile(
      path.join(tmp, "package.json"),
      JSON.stringify({
        name: "wepwawet",
        scripts: {
          build: `node -e "require('fs').writeFileSync(Buffer.from('${encodedMarker}','base64').toString(),'unexpected')"`,
        },
      }),
      "utf8",
    );
    await writeFile(path.join(tmp, ".gitignore"), ".wep/local/\ndist/\n", "utf8");
    await mkdir(path.join(tmp, "src"), { recursive: true });
    await writeFile(path.join(tmp, "src/index.ts"), 'export const safeEntry = "safe";\n', "utf8");

    await captureJudgeSnapshot(tmp, task.taskId, "HEAD");

    expect(await pathExists(marker)).toBe(false);
  });

  it("does not execute a consumer project's build script while capturing a snapshot", async () => {
    const { task } = await createReviewFixture();
    await writeFile(
      path.join(tmp, "package.json"),
      JSON.stringify({
        name: "consumer-project",
        scripts: { build: "node -e \"require('fs').writeFileSync('consumer-build-ran.txt','unexpected')\"" },
      }),
      "utf8",
    );

    await captureJudgeSnapshot(tmp, task.taskId, "HEAD");

    expect(await pathExists(path.join(tmp, "consumer-build-ran.txt"))).toBe(false);
  });

  it("captures a snapshot when live file modes differ from a fresh checkout (mode-insensitive)", async () => {
    const restore = process.umask(0o022);
    const { task } = await createReviewFixture();
    const restore2 = process.umask(0o0002);
    try {
      const snapshot = await captureJudgeSnapshot(tmp, task.taskId, "HEAD");
      expect(snapshot.candidate).toBe(`SNAPSHOT:${snapshot.id}`);
      expect(await pathExists(path.join(snapshot.worktreePath, "app.ts"))).toBe(true);
    } finally {
      process.umask(restore2);
      process.umask(restore);
    }
  });

  it("removes blocked tracked paths from a shallow review worktree", async () => {
    const { task } = await createReviewFixture();
    await writeFile(path.join(tmp, ".env"), "DO_NOT_COPY=secret\n", "utf8");
    await execFileAsync("git", ["add", ".env"], { cwd: tmp });
    await execFileAsync("git", ["commit", "-m", "add blocked fixture"], { cwd: tmp });
    await rm(path.join(tmp, ".env"));

    const snapshot = await captureJudgeSnapshot(tmp, task.taskId, "HEAD");
    const { stdout } = await execFileAsync("git", ["rev-list", "--count", "--all"], { cwd: snapshot.worktreePath });
    const remotes = await execFileAsync("git", ["remote"], { cwd: snapshot.worktreePath });

    expect(snapshot.scope.excludedPaths).toContain(".env");
    expect(await pathExists(path.join(snapshot.worktreePath, ".env"))).toBe(false);
    expect(Number(stdout.trim())).toBeLessThanOrEqual(2);
    expect(remotes.stdout).toBe("");
  });

  it("keeps snapshot approval valid while the live worktree moves", async () => {
    const { task } = await createReviewFixture({ declares: ['node -e "process.exit(0)"'], claims: [] });
    const snapshot = await captureJudgeSnapshot(tmp, task.taskId, "HEAD");
    const command = 'node -e "process.exit(0)"';
    const recordPath = path.join(tmp, ".wep/local/judge/snapshot-review.json");
    await writeFile(
      recordPath,
      `${JSON.stringify(
        {
          schemaVersion: JUDGE_SCHEMA_VERSION,
          taskId: task.taskId,
          scope: snapshot.scope,
          verdict: "APPROVED",
          tests: [{ command, status: "passed" }],
          criteria: await passingCriteria(task.taskId),
          observations: [],
          reviewedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(path.join(tmp, "app.ts"), "export const value = 3;\n", "utf8");

    const result = await verifyJudgeRecord(tmp, recordPath, { runTests: true, approve: async () => true });

    expect(result.approved).toBe(true);
    expect(result.reexecuted[0]).toMatchObject({ command, passed: true });
    expect(await readFile(path.join(snapshot.worktreePath, "app.ts"), "utf8")).toContain("value = 2");
  });

  it("invalidates a snapshot approval when snapshot content is tampered with", async () => {
    const { task } = await createReviewFixture();
    const snapshot = await captureJudgeSnapshot(tmp, task.taskId, "HEAD");
    const recordPath = path.join(tmp, ".wep/local/judge/snapshot-review.json");
    await writeFile(
      recordPath,
      `${JSON.stringify(
        {
          schemaVersion: JUDGE_SCHEMA_VERSION,
          taskId: task.taskId,
          scope: snapshot.scope,
          verdict: "APPROVED",
          tests: [{ command: "pnpm test", status: "passed" }],
          criteria: await passingCriteria(task.taskId),
          observations: [],
          reviewedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(path.join(snapshot.worktreePath, "app.ts"), "export const value = 99;\n", "utf8");

    const result = await verifyJudgeRecord(tmp, recordPath);

    expect(result.approved).toBe(false);
    expect(result.reasons.join("\n")).toContain("Snapshot integrity check failed");
  });

  it("invalidates a snapshot approval when the snapshot workspace is deleted", async () => {
    const { task } = await createReviewFixture();
    const snapshot = await captureJudgeSnapshot(tmp, task.taskId, "HEAD");
    const recordPath = path.join(tmp, ".wep/local/judge/snapshot-review.json");
    await writeFile(
      recordPath,
      `${JSON.stringify(
        {
          schemaVersion: JUDGE_SCHEMA_VERSION,
          taskId: task.taskId,
          scope: snapshot.scope,
          verdict: "APPROVED",
          tests: [{ command: "pnpm test", status: "passed" }],
          criteria: await passingCriteria(task.taskId),
          observations: [],
          reviewedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await rm(snapshot.worktreePath, { recursive: true, force: true });

    const result = await verifyJudgeRecord(tmp, recordPath);

    expect(result.approved).toBe(false);
    expect(result.reasons.join("\n")).toContain("Snapshot integrity check failed");
  });

  it("rejects a snapshot whose ignored dependency directory links to the live project", async () => {
    const { task } = await createReviewFixture();
    const snapshot = await captureJudgeSnapshot(tmp, task.taskId, "HEAD");
    await mkdir(path.join(tmp, "node_modules"), { recursive: true });
    await symlink(path.join(tmp, "node_modules"), path.join(snapshot.worktreePath, "node_modules"), "dir");

    await expect(loadJudgeSnapshot(tmp, snapshot.candidate)).rejects.toThrow("dependency directory is a symlink");
  });

  it("refuses to read an old snapshot after blocked-read policy changes", async () => {
    const { task } = await createReviewFixture();
    const snapshot = await captureJudgeSnapshot(tmp, task.taskId, "HEAD");
    const recordPath = path.join(tmp, ".wep/local/judge/snapshot-review.json");
    await writeFile(
      recordPath,
      `${JSON.stringify(
        {
          schemaVersion: JUDGE_SCHEMA_VERSION,
          taskId: task.taskId,
          scope: snapshot.scope,
          verdict: "APPROVED",
          tests: [{ command: "pnpm test", status: "passed" }],
          criteria: await passingCriteria(task.taskId),
          observations: [],
          reviewedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const policyPath = path.join(tmp, ".wep/policy.json");
    const policy = JSON.parse(await readFile(policyPath, "utf8"));
    policy.blockedReadPatterns.push("*.new-secret");
    await writeFile(policyPath, `${JSON.stringify(policy, null, 2)}\n`, "utf8");

    const result = await verifyJudgeRecord(tmp, recordPath);

    expect(result.approved).toBe(false);
    expect(result.reasons.join("\n")).toContain("blocked-read policy changed after capture");
  });

  it("runs mutating snapshot validation away from the live worktree and detects it", async () => {
    const mutating = "node -e \"require('fs').writeFileSync('app.ts', 'export const value = 7;\\n')\"";
    const { task } = await createReviewFixture({ declares: [mutating], claims: [] });
    const snapshot = await captureJudgeSnapshot(tmp, task.taskId, "HEAD");
    const recordPath = path.join(tmp, ".wep/local/judge/snapshot-review.json");
    await writeFile(
      recordPath,
      `${JSON.stringify(
        {
          schemaVersion: JUDGE_SCHEMA_VERSION,
          taskId: task.taskId,
          scope: snapshot.scope,
          verdict: "APPROVED",
          tests: [{ command: mutating, status: "passed" }],
          criteria: await passingCriteria(task.taskId),
          observations: [],
          reviewedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const result = await verifyJudgeRecord(tmp, recordPath, { runTests: true, approve: async () => true });

    expect(result.approved).toBe(false);
    expect(result.reasons.join("\n")).toContain("Validation changed the snapshot");
    expect(await readFile(path.join(tmp, "app.ts"), "utf8")).toContain("value = 2");
    expect(await readFile(path.join(snapshot.worktreePath, "app.ts"), "utf8")).toContain("value = 2");
  });

  it("materialises dependencies from the lockfile so validation resolves transitive packages", async () => {
    const command = "node -e \"if(require('dep')!=='leaf reached')process.exit(1)\"";
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const task = await runTask("Resolve deps from lockfile", { cwd: tmp, nonInteractive: true });
    const taskFile = path.join(tmp, task.taskDir, "task.md");
    const original = await readFile(taskFile, "utf8");
    const filled = original.replace("```\n```", `\`\`\`\n${command}\n\`\`\``);
    expect(filled).not.toBe(original);
    await writeFile(taskFile, filled, "utf8");
    await writeFile(path.join(tmp, "app.ts"), "export const value = 1;\n", "utf8");
    await writeFile(path.join(tmp, ".gitignore"), ".wep/local/\nnode_modules/\n", "utf8");
    await mkdir(path.join(tmp, "packages/dep"), { recursive: true });
    await mkdir(path.join(tmp, "packages/leaf"), { recursive: true });
    await writeFile(
      path.join(tmp, "packages/leaf/package.json"),
      `${JSON.stringify({ name: "leaf", version: "1.0.0", main: "index.js" })}\n`,
      "utf8",
    );
    await writeFile(path.join(tmp, "packages/leaf/index.js"), 'module.exports = "leaf reached";\n', "utf8");
    await writeFile(
      path.join(tmp, "packages/dep/package.json"),
      `${JSON.stringify({ name: "dep", version: "1.0.0", main: "index.js", dependencies: { leaf: "file:../leaf" } })}\n`,
      "utf8",
    );
    await writeFile(path.join(tmp, "packages/dep/index.js"), 'module.exports = require("leaf");\n', "utf8");
    await writeFile(
      path.join(tmp, "package.json"),
      `${JSON.stringify({ name: "app", version: "1.0.0", dependencies: { dep: "file:packages/dep" } })}\n`,
      "utf8",
    );
    await execFileAsync("pnpm", ["install"], { cwd: tmp, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    await execFileAsync("git", ["init"], { cwd: tmp });
    await execFileAsync("git", ["config", "user.email", "tests@example.com"], { cwd: tmp });
    await execFileAsync("git", ["config", "user.name", "wep tests"], { cwd: tmp });
    await execFileAsync("git", ["add", "."], { cwd: tmp });
    await execFileAsync("git", ["commit", "-m", "base"], { cwd: tmp });
    await writeFile(path.join(tmp, "app.ts"), "export const value = 2;\n", "utf8");

    const snapshot = await captureJudgeSnapshot(tmp, task.taskId, "HEAD");
    const recordPath = path.join(tmp, ".wep/local/judge/lockfile-review.json");
    await writeFile(
      recordPath,
      `${JSON.stringify({
        schemaVersion: JUDGE_SCHEMA_VERSION,
        taskId: task.taskId,
        scope: snapshot.scope,
        verdict: "APPROVED",
        tests: [{ command, status: "passed" }],
        criteria: await passingCriteria(task.taskId),
        observations: [],
        reviewedAt: new Date().toISOString(),
      })}\n`,
      "utf8",
    );

    const result = await verifyJudgeRecord(tmp, recordPath, { runTests: true, approve: async () => true });
    expect(result.reexecuted[0]).toMatchObject({ command, passed: true });
    expect(result.approved).toBe(true);
  });

  it("captures no dependency directory and leaves the live one untouched", async () => {
    const { task } = await createReviewFixture();
    await writeFile(path.join(tmp, ".gitignore"), ".wep/local/\nnode_modules/\nsecrets-outside/\n", "utf8");
    await mkdir(path.join(tmp, "node_modules/dep"), { recursive: true });
    await writeFile(path.join(tmp, "node_modules/dep/index.js"), "module.exports = 1;\n", "utf8");
    await mkdir(path.join(tmp, "secrets-outside"), { recursive: true });
    await writeFile(path.join(tmp, "secrets-outside/data.txt"), "outside content\n", "utf8");
    // Escaping and broken links used to need special handling when capture copied the tree.
    await symlink(path.join(tmp, "secrets-outside"), path.join(tmp, "node_modules/absolute-escape"), "dir");
    await symlink("../secrets-outside", path.join(tmp, "node_modules/relative-escape"), "dir");
    await symlink(path.join(tmp, "node_modules/nowhere"), path.join(tmp, "node_modules/broken"), "dir");

    const snapshot = await captureJudgeSnapshot(tmp, task.taskId, "HEAD");

    expect(await pathExists(path.join(snapshot.worktreePath, "node_modules"))).toBe(false);
    expect(await readFile(path.join(tmp, "node_modules/dep/index.js"), "utf8")).toBe("module.exports = 1;\n");
    expect((await lstat(path.join(tmp, "node_modules/absolute-escape"))).isSymbolicLink()).toBe(true);
    expect((await lstat(path.join(tmp, "node_modules/broken"))).isSymbolicLink()).toBe(true);
  });

  it("recreates a symlink among the changed files instead of throwing", async () => {
    const { task } = await createReviewFixture();
    await symlink("app.ts", path.join(tmp, "app-link.ts"));
    await execFileAsync("git", ["add", "app-link.ts"], { cwd: tmp });

    const snapshot = await captureJudgeSnapshot(tmp, task.taskId, "HEAD");
    const link = path.join(snapshot.worktreePath, "app-link.ts");
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readlink(link)).toBe("app.ts");
  });

  it("verify --run-tests does not trust the snapshot's node_modules", async () => {
    const command =
      "node -e \"if(require('fs').existsSync('node_modules/MARKER.txt'))process.exit(0);else process.exit(1)\"";
    const { task } = await createReviewFixture({ declares: [command], claims: [] });
    await writeFile(path.join(tmp, ".gitignore"), ".wep/local/\nnode_modules/\n", "utf8");
    await mkdir(path.join(tmp, "node_modules"), { recursive: true });
    await writeFile(path.join(tmp, "node_modules/MARKER.txt"), "planted\n", "utf8");
    const snapshot = await captureJudgeSnapshot(tmp, task.taskId, "HEAD");
    expect(await pathExists(path.join(snapshot.worktreePath, "node_modules"))).toBe(false);
    const recordPath = path.join(tmp, ".wep/local/judge/dependency-review.json");
    await writeFile(
      recordPath,
      `${JSON.stringify(
        {
          schemaVersion: JUDGE_SCHEMA_VERSION,
          taskId: task.taskId,
          scope: snapshot.scope,
          verdict: "APPROVED",
          tests: [{ command, status: "passed" }],
          criteria: await passingCriteria(task.taskId),
          observations: [],
          reviewedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const result = await verifyJudgeRecord(tmp, recordPath, { runTests: true, approve: async () => true });

    expect(result.reexecuted).toHaveLength(1);
    expect(result.reexecuted[0]).toMatchObject({ command, passed: false });
    expect(result.reexecuted[0].evidence).toMatchObject({ status: "failed" });
    expect(result.approved).toBe(false);
    expect(result.reasons.join("\n")).toContain("Independent re-run");
    expect(await readFile(path.join(snapshot.worktreePath, "app.ts"), "utf8")).toContain("value = 2");
    expect(await readFile(path.join(tmp, "app.ts"), "utf8")).toContain("value = 2");
  });

  it("verify --run-tests ignores node_modules left in an older snapshot", async () => {
    // Snapshots captured before TASK-094 still hold a dependency copy. The disposable copy must
    // keep excluding it and install from the lockfile instead.
    const command =
      "node -e \"if(require('fs').existsSync('node_modules/MARKER.txt'))process.exit(0);else process.exit(1)\"";
    const { task } = await createReviewFixture({ declares: [command], claims: [] });
    await writeFile(path.join(tmp, ".gitignore"), ".wep/local/\nnode_modules/\n", "utf8");
    const snapshot = await captureJudgeSnapshot(tmp, task.taskId, "HEAD");
    await mkdir(path.join(snapshot.worktreePath, "node_modules"), { recursive: true });
    await writeFile(path.join(snapshot.worktreePath, "node_modules/MARKER.txt"), "planted\n", "utf8");
    await expect(loadJudgeSnapshot(tmp, snapshot.candidate)).resolves.toBeDefined();
    const recordPath = path.join(tmp, ".wep/local/judge/old-snapshot-dependency-review.json");
    await writeFile(
      recordPath,
      `${JSON.stringify({
        schemaVersion: JUDGE_SCHEMA_VERSION,
        taskId: task.taskId,
        scope: snapshot.scope,
        verdict: "APPROVED",
        tests: [{ command, status: "passed" }],
        criteria: await passingCriteria(task.taskId),
        observations: [],
        reviewedAt: new Date().toISOString(),
      })}\n`,
      "utf8",
    );

    const result = await verifyJudgeRecord(tmp, recordPath, { runTests: true, approve: async () => true });

    expect(result.reexecuted[0]).toMatchObject({ command, passed: false });
    expect(result.approved).toBe(false);
  });

  it("verify --run-tests fails when the boundary declares dependencies but has no lockfile", async () => {
    const command = 'node -e "process.exit(0)"';
    const { task } = await createReviewFixture({ declares: [command], claims: [] });
    await writeFile(
      path.join(tmp, "package.json"),
      `${JSON.stringify({ name: "app", dependencies: { dep: "^1.0.0" } })}\n`,
      "utf8",
    );
    const snapshot = await captureJudgeSnapshot(tmp, task.taskId, "HEAD");
    const recordPath = path.join(tmp, ".wep/local/judge/no-lockfile-review.json");
    await writeFile(
      recordPath,
      `${JSON.stringify(
        {
          schemaVersion: JUDGE_SCHEMA_VERSION,
          taskId: task.taskId,
          scope: snapshot.scope,
          verdict: "APPROVED",
          tests: [{ command, status: "passed" }],
          criteria: await passingCriteria(task.taskId),
          observations: [],
          reviewedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const result = await verifyJudgeRecord(tmp, recordPath, { runTests: true, approve: async () => true });

    expect(result.approved).toBe(false);
    expect(result.reexecuted).toEqual([]);
    expect(result.reasons.join("\n")).toContain("no lockfile");
  });

  it("allows ignored validation output inside the snapshot without touching live files", async () => {
    const command =
      "node -e \"require('fs').mkdirSync('dist',{recursive:true});require('fs').writeFileSync('dist/out.js','ok')\"";
    const { task } = await createReviewFixture({ declares: [command], claims: [] });
    await writeFile(path.join(tmp, ".gitignore"), ".wep/local/\ndist/\n", "utf8");
    const snapshot = await captureJudgeSnapshot(tmp, task.taskId, "HEAD");
    const recordPath = path.join(tmp, ".wep/local/judge/snapshot-review.json");
    await writeFile(
      recordPath,
      `${JSON.stringify(
        {
          schemaVersion: JUDGE_SCHEMA_VERSION,
          taskId: task.taskId,
          scope: snapshot.scope,
          verdict: "APPROVED",
          tests: [{ command, status: "passed" }],
          criteria: await passingCriteria(task.taskId),
          observations: [],
          reviewedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const result = await verifyJudgeRecord(tmp, recordPath, { runTests: true, approve: async () => true });

    expect(result.approved).toBe(true);
    expect(await pathExists(path.join(snapshot.worktreePath, "dist/out.js"))).toBe(false);
    expect(await pathExists(path.join(tmp, "dist/out.js"))).toBe(false);
  });

  it("does not false-positive when an honest review writes ignored output inside the snapshot", async () => {
    const command =
      "node -e \"require('fs').mkdirSync('dist',{recursive:true});require('fs').writeFileSync('dist/out.js','ok')\"";
    const { task } = await createReviewFixture({ declares: [command], claims: [] });
    await writeFile(path.join(tmp, ".gitignore"), ".wep/local/\ndist/\nnode_modules/\n", "utf8");
    await mkdir(path.join(tmp, "node_modules"), { recursive: true });
    const snapshot = await captureJudgeSnapshot(tmp, task.taskId, "HEAD");
    // An honest in-snapshot review writes ignored build output and dependency churn — both at the
    // root, both ignored — and neither moves a covered path's ctime or a tracked ancestor dir's,
    // so a later load must still succeed. (The inode number is excluded from the fingerprint
    // precisely because it would make this nondeterministic on FUSE mounts; see `statOf`.)
    await execFileAsync(
      "node",
      [
        "-e",
        "require('fs').mkdirSync('dist',{recursive:true});require('fs').writeFileSync('dist/out.js','ok');" +
          "require('fs').mkdirSync('node_modules',{recursive:true});require('fs').writeFileSync('node_modules/ran.txt','ok');",
      ],
      {
        cwd: snapshot.worktreePath,
        encoding: "utf8",
      },
    );
    await expect(loadJudgeSnapshot(tmp, snapshot.candidate)).resolves.toBeDefined();
  });

  it("detects a write-then-restore on a manifest-covered file at the next load", async () => {
    const { task } = await createReviewFixture();
    const snapshot = await captureJudgeSnapshot(tmp, task.taskId, "HEAD");
    const file = path.join(snapshot.worktreePath, "app.ts");
    const original = await readFile(file, "utf8");
    await writeFile(file, "export const value = 999;\n", "utf8");
    await writeFile(file, original, "utf8");
    await expect(loadJudgeSnapshot(tmp, snapshot.candidate)).rejects.toThrow("modified after capture");
  });

  it("detects a file created then deleted inside a tracked directory", async () => {
    const { task } = await createReviewFixture();
    const snapshot = await captureJudgeSnapshot(tmp, task.taskId, "HEAD");
    const scratch = path.join(snapshot.worktreePath, task.taskDir, "scratch.tmp");
    await writeFile(scratch, "transient\n", "utf8");
    await rm(scratch, { force: true });
    await expect(loadJudgeSnapshot(tmp, snapshot.candidate)).rejects.toThrow("modified after capture");
  });

  it("leaves no snapshot directory behind when capture fails its own verification", async () => {
    const { task } = await createReviewFixture();
    const policyPath = path.join(tmp, ".wep/policy.json");
    const policy = JSON.parse(await readFile(policyPath, "utf8"));
    policy.blockedReadPatterns.push("policy.json");
    await writeFile(policyPath, `${JSON.stringify(policy, null, 2)}\n`, "utf8");

    await expect(captureJudgeSnapshot(tmp, task.taskId, "HEAD")).rejects.toThrow();

    const remaining = await readdir(path.join(tmp, ".wep/local/judge/snapshots")).catch(() => []);
    expect(remaining).toEqual([]);
  });
});
