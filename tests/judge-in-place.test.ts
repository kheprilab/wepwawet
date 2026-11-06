import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { pathExists } from "../src/fs-utils.js";
import { runGuard } from "../src/hook/guard.js";
import { runTraceEnable } from "../src/hook/install.js";
import { runInit } from "../src/init.js";
import { JUDGE_SCHEMA_VERSION, readAcceptanceCriteria, verifyJudgeRecord } from "../src/judge-enforcement.js";
import { RUN_LOCK_PATH } from "../src/judge-run-lock.js";
import { JudgeRunRefusal, runJudgeValidation } from "../src/judge-runner.js";
import { captureJudgeSnapshot } from "../src/judge-snapshot.js";
import { withJudgeTimings } from "../src/judge-timings.js";
import { runJudgeDisable, runJudgeEnable } from "../src/judge.js";
import { runStatus } from "../src/status.js";
import { runTask } from "../src/task.js";
import { runUpgrade } from "../src/upgrade.js";

const execFileAsync = promisify(execFile);
let tmp: string;
let outside: string;

beforeEach(async () => {
  tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), "wep-inplace-")));
  outside = await mkdtemp(path.join(os.tmpdir(), "wep-inplace-log-"));
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

async function createSnapshotFixture(commands: string[], target: "codex" | "claude" = "codex") {
  await runInit({ cwd: tmp, target, nonInteractive: true });
  const task = await runTask("Run validation in place", { cwd: tmp, nonInteractive: true });
  const taskFile = path.join(tmp, task.taskDir, "task.md");
  const original = await readFile(taskFile, "utf8");
  await writeFile(taskFile, original.replace("```\n```", `\`\`\`\n${commands.join("\n")}\n\`\`\``), "utf8");
  const gitignore = await readFile(path.join(tmp, ".gitignore"), "utf8").catch(() => "");
  await writeFile(path.join(tmp, ".gitignore"), `${gitignore}dist/\n`, "utf8");
  await writeFile(path.join(tmp, "app.ts"), "export const value = 1;\n", "utf8");
  for (const args of [
    ["init"],
    ["config", "user.email", "tests@example.com"],
    ["config", "user.name", "wep tests"],
    ["add", "."],
    ["commit", "-m", "base"],
  ]) {
    await execFileAsync("git", args, { cwd: tmp });
  }
  await writeFile(path.join(tmp, "app.ts"), "export const value = 2;\n", "utf8");
  const snapshot = await captureJudgeSnapshot(tmp, task.taskId, "HEAD");
  return { task, snapshot };
}

async function writeLock(lock: Record<string, unknown>) {
  const file = path.join(tmp, RUN_LOCK_PATH);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(lock)}\n`, "utf8");
}

async function writeReview(
  task: { taskId: string },
  scope: unknown,
  tests: Array<{ command: string; status: string }>,
) {
  const criteria = (await readAcceptanceCriteria(tmp, task.taskId)).ids.map((id) => ({
    id,
    status: "pass",
    evidence: "Checked against the changed files.",
  }));
  const recordPath = path.join(tmp, ".wep/local/judge/review.json");
  await mkdir(path.dirname(recordPath), { recursive: true });
  await writeFile(
    recordPath,
    `${JSON.stringify({
      schemaVersion: JUDGE_SCHEMA_VERSION,
      taskId: task.taskId,
      scope,
      verdict: "APPROVED",
      tests,
      criteria,
      observations: [],
      reviewedAt: new Date().toISOString(),
    })}\n`,
    "utf8",
  );
  return recordPath;
}

const approve = async () => true;

describe("in-place judge run", () => {
  it("runs every declared command once in the live project root and records the mode", async () => {
    const { task, snapshot } = await createSnapshotFixture([loggingCommand("first"), loggingCommand("second")]);

    const run = await runJudgeValidation(tmp, task.taskId, snapshot.candidate, { approve });

    const lines = await runLog();
    expect(lines).toEqual([`first ${tmp}`, `second ${tmp}`]);
    expect(run.outcome).toBe("passed");
    expect(run.exitCode).toBe(0);
    expect(run.receipt).toMatchObject({ version: 2, mode: "in-place" });
    expect(run.receipt.beforeDigest).toBe(run.receipt.afterDigest);
    expect(run.receipt.beforeDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("creates no disposable workspace and installs nothing", async () => {
    const { task, snapshot } = await createSnapshotFixture([loggingCommand("phases")]);
    const lines: string[] = [];

    await withJudgeTimings(
      true,
      "run",
      () => runJudgeValidation(tmp, task.taskId, snapshot.candidate, { approve }),
      (line) => lines.push(line),
    );

    const phases = (JSON.parse(lines[0]).phases as Array<{ phase: string }>).map((entry) => entry.phase);
    expect(phases).toContain("validation-command");
    expect(phases).not.toContain("workspace-copy");
    expect(phases).not.toContain("dependency-preparation");
  });

  it("keeps the disposable copy with --isolated", async () => {
    const { task, snapshot } = await createSnapshotFixture([loggingCommand("isolated")]);

    const run = await runJudgeValidation(tmp, task.taskId, snapshot.candidate, { approve, isolated: true });

    const [line] = await runLog();
    expect(line.startsWith(`isolated ${tmp}`)).toBe(false);
    expect(run.receipt).toMatchObject({ version: 2, mode: "isolated" });
    expect(run.receipt.beforeDigest).toBeUndefined();
  });

  it("refuses to run when the live tree no longer matches the snapshot", async () => {
    const { task, snapshot } = await createSnapshotFixture([loggingCommand("never")]);
    await writeFile(path.join(tmp, "app.ts"), "export const value = 3;\n", "utf8");

    const refusal = await runJudgeValidation(tmp, task.taskId, snapshot.candidate, { approve }).catch((error) => error);

    expect(refusal).toBeInstanceOf(JudgeRunRefusal);
    expect(refusal).toMatchObject({ outcome: "tree-mismatch", exitCode: 6 });
    expect(refusal.paths).toContain("app.ts");
    expect(await runLog()).toEqual([]);
    expect(await pathExists(path.join(tmp, RUN_LOCK_PATH))).toBe(false);
  });

  it("invalidates a run that changes a covered file and keeps the evidence", async () => {
    const mutating = "node -e \"require('fs').writeFileSync('app.ts', 'export const value = 9;\\n')\"";
    const { task, snapshot } = await createSnapshotFixture([mutating]);

    const run = await runJudgeValidation(tmp, task.taskId, snapshot.candidate, { approve });

    expect(run).toMatchObject({ outcome: "invalidated", exitCode: 5 });
    expect(run.changedPaths).toEqual(["app.ts"]);
    expect(await pathExists(path.join(tmp, run.receiptPath))).toBe(true);
    const recordPath = await writeReview(task, snapshot.scope, [{ command: mutating, status: "passed" }]);
    await writeFile(path.join(tmp, "app.ts"), "export const value = 2;\n", "utf8");
    const verified = await verifyJudgeRecord(tmp, recordPath, { receiptDigest: run.receiptDigest });
    expect(verified.approved).toBe(false);
    expect(verified.reasons.join("\n")).toMatch(/changed the snapshot boundary|in-place digests/);
  });

  it("does not invalidate a run that only writes Git-ignored output", async () => {
    const building =
      "node -e \"require('fs').mkdirSync('dist',{recursive:true});require('fs').writeFileSync('dist/out.js','ok')\"";
    const { task, snapshot } = await createSnapshotFixture([building]);

    const run = await runJudgeValidation(tmp, task.taskId, snapshot.candidate, { approve });

    expect(run.outcome).toBe("passed");
    expect(await readFile(path.join(tmp, "dist/out.js"), "utf8")).toBe("ok");
  });

  it("reports approval missing with its own code and runs nothing", async () => {
    const { task, snapshot } = await createSnapshotFixture([loggingCommand("blocked")]);

    const refusal = await runJudgeValidation(tmp, task.taskId, snapshot.candidate, {
      approve: async () => false,
    }).catch((error) => error);

    expect(refusal).toMatchObject({ outcome: "approval-missing", exitCode: 3 });
    expect(refusal.message).toMatch(/Operator approval was not given/);
    expect(await runLog()).toEqual([]);
  });
});

describe("run lock", () => {
  const sameHost = os.hostname();

  it("is released after a passing run, a failing run and a refusal", async () => {
    const { task, snapshot } = await createSnapshotFixture([loggingCommand("fails", 1)]);

    const failed = await runJudgeValidation(tmp, task.taskId, snapshot.candidate, { approve });
    expect(failed).toMatchObject({ outcome: "failed", exitCode: 1 });
    expect(await pathExists(path.join(tmp, RUN_LOCK_PATH))).toBe(false);

    await writeFile(path.join(tmp, "app.ts"), "export const value = 5;\n", "utf8");
    await runJudgeValidation(tmp, task.taskId, snapshot.candidate, { approve }).catch(() => undefined);
    expect(await pathExists(path.join(tmp, RUN_LOCK_PATH))).toBe(false);
  });

  it("refuses a second run while a live process holds the lock", async () => {
    const { task, snapshot } = await createSnapshotFixture([loggingCommand("busy")]);
    await writeLock({
      pid: 4242,
      host: sameHost,
      startedAt: "2026-10-31T10:00:00.000Z",
      taskId: "TASK-001",
      snapshotId: "x",
    });

    const refusal = await runJudgeValidation(tmp, task.taskId, snapshot.candidate, {
      approve,
      lockEnv: { isAlive: () => true },
    }).catch((error) => error);

    expect(refusal).toMatchObject({ outcome: "lock-busy", exitCode: 4 });
    expect(refusal.message).toContain("4242");
    expect(refusal.message).toContain("2026-10-31T10:00:00.000Z");
    expect(await runLog()).toEqual([]);
    expect(await pathExists(path.join(tmp, RUN_LOCK_PATH))).toBe(true);
  });

  it("reclaims a same-host lock whose process is gone, with a notice", async () => {
    const { task, snapshot } = await createSnapshotFixture([loggingCommand("reclaimed")]);
    await writeLock({
      pid: 4242,
      host: sameHost,
      startedAt: "2026-10-31T10:00:00.000Z",
      taskId: "TASK-001",
      snapshotId: "x",
    });

    const run = await runJudgeValidation(tmp, task.taskId, snapshot.candidate, {
      approve,
      lockEnv: { isAlive: () => false },
    });

    expect(run.outcome).toBe("passed");
    expect(run.notices.join("\n")).toMatch(/stale run lock/i);
  });

  it("keeps a stale-lock notice when the run is then refused for a tree mismatch", async () => {
    const { task, snapshot } = await createSnapshotFixture([loggingCommand("never")]);
    await writeLock({
      pid: 4242,
      host: sameHost,
      startedAt: "2026-10-31T10:00:00.000Z",
      taskId: "TASK-001",
      snapshotId: "x",
    });
    await writeFile(path.join(tmp, "app.ts"), "export const value = 6;\n", "utf8");

    const refusal = await runJudgeValidation(tmp, task.taskId, snapshot.candidate, {
      approve,
      lockEnv: { isAlive: () => false },
    }).catch((error) => error);

    expect(refusal).toMatchObject({ outcome: "tree-mismatch" });
    expect(refusal.notices.join("\n")).toMatch(/stale run lock/i);
  });

  it("refuses a lock from another host until --break-lock", async () => {
    const { task, snapshot } = await createSnapshotFixture([loggingCommand("other-host")]);
    await writeLock({
      pid: 1,
      host: "other-machine",
      startedAt: "2026-10-31T10:00:00.000Z",
      taskId: "TASK-001",
      snapshotId: "x",
    });

    const refusal = await runJudgeValidation(tmp, task.taskId, snapshot.candidate, { approve }).catch((error) => error);
    expect(refusal).toMatchObject({ outcome: "lock-busy", exitCode: 4 });
    expect(refusal.message).toContain("--break-lock");

    const run = await runJudgeValidation(tmp, task.taskId, snapshot.candidate, { approve, breakLock: true });
    expect(run.outcome).toBe("passed");
  });
});

describe("receipt version 2 in verify", () => {
  /** Rewrites a receipt the way a forger would and returns the new digest. */
  async function forge(receiptPath: string, change: (receipt: Record<string, unknown>) => void) {
    const receipt = JSON.parse(await readFile(path.join(tmp, receiptPath), "utf8"));
    change(receipt);
    const bytes = `${JSON.stringify(receipt, null, 2)}\n`;
    const hex = createHash("sha256").update(bytes).digest("hex");
    await writeFile(path.join(tmp, path.dirname(receiptPath), `${hex}.json`), bytes, "utf8");
    return `sha256:${hex}`;
  }

  it("verifies an in-place receipt and reports its mode", async () => {
    const command = loggingCommand("verify");
    const { task, snapshot } = await createSnapshotFixture([command]);
    const run = await runJudgeValidation(tmp, task.taskId, snapshot.candidate, { approve });
    const recordPath = await writeReview(task, snapshot.scope, [{ command, status: "passed" }]);

    const result = await verifyJudgeRecord(tmp, recordPath, { receiptDigest: run.receiptDigest });

    expect(result.reasons).toEqual([]);
    expect(result.receipt?.mode).toBe("in-place");
  });

  it("still accepts a version 1 receipt and reads it as isolated", async () => {
    const command = loggingCommand("v1");
    const { task, snapshot } = await createSnapshotFixture([command]);
    const run = await runJudgeValidation(tmp, task.taskId, snapshot.candidate, { approve, isolated: true });
    const v1 = await forge(run.receiptPath, (receipt) => {
      receipt.version = 1;
      // JSON.stringify drops an undefined key, which is how a version 1 receipt looks.
      receipt.mode = undefined;
    });
    const recordPath = await writeReview(task, snapshot.scope, [{ command, status: "passed" }]);

    const result = await verifyJudgeRecord(tmp, recordPath, { receiptDigest: v1 });

    expect(result.reasons).toEqual([]);
    expect(result.receipt?.mode).toBe("isolated");
  });

  it("rejects an in-place receipt whose digests do not match the snapshot", async () => {
    const command = loggingCommand("digests");
    const { task, snapshot } = await createSnapshotFixture([command]);
    const run = await runJudgeValidation(tmp, task.taskId, snapshot.candidate, { approve });
    const forged = await forge(run.receiptPath, (receipt) => {
      receipt.afterDigest = `sha256:${"7".repeat(64)}`;
    });
    const recordPath = await writeReview(task, snapshot.scope, [{ command, status: "passed" }]);

    const result = await verifyJudgeRecord(tmp, recordPath, { receiptDigest: forged });

    expect(result.approved).toBe(false);
    expect(result.reasons.join("\n")).toContain("receipt in-place digests");
  });
});

describe("judge run CLI exit codes", () => {
  const runCli = async (args: string[]) => {
    const previousCwd = process.cwd();
    const originalLog = console.log;
    const originalError = console.error;
    const originalExitCode = process.exitCode;
    const writes: string[] = [];
    console.log = (message?: unknown) => {
      writes.push(String(message));
    };
    console.error = () => {};
    try {
      process.chdir(tmp);
      await main(["node", "wep", ...args]);
    } finally {
      process.chdir(previousCwd);
      console.log = originalLog;
      console.error = originalError;
    }
    const exitCode = process.exitCode;
    process.exitCode = originalExitCode;
    return { output: writes.join("\n"), exitCode };
  };

  it("exits 6 with a JSON outcome when the tree does not match the snapshot", async () => {
    const command = loggingCommand("cli");
    const { task, snapshot } = await createSnapshotFixture([command]);
    await writeFile(path.join(tmp, "app.ts"), "export const value = 8;\n", "utf8");

    const result = await runCli([
      "judge",
      "run",
      task.taskId,
      "--candidate",
      snapshot.candidate,
      "--json",
      "--approve-commands",
      command,
    ]);

    expect(result.exitCode).toBe(6);
    expect(JSON.parse(result.output)).toMatchObject({ outcome: "tree-mismatch", paths: ["app.ts"] });
  });

  it("exits 5 and reports the changed paths when the run changes a covered file", async () => {
    const mutating = "node -e \"require('fs').writeFileSync('app.ts', 'export const value = 9;\\n')\"";
    const { task, snapshot } = await createSnapshotFixture([mutating]);

    const json = await runCli([
      "judge",
      "run",
      task.taskId,
      "--candidate",
      snapshot.candidate,
      "--json",
      "--approve-commands",
      mutating,
    ]);
    expect(json.exitCode).toBe(5);
    expect(JSON.parse(json.output)).toMatchObject({ outcome: "invalidated", paths: ["app.ts"] });

    await writeFile(path.join(tmp, "app.ts"), "export const value = 2;\n", "utf8");
    const text = await runCli([
      "judge",
      "run",
      task.taskId,
      "--candidate",
      snapshot.candidate,
      "--approve-commands",
      mutating,
    ]);
    expect(text.exitCode).toBe(5);
    expect(text.output).toContain("INVALIDATED");
    expect(text.output).toContain("app.ts");
  });

  it("exits 3 headless without approval", async () => {
    const { task, snapshot } = await createSnapshotFixture([loggingCommand("cli")]);

    const result = await runCli(["judge", "run", task.taskId, "--candidate", snapshot.candidate, "--json"]);

    expect(result.exitCode).toBe(3);
    expect(JSON.parse(result.output)).toMatchObject({ outcome: "approval-missing" });
  });

  it("exits 0 with outcome passed and the mode in JSON", async () => {
    const command = loggingCommand("cli");
    const { task, snapshot } = await createSnapshotFixture([command]);

    const result = await runCli([
      "judge",
      "run",
      task.taskId,
      "--candidate",
      snapshot.candidate,
      "--json",
      "--approve-commands",
      command,
    ]);

    expect(result.exitCode ?? 0).toBe(0);
    expect(JSON.parse(result.output)).toMatchObject({ outcome: "passed", mode: "in-place" });
  });
});

describe("guard hook", () => {
  const lock = {
    pid: 4242,
    host: os.hostname(),
    startedAt: "2026-10-31T10:00:00.000Z",
    taskId: "TASK-007",
    snapshotId: "abc",
  };
  const payload = (tool: string) => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: tool, cwd: tmp });

  it("denies a file-writing tool while a live lock exists", async () => {
    await writeLock(lock);

    const result = await runGuard(payload("Edit"), tmp, { isAlive: () => true });

    expect(result?.hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
    expect(result?.hookSpecificOutput.permissionDecisionReason).toContain("TASK-007");
    expect(result?.hookSpecificOutput.permissionDecisionReason).toContain("2026-10-31T10:00:00.000Z");
  });

  it.each([
    { name: "a read-only tool", tool: "Read", alive: true, locked: true },
    { name: "no lock", tool: "Write", alive: true, locked: false },
    { name: "a stale lock", tool: "Write", alive: false, locked: true },
  ])("allows $name", async ({ tool, alive, locked }) => {
    if (locked) await writeLock(lock);

    expect(await runGuard(payload(tool), tmp, { isAlive: () => alive })).toBeUndefined();
  });

  it("finds the lock from a subfolder of the project", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    await writeLock(lock);
    await mkdir(path.join(tmp, "src/deep"), { recursive: true });
    const fromSubfolder = JSON.stringify({ tool_name: "Write", cwd: path.join(tmp, "src/deep") });

    const result = await runGuard(fromSubfolder, tmp, { isAlive: () => true });

    expect(result?.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("allows the tool on unreadable input or a corrupt lock", async () => {
    expect(await runGuard("not json", tmp)).toBeUndefined();
    await mkdir(path.dirname(path.join(tmp, RUN_LOCK_PATH)), { recursive: true });
    await writeFile(path.join(tmp, RUN_LOCK_PATH), "{ broken", "utf8");
    expect(await runGuard(payload("Edit"), tmp)).toBeUndefined();
  });
});

describe("guard installation", () => {
  const localSettings = () => path.join(tmp, ".claude/settings.local.json");
  const guardEntries = async () => {
    const settings = JSON.parse(await readFile(localSettings(), "utf8"));
    return (settings.hooks?.PreToolUse ?? []).filter((entry: unknown) => JSON.stringify(entry).includes("--wep-guard"));
  };

  it("is installed by init for Claude with the judge enabled, only in settings.local.json", async () => {
    await runInit({ cwd: tmp, target: "claude", nonInteractive: true });

    const entries = await guardEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].matcher).toBe("Edit|Write|MultiEdit|NotebookEdit");
    const shared = await readFile(path.join(tmp, ".claude/settings.json"), "utf8").catch(() => "");
    expect(shared).not.toContain("--wep-guard");
  });

  it("is removed by judge disable and restored by judge enable, keeping foreign hooks", async () => {
    await runInit({ cwd: tmp, target: "claude", nonInteractive: true });
    const settings = JSON.parse(await readFile(localSettings(), "utf8"));
    settings.hooks.PreToolUse.push({ matcher: "Bash", hooks: [{ type: "command", command: "my-own-hook" }] });
    await writeFile(localSettings(), JSON.stringify(settings), "utf8");

    await runJudgeDisable({ cwd: tmp, nonInteractive: true });
    expect(await guardEntries()).toHaveLength(0);
    expect(await readFile(localSettings(), "utf8")).toContain("my-own-hook");

    await runJudgeEnable({ cwd: tmp, nonInteractive: true });
    expect(await guardEntries()).toHaveLength(1);
    expect(await readFile(localSettings(), "utf8")).toContain("my-own-hook");
  });

  it("is installed by upgrade when the judge is enabled", async () => {
    await runInit({ cwd: tmp, target: "claude", nonInteractive: true });
    await rm(localSettings(), { force: true });

    await runUpgrade({ cwd: tmp, nonInteractive: true });

    expect(await guardEntries()).toHaveLength(1);
  });

  it("still enables the judge, with a warning, when the local settings cannot be parsed", async () => {
    await runInit({ cwd: tmp, target: "claude", nonInteractive: true });
    await runJudgeDisable({ cwd: tmp, nonInteractive: true });
    await writeFile(localSettings(), "[1, 2]\n", "utf8");

    const result = await runJudgeEnable({ cwd: tmp, nonInteractive: true });

    expect(result.warnings.join("\n")).toContain("run guard was not installed");
    expect(result.guard).toBeUndefined();
  });

  it("still disables the judge when the local settings cannot be parsed", async () => {
    await runInit({ cwd: tmp, target: "claude", nonInteractive: true });
    await writeFile(localSettings(), "[1, 2]\n", "utf8");

    const result = await runJudgeDisable({ cwd: tmp, nonInteractive: true });

    expect(result.warnings.join("\n")).toContain("run guard was not removed");
    const config = JSON.parse(await readFile(path.join(tmp, ".wep/config.json"), "utf8"));
    expect(config.agents?.judge?.enabled ?? config.judge?.enabled).toBe(false);
  });

  it("coexists with the session trace without either removing the other", async () => {
    await runInit({ cwd: tmp, target: "claude", nonInteractive: true });

    await runTraceEnable({ cwd: tmp, nonInteractive: true });
    await runJudgeEnable({ cwd: tmp, nonInteractive: true });

    expect(await guardEntries()).toHaveLength(1);
    expect(await readFile(path.join(tmp, ".claude/settings.json"), "utf8")).toContain("--wep-trace");
  });
});

describe("status", () => {
  it("reports no active run, then the run that holds the lock", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    expect((await runStatus({ cwd: tmp, nonInteractive: true })).activeRun).toBeNull();

    await writeLock({
      pid: process.pid,
      host: os.hostname(),
      startedAt: "2026-10-31T10:00:00.000Z",
      taskId: "TASK-003",
      snapshotId: "s1",
    });

    expect((await runStatus({ cwd: tmp, nonInteractive: true })).activeRun).toMatchObject({
      taskId: "TASK-003",
      snapshotId: "s1",
      pid: process.pid,
      host: os.hostname(),
      startedAt: "2026-10-31T10:00:00.000Z",
    });
  });
});
