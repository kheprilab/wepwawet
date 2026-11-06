import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathExists, writePlannedFile } from "../fs-utils.js";
import { type RunLockEnv, readActiveRun } from "../judge-run-lock.js";
import { resolveCliEntry } from "./install.js";

/**
 * Ownership marker of the run guard. Distinct from the trace marker, so enabling or disabling one
 * never removes the other's entries.
 */
export const GUARD_MARKER = "--wep-guard";

/**
 * Per-developer Claude Code settings, not committed. The command pins this machine's Node binary
 * and CLI entry, which would break for every other clone in the shared `settings.json`.
 */
export const GUARD_SETTINGS_PATH = ".claude/settings.local.json";

/** Claude Code tools that write files. Shell writes are not visible here; the after-digest covers them. */
export const GUARD_MATCHER = "Edit|Write|MultiEdit|NotebookEdit";
const guardedTools = new Set(GUARD_MATCHER.split("|"));

export interface GuardDecision {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: "deny";
    permissionDecisionReason: string;
  };
}

/**
 * Refuse a file-writing tool while a validation run holds the lock.
 *
 * Fails open: unreadable input, a missing or corrupt lock, a stale lock, or any error lets the
 * tool through. A guard bug must never block an agent; the run's after-digest still catches an
 * edit the guard missed.
 */
export async function runGuard(stdin: string, cwd: string, env: RunLockEnv = {}): Promise<GuardDecision | undefined> {
  try {
    const payload = JSON.parse(stdin) as { tool_name?: unknown; cwd?: unknown };
    if (typeof payload.tool_name !== "string" || !guardedTools.has(payload.tool_name)) return undefined;
    const start = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : cwd;
    const run = await readActiveRun(await projectRoot(start), env);
    if (!run) return undefined;
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `wep judge run is validating ${run.taskId} in this working tree since ${run.startedAt} (PID ${run.pid} on ${run.host}). Editing files now invalidates that run. Wait until it finishes, then retry this edit.`,
      },
    };
  } catch {
    return undefined;
  }
}

/** The nearest directory at or above `start` with an wep install; `start` itself when there is none. */
async function projectRoot(start: string): Promise<string> {
  let directory = path.resolve(start);
  for (;;) {
    if (await pathExists(path.join(directory, ".wep/config.json"))) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) return start;
    directory = parent;
  }
}

export function guardCommand(entry = resolveCliEntry()): string {
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(entry)} guard ${GUARD_MARKER}`;
}

/** Install the guard in the local Claude Code settings. Returns the path it wrote, if any. */
export async function installGuard(cwd: string, options: { dryRun?: boolean } = {}): Promise<string | undefined> {
  const settings = await readSettings(cwd);
  const hooks = { ...((settings.hooks as Record<string, unknown>) ?? {}) };
  const current = Array.isArray(hooks.PreToolUse) ? (hooks.PreToolUse as unknown[]) : [];
  hooks.PreToolUse = [
    ...current.filter((entry) => !isGuardEntry(entry)),
    { matcher: GUARD_MATCHER, hooks: [{ type: "command", command: guardCommand(), timeout: 5 }] },
  ];
  return writeSettings(cwd, { ...settings, hooks }, options, "wep run guard hook.");
}

/** Remove only the guard's entries, keeping every other hook. Returns the path it wrote, if any. */
export async function removeGuard(cwd: string, options: { dryRun?: boolean } = {}): Promise<string | undefined> {
  const settings = await readSettings(cwd);
  const hooks = settings?.hooks as Record<string, unknown> | undefined;
  if (!hooks || !Array.isArray(hooks.PreToolUse)) return undefined;
  const kept = (hooks.PreToolUse as unknown[]).filter((entry) => !isGuardEntry(entry));
  if (kept.length === hooks.PreToolUse.length) return undefined;
  const { PreToolUse: _removed, ...otherEvents } = hooks;
  const nextHooks = kept.length > 0 ? { ...otherEvents, PreToolUse: kept } : otherEvents;
  const { hooks: _hooks, ...rest } = settings;
  const next = Object.keys(nextHooks).length > 0 ? { ...rest, hooks: nextHooks } : rest;
  return writeSettings(cwd, next, options, "Removed the wep run guard hook.");
}

function isGuardEntry(entry: unknown): boolean {
  return JSON.stringify(entry ?? null).includes(GUARD_MARKER);
}

/** A missing file is empty settings. Anything unreadable is refused rather than overwritten. */
async function readSettings(cwd: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFile(path.join(cwd, GUARD_SETTINGS_PATH), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return {};
    throw new Error(`${GUARD_SETTINGS_PATH} exists but could not be read, so wep will not touch it.`);
  }
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${GUARD_SETTINGS_PATH} is not a JSON object, so wep will not touch it.`);
  }
  return parsed as Record<string, unknown>;
}

async function writeSettings(
  cwd: string,
  settings: Record<string, unknown>,
  options: { dryRun?: boolean },
  reason: string,
): Promise<string> {
  await writePlannedFile(cwd, GUARD_SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`, {
    dryRun: options.dryRun,
    force: true,
    reason,
  });
  return GUARD_SETTINGS_PATH;
}
