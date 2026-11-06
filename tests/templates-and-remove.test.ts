import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { runComprehensionEnable } from "../src/comprehension.js";
import { readConfig } from "../src/config.js";
import { pathExists } from "../src/fs-utils.js";
import { runInit } from "../src/init.js";
import { runJudgeEnable } from "../src/judge.js";
import { runRemove } from "../src/remove.js";
import { runTask } from "../src/task.js";
import { runTemplateApply, runTemplateStatus } from "../src/template-apply.js";
import { workflows } from "../src/types.js";
import { runUpgrade } from "../src/upgrade.js";
import { CLI_VERSION } from "../src/version.js";

import { tmp, useTempDir } from "./helpers/wep.js";

useTempDir();

async function createLocalTemplatePack(
  root: string,
  name: string,
  content: {
    config?: unknown;
    policy?: unknown;
    wiki?: Record<string, string>;
    skills?: Record<string, string>;
    rootInstructions?: string;
  },
): Promise<string> {
  const pack = path.join(root, `${name}-pack`);
  await mkdir(pack, { recursive: true });
  await writeFile(
    path.join(pack, "wep-pack.json"),
    JSON.stringify({ name, version: "1.0.0", wepPackVersion: 1 }),
    "utf8",
  );
  if (content.config) await writeFile(path.join(pack, "config.json"), JSON.stringify(content.config), "utf8");
  if (content.policy) await writeFile(path.join(pack, "policy.json"), JSON.stringify(content.policy), "utf8");
  for (const [filename, markdown] of Object.entries(content.wiki ?? {})) {
    await mkdir(path.join(pack, "wiki"), { recursive: true });
    await writeFile(path.join(pack, "wiki", filename), markdown, "utf8");
  }
  for (const [skill, markdown] of Object.entries(content.skills ?? {})) {
    await mkdir(path.join(pack, "target/skills", skill), { recursive: true });
    await writeFile(path.join(pack, "target/skills", skill, "SKILL.md"), markdown, "utf8");
  }
  if (content.rootInstructions !== undefined) {
    await mkdir(path.join(pack, "target"), { recursive: true });
    await writeFile(path.join(pack, "target/root-instructions.md"), content.rootInstructions, "utf8");
  }
  return pack;
}

describe("templates", () => {
  it("lists bundled template packs", async () => {
    const writes: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      writes.push(String(message));
    };

    try {
      await main(["node", "wep", "templates", "list", "--json"]);
    } finally {
      console.log = originalLog;
    }

    const parsed = JSON.parse(writes.join("\n"));
    expect(parsed.some((template: { name: string }) => template.name === "test-template")).toBe(true);
  });

  it("applies a local template after initialization without rerunning the harness", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const agentsBefore = await readFile(path.join(tmp, "AGENTS.md"), "utf8");
    const pack = await createLocalTemplatePack(tmp, "company-base", {
      config: { defaults: { workflow: "TDD" } },
      policy: { blockedReadPatterns: ["company-secrets/"] },
      wiki: { "company.md": "# Company rules\n" },
      skills: { "company-review": "# Company Review\n" },
    });

    const result = await runTemplateApply({
      cwd: tmp,
      templateRef: pack,
      local: true,
      nonInteractive: true,
    });
    const config = await readConfig(tmp);
    const policy = JSON.parse(await readFile(path.join(tmp, ".wep/policy.json"), "utf8"));

    expect(result.completed).toBe(true);
    expect(result.conflicts).toEqual([]);
    expect(await readFile(path.join(tmp, "AGENTS.md"), "utf8")).toBe(agentsBefore);
    expect(await pathExists(path.join(tmp, ".agents/skills/company-review/SKILL.md"))).toBe(true);
    expect(await pathExists(path.join(tmp, ".wep/wiki/company-base/company.md"))).toBe(true);
    expect(config?.defaults.workflow).toBe("TDD");
    expect(config?.templatePacks).toHaveLength(1);
    expect(config?.templatePacks[0].name).toBe("company-base");
    expect(config?.templatePacks[0].fileHashes[".agents/skills/company-review/SKILL.md"]).toMatch(/^sha256:/);
    expect(policy.blockedReadPatterns).toContain("company-secrets/");
  });

  it("exposes post-init apply and status through the CLI", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const pack = await createLocalTemplatePack(tmp, "cli-template", {
      skills: { "cli-template": "# CLI Template\n" },
    });
    const previousCwd = process.cwd();
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => logs.push(String(message));
    try {
      process.chdir(tmp);
      await main(["node", "wep", "templates", "apply", pack, "--local", "--json"]);
      const applied = JSON.parse(logs.join("\n"));
      expect(applied.completed).toBe(true);
      logs.length = 0;
      await main(["node", "wep", "templates", "status", "--json"]);
      const status = JSON.parse(logs.join("\n"));
      expect(status.templates[0].name).toBe("cli-template");
    } finally {
      process.chdir(previousCwd);
      console.log = originalLog;
    }
  });

  it("applies multiple templates sequentially and records both", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const base = await createLocalTemplatePack(tmp, "company-base", {
      skills: { "company-base": "# Base\n" },
    });
    const security = await createLocalTemplatePack(tmp, "security-rules", {
      policy: { blockedReadPatterns: ["security-private/"] },
      skills: { "security-rules": "# Security\n" },
    });

    await runTemplateApply({ cwd: tmp, templateRef: base, local: true, nonInteractive: true });
    await runTemplateApply({ cwd: tmp, templateRef: security, local: true, nonInteractive: true });
    const status = await runTemplateStatus({ cwd: tmp, nonInteractive: true });

    expect(status.templates.map((template) => template.name)).toEqual(["company-base", "security-rules"]);
    expect(await pathExists(path.join(tmp, ".agents/skills/company-base/SKILL.md"))).toBe(true);
    expect(await pathExists(path.join(tmp, ".agents/skills/security-rules/SKILL.md"))).toBe(true);
  });

  it("blocks transactionally on project-content conflicts and writes a versioned candidate", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    await mkdir(path.join(tmp, ".wep/wiki/testing-standard"), { recursive: true });
    await writeFile(path.join(tmp, ".wep/wiki/testing-standard/testing.md"), "# Existing project testing\n", "utf8");
    const pack = await createLocalTemplatePack(tmp, "testing-standard", {
      config: { defaults: { workflow: "TDD" } },
      wiki: { "testing.md": "# Required company testing\n" },
      skills: { "testing-standard": "# Testing Standard\n" },
    });

    const blocked = await runTemplateApply({ cwd: tmp, templateRef: pack, local: true, nonInteractive: true });
    const candidate = path.join(
      tmp,
      ".wep/template-candidates/testing-standard/1.0.0/.wep/wiki/testing-standard/testing.md",
    );

    expect(blocked.completed).toBe(false);
    expect(blocked.conflicts).toContain(".wep/wiki/testing-standard/testing.md");
    expect(await pathExists(candidate)).toBe(true);
    expect(await pathExists(path.join(tmp, ".agents/skills/testing-standard/SKILL.md"))).toBe(false);
    expect((await readConfig(tmp))?.defaults.workflow).toBe("task-fit");
    expect((await readConfig(tmp))?.templatePacks).toEqual([]);

    await writeFile(path.join(tmp, ".wep/wiki/testing-standard/testing.md"), await readFile(candidate));
    const applied = await runTemplateApply({ cwd: tmp, templateRef: pack, local: true, nonInteractive: true });

    expect(applied.completed).toBe(true);
    expect(await pathExists(path.join(tmp, ".agents/skills/testing-standard/SKILL.md"))).toBe(true);
    expect((await readConfig(tmp))?.defaults.workflow).toBe("TDD");
  });

  it("treats root instructions as a nonblocking human-approved merge", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const agentsBefore = await readFile(path.join(tmp, "AGENTS.md"), "utf8");
    const pack = await createLocalTemplatePack(tmp, "root-guidance", {
      rootInstructions: "# Company root guidance\n",
      skills: { "root-guidance": "# Root Guidance\n" },
    });

    const result = await runTemplateApply({ cwd: tmp, templateRef: pack, local: true, nonInteractive: true });

    expect(result.completed).toBe(true);
    expect(result.pendingMerges).toEqual(["AGENTS.md"]);
    expect(await readFile(path.join(tmp, "AGENTS.md"), "utf8")).toBe(agentsBefore);
    expect(await readFile(path.join(tmp, "AGENTS.wep.suggested.md"), "utf8")).toContain("Company root guidance");
    expect(await pathExists(path.join(tmp, ".agents/skills/root-guidance/SKILL.md"))).toBe(true);
  });

  it("blocks a second root proposal instead of replacing an existing suggestion", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const first = await createLocalTemplatePack(tmp, "first-root", {
      rootInstructions: "# First root\n",
    });
    const second = await createLocalTemplatePack(tmp, "second-root", {
      rootInstructions: "# Second root\n",
      skills: { "second-root": "# Second Root\n" },
    });
    await runTemplateApply({ cwd: tmp, templateRef: first, local: true, nonInteractive: true });

    const result = await runTemplateApply({ cwd: tmp, templateRef: second, local: true, nonInteractive: true });

    expect(result.completed).toBe(false);
    expect(result.conflicts).toContain("AGENTS.md");
    expect(await readFile(path.join(tmp, "AGENTS.wep.suggested.md"), "utf8")).toContain("First root");
    expect(await pathExists(path.join(tmp, ".wep/template-candidates/second-root/1.0.0/AGENTS.md"))).toBe(true);
    expect(await pathExists(path.join(tmp, ".agents/skills/second-root/SKILL.md"))).toBe(false);
  });

  it("supports dry-run, rejects force, and applies to all installed targets by default", async () => {
    await runInit({ cwd: tmp, target: "all", nonInteractive: true });
    const pack = await createLocalTemplatePack(tmp, "dry-template", {
      skills: { "dry-template": "# Dry\n" },
    });

    await expect(
      runTemplateApply({ cwd: tmp, templateRef: pack, local: true, target: "codex", force: true }),
    ).rejects.toThrow("does not support --force");

    const dryRun = await runTemplateApply({
      cwd: tmp,
      templateRef: pack,
      local: true,
      target: "codex",
      dryRun: true,
      nonInteractive: true,
    });
    expect(dryRun.completed).toBe(true);
    expect(await pathExists(path.join(tmp, ".agents/skills/dry-template/SKILL.md"))).toBe(false);
    expect((await readConfig(tmp))?.templatePacks).toEqual([]);

    const appliedAll = await runTemplateApply({ cwd: tmp, templateRef: pack, local: true, nonInteractive: true });
    expect(appliedAll.completed).toBe(true);
    expect(appliedAll.targets).toEqual(["codex", "claude", "copilot", "pi"]);
    expect(await pathExists(path.join(tmp, ".agents/skills/dry-template/SKILL.md"))).toBe(true);
    expect(await pathExists(path.join(tmp, ".claude/skills/dry-template/SKILL.md"))).toBe(true);
    expect(await pathExists(path.join(tmp, ".github/skills/dry-template/SKILL.md"))).toBe(true);
    expect(await pathExists(path.join(tmp, ".pi/skills/dry-template/SKILL.md"))).toBe(true);
  });

  it("requires an initialized project with valid provenance and policy", async () => {
    const pack = await createLocalTemplatePack(tmp, "requirements", {
      skills: { requirements: "# Requirements\n" },
    });
    await expect(runTemplateApply({ cwd: tmp, templateRef: pack, local: true, nonInteractive: true })).rejects.toThrow(
      "not installed",
    );

    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    await rm(path.join(tmp, ".wep/manifest.json"));
    await expect(runTemplateApply({ cwd: tmp, templateRef: pack, local: true, nonInteractive: true })).rejects.toThrow(
      "valid .wep/manifest.json",
    );

    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    await writeFile(path.join(tmp, ".wep/policy.json"), "[]\n", "utf8");
    await expect(runTemplateApply({ cwd: tmp, templateRef: pack, local: true, nonInteractive: true })).rejects.toThrow(
      "policy.json is invalid",
    );
  });

  it("keeps template-owned target files out of upgrade obsolete reports", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const pack = await createLocalTemplatePack(tmp, "upgrade-safe", {
      skills: { "upgrade-safe": "# Upgrade Safe\n" },
    });
    await runTemplateApply({ cwd: tmp, templateRef: pack, local: true, nonInteractive: true });

    const upgrade = await runUpgrade({ cwd: tmp, target: "codex", nonInteractive: true });

    expect(upgrade.obsolete).not.toContain(".agents/skills/upgrade-safe/SKILL.md");
    expect(await pathExists(path.join(tmp, ".agents/skills/upgrade-safe/SKILL.md"))).toBe(true);
  });
});

describe("remove", () => {
  it("defaults to dry-run when --force is not passed", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });

    const result = await runRemove({ cwd: tmp, target: "codex", dryRun: false, force: false, nonInteractive: true });

    expect(result.dryRun).toBe(true);
    expect(result.planned).toContain(".agents/skills/wep-doctor/SKILL.md");
    expect(await pathExists(path.join(tmp, ".agents/skills/wep-doctor/SKILL.md"))).toBe(true);
  });

  it("CLI remove defaults to dry-run without --force", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const previousCwd = process.cwd();
    const originalLog = console.log;
    console.log = () => {};

    try {
      process.chdir(tmp);
      await main(["node", "wep", "remove", "--target", "codex"]);
    } finally {
      process.chdir(previousCwd);
      console.log = originalLog;
    }

    expect(await pathExists(path.join(tmp, ".agents/skills/wep-doctor/SKILL.md"))).toBe(true);
  });

  it("dry-run lists files to remove without deleting them", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });

    const result = await runRemove({ cwd: tmp, target: "codex", dryRun: true, nonInteractive: true });

    expect(result.dryRun).toBe(true);
    expect(result.planned.length).toBeGreaterThan(0);
    // AGENTS.md is protected — should be skipped.
    expect(result.protected).toContain("AGENTS.md");
    // Files must still exist after dry-run.
    expect(await pathExists(path.join(tmp, ".agents/skills/wep-doctor/SKILL.md"))).toBe(true);
  });

  it("--force actually removes skill files", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });

    const result = await runRemove({ cwd: tmp, target: "codex", force: true, nonInteractive: true });

    expect(result.dryRun).toBe(false);
    expect(result.planned).toContain(".agents/skills/wep-doctor/SKILL.md");
    expect(result.planned).toContain(".agents/skills/wep-doctor/");
    expect(await pathExists(path.join(tmp, ".agents/skills/wep-doctor/SKILL.md"))).toBe(false);
    expect(await pathExists(path.join(tmp, ".agents/skills/wep-doctor"))).toBe(false);
    // Protected file must survive.
    expect(await pathExists(path.join(tmp, "AGENTS.md"))).toBe(true);
  });

  it("does not prune directories that contain non-wep user files", async () => {
    await runInit({ cwd: tmp, target: "copilot", nonInteractive: true });
    await writeFile(path.join(tmp, ".github/skills/wep-doctor/notes.md"), "# Keep me\n", "utf8");

    await runRemove({ cwd: tmp, target: "copilot", force: true, nonInteractive: true });

    expect(await pathExists(path.join(tmp, ".github/skills/wep-doctor/SKILL.md"))).toBe(false);
    expect(await pathExists(path.join(tmp, ".github/skills/wep-doctor/notes.md"))).toBe(true);
    expect(await pathExists(path.join(tmp, ".github/skills/wep-doctor"))).toBe(true);
  });

  it("dry-run planned matches the actual run's planned for a real target", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });

    const dryRunResult = await runRemove({ cwd: tmp, target: "codex", dryRun: true, nonInteractive: true });
    const realResult = await runRemove({ cwd: tmp, target: "codex", force: true, nonInteractive: true });

    expect(dryRunResult.planned.slice().sort()).toEqual(realResult.planned.slice().sort());
  });

  it("--all --force removes .wep directory", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });

    await runRemove({ cwd: tmp, force: true, all: true, nonInteractive: true } as Parameters<typeof runRemove>[0]);

    expect(await pathExists(path.join(tmp, ".wep"))).toBe(false);
  });

  it("--all unwires tracing for every target before removing its config", async () => {
    await runInit({ cwd: tmp, target: "all", nonInteractive: true });
    const claudeSettings = path.join(tmp, ".claude/settings.json");
    await mkdir(path.dirname(claudeSettings), { recursive: true });
    await writeFile(
      claudeSettings,
      JSON.stringify({
        model: "keep-me",
        hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "foreign-pre" }] }] },
      }),
      "utf8",
    );
    const { runTraceEnable } = await import("../src/hook/install.js");
    await runTraceEnable({ cwd: tmp, nonInteractive: true });

    const result = await runRemove({ cwd: tmp, force: true, all: true, purgeLocal: true, nonInteractive: true });

    expect(await pathExists(path.join(tmp, ".wep/config.json"))).toBe(false);
    const preservedClaude = await readFile(claudeSettings, "utf8");
    expect(preservedClaude).toContain("foreign-pre");
    expect(preservedClaude).toContain("keep-me");
    expect(preservedClaude).not.toContain("--wep-trace");
    expect(await readFile(path.join(tmp, ".codex/hooks.json"), "utf8")).not.toContain("--wep-trace");
    expect(await readFile(path.join(tmp, ".github/hooks/wep-trace.json"), "utf8")).not.toContain("--wep-trace");
    expect(await pathExists(path.join(tmp, ".pi/extensions/wep-trace.ts"))).toBe(false);
    expect(result.updated).toEqual(
      expect.arrayContaining([
        ".claude/settings.json",
        ".codex/hooks.json",
        ".github/hooks/wep-trace.json",
        ".pi/extensions/wep-trace.ts",
      ]),
    );
  });

  it("--all dry-run plans trace cleanup without changing hooks", async () => {
    await runInit({ cwd: tmp, target: "all", nonInteractive: true });
    const { runTraceEnable } = await import("../src/hook/install.js");
    await runTraceEnable({ cwd: tmp, nonInteractive: true });
    const settingsPath = path.join(tmp, ".claude/settings.json");
    const before = await readFile(settingsPath, "utf8");

    const result = await runRemove({ cwd: tmp, all: true, nonInteractive: true });

    expect(result.dryRun).toBe(true);
    expect(result.updated).toContain(".claude/settings.json");
    expect(await readFile(settingsPath, "utf8")).toBe(before);
    expect(await pathExists(path.join(tmp, ".wep/config.json"))).toBe(true);
    expect(await pathExists(path.join(tmp, ".pi/extensions/wep-trace.ts"))).toBe(true);
  });

  it("--all preserves a foreign Pi extension at the trace path", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const extensionPath = path.join(tmp, ".pi/extensions/wep-trace.ts");
    await mkdir(path.dirname(extensionPath), { recursive: true });
    await writeFile(extensionPath, "// foreign extension with a coincidental filename\n", "utf8");

    await runRemove({ cwd: tmp, force: true, all: true, nonInteractive: true });

    expect(await readFile(extensionPath, "utf8")).toBe("// foreign extension with a coincidental filename\n");
  });

  it("--all --force preserves .wep/tasks/ when task capsules exist", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const task = await runTask("Fix auth bug", { cwd: tmp, nonInteractive: true });

    const result = await runRemove({
      cwd: tmp,
      force: true,
      all: true,
      nonInteractive: true,
    } as Parameters<typeof runRemove>[0]);

    expect(await pathExists(path.join(tmp, task.taskDir))).toBe(true);
    expect(await pathExists(path.join(tmp, ".wep/config.json"))).toBe(false);
    expect(result.protected.some((p) => p.includes(".wep/tasks/"))).toBe(true);
  });

  it("--all --purge-tasks --force removes everything including task capsules", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const task = await runTask("Fix auth bug", { cwd: tmp, nonInteractive: true });

    await runRemove({
      cwd: tmp,
      force: true,
      all: true,
      purgeTasks: true,
      nonInteractive: true,
    } as Parameters<typeof runRemove>[0]);

    expect(await pathExists(path.join(tmp, task.taskDir))).toBe(false);
    expect(await pathExists(path.join(tmp, ".wep"))).toBe(false);
  });

  it("--all preserves personal comprehension records unless --purge-local is used", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const recordPath = path.join(tmp, ".wep/local/comprehension/TASK-001/session/result.json");
    await mkdir(path.dirname(recordPath), { recursive: true });
    await writeFile(recordPath, "{}\n", "utf8");

    const result = await runRemove({ cwd: tmp, force: true, all: true, nonInteractive: true });

    expect(await pathExists(recordPath)).toBe(true);
    expect(result.protected.some((entry) => entry.includes("--purge-local"))).toBe(true);

    await runRemove({ cwd: tmp, force: true, all: true, purgeLocal: true, nonInteractive: true });
    expect(await pathExists(path.join(tmp, ".wep/local"))).toBe(false);
  });

  it("--all dry-run treats the upgrade ledger as removable runtime state", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    await writeFile(path.join(tmp, ".wep/manifest.json"), "{ invalid manifest\n", "utf8");
    await runUpgrade({ cwd: tmp, target: "codex", nonInteractive: true });
    const ledgerPath = path.join(tmp, ".wep/local/upgrade-candidates.json");
    expect(await pathExists(ledgerPath)).toBe(true);

    const preview = await runRemove({ cwd: tmp, all: true, nonInteractive: true });
    expect(await pathExists(ledgerPath)).toBe(true);
    const actual = await runRemove({ cwd: tmp, all: true, force: true, nonInteractive: true });

    expect(preview.planned.slice().sort()).toEqual(actual.planned.slice().sort());
    expect(await pathExists(ledgerPath)).toBe(false);
    expect(await pathExists(path.join(tmp, ".wep"))).toBe(false);
  });

  it("removes the optional comprehension agent with its target adapter", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    await runComprehensionEnable({ cwd: tmp, nonInteractive: true });
    const agentPath = path.join(tmp, ".codex/agents/wep-comprehension.toml");
    expect(await pathExists(agentPath)).toBe(true);

    await runRemove({ cwd: tmp, target: "codex", force: true, nonInteractive: true });

    expect(await pathExists(agentPath)).toBe(false);
  });
});

describe("skill content contract", () => {
  it("installed workflow skill contains every workflow name and UI review", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });

    const skill = await readFile(path.join(tmp, ".agents/skills/wep-workflow/SKILL.md"), "utf8");

    for (const w of workflows) {
      expect(skill, `skill missing workflow: ${w}`).toContain(w);
    }
    expect(skill, "skill missing UI review").toContain("UI review");
  });

  it("teaches immutable review snapshots without authorizing Git mutations", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    await runJudgeEnable({ cwd: tmp, nonInteractive: true });

    const workflow = await readFile(path.join(tmp, ".agents/skills/wep-workflow/SKILL.md"), "utf8");
    const judge = await readFile(path.join(tmp, ".codex/agents/wep-judge.toml"), "utf8");
    const contract = await readFile(path.join(tmp, ".wep/judge/README.md"), "utf8");

    expect(workflow).toContain("wep judge snapshot TASK-XXX");
    expect(workflow).toContain("never commits, stages, stashes, checks out, creates a branch or ref");
    expect(judge).toContain(".wep/local/judge/snapshots/<id>/worktree");
    expect(contract).toContain("CURRENT");
    expect(contract).toContain("NEWER_CHANGES");
    expect(contract).toContain("DIVERGED");
  });

  it("installs comprehension as an independent agent instead of a main-context skill", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    await runComprehensionEnable({ cwd: tmp, nonInteractive: true });

    const agent = await readFile(path.join(tmp, ".codex/agents/wep-comprehension.toml"), "utf8");

    expect(agent).toContain('sandbox_mode = "read-only"');
    expect(agent).toContain('model_reasoning_effort = "high"');
    expect(agent).toContain("Do not inherit the implementing agent's reasoning");
    expect(agent).toContain("wep judge current <review.json> --json");
    expect(agent).toContain("current state is 'CURRENT'");
    expect(agent).toContain("Ask one question at a time");
    expect(agent).toContain("Mermaid");
    expect(agent).toContain("test matrix");
    expect(agent).toContain("INVALID_GATE");
    expect(await pathExists(path.join(tmp, ".agents/skills/wep-comprehension/SKILL.md"))).toBe(false);
  });

  it("defines versioned schemas for scope, frozen rubric, and result", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });

    const scope = JSON.parse(await readFile(path.join(tmp, ".wep/comprehension/schemas/scope.schema.json"), "utf8"));
    const rubric = JSON.parse(await readFile(path.join(tmp, ".wep/comprehension/schemas/rubric.schema.json"), "utf8"));
    const result = JSON.parse(await readFile(path.join(tmp, ".wep/comprehension/schemas/result.schema.json"), "utf8"));

    expect(scope.required).toContain("decision");
    expect(rubric.properties.createdBeforeAnswers.const).toBe(true);
    expect(rubric.properties.questions.maxItems).toBe(6);
    expect(result.properties.evaluationMode.enum).toEqual(["independent", "fresh-context"]);
  });

  it("config.json records the CLI version that installed the harness", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });

    const config = await readConfig(tmp);
    expect(config?.installedVersion).toBe(CLI_VERSION);
  });

  it("wiki/overview.md includes project name and installed targets", async () => {
    await writeFile(path.join(tmp, "package.json"), JSON.stringify({ name: "my-app" }), "utf8");
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });

    const overview = await readFile(path.join(tmp, ".wep/wiki/overview.md"), "utf8");
    expect(overview).toContain("my-app");
    expect(overview).toContain("codex");
    expect(overview).toContain(CLI_VERSION);
  });

  it("wiki/overview.md falls back to directory name when no package.json exists", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });

    const overview = await readFile(path.join(tmp, ".wep/wiki/overview.md"), "utf8");
    expect(overview).toContain(path.basename(tmp));
  });
});
