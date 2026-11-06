import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { runInit } from "../src/init.js";
import { JUDGE_SCHEMA_VERSION, readAcceptanceCriteria } from "../src/judge-enforcement.js";
import { collectJudgeRounds, renderJudgeRounds } from "../src/judge-rounds.js";
import { captureJudgeCatchUpSnapshot, captureJudgeSnapshot } from "../src/judge-snapshot.js";
import { runTask } from "../src/task.js";

import { execFileAsync, tmp, useTempDir } from "./helpers/wep.js";

useTempDir();

describe("TASK-076 judge round accounting", () => {
  const cli = path.resolve("dist/index.js");
  const JUDGE_DIR = ".wep/local/judge";
  const digestOf = (seed: string) => `sha256:${createHash("sha256").update(seed).digest("hex")}`;

  interface FixtureRecord {
    taskId?: unknown;
    verdict?: unknown;
    reviewedAt?: unknown;
    digest?: string | null;
    candidate?: string;
    independent?: boolean;
    criteria?: Array<{ id: string; status: string; evidence: string }>;
    extra?: Record<string, unknown>;
  }

  function recordBody(input: FixtureRecord): Record<string, unknown> {
    const body: Record<string, unknown> = { schemaVersion: 5, tests: [] };
    body.taskId = "taskId" in input ? input.taskId : "TASK-001";
    if ("verdict" in input) body.verdict = input.verdict;
    else body.verdict = "APPROVED";
    if ("reviewedAt" in input) {
      if (input.reviewedAt !== undefined) body.reviewedAt = input.reviewedAt;
    } else {
      body.reviewedAt = "2026-08-01T10:00:00Z";
    }
    const scope: Record<string, unknown> = { candidate: input.candidate ?? "WORKTREE" };
    if (input.digest !== null) scope.scopeDigest = input.digest ?? digestOf("default");
    body.scope = scope;
    if (input.independent !== undefined) body.independent = input.independent;
    if (input.criteria) body.criteria = input.criteria;
    return { ...body, ...input.extra };
  }

  async function put(relative: string, input: FixtureRecord | string): Promise<string> {
    const target = path.join(tmp, JUDGE_DIR, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, typeof input === "string" ? input : `${JSON.stringify(recordBody(input), null, 2)}\n`);
    return `${JUDGE_DIR}/${relative}`;
  }

  beforeEach(async () => {
    await mkdir(path.join(tmp, ".wep"), { recursive: true });
    await writeFile(
      path.join(tmp, ".wep/policy.json"),
      JSON.stringify({ blockedReadPatterns: [".env", "*.pem", "secrets/", "private/"] }),
    );
  });

  async function treeState(): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        const info = await lstat(full);
        if (entry.isDirectory()) {
          out.push(`d ${path.relative(tmp, full)} ${info.mtimeMs}`);
          await walk(full);
        } else if (entry.isSymbolicLink()) {
          out.push(`l ${path.relative(tmp, full)} ${await readlink(full)}`);
        } else {
          out.push(`f ${path.relative(tmp, full)} ${info.mtimeMs} ${(await readFile(full)).toString("base64")}`);
        }
      }
    };
    await walk(tmp);
    return out.sort();
  }

  it("counts every historical name shape and lists project-relative source files", async () => {
    const files = [
      "TASK-001-review.json",
      "TASK-001-review-2.json",
      "TASK-001-review-final2-approved.json",
      "TASK-001-a328907c6fd343c8e431.json",
      "TASK-001-d7ed997c8f67bfdcb94c.review.json",
      "TASK-001-2026-07-22T191831Z.json",
      "TASK-001/review.json",
      "records/TASK-001-old.json",
      "TASK-001-no-extension",
    ];
    for (const [index, name] of files.entries()) {
      await put(name, {
        reviewedAt: `2026-08-01T10:${String(index).padStart(2, "0")}:00Z`,
        digest: digestOf(name),
      });
    }

    const report = await collectJudgeRounds(tmp);

    expect(report.tasks).toHaveLength(1);
    expect(report.tasks[0].rounds).toHaveLength(files.length);
    expect(report.tasks[0].rounds.flatMap((round) => round.files).sort()).toEqual(
      files.map((name) => `${JUDGE_DIR}/${name}`).sort(),
    );
    expect(report.skipped).toEqual([]);
  });

  it("does not traverse snapshots/ and skips symbolic links without counting them", async () => {
    await put("TASK-001-real.json", { digest: digestOf("real") });
    await put("snapshots/abc/worktree/TASK-001-inside.json", { digest: digestOf("inside") });
    await symlink(path.join(tmp, JUDGE_DIR, "TASK-001-real.json"), path.join(tmp, JUDGE_DIR, "TASK-001-link.json"));

    const report = await collectJudgeRounds(tmp);

    expect(report.tasks[0].rounds).toHaveLength(1);
    expect(report.tasks[0].rounds[0].files).toEqual([`${JUDGE_DIR}/TASK-001-real.json`]);
    expect(JSON.stringify(report)).not.toContain("inside");
    expect(report.skipped).toEqual([
      { file: `${JUDGE_DIR}/TASK-001-link.json`, reason: expect.stringContaining("symbolic link") },
    ]);
  });

  it("enters only TASK-<n>/ and records/ and reports other directories as one skipped entry", async () => {
    await put("TASK-001-real.json", { digest: digestOf("real") });
    await put("TASK-001/review.json", { reviewedAt: "2026-08-02T10:00:00Z", digest: digestOf("dir") });
    await put("records/TASK-001-old.json", { reviewedAt: "2026-08-03T10:00:00Z", digest: digestOf("rec") });
    await put("TASK-001/nested/deep.json", { reviewedAt: "2026-08-04T10:00:00Z", digest: digestOf("deep") });
    await put("TASK-083-workspace/.wep/local/judge/TASK-001-copy.json", { digest: digestOf("real") });
    await put("TASK-083-workspace/README.md", "# not a record\n");

    const report = await collectJudgeRounds(tmp);

    expect(report.tasks[0].rounds).toHaveLength(3);
    expect(JSON.stringify(report.tasks)).not.toContain("workspace");
    expect(report.skipped.map((entry) => entry.file)).toEqual([
      `${JUDGE_DIR}/TASK-001/nested`,
      `${JUDGE_DIR}/TASK-083-workspace`,
    ]);
    for (const entry of report.skipped) expect(entry.reason).toMatch(/^unattributable: .*not traversed/);
  });

  it("honors blocked-read policy and fails closed when the policy is unreadable", async () => {
    await put("TASK-001-ok.json", { digest: digestOf("ok") });
    await put("private/TASK-001-hidden.json", { digest: digestOf("hidden") });
    await put("TASK-001-key.pem", { digest: digestOf("pem") });

    const report = await collectJudgeRounds(tmp);

    expect(report.tasks[0].rounds).toHaveLength(1);
    expect(report.skipped.map((entry) => entry.file).sort()).toEqual([
      `${JUDGE_DIR}/TASK-001-key.pem`,
      `${JUDGE_DIR}/private`,
    ]);
    for (const entry of report.skipped) expect(entry.reason).toContain("blocked");

    await rm(path.join(tmp, ".wep/policy.json"));
    await expect(collectJudgeRounds(tmp)).rejects.toThrow("blockedReadPatterns");
  });

  it("skips malformed and non-record files with a reason and labels unattributable ones", async () => {
    await put("TASK-001-ok.json", { digest: digestOf("ok") });
    await put("broken.json", "{ not json");
    await put("timings.jsonl", '{"phase":"snapshot"}\n{"phase":"verify"}\n');
    await put("array.json", "[1,2]");
    await put("no-task.json", { taskId: undefined, digest: digestOf("x") });
    await put("bad-verdict.json", { taskId: "TASK-002", verdict: "MAYBE", digest: digestOf("y") });
    await put("bad-task.json", { taskId: "TASK-x", digest: digestOf("z") });

    const report = await collectJudgeRounds(tmp);

    expect(report.tasks.map((task) => task.taskId)).toEqual(["TASK-001"]);
    const byFile = Object.fromEntries(report.skipped.map((entry) => [entry.file, entry.reason]));
    expect(Object.keys(byFile).sort()).toEqual(
      ["array.json", "bad-task.json", "bad-verdict.json", "broken.json", "no-task.json", "timings.jsonl"].map(
        (name) => `${JUDGE_DIR}/${name}`,
      ),
    );
    for (const name of ["array.json", "bad-task.json", "broken.json", "no-task.json", "timings.jsonl"]) {
      expect(byFile[`${JUDGE_DIR}/${name}`]).toMatch(/^unattributable: /);
    }
    expect(byFile[`${JUDGE_DIR}/bad-verdict.json`]).toContain("TASK-002");
    expect(byFile[`${JUDGE_DIR}/bad-verdict.json`]).not.toMatch(/^unattributable/);
  });

  it("reports a file that cannot be stat'ed during discovery in skipped without aborting", async () => {
    await put("TASK-001-ok.json", { digest: digestOf("ok") });
    await put("records/unstatable.json", { digest: digestOf("unstatable") });
    const recordsDir = path.join(tmp, JUDGE_DIR, "records");
    await chmod(recordsDir, 0o400);
    try {
      const report = await collectJudgeRounds(tmp);
      expect(report.tasks.map((task) => task.taskId)).toEqual(["TASK-001"]);
      expect(report.skipped).toContainEqual({
        file: `${JUDGE_DIR}/records/unstatable.json`,
        reason: expect.stringMatching(/^unattributable: /),
      });
    } finally {
      await chmod(recordsDir, 0o755);
    }
  });

  it("accepts an older schema without full record verification", async () => {
    await put("TASK-001-v2.json", { extra: { schemaVersion: 2, unexpected: true } });

    const report = await collectJudgeRounds(tmp);

    expect(report.tasks[0].rounds).toHaveLength(1);
    expect(report.skipped).toEqual([]);
  });

  it("counts exact copies once and lists every source file sorted", async () => {
    const key = { reviewedAt: "2026-08-31T14:46:02Z", digest: digestOf("same") };
    await put("TASK-001-approved.json", key);
    await put("TASK-001-approved-raw.json", { ...key, extra: { tests: [{ command: "x", status: "passed" }] } });

    const report = await collectJudgeRounds(tmp);

    expect(report.tasks[0].rounds).toHaveLength(1);
    expect(report.tasks[0].rounds[0].files).toEqual([
      `${JUDGE_DIR}/TASK-001-approved-raw.json`,
      `${JUDGE_DIR}/TASK-001-approved.json`,
    ]);
    expect(report.tasks[0].rounds[0].ambiguous).toBe(false);
    expect(report.unknown.filter((entry) => entry.reason.includes("conflict"))).toEqual([]);
  });

  it("treats equivalent UTC offsets as one round and reports the UTC instant", async () => {
    const digest = digestOf("offset");
    await put("TASK-001-a.json", { reviewedAt: "2026-09-02T17:04:36+02:00", digest });
    await put("TASK-001-b.json", { reviewedAt: "2026-09-02T15:04:36.000Z", digest });

    const report = await collectJudgeRounds(tmp);

    expect(report.tasks[0].rounds).toHaveLength(1);
    expect(report.tasks[0].rounds[0].reviewedAt).toBe("2026-09-02T15:04:36.000Z");
  });

  it("does not merge records with the same digest at different instants", async () => {
    const digest = digestOf("d");
    await put("TASK-001-a.json", { reviewedAt: "2026-08-01T10:00:00Z", digest });
    await put("TASK-001-b.json", { reviewedAt: "2026-08-01T10:00:01Z", digest });

    expect((await collectJudgeRounds(tmp)).tasks[0].rounds).toHaveLength(2);
  });

  it.each([
    ["verdict", { verdict: "NEEDS_CHANGES" }, {}],
    ["independence", { independent: true }, {}],
    ["independence (false against absent)", { independent: false }, {}],
    [
      "criterion statuses",
      { criteria: [{ id: "AC-1", status: "fail", evidence: "x" }] },
      { criteria: [{ id: "AC-1", status: "pass", evidence: "x" }] },
    ],
  ])("marks one ambiguous round when copies disagree on %s", async (_label, left, right) => {
    const key = { reviewedAt: "2026-08-01T10:00:00Z", digest: digestOf("conflict") };
    await put("TASK-001-left.json", { ...key, ...left });
    await put("TASK-001-right.json", { ...key, ...right });

    const report = await collectJudgeRounds(tmp);

    expect(report.tasks[0].rounds).toHaveLength(1);
    expect(report.tasks[0].rounds[0].ambiguous).toBe(true);
    const files = [`${JUDGE_DIR}/TASK-001-left.json`, `${JUDGE_DIR}/TASK-001-right.json`];
    expect(report.unknown).toContainEqual({ taskId: "TASK-001", files, reason: expect.stringContaining("conflict") });
  });

  it("sets verdict to null and independence to null when copies conflict", async () => {
    const key = { reviewedAt: "2026-08-01T10:00:00Z", digest: digestOf("nulls") };
    await put("TASK-001-a.json", { ...key, verdict: "APPROVED", independent: true });
    await put("TASK-001-b.json", { ...key, verdict: "BLOCKED", independent: false });

    const round = (await collectJudgeRounds(tmp)).tasks[0].rounds[0];

    expect(round.verdict).toBeNull();
    expect(round.independent).toBeNull();
  });

  it("does not treat evidence wording differences as a conflict", async () => {
    const key = { reviewedAt: "2026-08-01T10:00:00Z", digest: digestOf("wording") };
    await put("TASK-001-a.json", { ...key, criteria: [{ id: "AC-1", status: "pass", evidence: "one" }] });
    await put("TASK-001-b.json", { ...key, criteria: [{ id: "AC-1", status: "pass", evidence: "another" }] });

    const round = (await collectJudgeRounds(tmp)).tasks[0].rounds[0];

    expect(round.ambiguous).toBe(false);
  });

  it("reports no criterion-status conflict when one copy lacks criteria, and still reports a conflict when copies supply different criteria", async () => {
    const key = { reviewedAt: "2026-08-01T10:00:00Z", digest: digestOf("missing-criteria") };
    await put("TASK-001-with.json", { ...key, criteria: [{ id: "AC-1", status: "pass", evidence: "ok" }] });
    await put("TASK-001-without.json", key);

    const noConflict = await collectJudgeRounds(tmp);
    expect(noConflict.tasks[0].rounds[0].ambiguous).toBe(false);
    expect(noConflict.unknown.filter((entry) => entry.reason.includes("criterion statuses"))).toEqual([]);

    const conflictKey = { reviewedAt: "2026-08-02T10:00:00Z", digest: digestOf("conflicting-criteria") };
    await put("TASK-001-pass.json", { ...conflictKey, criteria: [{ id: "AC-1", status: "pass", evidence: "ok" }] });
    await put("TASK-001-fail.json", { ...conflictKey, criteria: [{ id: "AC-1", status: "fail", evidence: "no" }] });
    await put("TASK-001-legacy.json", conflictKey);

    const withConflict = await collectJudgeRounds(tmp);
    const secondRound = withConflict.tasks[0].rounds[1];
    expect(secondRound.ambiguous).toBe(true);
    expect(withConflict.unknown.some((entry) => entry.reason.includes("criterion statuses"))).toBe(true);
  });

  it("reports declared independence as true, false or null", async () => {
    await put("TASK-001-a.json", { reviewedAt: "2026-08-01T10:00:00Z", digest: digestOf("a"), independent: true });
    await put("TASK-001-b.json", { reviewedAt: "2026-08-02T10:00:00Z", digest: digestOf("b"), independent: false });
    await put("TASK-001-c.json", { reviewedAt: "2026-08-03T10:00:00Z", digest: digestOf("c") });

    const rounds = (await collectJudgeRounds(tmp)).tasks[0].rounds;

    expect(rounds.map((round) => round.independent)).toEqual([true, false, null]);
  });

  it.each([
    ["missing reviewedAt", { reviewedAt: undefined, digest: digestOf("k") }, "reviewedAt"],
    ["unparseable reviewedAt", { reviewedAt: "yesterday", digest: digestOf("k") }, "reviewedAt"],
    ["reviewedAt without an offset", { reviewedAt: "2026-08-01T10:00:00", digest: digestOf("k") }, "reviewedAt"],
    ["missing scopeDigest", { reviewedAt: "2026-08-01T10:00:00Z", digest: null }, "scopeDigest"],
    ["malformed scopeDigest", { reviewedAt: "2026-08-01T10:00:00Z", digest: "sha256:abc" }, "scopeDigest"],
  ])("puts a record with %s in unknown, uncounted, and makes the task unknown", async (_label, input, field) => {
    await put("TASK-001-good.json", { reviewedAt: "2026-08-01T09:00:00Z", digest: digestOf("good") });
    const bad = await put("TASK-001-bad.json", input as FixtureRecord);

    const report = await collectJudgeRounds(tmp);

    expect(report.tasks[0].rounds).toHaveLength(1);
    expect(report.tasks[0].state).toBe("unknown");
    expect(report.unknown).toContainEqual({ taskId: "TASK-001", files: [bad], reason: expect.stringContaining(field) });
    expect(report.closed.taskCount + report.open.taskCount).toBe(0);
    expect(report.skipped).toEqual([]);
  });

  it("sorts rounds by UTC instant with scopeDigest as the display tie-breaker", async () => {
    const early = "2026-08-01T10:00:00Z";
    await put("TASK-001-late.json", { reviewedAt: "2026-08-02T10:00:00Z", digest: digestOf("late") });
    await put("TASK-001-z.json", { reviewedAt: early, digest: `sha256:${"b".repeat(64)}` });
    await put("TASK-001-a.json", { reviewedAt: early, digest: `sha256:${"a".repeat(64)}` });

    const rounds = (await collectJudgeRounds(tmp)).tasks[0].rounds;

    expect(rounds.map((round) => round.scopeDigest.slice(7, 8))).toEqual(["a", "b", digestOf("late").slice(7, 8)]);
  });

  it.each([
    ["APPROVED", "closed"],
    ["NEEDS_CHANGES", "open"],
    ["BLOCKED", "open"],
  ])("derives the task state from the latest round: %s is %s", async (verdict, state) => {
    await put("TASK-001-first.json", { reviewedAt: "2026-08-01T10:00:00Z", digest: digestOf("1"), verdict: "BLOCKED" });
    await put("TASK-001-last.json", { reviewedAt: "2026-08-02T10:00:00Z", digest: digestOf("2"), verdict });
    await put("TASK-001-zz.json", { reviewedAt: "2026-07-01T10:00:00Z", digest: digestOf("0"), verdict: "APPROVED" });

    expect((await collectJudgeRounds(tmp)).tasks[0].state).toBe(state);
  });

  it("makes the state unknown for conflicting verdicts at the latest instant", async () => {
    const at = "2026-08-02T10:00:00Z";
    await put("TASK-001-a.json", { reviewedAt: at, digest: digestOf("a"), verdict: "APPROVED" });
    await put("TASK-001-b.json", { reviewedAt: at, digest: digestOf("b"), verdict: "NEEDS_CHANGES" });

    const report = await collectJudgeRounds(tmp);

    expect(report.tasks[0].state).toBe("unknown");
    expect(report.unknown.some((entry) => entry.reason.includes("state"))).toBe(true);
  });

  it("keeps a state when rounds at the latest instant agree", async () => {
    const at = "2026-08-02T10:00:00Z";
    await put("TASK-001-a.json", { reviewedAt: at, digest: digestOf("a"), verdict: "APPROVED" });
    await put("TASK-001-b.json", { reviewedAt: at, digest: digestOf("b"), verdict: "APPROVED" });

    expect((await collectJudgeRounds(tmp)).tasks[0].state).toBe("closed");
  });

  it("makes the state unknown when the latest round is ambiguous", async () => {
    await put("TASK-001-old.json", { reviewedAt: "2026-08-01T10:00:00Z", digest: digestOf("old") });
    const key = { reviewedAt: "2026-08-02T10:00:00Z", digest: digestOf("new") };
    await put("TASK-001-x.json", { ...key, verdict: "APPROVED" });
    await put("TASK-001-y.json", { ...key, verdict: "NEEDS_CHANGES" });

    expect((await collectJudgeRounds(tmp)).tasks[0].state).toBe("unknown");
  });

  it("keeps an ambiguous earlier round from changing the state", async () => {
    const key = { reviewedAt: "2026-08-01T10:00:00Z", digest: digestOf("early") };
    await put("TASK-001-x.json", { ...key, verdict: "APPROVED" });
    await put("TASK-001-y.json", { ...key, verdict: "NEEDS_CHANGES" });
    await put("TASK-001-final.json", { reviewedAt: "2026-08-02T10:00:00Z", digest: digestOf("final") });

    const report = await collectJudgeRounds(tmp);

    expect(report.tasks[0].state).toBe("closed");
    expect(report.tasks[0].rounds[0].ambiguous).toBe(true);
  });

  it("aggregates closed and open separately, excluding unknown tasks, and nulls empty groups", async () => {
    const rounds = async (taskId: string, verdicts: string[]) => {
      for (const [index, verdict] of verdicts.entries()) {
        await put(`${taskId}-${index}.json`, {
          taskId,
          verdict,
          reviewedAt: `2026-08-0${index + 1}T10:00:00Z`,
          digest: digestOf(`${taskId}${index}`),
        });
      }
    };
    await rounds("TASK-001", ["NEEDS_CHANGES", "APPROVED"]);
    await rounds("TASK-002", ["APPROVED"]);
    await rounds("TASK-003", ["NEEDS_CHANGES", "NEEDS_CHANGES", "BLOCKED"]);
    await put("TASK-004-x.json", { taskId: "TASK-004", reviewedAt: undefined });

    const report = await collectJudgeRounds(tmp);

    expect(report.closed).toEqual({ taskCount: 2, roundCount: 3, mean: 1.5, max: 2 });
    expect(report.open).toEqual({ taskCount: 1, roundCount: 3, mean: 3, max: 3 });
    expect(report.tasks.map((task) => [task.taskId, task.state])).toEqual([
      ["TASK-001", "closed"],
      ["TASK-002", "closed"],
      ["TASK-003", "open"],
      ["TASK-004", "unknown"],
    ]);
  });

  it("reports empty groups with zero counts and null mean and max", async () => {
    await put("TASK-001-x.json", { verdict: "BLOCKED" });

    const report = await collectJudgeRounds(tmp);

    expect(report.closed).toEqual({ taskCount: 0, roundCount: 0, mean: null, max: null });
    expect(report.open).toEqual({ taskCount: 1, roundCount: 1, mean: 1, max: 1 });
  });

  it("reports an empty directory without inventing observations", async () => {
    const report = await collectJudgeRounds(tmp);

    expect(report).toEqual({
      tasks: [],
      closed: { taskCount: 0, roundCount: 0, mean: null, max: null },
      open: { taskCount: 0, roundCount: 0, mean: null, max: null },
      unknown: [],
      skipped: [],
    });
  });

  it("labels the category unknown without boundary metadata and still counts the round", async () => {
    await put("TASK-001-worktree.json", { candidate: "WORKTREE", digest: digestOf("w") });
    await put("TASK-001-snap.json", {
      reviewedAt: "2026-08-02T10:00:00Z",
      candidate: `SNAPSHOT:${"a".repeat(20)}`,
      digest: digestOf("s"),
    });

    const report = await collectJudgeRounds(tmp);

    expect(report.tasks[0].rounds.map((round) => round.category)).toEqual(["unknown", "unknown"]);
    expect(report.unknown.filter((entry) => entry.reason.includes("category"))).toHaveLength(2);
    expect(report.tasks[0].state).toBe("closed");
  });

  it("never infers the category from the filename", async () => {
    await put("TASK-001-catchup-approved.json", { candidate: "WORKTREE", digest: digestOf("cu") });

    expect((await collectJudgeRounds(tmp)).tasks[0].rounds[0].category).toBe("unknown");
  });

  it("classifies ordinary and catch-up rounds from snapshot metadata", async () => {
    const command = 'node -e "process.exit(0)"';
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const task = await runTask("Round accounting fixture", { cwd: tmp, nonInteractive: true });
    const taskFile = path.join(tmp, task.taskDir, "task.md");
    const original = await readFile(taskFile, "utf8");
    await writeFile(taskFile, original.replace("```\n```", `\`\`\`\n${command}\n\`\`\``), "utf8");
    await writeFile(path.join(tmp, "app.ts"), "export const value = 1;\n", "utf8");
    await execFileAsync("git", ["init"], { cwd: tmp });
    await execFileAsync("git", ["config", "user.email", "tests@example.com"], { cwd: tmp });
    await execFileAsync("git", ["config", "user.name", "wep tests"], { cwd: tmp });
    await execFileAsync("git", ["add", "."], { cwd: tmp });
    await execFileAsync("git", ["commit", "-m", "base"], { cwd: tmp });
    await writeFile(path.join(tmp, "app.ts"), "export const value = 2;\n", "utf8");

    const parent = await captureJudgeSnapshot(tmp, task.taskId, "HEAD");
    const declaration = await readAcceptanceCriteria(tmp, task.taskId);
    const parentRecord = path.join(tmp, JUDGE_DIR, "parent.json");
    await mkdir(path.dirname(parentRecord), { recursive: true });
    await writeFile(
      parentRecord,
      JSON.stringify({
        schemaVersion: JUDGE_SCHEMA_VERSION,
        taskId: task.taskId,
        scope: parent.scope,
        verdict: "APPROVED",
        tests: [{ command, status: "passed" }],
        criteria: declaration.ids.map((id) => ({ id, status: "pass", evidence: "Checked." })),
        observations: [],
        reviewedAt: "2026-08-01T10:00:00Z",
      }),
    );
    await writeFile(path.join(tmp, "app.ts"), "export const value = 3;\n", "utf8");
    const child = await captureJudgeCatchUpSnapshot(tmp, task.taskId, parentRecord, async () => true);
    await writeFile(
      path.join(tmp, JUDGE_DIR, "child.json"),
      JSON.stringify({
        schemaVersion: JUDGE_SCHEMA_VERSION,
        taskId: task.taskId,
        scope: child.scope,
        verdict: "APPROVED",
        tests: [],
        criteria: [],
        observations: [],
        reviewedAt: "2026-08-02T10:00:00Z",
      }),
    );

    const report = await collectJudgeRounds(tmp, task.taskId);

    expect(report.tasks[0].rounds.map((round) => round.category)).toEqual(["ordinary", "catch-up"]);
    expect(report.unknown.filter((entry) => entry.reason.includes("category"))).toEqual([]);
    expect(report.closed.roundCount).toBe(2);
  });

  it("applies the task filter before aggregation and keeps unattributable skipped files", async () => {
    await put("TASK-001-a.json", { taskId: "TASK-001", digest: digestOf("1") });
    await put("TASK-002-a.json", { taskId: "TASK-002", digest: digestOf("2"), verdict: "BLOCKED" });
    await put("TASK-002-bad.json", { taskId: "TASK-002", verdict: "MAYBE" });
    await put("TASK-003-gap.json", { taskId: "TASK-003", reviewedAt: undefined });
    await put("garbage.json", "nope");

    const report = await collectJudgeRounds(tmp, "TASK-002");

    expect(report.tasks.map((task) => task.taskId)).toEqual(["TASK-002"]);
    expect(report.closed.taskCount).toBe(0);
    expect(report.open.taskCount).toBe(1);
    expect(report.unknown.every((entry) => entry.taskId === "TASK-002" || entry.taskId === null)).toBe(true);
    expect(report.skipped.map((entry) => entry.file).sort()).toEqual([
      `${JUDGE_DIR}/TASK-002-bad.json`,
      `${JUDGE_DIR}/garbage.json`,
    ]);
  });

  it("rejects a malformed task filter", async () => {
    await expect(collectJudgeRounds(tmp, "task-1")).rejects.toThrow("TASK-");
  });

  it("sorts tasks, unknown entries and skipped entries deterministically", async () => {
    await put("TASK-010-a.json", { taskId: "TASK-010", digest: digestOf("10") });
    await put("TASK-002-a.json", { taskId: "TASK-002", digest: digestOf("2") });
    await put("z.json", "bad");
    await put("a.json", "bad");

    const report = await collectJudgeRounds(tmp);

    expect(report.tasks.map((task) => task.taskId)).toEqual(["TASK-002", "TASK-010"]);
    expect(report.skipped.map((entry) => entry.file)).toEqual([`${JUDGE_DIR}/a.json`, `${JUDGE_DIR}/z.json`]);
  });

  it("is strictly read-only", async () => {
    await put("TASK-001-a.json", { digest: digestOf("a") });
    await put("TASK-001-b.json", { digest: digestOf("a") });
    await put("TASK-002-gap.json", { taskId: "TASK-002", reviewedAt: undefined });
    await put("junk.json", "nope");
    await put("snapshots/x/snapshot.json", "{}");
    const before = await treeState();

    await collectJudgeRounds(tmp);
    await collectJudgeRounds(tmp, "TASK-001");
    renderJudgeRounds(await collectJudgeRounds(tmp));

    expect(await treeState()).toEqual(before);
  });

  it("emits JSON with exactly the contract's fields through the CLI", async () => {
    await put("TASK-001-a.json", { digest: digestOf("a"), independent: true });
    await put("TASK-002-a.json", { taskId: "TASK-002", digest: digestOf("b"), verdict: "BLOCKED" });
    await put("junk.json", "nope");

    const { stdout } = await execFileAsync("node", [cli, "judge", "rounds", "--json"], { cwd: tmp });
    const report = JSON.parse(stdout);

    expect(Object.keys(report).sort()).toEqual(["closed", "open", "skipped", "tasks", "unknown"]);
    expect(Object.keys(report.closed).sort()).toEqual(["max", "mean", "roundCount", "taskCount"]);
    expect(Object.keys(report.tasks[0]).sort()).toEqual(["rounds", "state", "taskId"]);
    expect(Object.keys(report.tasks[0].rounds[0]).sort()).toEqual([
      "ambiguous",
      "category",
      "files",
      "independent",
      "reviewedAt",
      "scopeDigest",
      "verdict",
    ]);
    expect(report).toEqual(await collectJudgeRounds(tmp));

    const filtered = JSON.parse(
      (await execFileAsync("node", [cli, "judge", "rounds", "TASK-002", "--json"], { cwd: tmp })).stdout,
    );
    expect(filtered.tasks.map((task: { taskId: string }) => task.taskId)).toEqual(["TASK-002"]);
  });

  it("renders every field and entry in human output, including empty collections", async () => {
    await put("TASK-001-a.json", { digest: digestOf("a"), independent: true });
    await put("TASK-001-b.json", { digest: digestOf("a"), independent: true });

    const report = await collectJudgeRounds(tmp);
    const text = renderJudgeRounds(report).join("\n");
    const round = report.tasks[0].rounds[0];

    for (const value of [
      "TASK-001",
      "closed",
      round.reviewedAt,
      round.scopeDigest,
      "APPROVED",
      "independent true",
      `category ${round.category}`,
      "round category unknown",
      ...round.files,
    ]) {
      expect(text).toContain(value);
    }
    expect(text).toMatch(/skipped \(0\):\n\s+none/);
    expect(text).toContain("open: taskCount 0, roundCount 0, mean null, max null");

    const human = (await execFileAsync("node", [cli, "judge", "rounds"], { cwd: tmp })).stdout;
    expect(human.trimEnd()).toBe(renderJudgeRounds(report).join("\n"));

    await rm(path.join(tmp, JUDGE_DIR), { recursive: true });
    const nothing = renderJudgeRounds(await collectJudgeRounds(tmp)).join("\n");
    expect(nothing).toMatch(/tasks \(0\):\n\s+none/);
    expect(nothing).toMatch(/unknown \(0\):\n\s+none/);
    expect(nothing).toMatch(/skipped \(0\):\n\s+none/);
  });
});
