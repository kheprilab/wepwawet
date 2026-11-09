import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { runInit } from "../src/init.js";
import {
  JUDGE_SCHEMA_VERSION,
  approveTaskValidationCommands,
  readAcceptanceCriteria,
  validateRecord,
  verifyJudgeRecord,
} from "../src/judge-enforcement.js";
import { readValidationReceipt, runJudgeValidation } from "../src/judge-runner.js";
import { captureJudgeCatchUpSnapshot, captureJudgeSnapshot } from "../src/judge-snapshot.js";
import { runTask } from "../src/task.js";
import { mainInstructionTemplate } from "../src/templates/instructions.js";
import { judgeContractFiles } from "../src/templates/judge-contract.js";
import { claudeJudgeFile, codexJudgeFile, copilotJudgeFile } from "../src/templates/judge.js";

const execFileAsync = promisify(execFile);
let tmp: string;
let outside: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "wep-runner-"));
  outside = await mkdtemp(path.join(os.tmpdir(), "wep-runner-log-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

/** A declared command that records the directory it ran in, one line per execution. */
function loggingCommand(label: string, exitCode = 0): string {
  const log = path.join(outside, "runs.log");
  return `node -e "require('fs').appendFileSync(${JSON.stringify(log).replace(/"/g, "'")}, '${label} ' + process.cwd() + '\\n'); process.exit(${exitCode})"`;
}

async function runLog(): Promise<string[]> {
  const text = await readFile(path.join(outside, "runs.log"), "utf8").catch(() => "");
  return text.split("\n").filter(Boolean);
}

async function createSnapshotFixture(commands: string[], documentation = false) {
  await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
  const task = await runTask("Run declared validation once", { cwd: tmp, nonInteractive: true });
  const taskFile = path.join(tmp, task.taskDir, "task.md");
  const original = await readFile(taskFile, "utf8");
  await writeFile(taskFile, original.replace("```\n```", `\`\`\`\n${commands.join("\n")}\n\`\`\``), "utf8");
  const changedFile = documentation ? "README.md" : "app.ts";
  await writeFile(path.join(tmp, changedFile), documentation ? "# Old usage\n" : "export const value = 1;\n");
  if (documentation) {
    // A documentation receipt must not try to provision dependencies without a lockfile.
    await writeFile(path.join(tmp, "package.json"), '{"dependencies":{"never-install-this-fixture":"1.0.0"}}');
  }
  for (const args of [
    ["init"],
    ["config", "user.email", "tests@example.com"],
    ["config", "user.name", "wep tests"],
    ["add", "."],
    ["commit", "-m", "base"],
  ]) {
    await execFileAsync("git", args, { cwd: tmp });
  }
  await writeFile(path.join(tmp, changedFile), documentation ? "# New usage\n" : "export const value = 2;\n");
  const snapshot = await captureJudgeSnapshot(tmp, task.taskId, "HEAD");
  return { task, snapshot };
}

async function writeReview(
  task: { taskId: string },
  scope: unknown,
  tests: Array<{ command: string; status: string }>,
  extra: Record<string, unknown> = {},
  name = "review.json",
) {
  const criteria = (await readAcceptanceCriteria(tmp, task.taskId)).ids.map((id) => ({
    id,
    status: "pass",
    evidence: "Checked against the changed files.",
  }));
  const recordPath = path.join(tmp, ".wep/local/judge", name);
  await mkdir(path.dirname(recordPath), { recursive: true });
  const record = {
    schemaVersion: JUDGE_SCHEMA_VERSION,
    taskId: task.taskId,
    scope,
    verdict: "APPROVED",
    tests,
    criteria,
    observations: [],
    reviewedAt: new Date().toISOString(),
    ...extra,
  };
  await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return recordPath;
}

/** Writes a receipt variant the way a forger would: valid name, valid digest, altered content. */
async function forgeReceipt(receiptPath: string, change: (receipt: Record<string, unknown>) => void) {
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  change(receipt);
  const bytes = `${JSON.stringify(receipt, null, 2)}\n`;
  const hex = createHash("sha256").update(bytes).digest("hex");
  await writeFile(path.join(path.dirname(receiptPath), `${hex}.json`), bytes, "utf8");
  return `sha256:${hex}`;
}

describe("judge run", () => {
  it("executes every declared command once, in order, only in a disposable copy with isolated", async () => {
    const commands = [loggingCommand("first"), loggingCommand("second")];
    const { task, snapshot } = await createSnapshotFixture(commands);

    const run = await runJudgeValidation(tmp, task.taskId, snapshot.candidate, {
      approve: async () => true,
      isolated: true,
    });

    const lines = await runLog();
    expect(lines.map((line) => line.split(" ")[0])).toEqual(["first", "second"]);
    // Compare real paths: on macOS the temporary directory is reached through a /var symlink.
    const liveRoot = await realpath(tmp);
    const snapshotRoot = await realpath(snapshot.worktreePath);
    for (const line of lines) {
      const ranIn = line.slice(line.indexOf(" ") + 1);
      expect(ranIn.startsWith(liveRoot)).toBe(false);
      expect(ranIn.startsWith(snapshotRoot)).toBe(false);
    }
    expect(run.passed).toBe(true);
    expect(run.receipt.results.map((result) => result.status)).toEqual(["passed", "passed"]);
  });

  it("runs nothing and writes no receipt without approval", async () => {
    const { task, snapshot } = await createSnapshotFixture([loggingCommand("blocked")]);

    await expect(
      runJudgeValidation(tmp, task.taskId, snapshot.candidate, { approve: async () => false }),
    ).rejects.toThrow(/Operator approval was not given/);

    expect(await runLog()).toEqual([]);
    const receipts = await readdir(path.join(path.dirname(snapshot.metadataPath), "receipts")).catch(() => []);
    expect(receipts).toEqual([]);
  });

  it("uses commands pre-approved with task approve-commands without asking", async () => {
    const { task, snapshot } = await createSnapshotFixture([loggingCommand("preapproved")]);
    await approveTaskValidationCommands(tmp, task.taskId, { approve: async () => true });

    const run = await runJudgeValidation(tmp, task.taskId, snapshot.candidate, {
      approve: async () => {
        throw new Error("must not prompt");
      },
    });

    expect(run.passed).toBe(true);
    expect(await runLog()).toHaveLength(1);
  });

  it("writes a digest-named receipt under the snapshot with every binding and no host identity", async () => {
    const failing = loggingCommand("failing", 3);
    const commands = [loggingCommand("passing"), failing];
    const { task, snapshot } = await createSnapshotFixture(commands);

    const run = await runJudgeValidation(tmp, task.taskId, snapshot.candidate, { approve: async () => true });

    const bytes = await readFile(path.join(tmp, run.receiptPath));
    expect(run.receiptDigest).toBe(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);
    expect(run.receiptPath).toBe(
      path.posix.join(
        ".wep/local/judge/snapshots",
        snapshot.id,
        "receipts",
        `${run.receiptDigest.slice("sha256:".length)}.json`,
      ),
    );
    const receipt = JSON.parse(bytes.toString("utf8"));
    expect(receipt).toMatchObject({
      type: "wep-validation-receipt",
      taskId: task.taskId,
      snapshotId: snapshot.id,
      candidate: snapshot.candidate,
      commands,
      lockfileDigest: null,
      drift: [],
    });
    expect(receipt.reviewContentDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(receipt.reviewWorkspaceDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(receipt.results[0]).toMatchObject({ status: "passed", exitCode: 0 });
    expect(receipt.results[1]).toMatchObject({ status: "failed", exitCode: 3 });
    expect(receipt.results[1].evidence).toMatchObject({ status: "failed", exitCode: 3 });
    expect(run.passed).toBe(false);
    const serialized = JSON.stringify(receipt);
    for (const hostField of ["nodeVersion", "platform", "arch", "os"]) {
      expect(serialized).not.toContain(`"${hostField}"`);
    }
  });
});

describe("documentation-only review", () => {
  const reason = "usage prose only; no executable behavior changed";
  const fixture = () => createSnapshotFixture([`no-runtime-validation: ${reason}`], true);

  it.each([false, true])("issues and verifies an explicit zero-runtime receipt (isolated=%s)", async (isolated) => {
    const { task, snapshot } = await fixture();
    const approve = vi.fn(async () => false);
    const onStart = vi.fn();

    const run = await runJudgeValidation(tmp, task.taskId, snapshot.candidate, { isolated, approve, onStart });

    expect(run).toMatchObject({ outcome: "no-runtime-validation", passed: false, exitCode: 0 });
    expect(run.receipt).toMatchObject({ mode: "documentation", noRuntimeReason: reason, commands: [], results: [] });
    expect(approve).not.toHaveBeenCalled();
    expect(onStart).not.toHaveBeenCalled();
    expect(await runLog()).toEqual([]);
    const recordPath = await writeReview(task, snapshot.scope, [], { receiptDigest: run.receiptDigest });
    const verified = await verifyJudgeRecord(tmp, recordPath, { receiptDigest: run.receiptDigest });
    expect(verified.reasons).toEqual([]);
    expect(verified.approved).toBe(true);
    expect(verified.verifiedNow).toMatchObject({ value: "not-applicable-to-runtime", reviewBoundary: "CURRENT" });
    expect(verified.receipt?.mode).toBe("documentation");
  });

  it("rejects fabricated test results even without a pinned receipt", async () => {
    const { task, snapshot } = await fixture();
    const recordPath = await writeReview(task, snapshot.scope, [{ command: "echo invented", status: "passed" }]);

    const verified = await verifyJudgeRecord(tmp, recordPath);

    expect(verified.approved).toBe(false);
    expect(verified.reasons.join("\n")).toMatch(/empty tests/);
  });

  it.each(["reason", "mode"])("rejects a receipt with the wrong documentation %s", async (field) => {
    const { task, snapshot } = await fixture();
    const run = await runJudgeValidation(tmp, task.taskId, snapshot.candidate);
    const digest = await forgeReceipt(path.join(tmp, run.receiptPath), (receipt) => {
      if (field === "reason") receipt.noRuntimeReason = "a different declaration";
      else {
        receipt.mode = "isolated";
        receipt.noRuntimeReason = undefined;
      }
    });
    const recordPath = await writeReview(task, snapshot.scope, [], { receiptDigest: digest });

    const verified = await verifyJudgeRecord(tmp, recordPath, { receiptDigest: digest });

    expect(verified.approved).toBe(false);
    expect(verified.reasons.join("\n")).toMatch(/documentation/);
  });

  it.each([false, true])("supports documentation catch-up (pinned parent=%s)", async (pinned) => {
    const { task, snapshot } = await fixture();
    const run = await runJudgeValidation(tmp, task.taskId, snapshot.candidate);
    const recordPath = await writeReview(task, snapshot.scope, [], { receiptDigest: run.receiptDigest });
    await writeFile(path.join(tmp, "README.md"), "# Revised usage\n");
    const approve = vi.fn(async () => false);

    const next = await captureJudgeCatchUpSnapshot(
      tmp,
      task.taskId,
      path.relative(tmp, recordPath),
      approve,
      false,
      pinned ? { receiptDigest: run.receiptDigest } : {},
    );
    const nextRun = await runJudgeValidation(tmp, task.taskId, next.candidate);
    const nextRecord = await writeReview(task, next.scope, [], { receiptDigest: nextRun.receiptDigest }, "next.json");
    const verified = await verifyJudgeRecord(tmp, nextRecord, { receiptDigest: nextRun.receiptDigest });

    expect(verified.approved).toBe(true);
    expect(approve).not.toHaveBeenCalled();
  });

  it("still rejects a failed criterion with a valid documentation receipt", async () => {
    const { task, snapshot } = await fixture();
    const run = await runJudgeValidation(tmp, task.taskId, snapshot.candidate);
    const ids = (await readAcceptanceCriteria(tmp, task.taskId)).ids;
    const recordPath = await writeReview(task, snapshot.scope, [], {
      receiptDigest: run.receiptDigest,
      criteria: ids.map((id) => ({ id, status: "fail", evidence: "The requested documentation is missing." })),
    });

    expect((await verifyJudgeRecord(tmp, recordPath, { receiptDigest: run.receiptDigest })).approved).toBe(false);
  });
});

describe("judge verify --receipt-digest", () => {
  async function approvedRound(commands = [loggingCommand("suite")]) {
    const { task, snapshot } = await createSnapshotFixture(commands);
    const run = await runJudgeValidation(tmp, task.taskId, snapshot.candidate, { approve: async () => true });
    const recordPath = await writeReview(
      task,
      snapshot.scope,
      run.receipt.results.map((result) => ({ command: result.command, status: result.status })),
      { receiptDigest: run.receiptDigest },
    );
    return { task, snapshot, run, recordPath };
  }

  it("approves from the pinned receipt without running any command", async () => {
    const { run, recordPath } = await approvedRound();
    const before = await runLog();

    const result = await verifyJudgeRecord(tmp, recordPath, { receiptDigest: run.receiptDigest });

    expect(result.reasons).toEqual([]);
    expect(result.approved).toBe(true);
    expect(result.reexecuted).toEqual([]);
    expect(result.receipt?.digest).toBe(run.receiptDigest);
    expect(await runLog()).toEqual(before);
    expect(result.notices.join("\n")).not.toContain("accepted on trust");
  });

  it("rejects a receipt whose bytes no longer match the pinned digest", async () => {
    const { run, recordPath } = await approvedRound();
    const receiptFile = path.join(tmp, run.receiptPath);
    await writeFile(receiptFile, (await readFile(receiptFile, "utf8")).replace('"failed"', '"passed"').concat(" "));

    const result = await verifyJudgeRecord(tmp, recordPath, { receiptDigest: run.receiptDigest });

    expect(result.approved).toBe(false);
    expect(result.reasons.join("\n")).toMatch(/does not match the pinned digest/);
  });

  it.each([
    {
      binding: "snapshot",
      change: (receipt: Record<string, unknown>) => {
        receipt.snapshotId = "0".repeat(20);
      },
    },
    {
      binding: "review digests",
      change: (receipt: Record<string, unknown>) => {
        receipt.reviewContentDigest = `sha256:${"1".repeat(64)}`;
      },
    },
    {
      binding: "command list",
      change: (receipt: Record<string, unknown>) => {
        receipt.commands = ["echo something else"];
      },
    },
    {
      binding: "lockfile digest",
      change: (receipt: Record<string, unknown>) => {
        receipt.lockfileDigest = `sha256:${"2".repeat(64)}`;
      },
    },
  ])("names a broken $binding binding", async ({ binding, change }) => {
    const { task, snapshot, run } = await approvedRound();
    const forged = await forgeReceipt(path.join(tmp, run.receiptPath), change);
    const recordPath = await writeReview(
      task,
      snapshot.scope,
      run.receipt.results.map((result) => ({ command: result.command, status: result.status })),
      { receiptDigest: forged },
      "forged-review.json",
    );

    const result = await verifyJudgeRecord(tmp, recordPath, { receiptDigest: forged });

    expect(result.approved).toBe(false);
    expect(result.reasons.join("\n")).toContain(`receipt ${binding}`);
  });

  it("rejects a passed claim the receipt does not back, naming the command", async () => {
    const failing = loggingCommand("broken", 1);
    const { task, snapshot } = await createSnapshotFixture([failing]);
    const run = await runJudgeValidation(tmp, task.taskId, snapshot.candidate, { approve: async () => true });
    const recordPath = await writeReview(task, snapshot.scope, [{ command: failing, status: "passed" }]);

    const result = await verifyJudgeRecord(tmp, recordPath, { receiptDigest: run.receiptDigest });

    expect(result.approved).toBe(false);
    expect(result.reasons.join("\n")).toContain(`claims \`${failing}\` passed`);
  });

  it("rejects a record whose receiptDigest differs from the pinned digest", async () => {
    const { task, snapshot, run } = await approvedRound();
    const recordPath = await writeReview(
      task,
      snapshot.scope,
      run.receipt.results.map((result) => ({ command: result.command, status: result.status })),
      { receiptDigest: `sha256:${"3".repeat(64)}` },
      "other-receipt-review.json",
    );

    const result = await verifyJudgeRecord(tmp, recordPath, { receiptDigest: run.receiptDigest });

    expect(result.approved).toBe(false);
    expect(result.reasons.join("\n")).toMatch(/receiptDigest .* pinned/);
  });

  it("refuses --receipt-digest together with --run-tests", async () => {
    const { run, recordPath } = await approvedRound();

    const result = await verifyJudgeRecord(tmp, recordPath, {
      receiptDigest: run.receiptDigest,
      runTests: true,
      approve: async () => true,
    });

    expect(result.approved).toBe(false);
    expect(result.reasons.join("\n")).toMatch(/cannot be combined/);
  });

  it("still verifies a record without receiptDigest under --run-tests", async () => {
    const command = loggingCommand("legacy");
    const { task, snapshot } = await createSnapshotFixture([command]);
    const recordPath = await writeReview(task, snapshot.scope, [{ command, status: "passed" }]);

    const result = await verifyJudgeRecord(tmp, recordPath, { runTests: true, approve: async () => true });

    expect(result.approved).toBe(true);
    expect(result.reexecuted).toHaveLength(1);
  });

  it("accepts a well-formed receiptDigest in the record schema and rejects a malformed one", () => {
    const base = {
      schemaVersion: JUDGE_SCHEMA_VERSION,
      taskId: "TASK-001",
      verdict: "APPROVED",
      tests: [],
      criteria: [],
      observations: [],
      reviewedAt: new Date().toISOString(),
    };
    expect(validateRecord({ ...base, receiptDigest: `sha256:${"a".repeat(64)}` })).not.toContain(
      "Unexpected review field: receiptDigest.",
    );
    expect(validateRecord({ ...base, receiptDigest: "abc" })).toContain(
      "receiptDigest must be a sha256 digest when present.",
    );
  });

  it("reads a pinned receipt back only when the digest matches", async () => {
    const { snapshot, run } = await approvedRound();

    await expect(readValidationReceipt(tmp, snapshot.candidate, run.receiptDigest)).resolves.toMatchObject({
      snapshotId: snapshot.id,
    });
    await expect(readValidationReceipt(tmp, snapshot.candidate, `sha256:${"4".repeat(64)}`)).rejects.toThrow(
      /No validation receipt/,
    );
  });
});

describe("catch-up from a receipt", () => {
  it("verifies the parent review from its pinned receipt without re-running", async () => {
    const command = loggingCommand("parent");
    const { task, snapshot } = await createSnapshotFixture([command]);
    const run = await runJudgeValidation(tmp, task.taskId, snapshot.candidate, { approve: async () => true });
    const recordPath = await writeReview(task, snapshot.scope, [{ command, status: "passed" }], {
      receiptDigest: run.receiptDigest,
    });
    await writeFile(path.join(tmp, "app.ts"), "export const value = 3;\n", "utf8");
    const before = await runLog();

    const catchUp = await captureJudgeCatchUpSnapshot(
      tmp,
      task.taskId,
      path.relative(tmp, recordPath),
      async () => {
        throw new Error("must not prompt");
      },
      false,
      { receiptDigest: run.receiptDigest },
    );

    expect(catchUp.parent?.snapshotId).toBe(snapshot.id);
    expect(await runLog()).toEqual(before);
  });
});

describe("CLI", () => {
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

  it("runs once headless, prints the digest, and verifies from it", async () => {
    const command = loggingCommand("cli");
    const { task, snapshot } = await createSnapshotFixture([command]);

    const run = await runCli([
      "judge",
      "run",
      task.taskId,
      "--candidate",
      snapshot.candidate,
      "--json",
      "--approve-commands",
      command,
    ]);
    const report = JSON.parse(run.output);
    expect(report.receiptDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(run.exitCode ?? 0).toBe(0);

    const recordPath = await writeReview(task, snapshot.scope, [{ command, status: "passed" }]);
    const verified = await runCli([
      "judge",
      "verify",
      path.relative(tmp, recordPath),
      "--receipt-digest",
      report.receiptDigest,
      "--json",
    ]);
    expect(JSON.parse(verified.output)).toMatchObject({ approved: true, reexecuted: [] });
    expect(await runLog()).toHaveLength(1);
  });

  it("refuses snapshot --receipt-digest without --from-review instead of ignoring it", async () => {
    const { task } = await createSnapshotFixture([loggingCommand("unused")]);
    await writeFile(path.join(tmp, "app.ts"), "export const value = 4;\n", "utf8");

    await expect(
      runCli(["judge", "snapshot", task.taskId, "--receipt-digest", `sha256:${"5".repeat(64)}`]),
    ).rejects.toThrow(/--receipt-digest only applies with --from-review/);
  });

  it("reports documentation as zero runtime validation, not a passing runtime run", async () => {
    const { task, snapshot } = await createSnapshotFixture(["no-runtime-validation: documentation only"], true);

    const run = await runCli(["judge", "run", task.taskId, "--candidate", snapshot.candidate, "--json"]);
    expect(run.exitCode ?? 0).toBe(0);
    expect(JSON.parse(run.output)).toMatchObject({
      outcome: "no-runtime-validation",
      passed: false,
      mode: "documentation",
      results: [],
      noRuntimeReason: "documentation only",
    });
    const human = await runCli(["judge", "run", task.taskId, "--candidate", snapshot.candidate]);
    expect(human.output).toContain("NO RUNTIME VALIDATION");
    expect(human.output).not.toContain("PASSED");
  });
});

describe("shipped guidance describes one executor", () => {
  const judgeTexts = [claudeJudgeFile(), codexJudgeFile(), copilotJudgeFile()].flatMap((files) => Object.values(files));

  it("tells the judge to read the receipt and never to run validation", () => {
    for (const text of judgeTexts) {
      expect(text).toContain("Execute no validation command yourself");
      expect(text).toContain("receiptDigest");
      expect(text).not.toMatch(/Run the validation the task capsule declares/);
      expect(text).not.toMatch(/run every declared command only in the disposable copy/);
    }
  });

  it("tells the trusted caller to run once, pin the digest and verify from it", () => {
    for (const target of ["claude", "codex", "copilot", "pi"] as const) {
      const text = mainInstructionTemplate(target);
      expect(text).toContain("wep judge run");
      expect(text).toContain("--receipt-digest");
      expect(text).not.toMatch(/The judge runs validation only in a disposable copy/);
    }
    expect(judgeContractFiles[".wep/judge/README.md"]).toContain("## Validation receipt");
    expect(
      JSON.parse(judgeContractFiles[".wep/judge/schemas/review.schema.json"]).properties.receiptDigest,
    ).toBeDefined();
  });
});
