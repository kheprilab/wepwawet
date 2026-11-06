import { mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runInit } from "../src/init.js";
import {
  JUDGE_SCHEMA_VERSION,
  createJudgeScope,
  readAcceptanceCriteria,
  verifyJudgeRecord,
} from "../src/judge-enforcement.js";
import { captureJudgeSnapshot } from "../src/judge-snapshot.js";
import { runJudgeEnable } from "../src/judge.js";
import { migrateAcceptanceCriteriaIdentifiers, runTask } from "../src/task.js";
import { taskTemplateFiles } from "../src/templates.js";
import { runUpgrade } from "../src/upgrade.js";

import { execFileAsync, tmp, useTempDir } from "./helpers/wep.js";

useTempDir();

describe("acceptance criterion identifiers", () => {
  async function capsule(criteria: string): Promise<{ taskId: string; taskDir: string }> {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const task = await runTask("Report per-criterion results", { cwd: tmp, nonInteractive: true });
    await writeFile(path.join(tmp, task.taskDir, "acceptance-criteria.md"), criteria, "utf8");
    return task;
  }

  it("reads identifiers in declared order and joins wrapped continuation lines", async () => {
    const task = await capsule(
      "# Acceptance Criteria\n\n- AC-1: The parser reads an identifier.\n- AC-2: The parser joins\n  a wrapped line.\n",
    );

    const declaration = await readAcceptanceCriteria(tmp, task.taskId);

    expect(declaration.filePresent).toBe(true);
    expect(declaration.ids).toEqual(["AC-1", "AC-2"]);
    expect(declaration.problems).toEqual([]);
    expect(declaration.criteria[1].text).toBe("AC-2: The parser joins a wrapped line.");
  });

  it("names the offending line when a criterion carries no identifier", async () => {
    const task = await capsule("# Acceptance Criteria\n\n- AC-1: Identified.\n- Not identified at all.\n");

    const declaration = await readAcceptanceCriteria(tmp, task.taskId);

    expect(declaration.ids).toEqual(["AC-1"]);
    expect(declaration.problems).toHaveLength(1);
    expect(declaration.problems[0]).toContain("line 4");
    expect(declaration.problems[0]).toContain("Not identified at all.");
  });

  it("names the offending line when an identifier repeats", async () => {
    const task = await capsule("# Acceptance Criteria\n\n- AC-1: First.\n- AC-1: Second.\n");

    const declaration = await readAcceptanceCriteria(tmp, task.taskId);

    expect(declaration.problems).toHaveLength(1);
    expect(declaration.problems[0]).toContain("line 4");
    expect(declaration.problems[0]).toContain("AC-1");
  });

  it("creates capsules whose criteria already carry identifiers", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const task = await runTask("Ship identified criteria", { cwd: tmp, nonInteractive: true });

    const declaration = await readAcceptanceCriteria(tmp, task.taskId);

    expect(declaration.problems).toEqual([]);
    expect(declaration.ids.length).toBeGreaterThan(0);
    const template = await readFile(path.join(tmp, ".wep/tasks/_template/acceptance-criteria.md"), "utf8");
    for (const line of template.split("\n").filter((line) => line.startsWith("- "))) {
      expect(line).toMatch(/^- AC-[1-9][0-9]*: /);
    }
  });
});

describe("task migrate-criteria", () => {
  async function legacyCapsule(criteria: string): Promise<{ taskId: string; taskDir: string }> {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const task = await runTask("Migrate my criteria", { cwd: tmp, nonInteractive: true });
    await writeFile(path.join(tmp, task.taskDir, "acceptance-criteria.md"), criteria, "utf8");
    return task;
  }

  it("adds identifiers to every top-level bullet and leaves continuation lines alone", async () => {
    const task = await legacyCapsule(
      "# Acceptance Criteria\n\n- First criterion.\n- Second criterion\n  continues here.\n\nClosing prose.\n",
    );

    const results = await migrateAcceptanceCriteriaIdentifiers(tmp, { taskId: task.taskId });

    expect(results).toEqual([
      { taskId: task.taskId, file: `${task.taskDir}/acceptance-criteria.md`, changed: true, criteria: 2 },
    ]);
    expect(await readFile(path.join(tmp, task.taskDir, "acceptance-criteria.md"), "utf8")).toBe(
      "# Acceptance Criteria\n\n- AC-1: First criterion.\n- AC-2: Second criterion\n  continues here.\n\nClosing prose.\n",
    );
  });

  it("is idempotent and reports no change for an already migrated capsule", async () => {
    const task = await legacyCapsule("# Acceptance Criteria\n\n- One.\n- Two.\n");

    await migrateAcceptanceCriteriaIdentifiers(tmp, { taskId: task.taskId });
    const second = await migrateAcceptanceCriteriaIdentifiers(tmp, { taskId: task.taskId });

    expect(second[0].changed).toBe(false);
    expect(await readFile(path.join(tmp, task.taskDir, "acceptance-criteria.md"), "utf8")).toBe(
      "# Acceptance Criteria\n\n- AC-1: One.\n- AC-2: Two.\n",
    );
  });

  it("rejects duplicate identifiers instead of silently repointing an existing review", async () => {
    const task = await legacyCapsule("# Acceptance Criteria\n\n- AC-1: One.\n- AC-1: Two.\n- Three.\n");

    // Unconditional renumbering was a bug: it changed the identity of the second criterion.
    const results = await migrateAcceptanceCriteriaIdentifiers(tmp, { taskId: task.taskId });

    expect(results[0].changed).toBe(false);
    expect(results[0].problems?.[0]).toContain("line 4");
    expect(await readFile(path.join(tmp, task.taskDir, "acceptance-criteria.md"), "utf8")).toBe(
      "# Acceptance Criteria\n\n- AC-1: One.\n- AC-1: Two.\n- Three.\n",
    );
  });

  it("writes nothing with --dry-run and migrates every capsule when no task is named", async () => {
    const task = await legacyCapsule("# Acceptance Criteria\n\n- Only one.\n");
    const original = await readFile(path.join(tmp, task.taskDir, "acceptance-criteria.md"), "utf8");

    const planned = await migrateAcceptanceCriteriaIdentifiers(tmp, { dryRun: true });

    expect(planned).toHaveLength(1);
    expect(planned[0].changed).toBe(true);
    expect(await readFile(path.join(tmp, task.taskDir, "acceptance-criteria.md"), "utf8")).toBe(original);
  });
});

describe("TASK-081 checklist claim classes", () => {
  const shipped = () => taskTemplateFiles["tasks/_template/review-checklist.md"];

  async function generated(): Promise<string> {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const task = await runTask("Classify checklist claims", { cwd: tmp, nonInteractive: true });
    return readFile(path.join(tmp, task.taskDir, "review-checklist.md"), "utf8");
  }

  function sectionOf(markdown: string, heading: string): string {
    const parts = markdown.split(/^## /m).slice(1);
    return parts.find((part) => part.startsWith(`${heading}\n`)) ?? "";
  }

  it("separates Evidence References from Process Attestations in both producers", async () => {
    for (const checklist of [shipped(), await generated()]) {
      expect(checklist).toContain("\n## Evidence References\n");
      expect(checklist).toContain("\n## Process Attestations\n");
      expect(checklist.indexOf("## Evidence References")).toBeLessThan(checklist.indexOf("## Process Attestations"));
    }
  });

  it("ships the same checklist from the template and from wep task", async () => {
    expect(await generated()).toBe(shipped());
  });

  it("keeps evidence references free of checkboxes", () => {
    const evidence = sectionOf(shipped(), "Evidence References");

    expect(evidence).toContain("AC-");
    expect(evidence).toContain("task.md");
    expect(evidence).not.toMatch(/\[[ x]\]/);
  });

  it("labels every attestation with an actor and states that a checked box is self-reported", () => {
    const attestations = sectionOf(shipped(), "Process Attestations");
    const boxes = attestations.split("\n").filter((line) => /^- \[[ x]\]/.test(line));

    expect(attestations).toContain("self-reported");
    expect(attestations).toMatch(/not independent(ly)? verif/i);
    expect(attestations).toMatch(/authenticated human approval/);
    expect(boxes.length).toBeGreaterThan(0);
    for (const box of boxes) expect(box).toMatch(/^- \[ \] (Implementing agent|Human operator): /);
  });

  it("drops the duplicated mechanical-result checkboxes", () => {
    const checklist = shipped();

    expect(checklist).not.toMatch(/tests or validation commands/i);
    expect(checklist).not.toMatch(/regenerated from src\/templates/i);
    expect(checklist).not.toMatch(/build, .*tests/i);
  });

  it("keeps TASK-051: ready-for-review is the last box and no box waits for approval", () => {
    const boxes = shipped()
      .split("\n")
      .filter((line) => /^- \[ \]/.test(line));

    expect(boxes.at(-1)).toMatch(/ready for independent review/);
    expect(shipped()).toMatch(/before snapshot capture/);
    expect(shipped()).not.toMatch(/approved|APPROVED|review (is )?completed/);
  });

  it("leaves existing capsules untouched by init and upgrade planning", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const task = await runTask("Keep my checklist", { cwd: tmp, nonInteractive: true });
    const file = path.join(tmp, task.taskDir, "review-checklist.md");
    const legacy = "# Review Checklist\n\n- [x] Goal is clear.\n- [ ] Mixed, unclassified item.\n";
    await writeFile(file, legacy, "utf8");

    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    expect(await readFile(file, "utf8")).toBe(legacy);

    await runUpgrade({ cwd: tmp, dryRun: true, nonInteractive: true });
    expect(await readFile(file, "utf8")).toBe(legacy);

    await runUpgrade({ cwd: tmp, nonInteractive: true });
    expect(await readFile(file, "utf8")).toBe(legacy);
  });
});

describe("TASK-077 criterion proof declarations", () => {
  interface ProofFixtureOptions {
    criteria: string;
    declares?: string[];
    tests?: Array<{ command: string; status: string }>;
    statuses?: Record<string, string>;
    files?: Record<string, string>;
    snapshot?: boolean;
  }

  async function proofCapsule(criteria: string, declares: string[] = ["pnpm test"]) {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const task = await runTask("Declare criterion proof", { cwd: tmp, nonInteractive: true });
    const taskFile = path.join(tmp, task.taskDir, "task.md");
    const original = await readFile(taskFile, "utf8");
    const filled = original.replace("```\n```", `\`\`\`\n${declares.join("\n")}\n\`\`\``);
    expect(filled).not.toBe(original);
    await writeFile(taskFile, filled, "utf8");
    await writeFile(path.join(tmp, task.taskDir, "acceptance-criteria.md"), criteria, "utf8");
    return task;
  }

  async function proofFixture(options: ProofFixtureOptions) {
    const task = await proofCapsule(options.criteria, options.declares);
    for (const [file, content] of Object.entries(options.files ?? {})) {
      await mkdir(path.dirname(path.join(tmp, file)), { recursive: true });
      await writeFile(path.join(tmp, file), content, "utf8");
    }
    await writeFile(path.join(tmp, "app.ts"), "export const value = 1;\n", "utf8");
    await execFileAsync("git", ["init"], { cwd: tmp });
    await execFileAsync("git", ["config", "user.email", "tests@example.com"], { cwd: tmp });
    await execFileAsync("git", ["config", "user.name", "wep tests"], { cwd: tmp });
    await execFileAsync("git", ["add", "."], { cwd: tmp });
    await execFileAsync("git", ["commit", "-m", "base"], { cwd: tmp });
    await writeFile(path.join(tmp, "app.ts"), "export const value = 2;\n", "utf8");
    const scope = options.snapshot
      ? (await captureJudgeSnapshot(tmp, task.taskId, "HEAD")).scope
      : await createJudgeScope(tmp, task.taskId, "HEAD", "WORKTREE");
    const declaration = await readAcceptanceCriteria(tmp, task.taskId);
    const record = {
      schemaVersion: JUDGE_SCHEMA_VERSION,
      taskId: task.taskId,
      scope,
      verdict: "APPROVED",
      tests: options.tests ?? [{ command: "pnpm test", status: "passed" }],
      criteria: declaration.ids.map((id) => ({
        id,
        status: options.statuses?.[id] ?? "pass",
        evidence: "Checked against the changed files.",
      })),
      observations: [],
      reviewedAt: new Date().toISOString(),
    };
    const recordPath = path.join(tmp, ".wep/local/judge/proof-review.json");
    await mkdir(path.dirname(recordPath), { recursive: true });
    await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    return { task, recordPath };
  }

  const header = "# Acceptance Criteria\n\n";

  describe("declaration parser", () => {
    it("reads proof lines, keeps them out of the prose and deduplicates identical pairs", async () => {
      const task = await proofCapsule(
        `${header}- AC-1: Builds.\n  proof-command: pnpm build\n  proof-command: pnpm test\n  proof-command: pnpm build\n  proof-doc: docs/a.md#Heading\n  proof-doc: docs/b.md\n- AC-2: Plain.\n`,
      );

      const declaration = await readAcceptanceCriteria(tmp, task.taskId);

      expect(declaration.problems).toEqual([]);
      expect(declaration.ids).toEqual(["AC-1", "AC-2"]);
      expect(declaration.criteria[0].text).toBe("AC-1: Builds.");
      expect(declaration.criteria[0].proofs).toEqual([
        { kind: "command", reference: "pnpm build", line: 4 },
        { kind: "command", reference: "pnpm test", line: 5 },
        { kind: "doc", reference: "docs/a.md#Heading", line: 7 },
        { kind: "doc", reference: "docs/b.md", line: 8 },
      ]);
      expect(declaration.criteria[1].proofs).toEqual([]);
    });

    it("still folds ordinary continuation prose around a proof line", async () => {
      const task = await proofCapsule(
        `${header}- AC-1: First part\n  proof-command: pnpm test\n  second part.\n- AC-2: Next.\n`,
      );

      const declaration = await readAcceptanceCriteria(tmp, task.taskId);

      expect(declaration.problems).toEqual([]);
      expect(declaration.criteria[0].text).toBe("AC-1: First part second part.");
      expect(declaration.criteria[0].proofs).toHaveLength(1);
    });

    it.each([
      ["an empty command", "- AC-1: A.\n  proof-command:\n", "line 4", "empty"],
      ["an empty document", "- AC-1: A.\n  proof-doc:   \n", "line 4", "empty"],
      ["a generic proof field", "- AC-1: A.\n  proof: pnpm test\n", "line 4", "unsupported"],
      ["an unknown proof kind", "- AC-1: A.\n  proof-test: it works\n", "line 4", "unsupported"],
      ["a differently cased kind", "- AC-1: A.\n  Proof-Command: pnpm test\n", "line 4", "unsupported"],
      ["an orphaned line before any criterion", "  proof-command: pnpm test\n- AC-1: A.\n", "line 3", "orphaned"],
      ["an unindented orphan", "- AC-1: A.\n\nproof-doc: docs/a.md\n", "line 5", "orphaned"],
      [
        "an orphan in the retired footer",
        "- AC-1: A.\nRetired: AC-2\n  proof-command: pnpm test\n",
        "line 5",
        "orphaned",
      ],
    ])("reports %s as a capsule defect with its line", async (_name, body, line, kind) => {
      const task = await proofCapsule(header + body);

      const declaration = await readAcceptanceCriteria(tmp, task.taskId);

      expect(declaration.problems).toHaveLength(1);
      expect(declaration.problems[0]).toContain(line);
      expect(declaration.problems[0]).toContain("acceptance-criteria.md");
      expect(declaration.problems[0]).toContain(kind);
    });

    it.each([
      ["an absolute path", "/etc/passwd"],
      ["a traversal path", "../outside.md"],
      ["an embedded traversal", "docs/../../outside.md"],
      ["a remote URL", "https://example.com/spec.md"],
      ["a file URL", "file:///etc/passwd"],
      ["a Windows drive path", "C:\\spec.md"],
      ["a policy-blocked file", ".env"],
      ["a policy-blocked directory", "secrets/spec.md"],
      ["a policy-blocked pattern", "docs/server.pem"],
      ["a fragment without a path", "#Heading"],
      ["an empty fragment", "docs/a.md#"],
    ])("rejects %s as a proof-doc reference", async (_name, reference) => {
      const task = await proofCapsule(`${header}- AC-1: A.\n  proof-doc: ${reference}\n`);

      const declaration = await readAcceptanceCriteria(tmp, task.taskId);

      expect(declaration.problems).toHaveLength(1);
      expect(declaration.problems[0]).toContain("line 4");
      expect(declaration.problems[0]).toContain("proof-doc");
    });

    it("drops a rejected reference so verification never looks at its target", async () => {
      const task = await proofCapsule(
        `${header}- AC-1: A.\n  proof-doc: ../outside.md\n  proof-doc: .env\n  proof-doc: docs/ok.md\n`,
      );

      const declaration = await readAcceptanceCriteria(tmp, task.taskId);

      expect(declaration.problems).toHaveLength(2);
      expect(declaration.criteria[0].proofs).toEqual([{ kind: "doc", reference: "docs/ok.md", line: 6 }]);
    });

    it("keeps retired identifiers as non-criteria next to proof declarations", async () => {
      const task = await proofCapsule(
        `${header}- AC-1: A.\n  proof-command: pnpm test\n\nRetired: AC-2\nRetired: AC-3\n`,
      );

      const declaration = await readAcceptanceCriteria(tmp, task.taskId);

      expect(declaration.problems).toEqual([]);
      expect(declaration.ids).toEqual(["AC-1"]);
    });

    it("leaves a capsule without declarations valid and untouched by migration", async () => {
      const body = `${header}- AC-1: Old prose.\n  wrapped line that mentions a proof of concept.\n- AC-2: Other.\n`;
      const task = await proofCapsule(body);

      const declaration = await readAcceptanceCriteria(tmp, task.taskId);
      const migration = await migrateAcceptanceCriteriaIdentifiers(tmp, { dryRun: true });

      expect(declaration.problems).toEqual([]);
      expect(declaration.criteria.map((criterion) => criterion.proofs)).toEqual([[], []]);
      expect(migration.every((entry) => !entry.changed)).toBe(true);
    });

    it("lets migration number a bullet in a capsule that also has a proof defect", async () => {
      const task = await proofCapsule(`${header}- Unnumbered.\n  proof: pnpm test\n`);

      const migration = await migrateAcceptanceCriteriaIdentifiers(tmp, { dryRun: true });

      const entry = migration.find((item) => item.file.includes(task.taskId));
      expect(entry?.changed).toBe(true);
      expect(entry?.problems ?? []).toEqual([]);
    });
  });

  describe("command proof in verify", () => {
    const one = (extra: string) => `${header}- AC-1: Works.\n${extra}`;

    it("accepts a declared passing command on trust and says the execution was not observed", async () => {
      const { recordPath } = await proofFixture({ criteria: one("  proof-command: pnpm test\n") });

      const result = await verifyJudgeRecord(tmp, recordPath);

      expect(result.approved).toBe(true);
      expect(result.reasons).toEqual([]);
      expect(result.notices.join("\n")).toContain("AC-1: execution not observed: command accepted on trust");
      expect(result.notices.join("\n")).toContain("pnpm test");
    });

    it("emits no proof text for a capsule that declares no proof", async () => {
      const { recordPath } = await proofFixture({ criteria: one("") });

      const result = await verifyJudgeRecord(tmp, recordPath);

      expect(result.approved).toBe(true);
      expect(result.reasons).toEqual([]);
      expect(result.notices.join("\n")).not.toContain("execution not observed");
      expect(result.notices.join("\n")).not.toContain("proof");
    });

    it("keeps a criterion without proof assessable when it is reported not-evaluated", async () => {
      const { recordPath } = await proofFixture({ criteria: one(""), statuses: { "AC-1": "not-evaluated" } });

      const result = await verifyJudgeRecord(tmp, recordPath);

      expect(result.approved).toBe(false);
      expect(result.reasons.join("\n")).not.toContain("proof requirement unmet");
      expect(result.reasons.join("\n")).not.toContain("criterion not evaluated");
    });

    it("reports a command the capsule does not declare as an unmet proof requirement", async () => {
      const { recordPath } = await proofFixture({
        criteria: one("  proof-command: pnpm e2e\n"),
        tests: [
          { command: "pnpm test", status: "passed" },
          { command: "pnpm e2e", status: "passed" },
        ],
      });

      const result = await verifyJudgeRecord(tmp, recordPath);

      expect(result.approved).toBe(false);
      expect(result.reasons.join("\n")).toMatch(
        /AC-1: proof requirement unmet.*pnpm e2e.*not a command the capsule declares/,
      );
    });

    it.each([
      ["absent", []],
      ["not-run", [{ command: "pnpm lint", status: "not-run" }]],
      ["failed", [{ command: "pnpm lint", status: "failed" }]],
    ])("reports %s evidence for a required proof command as unmet", async (_name, extra) => {
      const { recordPath } = await proofFixture({
        criteria: one("  proof-command: pnpm lint\n"),
        declares: ["pnpm test", "pnpm lint # optional"],
        tests: [{ command: "pnpm test", status: "passed" }, ...extra],
      });

      const result = await verifyJudgeRecord(tmp, recordPath);

      expect(result.approved).toBe(false);
      expect(result.reasons.join("\n")).toMatch(/AC-1: proof requirement unmet.*pnpm lint/);
    });

    it("keeps the optional-failure notice and still blocks the criterion that requires the command", async () => {
      const { recordPath } = await proofFixture({
        criteria: one("  proof-command: pnpm lint\n"),
        declares: ["pnpm test", "pnpm lint # optional"],
        tests: [
          { command: "pnpm test", status: "passed" },
          { command: "pnpm lint", status: "failed" },
        ],
      });

      const result = await verifyJudgeRecord(tmp, recordPath);

      expect(result.notices.join("\n")).toContain("Optional command `pnpm lint` failed");
      expect(result.reasons.join("\n")).toContain("AC-1: proof requirement unmet");
    });

    it("accepts a globally optional command that passed when a criterion requires it", async () => {
      const { recordPath } = await proofFixture({
        criteria: one("  proof-command: pnpm lint # optional\n"),
        declares: ["pnpm test", "pnpm lint # optional"],
        tests: [
          { command: "pnpm test", status: "passed" },
          { command: "pnpm lint", status: "passed" },
        ],
      });

      const result = await verifyJudgeRecord(tmp, recordPath);

      expect(result.approved).toBe(true);
      expect(result.reasons).toEqual([]);
    });

    it("treats several command references as conjunctive and names only the unmet one", async () => {
      const { recordPath } = await proofFixture({
        criteria: one("  proof-command: pnpm test\n  proof-command: pnpm build\n"),
        declares: ["pnpm test", "pnpm build"],
        tests: [{ command: "pnpm test", status: "passed" }],
      });

      const result = await verifyJudgeRecord(tmp, recordPath);

      const unmet = result.reasons.filter((reason) => reason.includes("proof requirement unmet"));
      expect(unmet).toHaveLength(1);
      expect(unmet[0]).toContain("pnpm build");
      expect(unmet[0]).not.toContain("pnpm test");
    });

    it("does not let a passing command force a pass", async () => {
      const { recordPath } = await proofFixture({
        criteria: one("  proof-command: pnpm test\n"),
        statuses: { "AC-1": "fail" },
      });

      const result = await verifyJudgeRecord(tmp, recordPath);

      expect(result.approved).toBe(false);
      expect(result.reasons.join("\n")).toContain("APPROVED requires every declared criterion to pass");
      expect(result.reasons.join("\n")).not.toContain("proof requirement unmet");
    });

    it("names an unmet proof next to a not-evaluated criterion instead of hiding it", async () => {
      const { recordPath } = await proofFixture({
        criteria: one("  proof-command: pnpm e2e\n"),
        statuses: { "AC-1": "not-evaluated" },
      });

      const result = await verifyJudgeRecord(tmp, recordPath);

      const text = result.reasons.join("\n");
      expect(text).toContain("AC-1: criterion not evaluated");
      expect(text).toContain("AC-1: proof requirement unmet");
    });

    it("names a not-evaluated criterion whose proof is available as not evaluated only", async () => {
      const { recordPath } = await proofFixture({
        criteria: one("  proof-command: pnpm test\n"),
        statuses: { "AC-1": "not-evaluated" },
      });

      const result = await verifyJudgeRecord(tmp, recordPath);

      const text = result.reasons.join("\n");
      expect(text).toContain("AC-1: criterion not evaluated");
      expect(text).not.toContain("proof requirement unmet");
    });

    it("rejects a malformed declaration through the existing capsule-defect channel", async () => {
      const { recordPath } = await proofFixture({ criteria: one("  proof:\n") });

      const result = await verifyJudgeRecord(tmp, recordPath);

      expect(result.approved).toBe(false);
      expect(result.reasons.join("\n")).toContain("acceptance-criteria.md line 4");
    });

    it("removes the trust notice after a successful observed re-run and runs nothing extra", async () => {
      const passing = 'node -e "process.exit(0)"';
      const sentinel = path.join(tmp, "proof-must-not-run.txt");
      const injected = `node -e "require('fs').writeFileSync(${JSON.stringify(sentinel)}, 'ran')"`;
      const { recordPath } = await proofFixture({
        criteria: one(`  proof-command: ${passing}\n  proof-command: ${injected}\n`),
        declares: [passing],
        tests: [{ command: passing, status: "passed" }],
        snapshot: true,
      });

      const result = await verifyJudgeRecord(tmp, recordPath, { runTests: true, approve: async () => true });

      expect(result.reexecuted).toHaveLength(1);
      expect(result.reexecuted[0]).toMatchObject({ command: passing, passed: true });
      expect(result.notices.join("\n")).not.toContain(
        `execution not observed: command accepted on trust: \`${passing}\``,
      );
      expect(result.reasons.join("\n")).toContain("proof requirement unmet");
      await expect(stat(sentinel)).rejects.toThrow();
    });

    it("adds an unmet-proof reason to the existing failure when the observed re-run fails", async () => {
      const failing = 'node -e "process.exit(1)"';
      const { recordPath } = await proofFixture({
        criteria: one(`  proof-command: ${failing}\n`),
        declares: [failing],
        tests: [{ command: failing, status: "passed" }],
        snapshot: true,
      });

      const result = await verifyJudgeRecord(tmp, recordPath, { runTests: true, approve: async () => true });

      const text = result.reasons.join("\n");
      expect(result.approved).toBe(false);
      expect(text).toContain("Independent re-run of");
      expect(text).toMatch(/AC-1: proof requirement unmet.*process\.exit\(1\)/);
    });

    it("does not infer a per-test result from reporter text", async () => {
      const { recordPath } = await proofFixture({
        criteria: one("  proof-command: pnpm test\n"),
        tests: [{ command: "pnpm test", status: "passed", evidence: "✗ proof test one failed" } as never],
      });

      const result = await verifyJudgeRecord(tmp, recordPath);

      expect(result.approved).toBe(true);
      expect(result.reasons).toEqual([]);
    });
  });

  describe("documentary proof in verify", () => {
    const withDoc = (reference: string) => `${header}- AC-1: Documented.\n  proof-doc: ${reference}\n`;

    it("accepts an existing unchanged document without any mechanical effect", async () => {
      const { recordPath } = await proofFixture({
        criteria: withDoc("docs/behavior.md#Behavior"),
        files: { "docs/behavior.md": "# Behavior\n" },
      });

      const result = await verifyJudgeRecord(tmp, recordPath);

      expect(result.approved).toBe(true);
      expect(result.reasons).toEqual([]);
      expect(result.notices.join("\n")).not.toMatch(/proof-doc .* unavailable/);
    });

    it("does not let an existing document force a pass", async () => {
      const { recordPath } = await proofFixture({
        criteria: withDoc("docs/unrelated.md"),
        files: { "docs/unrelated.md": "# Unrelated\n" },
        statuses: { "AC-1": "fail" },
      });

      const result = await verifyJudgeRecord(tmp, recordPath);

      expect(result.approved).toBe(false);
      expect(result.reasons.join("\n")).toContain("APPROVED requires every declared criterion to pass");
    });

    it("reports a missing document as unavailable without failing the criterion", async () => {
      const { recordPath } = await proofFixture({ criteria: withDoc("docs/missing.md") });

      const result = await verifyJudgeRecord(tmp, recordPath);

      expect(result.approved).toBe(true);
      expect(result.reasons).toEqual([]);
      expect(result.notices.join("\n")).toMatch(/AC-1: proof-doc `docs\/missing\.md` unavailable/);
    });

    it("reports a missing heading fragment as unavailable without failing the criterion", async () => {
      const { recordPath } = await proofFixture({
        criteria: withDoc("docs/behavior.md#NonExistentHeading"),
        files: { "docs/behavior.md": "# Behavior\n\nSome text.\n" },
      });

      const result = await verifyJudgeRecord(tmp, recordPath);

      expect(result.approved).toBe(true);
      expect(result.reasons).toEqual([]);
      expect(result.notices.join("\n")).toMatch(
        /AC-1: proof-doc `docs\/behavior\.md#NonExistentHeading` unavailable: heading "#NonExistentHeading" was not found/,
      );
    });

    it("reports a link that escapes the repository as unavailable and never follows it", async () => {
      const outside = path.join(path.dirname(tmp), `${path.basename(tmp)}-secret.md`);
      await writeFile(outside, "# Outside\n", "utf8");
      const { recordPath } = await proofFixture({
        criteria: withDoc("docs/link.md"),
        files: { "docs/placeholder.md": "# Placeholder\n" },
      });
      await symlink(outside, path.join(tmp, "docs/link.md"));
      const before = (await stat(outside)).atimeMs;

      const result = await verifyJudgeRecord(tmp, recordPath);

      expect(result.reasons.join("\n")).not.toContain("proof requirement unmet");
      expect(result.notices.join("\n")).toMatch(/AC-1: proof-doc `docs\/link\.md` unavailable/);
      expect((await stat(outside)).atimeMs).toBe(before);
      await rm(outside);
    });
  });

  describe("shipped guidance", () => {
    it("shows the proof syntax in the capsule template and in a new capsule", async () => {
      await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
      const task = await runTask("Show the proof syntax", { cwd: tmp, nonInteractive: true });

      for (const file of [".wep/tasks/_template/acceptance-criteria.md", `${task.taskDir}/acceptance-criteria.md`]) {
        const markdown = await readFile(path.join(tmp, file), "utf8");
        expect(markdown).toContain("proof-command:");
        expect(markdown).toContain("proof-doc:");
      }
      const declaration = await readAcceptanceCriteria(tmp, task.taskId);
      expect(declaration.problems).toEqual([]);
      expect(declaration.criteria.every((criterion) => criterion.proofs.length === 0)).toBe(true);
    });

    it("describes how a declared proof constrains the verdict in the judge files", async () => {
      await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
      await runJudgeEnable({ cwd: tmp, nonInteractive: true });

      const instructions = await readFile(path.join(tmp, ".codex/agents/wep-judge.toml"), "utf8");
      const readme = await readFile(path.join(tmp, ".wep/judge/README.md"), "utf8");
      const schema = JSON.parse(await readFile(path.join(tmp, ".wep/judge/schemas/review.schema.json"), "utf8"));

      for (const text of [instructions, readme]) {
        expect(text).toContain("proof-command:");
        expect(text).toContain("proof-doc:");
        expect(text).toContain("proof requirement unmet");
        expect(text).toContain("execution not observed: command accepted on trust");
      }
      expect(schema.properties.criteria.description).toContain("proof");
      expect(Object.keys(schema.properties.criteria.items.properties)).toEqual(["id", "status", "evidence"]);
    });
  });
});
