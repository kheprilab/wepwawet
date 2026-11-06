import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { readConfig } from "../src/config.js";
import { runDoctor } from "../src/doctor.js";
import { pathExists } from "../src/fs-utils.js";
import { runInit } from "../src/init.js";
import {
  JUDGE_SCHEMA_VERSION,
  approveTaskValidationCommands,
  approvedCommandsPath,
  buildJudgeClosureSummary,
  hasPreApprovedValidationCommands,
  readAcceptanceCriteria,
  verifyJudgeRecord,
} from "../src/judge-enforcement.js";
import { captureJudgeSnapshot } from "../src/judge-snapshot.js";
import { runStatus } from "../src/status.js";
import { runTask } from "../src/task.js";

const execFileAsync = promisify(execFile);

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "wep-human-exp-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

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

async function setupTaskRepo(options: { commands?: string[]; clarifications?: string[] } = {}) {
  const commands = options.commands ?? ['node -e "process.exit(0)"'];
  const clarifications = options.clarifications ?? ["Q: Return HTTP 404 or null? -> A: Return null."];
  await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
  await writeFile(path.join(tmp, ".gitignore"), ".wep/local/\n", "utf8");
  const task = await runTask("Improve user checkout flow", { cwd: tmp, nonInteractive: true });
  const taskPath = path.join(tmp, task.taskDir, "task.md");
  const originalTaskMd = await readFile(taskPath, "utf8");
  const updatedTaskMd = originalTaskMd
    .replace("```\n```", `\`\`\`\n${commands.join("\n")}\n\`\`\``)
    .replace(
      "- None recorded yet.\n\n## Open Questions",
      `${clarifications.map((item) => `- ${item}`).join("\n")}\n\n## Open Questions`,
    );
  await writeFile(taskPath, updatedTaskMd, "utf8");

  const criteriaPath = path.join(tmp, task.taskDir, "acceptance-criteria.md");
  await writeFile(
    criteriaPath,
    [
      "# Acceptance Criteria",
      "",
      "- AC-1: Checkout returns null when cart is empty (evidence: app.ts)",
      "- AC-2: Validation command passes cleanly (evidence: app.ts)",
      "",
    ].join("\n"),
    "utf8",
  );

  await writeFile(path.join(tmp, "app.ts"), "export const checkout = () => null;\n", "utf8");
  await execFileAsync("git", ["init"], { cwd: tmp });
  await execFileAsync("git", ["config", "user.email", "tests@example.com"], { cwd: tmp });
  await execFileAsync("git", ["config", "user.name", "wep tests"], { cwd: tmp });
  await execFileAsync("git", ["add", "."], { cwd: tmp });
  await execFileAsync("git", ["commit", "-m", "base"], { cwd: tmp });
  await writeFile(
    path.join(tmp, "app.ts"),
    "export const checkout = (cart: unknown[]) => (cart.length ? cart : null);\n",
    "utf8",
  );

  const snapshot = await captureJudgeSnapshot(tmp, task.taskId, "HEAD");
  const declared = await readAcceptanceCriteria(tmp, task.taskId);
  const recordPath = path.join(tmp, `.wep/local/judge/${task.taskId}-round-1.json`);
  await mkdir(path.dirname(recordPath), { recursive: true });
  await writeFile(
    recordPath,
    `${JSON.stringify(
      {
        schemaVersion: JUDGE_SCHEMA_VERSION,
        taskId: task.taskId,
        scope: snapshot.scope,
        verdict: "APPROVED",
        independent: true,
        tests: commands.map((command) => ({ command, status: "passed" })),
        criteria: declared.criteria.map((item) => ({
          id: item.id,
          status: "pass",
          evidence: `Verified in app.ts:1 (${item.id})`,
        })),
        observations: [],
        reviewedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return { task, snapshot, recordPath, commands };
}

describe("human-experience & Goldfish boundary improvements (P1-P6)", () => {
  it("P1: enables judge by default during init, writes judge agent files, and keeps doctor at 100", async () => {
    await runInit({ cwd: tmp, target: "claude,codex,copilot", nonInteractive: true });

    const config = await readConfig(tmp);
    expect(config?.judge?.enabled).toBe(true);
    expect(config?.judge?.trigger).toBe("post-implementation");
    expect(await pathExists(path.join(tmp, ".claude/agents/wep-judge.md"))).toBe(true);
    expect(await pathExists(path.join(tmp, ".codex/agents/wep-judge.toml"))).toBe(true);
    expect(await pathExists(path.join(tmp, ".github/agents/wep-judge.agent.md"))).toBe(true);

    const doctor = await runDoctor({ cwd: tmp, nonInteractive: true });
    expect(doctor.readiness).toBe(100);

    const agentsMd = await readFile(path.join(tmp, "AGENTS.md"), "utf8");
    expect(agentsMd).toContain("automatically capture an immutable local boundary with wep judge snapshot");
    expect(agentsMd).not.toContain("ask the human for confirmation before invoking `wep-judge`");
  });

  it("P2 + P4: instructions and wep-task skill define the 4-part Approval Brief, Goldfish contract, and single-gate delegation", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });

    const agentsMd = await readFile(path.join(tmp, "AGENTS.md"), "utf8");
    const taskSkill = await readFile(path.join(tmp, ".agents/skills/wep-task/SKILL.md"), "utf8");
    const workflowSkill = await readFile(path.join(tmp, ".agents/skills/wep-workflow/SKILL.md"), "utf8");

    expect(agentsMd).toContain("Approval Brief");
    expect(agentsMd).toContain("Goldfish contract");
    expect(agentsMd).toContain("do not ask a second confirmation question");

    expect(taskSkill).toContain("## Approval Brief (Goldfish boundary)");
    expect(taskSkill).toContain("Goldfish contract");
    expect(taskSkill).toContain("wep task approve-commands TASK-XXX");

    expect(workflowSkill).toContain("isolated Goldfish context");
    expect(workflowSkill).toContain("evidence-based closure summary");
  });

  it("P3: pre-approves validation commands with SHA-256 digest and allows judge verify --run-tests without re-prompting unless modified", async () => {
    const cmd = 'node -e "process.exit(0)"';
    const { task, recordPath } = await setupTaskRepo({ commands: [cmd] });

    // Approve commands upfront via CLI
    const approveCli = await runCli(["task", "approve-commands", task.taskId, "--approve-commands", cmd]);
    expect(approveCli.exitCode).toBeUndefined();
    expect(approveCli.output).toContain("Approved commands:");
    expect(approveCli.output).toContain(task.taskId);
    expect(await pathExists(path.join(tmp, approvedCommandsPath(task.taskId)))).toBe(true);
    expect(await hasPreApprovedValidationCommands(tmp, task.taskId, [cmd], [cmd])).toBe(true);

    // Run `wep judge verify <record> --run-tests` WITHOUT `--approve-commands`
    const verifyCli = await runCli(["judge", "verify", path.relative(tmp, recordPath), "--run-tests"]);
    expect(verifyCli.exitCode).toBeUndefined();
    expect(verifyCli.output).toContain("APPROVED for the reviewed boundary");
    expect(verifyCli.output).toContain("re-ran");

    // If the command list changes by even one character, pre-approval no longer matches
    const modifiedCmd = 'node -e "process.exit(0); // changed"';
    expect(await hasPreApprovedValidationCommands(tmp, task.taskId, [modifiedCmd], [modifiedCmd])).toBe(false);

    // Direct API test: approveTaskValidationCommands rejects when approval callback returns false
    await expect(approveTaskValidationCommands(tmp, task.taskId, { approve: async () => false })).rejects.toThrow(
      /Operator approval was not given/,
    );
  });

  it("P5: builds and prints the human-centric closure summary card on verified approval", async () => {
    const cmd = 'node -e "process.exit(0)"';
    const { task, recordPath } = await setupTaskRepo({
      commands: [cmd],
      clarifications: ["Q: Empty cart return value? -> A: Return null instead of throwing."],
    });

    const verifyResult = await verifyJudgeRecord(tmp, recordPath);
    const summary = await buildJudgeClosureSummary(tmp, recordPath, verifyResult, [task.taskId]);
    expect(summary).toBeDefined();
    expect(summary?.taskId).toBe(task.taskId);
    expect(summary?.title).toContain("Improve user checkout flow");
    expect(summary?.verdict).toBe("APPROVED (verified)");
    expect(summary?.criteria).toHaveLength(2);
    expect(summary?.criteria[0]).toMatchObject({
      id: "AC-1",
      status: "pass",
      description: "Checkout returns null when cart is empty (evidence: app.ts)",
    });
    expect(summary?.clarifications).toEqual(["Q: Empty cart return value? -> A: Return null instead of throwing."]);

    const cliResult = await runCli(["judge", "verify", path.relative(tmp, recordPath)]);
    expect(cliResult.exitCode).toBeUndefined();
    expect(cliResult.output).toContain(`${task.taskId} · Improve user checkout flow · APPROVED (verified)`);
    expect(cliResult.output).toContain("AC-1 ✓");
    expect(cliResult.output).toContain("AC-2 ✓");
    expect(cliResult.output).toContain("Decisions respected:");
    expect(cliResult.output).toContain("Q: Empty cart return value? -> A: Return null instead of throwing.");
    expect(cliResult.output).toContain(`Pending comprehension: 1 session(s) (${task.taskId})`);
  });

  it("P6: tracks pending comprehension asynchronously in status until a non-deferred result.json is recorded", async () => {
    const { task } = await setupTaskRepo();

    const statusBefore = await runStatus({ cwd: tmp });
    expect(statusBefore.pendingComprehension).toEqual([task.taskId]);

    const statusCliBefore = await runCli(["status"]);
    expect(statusCliBefore.output).toContain(`Pending comp: 1 session(s) (${task.taskId})`);

    // Writing a DEFERRED comprehension result keeps it in pendingComprehension
    const compDir = path.join(tmp, ".wep/local/comprehension", task.taskId);
    await mkdir(compDir, { recursive: true });
    await writeFile(path.join(compDir, "result.json"), JSON.stringify({ status: "DEFERRED" }, null, 2), "utf8");
    const statusDeferred = await runStatus({ cwd: tmp });
    expect(statusDeferred.pendingComprehension).toEqual([task.taskId]);

    // Writing a completed (CONSOLIDATED) result removes the task from pendingComprehension
    await writeFile(path.join(compDir, "result.json"), JSON.stringify({ status: "CONSOLIDATED" }, null, 2), "utf8");
    const statusAfter = await runStatus({ cwd: tmp });
    expect(statusAfter.pendingComprehension).toEqual([]);
  });
});
