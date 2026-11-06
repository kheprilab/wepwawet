import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pathExists } from "../src/fs-utils.js";
import { runInit } from "../src/init.js";
import {
  JUDGE_SCHEMA_VERSION,
  createJudgeScope,
  readValidationDeclaration,
  validateRecord,
  verifyJudgeRecord,
} from "../src/judge-enforcement.js";
import { captureJudgeSnapshot } from "../src/judge-snapshot.js";
import { runTask } from "../src/task.js";
import {
  captureValidationError,
  normalizeValidationCommand,
  redactValidationOutput,
  sanitizeValidationCommand,
} from "../src/validation-evidence.js";

import {
  createApprovableSnapshotFixture,
  createReviewFixture,
  declareValidation,
  passingCriteria,
} from "./helpers/judge-fixtures.js";
import { execFileAsync, tmp, useTempDir } from "./helpers/wep.js";

useTempDir();

describe("judge", () => {
  it("normalizes validation commands and preserves bounded redacted failure evidence", () => {
    expect(normalizeValidationCommand("  pnpm   test\n --runInBand  ")).toBe("pnpm test --runInBand");
    const output = redactValidationOutput(`token=super-secret\n${"x".repeat(20)}`, 32);
    expect(output).toContain("token=[REDACTED]");
    expect(output).not.toContain("super-secret");
    expect(output).toContain("[truncated]");
  });

  it("keeps observations separate from optional inferred or confirmed causes", () => {
    const evidence = captureValidationError("pnpm test", {
      code: 137,
      signal: null,
      stdout: "stdout line",
      stderr: "stderr line",
    });

    expect(evidence).toMatchObject({
      command: "pnpm test",
      status: "failed",
      exitCode: 137,
      signal: null,
    });
    expect(evidence.output).toContain("stderr line");

    expect(captureValidationError("pnpm test", { signal: "SIGTERM" })).toMatchObject({
      exitCode: null,
      signal: "SIGTERM",
      output: "[no diagnostic output]",
    });
  });

  it("redacts and bounds the current failure evidence at capture time", () => {
    const evidence = captureValidationError("pnpm test", {
      code: 1,
      stderr: `TOKEN=do-not-persist\n${"x".repeat(10_000)} https://private.example/secret`,
    });
    expect(evidence.output).toContain("TOKEN=[REDACTED]");
    expect(evidence.output).not.toContain("do-not-persist");
    expect(evidence.output).not.toContain("private.example");
    expect(evidence.output).toContain("[truncated]");
    expect(evidence).not.toHaveProperty("diagnosis");
  });

  it("redacts prefixed and compound secret variable names", () => {
    const output = redactValidationOutput(
      'NPM_TOKEN=npm-secret AWS_SECRET_ACCESS_KEY="aws secret" PRIVATE_KEY=private --api-key "cli secret"',
    );
    expect(output).toContain("NPM_TOKEN=[REDACTED]");
    expect(output).toContain("AWS_SECRET_ACCESS_KEY=[REDACTED]");
    expect(output).toContain("PRIVATE_KEY=[REDACTED]");
    expect(output).toContain("--api-key [REDACTED]");
    expect(output).not.toContain("npm-secret");
    expect(output).not.toContain("aws secret");
    expect(output).not.toContain("private");
    expect(output).not.toContain("cli secret");
  });

  it("redacts quoted secret-bearing keys in structured diagnostic output", () => {
    const output = redactValidationOutput(
      `{"AWS_SECRET_ACCESS_KEY":"json secret"}\n'api-key': 'yaml secret'\n"password" : unquoted-secret`,
    );

    expect(output).toContain('"AWS_SECRET_ACCESS_KEY":[REDACTED]');
    expect(output).toContain("'api-key': [REDACTED]");
    expect(output).toContain('"password" : [REDACTED]');
    expect(output).not.toContain("json secret");
    expect(output).not.toContain("yaml secret");
    expect(output).not.toContain("unquoted-secret");
  });

  it("redacts credentials embedded in a reported validation command", () => {
    const command = sanitizeValidationCommand(
      '  NPM_TOKEN="npm secret"   pnpm test --api-key cli-secret https://private.example/run  ',
    );
    expect(command).toBe("NPM_TOKEN=[REDACTED] pnpm test --api-key [REDACTED] [URL REDACTED]");
    expect(captureValidationError('AWS_SECRET_ACCESS_KEY="aws secret" pnpm test', { code: 1 }).command).toBe(
      "AWS_SECRET_ACCESS_KEY=[REDACTED] pnpm test",
    );
  });

  describe("readValidationDeclaration", () => {
    it("recognizes a `# optional` suffix and strips it from the command", async () => {
      const task = await declareValidation("pnpm test\npnpm lint # optional");

      const declaration = await readValidationDeclaration(tmp, task.taskId);

      expect(declaration.checks).toEqual([
        { command: "pnpm test", required: true },
        { command: "pnpm lint", required: false },
      ]);
      expect(declaration.commands).toEqual(["pnpm test", "pnpm lint"]);
    });

    it("recognizes optional-marker spacing and casing variants", async () => {
      const task = await declareValidation("pnpm a #optional\npnpm b # OPTIONAL\npnpm c #   Optional");

      const declaration = await readValidationDeclaration(tmp, task.taskId);

      expect(declaration.checks).toEqual([
        { command: "pnpm a", required: false },
        { command: "pnpm b", required: false },
        { command: "pnpm c", required: false },
      ]);
    });

    it("keeps the literal text of a line ending in an unrelated trailing comment", async () => {
      const task = await declareValidation("pnpm test # this checks the build");

      const declaration = await readValidationDeclaration(tmp, task.taskId);

      expect(declaration.checks).toEqual([{ command: "pnpm test # this checks the build", required: true }]);
    });

    it("reports `unknown` when the capsule predates the Validation section", async () => {
      await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
      const task = await runTask("Legacy capsule", { cwd: tmp, nonInteractive: true });
      const taskFile = path.join(tmp, task.taskDir, "task.md");
      const original = await readFile(taskFile, "utf8");
      await writeFile(taskFile, original.replace(/\n## Validation\n[\s\S]*?(?=\n## )/, "\n"), "utf8");

      const declaration = await readValidationDeclaration(tmp, task.taskId);

      expect(declaration.sectionPresent).toBe(false);
    });

    it("keeps an empty or malformed fence as an unfinished capsule, not documentation", async () => {
      const task = await declareValidation("");

      const declaration = await readValidationDeclaration(tmp, task.taskId);

      expect(declaration.sectionPresent).toBe(true);
      expect(declaration.kind).toBe("runtime");
      expect(declaration.checks).toEqual([]);
    });

    it("parses a lone `no-runtime-validation:` line as documentation", async () => {
      const task = await declareValidation("no-runtime-validation: investigation only, no code changed");

      const declaration = await readValidationDeclaration(tmp, task.taskId);

      expect(declaration.kind).toBe("documentation");
      expect(declaration.reason).toBe("investigation only, no code changed");
      expect(declaration.checks).toEqual([]);
      expect(declaration.commands).toEqual([]);
    });

    it("does not accept `no-runtime-validation:` without a reason", async () => {
      const task = await declareValidation("no-runtime-validation:");

      const declaration = await readValidationDeclaration(tmp, task.taskId);

      expect(declaration.kind).toBe("runtime");
    });

    it("does not accept `no-runtime-validation:` accompanied by other lines", async () => {
      const task = await declareValidation("no-runtime-validation: investigation only\npnpm test");

      const declaration = await readValidationDeclaration(tmp, task.taskId);

      expect(declaration.kind).toBe("runtime");
      expect(declaration.commands).toContain("pnpm test");
    });
  });

  it("cryptographically binds an approved review to its task and working-tree boundary", async () => {
    const { scope, recordPath } = await createReviewFixture();

    const result = await verifyJudgeRecord(tmp, recordPath);

    expect(result).toMatchObject({
      valid: true,
      approved: true,
      verdict: "APPROVED",
      scopeDigest: scope.scopeDigest,
      reasons: [],
      // TASK-078: a WORKTREE boundary always adds the clarification `comparison unavailable` notice.
      notices: [expect.stringContaining("comparison unavailable")],
      declaredCommands: ["pnpm test"],
      reexecuted: [],
    });
  });

  it("rejects a symbolic base in the review record contract", async () => {
    const { recordPath } = await createReviewFixture();
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    record.scope.base = "origin/main";

    expect(validateRecord(record)).toContain("scope does not match the judge scope contract.");
  });

  it("rejects an incomplete hexadecimal base hash", async () => {
    const { recordPath } = await createReviewFixture();
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    record.scope.base = `${record.scope.base}a`;

    expect(validateRecord(record)).toContain("scope does not match the judge scope contract.");
  });

  it("accepts a checklist finalized before capture without a post-judge administrative write", async () => {
    const checklist = "# Review Checklist\n\n- [x] The capsule is ready for independent review.\n";
    const { recordPath } = await createReviewFixture({ checklist });

    const result = await verifyJudgeRecord(tmp, recordPath);

    expect(result.approved).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("reports a non-independent review as a notice without changing approval", async () => {
    const { recordPath } = await createReviewFixture();
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    record.independent = false;
    await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");

    const result = await verifyJudgeRecord(tmp, recordPath);

    expect(result.valid).toBe(true);
    expect(result.approved).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.notices.some((n) => n.includes("non-independent") && n.includes("verification-only"))).toBe(true);
    expect(result.historicalVerdict.independence).toBe("declared-false");
  });

  it("reports historicalVerdict.independence as unknown when independent is absent", async () => {
    const { recordPath } = await createReviewFixture();

    const result = await verifyJudgeRecord(tmp, recordPath);

    expect(result.historicalVerdict.independence).toBe("unknown");
    expect(result.historicalVerdict.value).toBe("APPROVED");
  });

  it("rejects a non-boolean independent field", async () => {
    const { recordPath } = await createReviewFixture();
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    record.independent = "false";
    await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");

    const result = await verifyJudgeRecord(tmp, recordPath);

    expect(result.valid).toBe(false);
    expect(result.approved).toBe(false);
    expect(result.reasons.some((r) => r.includes("independent must be a boolean"))).toBe(true);
  });

  it("reports unresolved open questions as a notice without blocking approval", async () => {
    const { recordPath, task } = await createReviewFixture();
    const taskFile = path.join(tmp, task.taskDir, "task.md");
    const original = await readFile(taskFile, "utf8");
    // Replace the section in place. Appending a second `## Open Questions` would be shadowed
    // by the generated one, which still holds the placeholder.
    const filled = original.replace(
      /\n## Open Questions\n[\s\S]*$/,
      "\n## Open Questions\n\n- Whether legacy invoices are in scope.\n",
    );
    expect(filled).not.toBe(original);
    await writeFile(taskFile, filled, "utf8");
    // The capsule is part of the reviewed boundary, so re-anchor the record to the edited tree;
    // otherwise this would assert a digest failure rather than the notice.
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    record.scope = await createJudgeScope(tmp, task.taskId, "HEAD", "WORKTREE");
    await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");

    const result = await verifyJudgeRecord(tmp, recordPath);

    // A judgement, not a mechanical check: it is surfaced, and it never moves the exit code.
    expect(result.notices).toEqual([
      "The task capsule lists 1 unresolved open question; confirm it would not have changed the implementation.",
      // TASK-078: a WORKTREE boundary always adds the clarification `comparison unavailable` notice.
      expect.stringContaining("comparison unavailable"),
    ]);
    expect(result.reasons).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.approved).toBe(true);
  });

  it("invalidates an approved review when code changes", async () => {
    const { recordPath } = await createReviewFixture();
    await writeFile(path.join(tmp, "app.ts"), "export const value = 3;\n", "utf8");

    const result = await verifyJudgeRecord(tmp, recordPath);

    expect(result.approved).toBe(false);
    expect(result.reasons).toContain("scope.changeDigest no longer matches the repository.");
  });

  it("invalidates an approved review when an untracked file appears", async () => {
    const { recordPath } = await createReviewFixture();
    await writeFile(path.join(tmp, "new-module.ts"), "export const added = true;\n", "utf8");

    const result = await verifyJudgeRecord(tmp, recordPath);

    expect(result.approved).toBe(false);
    expect(result.reasons).toContain("scope.changeDigest no longer matches the repository.");
  });

  it("withholds untracked files blocked by policy from the boundary", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const task = await runTask("Protect judge scope", { cwd: tmp, nonInteractive: true });
    await execFileAsync("git", ["init"], { cwd: tmp });
    await execFileAsync("git", ["config", "user.email", "tests@example.com"], { cwd: tmp });
    await execFileAsync("git", ["config", "user.name", "wep tests"], { cwd: tmp });
    await execFileAsync("git", ["add", "."], { cwd: tmp });
    await execFileAsync("git", ["commit", "-m", "base"], { cwd: tmp });
    await writeFile(path.join(tmp, ".env"), "SECRET=not-read\n", "utf8");

    const scope = await createJudgeScope(tmp, task.taskId, "HEAD", "WORKTREE");

    expect(scope.excludedPaths).toContain(".env");
    expect(scope.changedFiles).not.toContain(".env");
  });

  it("withholds tracked files blocked by policy from the diff and the digest", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const task = await runTask("Protect tracked secrets", { cwd: tmp, nonInteractive: true });
    await writeFile(path.join(tmp, ".env"), "SECRET=base\n", "utf8");
    await writeFile(path.join(tmp, "app.ts"), "export const value = 1;\n", "utf8");
    await execFileAsync("git", ["init"], { cwd: tmp });
    await execFileAsync("git", ["config", "user.email", "tests@example.com"], { cwd: tmp });
    await execFileAsync("git", ["config", "user.name", "wep tests"], { cwd: tmp });
    await execFileAsync("git", ["add", "-f", "."], { cwd: tmp });
    await execFileAsync("git", ["commit", "-m", "base"], { cwd: tmp });
    await writeFile(path.join(tmp, ".env"), "SECRET=rotated-in-boundary\n", "utf8");
    await writeFile(path.join(tmp, "app.ts"), "export const value = 2;\n", "utf8");

    const scope = await createJudgeScope(tmp, task.taskId, "HEAD", "WORKTREE");
    const withSecretOnly = await (async () => {
      await writeFile(path.join(tmp, ".env"), "SECRET=rotated-again\n", "utf8");
      return createJudgeScope(tmp, task.taskId, "HEAD", "WORKTREE");
    })();

    expect(scope.excludedPaths).toContain(".env");
    expect(scope.changedFiles).toEqual(["app.ts"]);
    // The secret's content never enters the digest, so rotating it again does not move it.
    expect(withSecretOnly.changeDigest).toBe(scope.changeDigest);
  });

  it("refuses to compute a boundary when policy.json cannot supply blocked patterns", async () => {
    const { task } = await createReviewFixture();
    const policyPath = path.join(tmp, ".wep/policy.json");
    const policy = JSON.parse(await readFile(policyPath, "utf8"));
    policy.blockedReadPatterns = "not-an-array";
    await writeFile(policyPath, JSON.stringify(policy, null, 2), "utf8");

    // Falling back to a default pattern set here would silently reduce the exclusion this
    // feature promises, so an unusable policy has to stop the scope instead.
    await expect(createJudgeScope(tmp, task.taskId, "HEAD", "WORKTREE")).rejects.toThrow(
      "blockedReadPatterns is missing or not an array",
    );
  });

  it("refuses to compute a boundary when policy.json is malformed", async () => {
    const { task } = await createReviewFixture();
    await writeFile(path.join(tmp, ".wep/policy.json"), "{ not json", "utf8");

    await expect(createJudgeScope(tmp, task.taskId, "HEAD", "WORKTREE")).rejects.toThrow(
      "Cannot apply policy.json blockedReadPatterns",
    );
  });

  it("invalidates an approved review when a blocked path enters the boundary", async () => {
    const { recordPath } = await createReviewFixture();
    await writeFile(path.join(tmp, ".env"), "SECRET=appeared\n", "utf8");

    const result = await verifyJudgeRecord(tmp, recordPath);

    expect(result.approved).toBe(false);
    expect(result.reasons).toContain("scope.excludedPaths no longer matches the repository.");
  });

  it("invalidates an approved review when the task capsule changes", async () => {
    const { task, recordPath } = await createReviewFixture();
    await writeFile(path.join(tmp, task.taskDir, "task.md"), "# Changed goal\n", "utf8");

    const result = await verifyJudgeRecord(tmp, recordPath);

    expect(result.approved).toBe(false);
    expect(result.reasons).toContain("scope.taskDigest no longer matches the repository.");
  });

  it("keeps taskDigest sensitive to a real review-checklist change", async () => {
    const { task, recordPath } = await createReviewFixture();
    await writeFile(
      path.join(tmp, task.taskDir, "review-checklist.md"),
      "# Review Checklist\n\n- [x] changed\n",
      "utf8",
    );

    const result = await verifyJudgeRecord(tmp, recordPath);

    expect(result.approved).toBe(false);
    expect(result.reasons).toContain("scope.taskDigest no longer matches the repository.");
  });

  it("rejects a current review whose verdict is not APPROVED", async () => {
    const { recordPath } = await createReviewFixture();
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    record.verdict = "NEEDS_CHANGES";
    await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");

    const result = await verifyJudgeRecord(tmp, recordPath);

    expect(result.valid).toBe(false);
    expect(result.reasons).toContain("Judge verdict is NEEDS_CHANGES, not APPROVED.");
  });

  it("rejects APPROVED when the judge record contains a failed validation", async () => {
    const { recordPath } = await createReviewFixture();
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    record.tests[0].status = "failed";
    await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");

    const result = await verifyJudgeRecord(tmp, recordPath);

    expect(result.approved).toBe(false);
    expect(result.reasons.some((reason) => reason.startsWith("Judge record contains failed validation:"))).toBe(true);
  });

  it("names every blocking failure in one reason instead of repeating a command-less line", async () => {
    const { recordPath } = await createReviewFixture({ declares: ["pnpm test"], claims: ["pnpm test"] });
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    record.tests.push({ command: "echo a", status: "failed" }, { command: "echo b", status: "failed" });
    await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");

    const result = await verifyJudgeRecord(tmp, recordPath);

    expect(result.approved).toBe(false);
    expect(result.reasons.filter((reason) => reason.startsWith("Judge record contains failed validation"))).toEqual([
      "Judge record contains failed validation: echo a, echo b.",
    ]);
  });

  it("rejects APPROVED when no validation command was executed", async () => {
    const { recordPath } = await createReviewFixture();
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    record.tests = [];
    await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");

    const result = await verifyJudgeRecord(tmp, recordPath);

    expect(result.approved).toBe(false);
    expect(result.reasons).toContain("APPROVED requires at least one validation command that passed.");
  });

  it("rejects APPROVED when every validation command was left not-run", async () => {
    const { recordPath } = await createReviewFixture();
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    record.tests = [
      { command: "pnpm test", status: "not-run", evidence: "sandbox is read-only" },
      { command: "pnpm lint", status: "not-run" },
    ];
    await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");

    const result = await verifyJudgeRecord(tmp, recordPath);

    expect(result.approved).toBe(false);
    expect(result.reasons).toContain("APPROVED requires at least one validation command that passed.");
  });

  it("rejects APPROVED backed only by a command the task capsule never declared", async () => {
    const { recordPath } = await createReviewFixture({ declares: ["pnpm test", "pnpm lint"], claims: ["echo ok"] });

    const result = await verifyJudgeRecord(tmp, recordPath);

    expect(result.approved).toBe(false);
    expect(result.declaredCommands).toEqual(["pnpm test", "pnpm lint"]);
    expect(result.reasons).toContain(
      "APPROVED requires every command the task capsule declares as required to pass; these did not: pnpm test, pnpm lint.",
    );
  });

  it("rejects APPROVED backed only by an invented command when every declared command is optional", async () => {
    const { recordPath } = await createReviewFixture({
      declares: ["pnpm test # optional", "pnpm lint # optional"],
      claims: ["echo unrelated"],
    });

    const result = await verifyJudgeRecord(tmp, recordPath);

    expect(result.approved).toBe(false);
    expect(result.reasons).toContain(
      "APPROVED requires a passing run of a command the task capsule declares: pnpm test, pnpm lint.",
    );
  });

  it("rejects APPROVED when a required declared command was not claimed as passing", async () => {
    const { recordPath } = await createReviewFixture({
      declares: ["pnpm test", "pnpm lint"],
      claims: ["pnpm lint", "echo extra-context"],
    });

    const result = await verifyJudgeRecord(tmp, recordPath);

    expect(result.approved).toBe(false);
    expect(result.reasons).toContain(
      "APPROVED requires every command the task capsule declares as required to pass; these did not: pnpm test.",
    );
  });

  it("accepts APPROVED when every required declared command passed", async () => {
    const { recordPath } = await createReviewFixture({
      declares: ["pnpm test", "pnpm lint"],
      claims: ["pnpm test", "pnpm lint", "echo extra-context"],
    });

    const result = await verifyJudgeRecord(tmp, recordPath);

    expect(result.reasons).toEqual([]);
    expect(result.approved).toBe(true);
  });

  it("names every missing required command when several are absent from tests", async () => {
    const { recordPath } = await createReviewFixture({
      declares: ["pnpm test", "pnpm lint", "pnpm build"],
      claims: ["pnpm build"],
    });

    const result = await verifyJudgeRecord(tmp, recordPath);

    expect(result.approved).toBe(false);
    expect(result.reasons).toContain(
      "APPROVED requires every command the task capsule declares as required to pass; these did not: pnpm test, pnpm lint.",
    );
  });

  it("treats a `# optional` suffixed command as non-blocking when it never passed", async () => {
    const { recordPath } = await createReviewFixture({
      declares: ["pnpm test", "pnpm lint # optional"],
      claims: ["pnpm test"],
    });

    const result = await verifyJudgeRecord(tmp, recordPath);

    expect(result.reasons).toEqual([]);
    expect(result.approved).toBe(true);
  });

  it("reports a failed optional command as a notice, not a reason, and stays approved", async () => {
    const { recordPath } = await createReviewFixture({
      declares: ["pnpm test", "pnpm lint # optional"],
      claims: ["pnpm test"],
    });
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    record.tests.push({ command: "pnpm lint", status: "failed" });
    await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");

    const result = await verifyJudgeRecord(tmp, recordPath);

    expect(result.approved).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.notices).toContain("Optional command `pnpm lint` failed; it does not block approval.");
  });

  it("still rejects a failed command that was never declared", async () => {
    const { recordPath } = await createReviewFixture({
      declares: ["pnpm test"],
      claims: ["pnpm test"],
    });
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    record.tests.push({ command: "pnpm lint", status: "failed" });
    await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");

    const result = await verifyJudgeRecord(tmp, recordPath);

    expect(result.approved).toBe(false);
    expect(result.reasons).toContain("Judge record contains failed validation: pnpm lint.");
  });

  it("leaves the declared-command rule dormant for a capsule predating the Validation section", async () => {
    const { recordPath } = await createReviewFixture({ legacyCapsule: true, claims: ["cargo test"] });

    const result = await verifyJudgeRecord(tmp, recordPath);

    expect(result.declaredCommands).toEqual([]);
    expect(result.approved).toBe(true);
    expect(result.verifiedNow.value).toBe("unknown");
  });

  it("reports verifiedNow as not-applicable-to-runtime for a documentation-only capsule", async () => {
    const { recordPath } = await createReviewFixture({
      declares: ["no-runtime-validation: investigation only, no code changed"],
      claims: [],
    });

    const result = await verifyJudgeRecord(tmp, recordPath);

    expect(result.approved).toBe(true);
    expect(result.verifiedNow.value).toBe("not-applicable-to-runtime");
  });

  it("reports verifiedNow as complete when every required command passed and the boundary is current", async () => {
    const { recordPath } = await createReviewFixture({
      declares: ["pnpm test"],
      claims: ["pnpm test"],
    });

    const result = await verifyJudgeRecord(tmp, recordPath);

    expect(result.verifiedNow.value).toBe("complete");
    expect(result.verifiedNow.reviewBoundary).toBeNull();
    expect(result.verifiedNow.executionMetadata).toBeNull();
  });

  it("reports verifiedNow as incomplete when a required command did not pass", async () => {
    const { recordPath } = await createReviewFixture({
      declares: ["pnpm test", "pnpm lint"],
      claims: ["pnpm lint"],
    });

    const result = await verifyJudgeRecord(tmp, recordPath);

    expect(result.verifiedNow.value).toBe("incomplete");
    expect(result.verifiedNow.reason.length).toBeGreaterThan(0);
  });

  it("rejects APPROVED when a current capsule left its Validation block empty", async () => {
    // Distinct from a legacy capsule: the section exists, so the commands were meant to be filled in.
    const { recordPath } = await createReviewFixture({ declares: [], claims: ["pnpm test"] });

    const result = await verifyJudgeRecord(tmp, recordPath);

    expect(result.approved).toBe(false);
    expect(result.reasons).toContain(
      "The task capsule has an empty or malformed `## Validation` block; declare the commands.",
    );
  });

  it("--run-tests re-executes declared commands and rejects a false passing claim", async () => {
    const failing = 'node -e "process.exit(1)"';
    const { recordPath } = await createApprovableSnapshotFixture([failing]);

    const result = await verifyJudgeRecord(tmp, recordPath, { runTests: true, approve: async () => true });

    expect(result.approved).toBe(false);
    expect(result.reexecuted).toHaveLength(1);
    expect(result.reexecuted[0]).toMatchObject({ command: failing, passed: false });
    expect(result.reexecuted[0].evidence).toMatchObject({ status: "failed", exitCode: 1 });
    expect(result.reexecuted[0].evidence?.output).toContain("[no diagnostic output]");
    expect(result.reasons[0]).toContain(`Independent re-run of \`${failing}\` failed`);
  });

  it("--run-tests confirms an approval whose declared command really passes", async () => {
    const passing = 'node -e "process.exit(0)"';
    const { recordPath } = await createApprovableSnapshotFixture([passing]);

    const result = await verifyJudgeRecord(tmp, recordPath, { runTests: true, approve: async () => true });

    expect(result.approved).toBe(true);
    expect(result.reexecuted[0]).toMatchObject({ command: passing, passed: true });
  });

  it("--run-tests leaves the boundary intact for a non-mutating command", async () => {
    const passing = 'node -e "process.exit(0)"';
    const { recordPath } = await createApprovableSnapshotFixture([passing]);

    const result = await verifyJudgeRecord(tmp, recordPath, { runTests: true, approve: async () => true });

    expect(result.approved).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("--run-tests never executes a command that only the review record names", async () => {
    const sentinel = path.join(tmp, "must-not-run.txt");
    const injected = `node -e "require('fs').writeFileSync(${JSON.stringify(sentinel)}, 'ran')"`;
    const { task } = await createReviewFixture({ declares: ["pnpm test"], claims: [] });
    const snapshot = await captureJudgeSnapshot(tmp, task.taskId, "HEAD");
    const recordPath = path.join(tmp, ".wep/local/judge/injected-review.json");
    await writeFile(
      recordPath,
      `${JSON.stringify(
        {
          schemaVersion: JUDGE_SCHEMA_VERSION,
          taskId: task.taskId,
          scope: snapshot.scope,
          verdict: "APPROVED",
          tests: [{ command: injected, status: "passed" }],
          criteria: await passingCriteria(task.taskId),
          observations: [],
          reviewedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const result = await verifyJudgeRecord(tmp, recordPath, { runTests: true, approve: async () => true });

    expect(result.reexecuted).toEqual([]);
    expect(await pathExists(sentinel)).toBe(false);
    expect(result.approved).toBe(false);
  });

  it("--run-tests executes the declared commands once the injected approval resolves true", async () => {
    const command = 'node -e "process.exit(0)"';
    const { recordPath } = await createApprovableSnapshotFixture([command]);

    const result = await verifyJudgeRecord(tmp, recordPath, { runTests: true, approve: async () => true });

    expect(result.reexecuted[0]).toMatchObject({ command, passed: true });
    expect(result.approved).toBe(true);
  });

  it("--run-tests withholds every command when the injected approval resolves false", async () => {
    const sentinel = path.join(tmp, "denied-must-not-run.txt");
    const command = `node -e "require('fs').writeFileSync(${JSON.stringify(sentinel)}, 'ran')"`;
    const { recordPath } = await createApprovableSnapshotFixture([command]);

    const result = await verifyJudgeRecord(tmp, recordPath, { runTests: true, approve: async () => false });

    expect(result.reexecuted).toEqual([]);
    expect(await pathExists(sentinel)).toBe(false);
    expect(result.approved).toBe(false);
    expect(result.reasons).toContain(`Operator approval was not given for the declared commands: ${command}.`);
  });

  it("--run-tests refuses to execute when no approval callback is supplied at all", async () => {
    const sentinel = path.join(tmp, "unapproved-must-not-run.txt");
    const command = `node -e "require('fs').writeFileSync(${JSON.stringify(sentinel)}, 'ran')"`;
    const { recordPath } = await createApprovableSnapshotFixture([command]);

    const result = await verifyJudgeRecord(tmp, recordPath, { runTests: true });

    expect(result.reexecuted).toEqual([]);
    expect(await pathExists(sentinel)).toBe(false);
    expect(result.approved).toBe(false);
    expect(result.reasons).toContain(`Operator approval was not given for the declared commands: ${command}.`);
  });

  it("--run-tests asks for approval exactly once, with the declared commands in parse order", async () => {
    const first = 'node -e "process.exit(0)"';
    const second = 'node -e "process.exitCode = 0"';
    const { recordPath } = await createApprovableSnapshotFixture([first, second]);
    const asked: string[][] = [];

    await verifyJudgeRecord(tmp, recordPath, {
      runTests: true,
      approve: async (commands) => {
        asked.push(commands);
        return true;
      },
    });

    expect(asked).toEqual([[first, second]]);
  });
});
