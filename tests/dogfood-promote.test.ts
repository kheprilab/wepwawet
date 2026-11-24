import { execFileSync } from "node:child_process";
import { existsSync, renameSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireLock,
  promote,
  rewireHooks,
  rewriteCommand,
  rewriteHookConfig,
  swapInto,
} from "../scripts/dogfood-promote.mjs";
import { guardCommand } from "../src/hook/guard.js";
import { hookCommand } from "../src/hook/install.js";

const OLD_NODE = "/old/nvm/v24.16.0/bin/node";
const OLD_ENTRY = "/old/nvm/lib/node_modules/wepwawet/dist/index.js";
const NODE = process.execPath;
const ENTRY = "/repo/.wep/local/bin/wep/dist/index.mjs";
const pinned = (rest: string) => `${JSON.stringify(OLD_NODE)} ${JSON.stringify(OLD_ENTRY)} ${rest}`;

describe("rewriteCommand", () => {
  it("repoints a pinned trace command to the stable copy, matching hookCommand", () => {
    const rewritten = rewriteCommand(pinned("hook PreToolUse --wep-trace --wep-host codex"), {
      node: NODE,
      entry: ENTRY,
    });
    expect(rewritten).toBe(hookCommand("PreToolUse", "codex", ENTRY));
  });

  it("repoints a pinned guard command, matching guardCommand", () => {
    expect(rewriteCommand(pinned("guard --wep-guard"), { node: NODE, entry: ENTRY })).toBe(guardCommand(ENTRY));
  });

  it.each([
    ["a command without a wep marker", pinned("hook PreToolUse --other-tool")],
    ["a legacy unpinned wep command", "wep hook PreToolUse"],
    ["an unrelated command", "npx prettier --check ."],
    ["a non-string", 42],
  ])("leaves %s alone", (_label, command) => {
    expect(rewriteCommand(command, { node: NODE, entry: ENTRY })).toBeUndefined();
  });

  it("returns undefined when the command already points at the stable copy", () => {
    expect(rewriteCommand(guardCommand(ENTRY), { node: NODE, entry: ENTRY })).toBeUndefined();
  });
});

describe("rewriteHookConfig", () => {
  it("rewrites only wep commands and keeps every other field", () => {
    const config = {
      model: "keep-me",
      hooks: {
        PreToolUse: [
          {
            matcher: "Edit|Write",
            hooks: [
              { type: "command", command: pinned("guard --wep-guard"), timeout: 5 },
              { type: "command", command: "echo other", timeout: 9 },
            ],
          },
        ],
        Stop: [{ hooks: [{ type: "command", command: pinned("hook Stop --wep-trace --wep-host codex"), timeout: 5 }] }],
      },
    };
    const { value, changed } = rewriteHookConfig(config, { node: NODE, entry: ENTRY });
    expect(changed).toBe(2);
    expect(value.model).toBe("keep-me");
    expect(value.hooks.PreToolUse[0].matcher).toBe("Edit|Write");
    expect(value.hooks.PreToolUse[0].hooks[0]).toEqual({ type: "command", command: guardCommand(ENTRY), timeout: 5 });
    expect(value.hooks.PreToolUse[0].hooks[1]).toEqual({ type: "command", command: "echo other", timeout: 9 });
    expect(value.hooks.Stop[0].hooks[0].command).toBe(hookCommand("Stop", "codex", ENTRY));
    expect(config.hooks.PreToolUse[0].hooks[0].command).toBe(pinned("guard --wep-guard"));
  });
});

describe("with a temporary repository", () => {
  let root: string;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "wep-dogfood-"));
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("does nothing without a dogfooded harness", async () => {
    const result = await promote({ cwd: root, log: () => {} });
    expect(result.status).toBe("no-harness");
    expect(execFileSync("git", ["status", "--porcelain", "--ignored"], { cwd: root, encoding: "utf8" })).toBe("");
  });

  it("rewires untracked hook files and never writes a tracked one", async () => {
    const tracked = {
      hooks: { Stop: [{ hooks: [{ type: "command", command: pinned("hook Stop --wep-trace --wep-host claude") }] }] },
    };
    const untracked = {
      hooks: { Stop: [{ hooks: [{ type: "command", command: pinned("hook Stop --wep-trace --wep-host codex") }] }] },
    };
    await mkdir(path.join(root, ".claude"), { recursive: true });
    await mkdir(path.join(root, ".codex"), { recursive: true });
    await writeFile(path.join(root, ".claude/settings.json"), JSON.stringify(tracked));
    git("add", ".claude/settings.json");
    git("commit", "-qm", "chore: tracked settings");
    await writeFile(path.join(root, ".codex/hooks.json"), JSON.stringify(untracked));

    const result = await rewireHooks(root, { node: NODE, entry: ENTRY });

    expect(result.rewritten).toEqual([".codex/hooks.json"]);
    expect(result.skippedTracked).toEqual([".claude/settings.json"]);
    const codex = JSON.parse(await readFile(path.join(root, ".codex/hooks.json"), "utf8"));
    expect(codex.hooks.Stop[0].hooks[0].command).toBe(hookCommand("Stop", "codex", ENTRY));
    expect(await readFile(path.join(root, ".claude/settings.json"), "utf8")).toBe(JSON.stringify(tracked));
  });

  it("rewires Antigravity hooks in .agents/hooks.json and preserves foreign hooks", async () => {
    const antigravity = {
      "foreign-hook": {
        Stop: [{ type: "command", command: "echo keep-me", timeout: 5 }],
      },
      "wep-trace": {
        SessionStart: [
          { type: "command", command: pinned("hook SessionStart --wep-trace --wep-host antigravity"), timeout: 5 },
        ],
        PreToolUse: [
          {
            matcher: "*",
            hooks: [
              { type: "command", command: pinned("hook PreToolUse --wep-trace --wep-host antigravity"), timeout: 5 },
            ],
          },
        ],
        PostToolUse: [
          {
            matcher: "*",
            hooks: [
              { type: "command", command: pinned("hook PostToolUse --wep-trace --wep-host antigravity"), timeout: 5 },
            ],
          },
        ],
        Stop: [{ type: "command", command: pinned("hook Stop --wep-trace --wep-host antigravity"), timeout: 5 }],
      },
    };
    await mkdir(path.join(root, ".agents"), { recursive: true });
    await writeFile(path.join(root, ".agents/hooks.json"), JSON.stringify(antigravity));

    const result = await rewireHooks(root, { node: NODE, entry: ENTRY });

    expect(result.rewritten).toEqual([".agents/hooks.json"]);
    expect(result.skippedTracked).toEqual([]);
    const rewritten = JSON.parse(await readFile(path.join(root, ".agents/hooks.json"), "utf8"));
    expect(rewritten["foreign-hook"]).toEqual(antigravity["foreign-hook"]);
    expect(rewritten["wep-trace"].SessionStart[0].command).toBe(hookCommand("SessionStart", "antigravity", ENTRY));
    expect(rewritten["wep-trace"].PreToolUse[0].matcher).toBe("*");
    expect(rewritten["wep-trace"].PreToolUse[0].hooks[0].command).toBe(hookCommand("PreToolUse", "antigravity", ENTRY));
    expect(rewritten["wep-trace"].PostToolUse[0].matcher).toBe("*");
    expect(rewritten["wep-trace"].PostToolUse[0].hooks[0].command).toBe(
      hookCommand("PostToolUse", "antigravity", ENTRY),
    );
    expect(rewritten["wep-trace"].Stop[0].command).toBe(hookCommand("Stop", "antigravity", ENTRY));
  });

  it("never overwrites a tracked .agents/hooks.json", async () => {
    const tracked = {
      "wep-trace": {
        Stop: [{ type: "command", command: pinned("hook Stop --wep-trace --wep-host antigravity"), timeout: 5 }],
      },
    };
    await mkdir(path.join(root, ".agents"), { recursive: true });
    await writeFile(path.join(root, ".agents/hooks.json"), JSON.stringify(tracked));
    git("add", ".agents/hooks.json");
    git("commit", "-qm", "chore: tracked antigravity hooks");

    const result = await rewireHooks(root, { node: NODE, entry: ENTRY });

    expect(result.rewritten).toEqual([]);
    expect(result.skippedTracked).toEqual([".agents/hooks.json"]);
    expect(await readFile(path.join(root, ".agents/hooks.json"), "utf8")).toBe(JSON.stringify(tracked));
  });

  it("lets only one promote hold the lock", async () => {
    const dir = path.join(root, "lockdir");
    await mkdir(dir);
    const first = acquireLock(dir);
    expect(first).toBeTypeOf("function");
    expect(acquireLock(dir)).toBeUndefined();
    first?.();
    const again = acquireLock(dir);
    expect(again).toBeTypeOf("function");
    again?.();
  });

  it("reports busy and changes nothing while another promote holds the lock", async () => {
    await mkdir(path.join(root, ".wep/local/bin"), { recursive: true });
    await writeFile(path.join(root, ".wep/config.json"), "{}");
    const release = acquireLock(path.join(root, ".wep/local/bin"));
    try {
      const result = await promote({ cwd: root, fetch: false, log: () => {} });
      expect(result.status).toBe("busy");
      expect(await readdir(path.join(root, ".wep/local/bin"))).toEqual([".promote.lock"]);
    } finally {
      release?.();
    }
  });

  it("swaps the new copy in and removes the old one", async () => {
    await mkdir(path.join(root, "target"));
    await writeFile(path.join(root, "target/v"), "old");
    await mkdir(path.join(root, "staging"));
    await writeFile(path.join(root, "staging/v"), "new");
    swapInto(path.join(root, "staging"), path.join(root, "target"));
    expect(await readFile(path.join(root, "target/v"), "utf8")).toBe("new");
    expect((await readdir(root)).filter((name) => name.startsWith("target.old-"))).toEqual([]);
  });

  it("puts the previous copy back when the swap fails", async () => {
    await mkdir(path.join(root, "target"));
    await writeFile(path.join(root, "target/v"), "old");
    let calls = 0;
    const failingSecondRename = {
      existsSync,
      rmSync,
      renameSync: (from: string, to: string) => {
        calls += 1;
        if (calls === 2) throw new Error("rename failed");
        renameSync(from, to);
      },
    };
    expect(() => swapInto(path.join(root, "staging"), path.join(root, "target"), failingSecondRename)).toThrow(
      "rename failed",
    );
    expect(await readFile(path.join(root, "target/v"), "utf8")).toBe("old");
    expect((await readdir(root)).filter((name) => name.startsWith("target.old-"))).toEqual([]);
  });
});
