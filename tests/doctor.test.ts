import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { isLocalIgnoreContentSafe } from "../src/comprehension.js";
import { runDoctor } from "../src/doctor.js";
import { pathExists } from "../src/fs-utils.js";
import { runInit } from "../src/init.js";
import { runTask } from "../src/task.js";
import { lintWiki } from "../src/wiki-lint.js";

import { tmp, useTempDir } from "./helpers/wep.js";

useTempDir();

describe("doctor", () => {
  it("reports installed targets and writes agent setup wiki", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });

    const result = await runDoctor({ cwd: tmp, nonInteractive: true });

    expect(result.installed).toBe(true);
    expect(result.installedTargets).toContain("codex");
    expect(result.readiness).toBeGreaterThan(50);
    expect(await pathExists(path.join(tmp, ".wep/wiki/agent-setup.md"))).toBe(true);
  });

  it("reports 100 readiness for a complete single-target install", async () => {
    await runInit({ cwd: tmp, target: "copilot", nonInteractive: true });

    const result = await runDoctor({ cwd: tmp, nonInteractive: true });

    expect(result.installed).toBe(true);
    expect(result.installedTargets).toEqual(["copilot"]);
    expect(result.readiness).toBe(100);
  });

  it("prints the installed target in the suggested doctor prompt", async () => {
    await runInit({ cwd: tmp, target: "pi", nonInteractive: true });
    const previousCwd = process.cwd();
    const writes: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      writes.push(String(message));
    };

    try {
      process.chdir(tmp);
      await main(["node", "wep", "doctor"]);
    } finally {
      process.chdir(previousCwd);
      console.log = originalLog;
    }

    expect(writes.join("\n")).toContain("Suggested Pi Code prompt:");
    expect(writes.join("\n")).not.toContain("Suggested Codex prompt:");
  });

  describe("capsule implementation logs", () => {
    async function capsuleWithLog(): Promise<{ taskDir: string; logPath: string }> {
      await runInit({ cwd: tmp, target: "copilot", nonInteractive: true });
      const task = await runTask("Fix auth bug", { cwd: tmp, nonInteractive: true });
      const logPath = path.join(tmp, task.taskDir, "log.md");
      await writeFile(logPath, "# Implementation log\n\nOld-policy notes.\n", "utf8");
      return { taskDir: task.taskDir, logPath };
    }

    it("reports a capsule that holds log.md, names the task and the reviewed boundary", async () => {
      const { taskDir } = await capsuleWithLog();

      const result = await runDoctor({ cwd: tmp, nonInteractive: true });

      expect(result.capsuleLogs).toEqual([{ taskId: "TASK-001", path: `${taskDir}/log.md` }]);
      const warning = result.suggestions.find((s) => s.text.includes(`${taskDir}/log.md`));
      expect(warning?.severity).toBe("warning");
      expect(warning?.text).toContain("TASK-001");
      expect(warning?.text).toContain("inside the reviewed boundary");
      expect(warning?.text).toContain(".wep/local/impl/TASK-001/log.md");
    });

    it("keeps every other axis clean when a capsule holds log.md", async () => {
      await capsuleWithLog();

      const result = await runDoctor({ cwd: tmp, nonInteractive: true });

      expect(result.readiness).toBe(100);
      expect(result.missing).toEqual([]);
      expect(result.conflicts).toEqual([]);
      expect(result.suggestions.filter((s) => s.severity === "error")).toEqual([]);
    });

    it.each([false, true])("never moves or rewrites the log (fix: %s)", async (fix) => {
      const { logPath } = await capsuleWithLog();
      const before = await readFile(logPath, "utf8");

      await runDoctor({ cwd: tmp, fix, nonInteractive: true });

      expect(await readFile(logPath, "utf8")).toBe(before);
      expect(await pathExists(path.join(tmp, ".wep/local/impl/TASK-001/log.md"))).toBe(false);
    });

    it("reports nothing when no capsule holds log.md", async () => {
      await runInit({ cwd: tmp, target: "copilot", nonInteractive: true });
      await runTask("Fix auth bug", { cwd: tmp, nonInteractive: true });

      const result = await runDoctor({ cwd: tmp, nonInteractive: true });

      expect(result.capsuleLogs).toEqual([]);
      expect(result.suggestions.some((s) => s.text.includes("log.md"))).toBe(false);
    });
  });

  it("provides actionable suggestions when not installed", async () => {
    const result = await runDoctor({ cwd: tmp, nonInteractive: true });

    expect(result.installed).toBe(false);
    expect(result.readiness).toBe(0);
    expect(result.suggestions[0].text).toContain("wep init");
  });

  it("reports policy gaps when required enforcement is relaxed", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });

    const policyPath = path.join(tmp, ".wep/policy.json");
    const policy = JSON.parse(await readFile(policyPath, "utf8"));
    policy.enforcement.requireTaskCapsule = false;
    policy.protectedFiles = policy.protectedFiles.filter((file: string) => file !== "AGENTS.md");
    await writeFile(policyPath, JSON.stringify(policy, null, 2), "utf8");

    const result = await runDoctor({ cwd: tmp, nonInteractive: true });

    expect(result.missing).toContain(".wep/policy.json — enforcement.requireTaskCapsule must be true");
    expect(result.missing).toContain(".wep/policy.json — protectedFiles missing AGENTS.md");
    expect(result.suggestions.some((suggestion) => suggestion.text.includes("file(s) missing"))).toBe(true);
  });

  it("reports an unsafe or missing protected-file merge approval contract", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const policyPath = path.join(tmp, ".wep/policy.json");
    const policy = JSON.parse(await readFile(policyPath, "utf8"));
    policy.protectedFileMerge = {
      agentMayEdit: "always",
      approvalScope: "any-conversation",
      requireDiffPreview: false,
    };
    await writeFile(policyPath, JSON.stringify(policy, null, 2), "utf8");

    const result = await runDoctor({ cwd: tmp, nonInteractive: true });

    expect(result.missing).toContain(
      ".wep/policy.json — protectedFileMerge.agentMayEdit must require explicit human approval",
    );
    expect(result.missing).toContain(
      ".wep/policy.json — protectedFileMerge.approvalScope must be current-conversation",
    );
    expect(result.missing).toContain(".wep/policy.json — protectedFileMerge.requireDiffPreview must be true");
  });

  it("reports profile-specific policy gaps", async () => {
    await runInit({ cwd: tmp, target: "codex", profile: "regulated", nonInteractive: true });

    const policyPath = path.join(tmp, ".wep/policy.json");
    const policy = JSON.parse(await readFile(policyPath, "utf8"));
    policy.blockedReadPatterns = policy.blockedReadPatterns.filter((pattern: string) => pattern !== "compliance/");
    await writeFile(policyPath, JSON.stringify(policy, null, 2), "utf8");

    const result = await runDoctor({ cwd: tmp, nonInteractive: true });

    expect(result.missing).toContain(".wep/policy.json — blockedReadPatterns missing compliance/");
  });

  it("doctor --ci fails when wep is not installed", async () => {
    const previousCwd = process.cwd();
    const previousExitCode = process.exitCode;
    const writes: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      writes.push(String(message));
    };

    try {
      process.exitCode = undefined;
      process.chdir(tmp);
      await main(["node", "wep", "doctor", "--ci"]);
    } finally {
      process.chdir(previousCwd);
      console.log = originalLog;
    }

    expect(process.exitCode).toBe(1);
    expect(writes.join("\n")).toContain("wep doctor CI failed");
    process.exitCode = previousExitCode;
  });

  it("doctor --ci passes for a complete install", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const previousCwd = process.cwd();
    const previousExitCode = process.exitCode;
    const writes: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      writes.push(String(message));
    };

    try {
      process.exitCode = undefined;
      process.chdir(tmp);
      await main(["node", "wep", "doctor", "--ci"]);
    } finally {
      process.chdir(previousCwd);
      console.log = originalLog;
    }

    expect(process.exitCode).toBeUndefined();
    expect(writes.join("\n")).toContain("wep doctor CI passed");
    process.exitCode = previousExitCode;
  });

  it("doctor --ci passes even when installedVersion drifts from CLI_VERSION (warning, not error)", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const configPath = path.join(tmp, ".wep/config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.installedVersion = "0.0.1";
    await writeFile(configPath, JSON.stringify(config, null, 2), "utf8");

    const previousCwd = process.cwd();
    const previousExitCode = process.exitCode;
    const writes: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      writes.push(String(message));
    };

    try {
      process.exitCode = undefined;
      process.chdir(tmp);
      await main(["node", "wep", "doctor", "--ci"]);
    } finally {
      process.chdir(previousCwd);
      console.log = originalLog;
    }

    expect(process.exitCode).toBeUndefined();
    expect(writes.join("\n")).toContain("wep doctor CI passed");
    process.exitCode = previousExitCode;
  });

  it("doctor --ci fails when required files are missing", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    await rm(path.join(tmp, ".agents/skills/wep-workflow/SKILL.md"), { force: true });
    const previousCwd = process.cwd();
    const previousExitCode = process.exitCode;
    const originalLog = console.log;
    console.log = () => {};

    try {
      process.exitCode = undefined;
      process.chdir(tmp);
      await main(["node", "wep", "doctor", "--ci"]);
    } finally {
      process.chdir(previousCwd);
      console.log = originalLog;
    }

    expect(process.exitCode).toBe(1);
    process.exitCode = previousExitCode;
  });

  it("doctor --ci --json includes CI status", async () => {
    const previousCwd = process.cwd();
    const previousExitCode = process.exitCode;
    const writes: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      writes.push(String(message));
    };

    try {
      process.exitCode = undefined;
      process.chdir(tmp);
      await main(["node", "wep", "doctor", "--ci", "--json"]);
    } finally {
      process.chdir(previousCwd);
      console.log = originalLog;
    }

    const parsed = JSON.parse(writes.join("\n"));
    expect(parsed.ci.passed).toBe(false);
    expect(parsed.ci.failureCount).toBeGreaterThan(0);
    expect(process.exitCode).toBe(1);
    process.exitCode = previousExitCode;
  });

  it("doctor --ci passes when the only issue is a wiki-lint warning, not an error", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const archPath = path.join(tmp, ".wep/wiki/architecture.md");
    const arch = await readFile(archPath, "utf8");
    await writeFile(archPath, arch.replace(/^timestamp:.*\n/m, ""), "utf8");

    const result = await runDoctor({ cwd: tmp, nonInteractive: true });
    expect(result.missing.some((m) => m.includes("architecture.md"))).toBe(false);
    expect(result.suggestions.some((s) => s.severity === "warning" && s.text.includes("Wiki lint"))).toBe(true);

    const previousCwd = process.cwd();
    const previousExitCode = process.exitCode;
    const originalLog = console.log;
    console.log = () => {};
    try {
      process.exitCode = undefined;
      process.chdir(tmp);
      await main(["node", "wep", "doctor", "--ci"]);
    } finally {
      process.chdir(previousCwd);
      console.log = originalLog;
    }
    expect(process.exitCode).toBeUndefined();
    process.exitCode = previousExitCode;
  });

  it("weights readiness score by category: wiki-lint issues cost less than missing harness files", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const archPath = path.join(tmp, ".wep/wiki/architecture.md");
    const arch = await readFile(archPath, "utf8");
    await writeFile(archPath, arch.replace(/^timestamp:.*\n/m, ""), "utf8");

    const wikiLintOnly = await runDoctor({ cwd: tmp, nonInteractive: true });
    expect(wikiLintOnly.readiness).toBe(99);

    await rm(path.join(tmp, ".agents/skills/wep-workflow/SKILL.md"), { force: true });
    const withMissingHarnessFile = await runDoctor({ cwd: tmp, nonInteractive: true });
    expect(withMissingHarnessFile.readiness).toBeLessThan(wikiLintOnly.readiness);
  });

  it("writes gaps.md and recommendations.md with OKF-style frontmatter", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });

    const result = await runDoctor({ cwd: tmp, nonInteractive: true });

    expect(result.installed).toBe(true);
    expect(await pathExists(path.join(tmp, ".wep/wiki/gaps.md"))).toBe(true);
    expect(await pathExists(path.join(tmp, ".wep/wiki/recommendations.md"))).toBe(true);

    const gaps = await readFile(path.join(tmp, ".wep/wiki/gaps.md"), "utf8");
    expect(gaps).toMatch(/^---\n/);
    expect(gaps).toContain("type: wep-wiki-gaps");
    expect(gaps).toContain("# Gaps");

    const recommendations = await readFile(path.join(tmp, ".wep/wiki/recommendations.md"), "utf8");
    expect(recommendations).toMatch(/^---\n/);
    expect(recommendations).toContain("type: wep-wiki-recommendations");
    expect(recommendations).toContain("# Recommendations");
  });

  it("preserves the semantic instruction audit when CLI Doctor regenerates mechanical reports", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const auditPath = path.join(tmp, ".wep/wiki/instruction-audit.md");
    const semanticAudit = "# Instruction Audit\n\n- move: scope the TypeScript rule to src/**/*.ts\n";
    await writeFile(auditPath, semanticAudit, "utf8");

    await runDoctor({ cwd: tmp, nonInteractive: true });

    expect(await readFile(auditPath, "utf8")).toBe(semanticAudit);
  });

  it("partitions gaps into missing files, config gaps, and policy gaps", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    await rm(path.join(tmp, ".agents/skills/wep-workflow/SKILL.md"), { force: true });

    const policyPath = path.join(tmp, ".wep/policy.json");
    const policy = JSON.parse(await readFile(policyPath, "utf8"));
    policy.enforcement.requireTaskCapsule = false;
    await writeFile(policyPath, JSON.stringify(policy, null, 2), "utf8");

    await runDoctor({ cwd: tmp, nonInteractive: true });

    const gaps = await readFile(path.join(tmp, ".wep/wiki/gaps.md"), "utf8");
    expect(gaps).toContain("## Missing files");
    expect(gaps).toContain(".agents/skills/wep-workflow/SKILL.md");
    expect(gaps).toContain("## Policy gaps");
    expect(gaps).toContain(".wep/policy.json — enforcement.requireTaskCapsule must be true");
  });

  it("reports wiki lint issues including broken links and missing timestamps", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });

    await rm(path.join(tmp, ".wep/wiki/overview.md"), { force: true });

    const archPath = path.join(tmp, ".wep/wiki/architecture.md");
    const arch = await readFile(archPath, "utf8");
    await writeFile(archPath, arch.replace(/^timestamp:.*\n/m, ""), "utf8");

    const result = await runDoctor({ cwd: tmp, nonInteractive: true });

    expect(result.wikiLint?.brokenLinks.length).toBeGreaterThan(0);
    expect(result.wikiLint?.brokenLinks.some((issue) => issue.message.includes("/wiki/overview.md"))).toBe(true);
    expect(result.wikiLint?.missingTimestamps.length).toBeGreaterThan(0);
    expect(result.wikiLint?.missingTimestamps.some((issue) => issue.file.includes("architecture.md"))).toBe(true);

    const gaps = await readFile(path.join(tmp, ".wep/wiki/gaps.md"), "utf8");
    expect(gaps).toContain("Wiki lint: broken links");
    expect(gaps).toContain("Wiki lint: missing timestamps");
  });
});

describe("wiki-lint", () => {
  it("does not flag a valid timestamp when frontmatter uses CRLF line endings", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const archPath = path.join(tmp, ".wep/wiki/architecture.md");
    const arch = await readFile(archPath, "utf8");
    await writeFile(archPath, arch.replace(/\n/g, "\r\n"), "utf8");

    const result = await lintWiki(tmp);

    expect(result.missingTimestamps.some((issue) => issue.file.includes("architecture.md"))).toBe(false);
  });

  it("does not flag a link with an anchor fragment as broken", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const archPath = path.join(tmp, ".wep/wiki/architecture.md");
    const arch = await readFile(archPath, "utf8");
    await writeFile(archPath, `${arch}\n[Quick Reference](/wiki/overview.md#quick-reference)\n`, "utf8");

    const result = await lintWiki(tmp);

    expect(result.brokenLinks.some((issue) => issue.message.includes("overview.md#quick-reference"))).toBe(false);
  });

  it("flags a link with an anchor fragment to a missing file as broken", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const archPath = path.join(tmp, ".wep/wiki/architecture.md");
    const arch = await readFile(archPath, "utf8");
    await writeFile(archPath, `${arch}\n[Missing](/wiki/missing.md#x)\n`, "utf8");

    const result = await lintWiki(tmp);

    expect(result.brokenLinks.some((issue) => issue.message.includes("missing.md#x"))).toBe(true);
  });
});

describe("doctor --fix", () => {
  it("recreates missing harness files", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    await rm(path.join(tmp, ".agents/skills/wep-doctor/SKILL.md"), { force: true });

    const result = await runDoctor({ cwd: tmp, fix: true, nonInteractive: true });

    expect(result.fixed?.some((f) => f.includes("wep-doctor/SKILL.md"))).toBe(true);
    expect(await pathExists(path.join(tmp, ".agents/skills/wep-doctor/SKILL.md"))).toBe(true);
  });

  it.each([
    // The config is written through JSON.stringify, which omits undefined values, so the
    // first case really does produce a file with no `targets` key at all.
    ["absent", (config: Record<string, unknown>) => Object.assign(config, { targets: undefined })],
    ["empty", (config: Record<string, unknown>) => Object.assign(config, { targets: [] })],
    ["unrecognizable", (config: Record<string, unknown>) => Object.assign(config, { targets: ["not-an-agent"] })],
  ])("leaves a config whose targets list is %s untouched and keeps the gap", async (_label, damage) => {
    await runInit({ cwd: tmp, target: "claude", nonInteractive: true });
    const configPath = path.join(tmp, ".wep/config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    damage(config);
    await writeFile(configPath, JSON.stringify(config, null, 2), "utf8");

    await expect(runDoctor({ cwd: tmp, fix: true, nonInteractive: true })).rejects.toThrow("no recognized target");

    // Repair must not answer "which agent is this repository for?" by guessing.
    const repaired = JSON.parse(await readFile(configPath, "utf8"));
    expect(repaired.targets ?? []).not.toContain("codex");
    const result = await runDoctor({ cwd: tmp, nonInteractive: true });
    expect(result.missing).toContain(".wep/config.json — targets must list at least one supported target");
    expect(result.readiness).toBeLessThan(100);
  });

  it("repairs a partly invalid targets list from the entries it can trust", async () => {
    await runInit({ cwd: tmp, target: "claude", nonInteractive: true });
    const configPath = path.join(tmp, ".wep/config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.targets = ["claude", "not-an-agent"];
    await writeFile(configPath, JSON.stringify(config, null, 2), "utf8");

    await runDoctor({ cwd: tmp, fix: true, nonInteractive: true });

    expect(JSON.parse(await readFile(configPath, "utf8")).targets).toEqual(["claude"]);
  });

  it("repairs config gaps without overwriting user values", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const configPath = path.join(tmp, ".wep/config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.workflowRules = undefined;
    config.defaults.allowedWorkflows = undefined;
    config.defaults.workflow = "TDD";
    await writeFile(configPath, JSON.stringify(config, null, 2), "utf8");

    const result = await runDoctor({ cwd: tmp, fix: true, nonInteractive: true });

    expect(result.fixed).toContain(".wep/config.json");
    const fixed = JSON.parse(await readFile(configPath, "utf8"));
    expect(fixed.defaults.workflow).toBe("TDD");
    expect(fixed.defaults.allowedWorkflows).toBeDefined();
    expect(fixed.workflowRules).toBeDefined();
  });

  it("repairs policy gaps by merging missing keys", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const policyPath = path.join(tmp, ".wep/policy.json");
    const policy = JSON.parse(await readFile(policyPath, "utf8"));
    policy.writePolicy = undefined;
    policy.protectedFileMerge = undefined;
    policy.blockedReadPatterns = [".env"];
    await writeFile(policyPath, JSON.stringify(policy, null, 2), "utf8");

    const result = await runDoctor({ cwd: tmp, fix: true, nonInteractive: true });

    expect(result.fixed).toContain(".wep/policy.json");
    const fixed = JSON.parse(await readFile(policyPath, "utf8"));
    expect(fixed.writePolicy).toBeDefined();
    expect(fixed.protectedFileMerge).toEqual({
      agentMayEdit: "after-explicit-human-approval",
      approvalScope: "current-conversation",
      requireDiffPreview: true,
    });
    expect(fixed.blockedReadPatterns).toContain(".env");
    expect(fixed.blockedReadPatterns).toContain("*.pem");
  });

  it("detects and repairs an unsafe local comprehension ignore file", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const ignorePath = path.join(tmp, ".wep/local/.gitignore");
    await writeFile(ignorePath, "# no ignore rules\n", "utf8");

    const diagnosis = await runDoctor({ cwd: tmp, nonInteractive: true });
    expect(diagnosis.missing.some((gap) => gap.includes("must ignore local records"))).toBe(true);

    const fixed = await runDoctor({ cwd: tmp, fix: true, nonInteractive: true });
    expect(fixed.fixed).toContain(".wep/local/.gitignore");
    expect(isLocalIgnoreContentSafe(await readFile(ignorePath, "utf8"))).toBe(true);
  });

  it("repairs invalid comprehension gate configuration", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const configPath = path.join(tmp, ".wep/config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.comprehensionGate = { enabled: true, trigger: "always", evaluationMode: "same-session" };
    await writeFile(configPath, JSON.stringify(config, null, 2), "utf8");

    const diagnosis = await runDoctor({ cwd: tmp, nonInteractive: true });
    expect(diagnosis.missing.some((gap) => gap.includes("comprehensionGate.trigger"))).toBe(false);
    expect(
      diagnosis.suggestions.some(
        (suggestion) => suggestion.severity === "warning" && suggestion.text.includes('trigger is "always"'),
      ),
    ).toBe(true);

    await runDoctor({ cwd: tmp, fix: true, nonInteractive: true });
    const repaired = JSON.parse(await readFile(configPath, "utf8"));
    expect(repaired.comprehensionGate).toEqual({
      enabled: true,
      trigger: "always",
      evaluationMode: "prefer-independent",
    });
  });

  it("repairs missing files across all installed targets, not just the first", async () => {
    await runInit({ cwd: tmp, target: "all", nonInteractive: true });
    await rm(path.join(tmp, ".claude/skills/wep-doctor/SKILL.md"), { force: true });
    await rm(path.join(tmp, ".pi/skills/wep-doctor/SKILL.md"), { force: true });

    const result = await runDoctor({ cwd: tmp, fix: true, nonInteractive: true });

    expect(result.fixed?.some((f) => f.includes(".claude/skills/wep-doctor/SKILL.md"))).toBe(true);
    expect(result.fixed?.some((f) => f.includes(".pi/skills/wep-doctor/SKILL.md"))).toBe(true);
    expect(await pathExists(path.join(tmp, ".claude/skills/wep-doctor/SKILL.md"))).toBe(true);
    expect(await pathExists(path.join(tmp, ".pi/skills/wep-doctor/SKILL.md"))).toBe(true);
  });

  it("reports nothing fixed for a healthy setup", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });

    const result = await runDoctor({ cwd: tmp, fix: true, nonInteractive: true });

    expect(result.fixed).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(await pathExists(path.join(tmp, "AGENTS.wep.suggested.md"))).toBe(false);
  });

  it("repairs a missing skill without creating a protected-file merge suggestion", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    await rm(path.join(tmp, ".agents/skills/wep-doctor/SKILL.md"), { force: true });

    const result = await runDoctor({ cwd: tmp, fix: true, nonInteractive: true });

    expect(result.fixed).toContain(".agents/skills/wep-doctor/SKILL.md");
    expect(result.conflicts).toEqual([]);
    expect(await pathExists(path.join(tmp, "AGENTS.wep.suggested.md"))).toBe(false);
  });

  it("never treats doctor --fix as approval to modify a protected instruction", async () => {
    await writeFile(path.join(tmp, "AGENTS.md"), "# Project-owned instructions\n", "utf8");
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const before = await readFile(path.join(tmp, "AGENTS.md"), "utf8");
    const wikiPath = path.join(tmp, ".wep/wiki/architecture.md");
    await writeFile(wikiPath, "# Project-owned architecture\n", "utf8");

    const result = await runDoctor({ cwd: tmp, fix: true, force: true, nonInteractive: true });

    expect(await readFile(path.join(tmp, "AGENTS.md"), "utf8")).toBe(before);
    expect(await readFile(wikiPath, "utf8")).toBe("# Project-owned architecture\n");
    expect(await pathExists(path.join(tmp, "AGENTS.wep.suggested.md"))).toBe(true);
    expect(result.conflicts.some((conflict) => conflict.includes("AGENTS.wep.suggested.md"))).toBe(true);
  });

  it("dry-run fix does not write files but reports what would be fixed", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    await rm(path.join(tmp, ".agents/skills/wep-doctor/SKILL.md"), { force: true });

    const result = await runDoctor({ cwd: tmp, fix: true, dryRun: true, nonInteractive: true });

    expect(result.fixed?.some((f) => f.includes("wep-doctor/SKILL.md"))).toBe(true);
    expect(await pathExists(path.join(tmp, ".agents/skills/wep-doctor/SKILL.md"))).toBe(false);
  });
});
