import path from "node:path";
import { pathExists } from "../fs-utils.js";

/** Walk up from `start` to the nearest directory containing `.wep/config.json`, or `undefined`. */
async function findNearestProjectRoot(start: string): Promise<string | undefined> {
  let directory = path.resolve(start);
  for (;;) {
    if (await pathExists(path.join(directory, ".wep/config.json"))) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/**
 * Resolve the nearest project root containing `.wep/config.json` by checking
 * `payloadCwd` (when provided) and then falling back to `processCwd`.
 * Returns `undefined` when neither candidate has a wep installation in its ancestry.
 */
export async function resolveProjectRoot(
  payloadCwd: string | undefined,
  processCwd: string,
): Promise<string | undefined> {
  const candidates: string[] = [];
  if (typeof payloadCwd === "string" && payloadCwd.trim().length > 0) {
    candidates.push(path.isAbsolute(payloadCwd) ? payloadCwd : path.resolve(processCwd, payloadCwd));
  }
  candidates.push(path.resolve(processCwd));

  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    const found = await findNearestProjectRoot(candidate);
    if (found) return found;
  }
  return undefined;
}
