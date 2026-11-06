import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { readConfig } from "../src/config.js";
import { runDoctor } from "../src/doctor.js";
import { pathExists } from "../src/fs-utils.js";
import { runInit } from "../src/init.js";
import { runJudgeDisable, runJudgeEnable, runJudgeStatus } from "../src/judge.js";

import { tmp, useTempDir } from "./helpers/wep.js";

useTempDir();

describe("judge", () => {
  it("enable generates agent files for installed targets and sets enabled in config", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });

    const result = await runJudgeEnable({ cwd: tmp, nonInteractive: true });

    expect(result.installedTargets).toContain("codex");
    expect(result.skippedTargets).not.toContain("codex");
    expect(await pathExists(path.join(tmp, ".codex/agents/wep-judge.toml"))).toBe(true);
    const config = await readConfig(tmp);
    expect(config?.judge?.enabled).toBe(true);
    expect(config?.judge?.trigger).toBe("post-implementation");
  });

  it("enable refuses a missing deterministic review contract", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    await rm(path.join(tmp, ".wep/judge/schemas/review.schema.json"));

    await expect(runJudgeEnable({ cwd: tmp, nonInteractive: true })).rejects.toThrow("wep upgrade");
  });

  it("enable skips pi and does not error", async () => {
    await runInit({ cwd: tmp, target: "all", nonInteractive: true });

    const result = await runJudgeEnable({ cwd: tmp, nonInteractive: true });

    expect(result.skippedTargets).toContain("pi");
    expect(result.installedTargets).toContain("codex");
    expect(result.installedTargets).toContain("claude");
    expect(result.installedTargets).toContain("copilot");
  });

  it("generated judge files do not contain a model field", async () => {
    await runInit({ cwd: tmp, target: "all", nonInteractive: true });
    await runJudgeEnable({ cwd: tmp, nonInteractive: true });

    const claudeFile = await readFile(path.join(tmp, ".claude/agents/wep-judge.md"), "utf8");
    const copilotFile = await readFile(path.join(tmp, ".github/agents/wep-judge.agent.md"), "utf8");
    const codexFile = await readFile(path.join(tmp, ".codex/agents/wep-judge.toml"), "utf8");

    expect(claudeFile).not.toMatch(/^model:/m);
    expect(copilotFile).not.toMatch(/^model:/m);
    expect(codexFile).not.toMatch(/^model\s*=/m);
  });

  it("CLI judge enable --dry-run reports 'would enable' instead of claiming success", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    await runJudgeDisable({ cwd: tmp, nonInteractive: true });
    const previousCwd = process.cwd();
    const writes: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      writes.push(String(message));
    };

    try {
      process.chdir(tmp);
      await main(["node", "wep", "judge", "enable", "--dry-run"]);
    } finally {
      process.chdir(previousCwd);
      console.log = originalLog;
    }

    expect(writes.join("\n")).toContain("would enable (dry-run)");
    expect(writes.join("\n")).not.toContain("Judge: enabled");
    const config = await readConfig(tmp);
    expect(config?.judge?.enabled).toBe(false);
  });

  it("disable sets enabled to false without removing files", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    await runJudgeEnable({ cwd: tmp, nonInteractive: true });

    await runJudgeDisable({ cwd: tmp, nonInteractive: true });

    const config = await readConfig(tmp);
    expect(config?.judge?.enabled).toBe(false);
    expect(await pathExists(path.join(tmp, ".codex/agents/wep-judge.toml"))).toBe(true);
  });

  it("status reflects enabled state and lists present files", async () => {
    await runInit({ cwd: tmp, target: "claude", nonInteractive: true });
    await runJudgeEnable({ cwd: tmp, nonInteractive: true });

    const status = await runJudgeStatus({ cwd: tmp, nonInteractive: true });

    expect(status.enabled).toBe(true);
    expect(status.presentFiles).toContain(".claude/agents/wep-judge.md");
    expect(status.missingFiles).toHaveLength(0);
  });

  it("init installs judge files and enables judge by default", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });

    expect(await pathExists(path.join(tmp, ".codex/agents/wep-judge.toml"))).toBe(true);
    const config = await readConfig(tmp);
    expect(config?.judge?.enabled).toBe(true);
  });

  it("doctor detects judge.enabled=true without agent files and suggests wep judge enable", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    await rm(path.join(tmp, ".codex/agents/wep-judge.toml"), { force: true });

    const configPath = path.join(tmp, ".wep/config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.judge = { enabled: true, trigger: "post-implementation" };
    await writeFile(configPath, JSON.stringify(config, null, 2), "utf8");

    const result = await runDoctor({ cwd: tmp, nonInteractive: true });

    expect(result.suggestions.some((s) => s.text.includes("wep judge enable"))).toBe(true);
  });
});
