import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { readTaskContinuation } from "./continuation.js";
import type { JudgeScope } from "./judge-enforcement.js";
import { measureJudgePhase } from "./judge-timings.js";
import { captureValidationError } from "./validation-evidence.js";

const execFileAsync = promisify(execFile);
const SNAPSHOT_ROOT = path.join(".wep", "local", "judge", "snapshots");
const SNAPSHOT_PREFIX = "SNAPSHOT:";
const SNAPSHOT_VERSION = 7;
const MAX_CAPTURE_ATTEMPTS = 3;

export interface JudgeSnapshotParent {
  snapshotId: string;
  scopeDigest: string;
  recordPath: string;
  recordDigest: string;
}

export interface JudgeSnapshotMetadata {
  version: typeof SNAPSHOT_VERSION;
  id: string;
  taskId: string;
  contentDigest: string;
  workspaceDigest: string;
  reviewContentDigest: string;
  reviewWorkspaceDigest: string;
  sourceScope: JudgeScope;
  scope: JudgeScope;
  emptyBoundaryAuthorized: boolean;
  parent?: JudgeSnapshotParent;
}

export interface JudgeSnapshot {
  id: string;
  candidate: string;
  scope: JudgeScope;
  metadataPath: string;
  worktreePath: string;
  parent?: JudgeSnapshotParent;
  emptyBoundaryAuthorized: boolean;
}

/**
 * A path's fingerprint in two parts: `content` (bytes/target) and `stat` (ctime only — see
 * `statOf` for why the inode number is excluded).
 *
 * `content` is what the snapshot is logically about; `stat` carries modification evidence so a
 * write-then-restore (same bytes, new ctime) or a create-then-delete (parent dir ctime moved) is
 * detectable at the next load even though the content manifest matches again. Splitting the two
 * lets a load tell "this no longer matches" (content differs) from "this was modified after
 * capture" (content matches, stat differs) — the distinction the integrity messages report.
 */
export interface PathFingerprint {
  content: string;
  stat: string | null;
}

export interface LoadedJudgeSnapshot extends JudgeSnapshot {
  metadata: JudgeSnapshotMetadata;
  manifest: Map<string, PathFingerprint>;
}

export interface JudgeSnapshotCurrentState {
  snapshotId: string;
  status: "CURRENT" | "NEWER_CHANGES" | "DIVERGED";
  changedFiles: string[];
  /** Same computation as `status`, but ignoring a valid continuation sidecar on both sides. */
  reviewBoundary: "CURRENT" | "NEWER_CHANGES" | "DIVERGED";
  executionMetadata: "ABSENT" | "UNCHANGED" | "CREATED" | "REMOVED" | "ADVANCED";
}

export interface JudgeSnapshotPruneResult {
  dryRun: boolean;
  keep: number;
  kept: string[];
  removed: string[];
}

export interface JudgeSnapshotValidationWorkspace {
  worktreePath: string;
  cleanup: () => Promise<void>;
}

interface CaptureParent extends JudgeSnapshotParent {
  worktreePath: string;
  manifest: Map<string, PathFingerprint>;
}

export function isSnapshotCandidate(candidate: string): boolean {
  return /^SNAPSHOT:[0-9a-f]{20}$/.test(candidate);
}

export async function captureJudgeSnapshot(
  cwd: string,
  taskId: string,
  base: string,
  includedTaskIds: string[] = [],
  allowEmpty = false,
): Promise<JudgeSnapshot> {
  return capture(cwd, taskId, base, undefined, includedTaskIds, allowEmpty);
}

export async function captureJudgeCatchUpSnapshot(
  cwd: string,
  taskId: string,
  parentRecordPath: string,
  approve?: (commands: string[]) => Promise<boolean>,
  allowEmpty = false,
  options: { receiptDigest?: string } = {},
): Promise<JudgeSnapshot> {
  const absoluteRecord = path.resolve(cwd, parentRecordPath);
  const relativeRecord = path.relative(cwd, absoluteRecord).split(path.sep).join("/");
  if (!relativeRecord || relativeRecord.startsWith("../") || path.isAbsolute(relativeRecord)) {
    throw new Error("The parent review record must be inside the project.");
  }
  const recordBytes = await readFile(absoluteRecord);
  const record = JSON.parse(recordBytes.toString("utf8")) as {
    taskId?: string;
    verdict?: string;
    scope?: JudgeScope;
  };
  if (record.taskId !== taskId || record.verdict !== "APPROVED" || !record.scope) {
    throw new Error("Catch-up requires an APPROVED review record for the same task.");
  }
  if (!isSnapshotCandidate(record.scope.candidate)) {
    throw new Error("Catch-up requires a review whose candidate is an immutable snapshot.");
  }
  const { verifyJudgeRecord } = await import("./judge-enforcement.js");
  const verified = await measureJudgePhase(
    "verification",
    () =>
      verifyJudgeRecord(
        cwd,
        relativeRecord,
        options.receiptDigest ? { receiptDigest: options.receiptDigest } : { runTests: true, approve },
      ),
    undefined,
    (result) => result.approved,
  );
  if (!verified.approved) {
    throw new Error(`Catch-up requires a verified current snapshot approval: ${verified.reasons.join(" ")}`);
  }
  const loaded = await loadJudgeSnapshot(cwd, record.scope.candidate);
  const parent: CaptureParent = {
    snapshotId: loaded.id,
    scopeDigest: record.scope.scopeDigest,
    recordPath: relativeRecord,
    recordDigest: hash([recordBytes]),
    worktreePath: loaded.worktreePath,
    manifest: loaded.manifest,
  };
  return capture(
    cwd,
    taskId,
    loaded.metadata.sourceScope.baseCommit,
    parent,
    loaded.metadata.sourceScope.includedTaskIds,
    allowEmpty,
  );
}

export async function loadJudgeSnapshot(cwd: string, candidate: string): Promise<LoadedJudgeSnapshot> {
  return loadJudgeSnapshotInternal(cwd, candidate, new Set());
}

async function loadJudgeSnapshotInternal(
  cwd: string,
  candidate: string,
  ancestors: Set<string>,
): Promise<LoadedJudgeSnapshot> {
  if (!isSnapshotCandidate(candidate)) throw new Error(`Invalid snapshot candidate: ${candidate}`);
  const id = candidate.slice(SNAPSHOT_PREFIX.length);
  if (ancestors.has(id)) throw new Error(`Snapshot integrity check failed: parent snapshot cycle at ${id}.`);
  const nextAncestors = new Set(ancestors).add(id);
  const root = path.join(cwd, SNAPSHOT_ROOT, id);
  const metadataPath = path.join(root, "snapshot.json");
  const worktreePath = path.join(root, "worktree");
  let metadata: JudgeSnapshotMetadata;
  try {
    metadata = JSON.parse(await readFile(metadataPath, "utf8")) as JudgeSnapshotMetadata;
  } catch (error) {
    throw new Error(`Snapshot integrity check failed: ${messageOf(error)}`);
  }
  if (metadata.version !== SNAPSHOT_VERSION) {
    if (metadata.version === 6) {
      throw new Error(
        "Snapshot integrity check failed: this snapshot predates the review content identity contract (v6); capture a new snapshot with the current CLI.",
      );
    }
    if (metadata.version === 5) {
      throw new Error(
        "Snapshot integrity check failed: this snapshot predates the empty-boundary authorization contract (v5); capture a new snapshot with the current CLI.",
      );
    }
    throw new Error(
      "Snapshot integrity check failed: this snapshot predates write detection and canonical Git base refs (legacy format); capture a new snapshot.",
    );
  }
  const legacyArtifacts = metadata as { artifactContentDigest?: unknown; artifactIntegrityDigest?: unknown };
  if (legacyArtifacts.artifactContentDigest !== undefined || legacyArtifacts.artifactIntegrityDigest !== undefined) {
    throw new Error(
      "Snapshot integrity check failed: this snapshot uses a previous format with generated build artifacts, which capture no longer produces; capture a new snapshot with the current CLI.",
    );
  }
  if (
    metadata.id !== id ||
    metadata.scope.candidate !== candidate ||
    metadata.taskId !== metadata.scope.taskId ||
    metadata.emptyBoundaryAuthorized !== metadata.scope.emptyBoundaryAuthorized ||
    metadata.emptyBoundaryAuthorized !== (metadata.scope.changedFiles.length === 0)
  ) {
    throw new Error("Snapshot integrity check failed: metadata shape or identity is invalid.");
  }
  let workspace: Map<string, PathFingerprint>;
  try {
    const dependencyInfo = await lstat(path.join(worktreePath, "node_modules")).catch(() => undefined);
    if (dependencyInfo?.isSymbolicLink()) {
      throw new Error("snapshot dependency directory is a symlink; capture a new isolated snapshot");
    }
    const currentBlockedPatterns = normalizePatterns(await readBlockedPatterns(cwd));
    const snapshotBlockedPatterns = normalizePatterns(await readBlockedPatterns(worktreePath));
    if (JSON.stringify(currentBlockedPatterns) !== JSON.stringify(snapshotBlockedPatterns)) {
      throw new Error("blocked-read policy changed after capture; capture a new snapshot");
    }
    workspace = await workspaceManifest(worktreePath, snapshotBlockedPatterns);
  } catch (error) {
    throw new Error(`Snapshot integrity check failed: ${messageOf(error)}`);
  }
  const currentContentDigest = contentDigest(workspace);
  if (currentContentDigest !== metadata.contentDigest) {
    throw new Error("Snapshot integrity check failed: workspace content no longer matches its capture.");
  }
  const currentWorkspaceDigest = workspaceDigest(workspace);
  if (currentWorkspaceDigest !== metadata.workspaceDigest) {
    throw new Error(
      "Snapshot integrity check failed: workspace was modified after capture (a file was changed and restored, or a file was created and deleted). Capture a new snapshot.",
    );
  }
  const currentReviewDigests = await reviewDigests(worktreePath, metadata.taskId, workspace);
  if (currentReviewDigests.reviewContentDigest !== metadata.reviewContentDigest) {
    throw new Error("Snapshot integrity check failed: reviewable content no longer matches its capture.");
  }
  if (currentReviewDigests.reviewWorkspaceDigest !== metadata.reviewWorkspaceDigest) {
    throw new Error(
      "Snapshot integrity check failed: reviewable workspace was modified after capture. Capture a new snapshot.",
    );
  }
  if (metadata.parent) {
    const currentParentRecord = await readFile(path.join(cwd, metadata.parent.recordPath)).catch(() => undefined);
    if (!currentParentRecord || hash([currentParentRecord]) !== metadata.parent.recordDigest) {
      throw new Error("Snapshot integrity check failed: parent review record no longer matches the catch-up chain.");
    }
    try {
      const parent = await loadJudgeSnapshotInternal(
        cwd,
        `${SNAPSHOT_PREFIX}${metadata.parent.snapshotId}`,
        nextAncestors,
      );
      if (parent.scope.scopeDigest !== metadata.parent.scopeDigest) {
        throw new Error("parent scope digest no longer matches");
      }
    } catch (error) {
      throw new Error(`Snapshot integrity check failed: parent snapshot is invalid (${messageOf(error)}).`);
    }
  }
  const expectedId = snapshotId(metadata.taskId, metadata.sourceScope, currentContentDigest, metadata.parent);
  if (expectedId !== id || scopeDigest(metadata.scope) !== metadata.scope.scopeDigest) {
    throw new Error("Snapshot integrity check failed: metadata digest no longer matches its capture.");
  }
  return {
    id,
    candidate,
    scope: metadata.scope,
    metadataPath,
    worktreePath,
    parent: metadata.parent,
    emptyBoundaryAuthorized: metadata.emptyBoundaryAuthorized,
    metadata,
    manifest: workspace,
  };
}

export async function checkJudgeSnapshotCurrentState(
  cwd: string,
  candidate: string,
): Promise<JudgeSnapshotCurrentState> {
  const snapshot = await loadJudgeSnapshot(cwd, candidate);
  const { createJudgeScope } = await import("./judge-enforcement.js");
  try {
    const current = await createJudgeScope(
      cwd,
      snapshot.metadata.taskId,
      snapshot.metadata.sourceScope.baseCommit,
      "WORKTREE",
      snapshot.metadata.sourceScope.includedTaskIds,
    );
    const blockedPatterns = await readBlockedPatterns(snapshot.worktreePath);
    const liveManifest = await workspaceManifest(cwd, blockedPatterns);
    const changedFiles = changedManifestPaths(snapshot.manifest, liveManifest);
    const isCurrent = sameLiveBoundary(current, snapshot.metadata.sourceScope) && changedFiles.length === 0;

    const capturedSidecar = await reviewSidecarExclusion(snapshot.worktreePath, snapshot.metadata.taskId);
    const liveSidecar = await reviewSidecarExclusion(cwd, snapshot.metadata.taskId);
    const reviewChangedFiles = changedManifestPaths(
      excludeSidecar(snapshot.manifest, capturedSidecar),
      excludeSidecar(liveManifest, liveSidecar),
    );
    const reviewBoundaryMatches =
      current.candidateCommit === snapshot.metadata.sourceScope.candidateCommit &&
      current.taskDigest === snapshot.metadata.sourceScope.taskDigest &&
      JSON.stringify(current.excludedPaths) === JSON.stringify(snapshot.metadata.sourceScope.excludedPaths) &&
      reviewChangedFiles.length === 0;
    const executionMetadata = sidecarExecutionMetadata(snapshot.manifest, liveManifest, capturedSidecar, liveSidecar);

    if (isCurrent) {
      return {
        snapshotId: snapshot.id,
        status: "CURRENT",
        changedFiles: [],
        reviewBoundary: "CURRENT",
        executionMetadata,
      };
    }
    const ancestor = await gitExitZero(cwd, [
      "merge-base",
      "--is-ancestor",
      snapshot.metadata.sourceScope.candidateCommit,
      "HEAD",
    ]);
    const label: "NEWER_CHANGES" | "DIVERGED" = ancestor ? "NEWER_CHANGES" : "DIVERGED";
    return {
      snapshotId: snapshot.id,
      status: label,
      changedFiles,
      reviewBoundary: reviewBoundaryMatches ? "CURRENT" : label,
      executionMetadata,
    };
  } catch {
    return {
      snapshotId: snapshot.id,
      status: "DIVERGED",
      changedFiles: [],
      reviewBoundary: "DIVERGED",
      executionMetadata: "ABSENT",
    };
  }
}

function excludeSidecar(
  manifest: Map<string, PathFingerprint>,
  sidecarPath: string | null,
): Map<string, PathFingerprint> {
  if (sidecarPath === null || !manifest.has(sidecarPath)) return manifest;
  const filtered = new Map(manifest);
  filtered.delete(sidecarPath);
  return filtered;
}

function sidecarExecutionMetadata(
  capturedManifest: Map<string, PathFingerprint>,
  liveManifest: Map<string, PathFingerprint>,
  capturedSidecar: string | null,
  liveSidecar: string | null,
): JudgeSnapshotCurrentState["executionMetadata"] {
  if (capturedSidecar === null && liveSidecar === null) return "ABSENT";
  if (capturedSidecar === null) return "CREATED";
  if (liveSidecar === null) return "REMOVED";
  const capturedFingerprint = capturedManifest.get(capturedSidecar)?.content;
  const liveFingerprint = liveManifest.get(liveSidecar)?.content;
  return capturedFingerprint === liveFingerprint ? "UNCHANGED" : "ADVANCED";
}

export async function checkJudgeReviewCurrentState(
  cwd: string,
  recordPath: string,
): Promise<JudgeSnapshotCurrentState> {
  const { verifyJudgeRecord } = await import("./judge-enforcement.js");
  const verified = await verifyJudgeRecord(cwd, recordPath);
  if (!verified.approved) {
    throw new Error(`Current-state checks require a valid APPROVED snapshot review: ${verified.reasons.join(" ")}`);
  }
  const record = JSON.parse(await readFile(path.resolve(cwd, recordPath), "utf8")) as {
    scope?: { candidate?: string };
  };
  const candidate = record.scope?.candidate;
  if (!candidate || !isSnapshotCandidate(candidate)) {
    throw new Error("Current-state checks require a review record for an immutable snapshot.");
  }
  return checkJudgeSnapshotCurrentState(cwd, candidate);
}

export async function createJudgeSnapshotValidationWorkspace(
  cwd: string,
  candidate: string,
): Promise<JudgeSnapshotValidationWorkspace> {
  const snapshot = await loadJudgeSnapshot(cwd, candidate);
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "wep-judge-validation-"));
  const worktreePath = path.join(temporaryRoot, "worktree");
  try {
    await measureJudgePhase("workspace-copy", () =>
      cp(snapshot.worktreePath, worktreePath, {
        recursive: true,
        preserveTimestamps: true,
        mode: constants.COPYFILE_FICLONE,
        filter: (source) => path.basename(source) !== "node_modules",
      }),
    );
    await measureJudgePhase("dependency-preparation", () => materialiseDependencies(worktreePath));
    return {
      worktreePath,
      cleanup: () => measureJudgePhase("cleanup", () => rm(temporaryRoot, { recursive: true, force: true })),
    };
  } catch (error) {
    await measureJudgePhase("cleanup", () => rm(temporaryRoot, { recursive: true, force: true }));
    throw error;
  }
}

/**
 * Install dependencies into the disposable validation workspace from its lockfile, deterministically.
 *
 * No `package.json` means the reviewed boundary is not a Node project and there is nothing to
 * materialise. A `package.json` with no dependency fields likewise has nothing to install, so a
 * lockfile is not required. A `package.json` that declares dependencies but has no lockfile cannot
 * be materialised deterministically — re-execution would resolve whatever the registry happens
 * to serve on the day — so it fails with a named reason rather than silently falling back to the
 * snapshot's `node_modules`. The install is frozen/locked so it never resolves a newer version.
 */
async function materialiseDependencies(worktreePath: string): Promise<void> {
  const packageJsonPath = path.join(worktreePath, "package.json");
  if (!(await lstat(packageJsonPath).catch(() => undefined))) return;
  let packageJson: Record<string, unknown> = {};
  try {
    packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  } catch {
    return;
  }
  const dependencyFields = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
  const hasDependencies = dependencyFields.some(
    (field) =>
      packageJson[field] &&
      typeof packageJson[field] === "object" &&
      Object.keys(packageJson[field] as Record<string, unknown>).length > 0,
  );
  if (!hasDependencies) return;
  const command = await frozenInstallCommand(worktreePath);
  if (!command) {
    throw new Error(
      "Cannot materialise dependencies for independent re-execution: the boundary has a package.json that declares dependencies but no lockfile (pnpm-lock.yaml, package-lock.json, or yarn.lock). Commit a lockfile so re-execution is deterministic.",
    );
  }
  try {
    await execFileAsync(command[0], command.slice(1), {
      cwd: worktreePath,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 15 * 60_000,
    });
  } catch (error) {
    const evidence = captureValidationError(command.join(" "), error);
    throw new Error(
      `Cannot materialise dependencies for independent re-execution (${evidence.command} failed): exit code ${evidence.exitCode ?? "unknown"}${evidence.signal ? `, signal ${evidence.signal}` : ""}\n${evidence.output}`,
    );
  }
}

export async function frozenInstallCommand(worktreePath: string): Promise<string[] | undefined> {
  const present = async (file: string) => !!(await lstat(path.join(worktreePath, file)).catch(() => undefined));
  if (await present("pnpm-lock.yaml")) return ["pnpm", "install", "--frozen-lockfile"];
  if (await present("package-lock.json")) return ["npm", "ci"];
  if (await present("yarn.lock")) return ["yarn", "install", "--frozen-lockfile"];
  return undefined;
}

export async function pruneJudgeSnapshots(
  cwd: string,
  options: { keep: number; dryRun?: boolean },
): Promise<JudgeSnapshotPruneResult> {
  if (!Number.isInteger(options.keep) || options.keep < 0) {
    throw new Error("Snapshot retention --keep must be a non-negative integer.");
  }
  const dryRun = options.dryRun ?? true;
  const snapshotsRoot = path.join(cwd, SNAPSHOT_ROOT);
  const entries = (await readdir(snapshotsRoot, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory() && /^[0-9a-f]{20}$/.test(entry.name))
    .map((entry) => entry.name);
  const snapshots = await Promise.all(
    entries.map(async (id) => {
      const root = path.join(snapshotsRoot, id);
      const info = await stat(root);
      const metadata = JSON.parse(await readFile(path.join(root, "snapshot.json"), "utf8")) as {
        parent?: { snapshotId?: string };
      };
      return { id, mtimeMs: info.mtimeMs, parentId: metadata.parent?.snapshotId };
    }),
  );
  snapshots.sort((left, right) => right.mtimeMs - left.mtimeMs || left.id.localeCompare(right.id));
  const byId = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
  const retained = new Set(snapshots.slice(0, options.keep).map((snapshot) => snapshot.id));
  for (const id of [...retained]) {
    let parentId = byId.get(id)?.parentId;
    while (parentId && byId.has(parentId) && !retained.has(parentId)) {
      retained.add(parentId);
      parentId = byId.get(parentId)?.parentId;
    }
  }
  const kept = snapshots.filter((snapshot) => retained.has(snapshot.id)).map((snapshot) => snapshot.id);
  const removed = snapshots.filter((snapshot) => !retained.has(snapshot.id)).map((snapshot) => snapshot.id);
  if (!dryRun) {
    for (const id of removed) await rm(path.join(snapshotsRoot, id), { recursive: true, force: true });
  }
  return { dryRun, keep: options.keep, kept, removed };
}

async function capture(
  cwd: string,
  taskId: string,
  base: string,
  parent?: CaptureParent,
  includedTaskIds: string[] = [],
  allowEmpty = false,
): Promise<JudgeSnapshot> {
  const snapshotsRoot = path.join(cwd, SNAPSHOT_ROOT);
  await mkdir(snapshotsRoot, { recursive: true });
  const { createJudgeScope } = await import("./judge-enforcement.js");

  for (let attempt = 1; attempt <= MAX_CAPTURE_ATTEMPTS; attempt += 1) {
    const sourceScope = await createJudgeScope(cwd, taskId, base, "WORKTREE", includedTaskIds);
    if (!parent && sourceScope.changedFiles.length === 0 && !allowEmpty) {
      throw new Error(
        `Cannot capture an empty judge boundary for ${taskId}: changedFiles is empty. HEAD as the base does not include commits already made on this branch. Select a base that contains the delta, for example: wep judge snapshot ${taskId} --base origin/main. Use --allow-empty only for an intentional empty capture.`,
      );
    }
    const temporaryRoot = await mkdtemp(path.join(snapshotsRoot, ".capture-"));
    const worktreePath = path.join(temporaryRoot, "worktree");
    let finalRoot = "";
    let renamed = false;
    try {
      await measureJudgePhase("workspace-copy", () =>
        createPrivateGitWorkspace(cwd, worktreePath, sourceScope.baseCommit, sourceScope.candidateCommit),
      );
      const blockedPatterns = await readBlockedPatterns(cwd);
      await removeBlockedPaths(worktreePath, blockedPatterns);
      await overlayChangedFiles(cwd, worktreePath, sourceScope.changedFiles);
      await restorePackageManagerState(cwd, worktreePath);

      const after = await createJudgeScope(cwd, taskId, sourceScope.baseCommit, "WORKTREE", includedTaskIds);
      if (!sameLiveBoundary(after, sourceScope)) {
        await measureJudgePhase("cleanup", () => rm(temporaryRoot, { recursive: true, force: true }));
        continue;
      }

      const snapshotBlockedPatterns = await readBlockedPatterns(worktreePath);
      const manifest = await workspaceManifest(worktreePath, snapshotBlockedPatterns);
      const liveManifest = await workspaceManifest(cwd, snapshotBlockedPatterns);
      const finalSourceScope = await createJudgeScope(cwd, taskId, sourceScope.baseCommit, "WORKTREE", includedTaskIds);
      if (!sameLiveBoundary(finalSourceScope, sourceScope)) {
        await measureJudgePhase("cleanup", () => rm(temporaryRoot, { recursive: true, force: true }));
        continue;
      }
      if (contentDigest(liveManifest) !== contentDigest(manifest)) {
        throw new Error(
          `Snapshot does not match the live workspace (deterministic mismatch, not a transient race; recapture after resolving the differing paths): ${changedManifestPaths(liveManifest, manifest).slice(0, 8).join(", ")}.`,
        );
      }
      const snapshotContentDigest = contentDigest(manifest);
      const snapshotWorkspaceDigest = workspaceDigest(manifest);
      const { reviewContentDigest: snapshotReviewContentDigest, reviewWorkspaceDigest: snapshotReviewWorkspaceDigest } =
        await reviewDigests(worktreePath, taskId, manifest);
      const parentRecord = parent
        ? {
            snapshotId: parent.snapshotId,
            scopeDigest: parent.scopeDigest,
            recordPath: parent.recordPath,
            recordDigest: parent.recordDigest,
          }
        : undefined;
      // Equivalent refs may reuse one immutable snapshot. Do not persist the spelling from one
      // invocation as metadata that could falsely describe a later invocation.
      const changedFiles = parent ? changedManifestPaths(parent.manifest, manifest) : sourceScope.changedFiles;
      if (changedFiles.length === 0 && !allowEmpty) {
        throw new Error(
          `Cannot capture an empty judge boundary for ${taskId}: changedFiles is empty. HEAD as the base does not include commits already made on this branch. Select a base that contains the delta, for example: wep judge snapshot ${taskId} --base origin/main. Use --allow-empty only for an intentional empty capture.`,
        );
      }
      const { baseRef: _requestedBaseRef, ...persistedSourceScope } = {
        ...sourceScope,
        emptyBoundaryAuthorized: allowEmpty && changedFiles.length === 0,
      };
      const id = snapshotId(taskId, persistedSourceScope, snapshotContentDigest, parentRecord);
      const candidate = `${SNAPSHOT_PREFIX}${id}`;
      const changeDigest = parent ? deltaDigest(parent.manifest, manifest) : sourceScope.changeDigest;
      const core = {
        ...persistedSourceScope,
        base: sourceScope.baseCommit,
        candidate,
        changedFiles,
        changeDigest,
      };
      const scope: JudgeScope = { ...core, scopeDigest: scopeDigest(core) };
      const metadata: JudgeSnapshotMetadata = {
        version: SNAPSHOT_VERSION,
        id,
        taskId,
        contentDigest: snapshotContentDigest,
        workspaceDigest: snapshotWorkspaceDigest,
        reviewContentDigest: snapshotReviewContentDigest,
        reviewWorkspaceDigest: snapshotReviewWorkspaceDigest,
        sourceScope: persistedSourceScope,
        scope,
        parent: parentRecord,
        emptyBoundaryAuthorized: persistedSourceScope.emptyBoundaryAuthorized,
      };
      await writeFile(path.join(temporaryRoot, "snapshot.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
      finalRoot = path.join(snapshotsRoot, id);
      try {
        await rename(temporaryRoot, finalRoot);
        renamed = true;
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== "EEXIST" &&
          (error as NodeJS.ErrnoException).code !== "ENOTEMPTY"
        ) {
          throw error;
        }
        await measureJudgePhase("cleanup", () => rm(temporaryRoot, { recursive: true, force: true }));
      }
      const loaded = await loadJudgeSnapshot(cwd, candidate);
      return {
        id: loaded.id,
        candidate: loaded.candidate,
        scope: loaded.scope,
        metadataPath: loaded.metadataPath,
        worktreePath: loaded.worktreePath,
        parent: loaded.parent,
        emptyBoundaryAuthorized: loaded.emptyBoundaryAuthorized,
      };
    } catch (error) {
      // If the self-verifying load below failed after the rename landed, the snapshot directory
      // is on disk under finalRoot, not temporaryRoot — remove the one that exists so a failed
      // capture never leaves a permanently unloadable snapshot behind.
      if (renamed) await measureJudgePhase("cleanup", () => rm(finalRoot, { recursive: true, force: true }));
      else await measureJudgePhase("cleanup", () => rm(temporaryRoot, { recursive: true, force: true }));
      throw error;
    }
  }
  throw new Error("The workspace kept changing while wep captured it. Retry when file writes briefly settle.");
}

async function overlayChangedFiles(sourceRoot: string, snapshotRoot: string, relativePaths: string[]): Promise<void> {
  for (const relativePath of relativePaths) {
    const source = path.join(sourceRoot, relativePath);
    const destination = path.join(snapshotRoot, relativePath);
    const info = await lstat(source).catch(() => undefined);
    if (!info) {
      await rm(destination, { recursive: true, force: true });
      continue;
    }
    await mkdir(path.dirname(destination), { recursive: true });
    await rm(destination, { recursive: true, force: true });
    if (info.isSymbolicLink()) {
      await symlink(await readlink(source), destination);
    } else if (info.isDirectory()) {
      await cp(source, destination, { recursive: true, preserveTimestamps: true });
    } else {
      await copyFile(source, destination);
    }
  }
}

async function createPrivateGitWorkspace(
  sourceRoot: string,
  snapshotRoot: string,
  baseCommit: string,
  candidateCommit: string,
): Promise<void> {
  await mkdir(snapshotRoot, { recursive: true });
  await git(snapshotRoot, ["init", "--quiet"]);
  await git(snapshotRoot, ["remote", "add", "origin", pathToFileURL(sourceRoot).href]);
  await git(snapshotRoot, ["fetch", "--quiet", "--depth=1", "--no-tags", "origin", candidateCommit]);
  await git(snapshotRoot, ["checkout", "--quiet", "--detach", "FETCH_HEAD"]);
  if (baseCommit !== candidateCommit) {
    await git(snapshotRoot, ["fetch", "--quiet", "--depth=1", "--no-tags", "origin", baseCommit]);
  }
  await git(snapshotRoot, ["remote", "remove", "origin"]);
}

async function removeBlockedPaths(snapshotRoot: string, blockedPatterns: string[]): Promise<void> {
  const tracked = await git(snapshotRoot, ["ls-files", "--cached", "-z"]);
  for (const relativePath of tracked.split("\0").filter(Boolean)) {
    if (blockedPatterns.some((pattern) => matchesBlockedPattern(relativePath, pattern))) {
      await rm(path.join(snapshotRoot, relativePath), { recursive: true, force: true });
    }
  }
}

async function restorePackageManagerState(sourceRoot: string, snapshotRoot: string): Promise<void> {
  for (const filename of ["pnpm-lock.yaml", "package-lock.json", "yarn.lock"]) {
    const source = path.join(sourceRoot, filename);
    const destination = path.join(snapshotRoot, filename);
    if (await lstat(source).catch(() => undefined)) await copyFile(source, destination);
    else await rm(destination, { force: true });
  }
}

async function workspaceManifest(root: string, blockedPatterns: string[]): Promise<Map<string, PathFingerprint>> {
  const raw = await git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  const paths = raw.split("\0").filter(Boolean).sort();
  const manifest = new Map<string, PathFingerprint>();
  for (const relativePath of paths) {
    if (relativePath === "node_modules" && (await lstat(path.join(root, relativePath))).isSymbolicLink()) continue;
    await addManifestPath(root, relativePath, blockedPatterns, manifest);
  }

  const directories = new Set<string>();
  for (const relativePath of [...manifest.keys()]) {
    let dir = path.posix.dirname(relativePath);
    while (dir && dir !== "." && !directories.has(dir)) {
      directories.add(dir);
      dir = path.posix.dirname(dir);
    }
  }
  for (const dir of [...directories].sort()) {
    if (manifest.has(dir)) continue;
    const info = await lstat(path.join(root, dir)).catch(() => undefined);
    if (!info || !info.isDirectory()) continue;
    manifest.set(dir, { content: "dir", stat: statOf(info) });
  }
  return manifest;
}

async function addManifestPath(
  root: string,
  relativePath: string,
  blockedPatterns: string[],
  manifest: Map<string, PathFingerprint>,
): Promise<void> {
  if (blockedPatterns.some((pattern) => matchesBlockedPattern(relativePath, pattern))) return;
  const absolute = path.join(root, relativePath);
  const info = await lstat(absolute).catch(() => undefined);
  if (!info) {
    manifest.set(relativePath, { content: "missing", stat: null });
  } else if (info.isSymbolicLink()) {
    manifest.set(relativePath, { content: hash(["symlink\0", await readlink(absolute)]), stat: statOf(info) });
  } else if (info.isFile()) {
    manifest.set(relativePath, { content: hash(["file\0", await readFile(absolute)]), stat: statOf(info) });
  } else if (info.isDirectory()) {
    const nested = await git(absolute, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).catch(
      () => undefined,
    );
    if (nested === undefined) {
      manifest.set(relativePath, { content: "directory", stat: statOf(info) });
      return;
    }
    const nestedPaths = nested.split("\0").filter(Boolean).sort();
    if (nestedPaths.length === 0) manifest.set(relativePath, { content: "empty-git-directory", stat: statOf(info) });
    for (const nestedPath of nestedPaths) {
      await addManifestPath(root, path.posix.join(relativePath, nestedPath), blockedPatterns, manifest);
    }
  } else {
    manifest.set(relativePath, { content: `type:${info.mode}`, stat: statOf(info) });
  }
}

function statOf(info: { ctimeMs: number }): string {
  // Only ctime (inode change time), never the inode number. ctime is kernel-set and changes only
  // on a content or metadata modification, so it detects a write-then-restore and a
  // create-then-delete (the parent directory's ctime moves) without false-positiving on an
  // honest load. The inode number is deliberately excluded: on FUSE and some network mounts it is
  // synthesized by the daemon and drifts over time even when nothing changed, which makes a
  // captured workspaceDigest irreproducible at load and an honest snapshot permanently
  // unreviewable. ctime alone is the stable modification evidence.
  return hash(["stat\0", String(info.ctimeMs)]);
}

function contentDigest(manifest: Map<string, PathFingerprint>): string {
  return hash(
    [...manifest]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .flatMap(([relativePath, fp]) => [relativePath, "\0", fp.content, "\0"]),
  );
}

function workspaceDigest(manifest: Map<string, PathFingerprint>): string {
  return hash(
    [...manifest]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .flatMap(([relativePath, fp]) => [relativePath, "\0", fp.content, "\0", fp.stat ?? "", "\0"]),
  );
}

/**
 * Identifies the one path that is exempt from `reviewContentDigest`: the task's continuation
 * sidecar, and only when it is a regular file `readTaskContinuation` accepts as `status: "valid"`.
 * An absent, irregular, invalid, or unsupported sidecar returns `null` and stays inside the
 * reviewable content like any ordinary tracked file.
 */
export async function reviewSidecarExclusion(worktreePath: string, taskId: string): Promise<string | null> {
  try {
    const result = await readTaskContinuation(worktreePath, taskId);
    return result.status === "valid" ? result.path : null;
  } catch {
    return null;
  }
}

async function reviewDigests(
  worktreePath: string,
  taskId: string,
  manifest: Map<string, PathFingerprint>,
): Promise<{ reviewContentDigest: string; reviewWorkspaceDigest: string }> {
  const excludedPath = await reviewSidecarExclusion(worktreePath, taskId);
  let reviewManifest = manifest;
  if (excludedPath !== null && manifest.has(excludedPath)) {
    reviewManifest = new Map(manifest);
    reviewManifest.delete(excludedPath);
  }
  // Both digests cover the reviewable subset. Sidecar tampering inside the capture is still caught
  // by `workspaceDigest`, which spans the whole manifest.
  return {
    reviewContentDigest: contentDigest(reviewManifest),
    reviewWorkspaceDigest: workspaceDigest(reviewManifest),
  };
}

/**
 * The live tree's content over the snapshot's coverage: tracked plus untracked-not-ignored, without
 * the paths the snapshot's policy blocks. Git-ignored output is outside it, so builds may write it.
 */
export async function liveContentState(
  cwd: string,
  snapshot: LoadedJudgeSnapshot,
): Promise<{ digest: string; manifest: Map<string, PathFingerprint> }> {
  const manifest = await workspaceManifest(cwd, await readBlockedPatterns(snapshot.worktreePath));
  return { digest: contentDigest(manifest), manifest };
}

/** Paths whose content differs between two manifests, sorted. */
export function changedContentPaths(
  before: Map<string, PathFingerprint>,
  after: Map<string, PathFingerprint>,
): string[] {
  return changedManifestPaths(before, after);
}

function changedManifestPaths(before: Map<string, PathFingerprint>, after: Map<string, PathFingerprint>): string[] {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((relativePath) => before.get(relativePath)?.content !== after.get(relativePath)?.content)
    .sort();
}

function deltaDigest(before: Map<string, PathFingerprint>, after: Map<string, PathFingerprint>): string {
  return hash(
    changedManifestPaths(before, after).flatMap((relativePath) => [
      relativePath,
      "\0",
      before.get(relativePath)?.content ?? "absent",
      "\0",
      after.get(relativePath)?.content ?? "absent",
      "\0",
    ]),
  );
}

function snapshotId(
  taskId: string,
  sourceScope: JudgeScope,
  contentDigest: string,
  parent?: JudgeSnapshotParent,
): string {
  const { baseRef: _diagnostic, ...canonicalSourceScope } = sourceScope;
  // Same serialization as when an absent artifact digest was part of this object, so the IDs of
  // existing snapshots do not change.
  return hash([JSON.stringify({ taskId, sourceScope: canonicalSourceScope, contentDigest, parent })]).slice(
    "sha256:".length,
    27,
  );
}

function scopeDigest(scope: Omit<JudgeScope, "scopeDigest"> | JudgeScope): string {
  const { scopeDigest: _ignored, baseRef: _diagnostic, ...core } = scope as JudgeScope;
  return hash([JSON.stringify(core)]);
}

function sameLiveBoundary(left: JudgeScope, right: JudgeScope): boolean {
  return (
    left.candidateCommit === right.candidateCommit &&
    left.taskDigest === right.taskDigest &&
    left.changeDigest === right.changeDigest &&
    JSON.stringify(left.changedFiles) === JSON.stringify(right.changedFiles) &&
    JSON.stringify(left.excludedPaths) === JSON.stringify(right.excludedPaths)
  );
}

async function readBlockedPatterns(cwd: string): Promise<string[]> {
  const { readBlockedPatterns: read } = await import("./judge-enforcement.js");
  return read(cwd);
}

function matchesBlockedPattern(relativePath: string, pattern: string): boolean {
  const normalized = relativePath.split(path.sep).join("/");
  const parts = normalized.split("/");
  if (pattern.endsWith("/")) {
    const directory = pattern.slice(0, -1);
    return parts.includes(directory) || normalized.startsWith(pattern);
  }
  if (pattern.startsWith("*.")) return parts.some((part) => part.endsWith(pattern.slice(1)));
  if (pattern.endsWith(".*")) return parts.some((part) => part.startsWith(pattern.slice(0, -1)));
  return parts.includes(pattern) || normalized === pattern;
}

function normalizePatterns(patterns: string[]): string[] {
  return [...new Set(patterns)].sort();
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

async function gitExitZero(cwd: string, args: string[]): Promise<boolean> {
  try {
    await git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

function hash(parts: Array<string | Buffer>): string {
  const digest = createHash("sha256");
  for (const part of parts) digest.update(part);
  return `sha256:${digest.digest("hex")}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
