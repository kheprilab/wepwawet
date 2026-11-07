import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { isLocalIgnoreContentSafe, runComprehensionEnable } from "../src/comprehension.js";
import { readConfig } from "../src/config.js";
import { runDoctor } from "../src/doctor.js";
import { pathExists } from "../src/fs-utils.js";
import { capsuleFiles, upgradesIgnorePath } from "../src/harness-files.js";
import { runInit } from "../src/init.js";
import { runJudgeEnable } from "../src/judge.js";
import { contentHash, readManifest } from "../src/manifest.js";
import { taskTemplateFiles } from "../src/templates.js";
import { collectRegularFiles, runUpgrade } from "../src/upgrade.js";
import { CLI_VERSION } from "../src/version.js";
import { lintWiki } from "../src/wiki-lint.js";

import { tmp, useTempDir } from "./helpers/wep.js";

useTempDir();

describe("upgrade", () => {
  it("adds Doctor wiki destinations to existing policies while preserving custom entries", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const policyPath = path.join(tmp, ".wep/policy.json");
    const policy = JSON.parse(await readFile(policyPath, "utf8"));
    const pages = ["architecture", "conventions", "testing", "decisions"].map((name) => `.wep/wiki/${name}.md`);
    policy.writePolicy.doctor = policy.writePolicy.doctor.filter((entry: string) => !pages.includes(entry));
    policy.writePolicy.doctor.push("docs/custom-doctor.md");
    await writeFile(policyPath, `${JSON.stringify(policy, null, 2)}\n`);
    const architecturePath = path.join(tmp, ".wep/wiki/architecture.md");
    await writeFile(architecturePath, "# Project architecture\n\nKeep this.\n");
    const wikiPath = path.join(tmp, ".wep/wiki/write-policy.md");
    const wiki = (await readFile(wikiPath, "utf8")).replace(
      "- Project knowledge maintained by Doctor: .wep/wiki/architecture.md, conventions.md, testing.md, decisions.md\n",
      "",
    );
    await writeFile(wikiPath, `${wiki}\n## Project notes\n\nKeep this too.\n`);

    await runUpgrade({ cwd: tmp, target: "codex", nonInteractive: true });
    const migrated = JSON.parse(await readFile(policyPath, "utf8"));
    expect(migrated.writePolicy.doctor).toEqual(expect.arrayContaining([...pages, "docs/custom-doctor.md"]));
    expect(await readFile(architecturePath, "utf8")).toBe("# Project architecture\n\nKeep this.\n");
    const migratedWiki = await readFile(wikiPath, "utf8");
    expect(migratedWiki).toContain(
      "- Project knowledge maintained by Doctor: .wep/wiki/architecture.md, conventions.md, testing.md, decisions.md",
    );
    expect(migratedWiki).toContain("## Project notes\n\nKeep this too.");
    const after = await readFile(policyPath, "utf8");
    await runUpgrade({ cwd: tmp, target: "codex", nonInteractive: true });
    expect(await readFile(policyPath, "utf8")).toBe(after);
    expect(await readFile(wikiPath, "utf8")).toBe(migratedWiki);
  });

  it("preserves intentionally restricted Doctor write policies", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const policyPath = path.join(tmp, ".wep/policy.json");
    const policy = JSON.parse(await readFile(policyPath, "utf8"));
    policy.writePolicy.doctor = [".wep/wiki/instruction-audit.md", "docs/custom.md"];
    await writeFile(policyPath, `${JSON.stringify(policy, null, 2)}\n`);
    await runUpgrade({ cwd: tmp, target: "codex", nonInteractive: true });
    const result = JSON.parse(await readFile(policyPath, "utf8"));
    expect(result.writePolicy.doctor).toEqual([".wep/wiki/instruction-audit.md", "docs/custom.md"]);
  });

  describe("implementation-log placement migration", () => {
    const OLD_NOTES = ".wep/tasks/TASK-XXX/log.md";
    const NEW_NOTES = ".wep/local/impl/TASK-XXX/log.md";
    const OLD_LINE = `- Implementation notes for a task: ${OLD_NOTES}`;
    const NEW_LINE = `- Implementation notes for a task: ${NEW_NOTES} (local only; never inside the capsule)`;
    const policyPath = () => path.join(tmp, ".wep/policy.json");
    const wikiPath = () => path.join(tmp, ".wep/wiki/write-policy.md");

    async function installWithOldPolicy(notes: string[]): Promise<void> {
      await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
      const policy = JSON.parse(await readFile(policyPath(), "utf8"));
      policy.writePolicy.implementationNotes = notes;
      await writeFile(policyPath(), `${JSON.stringify(policy, null, 2)}\n`, "utf8");
    }

    async function notes(): Promise<string[]> {
      return JSON.parse(await readFile(policyPath(), "utf8")).writePolicy.implementationNotes;
    }

    it("replaces the old default implementationNotes value", async () => {
      await installWithOldPolicy([OLD_NOTES]);

      await runUpgrade({ cwd: tmp, target: "codex", nonInteractive: true });

      expect(await notes()).toEqual([NEW_NOTES]);
    });

    it.each([
      [["docs/impl-notes/TASK-XXX.md"], [NEW_NOTES, "docs/impl-notes/TASK-XXX.md"]],
      [
        [OLD_NOTES, "docs/impl-notes/TASK-XXX.md"],
        [NEW_NOTES, "docs/impl-notes/TASK-XXX.md"],
      ],
    ])("keeps custom entries and drops only the old default (%j)", async (before, after) => {
      await installWithOldPolicy(before);

      await runUpgrade({ cwd: tmp, target: "codex", nonInteractive: true });

      expect(await notes()).toEqual(after);
    });

    it("replaces only the old implementation-notes line in an existing wiki page", async () => {
      await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
      const page = (await readFile(wikiPath(), "utf8")).replace(NEW_LINE, OLD_LINE);
      const edited = `${page}\n## Project Notes\n\nKeep this section.\n`;
      await writeFile(wikiPath(), edited, "utf8");

      await runUpgrade({ cwd: tmp, target: "codex", nonInteractive: true });

      expect(await readFile(wikiPath(), "utf8")).toBe(edited.replace(OLD_LINE, NEW_LINE));
    });

    it("preserves a wiki page that does not carry the old line", async () => {
      await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
      const custom = "# Write Policy\n\n- Implementation notes for a task: somewhere/else.md\n";
      await writeFile(wikiPath(), custom, "utf8");

      await runUpgrade({ cwd: tmp, target: "codex", nonInteractive: true });

      expect(await readFile(wikiPath(), "utf8")).toBe(custom);
    });

    it("is a no-op on a second run", async () => {
      await installWithOldPolicy([OLD_NOTES]);
      const page = (await readFile(wikiPath(), "utf8")).replace(NEW_LINE, OLD_LINE);
      await writeFile(wikiPath(), page, "utf8");
      await runUpgrade({ cwd: tmp, target: "codex", nonInteractive: true });
      const policyAfter = await readFile(policyPath(), "utf8");
      const wikiAfter = await readFile(wikiPath(), "utf8");

      const second = await runUpgrade({ cwd: tmp, target: "codex", nonInteractive: true });

      expect(await readFile(policyPath(), "utf8")).toBe(policyAfter);
      expect(await readFile(wikiPath(), "utf8")).toBe(wikiAfter);
      const touched = second.writes.filter(
        (w) => w.kind !== "preserve" && [".wep/policy.json", ".wep/wiki/write-policy.md"].includes(w.path),
      );
      expect(touched).toEqual([]);
    });
  });

  describe("capsule template provenance", () => {
    const rel = ".wep/tasks/_template/acceptance-criteria.md";
    const shipped = () => taskTemplateFiles["tasks/_template/acceptance-criteria.md"];
    const abs = () => path.join(tmp, rel);
    const candidate = () => path.join(tmp, `.wep/upgrades/${CLI_VERSION}/${rel}`);
    const OLD = "# Acceptance Criteria\n\nOld shipped wording.\n";

    async function manifestHashes(): Promise<Record<string, { hash: string }>> {
      return JSON.parse(await readFile(path.join(tmp, ".wep/manifest.json"), "utf8")).files;
    }

    async function installWithOldTemplate(recordProvenance: boolean): Promise<void> {
      await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
      await writeFile(abs(), OLD, "utf8");
      const manifestFile = path.join(tmp, ".wep/manifest.json");
      const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
      if (recordProvenance) manifest.files[rel] = { hash: contentHash(OLD) };
      else delete manifest.files[rel];
      await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    }

    it("records provenance for every capsule template on a fresh install", async () => {
      await runInit({ cwd: tmp, target: "codex", nonInteractive: true });

      const files = await manifestHashes();
      for (const file of capsuleFiles) {
        const key = `.wep/tasks/_template/${file}`;
        expect(files[key]?.hash).toBe(contentHash(await readFile(path.join(tmp, key))));
      }
    });

    it("keeps wiki knowledge and task capsules out of the manifest", async () => {
      await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
      await mkdir(path.join(tmp, ".wep/tasks/TASK-001-x"), { recursive: true });
      await writeFile(path.join(tmp, ".wep/tasks/TASK-001-x/task.md"), "# x\n", "utf8");

      await runUpgrade({ cwd: tmp, target: "codex", nonInteractive: true });

      const keys = Object.keys(await manifestHashes());
      expect(keys.filter((key) => key.startsWith(".wep/wiki/"))).toEqual([]);
      expect(keys.filter((key) => key.startsWith(".wep/tasks/") && !key.startsWith(".wep/tasks/_template/"))).toEqual(
        [],
      );
    });

    it("updates a template that matches its recorded hash and lists the write", async () => {
      await installWithOldTemplate(true);

      const result = await runUpgrade({ cwd: tmp, target: "codex", nonInteractive: true });

      expect(await readFile(abs(), "utf8")).toBe(shipped());
      expect(result.writes.find((write) => write.path === rel)?.kind).toBe("update");
      expect((await manifestHashes())[rel]?.hash).toBe(contentHash(shipped()));
      expect(result.conflicts).not.toContain(rel);
    });

    it("produces the same template as a fresh install after an eligible upgrade", async () => {
      await installWithOldTemplate(true);
      await runUpgrade({ cwd: tmp, target: "codex", nonInteractive: true });
      const fresh = await mkdtemp(path.join(os.tmpdir(), "wep-fresh-"));
      try {
        await runInit({ cwd: fresh, target: "codex", nonInteractive: true });

        for (const file of capsuleFiles) {
          const key = `.wep/tasks/_template/${file}`;
          expect(await readFile(path.join(tmp, key), "utf8")).toBe(await readFile(path.join(fresh, key), "utf8"));
        }
      } finally {
        await rm(fresh, { recursive: true, force: true });
      }
    });

    it("preserves a personalized template and offers a candidate", async () => {
      await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
      const edited = `${await readFile(abs(), "utf8")}\nProject criterion.\n`;
      await writeFile(abs(), edited, "utf8");

      const result = await runUpgrade({ cwd: tmp, target: "codex", nonInteractive: true });

      expect(await readFile(abs(), "utf8")).toBe(edited);
      expect(await readFile(candidate(), "utf8")).toBe(shipped());
      expect(result.conflicts).toContain(rel);
      expect(result.completed).toBe(false);
    });

    it("preserves a differing template that has no provenance and invents no hash", async () => {
      await installWithOldTemplate(false);

      const result = await runUpgrade({ cwd: tmp, target: "codex", nonInteractive: true });

      expect(await readFile(abs(), "utf8")).toBe(OLD);
      expect(await readFile(candidate(), "utf8")).toBe(shipped());
      expect(result.conflicts).toContain(rel);
      expect((await manifestHashes())[rel]).toBeUndefined();
    });

    it("preserves a differing template when the manifest is invalid", async () => {
      await installWithOldTemplate(true);
      await writeFile(path.join(tmp, ".wep/manifest.json"), "{ invalid manifest\n", "utf8");

      const result = await runUpgrade({ cwd: tmp, target: "codex", nonInteractive: true });

      expect(await readFile(abs(), "utf8")).toBe(OLD);
      expect(await pathExists(candidate())).toBe(true);
      expect(result.conflicts).toContain(rel);
    });

    it("creates a missing template and records its hash", async () => {
      await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
      await rm(abs());

      await runUpgrade({ cwd: tmp, target: "codex", nonInteractive: true });

      expect(await readFile(abs(), "utf8")).toBe(shipped());
      expect((await manifestHashes())[rel]?.hash).toBe(contentHash(shipped()));
    });

    it("records provenance for an identical template without rewriting it", async () => {
      await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
      const manifestFile = path.join(tmp, ".wep/manifest.json");
      const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
      delete manifest.files[rel];
      await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

      const result = await runUpgrade({ cwd: tmp, target: "codex", nonInteractive: true });

      expect(result.writes.find((write) => write.path === rel)?.kind).toBe("preserve");
      expect((await manifestHashes())[rel]?.hash).toBe(contentHash(shipped()));
      expect(await readManifest(tmp)).toBeDefined();
    });

    it("reports drift in dry-run without changing files or provenance", async () => {
      await installWithOldTemplate(true);
      await rm(path.join(tmp, ".wep/tasks/_template/task.md"));
      const manifestBefore = await readFile(path.join(tmp, ".wep/manifest.json"), "utf8");

      const result = await runUpgrade({ cwd: tmp, target: "codex", dryRun: true, nonInteractive: true });

      expect(result.writes.find((write) => write.path === rel)?.kind).toBe("update");
      expect(result.writes.find((write) => write.path === ".wep/tasks/_template/task.md")?.kind).toBe("create");
      expect(await readFile(abs(), "utf8")).toBe(OLD);
      expect(await pathExists(path.join(tmp, ".wep/tasks/_template/task.md"))).toBe(false);
      expect(await readFile(path.join(tmp, ".wep/manifest.json"), "utf8")).toBe(manifestBefore);
    });

    it("names a personalized template as a candidate in dry-run", async () => {
      await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
      await writeFile(abs(), "# Mine\n", "utf8");

      const result = await runUpgrade({ cwd: tmp, target: "codex", dryRun: true, nonInteractive: true });

      expect(
        result.writes
          .filter((write) => write.path.endsWith(rel))
          .map((write) => write.kind)
          .sort(),
      ).toEqual(["preserve", "suggest"]);
      expect(await pathExists(candidate())).toBe(false);
    });
  });

  it("rejects --force because upgrades never overwrite conflicts", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const previousCwd = process.cwd();
    try {
      process.chdir(tmp);
      await expect(main(["node", "wep", "upgrade", "--force"])).rejects.toThrow("never force-overwrites");
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("upgrades without touching protected AGENTS.md", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    await writeFile(path.join(tmp, "AGENTS.md"), "# Custom instructions\n", "utf8");

    const previousCwd = process.cwd();
    try {
      process.chdir(tmp);
      await main(["node", "wep", "upgrade", "--target", "codex"]);
    } finally {
      process.chdir(previousCwd);
    }

    expect(await readFile(path.join(tmp, "AGENTS.md"), "utf8")).toBe("# Custom instructions\n");
    expect(await pathExists(path.join(tmp, ".agents/skills/wep-workflow/SKILL.md"))).toBe(true);
  });

  it("records a created root-instruction candidate", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    await writeFile(path.join(tmp, "AGENTS.md"), "# Custom instructions\n", "utf8");

    await runUpgrade({ cwd: tmp, target: "codex", nonInteractive: true });

    const candidateKey = path.posix.join(`.wep/upgrades/${CLI_VERSION}`, "AGENTS.md");
    const manifest = JSON.parse(await readFile(path.join(tmp, ".wep/manifest.json"), "utf8"));
    expect(manifest.candidates?.[candidateKey]).toMatchObject({
      hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
  });

  it("does not adopt a preexisting root-instruction candidate", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const candidateKey = path.posix.join(`.wep/upgrades/${CLI_VERSION}`, "AGENTS.md");
    const candidatePath = path.join(tmp, candidateKey);
    await mkdir(path.dirname(candidatePath), { recursive: true });
    await writeFile(candidatePath, "# Foreign candidate\n", "utf8");
    await writeFile(path.join(tmp, "AGENTS.md"), "# Custom instructions\n", "utf8");

    await runUpgrade({ cwd: tmp, target: "codex", nonInteractive: true });

    const manifest = JSON.parse(await readFile(path.join(tmp, ".wep/manifest.json"), "utf8"));
    expect(manifest.candidates?.[candidateKey]).toBeUndefined();
  });

  it("does not record a root-instruction candidate during dry-run", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    await writeFile(path.join(tmp, "AGENTS.md"), "# Custom instructions\n", "utf8");
    const manifestPath = path.join(tmp, ".wep/manifest.json");
    const before = await readFile(manifestPath, "utf8");
    const candidatePath = path.join(tmp, `.wep/upgrades/${CLI_VERSION}/AGENTS.md`);

    await runUpgrade({ cwd: tmp, target: "codex", dryRun: true, nonInteractive: true });

    expect(await readFile(manifestPath, "utf8")).toBe(before);
    expect(await pathExists(candidatePath)).toBe(false);
  });

  it("preserves an edited skill and writes a versioned upgrade candidate", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const skillPath = path.join(tmp, ".agents/skills/wep-doctor/SKILL.md");
    await writeFile(skillPath, `${await readFile(skillPath, "utf8")}\n<!-- local edit -->\n`, "utf8");
    const configPath = path.join(tmp, ".wep/config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.installedVersion = "0.2.0";
    await writeFile(configPath, JSON.stringify(config, null, 2), "utf8");

    const result = await runUpgrade({ cwd: tmp, target: "codex", nonInteractive: true });

    expect(result.completed).toBe(false);
    expect(result.conflicts).toContain(".agents/skills/wep-doctor/SKILL.md");
    expect(await readFile(skillPath, "utf8")).toContain("local edit");
    expect(await pathExists(path.join(tmp, `.wep/upgrades/${CLI_VERSION}/.agents/skills/wep-doctor/SKILL.md`))).toBe(
      true,
    );
    expect((await readConfig(tmp))?.installedVersion).toBe("0.2.0");

    const candidatePath = path.join(tmp, `.wep/upgrades/${CLI_VERSION}/.agents/skills/wep-doctor/SKILL.md`);
    await writeFile(skillPath, await readFile(candidatePath));
    const completed = await runUpgrade({ cwd: tmp, target: "codex", nonInteractive: true });
    expect(completed.completed).toBe(true);
    expect((await readConfig(tmp))?.installedVersion).toBe(CLI_VERSION);
  });

  it("records an unchanged skill as current without a spurious update", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });

    const result = await runUpgrade({ cwd: tmp, target: "codex", nonInteractive: true });

    const unchanged = result.writes.find((w) => w.path === ".agents/skills/wep-doctor/SKILL.md");
    expect(unchanged?.kind).toBe("preserve");
    expect(result.completed).toBe(true);
  });

  it("updates a generated file only when its previous manifest hash matches", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const relativeSkill = ".agents/skills/wep-doctor/SKILL.md";
    const skillPath = path.join(tmp, relativeSkill);
    await writeFile(skillPath, "# Older generated template\n", "utf8");
    const manifestPath = path.join(tmp, ".wep/manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.files[relativeSkill].hash =
      `sha256:${createHash("sha256").update("# Older generated template\n").digest("hex")}`;
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    const result = await runUpgrade({ cwd: tmp, target: "codex", nonInteractive: true });

    expect(result.completed).toBe(true);
    expect(result.writes.find((write) => write.path === relativeSkill)?.kind).toBe("update");
    expect(await readFile(skillPath, "utf8")).toContain("# wep-doctor");
  });

  it("never overwrites advanced project wiki content", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const wikiPath = path.join(tmp, ".wep/wiki/architecture.md");
    const advancedWiki = "# Architecture\n\nProduction knowledge accumulated over years.\n";
    await writeFile(wikiPath, advancedWiki, "utf8");

    const result = await runUpgrade({ cwd: tmp, target: "codex", nonInteractive: true });

    expect(await readFile(wikiPath, "utf8")).toBe(advancedWiki);
    expect(result.writes.find((write) => write.path === ".wep/wiki/architecture.md")?.reason).toContain(
      "never overwritten",
    );
  });

  it("introduces the persistent instruction audit without orphaning it from a custom wiki index", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const auditPath = path.join(tmp, ".wep/wiki/instruction-audit.md");
    const indexPath = path.join(tmp, ".wep/wiki/index.md");
    const customIndex = "# Wiki Index\n\n- [Architecture](/wiki/architecture.md) — Custom entry.\n";
    await rm(auditPath);
    await writeFile(indexPath, customIndex, "utf8");

    await runUpgrade({ cwd: tmp, target: "codex", nonInteractive: true });

    const upgradedIndex = await readFile(indexPath, "utf8");
    expect(await pathExists(auditPath)).toBe(true);
    expect(upgradedIndex).toContain(customIndex);
    expect(upgradedIndex).toContain("[Instruction Audit](/wiki/instruction-audit.md)");
    expect((await lintWiki(tmp)).orphans).not.toContain("instruction-audit.md");
  });

  it("treats a differing legacy generated file without a manifest as a conflict", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    await rm(path.join(tmp, ".wep/manifest.json"));
    const skillPath = path.join(tmp, ".agents/skills/wep-doctor/SKILL.md");
    await writeFile(skillPath, "# Unknown legacy content\n", "utf8");

    const result = await runUpgrade({ cwd: tmp, target: "codex", nonInteractive: true });

    expect(result.completed).toBe(false);
    expect(await readFile(skillPath, "utf8")).toBe("# Unknown legacy content\n");
  });

  it("dry-run does not modify wiki, manifest, or installedVersion", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const wikiPath = path.join(tmp, ".wep/wiki/architecture.md");
    await writeFile(wikiPath, "# Custom wiki\n", "utf8");
    const manifestPath = path.join(tmp, ".wep/manifest.json");
    const manifestBefore = await readFile(manifestPath, "utf8");
    const configBefore = await readFile(path.join(tmp, ".wep/config.json"), "utf8");

    await runUpgrade({ cwd: tmp, target: "codex", dryRun: true, nonInteractive: true });

    expect(await readFile(wikiPath, "utf8")).toBe("# Custom wiki\n");
    expect(await readFile(manifestPath, "utf8")).toBe(manifestBefore);
    expect(await readFile(path.join(tmp, ".wep/config.json"), "utf8")).toBe(configBefore);
  });

  it("does not advance the installation version after a partial target upgrade", async () => {
    await runInit({ cwd: tmp, target: "all", nonInteractive: true });
    const configPath = path.join(tmp, ".wep/config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.installedVersion = "0.2.0";
    await writeFile(configPath, JSON.stringify(config, null, 2), "utf8");

    const result = await runUpgrade({ cwd: tmp, target: "codex", nonInteractive: true });
    const upgradedConfig = await readConfig(tmp);

    expect(result.completed).toBe(true);
    expect(result.installationComplete).toBe(false);
    expect(upgradedConfig?.installedVersion).toBe("0.2.0");
    expect(upgradedConfig?.targets).toEqual(["codex", "claude", "copilot", "pi"]);
  });

  it("preserves invalid policy JSON and makes the upgrade incomplete", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const policyPath = path.join(tmp, ".wep/policy.json");
    await writeFile(policyPath, "{ invalid policy\n", "utf8");

    const result = await runUpgrade({ cwd: tmp, target: "codex", nonInteractive: true });

    expect(result.completed).toBe(false);
    expect(result.conflicts).toContain(".wep/policy.json");
    expect(await readFile(policyPath, "utf8")).toBe("{ invalid policy\n");
    expect(await pathExists(path.join(tmp, `.wep/upgrades/${CLI_VERSION}/.wep/policy.json`))).toBe(true);
  });

  it("adds missing policy fields without replacing project values", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const policyPath = path.join(tmp, ".wep/policy.json");
    const policy = JSON.parse(await readFile(policyPath, "utf8"));
    policy.blockedReadPatterns = ["company-secret/"];
    policy.writePolicy = undefined;
    await writeFile(policyPath, JSON.stringify(policy, null, 2), "utf8");

    const result = await runUpgrade({ cwd: tmp, target: "codex", nonInteractive: true });
    const migrated = JSON.parse(await readFile(policyPath, "utf8"));

    expect(result.completed).toBe(true);
    expect(migrated.blockedReadPatterns).toContain("company-secret/");
    expect(migrated.writePolicy.doctor).toBeDefined();
    expect(migrated.protectedFileMerge.agentMayEdit).toBe("after-explicit-human-approval");
  });

  it("preserves an invalid provenance manifest", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const manifestPath = path.join(tmp, ".wep/manifest.json");
    await writeFile(manifestPath, "{ invalid manifest\n", "utf8");

    const result = await runUpgrade({ cwd: tmp, target: "codex", nonInteractive: true });

    expect(result.completed).toBe(false);
    expect(result.conflicts).toContain(".wep/manifest.json");
    expect(await readFile(manifestPath, "utf8")).toBe("{ invalid manifest\n");
  });

  it("records and cleans an invalid manifest candidate in the external ledger", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const manifestPath = path.join(tmp, ".wep/manifest.json");
    await writeFile(manifestPath, "{ invalid manifest\n", "utf8");

    const first = await runUpgrade({ cwd: tmp, target: "codex", nonInteractive: true });
    const candidateKey = path.posix.join(`.wep/upgrades/${CLI_VERSION}`, ".wep/manifest.json");
    const candidatePath = path.join(tmp, candidateKey);
    const ledgerPath = path.join(tmp, ".wep/local/upgrade-candidates.json");
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
    expect(first.completed).toBe(false);
    expect(ledger.candidates?.[candidateKey]).toMatchObject({
      hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
    expect(JSON.parse(await readFile(candidatePath, "utf8")).candidates?.[candidateKey]).toBeUndefined();

    await writeFile(manifestPath, await readFile(candidatePath));
    const resolved = await runUpgrade({ cwd: tmp, target: "codex", nonInteractive: true });

    expect(resolved.removed).toContain(candidateKey);
    expect(await pathExists(candidatePath)).toBe(false);
    expect(await pathExists(ledgerPath)).toBe(false);
  });

  it("does not adopt a plausible foreign manifest candidate", async () => {
    const foreign = await mkdtemp(path.join(os.tmpdir(), "wep-foreign-"));
    const candidateKey = path.posix.join(`.wep/upgrades/${CLI_VERSION}`, ".wep/manifest.json");
    const candidatePath = path.join(tmp, candidateKey);
    try {
      await runInit({ cwd: foreign, target: "codex", nonInteractive: true });
      await writeFile(path.join(foreign, ".wep/manifest.json"), "{ invalid manifest\n", "utf8");
      await runUpgrade({ cwd: foreign, target: "codex", nonInteractive: true });

      await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
      await mkdir(path.dirname(candidatePath), { recursive: true });
      await writeFile(candidatePath, await readFile(path.join(foreign, candidateKey)));
    } finally {
      await rm(foreign, { recursive: true, force: true });
    }
    const manifestPath = path.join(tmp, ".wep/manifest.json");
    await writeFile(manifestPath, "{ invalid manifest\n", "utf8");

    const first = await runUpgrade({ cwd: tmp, target: "codex", nonInteractive: true });
    expect(first.writes.find((write) => write.path === candidateKey)?.kind).toBe("preserve");
    expect(await pathExists(path.join(tmp, ".wep/local/upgrade-candidates.json"))).toBe(false);

    await writeFile(manifestPath, await readFile(candidatePath));
    const resolved = await runUpgrade({ cwd: tmp, target: "codex", nonInteractive: true });
    expect(resolved.removed).not.toContain(candidateKey);
    expect(await pathExists(candidatePath)).toBe(true);
  });

  it("does not create external manifest provenance during dry-run", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const manifestPath = path.join(tmp, ".wep/manifest.json");
    await writeFile(manifestPath, "{ invalid manifest\n", "utf8");
    const candidatePath = path.join(tmp, `.wep/upgrades/${CLI_VERSION}/.wep/manifest.json`);

    await runUpgrade({ cwd: tmp, target: "codex", dryRun: true, nonInteractive: true });

    expect(await readFile(manifestPath, "utf8")).toBe("{ invalid manifest\n");
    expect(await pathExists(candidatePath)).toBe(false);
    expect(await pathExists(path.join(tmp, ".wep/local/upgrade-candidates.json"))).toBe(false);
  });

  it("keeps a manifest candidate and external provenance after tampering", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const manifestPath = path.join(tmp, ".wep/manifest.json");
    await writeFile(manifestPath, "{ invalid manifest\n", "utf8");
    await runUpgrade({ cwd: tmp, target: "codex", nonInteractive: true });
    const candidateKey = path.posix.join(`.wep/upgrades/${CLI_VERSION}`, ".wep/manifest.json");
    const candidatePath = path.join(tmp, candidateKey);
    const tampered = `${await readFile(candidatePath, "utf8")}\n<!-- tampered -->\n`;
    await writeFile(candidatePath, tampered, "utf8");
    await writeFile(manifestPath, tampered, "utf8");

    const result = await runUpgrade({ cwd: tmp, target: "codex", nonInteractive: true });

    expect(result.removed).not.toContain(candidateKey);
    expect(await pathExists(candidatePath)).toBe(true);
    expect(await pathExists(path.join(tmp, ".wep/local/upgrade-candidates.json"))).toBe(true);
  });

  it("reports obsolete managed files without deleting them", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const obsoletePath = ".agents/skills/wep-retired/SKILL.md";
    const obsoleteAbsolute = path.join(tmp, obsoletePath);
    await mkdir(path.dirname(obsoleteAbsolute), { recursive: true });
    await writeFile(obsoleteAbsolute, "# Retired\n", "utf8");
    const manifestPath = path.join(tmp, ".wep/manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.files[obsoletePath] = { hash: `sha256:${createHash("sha256").update("# Retired\n").digest("hex")}` };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    const result = await runUpgrade({ cwd: tmp, target: "codex", nonInteractive: true });

    expect(result.obsolete).toContain(obsoletePath);
    expect(await readFile(obsoleteAbsolute, "utf8")).toBe("# Retired\n");
  });

  it("preserves enabled optional agents and user configuration during upgrade", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    await runComprehensionEnable({ cwd: tmp, nonInteractive: true });
    await runJudgeEnable({ cwd: tmp, nonInteractive: true });

    await runUpgrade({ cwd: tmp, target: "codex", nonInteractive: true });

    const config = await readConfig(tmp);
    expect(config?.comprehensionGate.enabled).toBe(true);
    expect(config?.judge?.enabled).toBe(true);
    expect(await pathExists(path.join(tmp, ".codex/agents/wep-comprehension.toml"))).toBe(true);
  });

  it("doctor detects version drift and suggests upgrade", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });

    const configPath = path.join(tmp, ".wep/config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.installedVersion = "0.0.1";
    await writeFile(configPath, JSON.stringify(config, null, 2), "utf8");

    const result = await runDoctor({ cwd: tmp, nonInteractive: true });

    expect(result.suggestions.some((s) => s.text.includes("wep upgrade"))).toBe(true);
    expect(result.suggestions.some((s) => s.text.includes("0.0.1"))).toBe(true);
  });
});

describe("upgrade candidate hygiene", () => {
  const candidateDir = `.wep/upgrades/${CLI_VERSION}`;
  const editedSkill = ".agents/skills/wep-doctor/SKILL.md";

  it("does not traverse a real nested directory symlink", async () => {
    const root = path.join(tmp, "upgrade");
    const outside = path.join(tmp, "outside");
    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(root, "local.txt"), "local\n");
    await writeFile(path.join(outside, "external.txt"), "external\n");
    await symlink(outside, path.join(root, "nested"), "dir");

    await expect(collectRegularFiles(root)).resolves.toEqual(["local.txt"]);
  });

  it("does not traverse a real symlink used as the collection root", async () => {
    const outside = path.join(tmp, "outside");
    const root = path.join(tmp, "upgrade");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "external.txt"), "external\n");
    await symlink(outside, root, "dir");

    await expect(collectRegularFiles(root)).resolves.toEqual([]);
  });

  it("walks nested candidates with only the Node 20.0 Dirent surface", async () => {
    const root = path.join(tmp, "upgrade");
    await mkdir(root, { recursive: true });
    type ReadDirectory = NonNullable<Parameters<typeof collectRegularFiles>[1]>;
    const tree = new Map<string, Awaited<ReturnType<ReadDirectory>>>([
      [
        root,
        [
          { name: "nested", isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false },
          { name: "link.txt", isDirectory: () => false, isFile: () => false, isSymbolicLink: () => true },
        ],
      ],
      [
        path.join(root, "nested"),
        [
          { name: "z.txt", isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false },
          { name: "file.txt", isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false },
          { name: "a.txt", isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false },
          { name: "empty", isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false },
        ],
      ],
      [path.join(root, "nested", "empty"), []],
    ]);

    const files = await collectRegularFiles(root, async (directory) => tree.get(directory) ?? []);

    expect(files).toEqual(["nested/a.txt", "nested/file.txt", "nested/z.txt"]);
  });

  async function initWithConflict(): Promise<string> {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const skillPath = path.join(tmp, editedSkill);
    await writeFile(skillPath, `${await readFile(skillPath, "utf8")}\n<!-- local edit -->\n`, "utf8");
    await runUpgrade({ cwd: tmp, target: "codex", nonInteractive: true });
    return path.join(tmp, candidateDir, editedSkill);
  }

  it("init writes a self-ignoring .gitignore for the upgrades directory", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });

    const content = await readFile(path.join(tmp, upgradesIgnorePath), "utf8");
    expect(isLocalIgnoreContentSafe(content)).toBe(true);
  });

  it("init leaves the project's own root .gitignore alone", async () => {
    await writeFile(path.join(tmp, ".gitignore"), "node_modules/\n", "utf8");

    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });

    expect(await readFile(path.join(tmp, ".gitignore"), "utf8")).toBe("node_modules/\n");
  });

  it("upgrade restores the upgrades ignore when an existing install lacks it", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    await rm(path.join(tmp, upgradesIgnorePath));

    await runUpgrade({ cwd: tmp, target: "codex", nonInteractive: true });

    expect(await pathExists(path.join(tmp, upgradesIgnorePath))).toBe(true);
  });

  it("removes a candidate the run no longer writes", async () => {
    const candidatePath = await initWithConflict();
    expect(await pathExists(candidatePath)).toBe(true);
    const manifest = JSON.parse(await readFile(path.join(tmp, ".wep/manifest.json"), "utf8"));
    expect(manifest.candidates[path.posix.join(candidateDir, editedSkill)]).toMatchObject({
      hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });

    await writeFile(path.join(tmp, editedSkill), await readFile(candidatePath));
    const resolved = await runUpgrade({ cwd: tmp, target: "codex", nonInteractive: true });

    expect(resolved.completed).toBe(true);
    expect(await pathExists(candidatePath)).toBe(false);
    expect(resolved.removed).toContain(path.posix.join(candidateDir, editedSkill));
    const updatedManifest = JSON.parse(await readFile(path.join(tmp, ".wep/manifest.json"), "utf8"));
    expect(updatedManifest.candidates[path.posix.join(candidateDir, editedSkill)]).toBeUndefined();
  });

  it("keeps a candidate that is still unresolved", async () => {
    const candidatePath = await initWithConflict();

    await runUpgrade({ cwd: tmp, target: "codex", nonInteractive: true });

    expect(await pathExists(candidatePath)).toBe(true);
  });

  it("keeps a candidate when its agent is disabled before rerunning upgrade", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    await runJudgeEnable({ cwd: tmp, nonInteractive: true });
    const agentPath = ".codex/agents/wep-judge.toml";
    await writeFile(path.join(tmp, agentPath), `${await readFile(path.join(tmp, agentPath), "utf8")}\n# local edit\n`);
    await runUpgrade({ cwd: tmp, target: "codex", nonInteractive: true });
    const candidatePath = path.join(tmp, candidateDir, agentPath);

    const configPath = path.join(tmp, ".wep/config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.agents.judge.enabled = false;
    await writeFile(configPath, JSON.stringify(config, null, 2));

    const result = await runUpgrade({ cwd: tmp, target: "codex", nonInteractive: true });

    expect(result.removed).not.toContain(path.posix.join(candidateDir, agentPath));
    expect(await pathExists(candidatePath)).toBe(true);
  });

  it("keeps a candidate when its target is removed from config", async () => {
    const candidatePath = await initWithConflict();
    const configPath = path.join(tmp, ".wep/config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.targets = ["claude"];
    await writeFile(configPath, JSON.stringify(config, null, 2));

    const result = await runUpgrade({ cwd: tmp, nonInteractive: true });

    expect(result.removed).not.toContain(path.posix.join(candidateDir, editedSkill));
    expect(await pathExists(candidatePath)).toBe(true);
  });

  it("keeps a candidate for a path no longer in the managed inventory", async () => {
    const candidatePath = await initWithConflict();
    const retiredPath = ".agents/skills/wep-retired/SKILL.md";
    const retiredCandidate = path.join(tmp, candidateDir, retiredPath);
    await mkdir(path.dirname(retiredCandidate), { recursive: true });
    await writeFile(retiredCandidate, await readFile(candidatePath));
    await rm(candidatePath);

    const result = await runUpgrade({ cwd: tmp, target: "codex", nonInteractive: true });

    expect(result.removed).not.toContain(path.posix.join(candidateDir, retiredPath));
    expect(await pathExists(retiredCandidate)).toBe(true);
  });

  it("keeps a foreign regular file under the current candidate directory", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const foreignPath = path.join(tmp, candidateDir, "foreign.txt");
    await mkdir(path.dirname(foreignPath), { recursive: true });
    await writeFile(foreignPath, "not created by wep\n");

    const result = await runUpgrade({ cwd: tmp, target: "codex", nonInteractive: true });

    expect(result.removed).not.toContain(path.posix.join(candidateDir, "foreign.txt"));
    expect(await pathExists(foreignPath)).toBe(true);
  });

  it("keeps a foreign candidate matching a real destination byte-for-byte", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const destination = ".agents/skills/wep-doctor/SKILL.md";
    const foreignPath = path.join(tmp, candidateDir, destination);
    await mkdir(path.dirname(foreignPath), { recursive: true });
    await writeFile(foreignPath, await readFile(path.join(tmp, destination)));

    const result = await runUpgrade({ cwd: tmp, target: "codex", nonInteractive: true });

    expect(result.removed).not.toContain(path.posix.join(candidateDir, destination));
    expect(await pathExists(foreignPath)).toBe(true);
  });

  it("does not adopt a preexisting matching candidate and never removes it later", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const destination = ".agents/skills/wep-doctor/SKILL.md";
    const destinationPath = path.join(tmp, destination);
    const foreignPath = path.join(tmp, candidateDir, destination);
    await mkdir(path.dirname(foreignPath), { recursive: true });
    await writeFile(foreignPath, await readFile(destinationPath));
    await writeFile(destinationPath, `${await readFile(destinationPath, "utf8")}\n<!-- local edit -->\n`);

    await runUpgrade({ cwd: tmp, target: "codex", nonInteractive: true });

    const candidateKey = path.posix.join(candidateDir, destination);
    const firstManifest = JSON.parse(await readFile(path.join(tmp, ".wep/manifest.json"), "utf8"));
    expect(firstManifest.candidates?.[candidateKey]).toBeUndefined();

    await writeFile(destinationPath, await readFile(foreignPath));
    const result = await runUpgrade({ cwd: tmp, target: "codex", nonInteractive: true });

    expect(result.removed).not.toContain(candidateKey);
    expect(await pathExists(foreignPath)).toBe(true);
    const secondManifest = JSON.parse(await readFile(path.join(tmp, ".wep/manifest.json"), "utf8"));
    expect(secondManifest.candidates?.[candidateKey]).toBeUndefined();
  });

  it("records and cleans a policy candidate created by wep", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const policyPath = path.join(tmp, ".wep/policy.json");
    const candidateKey = path.posix.join(candidateDir, ".wep/policy.json");
    const candidatePath = path.join(tmp, candidateKey);
    await writeFile(policyPath, "{ invalid policy\n", "utf8");

    const first = await runUpgrade({ cwd: tmp, target: "codex", nonInteractive: true });

    expect(first.conflicts).toContain(".wep/policy.json");
    expect(await pathExists(candidatePath)).toBe(true);
    const firstManifest = JSON.parse(await readFile(path.join(tmp, ".wep/manifest.json"), "utf8"));
    expect(firstManifest.candidates?.[candidateKey]).toMatchObject({
      hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });

    await writeFile(policyPath, await readFile(candidatePath));
    const resolved = await runUpgrade({ cwd: tmp, target: "codex", nonInteractive: true });

    expect(resolved.removed).toContain(candidateKey);
    expect(await pathExists(candidatePath)).toBe(false);
    const secondManifest = JSON.parse(await readFile(path.join(tmp, ".wep/manifest.json"), "utf8"));
    expect(secondManifest.candidates?.[candidateKey]).toBeUndefined();
  });

  it("keeps a registered candidate after its bytes are tampered with", async () => {
    const candidatePath = await initWithConflict();
    const tampered = `${await readFile(candidatePath, "utf8")}\n<!-- tampered -->\n`;
    await writeFile(candidatePath, tampered);
    await writeFile(path.join(tmp, editedSkill), tampered);

    const result = await runUpgrade({ cwd: tmp, target: "codex", nonInteractive: true });

    expect(result.removed).not.toContain(path.posix.join(candidateDir, editedSkill));
    expect(await pathExists(candidatePath)).toBe(true);
  });

  it("never removes the upgrades ignore itself", async () => {
    await initWithConflict();

    await runUpgrade({ cwd: tmp, target: "codex", nonInteractive: true });

    expect(await pathExists(path.join(tmp, upgradesIgnorePath))).toBe(true);
  });

  it("leaves candidate directories of other versions untouched", async () => {
    const candidatePath = await initWithConflict();
    const oldCandidate = path.join(tmp, ".wep/upgrades/0.0.1/AGENTS.md");
    await mkdir(path.dirname(oldCandidate), { recursive: true });
    await writeFile(oldCandidate, "# old suggestion\n", "utf8");

    await writeFile(path.join(tmp, editedSkill), await readFile(candidatePath));
    await runUpgrade({ cwd: tmp, target: "codex", nonInteractive: true });

    expect(await readFile(oldCandidate, "utf8")).toBe("# old suggestion\n");
  });

  it("removes nothing on a dry run but reports what it would remove", async () => {
    const candidatePath = await initWithConflict();
    await writeFile(path.join(tmp, editedSkill), await readFile(candidatePath));

    const preview = await runUpgrade({ cwd: tmp, target: "codex", dryRun: true, nonInteractive: true });

    expect(preview.removed).toContain(path.posix.join(candidateDir, editedSkill));
    expect(await pathExists(candidatePath)).toBe(true);
  });

  it("removes nothing when the run does not cover every installed target", async () => {
    await runInit({ cwd: tmp, target: "all", nonInteractive: true });
    const skillPath = path.join(tmp, editedSkill);
    await writeFile(skillPath, `${await readFile(skillPath, "utf8")}\n<!-- local edit -->\n`, "utf8");
    await runUpgrade({ cwd: tmp, nonInteractive: true });
    const candidatePath = path.join(tmp, candidateDir, editedSkill);
    await writeFile(skillPath, await readFile(candidatePath));

    const partial = await runUpgrade({ cwd: tmp, target: "claude", nonInteractive: true });

    expect(partial.removed).toEqual([]);
    expect(await pathExists(candidatePath)).toBe(true);
  });

  it("doctor reports a missing upgrades ignore and --fix restores it", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    await rm(path.join(tmp, upgradesIgnorePath));

    const diagnosis = await runDoctor({ cwd: tmp, nonInteractive: true });
    expect(diagnosis.missing).toContain(upgradesIgnorePath);

    await runDoctor({ cwd: tmp, fix: true, nonInteractive: true });
    expect(isLocalIgnoreContentSafe(await readFile(path.join(tmp, upgradesIgnorePath), "utf8"))).toBe(true);
  });

  it("doctor reports a weakened upgrades ignore", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    await writeFile(path.join(tmp, upgradesIgnorePath), "*.tmp\n", "utf8");

    const diagnosis = await runDoctor({ cwd: tmp, nonInteractive: true });

    expect(diagnosis.missing.some((gap) => gap.includes("must ignore upgrade candidates"))).toBe(true);
  });
});
