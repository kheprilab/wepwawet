import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach } from "vitest";

export const execFileAsync = promisify(execFile);

/**
 * The current test's temporary directory. An exported `let` is a live binding, so test files and
 * shared fixtures that import it always see the directory of the test that is running.
 */
export let tmp: string;

/** Give each test in the calling file a fresh temporary directory, and remove it afterwards. */
export function useTempDir(): void {
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "wep-test-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });
}
