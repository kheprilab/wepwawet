import { mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import type { ContinuationRecord } from "../src/continuation.js";
import { pathExists } from "../src/fs-utils.js";
import { JUDGE_SCHEMA_VERSION } from "../src/judge-enforcement.js";
import {
  captureJudgeCatchUpSnapshot,
  captureJudgeSnapshot,
  checkJudgeReviewCurrentState,
  checkJudgeSnapshotCurrentState,
  loadJudgeSnapshot,
  pruneJudgeSnapshots,
} from "../src/judge-snapshot.js";

import {
  createReviewFixture,
  passingCriteria,
  validContinuationRecord,
  writeContinuationSidecar,
} from "./helpers/judge-fixtures.js";
import { execFileAsync, tmp, useTempDir } from "./helpers/wep.js";

useTempDir();

describe("judge", () => {
  it("detects a manifest-covered file deleted then recreated with identical bytes", async () => {
    const { task } = await createReviewFixture();
    const snapshot = await captureJudgeSnapshot(tmp, task.taskId, "HEAD");
    const file = path.join(snapshot.worktreePath, "app.ts");
    const original = await readFile(file, "utf8");
    await rm(file, { force: true });
    await writeFile(file, original, "utf8");
    await expect(loadJudgeSnapshot(tmp, snapshot.candidate)).rejects.toThrow("modified after capture");
  });

  it("refuses to load a snapshot captured before write detection", async () => {
    const { task } = await createReviewFixture();
    const snapshot = await captureJudgeSnapshot(tmp, task.taskId, "HEAD");
    const metadata = JSON.parse(await readFile(snapshot.metadataPath, "utf8"));
    metadata.version = 1;
    await writeFile(snapshot.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    await expect(loadJudgeSnapshot(tmp, snapshot.candidate)).rejects.toThrow("predates write detection");
  });

  it("refuses to load a snapshot captured with the previous inode-based fingerprint", async () => {
    // The fingerprint once included the inode number, which drifts on FUSE/network mounts and made
    // an honest snapshot permanently unreviewable. That field is gone and `SNAPSHOT_VERSION` moved;
    // a snapshot claiming the old version is refused, never silently accepted as if it carried the
    // current guarantee.
    const { task } = await createReviewFixture();
    const snapshot = await captureJudgeSnapshot(tmp, task.taskId, "HEAD");
    const metadata = JSON.parse(await readFile(snapshot.metadataPath, "utf8"));
    metadata.version = 2;
    await writeFile(snapshot.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    await expect(loadJudgeSnapshot(tmp, snapshot.candidate)).rejects.toThrow("predates write detection");
  });

  it("fails legacy snapshots without canonical base metadata with an explicit diagnostic", async () => {
    const { task } = await createReviewFixture();
    const snapshot = await captureJudgeSnapshot(tmp, task.taskId, "HEAD");
    const metadata = JSON.parse(await readFile(snapshot.metadataPath, "utf8"));
    metadata.version = 4;
    await writeFile(snapshot.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

    await expect(loadJudgeSnapshot(tmp, snapshot.candidate)).rejects.toThrow(
      "predates write detection and canonical Git base refs (legacy format)",
    );
  });

  it("distinguishes v5 snapshots from older legacy contracts", async () => {
    const { task } = await createReviewFixture();
    const snapshot = await captureJudgeSnapshot(tmp, task.taskId, "HEAD");
    const metadata = JSON.parse(await readFile(snapshot.metadataPath, "utf8"));
    metadata.version = 5;
    await writeFile(snapshot.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

    const error = await loadJudgeSnapshot(tmp, snapshot.candidate).catch((value: unknown) => value as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("predates the empty-boundary authorization contract");
    expect((error as Error).message).not.toContain("canonical Git base refs");
  });

  it("computes reviewContentDigest without ctime and reviewWorkspaceDigest with it, across two captures of the same content", async () => {
    const { task } = await createReviewFixture();
    const first = await captureJudgeSnapshot(tmp, task.taskId, "HEAD");
    const firstMetadata = JSON.parse(await readFile(first.metadataPath, "utf8"));
    await rm(path.join(tmp, ".wep/local/judge/snapshots", first.id), { recursive: true, force: true });
    const second = await captureJudgeSnapshot(tmp, task.taskId, "HEAD");
    const secondMetadata = JSON.parse(await readFile(second.metadataPath, "utf8"));

    expect(second.id).toBe(first.id);
    expect(secondMetadata.contentDigest).toBe(firstMetadata.contentDigest);
    expect(secondMetadata.reviewContentDigest).toBe(firstMetadata.reviewContentDigest);
    expect(secondMetadata.workspaceDigest).not.toBe(firstMetadata.workspaceDigest);
    expect(secondMetadata.reviewWorkspaceDigest).not.toBe(firstMetadata.reviewWorkspaceDigest);
  });

  it("excludes a valid continuation sidecar from reviewContentDigest but not from contentDigest", async () => {
    const { task } = await createReviewFixture();
    await writeContinuationSidecar(task, `${JSON.stringify(validContinuationRecord(task), null, 2)}\n`);
    const withSidecar = await captureJudgeSnapshot(tmp, task.taskId, "HEAD");
    const withSidecarMetadata = JSON.parse(await readFile(withSidecar.metadataPath, "utf8"));

    expect(withSidecarMetadata.reviewContentDigest).not.toBe(withSidecarMetadata.contentDigest);

    await rm(path.join(tmp, task.taskDir, "continuation.json"), { force: true });
    const bare = await captureJudgeSnapshot(tmp, task.taskId, "HEAD");
    const bareMetadata = JSON.parse(await readFile(bare.metadataPath, "utf8"));

    // Same app content, no sidecar: the review manifest and the full manifest are identical.
    expect(bareMetadata.reviewContentDigest).toBe(bareMetadata.contentDigest);
    // Excluding the valid sidecar makes the review identity of the two captures agree even though
    // one carried an extra tracked file.
    expect(withSidecarMetadata.reviewContentDigest).toBe(bareMetadata.reviewContentDigest);
  });

  it("keeps reviewWorkspaceDigest distinct from workspaceDigest when a valid sidecar is present", async () => {
    const { task } = await createReviewFixture();
    await writeContinuationSidecar(task, `${JSON.stringify(validContinuationRecord(task), null, 2)}\n`);
    const snapshot = await captureJudgeSnapshot(tmp, task.taskId, "HEAD");
    const metadata = JSON.parse(await readFile(snapshot.metadataPath, "utf8"));

    expect(metadata.reviewWorkspaceDigest).not.toBe(metadata.workspaceDigest);
  });

  it("keeps reviewContentDigest stable when only a valid sidecar's body changes", async () => {
    const { task } = await createReviewFixture();
    const recordA = validContinuationRecord(task);
    await writeContinuationSidecar(task, `${JSON.stringify(recordA, null, 2)}\n`);
    const snapshotA = await captureJudgeSnapshot(tmp, task.taskId, "HEAD");
    const metadataA = JSON.parse(await readFile(snapshotA.metadataPath, "utf8"));

    const recordB: ContinuationRecord = {
      ...recordA,
      task: { ...recordA.task, capsuleDigest: `sha256:${"b".repeat(64)}` },
    };
    await writeContinuationSidecar(task, `${JSON.stringify(recordB, null, 2)}\n`);
    const snapshotB = await captureJudgeSnapshot(tmp, task.taskId, "HEAD");
    const metadataB = JSON.parse(await readFile(snapshotB.metadataPath, "utf8"));

    expect(metadataA.contentDigest).not.toBe(metadataB.contentDigest);
    expect(metadataA.reviewContentDigest).toBe(metadataB.reviewContentDigest);
  });

  it("keeps an invalid continuation sidecar inside reviewContentDigest", async () => {
    const { task } = await createReviewFixture();
    await writeContinuationSidecar(task, "not json\n");
    const snapshot = await captureJudgeSnapshot(tmp, task.taskId, "HEAD");
    const metadata = JSON.parse(await readFile(snapshot.metadataPath, "utf8"));

    expect(metadata.reviewContentDigest).toBe(metadata.contentDigest);
  });

  it("keeps an unsupported-schema continuation sidecar inside reviewContentDigest", async () => {
    const { task } = await createReviewFixture();
    const record = { ...validContinuationRecord(task), schemaVersion: 2 };
    await writeContinuationSidecar(task, `${JSON.stringify(record, null, 2)}\n`);
    const snapshot = await captureJudgeSnapshot(tmp, task.taskId, "HEAD");
    const metadata = JSON.parse(await readFile(snapshot.metadataPath, "utf8"));

    expect(metadata.reviewContentDigest).toBe(metadata.contentDigest);
  });

  it("keeps an irregular continuation sidecar (symlink) inside reviewContentDigest", async () => {
    const { task } = await createReviewFixture();
    await writeFile(path.join(tmp, task.taskDir, "elsewhere.json"), "{}\n", "utf8");
    await symlink("elsewhere.json", path.join(tmp, task.taskDir, "continuation.json"));
    const snapshot = await captureJudgeSnapshot(tmp, task.taskId, "HEAD");
    const metadata = JSON.parse(await readFile(snapshot.metadataPath, "utf8"));

    expect(metadata.reviewContentDigest).toBe(metadata.contentDigest);
  });

  it("fails integrity when the immutable capture's sidecar is altered after capture", async () => {
    const { task } = await createReviewFixture();
    await writeContinuationSidecar(task, `${JSON.stringify(validContinuationRecord(task), null, 2)}\n`);
    const snapshot = await captureJudgeSnapshot(tmp, task.taskId, "HEAD");
    const sidecar = path.join(snapshot.worktreePath, task.taskDir, "continuation.json");
    const tampered: ContinuationRecord = {
      ...validContinuationRecord(task),
      task: { ...validContinuationRecord(task).task, capsuleDigest: `sha256:${"c".repeat(64)}` },
    };
    await writeFile(sidecar, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");
    await expect(loadJudgeSnapshot(tmp, snapshot.candidate)).rejects.toThrow("Snapshot integrity check failed");
  });

  it("refuses to load a snapshot captured before the review content identity contract", async () => {
    const { task } = await createReviewFixture();
    const snapshot = await captureJudgeSnapshot(tmp, task.taskId, "HEAD");
    const metadata = JSON.parse(await readFile(snapshot.metadataPath, "utf8"));
    metadata.version = 6;
    await writeFile(snapshot.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

    const error = await loadJudgeSnapshot(tmp, snapshot.candidate).catch((value: unknown) => value as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("predates the review content identity contract");
  });

  it("loads deterministically: repeated loads of the same snapshot all succeed", async () => {
    // Guards against any per-call nondeterministic field in the fingerprint (a random, a clock,
    // or an inode number re-read on every load). The inode number was removed for exactly this
    // reason — it is synthesized by FUSE daemons and drifts over time — so a snapshot must load
    // the same way every time it is read.
    const { task } = await createReviewFixture();
    const snapshot = await captureJudgeSnapshot(tmp, task.taskId, "HEAD");
    for (let i = 0; i < 5; i += 1) {
      await expect(loadJudgeSnapshot(tmp, snapshot.candidate)).resolves.toBeDefined();
    }
  });

  it("reports snapshot currency separately from historical approval validity", async () => {
    const { task } = await createReviewFixture();
    const snapshot = await captureJudgeSnapshot(tmp, task.taskId, "HEAD");

    expect((await checkJudgeSnapshotCurrentState(tmp, snapshot.candidate)).status).toBe("CURRENT");
    await writeFile(path.join(tmp, "app.ts"), "export const value = 3;\n", "utf8");
    const newer = await checkJudgeSnapshotCurrentState(tmp, snapshot.candidate);
    expect(newer.status).toBe("NEWER_CHANGES");
    expect(newer.changedFiles).toContain("app.ts");

    await execFileAsync("git", ["checkout", "--orphan", "other-lineage"], { cwd: tmp });
    expect((await checkJudgeSnapshotCurrentState(tmp, snapshot.candidate)).status).toBe("DIVERGED");
  });

  it("keeps reviewBoundary CURRENT when a continuation sidecar is created live, and reports it CREATED", async () => {
    const { task } = await createReviewFixture();
    const snapshot = await captureJudgeSnapshot(tmp, task.taskId, "HEAD");

    await writeContinuationSidecar(task, `${JSON.stringify(validContinuationRecord(task), null, 2)}\n`);
    const state = await checkJudgeSnapshotCurrentState(tmp, snapshot.candidate);

    expect(state.reviewBoundary).toBe("CURRENT");
    expect(state.executionMetadata).toBe("CREATED");
  });

  it("keeps reviewBoundary CURRENT when a captured continuation sidecar is deleted live, and reports it REMOVED", async () => {
    const { task } = await createReviewFixture();
    await writeContinuationSidecar(task, `${JSON.stringify(validContinuationRecord(task), null, 2)}\n`);
    const snapshot = await captureJudgeSnapshot(tmp, task.taskId, "HEAD");

    await rm(path.join(tmp, task.taskDir, "continuation.json"), { force: true });
    const state = await checkJudgeSnapshotCurrentState(tmp, snapshot.candidate);

    expect(state.reviewBoundary).toBe("CURRENT");
    expect(state.executionMetadata).toBe("REMOVED");
  });

  it("keeps reviewBoundary CURRENT when a continuation sidecar is edited live, and reports it ADVANCED", async () => {
    const { task } = await createReviewFixture();
    await writeContinuationSidecar(task, `${JSON.stringify(validContinuationRecord(task), null, 2)}\n`);
    const snapshot = await captureJudgeSnapshot(tmp, task.taskId, "HEAD");

    const advanced: ContinuationRecord = {
      ...validContinuationRecord(task),
      task: { ...validContinuationRecord(task).task, capsuleDigest: `sha256:${"d".repeat(64)}` },
    };
    await writeContinuationSidecar(task, `${JSON.stringify(advanced, null, 2)}\n`);
    const state = await checkJudgeSnapshotCurrentState(tmp, snapshot.candidate);

    expect(state.reviewBoundary).toBe("CURRENT");
    expect(state.executionMetadata).toBe("ADVANCED");
  });

  it("reports ADVANCED for a continuation sidecar replaced with rename, not CREATED plus REMOVED", async () => {
    const { task } = await createReviewFixture();
    await writeContinuationSidecar(task, `${JSON.stringify(validContinuationRecord(task), null, 2)}\n`);
    const snapshot = await captureJudgeSnapshot(tmp, task.taskId, "HEAD");

    const replacement: ContinuationRecord = {
      ...validContinuationRecord(task),
      task: { ...validContinuationRecord(task).task, capsuleDigest: `sha256:${"e".repeat(64)}` },
    };
    const staged = path.join(tmp, task.taskDir, "continuation.json.next");
    await writeFile(staged, `${JSON.stringify(replacement, null, 2)}\n`, "utf8");
    await rename(staged, path.join(tmp, task.taskDir, "continuation.json"));

    const state = await checkJudgeSnapshotCurrentState(tmp, snapshot.candidate);

    expect(state.reviewBoundary).toBe("CURRENT");
    expect(state.executionMetadata).toBe("ADVANCED");
  });

  it("does not exclude an irregular continuation sidecar; editing it moves reviewBoundary off CURRENT", async () => {
    const { task } = await createReviewFixture();
    await writeFile(path.join(tmp, task.taskDir, "elsewhere.json"), "{}\n", "utf8");
    await symlink("elsewhere.json", path.join(tmp, task.taskDir, "continuation.json"));
    const snapshot = await captureJudgeSnapshot(tmp, task.taskId, "HEAD");

    await writeFile(path.join(tmp, task.taskDir, "elsewhere.json"), '{"changed":true}\n', "utf8");
    const state = await checkJudgeSnapshotCurrentState(tmp, snapshot.candidate);

    expect(state.reviewBoundary).not.toBe("CURRENT");
  });

  it("moves reviewBoundary off CURRENT when real code changes accompany a sidecar change", async () => {
    const { task } = await createReviewFixture();
    const snapshot = await captureJudgeSnapshot(tmp, task.taskId, "HEAD");

    await writeContinuationSidecar(task, `${JSON.stringify(validContinuationRecord(task), null, 2)}\n`);
    await writeFile(path.join(tmp, "app.ts"), "export const value = 3;\n", "utf8");
    const state = await checkJudgeSnapshotCurrentState(tmp, snapshot.candidate);

    expect(["NEWER_CHANGES", "DIVERGED"]).toContain(state.reviewBoundary);
  });

  it("rejects current-state claims from non-approved snapshot records", async () => {
    const { task } = await createReviewFixture();
    const snapshot = await captureJudgeSnapshot(tmp, task.taskId, "HEAD");
    const recordPath = path.join(tmp, ".wep/local/judge/rejected-review.json");
    await writeFile(
      recordPath,
      `${JSON.stringify(
        {
          schemaVersion: JUDGE_SCHEMA_VERSION,
          taskId: task.taskId,
          scope: snapshot.scope,
          verdict: "NEEDS_CHANGES",
          tests: [{ command: "pnpm test", status: "passed" }],
          criteria: (await passingCriteria(task.taskId)).map((criterion) => ({ ...criterion, status: "fail" })),
          observations: ["not approved"],
          reviewedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await expect(checkJudgeReviewCurrentState(tmp, recordPath)).rejects.toThrow("valid APPROVED");
  });

  it("captures a catch-up delta linked to a strongly verified approved snapshot", async () => {
    const command = 'node -e "process.exit(0)"';
    const { task } = await createReviewFixture({ declares: [command], claims: [] });
    const parent = await captureJudgeSnapshot(tmp, task.taskId, "HEAD");
    const parentRecordPath = path.join(tmp, ".wep/local/judge/parent-review.json");
    await writeFile(
      parentRecordPath,
      `${JSON.stringify(
        {
          schemaVersion: JUDGE_SCHEMA_VERSION,
          taskId: task.taskId,
          scope: parent.scope,
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
    await writeFile(path.join(tmp, "new.ts"), "export const added = true;\n", "utf8");

    const catchUp = await captureJudgeCatchUpSnapshot(tmp, task.taskId, parentRecordPath, async () => true);
    const loaded = await loadJudgeSnapshot(tmp, catchUp.candidate);

    expect(catchUp.scope.base).toBe(parent.scope.base);
    expect(catchUp.scope.changedFiles).toEqual(["app.ts", "new.ts"]);
    expect(loaded.metadata.parent?.scopeDigest).toBe(parent.scope.scopeDigest);
    expect(loaded.metadata.parent?.recordDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("preserves explicit foreign task inclusion across catch-up snapshots", async () => {
    const command = 'node -e "process.exit(0)"';
    const { task } = await createReviewFixture({ declares: [command], claims: [] });
    const foreignPath = path.join(tmp, ".wep/tasks/TASK-999-other-work/task.md");
    await mkdir(path.dirname(foreignPath), { recursive: true });
    await writeFile(foreignPath, "foreign\n", "utf8");
    const parent = await captureJudgeSnapshot(tmp, task.taskId, "HEAD", ["TASK-999"]);
    const parentRecordPath = path.join(tmp, ".wep/local/judge/inclusive-parent-review.json");
    await writeFile(
      parentRecordPath,
      `${JSON.stringify(
        {
          schemaVersion: JUDGE_SCHEMA_VERSION,
          taskId: task.taskId,
          scope: parent.scope,
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

    const catchUp = await captureJudgeCatchUpSnapshot(tmp, task.taskId, parentRecordPath, async () => true);

    expect(catchUp.scope.includedTaskIds).toEqual(["TASK-999"]);
    expect(catchUp.scope.base).toBe(parent.scope.base);
  });

  it("rejects catch-up when the parent passing claim fails independent re-execution", async () => {
    const command = 'node -e "process.exit(1)"';
    const { task } = await createReviewFixture({ declares: [command], claims: [] });
    const parent = await captureJudgeSnapshot(tmp, task.taskId, "HEAD");
    const parentRecordPath = path.join(tmp, ".wep/local/judge/false-parent-review.json");
    await writeFile(
      parentRecordPath,
      `${JSON.stringify(
        {
          schemaVersion: JUDGE_SCHEMA_VERSION,
          taskId: task.taskId,
          scope: parent.scope,
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

    await expect(captureJudgeCatchUpSnapshot(tmp, task.taskId, parentRecordPath, async () => true)).rejects.toThrow(
      "Independent re-run",
    );
  });

  it("invalidates a catch-up snapshot when an ancestor snapshot is removed", async () => {
    const command = 'node -e "process.exit(0)"';
    const { task } = await createReviewFixture({ declares: [command], claims: [] });
    const parent = await captureJudgeSnapshot(tmp, task.taskId, "HEAD");
    const parentRecordPath = path.join(tmp, ".wep/local/judge/ancestor-review.json");
    await writeFile(
      parentRecordPath,
      `${JSON.stringify(
        {
          schemaVersion: JUDGE_SCHEMA_VERSION,
          taskId: task.taskId,
          scope: parent.scope,
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
    const child = await captureJudgeCatchUpSnapshot(tmp, task.taskId, parentRecordPath, async () => true);
    await rm(parent.worktreePath, { recursive: true, force: true });

    await expect(loadJudgeSnapshot(tmp, child.candidate)).rejects.toThrow("parent snapshot");
  });

  it("prunes old snapshots explicitly and is dry-run by default", async () => {
    const { task } = await createReviewFixture();
    const first = await captureJudgeSnapshot(tmp, task.taskId, "HEAD");
    await writeFile(path.join(tmp, "app.ts"), "export const value = 3;\n", "utf8");
    const second = await captureJudgeSnapshot(tmp, task.taskId, "HEAD");

    const preview = await pruneJudgeSnapshots(tmp, { keep: 1 });
    expect(preview.dryRun).toBe(true);
    expect(preview.removed).toHaveLength(1);
    expect(await pathExists(path.dirname(first.metadataPath))).toBe(true);
    expect(await pathExists(path.dirname(second.metadataPath))).toBe(true);

    const applied = await pruneJudgeSnapshots(tmp, { keep: 1, dryRun: false });
    expect(applied.removed).toHaveLength(1);
    expect(applied.kept).toHaveLength(1);
    expect(
      Number(await pathExists(path.dirname(first.metadataPath))) +
        Number(await pathExists(path.dirname(second.metadataPath))),
    ).toBe(1);
  });

  it("rejects catch-up from non-approved or boundary-invalid parent records", async () => {
    const { task } = await createReviewFixture();
    const parent = await captureJudgeSnapshot(tmp, task.taskId, "HEAD");
    const parentRecordPath = path.join(tmp, ".wep/local/judge/parent-review.json");
    const record = {
      schemaVersion: JUDGE_SCHEMA_VERSION,
      taskId: task.taskId,
      scope: parent.scope,
      verdict: "NEEDS_CHANGES",
      tests: [{ command: "pnpm test", status: "passed" }],
      criteria: (await passingCriteria(task.taskId)).map((criterion) => ({ ...criterion, status: "fail" })),
      observations: ["still needs work"],
      reviewedAt: new Date().toISOString(),
    };
    await writeFile(parentRecordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    await expect(captureJudgeCatchUpSnapshot(tmp, task.taskId, parentRecordPath)).rejects.toThrow("APPROVED");

    await writeFile(
      parentRecordPath,
      `${JSON.stringify(
        {
          ...record,
          verdict: "APPROVED",
          criteria: await passingCriteria(task.taskId),
          observations: [],
          scope: { ...parent.scope, changeDigest: "sha256:invalid" },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await expect(captureJudgeCatchUpSnapshot(tmp, task.taskId, parentRecordPath, async () => true)).rejects.toThrow(
      "verified current",
    );
  });

  it("CLI judge snapshot keeps human output short and exposes full JSON on demand", async () => {
    const { task } = await createReviewFixture();
    const previousCwd = process.cwd();
    const originalLog = console.log;
    const capture = async (args: string[]) => {
      const writes: string[] = [];
      console.log = (message?: unknown) => writes.push(String(message));
      try {
        process.chdir(tmp);
        await main(["node", "wep", ...args]);
      } finally {
        process.chdir(previousCwd);
        console.log = originalLog;
      }
      return writes.join("\n");
    };

    const human = await capture(["judge", "snapshot", task.taskId]);
    const json = JSON.parse(await capture(["judge", "snapshot", task.taskId, "--json"]));

    expect(human).toContain("You can keep working");
    expect(human).toContain("SNAPSHOT:");
    expect(human).toContain("<review.json>");
    expect(human).not.toContain("scopeDigest");
    expect(json.candidate).toMatch(/^SNAPSHOT:[0-9a-f]{20}$/);
    expect(json.scope.scopeDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(json.emptyBoundaryAuthorized).toBe(false);
    expect(json.worktreePath).toContain(".wep/local/judge/snapshots/");

    const recordPath = path.join(tmp, ".wep/local/judge/cli-review.json");
    await writeFile(
      recordPath,
      `${JSON.stringify(
        {
          schemaVersion: JUDGE_SCHEMA_VERSION,
          taskId: task.taskId,
          scope: json.scope,
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
    const currentHuman = await capture(["judge", "current", recordPath]);
    expect(currentHuman).toContain("CURRENT");
    expect(currentHuman).toContain("reviewBoundary");
    expect(currentHuman).toContain("executionMetadata");
    await writeFile(path.join(tmp, "app.ts"), "export const value = 3;\n", "utf8");
    const currentJson = JSON.parse(await capture(["judge", "current", recordPath, "--json"]));
    expect(currentJson.status).toBe("NEWER_CHANGES");
    expect(currentJson.changedFiles).toContain("app.ts");
    expect(currentJson.reviewBoundary).toBe("NEWER_CHANGES");
    expect(currentJson.executionMetadata).toBe("ABSENT");

    await capture(["judge", "snapshot", task.taskId]);
    const prunePreview = JSON.parse(await capture(["judge", "prune", "--keep", "1", "--json"]));
    expect(prunePreview.dryRun).toBe(true);
    expect(prunePreview.removed).toHaveLength(1);
    const pruneApplied = JSON.parse(await capture(["judge", "prune", "--keep", "1", "--force", "--json"]));
    expect(pruneApplied.dryRun).toBe(false);
    expect(pruneApplied.removed).toHaveLength(1);
  });

  it("CLI judge snapshot makes --allow-empty visible in human and JSON output", async () => {
    const { task } = await createReviewFixture();
    await execFileAsync("git", ["add", "."], { cwd: tmp });
    await execFileAsync("git", ["commit", "-m", "implementation"], { cwd: tmp });
    const previousCwd = process.cwd();
    const originalLog = console.log;
    const capture = async (args: string[]) => {
      const writes: string[] = [];
      console.log = (message?: unknown) => writes.push(String(message));
      try {
        process.chdir(tmp);
        await main(["node", "wep", ...args]);
      } finally {
        process.chdir(previousCwd);
        console.log = originalLog;
      }
      return writes.join("\n");
    };

    const human = await capture(["judge", "snapshot", task.taskId, "--allow-empty"]);
    const json = JSON.parse(await capture(["judge", "snapshot", task.taskId, "--allow-empty", "--json"]));
    expect(human).toContain("authorized by --allow-empty");
    expect(human).toContain("SNAPSHOT:");
    expect(json.emptyBoundaryAuthorized).toBe(true);
    expect(json.scope.emptyBoundaryAuthorized).toBe(true);
  });
});
