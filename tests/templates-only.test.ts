import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readConfig } from "../src/config.js";
import { runDoctor } from "../src/doctor.js";
import { pathExists } from "../src/fs-utils.js";
import { expandModules, requiredFiles } from "../src/harness-files.js";
import { runEnable, runInit } from "../src/init.js";
import { runTemplateApply, runTemplateStatus, runTemplateUpdate } from "../src/template-apply.js";
import { runUpgrade } from "../src/upgrade.js";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "wep-templates-only-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function writePack(
  root: string,
  name: string,
  version: string,
  spec: {
    config?: unknown;
    policy?: unknown;
    wiki?: Record<string, string>;
    skills?: Record<string, Record<string, string>>;
    agents?: Record<string, string>;
    prompts?: Record<string, string>;
    instructions?: Record<string, string>;
    rootInstructions?: string;
  },
): Promise<string> {
  const packDir = path.join(root, `${name}-pack`);
  await mkdir(packDir, { recursive: true });
  await writeFile(
    path.join(packDir, "wep-pack.json"),
    JSON.stringify({ name, version, wepPackVersion: 1 }, null, 2),
    "utf8",
  );
  if (spec.config !== undefined) {
    await writeFile(path.join(packDir, "config.json"), JSON.stringify(spec.config, null, 2), "utf8");
  }
  if (spec.policy !== undefined) {
    await writeFile(path.join(packDir, "policy.json"), JSON.stringify(spec.policy, null, 2), "utf8");
  }
  for (const [rel, content] of Object.entries(spec.wiki ?? {})) {
    const dest = path.join(packDir, "wiki", rel);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, content, "utf8");
  }
  for (const [skillName, files] of Object.entries(spec.skills ?? {})) {
    for (const [rel, content] of Object.entries(files)) {
      const dest = path.join(packDir, "target/skills", skillName, rel);
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, content, "utf8");
    }
  }
  for (const [agentName, content] of Object.entries(spec.agents ?? {})) {
    const dest = path.join(packDir, "target/agents", `${agentName}.md`);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, content, "utf8");
  }
  for (const [promptName, content] of Object.entries(spec.prompts ?? {})) {
    const dest = path.join(packDir, "target/prompts", promptName);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, content, "utf8");
  }
  for (const [instrName, content] of Object.entries(spec.instructions ?? {})) {
    const dest = path.join(packDir, "target/instructions", instrName);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, content, "utf8");
  }
  if (spec.rootInstructions !== undefined) {
    await mkdir(path.join(packDir, "target"), { recursive: true });
    await writeFile(path.join(packDir, "target/root-instructions.md"), spec.rootInstructions, "utf8");
  }
  return packDir;
}

describe("templates-only module mode", () => {
  it("computes requiredFiles per module and expands module dependencies", () => {
    expect(expandModules(["templates"])).toEqual(["templates"]);
    expect(expandModules(["judge"])).toEqual(["templates", "tasks", "judge"]);
    expect(expandModules(["comprehension"])).toEqual(["templates", "tasks", "judge", "comprehension"]);
    expect(requiredFiles(["templates"], ["claude", "codex", "copilot"])).toEqual([
      ".wep/config.json",
      ".wep/manifest.json",
    ]);
  });

  it("installs only config.json and manifest.json with --modules templates and scores 100 in doctor", async () => {
    const init = await runInit({
      cwd: tmp,
      modules: "templates",
      target: "claude,codex,copilot",
      nonInteractive: true,
    });

    expect(init.selectedTargets).toEqual(["claude", "codex", "copilot"]);
    expect(init.writes.map((w) => w.path)).toEqual([".wep/config.json", ".wep/manifest.json"]);
    expect(await pathExists(path.join(tmp, ".wep/policy.json"))).toBe(false);
    expect(await pathExists(path.join(tmp, ".wep/wiki"))).toBe(false);
    expect(await pathExists(path.join(tmp, ".wep/tasks"))).toBe(false);
    expect(await pathExists(path.join(tmp, "CLAUDE.md"))).toBe(false);
    expect(await pathExists(path.join(tmp, "AGENTS.md"))).toBe(false);
    expect(await pathExists(path.join(tmp, ".claude"))).toBe(false);
    expect(await pathExists(path.join(tmp, ".agents"))).toBe(false);
    expect(await pathExists(path.join(tmp, ".github"))).toBe(false);

    const config = await readConfig(tmp);
    expect(config?.modules).toEqual(["templates"]);
    expect(config?.targets).toEqual(["claude", "codex", "copilot"]);

    const doctor = await runDoctor({ cwd: tmp, nonInteractive: true });
    expect(doctor.installed).toBe(true);
    expect(doctor.readiness).toBe(100);
    expect(doctor.missing).toEqual([]);
    expect(doctor.installedTargets).toEqual(["claude", "codex", "copilot"]);
    expect(await pathExists(path.join(tmp, ".wep/wiki"))).toBe(false);

    const upgrade = await runUpgrade({ cwd: tmp, nonInteractive: true });
    expect(upgrade.completed).toBe(true);
    expect(await pathExists(path.join(tmp, "CLAUDE.md"))).toBe(false);
    expect(await pathExists(path.join(tmp, ".wep/policy.json"))).toBe(false);
  });

  it("applies a template across all configured targets without policy.json, copying full skill directories, wiki/<template>/, and agents", async () => {
    await runInit({
      cwd: tmp,
      modules: "templates",
      target: "claude,codex,copilot,pi",
      nonInteractive: true,
    });

    const frontendPack = await writePack(tmp, "frontend", "1.0.0", {
      config: { defaults: { workflow: "TDD" } },
      policy: { blockedReadPatterns: ["secrets/"] },
      wiki: { "components.md": "# Component Guidelines\n" },
      skills: {
        "ui-kit": {
          "SKILL.md": "# UI Kit Skill\n",
          "references/tokens.md": "# Design Tokens\n",
          "scripts/check.sh": "#!/bin/sh\necho ok\n",
        },
      },
      agents: {
        "a11y-reviewer": `---
name: a11y-reviewer
description: Checks accessibility of UI components.
model: sonnet
---

# Accessibility Reviewer

Verify ARIA roles and keyboard navigation.
`,
      },
    });

    const applied = await runTemplateApply({
      cwd: tmp,
      templateRef: frontendPack,
      local: true,
      nonInteractive: true,
    });

    expect(applied.completed).toBe(true);
    expect(applied.targets).toEqual(["claude", "codex", "copilot", "pi"]);

    // Warns about ignored config.json and policy.json when tasks/judge are not installed, plus Pi agent warning
    expect(applied.policyWarnings.some((w) => w.includes("policy.json") && w.includes('"judge"'))).toBe(true);
    expect(applied.policyWarnings.some((w) => w.includes("config.json") && w.includes('"tasks"'))).toBe(true);
    expect(
      applied.policyWarnings.some((w) => w.includes("pi is installed but has no a11y-reviewer agent format")),
    ).toBe(true);
    expect(await pathExists(path.join(tmp, ".wep/policy.json"))).toBe(false);

    // Template wiki under .wep/wiki/<template>/
    expect(await readFile(path.join(tmp, ".wep/wiki/frontend/components.md"), "utf8")).toContain(
      "Component Guidelines",
    );

    // Whole skill directory copied to each target
    for (const prefix of [".claude/skills", ".agents/skills", ".github/skills", ".pi/skills"]) {
      expect(await pathExists(path.join(tmp, prefix, "ui-kit/SKILL.md"))).toBe(true);
      expect(await readFile(path.join(tmp, prefix, "ui-kit/references/tokens.md"), "utf8")).toContain("Design Tokens");
      expect(await readFile(path.join(tmp, prefix, "ui-kit/scripts/check.sh"), "utf8")).toContain("echo ok");
    }

    // Agents emitted in each host's format
    const claudeAgent = await readFile(path.join(tmp, ".claude/agents/a11y-reviewer.md"), "utf8");
    expect(claudeAgent).toContain("name: a11y-reviewer");
    expect(claudeAgent).toContain("model: sonnet");
    expect(claudeAgent).toContain("Verify ARIA roles");

    const copilotAgent = await readFile(path.join(tmp, ".github/agents/a11y-reviewer.agent.md"), "utf8");
    expect(copilotAgent).toContain("user-invocable: true");
    expect(copilotAgent).toContain("Verify ARIA roles");

    const codexAgent = await readFile(path.join(tmp, ".codex/agents/a11y-reviewer.toml"), "utf8");
    expect(codexAgent).toContain('name = "a11y-reviewer"');
    expect(codexAgent).toContain('developer_instructions = """');
    expect(codexAgent).toContain("Verify ARIA roles");
  });

  it("refuses and names both templates when two templates claim the same path", async () => {
    await runInit({
      cwd: tmp,
      modules: "templates",
      target: "claude",
      nonInteractive: true,
    });

    const packA = await writePack(tmp, "team-alpha", "1.0.0", {
      skills: { "shared-skill": { "SKILL.md": "# Alpha\n" } },
    });
    const packB = await writePack(tmp, "team-beta", "1.0.0", {
      skills: { "shared-skill": { "SKILL.md": "# Beta\n" } },
    });

    await runTemplateApply({ cwd: tmp, templateRef: packA, local: true, nonInteractive: true });
    await expect(runTemplateApply({ cwd: tmp, templateRef: packB, local: true, nonInteractive: true })).rejects.toThrow(
      /team-beta.*already claimed by template "team-alpha"/,
    );
  });

  it("tracks user-modified files in templates status and preserves them as suggestions on templates update", async () => {
    await runInit({
      cwd: tmp,
      modules: "templates",
      target: "claude",
      nonInteractive: true,
    });

    const packDir = await writePack(tmp, "frontend", "1.0.0", {
      skills: {
        "ui-kit": {
          "SKILL.md": "# UI Kit v1\n",
          "references/guide.md": "# Guide v1\n",
        },
      },
    });

    await runTemplateApply({ cwd: tmp, templateRef: packDir, local: true, nonInteractive: true });

    const cleanStatus = await runTemplateStatus({ cwd: tmp, nonInteractive: true });
    expect(cleanStatus.templates[0].changedFiles).toEqual([]);

    // User modifies SKILL.md but leaves references/guide.md untouched
    await writeFile(path.join(tmp, ".claude/skills/ui-kit/SKILL.md"), "# User customized UI Kit\n", "utf8");

    const dirtyStatus = await runTemplateStatus({ cwd: tmp, nonInteractive: true });
    expect(dirtyStatus.templates[0].changedFiles).toEqual([".claude/skills/ui-kit/SKILL.md"]);

    // Ship version 1.1.0 of frontend template
    await writePack(tmp, "frontend", "1.1.0", {
      skills: {
        "ui-kit": {
          "SKILL.md": "# UI Kit v1.1\n",
          "references/guide.md": "# Guide v1.1\n",
        },
      },
    });

    const updated = await runTemplateUpdate({ cwd: tmp, templateRef: packDir, local: true, nonInteractive: true });
    expect(updated.completed).toBe(false);
    expect(updated.conflicts).toEqual([".claude/skills/ui-kit/SKILL.md"]);

    // Unmodified file was updated in place
    expect(await readFile(path.join(tmp, ".claude/skills/ui-kit/references/guide.md"), "utf8")).toBe("# Guide v1.1\n");
    // User-modified file was preserved, and v1.1.0 candidate was written as a suggestion
    expect(await readFile(path.join(tmp, ".claude/skills/ui-kit/SKILL.md"), "utf8")).toBe("# User customized UI Kit\n");
    expect(
      await readFile(path.join(tmp, ".wep/template-candidates/frontend/1.1.0/.claude/skills/ui-kit/SKILL.md"), "utf8"),
    ).toBe("# UI Kit v1.1\n");
  });

  it("enables tasks later via wep enable tasks and installs its files", async () => {
    await runInit({ cwd: tmp, modules: "templates", target: "claude,codex", nonInteractive: true });
    expect(await pathExists(path.join(tmp, "CLAUDE.md"))).toBe(false);
    expect(await pathExists(path.join(tmp, ".wep/tasks/_template/task.md"))).toBe(false);

    const enabled = await runEnable("tasks", { cwd: tmp, nonInteractive: true });
    expect(enabled.selectedTargets).toEqual(["claude", "codex"]);

    const config = await readConfig(tmp);
    expect(config?.modules).toEqual(["templates", "tasks"]);
    expect(await pathExists(path.join(tmp, "CLAUDE.md"))).toBe(true);
    expect(await pathExists(path.join(tmp, "AGENTS.md"))).toBe(true);
    expect(await pathExists(path.join(tmp, ".wep/tasks/_template/task.md"))).toBe(true);
    expect(await pathExists(path.join(tmp, ".wep/wiki/overview.md"))).toBe(true);
    expect(await pathExists(path.join(tmp, ".wep/policy.json"))).toBe(false);

    const doctor = await runDoctor({ cwd: tmp, nonInteractive: true });
    expect(doctor.readiness).toBe(100);
    expect(doctor.missing).toEqual([]);
  });
});
