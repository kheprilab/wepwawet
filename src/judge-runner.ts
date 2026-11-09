import { exec } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  type JudgeScope,
  type ValidationDeclaration,
  hasPreApprovedValidationCommands,
  readValidationDeclaration,
  snapshotValidationDrift,
  validationCommandsDigest,
  withheldReason,
} from "./judge-enforcement.js";
import { RunLockBusy, type RunLockEnv, acquireRunLock } from "./judge-run-lock.js";
import {
  type LoadedJudgeSnapshot,
  changedContentPaths,
  createJudgeSnapshotValidationWorkspace,
  isSnapshotCandidate,
  liveContentState,
  loadJudgeSnapshot,
} from "./judge-snapshot.js";
import { measureJudgePhase } from "./judge-timings.js";
import {
  type ValidationFailureEvidence,
  captureValidationError,
  normalizeValidationCommand,
} from "./validation-evidence.js";
import { CLI_VERSION } from "./version.js";

const execAsync = promisify(exec);
const RECEIPT_TYPE = "wep-validation-receipt";
const RECEIPT_VERSION = 2;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/**
 * Lockfiles bound into a receipt, by well-known name at the project root. The set is
 * deliberately technology-neutral: a receipt only needs to notice that dependency resolution
 * changed, not to understand any package manager.
 */
const LOCKFILES = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "go.sum",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "Gemfile.lock",
  "composer.lock",
] as const;

export interface ValidationReceiptResult {
  command: string;
  status: "passed" | "failed";
  exitCode: number | null;
  evidence?: ValidationFailureEvidence;
}

/**
 * What one `wep judge run` observed for one snapshot.
 *
 * A local file cannot authenticate its writer, so the receipt carries no trust of its own. It
 * becomes evidence only when the trusted caller pins the digest `judge run` printed and passes
 * it to `judge verify --receipt-digest`. Host identity (Node version, architecture, operating
 * system) is deliberately absent: switching Node versions must not force a re-run.
 */
export interface ValidationReceipt {
  type: typeof RECEIPT_TYPE;
  /** Version 1 receipts predate `mode`; they were always isolated runs. */
  version: 1 | typeof RECEIPT_VERSION;
  /**
   * Runtime modes prove different things. Isolated: the validation passes with dependencies
   * installed from the lockfile. In-place: it passes with the developer's existing environment,
   * which may not match the lockfile. Documentation records an explicit zero-runtime declaration.
   */
  mode?: JudgeRunMode;
  /** Documentation only: the exact reason declared by the immutable task capsule. */
  noRuntimeReason?: string;
  /** In-place only: the live content digest before and after the commands. Both must equal the snapshot's. */
  beforeDigest?: string;
  afterDigest?: string;
  cliVersion: string;
  taskId: string;
  snapshotId: string;
  candidate: string;
  reviewContentDigest: string;
  reviewWorkspaceDigest: string;
  commands: string[];
  commandsDigest: string;
  lockfileDigest: string | null;
  results: ValidationReceiptResult[];
  drift: string[];
  startedAt: string;
  finishedAt: string;
}

export type JudgeRunMode = "in-place" | "isolated" | "documentation";

export interface JudgeRunResult {
  receipt: ValidationReceipt;
  /** Relative to the project root, with forward slashes. */
  receiptPath: string;
  receiptDigest: string;
  /** True only when runtime commands passed and validation left the boundary intact. */
  passed: boolean;
  outcome: "passed" | "failed" | "invalidated" | "no-runtime-validation";
  /** 0 completed (including documentation), 1 a required command failed, 5 boundary drift. */
  exitCode: 0 | 1 | 5;
  /** Covered paths that changed during the run (in-place) or in the disposable copy (isolated). */
  changedPaths: string[];
  notices: string[];
}

/**
 * A run that never started. Each refusal has its own exit code, so an orchestrator with no human
 * can tell "retry later" (lock busy) from "recapture" (tree mismatch) from "ask for approval".
 */
export class JudgeRunRefusal extends Error {
  constructor(
    message: string,
    readonly outcome: "approval-missing" | "lock-busy" | "tree-mismatch",
    readonly exitCode: 3 | 4 | 6,
    readonly paths: string[] = [],
    /** Lock notices from before the refusal, such as a reclaimed stale lock. */
    readonly notices: string[] = [],
  ) {
    super(message);
  }
}

export interface JudgeRunOptions {
  approve?: (commands: string[]) => Promise<boolean>;
  /** Run in a disposable copy with dependencies from the lockfile instead of the live tree. */
  isolated?: boolean;
  /** Remove a lock held by another host, whose liveness cannot be checked from here. */
  breakLock?: boolean;
  lockEnv?: RunLockEnv;
  /** Called once the run is about to execute commands, so the caller can tell the human not to edit. */
  onStart?: (info: {
    mode: JudgeRunMode;
    taskId: string;
    candidate: string;
    commands: string[];
    /** Lock notices, such as a reclaimed stale lock, shown before the commands run. */
    notices: string[];
  }) => void;
}

export interface ExecutedCommand {
  command: string;
  passed: boolean;
  exitCode: number | null;
  evidence?: ValidationFailureEvidence;
}

/**
 * Run commands in a fresh disposable copy of a snapshot, then check that they left the reviewed
 * boundary intact. Used by `judge run --isolated` and by `verify --run-tests`.
 */
export async function executeInSnapshotCopy(
  cwd: string,
  candidate: string,
  sourceScope: JudgeScope,
  commands: readonly string[],
): Promise<{ executed: ExecutedCommand[]; drift: string[] }> {
  const workspace = await createJudgeSnapshotValidationWorkspace(cwd, candidate);
  try {
    const executed = await executeCommands(workspace.worktreePath, commands);
    const drift = executed.length > 0 ? await snapshotValidationDrift(workspace.worktreePath, sourceScope) : [];
    return { executed, drift };
  } finally {
    await workspace.cleanup();
  }
}

/** Each distinct command once, in order, with `workingDirectory` as its working directory. */
async function executeCommands(workingDirectory: string, commands: readonly string[]): Promise<ExecutedCommand[]> {
  const executed: ExecutedCommand[] = [];
  for (const [index, command] of [...new Set(commands)].entries()) {
    try {
      await measureJudgePhase(
        "validation-command",
        () => execAsync(command, { cwd: workingDirectory, timeout: 15 * 60_000, maxBuffer: 64 * 1024 * 1024 }),
        index + 1,
      );
      executed.push({ command, passed: true, exitCode: 0 });
    } catch (error) {
      const evidence = captureValidationError(command, error);
      executed.push({ command, passed: false, exitCode: evidence.exitCode, evidence });
    }
  }
  return executed;
}

export async function runJudgeValidation(
  cwd: string,
  taskId: string,
  candidate: string,
  options: JudgeRunOptions = {},
): Promise<JudgeRunResult> {
  if (!isSnapshotCandidate(candidate)) {
    throw new Error(
      "judge run requires a snapshot candidate, SNAPSHOT:<id>; capture one with `wep judge snapshot <TASK-ID>`.",
    );
  }
  const snapshot = await loadJudgeSnapshot(cwd, candidate);
  if (snapshot.scope.taskId !== taskId) {
    throw new Error(`Snapshot ${snapshot.id} belongs to ${snapshot.scope.taskId}, not ${taskId}.`);
  }
  const declaration = await readValidationDeclaration(snapshot.worktreePath, taskId);
  if (declaration.kind === "documentation") {
    if (!declaration.reason) throw new Error("Documentation validation requires an explicit reason.");
    const timestamp = new Date().toISOString();
    const receipt: ValidationReceipt = {
      type: RECEIPT_TYPE,
      version: RECEIPT_VERSION,
      mode: "documentation",
      noRuntimeReason: declaration.reason,
      cliVersion: CLI_VERSION,
      taskId,
      snapshotId: snapshot.id,
      candidate: snapshot.candidate,
      reviewContentDigest: snapshot.metadata.reviewContentDigest,
      reviewWorkspaceDigest: snapshot.metadata.reviewWorkspaceDigest,
      commands: [],
      commandsDigest: validationCommandsDigest([]),
      lockfileDigest: await lockfileDigest(snapshot.worktreePath),
      results: [],
      drift: [],
      startedAt: timestamp,
      finishedAt: timestamp,
    };
    return {
      receipt,
      ...(await persistReceipt(cwd, snapshot, receipt)),
      passed: false,
      outcome: "no-runtime-validation",
      exitCode: 0,
      changedPaths: [],
      notices: [],
    };
  }
  const commands = declaration.commands;
  if (commands.length === 0) {
    throw new Error(`${taskId} declares no validation commands under ## Validation.`);
  }
  const approved =
    (await hasPreApprovedValidationCommands(cwd, taskId, commands, commands)) ||
    (await measureJudgePhase(
      "approval-wait",
      async () => Boolean(await options.approve?.([...commands])),
      undefined,
      Boolean,
    ));
  if (!approved) throw new JudgeRunRefusal(withheldReason(commands), "approval-missing", 3);

  let lock: Awaited<ReturnType<typeof acquireRunLock>>;
  try {
    lock = await acquireRunLock(
      cwd,
      { taskId, snapshotId: snapshot.id },
      { breakLock: options.breakLock, env: options.lockEnv },
    );
  } catch (error) {
    if (error instanceof RunLockBusy) throw new JudgeRunRefusal(error.message, "lock-busy", 4);
    throw error;
  }
  try {
    const mode: JudgeRunMode = options.isolated ? "isolated" : "in-place";
    const before = mode === "in-place" ? await liveContentState(cwd, snapshot) : undefined;
    if (before && before.digest !== snapshot.metadata.contentDigest) {
      const paths = changedContentPaths(snapshot.manifest, before.manifest);
      throw new JudgeRunRefusal(
        `The working tree no longer matches ${snapshot.candidate}, so nothing ran. Differing paths: ${paths.slice(0, 8).join(", ")}${paths.length > 8 ? ", ..." : ""}. Capture a new snapshot, or use --isolated to run the reviewed content as captured.`,
        "tree-mismatch",
        6,
        paths,
        lock.notices,
      );
    }
    options.onStart?.({ mode, taskId, candidate: snapshot.candidate, commands: [...commands], notices: lock.notices });

    const startedAt = new Date().toISOString();
    let executed: ExecutedCommand[];
    let drift: string[];
    let after: Awaited<ReturnType<typeof liveContentState>> | undefined;
    if (before) {
      executed = await executeCommands(cwd, commands);
      after = await liveContentState(cwd, snapshot);
      drift = changedContentPaths(before.manifest, after.manifest);
    } else {
      ({ executed, drift } = await executeInSnapshotCopy(cwd, candidate, snapshot.metadata.sourceScope, commands));
    }
    const normalized = commands.map(normalizeValidationCommand);
    const receipt: ValidationReceipt = {
      type: RECEIPT_TYPE,
      version: RECEIPT_VERSION,
      mode,
      ...(before && after ? { beforeDigest: before.digest, afterDigest: after.digest } : {}),
      cliVersion: CLI_VERSION,
      taskId,
      snapshotId: snapshot.id,
      candidate: snapshot.candidate,
      reviewContentDigest: snapshot.metadata.reviewContentDigest,
      reviewWorkspaceDigest: snapshot.metadata.reviewWorkspaceDigest,
      commands: normalized,
      commandsDigest: validationCommandsDigest(normalized),
      lockfileDigest: await lockfileDigest(snapshot.worktreePath),
      results: executed.map((item) => ({
        command: normalizeValidationCommand(item.command),
        status: item.passed ? "passed" : "failed",
        exitCode: item.exitCode,
        ...(item.evidence ? { evidence: item.evidence } : {}),
      })),
      drift,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
    const required = declaration.checks.filter((check) => check.required).map((check) => check.command);
    const commandsPassed = executed.every((item) => item.passed || !required.includes(item.command));
    const outcome = drift.length > 0 ? "invalidated" : commandsPassed ? "passed" : "failed";
    return {
      receipt,
      ...(await persistReceipt(cwd, snapshot, receipt)),
      passed: outcome === "passed",
      outcome,
      exitCode: outcome === "passed" ? 0 : outcome === "failed" ? 1 : 5,
      changedPaths: drift,
      notices: lock.notices,
    };
  } finally {
    await lock.release();
  }
}

async function persistReceipt(cwd: string, snapshot: LoadedJudgeSnapshot, receipt: ValidationReceipt) {
  const bytes = `${JSON.stringify(receipt, null, 2)}\n`;
  const hex = createHash("sha256").update(bytes).digest("hex");
  const file = receiptFile(snapshot, hex);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes, "utf8");
  return {
    receiptPath: path.relative(cwd, file).split(path.sep).join("/"),
    receiptDigest: `sha256:${hex}`,
  };
}

/** Version 1 receipts were always isolated runs. */
export function receiptMode(receipt: ValidationReceipt): JudgeRunMode {
  return receipt.mode ?? "isolated";
}

/** Read the receipt the caller pinned. Any byte change since `judge run` wrote it is a refusal. */
export async function readValidationReceipt(
  cwd: string,
  candidate: string,
  digest: string,
): Promise<ValidationReceipt> {
  if (!DIGEST_PATTERN.test(digest)) {
    throw new Error(`The pinned receipt digest must be sha256:<64 hex characters>, not ${JSON.stringify(digest)}.`);
  }
  const snapshot = await loadJudgeSnapshot(cwd, candidate);
  const file = receiptFile(snapshot, digest.slice("sha256:".length));
  const bytes = await readFile(file).catch(() => undefined);
  if (!bytes) {
    throw new Error(
      `No validation receipt ${digest} exists for snapshot ${snapshot.id}. Run \`wep judge run\` and pin the digest it prints.`,
    );
  }
  if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== digest) {
    throw new Error(
      `The receipt file ${path.relative(cwd, file).split(path.sep).join("/")} does not match the pinned digest ${digest}; it changed after \`wep judge run\` wrote it.`,
    );
  }
  let receipt: unknown;
  try {
    receipt = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("The receipt is not valid JSON.");
  }
  if (!isReceipt(receipt)) throw new Error("The receipt format is not recognized.");
  return receipt;
}

/** Every way a pinned receipt can fail to describe the reviewed snapshot, one named binding each. */
export async function receiptBindingReasons(
  receipt: ValidationReceipt,
  snapshot: LoadedJudgeSnapshot,
  declaration: ValidationDeclaration,
): Promise<string[]> {
  const reasons: string[] = [];
  if (receipt.mode === "documentation") {
    if (declaration.kind !== "documentation" || receipt.noRuntimeReason !== declaration.reason) {
      reasons.push("The documentation receipt does not match the capsule's no-runtime-validation declaration.");
    }
  } else if (declaration.kind === "documentation") {
    reasons.push("A documentation declaration requires an explicit documentation receipt, not a runtime receipt.");
  }
  if (
    receipt.snapshotId !== snapshot.id ||
    receipt.candidate !== snapshot.candidate ||
    receipt.taskId !== snapshot.scope.taskId
  ) {
    reasons.push(
      `The receipt snapshot binding is broken: it records ${receipt.taskId} at ${receipt.candidate}, not ${snapshot.scope.taskId} at ${snapshot.candidate}.`,
    );
  }
  if (
    receipt.reviewContentDigest !== snapshot.metadata.reviewContentDigest ||
    receipt.reviewWorkspaceDigest !== snapshot.metadata.reviewWorkspaceDigest
  ) {
    reasons.push("The receipt review digests binding is broken: they no longer match the snapshot's reviewed content.");
  }
  const declared = declaration.commands.map(normalizeValidationCommand);
  if (
    JSON.stringify(receipt.commands) !== JSON.stringify(declared) ||
    receipt.commandsDigest !== validationCommandsDigest(receipt.commands) ||
    JSON.stringify(receipt.results.map((result) => result.command)) !== JSON.stringify(receipt.commands)
  ) {
    reasons.push(
      "The receipt command list binding is broken: the commands it ran are not the commands the capsule declares, in order.",
    );
  }
  if (receipt.lockfileDigest !== (await lockfileDigest(snapshot.worktreePath))) {
    reasons.push(
      "The receipt lockfile digest binding is broken: the snapshot's lockfiles differ from the ones it ran with.",
    );
  }
  if (
    receiptMode(receipt) === "in-place" &&
    (receipt.beforeDigest !== snapshot.metadata.contentDigest ||
      receipt.afterDigest !== snapshot.metadata.contentDigest)
  ) {
    reasons.push(
      "The receipt in-place digests binding is broken: the live tree before or after the run did not match the snapshot's content.",
    );
  }
  if (receipt.drift.length > 0) {
    reasons.push(
      receiptMode(receipt) === "in-place"
        ? `Validation changed the snapshot boundary in the live working tree: ${receipt.drift.join(", ")} no longer match the reviewed boundary.`
        : `Validation changed the snapshot boundary in its disposable workspace: ${receipt.drift.join(", ")} no longer match the reviewed boundary.`,
    );
  }
  return reasons;
}

function receiptFile(snapshot: LoadedJudgeSnapshot, hex: string): string {
  return path.join(path.dirname(snapshot.metadataPath), "receipts", `${hex}.json`);
}

async function lockfileDigest(root: string): Promise<string | null> {
  const hash = createHash("sha256");
  let found = false;
  for (const name of LOCKFILES) {
    const bytes = await readFile(path.join(root, name)).catch(() => undefined);
    if (!bytes) continue;
    found = true;
    hash.update(`${name}\0`);
    hash.update(bytes);
    hash.update("\0");
  }
  return found ? `sha256:${hash.digest("hex")}` : null;
}

function isReceipt(value: unknown): value is ValidationReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  const strings = ["cliVersion", "taskId", "snapshotId", "candidate", "startedAt", "finishedAt"];
  const digests = ["reviewContentDigest", "reviewWorkspaceDigest", "commandsDigest"];
  return (
    receipt.type === RECEIPT_TYPE &&
    (receipt.version === 1
      ? receipt.mode === undefined
      : receipt.version === RECEIPT_VERSION &&
        ((receipt.mode === "documentation" &&
          typeof receipt.noRuntimeReason === "string" &&
          receipt.noRuntimeReason.trim().length > 0 &&
          Array.isArray(receipt.commands) &&
          receipt.commands.length === 0 &&
          Array.isArray(receipt.results) &&
          receipt.results.length === 0) ||
          receipt.mode === "isolated" ||
          (receipt.mode === "in-place" &&
            typeof receipt.beforeDigest === "string" &&
            DIGEST_PATTERN.test(receipt.beforeDigest) &&
            typeof receipt.afterDigest === "string" &&
            DIGEST_PATTERN.test(receipt.afterDigest)))) &&
    strings.every((key) => typeof receipt[key] === "string") &&
    digests.every((key) => typeof receipt[key] === "string" && DIGEST_PATTERN.test(receipt[key] as string)) &&
    (receipt.lockfileDigest === null ||
      (typeof receipt.lockfileDigest === "string" && DIGEST_PATTERN.test(receipt.lockfileDigest))) &&
    Array.isArray(receipt.commands) &&
    receipt.commands.every((command) => typeof command === "string") &&
    Array.isArray(receipt.drift) &&
    receipt.drift.every((item) => typeof item === "string") &&
    Array.isArray(receipt.results) &&
    receipt.results.every(
      (result) =>
        result &&
        typeof result === "object" &&
        typeof (result as Record<string, unknown>).command === "string" &&
        ["passed", "failed"].includes(String((result as Record<string, unknown>).status)),
    )
  );
}
