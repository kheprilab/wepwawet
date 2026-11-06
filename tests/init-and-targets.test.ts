import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runComprehensionEnable } from "../src/comprehension.js";
import { readConfig } from "../src/config.js";
import { detectTargets } from "../src/detect.js";
import { runDoctor } from "../src/doctor.js";
import { pathExists } from "../src/fs-utils.js";
import { runInit } from "../src/init.js";
import { runJudgeEnable } from "../src/judge.js";

import { tmp, useTempDir } from "./helpers/wep.js";

useTempDir();

describe("wep init", () => {
  it("installs the codex harness without overwriting existing AGENTS.md", async () => {
    await writeFile(path.join(tmp, "AGENTS.md"), "# Existing instructions\n", "utf8");

    const result = await runInit({ cwd: tmp, target: "codex", nonInteractive: true });

    expect(result.selectedTargets).toEqual(["codex"]);
    expect(await readFile(path.join(tmp, "AGENTS.md"), "utf8")).toBe("# Existing instructions\n");
    expect(await pathExists(path.join(tmp, "AGENTS.wep.suggested.md"))).toBe(true);
    expect(await pathExists(path.join(tmp, ".wep/config.json"))).toBe(true);
    expect(await pathExists(path.join(tmp, ".wep/manifest.json"))).toBe(true);
    const config = await readConfig(tmp);
    expect(config?.defaults.workflow).toBe("task-fit");
    expect(config?.workflowRules.apiOrContract).toBe("SDD+TDD");
    expect(config?.comprehensionGate).toEqual({
      enabled: false,
      trigger: "agent-assessed-significance",
      evaluationMode: "prefer-independent",
    });
    expect(await pathExists(path.join(tmp, ".agents/skills/wep-doctor/SKILL.md"))).toBe(true);
    expect(await pathExists(path.join(tmp, ".agents/skills/wep-workflow/SKILL.md"))).toBe(true);
    expect(await pathExists(path.join(tmp, ".agents/skills/wep-comprehension/SKILL.md"))).toBe(false);
    expect(await pathExists(path.join(tmp, ".codex/agents/wep-comprehension.toml"))).toBe(false);
    expect(await pathExists(path.join(tmp, ".wep/wiki/write-policy.md"))).toBe(true);
    expect(await pathExists(path.join(tmp, ".wep/local/.gitignore"))).toBe(true);
    expect(await readFile(path.join(tmp, ".wep/local/.gitignore"), "utf8")).toBe("*\n!.gitignore\n");
    expect(await pathExists(path.join(tmp, ".wep/comprehension/schemas/rubric.schema.json"))).toBe(true);
  });

  it("creates wiki pages with OKF-style frontmatter", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });

    const architecture = await readFile(path.join(tmp, ".wep/wiki/architecture.md"), "utf8");
    expect(architecture).toMatch(/^---\n/);
    expect(architecture).toContain("type: wep-wiki-architecture");
    expect(architecture).toContain("tags:");

    const overview = await readFile(path.join(tmp, ".wep/wiki/overview.md"), "utf8");
    expect(overview).toContain("type: wep-wiki-overview");

    const index = await readFile(path.join(tmp, ".wep/wiki/index.md"), "utf8");
    expect(index).toMatch(/^---\n/);
    expect(index).toContain("type: wep-wiki-index");
    expect(index).toContain("[Overview](/wiki/overview.md)");
    expect(index).toContain("[Instruction Audit](/wiki/instruction-audit.md)");

    const log = await readFile(path.join(tmp, ".wep/wiki/log.md"), "utf8");
    expect(log).toContain("type: wep-wiki-log");
    expect(log).toMatch(/^---\n[\s\S]*# Log\n\n## \d{4}-\d{2}-\d{2}\n- wep initialized\.\n$/);

    const instructionAudit = await readFile(path.join(tmp, ".wep/wiki/instruction-audit.md"), "utf8");
    expect(instructionAudit).toContain("type: wep-wiki-instruction-audit");
    expect(instructionAudit).toContain("does not overwrite this page");
  });

  it("creates an active Codex harness when AGENTS.md does not exist", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });

    const agents = await readFile(path.join(tmp, "AGENTS.md"), "utf8");
    expect(agents).toContain("Mandatory Behavior");
    expect(agents).toContain("Create or update a task capsule");
    expect(agents).toContain("before implementation");
    expect(agents).toContain("Create the task capsule yourself");
  });

  it("creates a harness policy that does not restrict the programming agent from implementation", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });

    const policy = JSON.parse(await readFile(path.join(tmp, ".wep/policy.json"), "utf8"));
    expect(policy).not.toHaveProperty("allowSourceCodeWrites");
    expect(policy).not.toHaveProperty("network");
    expect(policy).not.toHaveProperty("llmProvider");
    expect(policy).not.toHaveProperty("allowExternalAgentExecution");
    expect(policy.mergeStrategy).toBe("preserve-and-suggest");
  });

  it("policy includes .p12 and .pfx in blockedReadPatterns", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });

    const policy = JSON.parse(await readFile(path.join(tmp, ".wep/policy.json"), "utf8"));
    expect(policy.blockedReadPatterns).toContain("*.p12");
    expect(policy.blockedReadPatterns).toContain("*.pfx");
  });

  it("policy records protected files and enforcement defaults", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });

    const policy = JSON.parse(await readFile(path.join(tmp, ".wep/policy.json"), "utf8"));
    expect(policy.protectedFiles).toContain("AGENTS.md");
    expect(policy.protectedFiles).toContain("CLAUDE.md");
    expect(policy.protectedFiles).toContain(".github/copilot-instructions.md");
    expect(policy.protectedFiles).toContain(".pi/README.md");
    expect(policy.protectedFileMerge).toEqual({
      agentMayEdit: "after-explicit-human-approval",
      approvalScope: "current-conversation",
      requireDiffPreview: true,
    });
    expect(policy.writePolicy.doctor).toContain("AGENTS.wep.suggested.md");
    expect(policy.writePolicy.doctor).toContain(".wep/wiki/instruction-audit.md");
    for (const page of ["architecture", "conventions", "testing", "decisions"]) {
      expect(policy.writePolicy.doctor).toContain(`.wep/wiki/${page}.md`);
    }
    expect(policy.writePolicy.doctor).not.toContain("AGENTS.md");
    expect(policy.enforcement.requireTaskCapsule).toBe(true);
    expect(policy.enforcement.requireWorkflowReason).toBe(true);
    expect(policy.enforcement.requireAcceptanceCriteria).toBe(true);
    expect(policy.enforcement.requireReviewChecklist).toBe(true);
  });

  it("never leaves a weak judge verify in an instruction aimed at the primary agent", async () => {
    await runInit({ cwd: tmp, target: "all", nonInteractive: true });
    await runJudgeEnable({ cwd: tmp, nonInteractive: true });

    // The primary agent is the only caller that can execute or pin a receipt digest, so every
    // surface that tells it to verify must say --receipt-digest or --run-tests. Read-only agents
    // are excluded: either flag would break their contract, and they are checked separately below.
    const readOnlyAgents = ["wep-judge", "wep-comprehension"];
    const surfaces = (await readdir(tmp, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile() && /\.(md|toml)$/.test(entry.name))
      .map((entry) => path.relative(tmp, path.join(entry.parentPath, entry.name)))
      .filter((relativePath) => !readOnlyAgents.some((agent) => relativePath.includes(agent)));
    expect(surfaces.length).toBeGreaterThan(0);

    const weak: string[] = [];
    for (const relativePath of surfaces) {
      const content = await readFile(path.join(tmp, relativePath), "utf8");
      for (const line of content.split("\n")) {
        if (!line.includes("judge verify")) continue;
        if (line.includes("--run-tests") || line.includes("--receipt-digest")) continue;
        // `judge verify` named as a bare command reference rather than an instruction to run it.
        if (/`wep judge verify`/.test(line)) continue;
        weak.push(`${relativePath}: ${line.trim()}`);
      }
    }

    expect(weak).toEqual([]);
  });

  it("tells the read-only agents not to re-execute validation", async () => {
    await runInit({ cwd: tmp, target: "all", nonInteractive: true });
    await runComprehensionEnable({ cwd: tmp, nonInteractive: true });

    const agent = await readFile(path.join(tmp, ".claude/agents/wep-comprehension.md"), "utf8");

    expect(agent).toContain("Do not pass `--run-tests`");
  });

  it("teaches every Doctor target the narrow human-approved merge workflow", async () => {
    await runInit({ cwd: tmp, target: "all", nonInteractive: true });

    const doctorSurfaces = [
      ".agents/skills/wep-doctor/SKILL.md",
      ".claude/skills/wep-doctor/SKILL.md",
      ".claude/commands/wep-doctor.md",
      ".github/skills/wep-doctor/SKILL.md",
      ".github/prompts/wep-doctor.prompt.md",
      ".pi/skills/wep-doctor/SKILL.md",
      ".pi/prompts/wep-doctor.md",
    ];

    for (const relativePath of doctorSurfaces) {
      const content = await readFile(path.join(tmp, relativePath), "utf8");
      expect(content, relativePath).toContain("explicit human approval");
      expect(content, relativePath).toContain("current conversation");
    }

    const skill = await readFile(path.join(tmp, ".agents/skills/wep-doctor/SKILL.md"), "utf8");
    expect(skill).toContain("Show the exact proposed diff");
    expect(skill).toContain("apply only the shown changes");
    expect(skill).toContain("Never use `--force`");

    const semanticDoctorSkills = [
      ".agents/skills/wep-doctor/SKILL.md",
      ".claude/skills/wep-doctor/SKILL.md",
      ".github/skills/wep-doctor/SKILL.md",
      ".pi/skills/wep-doctor/SKILL.md",
    ];
    for (const relativePath of semanticDoctorSkills) {
      const content = await readFile(path.join(tmp, relativePath), "utf8");
      expect(content, relativePath).toContain("instruction or coherent block");
      expect(content, relativePath).toContain("missing or empty `applyTo`");
      expect(content, relativePath).toContain("Move up only when evidence shows");
      expect(content, relativePath).toContain(".wep/wiki/instruction-audit.md");
    }

    const copilotInstructions = await readFile(path.join(tmp, ".github/instructions/wep.instructions.md"), "utf8");
    expect(copilotInstructions).toContain('applyTo: ".wep/**"');
    expect(copilotInstructions).not.toContain('applyTo: "**"');
  });

  it("strict profile records stricter config and policy defaults", async () => {
    await runInit({ cwd: tmp, target: "copilot", profile: "strict", nonInteractive: true });

    const config = await readConfig(tmp);
    const policy = JSON.parse(await readFile(path.join(tmp, ".wep/policy.json"), "utf8"));
    expect(config?.profile).toBe("strict");
    expect(config?.defaults.contextBudget).toBe("thorough");
    expect(policy.profile).toBe("strict");
    expect(policy.blockedReadPatterns).toContain(".ssh/");
    expect(policy.blockedReadPatterns).toContain(".netrc");
  });

  it("regulated profile avoids fast-patch for small patches and adds regulated blocked reads", async () => {
    await runInit({ cwd: tmp, target: "codex", profile: "regulated", nonInteractive: true });

    const config = await readConfig(tmp);
    const policy = JSON.parse(await readFile(path.join(tmp, ".wep/policy.json"), "utf8"));
    expect(config?.profile).toBe("regulated");
    expect(config?.workflowRules.smallSafePatch).toBe("TDD");
    expect(config?.workflowRules.default).toBe("research-first");
    expect(policy.profile).toBe("regulated");
    expect(policy.blockedReadPatterns).toContain("compliance/");
    expect(policy.blockedReadPatterns).toContain("*.jks");
  });

  it("applies a target-relative template pack", async () => {
    const pack = path.join(tmp, "pepe-template");
    await mkdir(path.join(pack, "wiki"), { recursive: true });
    await mkdir(path.join(pack, "target/skills/pepe-front"), { recursive: true });
    await mkdir(path.join(pack, "target/prompts"), { recursive: true });
    await mkdir(path.join(pack, "target/instructions"), { recursive: true });
    await writeFile(
      path.join(pack, "wep-pack.json"),
      JSON.stringify({ name: "pepe-template", version: "1.0.0", wepPackVersion: 1 }),
      "utf8",
    );
    await writeFile(
      path.join(pack, "config.json"),
      JSON.stringify({
        defaults: { workflow: "SDD+TDD", contextBudget: "thorough" },
        comprehensionGate: { enabled: "yes", trigger: "always", evaluationMode: "same-session" },
      }),
      "utf8",
    );
    await writeFile(
      path.join(pack, "policy.json"),
      JSON.stringify({ blockedReadPatterns: ["terraform.tfstate", "prod-secrets/"] }),
      "utf8",
    );
    await writeFile(path.join(pack, "wiki/testing.md"), "# Company Testing\n", "utf8");
    await writeFile(path.join(pack, "target/root-instructions.md"), "# Company Copilot Instructions\n", "utf8");
    await writeFile(path.join(pack, "target/skills/pepe-front/SKILL.md"), "# pepe-front\n", "utf8");
    await writeFile(path.join(pack, "target/prompts/pepe-review.md"), "# Pepe Review\n", "utf8");
    await writeFile(path.join(pack, "target/instructions/pepe.instructions.md"), "# Pepe Instructions\n", "utf8");

    await runInit({ cwd: tmp, target: "copilot", templatePack: pack, nonInteractive: true });

    const config = await readConfig(tmp);
    const policy = JSON.parse(await readFile(path.join(tmp, ".wep/policy.json"), "utf8"));
    expect(config?.defaults.workflow).toBe("SDD+TDD");
    expect(config?.defaults.contextBudget).toBe("thorough");
    expect(config?.comprehensionGate).toEqual({
      enabled: false,
      trigger: "always",
      evaluationMode: "prefer-independent",
    });
    expect(config?.templatePacks[0]).toMatchObject({
      name: "pepe-template",
      version: "1.0.0",
      source: "local",
      targets: ["copilot"],
    });
    expect(policy.blockedReadPatterns).toContain("terraform.tfstate");
    expect(policy.blockedReadPatterns).toContain(".env");
    expect(await readFile(path.join(tmp, ".wep/wiki/pepe-template/testing.md"), "utf8")).toContain("Company Testing");
    expect(await readFile(path.join(tmp, ".github/copilot-instructions.md"), "utf8")).toContain(
      "Company Copilot Instructions",
    );
    expect(await readFile(path.join(tmp, ".github/skills/pepe-front/SKILL.md"), "utf8")).toContain("pepe-front");
    expect(await pathExists(path.join(tmp, ".github/prompts/pepe-review.md"))).toBe(true);
    expect(await pathExists(path.join(tmp, ".github/instructions/pepe.instructions.md"))).toBe(true);
  });

  it("warns when a template pack weakens enforcement policy", async () => {
    const pack = path.join(tmp, "weak-template");
    await mkdir(pack, { recursive: true });
    await writeFile(
      path.join(pack, "wep-pack.json"),
      JSON.stringify({ name: "weak-template", version: "1.0.0", wepPackVersion: 1 }),
      "utf8",
    );
    await writeFile(
      path.join(pack, "policy.json"),
      JSON.stringify({
        enforcement: { requireTaskCapsule: false },
        protectedFileMerge: { requireDiffPreview: false },
      }),
      "utf8",
    );

    const result = await runInit({ cwd: tmp, target: "copilot", templatePack: pack, nonInteractive: true });

    expect(result.policyWarnings.some((w) => w.includes("enforcement.requireTaskCapsule"))).toBe(true);
    expect(result.policyWarnings.some((w) => w.includes("protected-file human-approval"))).toBe(true);
  });

  it("reports no policy warnings when a template pack does not touch policy", async () => {
    const result = await runInit({ cwd: tmp, target: "codex", nonInteractive: true });

    expect(result.policyWarnings).toEqual([]);
  });

  it("rejects root-level template pack skills", async () => {
    const pack = path.join(tmp, "bad-template");
    await mkdir(path.join(pack, "skills/pepe-front"), { recursive: true });
    await writeFile(
      path.join(pack, "wep-pack.json"),
      JSON.stringify({ name: "bad-template", version: "1.0.0", wepPackVersion: 1 }),
      "utf8",
    );
    await writeFile(path.join(pack, "skills/pepe-front/SKILL.md"), "# nope\n", "utf8");

    await expect(runInit({ cwd: tmp, target: "copilot", templatePack: pack, nonInteractive: true })).rejects.toThrow(
      "root-level skills/ is not supported",
    );
  });

  it("applies a bundled template by name", async () => {
    await runInit({ cwd: tmp, target: "copilot", template: "test-template", nonInteractive: true });

    const policy = JSON.parse(await readFile(path.join(tmp, ".wep/policy.json"), "utf8"));
    expect(policy.blockedReadPatterns).toContain("terraform.tfstate");
    expect(await readFile(path.join(tmp, ".wep/wiki/test-template/testing.md"), "utf8")).toContain(
      "Test Template Testing",
    );
    expect(await readFile(path.join(tmp, ".github/copilot-instructions.md"), "utf8")).toContain(
      "Test Template Instructions",
    );
    expect(await readFile(path.join(tmp, ".github/skills/test-front/SKILL.md"), "utf8")).toContain("test-front");
  });

  it("installs target workflow surfaces for all supported targets", async () => {
    await runInit({ cwd: tmp, target: "all", nonInteractive: true });

    expect(await pathExists(path.join(tmp, ".agents/skills/wep-workflow/SKILL.md"))).toBe(true);
    expect(await pathExists(path.join(tmp, ".claude/skills/wep-workflow/SKILL.md"))).toBe(true);
    // Copilot gets both skills and prompts.
    expect(await pathExists(path.join(tmp, ".github/skills/wep-workflow/SKILL.md"))).toBe(true);
    expect(await pathExists(path.join(tmp, ".github/prompts/wep-workflow.prompt.md"))).toBe(true);
    expect(await pathExists(path.join(tmp, ".pi/skills/wep-workflow/SKILL.md"))).toBe(true);
  });

  it("dry-run reports planned writes without creating files", async () => {
    const result = await runInit({ cwd: tmp, target: "codex", dryRun: true, nonInteractive: true });

    expect(result.writes.some((write) => write.path === ".wep/config.json" && write.kind === "create")).toBe(true);
    expect(await pathExists(path.join(tmp, ".wep/config.json"))).toBe(false);
  });

  it("fails instead of silently defaulting to codex in non-interactive mode with no detected target", async () => {
    await expect(runInit({ cwd: tmp, dryRun: true, nonInteractive: true })).rejects.toThrow(
      "No agent setup detected and no --target given.",
    );
  });

  it("fails in non-interactive mode when multiple targets are detected and none is given", async () => {
    await writeFile(path.join(tmp, "AGENTS.md"), "# Codex\n", "utf8");
    await writeFile(path.join(tmp, "CLAUDE.md"), "# Claude\n", "utf8");

    await expect(runInit({ cwd: tmp, dryRun: true, nonInteractive: true })).rejects.toThrow(
      "Multiple agent setups detected",
    );
  });
});

describe("target reference files", () => {
  it("writes only the selected target's reference file", async () => {
    await runInit({ cwd: tmp, target: "claude", nonInteractive: true });

    expect(await pathExists(path.join(tmp, ".wep/targets/claude.md"))).toBe(true);
    expect(await pathExists(path.join(tmp, ".wep/targets/codex.md"))).toBe(false);
    expect(await pathExists(path.join(tmp, ".wep/targets/copilot.md"))).toBe(false);
    expect(await pathExists(path.join(tmp, ".wep/targets/pi.md"))).toBe(false);
  });

  it("doctor does not flag unselected targets' reference files as missing", async () => {
    await runInit({ cwd: tmp, target: "claude", nonInteractive: true });

    const result = await runDoctor({ cwd: tmp, nonInteractive: true });

    expect(result.readiness).toBe(100);
    expect(result.missing).not.toContain(".wep/targets/codex.md");
  });

  it("doctor flags a missing target reference file for an installed target", async () => {
    await runInit({ cwd: tmp, target: "claude", nonInteractive: true });
    await rm(path.join(tmp, ".wep/targets/claude.md"), { force: true });

    const result = await runDoctor({ cwd: tmp, nonInteractive: true });

    expect(result.missing).toContain(".wep/targets/claude.md");
  });
});

describe("target detection", () => {
  it("detects multiple agent setups", async () => {
    await writeFile(path.join(tmp, "CLAUDE.md"), "# Claude\n", "utf8");
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });

    const detection = await detectTargets(tmp);

    expect(detection.detected).toContain("codex");
    expect(detection.detected).toContain("claude");
  });
});
