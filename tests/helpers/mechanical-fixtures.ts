import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, readlink, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { runInit } from "../../src/init.js";
import { JUDGE_SCHEMA_VERSION, readAcceptanceCriteria } from "../../src/judge-enforcement.js";
import { captureJudgeSnapshot } from "../../src/judge-snapshot.js";
import { runTask } from "../../src/task.js";

import { execFileAsync, tmp } from "./wep.js";

export const SLOW = 120_000;
export const GENERATOR = `import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
const mode = process.argv[2] ?? "";
for (const file of ["data/a.txt", "data/b.txt"]) writeFileSync(file, readFileSync(file, "utf8").toUpperCase());
if (mode === "--stray") {
  mkdirSync("ignored", { recursive: true });
  writeFileSync("ignored/out.txt", "x");
}
if (mode === "--touch") writeFileSync("data/c.txt", readFileSync("data/c.txt"));
if (mode === "--delete") rmSync("data/old.txt");
if (mode === "--add") writeFileSync("data/new.txt", "new\\n");
if (mode === "--relink") {
  unlinkSync("data/link.txt");
  symlinkSync("target-b", "data/link.txt");
}
if (mode === "--exec") chmodSync("data/a.txt", 0o755);
if (mode === "--rootblip") {
  writeFileSync("blip", "");
  rmSync("blip");
}
`;
export const RUN = 'node "$WEP_GENERATOR_ROOT/tools/gen.mjs"';
export const VALIDATION = 'node -e "process.exit(0)"';

export interface Fixture {
  generator: { taskId: string };
  task: { taskId: string; taskDir: string };
  landed: string;
  candidate: string;
  include: string[];
  declare: (declaration: unknown) => Promise<void>;
}

export interface FixtureOptions {
  command?: string;
  prepare?: string[];
  paths?: string[] | (() => string[]);
  inputs?: string[];
  generatorSource?: string;
  reviewedSource?: string;
  setupBase?: () => Promise<void>;
  generateCandidate?: () => Promise<void>;
  includeTaskIds?: () => string[];
  review?: "approved" | "needs-changes" | "missing" | "commit-candidate";
  afterLanding?: () => Promise<void>;
  editCandidate?: () => Promise<void>;
  declarationOverride?: (declaration: Record<string, unknown>) => unknown;
  skipGeneration?: boolean;
  baseFiles?: Record<string, string>;
}

export async function sh(...args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd: tmp })).stdout.trim();
}

export async function fillValidation(taskDir: string): Promise<void> {
  const file = path.join(tmp, taskDir, "task.md");
  const original = await readFile(file, "utf8");
  await writeFile(file, original.replace("```\n```", `\`\`\`\n${VALIDATION}\n\`\`\``), "utf8");
}

export async function approvedGeneratorRecord(
  generatorTaskId: string,
  snapshotScope: unknown,
  verdict: string,
  recordFile: string,
) {
  const declaration = await readAcceptanceCriteria(tmp, generatorTaskId);
  await mkdir(path.dirname(path.join(tmp, recordFile)), { recursive: true });
  await writeFile(
    path.join(tmp, recordFile),
    `${JSON.stringify({
      schemaVersion: JUDGE_SCHEMA_VERSION,
      taskId: generatorTaskId,
      scope: snapshotScope,
      verdict,
      tests: [{ command: VALIDATION, status: "passed" }],
      criteria: declaration.ids.map((id) => ({ id, status: "pass", evidence: "Reviewed the generator." })),
      observations: [],
      reviewedAt: new Date().toISOString(),
    })}\n`,
    "utf8",
  );
}

export async function mechanicalFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const recordFile = ".wep/local/judge/generator-approved.json";
  await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
  await sh("init");
  await sh("config", "user.email", "tests@example.com");
  await sh("config", "user.name", "wep tests");
  await mkdir(path.join(tmp, "data"), { recursive: true });
  const baseFiles = options.baseFiles ?? {
    "data/a.txt": "alpha\n",
    "data/b.txt": "beta\n",
    "data/c.txt": "gamma\n",
    "data/old.txt": "old\n",
  };
  for (const [file, content] of Object.entries(baseFiles)) {
    await mkdir(path.dirname(path.join(tmp, file)), { recursive: true });
    await writeFile(path.join(tmp, file), content, "utf8");
  }
  await symlink("target-a", path.join(tmp, "data/link.txt"));
  await writeFile(
    path.join(tmp, ".gitignore"),
    `${await readFile(path.join(tmp, ".gitignore"), "utf8").catch(() => "")}\nignored/\n`,
  );
  const generator = await runTask("Land the generator", { cwd: tmp, nonInteractive: true });
  await fillValidation(generator.taskDir);
  await options.setupBase?.();
  await sh("add", "-A");
  await sh("commit", "-m", "base");

  const landedSource = options.generatorSource ?? GENERATOR;
  await mkdir(path.join(tmp, "tools"), { recursive: true });
  await writeFile(path.join(tmp, "tools/gen.mjs"), options.reviewedSource ?? landedSource, "utf8");
  if (options.review !== "missing") {
    const reviewed = await captureJudgeSnapshot(tmp, generator.taskId, "HEAD");
    await approvedGeneratorRecord(
      generator.taskId,
      reviewed.scope,
      options.review === "needs-changes" ? "NEEDS_CHANGES" : "APPROVED",
      recordFile,
    );
    if (options.review === "commit-candidate") {
      const record = JSON.parse(await readFile(path.join(tmp, recordFile), "utf8"));
      record.scope.candidate = "HEAD";
      await writeFile(path.join(tmp, recordFile), JSON.stringify(record), "utf8");
    }
  }
  await writeFile(path.join(tmp, "tools/gen.mjs"), landedSource, "utf8");
  await sh("add", "-A");
  await sh("commit", "-m", "land generator");
  const landed = await sh("rev-parse", "HEAD");
  await options.afterLanding?.();

  const task = await runTask("Mechanical change", { cwd: tmp, nonInteractive: true });
  await fillValidation(task.taskDir);
  const declaration = {
    generator: {
      command: options.command ?? RUN,
      commit: landed,
      review: recordFile,
      inputs: options.inputs ?? ["tools/gen.mjs"],
      prepare: options.prepare ?? [],
    },
    paths: typeof options.paths === "function" ? options.paths() : (options.paths ?? ["data/a.txt", "data/b.txt"]),
  };
  const declare = async (value: unknown) => {
    const file = path.join(tmp, task.taskDir, "task.md");
    const markdown = (await readFile(file, "utf8")).replace(/\n## Migration[\s\S]*$/, "");
    await writeFile(file, `${markdown}\n## Migration\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`);
  };
  await declare(options.declarationOverride ? options.declarationOverride(declaration) : declaration);
  if (options.generateCandidate) {
    await options.generateCandidate();
  } else if (!options.skipGeneration) {
    for (const file of ["data/a.txt", "data/b.txt"]) {
      const full = path.join(tmp, file);
      await writeFile(full, (await readFile(full, "utf8")).toUpperCase());
    }
  }
  await options.editCandidate?.();
  const include = options.includeTaskIds?.() ?? [];
  const snapshot = await captureJudgeSnapshot(tmp, task.taskId, "HEAD", include);
  return { generator, task, landed, candidate: snapshot.candidate, include, declare };
}

export async function reproduce(
  fixture: Fixture,
  approve: (commands: string[]) => Promise<boolean> = async () => true,
) {
  const { reproduceMechanicalChange } = await import("../../src/mechanical-reproduction.js");
  return reproduceMechanicalChange(tmp, fixture.task.taskId, {
    base: "HEAD",
    candidate: fixture.candidate,
    includedTaskIds: fixture.include,
    approve,
  });
}

export async function treeDigest(root: string): Promise<string> {
  const lines: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (entry.name === ".git") continue;
      const full = path.join(directory, entry.name);
      const relative = path.relative(root, full);
      if (entry.isDirectory()) {
        lines.push(`d ${relative}`);
        await visit(full);
      } else if (entry.isSymbolicLink()) {
        lines.push(`l ${relative} ${await readlink(full)}`);
      } else {
        lines.push(
          `f ${relative} ${createHash("sha256")
            .update(await readFile(full))
            .digest("hex")}`,
        );
      }
    }
  };
  await visit(root);
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}
