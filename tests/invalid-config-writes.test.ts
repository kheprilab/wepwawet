import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readConfig } from "../src/config.js";
import { runDoctor } from "../src/doctor.js";
import { runInit } from "../src/init.js";
import { tmp, useTempDir } from "./helpers/wep.js";

useTempDir();

async function projectBytes(directory = tmp): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(tmp, absolute);
    if (entry.isDirectory()) {
      result[`${relative}/`] = "directory";
      Object.assign(result, await projectBytes(absolute));
    } else {
      result[relative] = (await readFile(absolute)).toString("base64");
    }
  }
  return result;
}

const invalidConfigs = [
  ["broken JSON", "{broken-json\n", "invalid JSON"],
  ["null", "null", "not a JSON object"],
  ["array", "[]", "not a JSON object"],
  ["missing targets", "{}", "no recognized target"],
  ["unknown targets", '{"targets":["unknown"]}', "no recognized target"],
  ["invalid agents", '{"targets":["codex"],"agents":[]}', "agents"],
  ["invalid attempt budget", '{"targets":["codex"],"agents":{"implementer":{"maxAttempts":0}}}', "maxAttempts"],
] as const;

describe.each(invalidConfigs)("unusable config: %s", (_label, contents, error) => {
  it.each([
    ["init", { force: false, dryRun: false }],
    ["init --force", { force: true, dryRun: false }],
    ["init --dry-run", { force: false, dryRun: true }],
  ])("%s refuses before changing any project file", async (_command, flags) => {
    await mkdir(path.join(tmp, ".wep/wiki"), { recursive: true });
    await writeFile(path.join(tmp, ".wep/config.json"), contents);
    await writeFile(path.join(tmp, ".wep/wiki/gaps.md"), "Keep this existing report.\n");
    await writeFile(path.join(tmp, "AGENTS.md"), "Keep the project's instructions.\n");
    const before = await projectBytes();

    await expect(runInit({ cwd: tmp, target: "codex", nonInteractive: true, ...flags })).rejects.toThrow(error);

    expect(await projectBytes()).toEqual(before);
  });

  it.each([false, true])("doctor --fix (force=%s) refuses before reports or repairs", async (force) => {
    await mkdir(path.join(tmp, ".wep/wiki"), { recursive: true });
    await writeFile(path.join(tmp, ".wep/config.json"), contents);
    await writeFile(path.join(tmp, ".wep/wiki/gaps.md"), "Keep this existing report.\n");
    await writeFile(path.join(tmp, "AGENTS.md"), "Keep the project's instructions.\n");
    const before = await projectBytes();

    await expect(runDoctor({ cwd: tmp, fix: true, force, nonInteractive: true })).rejects.toThrow(error);

    expect(await projectBytes()).toEqual(before);
  });
});

it("still initializes a project whose config is missing", async () => {
  await writeFile(path.join(tmp, "CLAUDE.md"), "Existing Claude instructions.\n");

  await runInit({ cwd: tmp, target: "claude", nonInteractive: true });
  await runDoctor({ cwd: tmp, fix: true, nonInteractive: true });

  expect((await readConfig(tmp))?.targets).toEqual(["claude"]);
  expect(await readFile(path.join(tmp, "CLAUDE.md"), "utf8")).toBe("Existing Claude instructions.\n");
});
