import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { pathExists } from "../src/fs-utils.js";
import {
  JUDGE_SCHEMA_VERSION,
  LEGACY_JUDGE_SCHEMA_VERSION,
  asSchemaVersion,
  createJudgeScope,
  verifyJudgeRecord,
} from "../src/judge-enforcement.js";
import { captureJudgeSnapshot } from "../src/judge-snapshot.js";

import { createApprovableSnapshotFixture, createReviewFixture, passingCriteria } from "./helpers/judge-fixtures.js";
import { execFileAsync, tmp, useTempDir } from "./helpers/wep.js";

useTempDir();

describe("judge", () => {
  it("--run-tests refuses a WORKTREE candidate before approval is ever requested", async () => {
    const command = 'node -e "process.exit(0)"';
    const { recordPath } = await createReviewFixture({ declares: [command], claims: [command] });
    let asked = false;

    const result = await verifyJudgeRecord(tmp, recordPath, {
      runTests: true,
      approve: async () => {
        asked = true;
        return true;
      },
    });

    expect(asked).toBe(false);
    expect(result.reexecuted).toEqual([]);
    expect(result.approved).toBe(false);
    expect(result.reasons).toContain(
      "--run-tests requires a snapshot candidate; capture one with `wep judge snapshot <TASK-ID>` and verify that record.",
    );
  });

  it("--run-tests refuses a bare commit-ref candidate for the same reason", async () => {
    const command = 'node -e "process.exit(0)"';
    const { task } = await createReviewFixture({ declares: [command], claims: [] });
    const head = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: tmp })).stdout.trim();
    const scope = await createJudgeScope(tmp, task.taskId, "HEAD", head);
    const recordPath = path.join(tmp, ".wep/local/judge/commit-review.json");
    await writeFile(
      recordPath,
      `${JSON.stringify(
        {
          schemaVersion: JUDGE_SCHEMA_VERSION,
          taskId: task.taskId,
          scope,
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

    expect(result.reexecuted).toEqual([]);
    expect(result.reasons).toContain(
      "--run-tests requires a snapshot candidate; capture one with `wep judge snapshot <TASK-ID>` and verify that record.",
    );
  });

  it("verification without --run-tests is unchanged on a WORKTREE candidate", async () => {
    const { recordPath } = await createReviewFixture();

    const result = await verifyJudgeRecord(tmp, recordPath);

    expect(result.approved).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("invalidates a review produced by a different wep version", async () => {
    const { recordPath } = await createReviewFixture();
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    record.scope.cliVersion = "0.0.1-ancient";
    await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");

    const result = await verifyJudgeRecord(tmp, recordPath);

    expect(result.approved).toBe(false);
    expect(result.reasons.some((reason: string) => reason.includes("produced by wep v0.0.1-ancient"))).toBe(true);
  });

  it("rejects a review record still using the previous schema version", async () => {
    const { recordPath } = await createReviewFixture();
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    record.schemaVersion = 1;
    await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");

    const result = await verifyJudgeRecord(tmp, recordPath);

    expect(result.valid).toBe(false);
    expect(result.reasons).toContain(`schemaVersion must be ${JUDGE_SCHEMA_VERSION}.`);
  });

  it("rejects a record that still carries the removed issues property", async () => {
    const { recordPath } = await createReviewFixture();
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    record.issues = ["acceptance criterion 3 is not covered by any test"];
    await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");

    const result = await verifyJudgeRecord(tmp, recordPath);

    expect(result.valid).toBe(false);
    expect(result.reasons).toContain("Unexpected review field: issues.");
  });

  it("rejects APPROVED when a declared criterion did not pass", async () => {
    const { recordPath } = await createReviewFixture();
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    record.criteria[1] = { ...record.criteria[1], status: "fail", evidence: "No test covers it." };
    await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");

    const result = await verifyJudgeRecord(tmp, recordPath);

    expect(result.approved).toBe(false);
    expect(result.reasons.join(" ")).toContain("AC-2 (fail)");
  });

  it("rejects a record that reports no result for a declared criterion", async () => {
    const { recordPath } = await createReviewFixture();
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    const dropped = record.criteria.pop();
    await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");

    const result = await verifyJudgeRecord(tmp, recordPath);

    expect(result.approved).toBe(false);
    expect(result.reasons.join(" ")).toContain(dropped.id);
  });

  it("rejects a record that reports a criterion the capsule does not declare", async () => {
    const { recordPath } = await createReviewFixture();
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    record.criteria.push({ id: "AC-99", status: "pass", evidence: "Invented." });
    await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");

    const result = await verifyJudgeRecord(tmp, recordPath);

    expect(result.approved).toBe(false);
    expect(result.reasons.join(" ")).toContain("AC-99");
  });

  it("reports a capsule whose criteria carry no identifier instead of approving it", async () => {
    const { task, recordPath } = await createReviewFixture();
    await writeFile(
      path.join(tmp, task.taskDir, "acceptance-criteria.md"),
      "# Acceptance Criteria\n\n- The outcome is implemented.\n",
      "utf8",
    );

    const result = await verifyJudgeRecord(tmp, recordPath);

    expect(result.approved).toBe(false);
    expect(result.reasons.join(" ")).toContain("AC-<n>");
  });

  it("approves with observations outside the declared criteria", async () => {
    const { recordPath } = await createReviewFixture();
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    record.observations = ["parseRef duplicates logic in resolveRef; outside the declared criteria."];
    await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");

    const result = await verifyJudgeRecord(tmp, recordPath);

    expect(result.reasons).toEqual([]);
    expect(result.approved).toBe(true);
  });

  it("reads a stored version 5 record under the version 5 rules and marks it legacy", async () => {
    const { task, recordPath } = await createReviewFixture();
    const legacyScope = asSchemaVersion(
      await createJudgeScope(tmp, task.taskId, "HEAD", "WORKTREE"),
      LEGACY_JUDGE_SCHEMA_VERSION,
    );
    const legacy = {
      schemaVersion: LEGACY_JUDGE_SCHEMA_VERSION,
      taskId: task.taskId,
      scope: legacyScope,
      verdict: "APPROVED",
      tests: [{ command: "pnpm test", status: "passed" }],
      issues: [],
      reviewedAt: new Date().toISOString(),
    };
    await writeFile(recordPath, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");

    const result = await verifyJudgeRecord(tmp, recordPath);

    expect(result.reasons).toEqual([]);
    expect(result.approved).toBe(true);
    expect(result.legacy).toBe(true);
    expect(result.notices.join(" ")).toContain(`version ${LEGACY_JUDGE_SCHEMA_VERSION}`);
  });

  it("keeps the version 5 approval rules for a legacy record that lists issues", async () => {
    const { task, recordPath } = await createReviewFixture();
    const legacyScope = asSchemaVersion(
      await createJudgeScope(tmp, task.taskId, "HEAD", "WORKTREE"),
      LEGACY_JUDGE_SCHEMA_VERSION,
    );
    const legacy = {
      schemaVersion: LEGACY_JUDGE_SCHEMA_VERSION,
      taskId: task.taskId,
      scope: legacyScope,
      verdict: "APPROVED",
      tests: [{ command: "pnpm test", status: "passed" }],
      issues: ["acceptance criterion 3 is not covered by any test"],
      reviewedAt: new Date().toISOString(),
    };
    await writeFile(recordPath, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");

    const result = await verifyJudgeRecord(tmp, recordPath);

    expect(result.approved).toBe(false);
    expect(result.legacy).toBe(true);
    expect(result.reasons).toContain("APPROVED records must not list unresolved issues.");
  });

  it("emits only the current schema version", async () => {
    const { task } = await createReviewFixture();
    const scope = await createJudgeScope(tmp, task.taskId, "HEAD", "WORKTREE");

    expect(JUDGE_SCHEMA_VERSION).toBe(6);
    expect(scope.schemaVersion).toBe(JUDGE_SCHEMA_VERSION);
  });

  it("applies the approval rules only to APPROVED verdicts", async () => {
    const { recordPath } = await createReviewFixture();
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    record.verdict = "NEEDS_CHANGES";
    record.tests = [];
    record.criteria = record.criteria.map((criterion: { id: string }) => ({
      ...criterion,
      status: "fail",
      evidence: "Not covered.",
    }));
    await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");

    const result = await verifyJudgeRecord(tmp, recordPath);

    expect(result.approved).toBe(false);
    expect(result.reasons).toEqual(["Judge verdict is NEEDS_CHANGES, not APPROVED."]);
  });

  it("CLI judge scope prints a human summary by default and JSON only with --json", async () => {
    const { task, scope } = await createReviewFixture();
    const previousCwd = process.cwd();
    const originalLog = console.log;
    const capture = async (args: string[]) => {
      const writes: string[] = [];
      console.log = (message?: unknown) => {
        writes.push(String(message));
      };
      try {
        process.chdir(tmp);
        await main(["node", "wep", ...args]);
      } finally {
        process.chdir(previousCwd);
        console.log = originalLog;
      }
      return writes.join("\n");
    };

    const human = await capture(["judge", "scope", task.taskId, "--base", "HEAD"]);
    const asJson = await capture(["judge", "scope", task.taskId, "--base", "HEAD", "--json"]);

    expect(human).toContain(scope.scopeDigest);
    expect(human).toContain("app.ts");
    expect(() => JSON.parse(human)).toThrow();
    expect(JSON.parse(asJson)).toEqual(scope);
  });

  it("rejects foreign task capsules in scope and snapshot capture by default", async () => {
    const { task } = await createReviewFixture();
    const foreignPath = path.join(tmp, ".wep/tasks/TASK-999-other-work/task.md");
    await mkdir(path.dirname(foreignPath), { recursive: true });
    await writeFile(foreignPath, "foreign\n", "utf8");

    await expect(createJudgeScope(tmp, task.taskId, "HEAD", "WORKTREE")).rejects.toThrow(
      /TASK-999.*\.wep\/tasks\/TASK-999-other-work\/task\.md.*--include-task TASK-999/,
    );
    await expect(captureJudgeSnapshot(tmp, task.taskId, "HEAD")).rejects.toThrow(/foreign task capsule/);
  });

  it("records explicit foreign task inclusion in the scope digest", async () => {
    const { task } = await createReviewFixture();
    const foreignPath = path.join(tmp, ".wep/tasks/TASK-999-other-work/task.md");
    await mkdir(path.dirname(foreignPath), { recursive: true });
    await writeFile(foreignPath, "foreign\n", "utf8");

    const scope = await createJudgeScope(tmp, task.taskId, "HEAD", "WORKTREE", ["TASK-999"]);

    expect(scope.includedTaskIds).toEqual(["TASK-999"]);
    expect(scope.changedFiles).toContain(".wep/tasks/TASK-999-other-work/task.md");
    expect(scope.scopeDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    await expect(createJudgeScope(tmp, task.taskId, "HEAD", "WORKTREE")).rejects.toThrow(/foreign task capsule/);
  });

  it("reports every foreign task and ignores task-like paths outside capsule names", async () => {
    const { task } = await createReviewFixture();
    for (const directory of ["TASK-998-first", "TASK-999-second", "TASK-001ish"]) {
      const file = path.join(tmp, ".wep/tasks", directory, "task.md");
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, "changed\n", "utf8");
    }

    await expect(createJudgeScope(tmp, task.taskId, "HEAD", "WORKTREE")).rejects.toThrow(
      /TASK-998, TASK-999.*TASK-998-first\/task\.md.*TASK-999-second\/task\.md/,
    );
  });

  it("exposes foreign-capsule rejection and repeated inclusion through the CLI", async () => {
    const { task } = await createReviewFixture();
    for (const id of ["TASK-998", "TASK-999"]) {
      const file = path.join(tmp, `.wep/tasks/${id}-extra/task.md`);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, "changed\n", "utf8");
    }
    const previousCwd = process.cwd();
    const originalLog = console.log;
    const writes: string[] = [];
    console.log = (message?: unknown) => writes.push(String(message));
    try {
      process.chdir(tmp);
      await expect(main(["node", "wep", "judge", "scope", task.taskId, "--base", "HEAD"])).rejects.toThrow(
        /TASK-998, TASK-999.*--include-task TASK-998 --include-task TASK-999/,
      );
      await main([
        "node",
        "wep",
        "judge",
        "scope",
        task.taskId,
        "--base",
        "HEAD",
        "--json",
        "--include-task",
        "TASK-998",
        "--include-task",
        "TASK-999",
      ]);
    } finally {
      process.chdir(previousCwd);
      console.log = originalLog;
    }
    expect(JSON.parse(writes.at(-1) ?? "{}").includedTaskIds).toEqual(["TASK-998", "TASK-999"]);
  });

  it("rejects a review whose inclusion list differs from the immutable snapshot", async () => {
    const { recordPath } = await createApprovableSnapshotFixture(['node -e "process.exit(0)"']);
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    record.scope.includedTaskIds = ["TASK-999"];
    await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");

    const result = await verifyJudgeRecord(tmp, recordPath);

    expect(result.reasons[0]).toMatch(/Cannot recompute review scope: Snapshot .* different --include-task scope/);
  });

  it("validates include-task IDs before returning a snapshot scope", async () => {
    const { task } = await createReviewFixture();
    const snapshot = await captureJudgeSnapshot(tmp, task.taskId, "HEAD");

    await expect(createJudgeScope(tmp, task.taskId, "HEAD", snapshot.candidate, ["NOT-A-TASK"])).rejects.toThrow(
      "Invalid task ID: NOT-A-TASK",
    );
  });

  describe("CLI judge verify --approve-commands", () => {
    const runCli = async (args: string[]) => {
      const previousCwd = process.cwd();
      const originalLog = console.log;
      const originalExitCode = process.exitCode;
      const writes: string[] = [];
      console.log = (message?: unknown) => {
        writes.push(String(message));
      };
      try {
        process.chdir(tmp);
        await main(["node", "wep", ...args]);
      } finally {
        process.chdir(previousCwd);
        console.log = originalLog;
      }
      const exitCode = process.exitCode;
      process.exitCode = originalExitCode;
      return { output: writes.join("\n"), exitCode };
    };

    // stdin is not a TTY under vitest, so these exercise the headless branch as written.
    it.each([
      { boundary: "CURRENT", legacy: false },
      { boundary: "NEWER_CHANGES", legacy: false },
      { boundary: "DIVERGED", legacy: false },
      { boundary: "DIVERGED", legacy: true },
      { boundary: null, legacy: false },
      { boundary: null, legacy: true },
    ])("labels approval separately from $boundary (legacy=$legacy)", async ({ boundary, legacy }) => {
      const command = 'node -e "process.exit(0)"';
      const { recordPath } = boundary
        ? await createApprovableSnapshotFixture([command])
        : await createReviewFixture({ declares: [command], claims: [command] });
      if (legacy) {
        const {
          criteria: _criteria,
          observations: _observations,
          ...record
        } = JSON.parse(await readFile(recordPath, "utf8"));
        await writeFile(
          recordPath,
          JSON.stringify({
            ...record,
            schemaVersion: LEGACY_JUDGE_SCHEMA_VERSION,
            scope: asSchemaVersion(record.scope, LEGACY_JUDGE_SCHEMA_VERSION),
            issues: [],
          }),
          "utf8",
        );
      }
      if (boundary === "NEWER_CHANGES") {
        await writeFile(path.join(tmp, "app.ts"), "export const value = 3;\n", "utf8");
      } else if (boundary === "DIVERGED") {
        await execFileAsync("git", ["checkout", "--orphan", "other-lineage"], { cwd: tmp });
      }

      const expected = await verifyJudgeRecord(tmp, recordPath);
      const { output, exitCode } = await runCli(["judge", "verify", recordPath]);
      const json = await runCli(["judge", "verify", recordPath, "--json"]);

      expect(expected.approved).toBe(true);
      expect(expected.verifiedNow.reviewBoundary).toBe(boundary);
      expect(exitCode).toBeUndefined();
      expect(json.exitCode).toBeUndefined();
      expect(JSON.parse(json.output)).toEqual(expected);
      expect(output.split("\n")[0]).toBe("Judge verification: APPROVED for the reviewed boundary");
      expect(output).not.toContain("APPROVED and current");
      expect(output).toContain(`reviewBoundary    ${boundary ?? "not classified for this boundary type"}`);
      expect(output).toContain(`historicalVerdict APPROVED (${expected.historicalVerdict.independence})`);
      expect(output).toContain(`verifiedNow       ${expected.verifiedNow.value} — ${expected.verifiedNow.reason}`);
      expect(output).toContain("Validation was taken on trust.");
      if (legacy) expect(output).toContain("schema            legacy");
      if (boundary === "DIVERGED") {
        expect(output).toContain("verifiedNow       incomplete");
        expect(output).toContain("reviewBoundary: DIVERGED");
      }
      if (boundary === null) expect(output).not.toContain("reviewBoundary    CURRENT");
    });

    it("refuses headless re-execution and prints the invocation that would approve it", async () => {
      const sentinel = path.join(tmp, "cli-unapproved.txt");
      const command = `node -e "require('fs').writeFileSync(${JSON.stringify(sentinel)}, 'ran')"`;
      const { recordPath } = await createApprovableSnapshotFixture([command]);

      const { output, exitCode } = await runCli(["judge", "verify", path.relative(tmp, recordPath), "--run-tests"]);

      expect(await pathExists(sentinel)).toBe(false);
      expect(exitCode).toBe(1);
      expect(output).toContain(command);
      expect(output).toContain(`--approve-commands ${JSON.stringify(command)}`);
    });

    it("executes when the repeated flags reproduce the declared list, commas included", async () => {
      // A CSV encoding would make this command unapprovable: it contains a comma and there is no
      // defined escape.
      const command = 'node -e "const [a,b] = [0,0]; process.exit(a)"';
      const { recordPath } = await createApprovableSnapshotFixture([command]);

      const { output, exitCode } = await runCli([
        "judge",
        "verify",
        path.relative(tmp, recordPath),
        "--run-tests",
        "--approve-commands",
        command,
      ]);

      expect(exitCode).toBeUndefined();
      expect(output).toContain("APPROVED for the reviewed boundary");
      expect(output).toContain("reviewBoundary    CURRENT");
      expect(output).toContain("re-ran");
    });

    it("refuses a reordered approval and names the first divergence", async () => {
      const first = 'node -e "process.exit(0)"';
      const second = 'node -e "process.exitCode = 0"';
      const { recordPath } = await createApprovableSnapshotFixture([first, second]);

      const { output, exitCode } = await runCli([
        "judge",
        "verify",
        path.relative(tmp, recordPath),
        "--run-tests",
        "--approve-commands",
        second,
        "--approve-commands",
        first,
      ]);

      expect(exitCode).toBe(1);
      expect(output).not.toContain("re-ran");
      expect(output).not.toContain("APPROVED for the reviewed boundary");
      expect(output).toContain(`expected ${JSON.stringify(first)}`);
      expect(output).toContain(`got ${JSON.stringify(second)}`);
    });

    it("refuses an approval that omits one declared command", async () => {
      const first = 'node -e "process.exit(0)"';
      const second = 'node -e "process.exitCode = 0"';
      const { recordPath } = await createApprovableSnapshotFixture([first, second]);

      const { output, exitCode } = await runCli([
        "judge",
        "verify",
        path.relative(tmp, recordPath),
        "--run-tests",
        "--approve-commands",
        first,
      ]);

      expect(exitCode).toBe(1);
      expect(output).not.toContain("APPROVED for the reviewed boundary");
    });

    it("ignores --approve-commands when --run-tests is not set", async () => {
      const command = 'node -e "process.exit(0)"';
      const { recordPath } = await createApprovableSnapshotFixture([command]);

      const withFlag = await runCli([
        "judge",
        "verify",
        path.relative(tmp, recordPath),
        "--approve-commands",
        "something else entirely",
      ]);
      const without = await runCli(["judge", "verify", path.relative(tmp, recordPath)]);

      expect(withFlag.output).toBe(without.output);
      expect(withFlag.exitCode).toBe(without.exitCode);
    });
  });
});
