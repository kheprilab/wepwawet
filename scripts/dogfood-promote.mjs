#!/usr/bin/env node
// Promote a stable wep build for the harness this repository uses on itself (dogfooding).
//
//   node scripts/dogfood-promote.mjs [--no-fetch] [--force]
//
// Builds wep from origin/main in a temporary worktree, runs the tests, bundles it into
// .wep/local/bin/wep/ and repoints this checkout's existing wep hooks to that copy. The working
// tree never supplies the code: an agent on a branch cannot put its own build into the guard.
// Without .wep/config.json it does nothing. It does not change how the product writes hooks.

import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MARKERS = ["--wep-trace", "--wep-guard"];
// Every file the product wires hooks into. Tracked files are never written.
const HOOK_FILES = [
  ".codex/hooks.json",
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".github/hooks/wep-trace.json",
  ".agents/hooks.json",
];
const PINNED = /^("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*") (.+)$/;
const STALE_LOCK_MS = 60 * 60 * 1000;
const BANNER =
  'import { createRequire as __wepCreateRequire } from "node:module"; const require = __wepCreateRequire(import.meta.url);';

/** The command repointed at `entry`, or undefined when it is not a pinned wep command or is already current. */
export function rewriteCommand(command, { node, entry }) {
  if (typeof command !== "string") return undefined;
  const match = PINNED.exec(command);
  if (!match) return undefined;
  try {
    JSON.parse(match[1]);
    JSON.parse(match[2]);
  } catch {
    return undefined;
  }
  const rest = match[3];
  if (!MARKERS.some((marker) => rest.split(" ").includes(marker))) return undefined;
  const next = `${JSON.stringify(node)} ${JSON.stringify(entry)} ${rest}`;
  return next === command ? undefined : next;
}

/** A copy of a host hook config with every wep command repointed. The input is not modified. */
export function rewriteHookConfig(config, target) {
  let changed = 0;
  const walk = (value) => {
    if (Array.isArray(value)) return value.map(walk);
    if (!value || typeof value !== "object") return value;
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      const rewritten = key === "command" ? rewriteCommand(child, target) : undefined;
      if (rewritten !== undefined) changed += 1;
      out[key] = rewritten ?? walk(child);
    }
    return out;
  };
  return { value: walk(config), changed };
}

function isTracked(root, relative) {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", "--", relative], { cwd: root, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Repoint the wep hooks already wired in this checkout. Never wires new hooks, never writes a tracked file. */
export async function rewireHooks(root, target) {
  const rewritten = [];
  const skippedTracked = [];
  const skippedInvalid = [];
  for (const relative of HOOK_FILES) {
    const file = path.join(root, relative);
    if (!existsSync(file)) continue;
    let config;
    try {
      config = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      skippedInvalid.push(relative);
      continue;
    }
    const { value, changed } = rewriteHookConfig(config, target);
    if (changed === 0) continue;
    if (isTracked(root, relative)) {
      skippedTracked.push(relative);
      continue;
    }
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
    rewritten.push(relative);
  }
  return { rewritten, skippedTracked, skippedInvalid };
}

/** Take the promote lock in `dir`. Returns a release function, or undefined when another run holds it. */
export function acquireLock(dir) {
  const lock = path.join(dir, ".promote.lock");
  const take = () => {
    mkdirSync(lock);
    return () => rmSync(lock, { recursive: true, force: true });
  };
  try {
    return take();
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  // A run that crashed leaves the lock behind; a lock older than any real run is taken over.
  if (Date.now() - statSync(lock).mtimeMs < STALE_LOCK_MS) return undefined;
  rmSync(lock, { recursive: true, force: true });
  try {
    return take();
  } catch {
    return undefined;
  }
}

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function step(log, command, args, cwd) {
  log(`$ ${command} ${args.join(" ")}`);
  execFileSync(command, args, { cwd, stdio: ["ignore", "inherit", "inherit"] });
}

function readPromoted(target) {
  try {
    return JSON.parse(readFileSync(path.join(target, "PROMOTED.json"), "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Replace `target` with `staging`. When the second rename fails, the previous copy is put back,
 * so there is never a moment where a failure leaves no stable copy behind.
 */
export function swapInto(staging, target, fs = { existsSync, renameSync, rmSync }) {
  const old = fs.existsSync(target) ? `${target}.old-${Date.now()}` : undefined;
  if (old) fs.renameSync(target, old);
  try {
    fs.renameSync(staging, target);
  } catch (error) {
    if (old) fs.renameSync(old, target);
    throw error;
  }
  if (old) fs.rmSync(old, { recursive: true, force: true });
}

/** Build, test and bundle `commit` in a temporary worktree, then swap it into `target`. */
function build(root, commit, binDir, target, log) {
  let worktree;
  let staging;
  let added = false;
  try {
    worktree = mkdtempSync(path.join(os.tmpdir(), "wep-promote-"));
    staging = mkdtempSync(path.join(binDir, ".staging-"));
    git(root, ["worktree", "add", "--detach", "--quiet", worktree, commit]);
    added = true;
    step(log, "pnpm", ["install", "--frozen-lockfile", "--prefer-offline"], worktree);
    step(log, "pnpm", ["test"], worktree);
    step(log, "pnpm", ["build"], worktree);
    const bundle = path.join(staging, "dist/index.mjs");
    step(
      log,
      "pnpm",
      [
        "exec",
        "esbuild",
        // From source: tsup's dist drops the node: prefix, which esbuild cannot resolve for readline/promises.
        "src/index.ts",
        "--bundle",
        "--platform=node",
        "--format=esm",
        "--target=node20",
        "--log-level=warning",
        `--outfile=${bundle}`,
        `--banner:js=${BANNER}`,
      ],
      worktree,
    );
    // template-pack.ts reads ../templates next to the running file.
    cpSync(path.join(worktree, "templates"), path.join(staging, "templates"), { recursive: true });

    const { version } = JSON.parse(readFileSync(path.join(worktree, "package.json"), "utf8"));
    const reported = execFileSync(process.execPath, [bundle, "--version"], { encoding: "utf8" }).trim();
    if (reported !== version) {
      throw new Error(`smoke run failed: the bundle reports "${reported}", expected "${version}".`);
    }
    writeFileSync(
      path.join(staging, "PROMOTED.json"),
      `${JSON.stringify({ commit, version, promotedAt: new Date().toISOString() }, null, 2)}\n`,
    );

    // Swap only now that tests, build and smoke run passed.
    swapInto(staging, target);
    log(`promoted wep ${version} from ${commit.slice(0, 7)}`);
  } finally {
    if (added) {
      try {
        git(root, ["worktree", "remove", "--force", worktree]);
      } catch {
        // Fall through to the directory removal and prune below.
      }
    }
    if (worktree) rmSync(worktree, { recursive: true, force: true });
    if (added) {
      try {
        git(root, ["worktree", "prune"]);
      } catch {}
    }
    if (staging) rmSync(staging, { recursive: true, force: true });
  }
}

/** Promote origin/main into the local harness. Resolves to a status object; throws when a step fails. */
export async function promote({ cwd = process.cwd(), fetch = true, force = false, log = console.log } = {}) {
  const root = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!existsSync(path.join(root, ".wep/config.json"))) {
    log("No dogfooded harness (.wep/config.json is missing); nothing to do.");
    return { status: "no-harness" };
  }
  const binDir = path.join(root, ".wep/local/bin");
  mkdirSync(binDir, { recursive: true });
  const release = acquireLock(binDir);
  if (!release) {
    log("Another promote is running; nothing to do.");
    return { status: "busy" };
  }
  try {
    if (fetch) {
      try {
        git(root, ["fetch", "--quiet", "origin", "main"]);
      } catch (error) {
        log(`warning: could not fetch origin/main, using the local ref (${error.message.split("\n")[0]}).`);
      }
    }
    const commit = git(root, ["rev-parse", "--verify", "origin/main^{commit}"]);
    const target = path.join(binDir, "wep");
    const bundle = path.join(target, "dist/index.mjs");
    const current = readPromoted(target)?.commit === commit && existsSync(bundle);
    if (current && !force) {
      log(`Stable wep is already at ${commit.slice(0, 7)}.`);
    } else {
      build(root, commit, binDir, target, log);
    }
    // Always rewire: a new Node version is picked up here even when the build is current.
    let rewire;
    try {
      rewire = await rewireHooks(root, { node: process.execPath, entry: realpathSync(bundle) });
    } catch (error) {
      // The stable copy is already in place here, so the "nothing changed" message would be false.
      throw Object.assign(new Error(`rewiring the hooks failed: ${error.message}`), { partial: true });
    }
    for (const file of rewire.rewritten) log(`rewired ${file}`);
    for (const file of rewire.skippedTracked)
      log(`warning: ${file} is tracked by git; its wep hooks were not changed.`);
    for (const file of rewire.skippedInvalid) log(`warning: ${file} is not valid JSON; it was not changed.`);
    return { status: current && !force ? "current" : "promoted", commit, ...rewire };
  } finally {
    release();
  }
}

function isMain() {
  // Node runs the real path of a symlinked script (macOS $TMPDIR is under /var -> /private/var).
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? "")).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  const args = process.argv.slice(2);
  promote({ fetch: !args.includes("--no-fetch"), force: args.includes("--force") }).then(
    () => process.exit(0),
    (error) => {
      console.error(`dogfood-promote: ${error instanceof Error ? error.message : String(error)}`);
      console.error(
        error?.partial
          ? "The stable wep was updated, but the hooks may be only partly rewired. Run pnpm dogfood:promote again."
          : "The previous stable wep and the hooks were left unchanged.",
      );
      process.exit(1);
    },
  );
}
