import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const RUN_LOCK_PATH = ".wep/local/judge/run.lock";

/** Who holds the validation run lock. Ignored output is outside every digest, so two runs must not overlap. */
export interface RunLock {
  pid: number;
  host: string;
  startedAt: string;
  taskId: string;
  snapshotId: string;
}

/** Process and host identity, injectable so tests need no foreign machines or dead processes. */
export interface RunLockEnv {
  pid?: number;
  host?: string;
  isAlive?: (pid: number) => boolean;
}

export class RunLockBusy extends Error {}

/**
 * Whether a process exists. EPERM means it exists under another user, so it counts as alive;
 * only ESRCH proves it is gone.
 */
export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function readRunLock(cwd: string): Promise<RunLock | null | "corrupt"> {
  let raw: string;
  try {
    raw = await readFile(path.join(cwd, RUN_LOCK_PATH), "utf8");
  } catch {
    return null;
  }
  try {
    const lock = JSON.parse(raw) as Partial<RunLock>;
    if (
      typeof lock.pid !== "number" ||
      typeof lock.host !== "string" ||
      typeof lock.startedAt !== "string" ||
      typeof lock.taskId !== "string" ||
      typeof lock.snapshotId !== "string"
    ) {
      return "corrupt";
    }
    return lock as RunLock;
  } catch {
    return "corrupt";
  }
}

/** The lock of a run that is still in progress, or null. A dead same-host holder is not active. */
export async function readActiveRun(cwd: string, env: RunLockEnv = {}): Promise<RunLock | null> {
  const lock = await readRunLock(cwd);
  if (!lock || lock === "corrupt") return null;
  const host = env.host ?? os.hostname();
  const isAlive = env.isAlive ?? processIsAlive;
  if (lock.host === host && !isAlive(lock.pid)) return null;
  return lock;
}

/**
 * Take the lock, or explain who holds it.
 *
 * Creation is exclusive (`wx`), so two runs that start at the same moment cannot both win. A
 * same-host holder whose process is gone, or a lock file that cannot be read, is reclaimed with
 * a notice. A holder on another host cannot be checked from here, so only `breakLock` removes it.
 */
export async function acquireRunLock(
  cwd: string,
  owner: { taskId: string; snapshotId: string },
  options: { breakLock?: boolean; env?: RunLockEnv } = {},
): Promise<{ release: () => Promise<void>; notices: string[] }> {
  const env = options.env ?? {};
  const file = path.join(cwd, RUN_LOCK_PATH);
  const lock: RunLock = {
    pid: env.pid ?? process.pid,
    host: env.host ?? os.hostname(),
    startedAt: new Date().toISOString(),
    taskId: owner.taskId,
    snapshotId: owner.snapshotId,
  };
  const notices: string[] = [];
  await mkdir(path.dirname(file), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(file, `${JSON.stringify(lock, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      return { release: () => releaseRunLock(cwd, lock), notices };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const held = await readRunLock(cwd);
    if (held === "corrupt") {
      notices.push(`Reclaimed an unreadable run lock at ${RUN_LOCK_PATH}.`);
    } else if (held && held.host === lock.host && !(env.isAlive ?? processIsAlive)(held.pid)) {
      notices.push(
        `Reclaimed a stale run lock: ${held.taskId} started at ${held.startedAt} by PID ${held.pid}, which no longer exists.`,
      );
    } else if (held && held.host !== lock.host && options.breakLock) {
      notices.push(`Broke the run lock held by host ${held.host} (PID ${held.pid}, started ${held.startedAt}).`);
    } else if (held) {
      const hint =
        held.host === lock.host
          ? "Wait for it to finish, then retry."
          : "It belongs to another host, so wep cannot check whether it is still running. If it is not, retry with --break-lock.";
      throw new RunLockBusy(
        `Another validation run holds the lock: ${held.taskId} (snapshot ${held.snapshotId}), PID ${held.pid} on ${held.host}, started ${held.startedAt}. ${hint}`,
      );
    }
    await rm(file, { force: true });
  }
  throw new RunLockBusy(`Could not take the run lock at ${RUN_LOCK_PATH}; another run took it first. Retry.`);
}

/** Remove the lock only while it is still ours, so a release never deletes another run's lock. */
async function releaseRunLock(cwd: string, lock: RunLock): Promise<void> {
  const held = await readRunLock(cwd);
  if (held && held !== "corrupt" && held.pid === lock.pid && held.startedAt === lock.startedAt) {
    await rm(path.join(cwd, RUN_LOCK_PATH), { force: true });
  }
}
