import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** Rejected Doctor merge blocks, keyed by protected file and block id, with the content hash that was declined. */
export const MERGE_DECISIONS_PATH = ".wep/doctor/merge-decisions.json";

export interface MergeDecisions {
  version: 1;
  files: Record<string, { rejected: Record<string, string> }>;
}

export async function readMergeDecisions(cwd: string): Promise<MergeDecisions> {
  try {
    const parsed = JSON.parse(await readFile(path.join(cwd, MERGE_DECISIONS_PATH), "utf8"));
    if (parsed?.version === 1 && parsed.files && typeof parsed.files === "object") return parsed as MergeDecisions;
  } catch {
    // Missing or unreadable: no decisions recorded yet.
  }
  return { version: 1, files: {} };
}

export function rejectedFor(decisions: MergeDecisions, file: string): Record<string, string> {
  return decisions.files[file]?.rejected ?? {};
}

export async function writeMergeDecisions(cwd: string, decisions: MergeDecisions): Promise<void> {
  const target = path.join(cwd, MERGE_DECISIONS_PATH);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(decisions, null, 2)}\n`, "utf8");
}
