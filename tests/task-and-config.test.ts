import { mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { runCompile } from "../src/compile.js";
import {
  isLocalIgnoreContentSafe,
  runComprehensionDisable,
  runComprehensionEnable,
  runComprehensionStatus,
} from "../src/comprehension.js";
import { normalizeWorkflow, readConfig, setConfigValue } from "../src/config.js";
import { runDoctor } from "../src/doctor.js";
import { pathExists } from "../src/fs-utils.js";
import { capsuleFiles } from "../src/harness-files.js";
import { runInit } from "../src/init.js";
import { createJudgeScope } from "../src/judge-enforcement.js";
import { runStatus } from "../src/status.js";
import {
  listTasks,
  recommendWorkflow,
  removeTask,
  runTask,
  searchTaskCapsules,
  showTask,
  slugify,
  taskNumber,
} from "../src/task.js";
import { taskTemplateFiles } from "../src/templates.js";
import { runUpgrade } from "../src/upgrade.js";

import { execFileAsync, tmp, useTempDir } from "./helpers/wep.js";

useTempDir();

describe("task and compile", () => {
  async function writeSearchFixture(taskDirectory: string, filename: string, content: string): Promise<void> {
    const filePath = path.join(tmp, ".wep/tasks", taskDirectory, filename);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf8");
  }

  it("creates no local implementation-log directory with a capsule", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });

    await runTask("Fix auth bug", { cwd: tmp, nonInteractive: true });

    expect(await pathExists(path.join(tmp, ".wep/local/impl"))).toBe(false);
  });

  it("creates a task capsule and compiles a codex brief", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    // "fix" and "regression" unambiguously trigger TDD.
    const task = await runTask("Fix regression in invoice calculation", { cwd: tmp, nonInteractive: true });

    expect(task.taskId).toBe("TASK-001");
    expect(task.workflow).toBe("TDD");
    expect(task.workflowReason).toContain("matched keywords");
    expect(await pathExists(path.join(tmp, task.taskDir, "acceptance-criteria.md"))).toBe(true);

    const compiled = await runCompile(task.taskId, { cwd: tmp, target: "codex", nonInteractive: true });

    expect(compiled.outputPath).toBe(`${task.taskDir}/exports/codex.md`);
    const brief = await readFile(path.join(tmp, compiled.outputPath), "utf8");
    expect(brief).toContain("wep codex Brief");
    expect(brief).toContain("Fix regression in invoice calculation");
  });

  it("compile defaults to codex when no --target is provided", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const task = await runTask("Fix auth bug", { cwd: tmp, nonInteractive: true });

    const compiled = await runCompile(task.taskId, { cwd: tmp, nonInteractive: true });

    expect(compiled.target).toBe("codex");
    expect(compiled.outputPath).toContain("codex.md");
  });

  it("recompiling without --force still regenerates a stale export (derived artifact)", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const task = await runTask("Fix auth bug", { cwd: tmp, nonInteractive: true });
    await runCompile(task.taskId, { cwd: tmp, target: "codex", nonInteractive: true });

    await writeFile(
      path.join(tmp, task.taskDir, "task.md"),
      "# TASK-001\n\n## Goal\n\nUpdated goal text after edit\n",
      "utf8",
    );

    await runCompile(task.taskId, { cwd: tmp, target: "codex", nonInteractive: true });

    const brief = await readFile(path.join(tmp, task.taskDir, "exports/codex.md"), "utf8");
    expect(brief).toContain("Updated goal text after edit");
  });

  it("compile throws when task id does not exist", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });

    await expect(runCompile("TASK-999", { cwd: tmp, nonInteractive: true })).rejects.toThrow(
      "Task not found: TASK-999",
    );
  });

  it("rejects an unsupported compile target before writing a brief", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const task = await runTask("Fix auth bug", { cwd: tmp, nonInteractive: true });

    await expect(runCompile(task.taskId, { cwd: tmp, target: "unknown", nonInteractive: true })).rejects.toThrow(
      /unsupported target/i,
    );
    expect(await pathExists(path.join(tmp, task.taskDir, "exports/unknown.md"))).toBe(false);
  });

  it("accepts an explicit workflow override", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const task = await runTask("Define invoice API examples", { cwd: tmp, workflow: "sdd+edd", nonInteractive: true });

    expect(task.workflow).toBe("SDD+EDD");
    expect(task.workflowReason).toBe("explicit CLI override");
    const plan = await readFile(path.join(tmp, task.taskDir, "plan.md"), "utf8");
    expect(plan).toContain("SDD+EDD");
    expect(plan).toContain("Load only the workflow skill or prompt");
  });

  it("accepts hyphen-separated workflow variant (sdd-tdd)", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const task = await runTask("Define contract", { cwd: tmp, workflow: "sdd-tdd", nonInteractive: true });

    expect(task.workflow).toBe("SDD+TDD");
  });

  it("recommends UI review for UI-shaped descriptions", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const task = await runTask("redesign the settings page", { cwd: tmp, nonInteractive: true });

    expect(task.workflow).toBe("UI review");
  });

  it("keeps UI review even when allowedWorkflows excludes it", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    await setConfigValue(tmp, "allowedWorkflows", "TDD");

    const task = await runTask("redesign the settings page", { cwd: tmp, nonInteractive: true });

    expect(task.workflow).toBe("UI review");
  });

  it("uses TDD+EDD for game tasks under task-fit fallback", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const task = await runTask("Create Tetris game", { cwd: tmp, nonInteractive: true });

    expect(task.workflow).toBe("TDD+EDD");
  });

  it("uses configured workflow defaults when no task override is provided", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    await setConfigValue(tmp, "defaultWorkflow", "SDD+TDD");

    const task = await runTask("Create invoice endpoint", { cwd: tmp, nonInteractive: true });

    expect(task.workflow).toBe("SDD+TDD");
    expect(task.workflowReason).toBe("project default");
    const capsule = await readFile(path.join(tmp, task.taskDir, "task.md"), "utf8");
    expect(capsule).toContain("project default");
  });

  it("falls back to an allowed workflow when task-fit recommends a disallowed one", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    await setConfigValue(tmp, "allowedWorkflows", "SDD, fast-patch");

    const task = await runTask("Fix auth bug", { cwd: tmp, nonInteractive: true });

    expect(task.workflow).toBe("SDD");
    expect(task.workflowReason).toContain("not in allowedWorkflows");
    expect(task.workflowReason).toContain("fell back to SDD");
  });

  it("rejects an explicit --workflow that is not in allowedWorkflows", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    await setConfigValue(tmp, "allowedWorkflows", "SDD, TDD");

    await expect(runTask("Fix auth bug", { cwd: tmp, workflow: "EDD", nonInteractive: true })).rejects.toThrow(
      'Workflow "EDD" is not in allowedWorkflows',
    );
  });

  it("rejects a project default workflow that is not in allowedWorkflows", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    await setConfigValue(tmp, "allowedWorkflows", "SDD, TDD");
    // Bypass setConfigValue validation to simulate a manually edited inconsistent config.
    const config = await readConfig(tmp);
    if (!config) throw new Error("config missing");
    config.defaults.workflow = "EDD";
    await writeFile(path.join(tmp, ".wep/config.json"), JSON.stringify(config, null, 2), "utf8");

    await expect(runTask("Fix auth bug", { cwd: tmp, nonInteractive: true })).rejects.toThrow(
      'Workflow "EDD" is not in allowedWorkflows',
    );
  });

  it("lists task capsules", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    await runTask("Fix auth bug", { cwd: tmp, nonInteractive: true });
    await runTask("Create invoice endpoint", { cwd: tmp, nonInteractive: true });

    const tasks = await listTasks(tmp);

    expect(tasks).toHaveLength(2);
    expect(tasks[0].taskId).toBe("TASK-001");
    expect(tasks[0].description).toContain("Fix auth bug");
    expect(tasks[1].taskId).toBe("TASK-002");
    expect(tasks[1].description).toContain("Create invoice endpoint");
  });

  it("listTasks sorts numerically for TASK-002/010/1000", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    for (const n of [10, 1000, 2]) {
      await mkdir(path.join(tmp, ".wep/tasks", `TASK-${String(n).padStart(3, "0")}-x`), { recursive: true });
    }

    const tasks = await listTasks(tmp);

    expect(tasks.map((t) => t.taskId)).toEqual(["TASK-002", "TASK-010", "TASK-1000"]);
  });

  it("searches canonical capsule files literally in deterministic order", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    await writeSearchFixture("TASK-002-legacy", "task.md", "orden legacy\n");
    await writeSearchFixture("TASK-010-acentos", "task.md", "Éclair [a-z]\nÉclair Éclair\n");
    await writeSearchFixture("TASK-010-acentos", "context.md", "orden contexto\n");
    await writeSearchFixture("TASK-010-acentos", "acceptance-criteria.md", "ÉCLAIR criterio\n");
    await writeSearchFixture("TASK-010-acentos", "exports/result.md", "ÉCLAIR exportado\n");
    await writeSearchFixture("TASK-010-acentos", "log.md", "ÉCLAIR en log\n");
    await writeSearchFixture("TASK-1000-final", "task.md", "orden final\n");

    await expect(searchTaskCapsules(tmp, "   ")).rejects.toThrow("non-empty");
    expect(await searchTaskCapsules(tmp, "orden")).toEqual([
      {
        taskId: "TASK-002",
        taskDir: ".wep/tasks/TASK-002-legacy",
        file: ".wep/tasks/TASK-002-legacy/task.md",
        line: 1,
        text: "orden legacy",
      },
      {
        taskId: "TASK-010",
        taskDir: ".wep/tasks/TASK-010-acentos",
        file: ".wep/tasks/TASK-010-acentos/context.md",
        line: 1,
        text: "orden contexto",
      },
      {
        taskId: "TASK-1000",
        taskDir: ".wep/tasks/TASK-1000-final",
        file: ".wep/tasks/TASK-1000-final/task.md",
        line: 1,
        text: "orden final",
      },
    ]);
    expect(await searchTaskCapsules(tmp, "éClAiR")).toEqual([
      {
        taskId: "TASK-010",
        taskDir: ".wep/tasks/TASK-010-acentos",
        file: ".wep/tasks/TASK-010-acentos/task.md",
        line: 1,
        text: "Éclair [a-z]",
      },
      {
        taskId: "TASK-010",
        taskDir: ".wep/tasks/TASK-010-acentos",
        file: ".wep/tasks/TASK-010-acentos/task.md",
        line: 2,
        text: "Éclair Éclair",
      },
      {
        taskId: "TASK-010",
        taskDir: ".wep/tasks/TASK-010-acentos",
        file: ".wep/tasks/TASK-010-acentos/acceptance-criteria.md",
        line: 1,
        text: "ÉCLAIR criterio",
      },
    ]);
    expect(await searchTaskCapsules(tmp, "[a-z]")).toHaveLength(1);
    expect(await searchTaskCapsules(tmp, "eclair")).toEqual([]);
    expect(await searchTaskCapsules(tmp, "sin coincidencias")).toEqual([]);
  });

  it("applies blocked-read policy before searching and rejects an absent policy", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    await mkdir(path.join(tmp, ".wep/tasks/TASK-002-private/task.md"), { recursive: true });
    await writeFile(path.join(tmp, ".wep/policy.json"), JSON.stringify({ blockedReadPatterns: ["task.md"] }), "utf8");

    expect(await searchTaskCapsules(tmp, "dato bloqueado")).toEqual([]);

    await rm(path.join(tmp, ".wep/policy.json"));
    await expect(searchTaskCapsules(tmp, "dato bloqueado")).rejects.toThrow(
      "Cannot apply policy.json blockedReadPatterns",
    );

    await writeFile(path.join(tmp, ".wep/policy.json"), "not valid JSON", "utf8");
    await expect(searchTaskCapsules(tmp, "dato bloqueado")).rejects.toThrow(
      "Cannot apply policy.json blockedReadPatterns",
    );
  });

  it("rejects a symbolic .wep root before reading its policy or capsules", async () => {
    const externalRoot = path.join(tmp, "external-wep");
    await mkdir(path.join(externalRoot, "tasks/TASK-002-external"), { recursive: true });
    await writeFile(path.join(externalRoot, "policy.json"), JSON.stringify({ blockedReadPatterns: [] }), "utf8");
    await writeFile(path.join(externalRoot, "tasks/TASK-002-external/task.md"), "contenido externo\n", "utf8");
    await symlink(externalRoot, path.join(tmp, ".wep"), "dir");

    await expect(searchTaskCapsules(tmp, "contenido externo")).rejects.toThrow(
      "Cannot search task capsules through symbolic link: .wep.",
    );
  });

  it("skips missing canonical files and every symbolic link, but reports other read errors", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const externalDirectory = path.join(tmp, "external-capsule");
    await mkdir(externalDirectory);
    await writeFile(path.join(externalDirectory, "task.md"), "outside directory\n", "utf8");
    await symlink(externalDirectory, path.join(tmp, ".wep/tasks/TASK-002-external"), "dir");

    const externalFile = path.join(tmp, "external.md");
    await writeFile(externalFile, "outside file\n", "utf8");
    await mkdir(path.join(tmp, ".wep/tasks/TASK-003-file-link"), { recursive: true });
    await symlink(externalFile, path.join(tmp, ".wep/tasks/TASK-003-file-link/task.md"), "file");
    await writeSearchFixture("TASK-004-missing", "context.md", "legacy sin task.md\n");

    expect(await searchTaskCapsules(tmp, "outside")).toEqual([]);
    expect(await searchTaskCapsules(tmp, "legacy")).toEqual([
      {
        taskId: "TASK-004",
        taskDir: ".wep/tasks/TASK-004-missing",
        file: ".wep/tasks/TASK-004-missing/context.md",
        line: 1,
        text: "legacy sin task.md",
      },
    ]);

    await mkdir(path.join(tmp, ".wep/tasks/TASK-005-unreadable", "task.md"), { recursive: true });
    await expect(searchTaskCapsules(tmp, "anything")).rejects.toThrow(/task\.md/);
  });

  it("taskNumber extracts the numeric id", () => {
    expect(taskNumber("TASK-002-fix-bug")).toBe(2);
    expect(taskNumber("TASK-1000-x")).toBe(1000);
  });

  it("showTask returns task files and workflow", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const task = await runTask("Fix auth bug", { cwd: tmp, nonInteractive: true });

    const result = await showTask(tmp, task.taskId);

    expect(result.taskId).toBe(task.taskId);
    expect(result.workflow).toBe("TDD");
    expect(result.files["task.md"]).toContain("Fix auth bug");
    expect(result.files["plan.md"]).toBeDefined();
  });

  it("removeTask deletes a task capsule", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const task = await runTask("Fix auth bug", { cwd: tmp, nonInteractive: true });

    const result = await removeTask(tmp, task.taskId, { cwd: tmp });

    expect(result.removed).toBe(true);
    expect(await pathExists(path.join(tmp, task.taskDir))).toBe(false);
  });

  it("removeTask respects dry-run", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const task = await runTask("Fix auth bug", { cwd: tmp, nonInteractive: true });

    const result = await removeTask(tmp, task.taskId, { cwd: tmp, dryRun: true });

    expect(result.removed).toBe(false);
    expect(await pathExists(path.join(tmp, task.taskDir))).toBe(true);
  });

  it("compiles briefs for all installed targets", async () => {
    await runInit({ cwd: tmp, target: "all", nonInteractive: true });
    const task = await runTask("Fix auth bug", { cwd: tmp, nonInteractive: true });

    const result = await runCompile(task.taskId, { cwd: tmp, target: "all", nonInteractive: true });

    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThanOrEqual(2);
    const targets = result.map((r) => r.target).sort();
    expect(targets).toContain("codex");
    expect(targets).toContain("claude");
    for (const r of result) {
      expect(await pathExists(path.join(tmp, r.outputPath))).toBe(true);
    }
  });
});

describe("config", () => {
  it("throws a descriptive error for unsupported config keys", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });

    await expect(setConfigValue(tmp, "unknownKey", "value")).rejects.toThrow('Unsupported config key: "unknownKey"');
  });

  it("setConfigValue updates workflow correctly", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });

    const result = await setConfigValue(tmp, "defaultWorkflow", "TDD");
    expect(result.defaults.workflow).toBe("TDD");
  });

  it("does not allow config set to bypass comprehension privacy checks", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });

    await expect(setConfigValue(tmp, "comprehensionGateEnabled", "true")).rejects.toThrow("Unsupported config key");
  });

  it("normalizes invalid comprehension configuration to safe defaults", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const configPath = path.join(tmp, ".wep/config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.comprehensionGate = { enabled: "yes", trigger: "always", evaluationMode: "same-session" };
    await writeFile(configPath, JSON.stringify(config, null, 2), "utf8");

    const normalized = await readConfig(tmp);

    expect(normalized?.comprehensionGate).toEqual({
      enabled: false,
      trigger: "always",
      evaluationMode: "prefer-independent",
    });
  });

  it("setConfigValue updates allowedWorkflows from a comma-separated list", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });

    const result = await setConfigValue(tmp, "allowedWorkflows", "SDD, TDD, fast-patch");
    expect(result.defaults.allowedWorkflows).toEqual(["SDD", "TDD", "fast-patch"]);
  });

  it("setConfigValue normalizes and deduplicates allowedWorkflows", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });

    const result = await setConfigValue(tmp, "allowedWorkflows", "sdd+tdd, TDD, sdd-tdd");
    expect(result.defaults.allowedWorkflows).toEqual(["SDD+TDD", "TDD"]);
  });

  it("setConfigValue rejects invalid workflows in allowedWorkflows", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });

    await expect(setConfigValue(tmp, "allowedWorkflows", "SDD, fake-workflow")).rejects.toThrow(
      'Unsupported workflow in allowedWorkflows: "fake-workflow"',
    );
  });

  it("setConfigValue rejects an empty allowedWorkflows list", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });

    await expect(setConfigValue(tmp, "allowedWorkflows", "   ")).rejects.toThrow(
      "allowedWorkflows must contain at least one workflow",
    );
  });

  it("readConfig throws on corrupt JSON instead of returning undefined", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    await writeFile(path.join(tmp, ".wep/config.json"), "{ broken json", "utf8");

    await expect(readConfig(tmp)).rejects.toThrow("invalid JSON");
  });

  it("readConfig returns undefined when config.json is simply missing", async () => {
    await expect(readConfig(tmp)).resolves.toBeUndefined();
  });

  it("setConfigValue throws instead of silently overwriting a corrupt config", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    await writeFile(path.join(tmp, ".wep/config.json"), "{ broken json", "utf8");

    await expect(setConfigValue(tmp, "defaultWorkflow", "TDD")).rejects.toThrow("invalid JSON");
  });

  it("CLI config show throws a clear error on corrupt JSON", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    await writeFile(path.join(tmp, ".wep/config.json"), "{ broken json", "utf8");
    const previousCwd = process.cwd();
    const originalLog = console.log;
    console.log = () => {};

    try {
      process.chdir(tmp);
      await expect(main(["node", "wep", "config", "show"])).rejects.toThrow("invalid JSON");
    } finally {
      process.chdir(previousCwd);
      console.log = originalLog;
    }
  });
});

describe("silent degradation", () => {
  const corrupt = async (contents: string) => {
    await runInit({ cwd: tmp, target: "claude", nonInteractive: true });
    await writeFile(path.join(tmp, ".wep/config.json"), contents, "utf8");
  };

  it("refuses to select a workflow from a corrupt config instead of allowing every workflow", async () => {
    await corrupt("{ broken json");

    // The defect: readConfig returned undefined, selectWorkflow fell back to the full
    // workflow list, and the task capsule was written as if the project had configured
    // no restrictions at all.
    await expect(runTask("Add invoice API", { cwd: tmp, nonInteractive: true })).rejects.toThrow("invalid JSON");
  });

  it("reports a corrupt config from status instead of calling it not configured", async () => {
    await corrupt("{ broken json");

    await expect(runStatus({ cwd: tmp, nonInteractive: true })).rejects.toThrow("invalid JSON");
  });

  it("still diagnoses a repository whose config.json is corrupt", async () => {
    await corrupt("{ broken json");

    // Doctor is the one caller that must tolerate corruption: diagnosing broken
    // repositories is its entire job. It reports the corruption rather than crashing.
    const result = await runDoctor({ cwd: tmp, nonInteractive: true });

    expect(result.missing).toContain(".wep/config.json — invalid JSON (fix manually or restore from git)");
  });

  it.each([
    ["null", "null"],
    ["an array", "[]"],
    ["a number", "42"],
  ])("rejects a config that is %s rather than defaulting to a codex install", async (_label, contents) => {
    await corrupt(contents);

    await expect(readConfig(tmp)).rejects.toThrow("not a JSON object");
  });

  it("rejects a config that declares no recognizable target instead of inventing codex", async () => {
    await corrupt(JSON.stringify({ version: 1, targets: ["not-a-real-agent"] }));

    // The defect: normalizeConfig substituted ["codex"] here, so a claude-only repo with
    // a damaged targets list silently became a codex install.
    await expect(readConfig(tmp)).rejects.toThrow("no recognized target");
  });

  it("reports a target-less config as a doctor gap rather than crashing on it", async () => {
    await corrupt(JSON.stringify({ version: 1, targets: [] }));

    const result = await runDoctor({ cwd: tmp, nonInteractive: true });

    expect(result.missing).toContain(".wep/config.json — targets must list at least one supported target");
  });
});

describe("canonical capsule file list", () => {
  // Deliberately no literal list here. A third copy of the names in the tests would let
  // a sixth capsule file be added to the constant while `task create` and `_template`
  // quietly kept producing five — which is the defect this block exists to prevent.
  it("ships every capsule file in the _template directory", async () => {
    await runInit({ cwd: tmp, target: "claude", nonInteractive: true });

    const shipped = await readdir(path.join(tmp, ".wep/tasks/_template"));

    expect(shipped.sort()).toEqual([...capsuleFiles].sort());
  });

  it("derives the shipped template from the canonical list", () => {
    expect(Object.keys(taskTemplateFiles).sort()).toEqual(capsuleFiles.map((f) => `tasks/_template/${f}`).sort());
  });

  it("writes every capsule file when task create generates a capsule", async () => {
    await runInit({ cwd: tmp, target: "claude", nonInteractive: true });

    const task = await runTask("Add invoice API", { cwd: tmp, nonInteractive: true });

    for (const name of capsuleFiles) {
      expect(task.writes).toContain(path.posix.join(task.taskDir, name));
    }
  });

  it("computes a judge scope for a capsule copied verbatim from _template", async () => {
    await runInit({ cwd: tmp, target: "claude", nonInteractive: true });
    // The defect end to end: _template shipped four files, createJudgeScope required
    // five, so `wep judge scope` failed on a capsule the harness itself produced.
    const capsule = path.join(tmp, ".wep/tasks/TASK-001-copied-from-template");
    await mkdir(capsule, { recursive: true });
    for (const name of await readdir(path.join(tmp, ".wep/tasks/_template"))) {
      await writeFile(path.join(capsule, name), await readFile(path.join(tmp, ".wep/tasks/_template", name)), "utf8");
    }
    await execFileAsync("git", ["init"], { cwd: tmp });
    await execFileAsync("git", ["config", "user.email", "tests@example.com"], { cwd: tmp });
    await execFileAsync("git", ["config", "user.name", "wep tests"], { cwd: tmp });
    await execFileAsync("git", ["add", "."], { cwd: tmp });
    await execFileAsync("git", ["commit", "-m", "base"], { cwd: tmp });

    const scope = await createJudgeScope(tmp, "TASK-001", "HEAD", "WORKTREE");

    expect(scope.taskId).toBe("TASK-001");
    expect(scope.taskDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("requires every capsule template file in doctor", async () => {
    await runInit({ cwd: tmp, target: "claude", nonInteractive: true });
    await rm(path.join(tmp, ".wep/tasks/_template/acceptance-criteria.md"));

    const result = await runDoctor({ cwd: tmp, nonInteractive: true });

    expect(result.missing).toContain(".wep/tasks/_template/acceptance-criteria.md");
  });

  it("creates the capsule template file missing from an older installation on upgrade", async () => {
    await runInit({ cwd: tmp, target: "claude", nonInteractive: true });
    const existing = path.join(tmp, ".wep/tasks/_template/task.md");
    await writeFile(existing, "# Task\n\nProject-owned edit that must survive.\n", "utf8");
    await rm(path.join(tmp, ".wep/tasks/_template/acceptance-criteria.md"));

    await runUpgrade({ cwd: tmp, nonInteractive: true });

    expect(await pathExists(path.join(tmp, ".wep/tasks/_template/acceptance-criteria.md"))).toBe(true);
    expect(await readFile(existing, "utf8")).toContain("Project-owned edit that must survive.");
  });
});

describe("normalizeWorkflow", () => {
  it.each([
    ["sdd+tdd", "SDD+TDD"],
    ["SDD+TDD", "SDD+TDD"],
    ["tdd+sdd", "SDD+TDD"],
    ["sdd-tdd", "SDD+TDD"],
    ["SDD_TDD", "SDD+TDD"],
    ["sdd+edd", "SDD+EDD"],
    ["tdd+edd", "TDD+EDD"],
    ["fast-patch", "fast-patch"],
    ["fastpatch", "fast-patch"],
    ["research-first", "research-first"],
    ["researchfirst", "research-first"],
  ])("normalizes %s → %s", (input, expected) => {
    expect(normalizeWorkflow(input)).toBe(expected);
  });

  it("returns undefined for unknown workflow strings", () => {
    expect(normalizeWorkflow("unknown")).toBeUndefined();
    expect(normalizeWorkflow("")).toBeUndefined();
    expect(normalizeWorkflow(undefined)).toBeUndefined();
  });
});

describe("recommendWorkflow — word boundary correctness", () => {
  it("does not match 'api' inside 'capitalism'", () => {
    const { workflow } = recommendWorkflow("capitalism economics");
    expect(workflow).toBe("fast-patch");
  });

  it("does not match 'spec' inside 'inspector'", () => {
    const { workflow } = recommendWorkflow("run the inspector");
    expect(workflow).toBe("fast-patch");
  });

  it("does not match 'fix' inside 'prefix'", () => {
    const { workflow } = recommendWorkflow("add prefix to config keys");
    expect(workflow).toBe("fast-patch");
  });

  it("does not match 'test' inside 'latest'", () => {
    const { workflow } = recommendWorkflow("upgrade to latest version");
    expect(workflow).toBe("fast-patch");
  });

  it("prioritizes bug signals over domain keywords: 'fix the api bug' matches TDD, not SDD", () => {
    const { workflow } = recommendWorkflow("fix the api bug");
    expect(workflow).toBe("TDD");
  });

  it("no longer treats 'tetris' as a game/interactive keyword on its own", () => {
    const { workflow } = recommendWorkflow("build a tetris clone");
    expect(workflow).toBe("fast-patch");
  });

  it("matches standalone 'api'", () => {
    const { workflow } = recommendWorkflow("create user api endpoint");
    expect(workflow).toBe("SDD");
  });

  it("matches standalone 'fix'", () => {
    const { workflow } = recommendWorkflow("fix the auth bug");
    expect(workflow).toBe("TDD");
  });

  it("matches 'regression'", () => {
    const { workflow } = recommendWorkflow("address login regression");
    expect(workflow).toBe("TDD");
  });

  it("matches 'screen' and returns UI review", () => {
    const { workflow } = recommendWorkflow("create settings screen");
    expect(workflow).toBe("UI review");
  });

  it("returns workflowReason for every path", () => {
    const paths = [
      "sdd edd example",
      "sdd tdd contract",
      "tetris game",
      "edge case example",
      "api schema",
      "fix regression bug",
      "ui screen",
      "research investigate",
      "generic change",
    ];
    for (const desc of paths) {
      const { reason } = recommendWorkflow(desc);
      expect(typeof reason).toBe("string");
      expect(reason.length).toBeGreaterThan(0);
    }
  });
});

describe("slugify", () => {
  it("converts description to slug", () => {
    expect(slugify("Create User API endpoint")).toBe("create-user-api-endpoint");
  });

  it("truncates at 64 characters", () => {
    const long = "a".repeat(100);
    expect(slugify(long).length).toBe(64);
  });

  it("falls back to 'task' for empty/special-char descriptions", () => {
    expect(slugify("!!!")).toBe("task");
    expect(slugify("")).toBe("task");
  });
});

describe("status", () => {
  it("returns not-installed status before init", async () => {
    const result = await runStatus({ cwd: tmp, nonInteractive: true });

    expect(result.installed).toBe(false);
    expect(result.taskCount).toBe(0);
  });

  it("orders recentTaskIds numerically (not lexicographically) for TASK-002/010/1000", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    for (const n of [2, 10, 1000]) {
      await mkdir(path.join(tmp, ".wep/tasks", `TASK-${String(n).padStart(3, "0")}-x`), { recursive: true });
    }

    const result = await runStatus({ cwd: tmp, nonInteractive: true });

    expect(result.recentTaskIds).toEqual(["TASK-1000", "TASK-010", "TASK-002"]);
  });

  it("shows installed targets and task count after init and task creation", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    await runTask("Fix auth bug", { cwd: tmp, nonInteractive: true });
    await runTask("Add user schema", { cwd: tmp, nonInteractive: true });

    const result = await runStatus({ cwd: tmp, nonInteractive: true });

    expect(result.installed).toBe(true);
    expect(result.targets).toContain("codex");
    expect(result.taskCount).toBe(2);
    expect(result.comprehensionGate).toBe("disabled");
    expect(result.recentTaskIds).toContain("TASK-001");
    expect(result.recentTaskIds).toContain("TASK-002");
  });
});

describe("TASK-082 workflow declaration reader", () => {
  const cli = path.resolve("dist/index.js");

  async function workflowCapsule(plan: string | undefined, task = "# Task\n"): Promise<string> {
    const taskDir = ".wep/tasks/TASK-082-fixture";
    await mkdir(path.join(tmp, taskDir), { recursive: true });
    await writeFile(path.join(tmp, taskDir, "task.md"), task);
    if (plan !== undefined) await writeFile(path.join(tmp, taskDir, "plan.md"), plan);
    return taskDir;
  }

  it.each([
    ["TDD", "TDD"],
    ["- research-first", "research-first"],
    ["* SDD+TDD.", "SDD+TDD"],
    ["+ EDD", "EDD"],
    ["  -   fast-patch.  ", "fast-patch"],
    ["TDD.", "TDD"],
    ["UI review", "UI review"],
    ["bespoke workflow.", "bespoke workflow"],
    ["- research-first, then TDD", "research-first, then TDD"],
    ["SDD+TDD. This is the declared string.", "SDD+TDD. This is the declared string"],
  ])("reads and normalizes the plan declaration %s", async (declaration, expected) => {
    await workflowCapsule(
      `# Plan\n\n## Workflow\n\n${declaration}\n\nReason: Keep the declared string.\n\n## Steps\n\n1. Work.\n`,
    );

    expect((await showTask(tmp, "TASK-082")).workflow).toBe(expected);
  });

  it("reads whitespace and CRLF without requiring a blank line after the heading", async () => {
    await workflowCapsule("# Plan\r\n\r\n## Workflow  \r\n\t-  UI review.  \r\n\r\n## Steps\r\nWork.\r\n");

    expect((await showTask(tmp, "TASK-082")).workflow).toBe("UI review");
  });

  it("prefers a non-empty plan declaration over a conflicting legacy value", async () => {
    await workflowCapsule("## Workflow\n\n- EDD.\n", "## Recommended Workflow\n\nTDD\n");

    expect((await showTask(tmp, "TASK-082")).workflow).toBe("EDD");
  });

  it.each([undefined, "# Plan\n", "## Workflow\n\n## Steps\n\nWork.\n", "## Workflow\n\n \t\n"])(
    "uses the legacy heading when the plan has no declaration (%s)",
    async (plan) => {
      await workflowCapsule(plan, "# Task\n\n## Recommended Workflow\n\n- TDD.\n\n## Scope\n\nWork.\n");

      expect((await showTask(tmp, "TASK-082")).workflow).toBe("TDD");
    },
  );

  it("keeps workflow absent rather than reading a neighboring section or recommending one", async () => {
    await workflowCapsule(
      "## Workflow\n\n## Steps\n\nSDD\n",
      "# Fix an API bug\n\n## Recommended Workflow\n\n## Scope\n\nTDD\n",
    );

    expect((await showTask(tmp, "TASK-082")).workflow).toBeUndefined();
  });

  it("does not mistake a different heading or a prose mention for the declaration", async () => {
    await workflowCapsule("# Plan\n\nThe heading ## Workflow mentions TDD.\n\n## Workflow Reason\n\nEDD\n");

    expect((await showTask(tmp, "TASK-082")).workflow).toBeUndefined();
  });

  it("keeps capsule bytes, mtimes and the showTask result shape unchanged", async () => {
    const plan = "## Workflow\n\n- UI review.\n\nReason: Check visuals.\n";
    const task = "## Recommended Workflow\n\nTDD\n";
    const taskDir = await workflowCapsule(plan, task);
    const names = ["task.md", "plan.md"];
    const before = await Promise.all(names.map((name) => stat(path.join(tmp, taskDir, name))));

    const result = await showTask(tmp, "TASK-082");

    expect(Object.keys(result).sort()).toEqual(["files", "taskDir", "taskId", "workflow"]);
    expect(result.files).toEqual({ "task.md": task, "plan.md": plan });
    for (const [index, name] of names.entries()) {
      expect(await readFile(path.join(tmp, taskDir, name), "utf8")).toBe(result.files[name]);
      expect((await stat(path.join(tmp, taskDir, name))).mtimeMs).toBe(before[index].mtimeMs);
    }
  });

  it.each(["TDD.", "- fast-patch.", "- UI review", "custom workflow."])(
    "reports the declaration %s through task show --json without adding fields",
    async (declaration) => {
      await workflowCapsule(`## Workflow\n\n${declaration}\n`);
      const { stdout } = await execFileAsync("node", [cli, "task", "show", "TASK-082", "--json"], { cwd: tmp });
      const result = JSON.parse(stdout);

      expect(Object.keys(result).sort()).toEqual(["files", "taskDir", "taskId", "workflow"]);
      expect(result.workflow).toBe(declaration.replace(/^- /, "").replace(/\.$/, ""));
    },
  );

  it("omits workflow from JSON when neither declaration is present", async () => {
    await workflowCapsule("# Plan\n\n## Workflow\n\n## Steps\n\nWork.\n");
    const { stdout } = await execFileAsync("node", [cli, "task", "show", "TASK-082", "--json"], { cwd: tmp });

    expect(Object.keys(JSON.parse(stdout)).sort()).toEqual(["files", "taskDir", "taskId"]);
  });
});

describe("comprehension gate", () => {
  it("enables, reports, and disables without selecting a model", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });

    const enabled = await runComprehensionEnable({ cwd: tmp, nonInteractive: true });
    expect(enabled.enabled).toBe(true);
    expect(enabled.evaluationMode).toBe("prefer-independent");
    expect(enabled.localIgnoreValid).toBe(true);
    expect(enabled.installedTargets).toContain("codex");
    expect(await pathExists(path.join(tmp, ".codex/agents/wep-comprehension.toml"))).toBe(true);

    expect((await runComprehensionStatus({ cwd: tmp, nonInteractive: true })).enabled).toBe(true);
    expect((await runComprehensionDisable({ cwd: tmp, nonInteractive: true })).enabled).toBe(false);
  });

  it("refuses to enable when local records are not safely ignored", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    await writeFile(path.join(tmp, ".wep/local/.gitignore"), "# unsafe\n", "utf8");

    await expect(runComprehensionEnable({ cwd: tmp, nonInteractive: true })).rejects.toThrow("wep doctor --fix");
    expect(isLocalIgnoreContentSafe("# unsafe\n")).toBe(false);
    expect(isLocalIgnoreContentSafe("*\n!.gitignore\n!comprehension/**\n")).toBe(false);
  });

  it("dry-run does not change the enabled state", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });

    const preview = await runComprehensionEnable({ cwd: tmp, dryRun: true, nonInteractive: true });

    expect(preview.enabled).toBe(true);
    expect((await readConfig(tmp))?.comprehensionGate.enabled).toBe(false);
    expect(await pathExists(path.join(tmp, ".codex/agents/wep-comprehension.toml"))).toBe(false);
  });

  it("installs platform-native isolated agents and skips Pi", async () => {
    await runInit({ cwd: tmp, target: "all", nonInteractive: true });

    const result = await runComprehensionEnable({ cwd: tmp, nonInteractive: true });

    expect(result.installedTargets).toEqual(expect.arrayContaining(["codex", "claude", "copilot"]));
    expect(result.skippedTargets).toContain("pi");
    const claude = await readFile(path.join(tmp, ".claude/agents/wep-comprehension.md"), "utf8");
    const copilot = await readFile(path.join(tmp, ".github/agents/wep-comprehension.agent.md"), "utf8");
    expect(claude).toContain("permissionMode: plan");
    expect(claude).toContain("background: false");
    expect(copilot).toContain('tools: ["read", "search", "execute"]');
    expect(copilot).toContain("user-invocable: true");
  });

  it("refuses to enable when any versioned contract schema is missing or invalid", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const rubricPath = path.join(tmp, ".wep/comprehension/schemas/rubric.schema.json");
    await writeFile(rubricPath, "{}\n", "utf8");

    await expect(runComprehensionEnable({ cwd: tmp, nonInteractive: true })).rejects.toThrow("missing or invalid");
  });

  it("doctor detects an enabled gate without its independent agent", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const configPath = path.join(tmp, ".wep/config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.comprehensionGate.enabled = true;
    await writeFile(configPath, JSON.stringify(config, null, 2), "utf8");

    const result = await runDoctor({ cwd: tmp, nonInteractive: true });

    expect(result.suggestions.some((suggestion) => suggestion.text.includes("wep comprehension enable"))).toBe(true);
  });

  it("keeps personal session files out of Git by default", async () => {
    await execFileAsync("git", ["init"], { cwd: tmp });
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const relativeRecord = ".wep/local/comprehension/TASK-001/session/result.json";
    const recordPath = path.join(tmp, relativeRecord);
    await mkdir(path.dirname(recordPath), { recursive: true });
    await writeFile(recordPath, "{}\n", "utf8");

    await execFileAsync("git", ["check-ignore", "-q", relativeRecord], { cwd: tmp });
    const { stdout } = await execFileAsync("git", ["status", "--short"], { cwd: tmp });
    expect(stdout).not.toContain(relativeRecord);
  });
});
