import { mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { installGuard } from "../src/hook/guard.js";
import { runTraceEnable, runTraceStatus } from "../src/hook/install.js";
import { runInit } from "../src/init.js";
import { contentHash, readManifest } from "../src/manifest.js";
import { runMigrate } from "../src/migrate.js";
import { tmp, useTempDir } from "./helpers/wep.js";

useTempDir();
const legacyRoot = ".akrctx";

function legacyReferences(text: string): string {
  return text.replaceAll("$WEP_CLI", "$AKRCTX").replaceAll("WEP_", "AKRCTX_").replaceAll("wep", "akrctx");
}

async function tree(root = tmp): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(directory: string) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      if (item.isDirectory()) await walk(file);
      else if (item.isFile()) result[path.relative(root, file)] = (await readFile(file)).toString("base64");
    }
  }
  await walk(root);
  return result;
}

async function legacyInstall() {
  await runInit({ cwd: tmp, target: "all", nonInteractive: true });
  await runTraceEnable({ cwd: tmp });
  await installGuard(tmp);
  const files = await tree();
  for (const [relative, bytes] of Object.entries(files)) {
    await writeFile(path.join(tmp, relative), legacyReferences(Buffer.from(bytes, "base64").toString("utf8")));
  }
  async function renameChildren(directory: string) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const source = path.join(directory, item.name);
      if (item.isDirectory()) await renameChildren(source);
      const next = legacyReferences(item.name);
      if (next !== item.name) await rename(source, path.join(directory, next));
    }
  }
  await renameChildren(tmp);
  const file = path.join(tmp, legacyRoot, "manifest.json");
  const manifest = JSON.parse(await readFile(file, "utf8"));
  manifest.cliVersion = "0.7.1";
  for (const [relative, record] of Object.entries(manifest.files)) {
    (record as { hash: string }).hash = contentHash(await readFile(path.join(tmp, relative)));
  }
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

describe("namespace migration", () => {
  it("moves active files, repins every host, preserves foreign hooks and rebinds verified provenance", async () => {
    await legacyInstall();
    const settingsFile = path.join(tmp, ".claude/settings.json");
    const settings = JSON.parse(await readFile(settingsFile, "utf8"));
    const foreign = { hooks: [{ type: "command", command: "echo akrctx user note" }] };
    settings.hooks.PreToolUse.unshift(foreign);
    settings.userNote = "akrctx is a literal user value";
    await writeFile(settingsFile, JSON.stringify(settings));
    const result = await runMigrate({ cwd: tmp });
    expect(result.status).toBe("migrated");
    await expect(stat(path.join(tmp, legacyRoot))).rejects.toMatchObject({ code: "ENOENT" });
    const config = JSON.parse(await readFile(path.join(tmp, ".wep/config.json"), "utf8"));
    expect(config).toMatchObject({ sourceOfTruth: ".wep", createdBy: "wep" });
    expect((await runTraceStatus({ cwd: tmp })).unwiredTargets).toEqual([]);
    const next = JSON.parse(await readFile(settingsFile, "utf8"));
    expect(next.hooks.PreToolUse).toContainEqual(foreign);
    expect(next.userNote).toBe(settings.userNote);
    const guard = await readFile(path.join(tmp, ".claude/settings.local.json"), "utf8");
    expect(guard).toContain("--wep-guard");
    expect(guard).not.toContain("--akrctx-guard");
    const manifest = await readManifest(tmp);
    for (const [relative, record] of Object.entries(manifest?.files ?? {})) {
      expect(record.hash, relative).toBe(contentHash(await readFile(path.join(tmp, relative))));
      expect(relative).not.toContain("akrctx");
    }
    expect(manifest?.cliVersion).toBe("0.7.1");
    expect((await runMigrate({ cwd: tmp })).status).toBe("already-migrated");
  });

  it("keeps review records and snapshots byte-for-byte, including timestamps, and reports the exception", async () => {
    await legacyInstall();
    const relative = "local/judge/TASK-001/review.json";
    const record =
      '{"scopeDigest":"sha256:old-boundary","path":".akrctx/tasks/TASK-001","command":"akrctx judge run"}\n';
    const file = path.join(tmp, legacyRoot, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, record);
    const before = await stat(file);
    const snapshot = "local/judge/snapshots/frozen/worktree/AGENTS.md";
    await mkdir(path.dirname(path.join(tmp, legacyRoot, snapshot)), { recursive: true });
    await writeFile(path.join(tmp, legacyRoot, snapshot), "frozen .akrctx evidence\n");
    const result = await runMigrate({ cwd: tmp });
    expect(await readFile(path.join(tmp, ".wep", relative), "utf8")).toBe(record);
    expect((await stat(path.join(tmp, ".wep", relative))).mtimeMs).toBe(before.mtimeMs);
    expect(await readFile(path.join(tmp, ".wep", snapshot), "utf8")).toBe("frozen .akrctx evidence\n");
    expect(result.preserved).toContain(".wep/local/judge");
    expect(result.notices.join(" ")).toContain("preserved byte-for-byte");
    expect(result.notices.join(" ")).toContain("legacy names");
  });

  it("dry-run performs the same planning without changing file bytes, names or modification times", async () => {
    await legacyInstall();
    const before = await tree();
    const config = path.join(tmp, legacyRoot, "config.json");
    const timestamp = (await stat(config)).mtimeMs;
    const result = await runMigrate({ cwd: tmp, dryRun: true });
    expect(result.status).toBe("would-migrate");
    expect(result.renamed.length).toBeGreaterThan(1);
    expect(await tree()).toEqual(before);
    expect((await stat(config)).mtimeMs).toBe(timestamp);
    await expect(stat(path.join(tmp, ".wep"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([".wep", ".agents/skills/wep-task", ".github/hooks/wep-trace.json"])(
    "refuses destination collision %s before any writes",
    async (collision) => {
      await legacyInstall();
      if (collision.endsWith(".json")) await writeFile(path.join(tmp, collision), "foreign\n");
      else await mkdir(path.join(tmp, collision), { recursive: true });
      const before = await tree();
      await expect(runMigrate({ cwd: tmp })).rejects.toThrow(/exist|collid/i);
      expect(await tree()).toEqual(before);
      expect((await stat(path.join(tmp, legacyRoot))).isDirectory()).toBe(true);
    },
  );

  it("does not authenticate customized integration content as generated provenance", async () => {
    await legacyInstall();
    const relative = ".agents/skills/akrctx-task/SKILL.md";
    await writeFile(
      path.join(tmp, relative),
      `${await readFile(path.join(tmp, relative), "utf8")}\nLocal customization.\n`,
    );
    await runMigrate({ cwd: tmp });
    const nextPath = ".agents/skills/wep-task/SKILL.md";
    const content = await readFile(path.join(tmp, nextPath), "utf8");
    expect(content).toContain("Local customization.");
    expect(content).not.toContain(".akrctx");
    expect((await readManifest(tmp))?.files[nextPath]?.hash).not.toBe(contentHash(content));
  });

  it("migrates template-pack and upgrade-candidate provenance without losing customization detection", async () => {
    await legacyInstall();
    const relative = ".agents/skills/custom/SKILL.md";
    await mkdir(path.dirname(path.join(tmp, relative)), { recursive: true });
    await writeFile(path.join(tmp, relative), "Custom instructions: .akrctx/tasks/\n");
    const hash = contentHash(await readFile(path.join(tmp, relative)));
    const configFile = path.join(tmp, legacyRoot, "config.json");
    const config = JSON.parse(await readFile(configFile, "utf8"));
    config.templatePacks = [
      { name: "custom", version: "1.0.0", source: "local", targets: ["codex"], fileHashes: { [relative]: hash } },
    ];
    await writeFile(configFile, JSON.stringify(config));
    const candidate = `${legacyRoot}/upgrades/0.7.1/.agents/skills/custom/SKILL.md`;
    await mkdir(path.dirname(path.join(tmp, candidate)), { recursive: true });
    await writeFile(path.join(tmp, candidate), "Candidate instructions: .akrctx/tasks/\n");
    const manifestFile = path.join(tmp, legacyRoot, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
    manifest.files[relative] = { hash };
    manifest.candidates = { [candidate]: { hash: contentHash(await readFile(path.join(tmp, candidate))) } };
    await writeFile(manifestFile, JSON.stringify(manifest));
    const ledgerFile = path.join(tmp, legacyRoot, "local/upgrade-candidates.json");
    const manifestCandidate = `${legacyRoot}/upgrades/0.7.1/${legacyRoot}/manifest.json`;
    await mkdir(path.dirname(path.join(tmp, manifestCandidate)), { recursive: true });
    await writeFile(path.join(tmp, manifestCandidate), '{"path":".akrctx"}\n');
    await writeFile(
      ledgerFile,
      JSON.stringify({
        version: 1,
        candidates: { [manifestCandidate]: { hash: contentHash(await readFile(path.join(tmp, manifestCandidate))) } },
      }),
    );

    await runMigrate({ cwd: tmp });
    const nextConfig = JSON.parse(await readFile(path.join(tmp, ".wep/config.json"), "utf8"));
    const nextManifest = await readManifest(tmp);
    const nextHash = contentHash(await readFile(path.join(tmp, relative)));
    expect(nextConfig.templatePacks[0].fileHashes[relative]).toBe(nextHash);
    expect(nextManifest?.files[relative].hash).toBe(nextHash);
    const nextCandidate = candidate.replaceAll(legacyRoot, ".wep");
    expect(nextManifest?.candidates?.[nextCandidate].hash).toBe(
      contentHash(await readFile(path.join(tmp, nextCandidate))),
    );
    const ledger = JSON.parse(await readFile(path.join(tmp, ".wep/local/upgrade-candidates.json"), "utf8"));
    const nextManifestCandidate = manifestCandidate.replaceAll(legacyRoot, ".wep");
    expect(ledger.candidates[nextManifestCandidate].hash).toBe(
      contentHash(await readFile(path.join(tmp, nextManifestCandidate))),
    );
  });

  it("keeps renamed paths lowercase and preserves blocked files and binary assets", async () => {
    await legacyInstall();
    await mkdir(path.join(tmp, legacyRoot, "wiki/akrcontext"));
    await writeFile(path.join(tmp, legacyRoot, "wiki/akrcontext/overview.md"), "akrcontext overview\n");
    const bytes = Buffer.from([0, 255, 1, 128]);
    await writeFile(path.join(tmp, legacyRoot, "asset.bin"), bytes);
    await mkdir(path.join(tmp, legacyRoot, "secrets"));
    await writeFile(path.join(tmp, legacyRoot, "secrets/keep.txt"), "opaque legacy contents\n");
    const result = await runMigrate({ cwd: tmp });
    expect(await readFile(path.join(tmp, ".wep/wiki/wepwawet/overview.md"), "utf8")).toBe("Wepwawet overview\n");
    expect(await readFile(path.join(tmp, ".wep/asset.bin"))).toEqual(bytes);
    expect(await readFile(path.join(tmp, ".wep/secrets/keep.txt"), "utf8")).toBe("opaque legacy contents\n");
    expect(result.preserved).toContain(".wep/secrets");
  });

  it.each(["missing-version", "traversal"])(
    "refuses invalid manifest provenance (%s) before any writes",
    async (variant) => {
      await legacyInstall();
      const file = path.join(tmp, legacyRoot, "manifest.json");
      const manifest = JSON.parse(await readFile(file, "utf8"));
      if (variant === "missing-version") Reflect.deleteProperty(manifest, "cliVersion");
      else manifest.files["../outside"] = { hash: `sha256:${"a".repeat(64)}` };
      await writeFile(file, JSON.stringify(manifest));
      const before = await tree();
      await expect(runMigrate({ cwd: tmp })).rejects.toThrow(/manifest/i);
      expect(await tree()).toEqual(before);
    },
  );

  it("refuses malformed shared settings without moving the root or rewriting any file", async () => {
    await legacyInstall();
    await writeFile(path.join(tmp, ".codex/hooks.json"), "not json");
    const before = await tree();
    await expect(runMigrate({ cwd: tmp })).rejects.toThrow("invalid JSON");
    expect(await tree()).toEqual(before);
  });

  it("refuses symlinked integration directories and leaves their target untouched", async () => {
    await legacyInstall();
    const outside = path.join(tmp, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "SKILL.md"), "outside .akrctx content\n");
    const skill = path.join(tmp, ".agents/skills/akrctx-task");
    await rm(skill, { recursive: true });
    await symlink(outside, skill);
    await expect(runMigrate({ cwd: tmp })).rejects.toThrow("symbolic links");
    expect(await readFile(path.join(outside, "SKILL.md"), "utf8")).toBe("outside .akrctx content\n");
    expect((await stat(path.join(tmp, legacyRoot))).isDirectory()).toBe(true);
  });

  it("reports an absent legacy install without creating a new harness", async () => {
    expect((await runMigrate({ cwd: tmp })).status).toBe("not-found");
    expect(await readdir(tmp)).toEqual([]);
  });

  it("exposes dry-run and migration notices through the CLI", async () => {
    await legacyInstall();
    const previousCwd = process.cwd();
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((message) => logs.push(String(message)));
    try {
      process.chdir(tmp);
      await main(["node", "wep", "migrate", "--dry-run", "--json"]);
      expect(JSON.parse(logs.join("\n")).status).toBe("would-migrate");
      logs.length = 0;
      await main(["node", "wep", "migrate"]);
      expect(logs.join("\n")).toContain("preserved byte-for-byte");
    } finally {
      process.chdir(previousCwd);
      spy.mockRestore();
    }
  });
});
