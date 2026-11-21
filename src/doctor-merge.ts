import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathExists, suggestedPathFor } from "./fs-utils.js";
import { protectedFiles } from "./harness-files.js";
import { type PendingBlock, applyBlock, lineDiff, pendingBlocks } from "./merge-blocks.js";
import { readMergeDecisions, rejectedFor, writeMergeDecisions } from "./merge-decisions.js";

export { MERGE_DECISIONS_PATH, type MergeDecisions, readMergeDecisions } from "./merge-decisions.js";

/**
 * Doctor suggested merges, one block at a time.
 *
 * The human approves each block in the conversation; this command then applies exactly that block
 * (`accept`) or remembers that it was declined (`reject`). Rejections are keyed by the block's
 * content hash, so a block is proposed again only when a newer template changes it.
 */

export interface DoctorMergeOptions {
  cwd?: string;
  /** Protected file to act on, e.g. AGENTS.md. Required with accept/reject when several suggestions exist. */
  file?: string;
  accept?: string[];
  reject?: string[];
  dryRun?: boolean;
}

export interface DoctorMergeBlock {
  id: string;
  title: string;
  status: "new" | "changed";
  diff: string[];
}

export interface DoctorMergeFile {
  file: string;
  suggestion: string;
  accepted: string[];
  rejected: string[];
  /** Blocks still pending after this run. */
  pending: DoctorMergeBlock[];
  removedSuggestion: boolean;
}

export interface DoctorMergeResult {
  dryRun: boolean;
  files: DoctorMergeFile[];
}

/** A refused request. Nothing was written. */
export class DoctorMergeError extends Error {}

async function filesWithSuggestions(cwd: string): Promise<string[]> {
  const found: string[] = [];
  for (const file of protectedFiles) {
    if ((await pathExists(path.join(cwd, file))) && (await pathExists(path.join(cwd, suggestedPathFor(file))))) {
      found.push(file);
    }
  }
  return found;
}

function describe(pending: ReturnType<typeof pendingBlocks>): DoctorMergeBlock[] {
  return pending.map((block) => ({
    id: block.id,
    title: block.title,
    status: block.status,
    diff: lineDiff(block.currentSection ?? "", block.block.content),
  }));
}

export async function runDoctorMerge(options: DoctorMergeOptions = {}): Promise<DoctorMergeResult> {
  const cwd = options.cwd ?? process.cwd();
  const accept = options.accept ?? [];
  const reject = options.reject ?? [];
  const acting = accept.length > 0 || reject.length > 0;
  const dryRun = Boolean(options.dryRun);

  let targets: string[];
  if (options.file) {
    const file = path.posix.normalize(options.file.split(path.sep).join("/"));
    if (!(await pathExists(path.join(cwd, file))) || !(await pathExists(path.join(cwd, suggestedPathFor(file))))) {
      throw new DoctorMergeError(`${file} has no suggested merge (${suggestedPathFor(file)} not found).`);
    }
    targets = [file];
  } else {
    targets = await filesWithSuggestions(cwd);
    if (acting && targets.length > 1) {
      throw new DoctorMergeError(
        `Name the file to merge: several suggestions are pending (${targets.join(", ")}). Example: wep doctor merge ${targets[0]} --accept <block>.`,
      );
    }
    if (acting && targets.length === 0) throw new DoctorMergeError("No suggested merge is pending.");
  }

  const twice = accept.filter((id) => reject.includes(id));
  if (twice.length > 0)
    throw new DoctorMergeError(`A block cannot be both accepted and rejected: ${twice.join(", ")}.`);

  const decisions = await readMergeDecisions(cwd);
  const files: DoctorMergeFile[] = [];
  for (const file of targets) {
    const suggestionPath = suggestedPathFor(file);
    const original = await readFile(path.join(cwd, file), "utf8");
    const suggestion = await readFile(path.join(cwd, suggestionPath), "utf8");
    const rejected = { ...rejectedFor(decisions, file) };
    const before = pendingBlocks(original, suggestion, rejected);
    const byId = new Map(before.map((block) => [block.id, block]));

    // Validate everything before writing anything.
    const unknown = [...accept, ...reject].filter((id) => !byId.has(id));
    if (unknown.length > 0) {
      const ids = before.map((block) => block.id).join(", ") || "none";
      throw new DoctorMergeError(`Block not pending in ${file}: ${unknown.join(", ")}. Pending blocks: ${ids}.`);
    }

    // Every id was checked against byId above.
    const blockFor = (id: string) => (byId.get(id) as PendingBlock).block;
    let next = original;
    for (const id of accept) next = applyBlock(next, blockFor(id));
    for (const id of reject) rejected[id] = blockFor(id).hash;

    const after = pendingBlocks(next, suggestion, rejected);
    const removeSuggestion = after.length === 0;
    if (!dryRun) {
      if (next !== original) await writeFile(path.join(cwd, file), next, "utf8");
      if (reject.length > 0) {
        decisions.files[file] = { rejected };
        await writeMergeDecisions(cwd, decisions);
      }
      if (removeSuggestion) await rm(path.join(cwd, suggestionPath), { force: true });
    }
    files.push({
      file,
      suggestion: suggestionPath,
      accepted: [...accept],
      rejected: [...reject],
      pending: describe(after),
      removedSuggestion: removeSuggestion,
    });
  }
  return { dryRun, files };
}

/** Number of pending blocks for an existing suggestion, for `wep doctor`. */
export async function pendingBlockCount(cwd: string, file: string): Promise<number> {
  const current = await readFile(path.join(cwd, file), "utf8");
  const suggestion = await readFile(path.join(cwd, suggestedPathFor(file)), "utf8");
  return pendingBlocks(current, suggestion, rejectedFor(await readMergeDecisions(cwd), file)).length;
}
