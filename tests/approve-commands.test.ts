import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const questionMock = vi.fn<(query: string) => Promise<string>>();
const closeMock = vi.fn();

vi.mock("node:readline/promises", () => ({
  createInterface: vi.fn(() => ({
    question: questionMock,
    close: closeMock,
  })),
}));

import { main } from "../src/cli.js";
import { approveCommands } from "../src/cli/judge.js";
import { pathExists } from "../src/fs-utils.js";
import { runInit } from "../src/init.js";
import { approvedCommandsPath, hasPreApprovedValidationCommands } from "../src/judge-enforcement.js";
import { runTask } from "../src/task.js";

let tmp: string;
const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");

function setStdinTTY(value: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", {
    value,
    configurable: true,
    writable: true,
  });
}

function restoreStdinTTY(): void {
  if (originalIsTTY) {
    Object.defineProperty(process.stdin, "isTTY", originalIsTTY);
  } else {
    (process.stdin as { isTTY?: boolean }).isTTY = undefined;
  }
}

async function runCli(args: string[]): Promise<{ output: string; exitCode: number | undefined }> {
  const previousCwd = process.cwd();
  const previousExitCode = process.exitCode;
  const originalLog = console.log;
  const originalError = console.error;
  const writes: string[] = [];
  console.log = (message?: unknown) => {
    writes.push(String(message));
  };
  console.error = (message?: unknown) => {
    writes.push(String(message));
  };
  process.exitCode = undefined;
  try {
    process.chdir(tmp);
    await main(["node", "wep", ...args]);
    return { output: writes.join("\n"), exitCode: process.exitCode };
  } catch (error) {
    writes.push(error instanceof Error ? error.message : String(error));
    return { output: writes.join("\n"), exitCode: 1 };
  } finally {
    process.chdir(previousCwd);
    process.exitCode = previousExitCode;
    console.log = originalLog;
    console.error = originalError;
  }
}

async function setupTask(commands: string[]): Promise<{ taskId: string }> {
  await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
  await writeFile(path.join(tmp, ".gitignore"), ".wep/local/\n", "utf8");
  const task = await runTask("Verify approve-commands prompt", { cwd: tmp, nonInteractive: true });
  const taskPath = path.join(tmp, task.taskDir, "task.md");
  const originalTaskMd = await readFile(taskPath, "utf8");
  await writeFile(taskPath, originalTaskMd.replace("```\n```", `\`\`\`\n${commands.join("\n")}\n\`\`\``), "utf8");
  return { taskId: task.taskId };
}

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "wep-approve-cmds-"));
  questionMock.mockReset();
  closeMock.mockReset();
});

afterEach(async () => {
  restoreStdinTTY();
  await rm(tmp, { recursive: true, force: true });
});

describe("approve-commands headless hint and TTY behavior", () => {
  it("shows exact headless invocation in TTY prompt for wep task approve-commands", async () => {
    const commands = ["pnpm lint", "pnpm test"];
    const { taskId } = await setupTask(commands);
    setStdinTTY(true);
    questionMock.mockResolvedValue("y");

    const result = await runCli(["task", "approve-commands", taskId]);

    expect(result.exitCode).toBeUndefined();
    expect(result.output).toContain("1. pnpm lint");
    expect(result.output).toContain("2. pnpm test");
    expect(result.output).toContain(
      `wep task approve-commands ${taskId} --approve-commands "pnpm lint" --approve-commands "pnpm test"`,
    );
    expect(questionMock).toHaveBeenCalledTimes(1);
    expect(questionMock).toHaveBeenCalledWith("  Approve them? [y/N] ");
    expect(closeMock).toHaveBeenCalledTimes(1);
    expect(await hasPreApprovedValidationCommands(tmp, taskId, commands, commands)).toBe(true);
  });

  it("shows exact headless invocation when there is no TTY for wep task approve-commands", async () => {
    const commands = ["pnpm lint", "pnpm test"];
    const { taskId } = await setupTask(commands);
    setStdinTTY(false);

    const result = await runCli(["task", "approve-commands", taskId]);

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("1. pnpm lint");
    expect(result.output).toContain("2. pnpm test");
    expect(result.output).toContain(
      `wep task approve-commands ${taskId} --approve-commands "pnpm lint" --approve-commands "pnpm test"`,
    );
    expect(questionMock).not.toHaveBeenCalled();
    expect(await pathExists(path.join(tmp, approvedCommandsPath(taskId)))).toBe(false);
  });

  it("accepts matching --approve-commands without prompting even when stdin is a TTY", async () => {
    const commands = ["pnpm lint", "pnpm test"];
    const { taskId } = await setupTask(commands);
    setStdinTTY(true);

    const result = await runCli([
      "task",
      "approve-commands",
      taskId,
      "--approve-commands",
      "pnpm lint",
      "--approve-commands",
      "pnpm test",
    ]);

    expect(result.exitCode).toBeUndefined();
    expect(result.output).toContain(`Approved commands: ${taskId}`);
    expect(questionMock).not.toHaveBeenCalled();
    expect(await hasPreApprovedValidationCommands(tmp, taskId, commands, commands)).toBe(true);
  });

  it("refuses mismatched --approve-commands without prompting in TTY and prints expected headless invocation", async () => {
    const commands = ["pnpm lint", "pnpm test"];
    const { taskId } = await setupTask(commands);
    setStdinTTY(true);

    const result = await runCli([
      "task",
      "approve-commands",
      taskId,
      "--approve-commands",
      "pnpm test",
      "--approve-commands",
      "pnpm lint",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("--approve-commands does not match the declared commands at position 1");
    expect(result.output).toContain(
      `wep task approve-commands ${taskId} --approve-commands "pnpm lint" --approve-commands "pnpm test"`,
    );
    expect(questionMock).not.toHaveBeenCalled();
    expect(await pathExists(path.join(tmp, approvedCommandsPath(taskId)))).toBe(false);
  });

  it("shows --approve-commands hint in default TTY prompt for judge callers and honors --approve-commands in TTY", async () => {
    const commands = ["pnpm lint", "pnpm test"];
    setStdinTTY(true);
    questionMock.mockResolvedValue("n");

    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
      logs.push(String(message));
    });
    try {
      const denied = await approveCommands(commands, []);
      expect(denied).toBe(false);
      expect(logs.join("\n")).toContain('--approve-commands "pnpm lint" --approve-commands "pnpm test"');
      expect(questionMock).toHaveBeenCalledWith("  Run them? [y/N] ");

      questionMock.mockClear();
      const accepted = await approveCommands(commands, commands);
      expect(accepted).toBe(true);
      expect(questionMock).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });
});
