import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as clarificationSignal from "../src/clarification-signal.js";
import { boundedNotice, countLineChanges, normalizeBlocks } from "../src/clarification-signal.js";
import { capsuleFiles } from "../src/harness-files.js";
import { runInit } from "../src/init.js";
import {
  JUDGE_SCHEMA_VERSION,
  createJudgeScope,
  readAcceptanceCriteria,
  readClarificationState,
  verifyJudgeRecord,
} from "../src/judge-enforcement.js";
import { captureJudgeSnapshot } from "../src/judge-snapshot.js";
import { runTask } from "../src/task.js";
import {
  claudeSkills,
  codexSkills,
  copilotSkills,
  piSkills,
  targetReferenceTemplates,
  taskTemplateFiles,
} from "../src/templates.js";

import { execFileAsync, tmp, useTempDir } from "./helpers/wep.js";

useTempDir();

describe("clarification gate", () => {
  async function capsuleWith(sections: string): Promise<string> {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const task = await runTask("Fix invoice regression", { cwd: tmp, nonInteractive: true });
    const taskFile = path.join(tmp, task.taskDir, "task.md");
    const original = await readFile(taskFile, "utf8");
    // Replace from `## Clarifications` to end of file: both sections are the tail of the
    // generated capsule, so a fixture supplies them together or not at all.
    const replaced = original.replace(/\n## Clarifications\n[\s\S]*$/, `\n${sections}`);
    expect(replaced).not.toBe(original);
    await writeFile(taskFile, replaced, "utf8");
    return task.taskId;
  }

  it("generates both sections empty, with no date and no session heading", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const task = await runTask("Fix invoice regression", { cwd: tmp, nonInteractive: true });

    const taskMd = await readFile(path.join(tmp, task.taskDir, "task.md"), "utf8");

    expect(taskMd).toContain("## Clarifications");
    expect(taskMd).toContain("## Open Questions");
    // A session heading is stamped when a question is actually answered. Emitting one at
    // creation would date a session that never happened and make the file non-deterministic.
    // The section's instructions name the `### Session YYYY-MM-DD` format, so this asserts
    // no heading was written, not that the format is never mentioned.
    expect(taskMd).not.toMatch(/^### Session/m);
    expect(taskMd).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("produces byte-identical task.md across runs (no clock dependency)", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const first = await runTask("Fix invoice regression", { cwd: tmp, nonInteractive: true });
    const firstMd = await readFile(path.join(tmp, first.taskDir, "task.md"), "utf8");
    await rm(path.join(tmp, first.taskDir), { recursive: true, force: true });
    const second = await runTask("Fix invoice regression", { cwd: tmp, nonInteractive: true });

    const secondMd = await readFile(path.join(tmp, second.taskDir, "task.md"), "utf8");

    expect(secondMd).toBe(firstMd);
  });

  it("ships both sections in the shipped _template", async () => {
    const template = taskTemplateFiles["tasks/_template/task.md"];

    expect(template).toContain("## Clarifications");
    expect(template).toContain("## Open Questions");
  });

  it("does not add a capsule file: the capsule is still exactly five files", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const task = await runTask("Fix invoice regression", { cwd: tmp, nonInteractive: true });

    const entries = await readdir(path.join(tmp, task.taskDir));

    expect(entries.filter((entry) => entry.endsWith(".md")).sort()).toEqual([...capsuleFiles].sort());
  });

  it("reads the bullets of each section", async () => {
    const taskId = await capsuleWith(
      [
        "## Clarifications",
        "",
        "### Session 2026-08-05",
        "",
        "- Q: Cents or minor units? / A: Minor units.",
        "",
        "## Open Questions",
        "",
        "- Whether legacy invoices are in scope.",
        "",
      ].join("\n"),
    );

    const state = await readClarificationState(tmp, taskId);

    expect(state.clarificationsSectionPresent).toBe(true);
    expect(state.clarifications).toEqual(["Q: Cents or minor units? / A: Minor units."]);
    expect(state.openQuestions).toEqual(["Whether legacy invoices are in scope."]);
  });

  it("joins a bullet wrapped across lines into one entry", async () => {
    const taskId = await capsuleWith(
      [
        "## Clarifications",
        "",
        "- None recorded yet.",
        "",
        "## Open Questions",
        "",
        "- Whether Copilot really emits snake_case is taken from its published",
        "  reference, not from execution.",
        "- A second question.",
        "",
      ].join("\n"),
    );

    const state = await readClarificationState(tmp, taskId);

    expect(state.openQuestions).toEqual([
      "Whether Copilot really emits snake_case is taken from its published reference, not from execution.",
      "A second question.",
    ]);
  });

  it("treats the generated placeholder as empty", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const task = await runTask("Fix invoice regression", { cwd: tmp, nonInteractive: true });

    const state = await readClarificationState(tmp, task.taskId);

    expect(state.clarificationsSectionPresent).toBe(true);
    expect(state.clarifications).toEqual([]);
    expect(state.openQuestions).toEqual([]);
  });

  it.each([
    "None.",
    "None!",
    "Ninguna.",
    "N/A",
    "none",
    "NONE",
    "Ninguno",
    "None recorded yet.",
    "None remaining.",
    "None left.",
    "None yet.",
    "None so far.",
    "None  so   far.",
    "None open.",
    "None pending.",
  ])("treats a %s bullet as empty in both sections", async (variant) => {
    const taskId = await capsuleWith(
      ["## Clarifications", "", `- ${variant}`, "", "## Open Questions", "", `- ${variant}`, ""].join("\n"),
    );

    const state = await readClarificationState(tmp, taskId);

    expect(state.clarifications).toEqual([]);
    expect(state.openQuestions).toEqual([]);
  });

  it("keeps a bullet that starts with None but continues with real content", async () => {
    const variant = "None of the callers validate X";
    const taskId = await capsuleWith(
      ["## Clarifications", "", `- ${variant}`, "", "## Open Questions", "", `- ${variant}`, ""].join("\n"),
    );

    const state = await readClarificationState(tmp, taskId);

    expect(state.clarifications).toEqual([variant]);
    expect(state.openQuestions).toEqual([variant]);
  });

  it("reports a capsule written before this section existed without erroring", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    const task = await runTask("Fix invoice regression", { cwd: tmp, nonInteractive: true });
    const taskFile = path.join(tmp, task.taskDir, "task.md");
    const original = await readFile(taskFile, "utf8");
    // A TASK-001…005-shaped capsule: `## Open Questions` exists, `## Clarifications` does not.
    await writeFile(taskFile, original.replace(/\n## Clarifications\n[\s\S]*?(?=\n## Open Questions\n)/, "\n"), "utf8");

    const state = await readClarificationState(tmp, task.taskId);

    expect(state.clarificationsSectionPresent).toBe(false);
    expect(state.clarifications).toEqual([]);
    expect(state.openQuestions).toEqual([]);
  });

  it("returns an absent state for a task id that has no capsule", async () => {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });

    const state = await readClarificationState(tmp, "TASK-999");

    expect(state).toEqual({ clarificationsSectionPresent: false, clarifications: [], openQuestions: [] });
  });

  it("ignores a question written as a bare paragraph, which is why the skill demands a bullet", async () => {
    const taskId = await capsuleWith(
      [
        "## Clarifications",
        "",
        "- None recorded yet.",
        "",
        "## Open Questions",
        "",
        "Whether legacy invoices are in scope is still undecided.",
        "",
      ].join("\n"),
    );

    const state = await readClarificationState(tmp, taskId);

    // The parser cannot accept paragraphs: both sections carry explanatory prose by design,
    // so prose-as-content would make every generated capsule look full of questions. The
    // instruction therefore has to require the bullet, and this pins the consequence of the
    // two drifting apart — a question nobody sees.
    expect(state.openQuestions).toEqual([]);
  });

  it("emits the same wep-task skill text to all four targets", () => {
    const bodyOf = (files: Record<string, string>, prefix: string) => files[`${prefix}/wep-task/SKILL.md`];
    const bodies = [
      bodyOf(claudeSkills, ".claude/skills"),
      bodyOf(codexSkills, ".agents/skills"),
      bodyOf(copilotSkills, ".github/skills"),
      bodyOf(piSkills, ".pi/skills"),
    ];

    expect(bodies.every((body) => typeof body === "string" && body.length > 0)).toBe(true);
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).toContain("Clarify before implementing");
    // The clarification contract is portable: no target's copy may name a host-specific
    // question UI, or the artifact would stop being identical across hosts.
    for (const body of bodies) expect(body).not.toContain("AskUserQuestion");
  });

  it("names the native question UI in the claude target reference only", () => {
    const mentioning = Object.entries(targetReferenceTemplates)
      .filter(([, text]) => text.includes("AskUserQuestion"))
      .map(([target]) => target);

    expect(mentioning).toEqual(["claude"]);
  });
});

describe("TASK-078 clarification signal", () => {
  const sha = async (ref: string) => (await execFileAsync("git", ["rev-parse", ref], { cwd: tmp })).stdout.trim();
  const git = (...args: string[]) => execFileAsync("git", args, { cwd: tmp });
  const reset = async () => {
    await rm(tmp, { recursive: true, force: true });
    await mkdir(tmp, { recursive: true });
  };

  interface Capsule {
    contract?: string;
    clarifications?: string | null;
    criteria?: string;
  }

  const taskMarkdown = ({ contract = "The tool reports X.", clarifications }: Capsule) => {
    const clarificationText =
      clarifications === undefined ? "### Session 2026-10-01\n- The human chose option A." : clarifications;
    return `# TASK-X

## Goal

Demo.

## Contract

${contract}

## Validation

\`\`\`
pnpm test
\`\`\`
${clarificationText === null ? "" : `\n## Clarifications\n\n${clarificationText}\n`}
## Open Questions

- None.
`;
  };
  const criteriaMarkdown = (criteria = "- AC-1: It works.") => `# Acceptance Criteria\n\n${criteria}\n`;

  async function writeCapsule(taskDir: string, capsule: Capsule) {
    await writeFile(path.join(tmp, taskDir, "task.md"), taskMarkdown(capsule), "utf8");
    await writeFile(path.join(tmp, taskDir, "acceptance-criteria.md"), criteriaMarkdown(capsule.criteria), "utf8");
  }

  async function writeRecord(task: { taskId: string }, scope: unknown, name: string) {
    const declaration = await readAcceptanceCriteria(tmp, task.taskId);
    const recordPath = path.join(tmp, ".wep/local/judge", name);
    await mkdir(path.dirname(recordPath), { recursive: true });
    await writeFile(
      recordPath,
      `${JSON.stringify({
        schemaVersion: JUDGE_SCHEMA_VERSION,
        taskId: task.taskId,
        scope,
        verdict: "APPROVED",
        tests: [{ command: "pnpm test", status: "passed" }],
        criteria: declaration.ids.map((id) => ({ id, status: "pass", evidence: "Checked." })),
        observations: [],
        reviewedAt: new Date().toISOString(),
      })}\n`,
      "utf8",
    );
    return recordPath;
  }

  async function initRepo() {
    await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
    await git("init");
    await git("config", "user.email", "tests@example.com");
    await git("config", "user.name", "wep tests");
  }

  const isSignal = (notice: string) => /^(Heuristic notice|Clarification comparison)/.test(notice);

  /** Verify a record over a base -> candidate boundary. */
  async function verifyBoundary(options: {
    base: Capsule;
    candidate: Capsule;
    mode?: "commit" | "snapshot" | "worktree";
    capsuleInBase?: boolean;
  }) {
    const mode = options.mode ?? "commit";
    await initRepo();
    let task: Awaited<ReturnType<typeof runTask>>;
    let base: string;
    if (options.capsuleInBase === false) {
      await git("add", ".");
      await git("commit", "-m", "init");
      base = await sha("HEAD");
      task = await runTask("Clarification signal", { cwd: tmp, nonInteractive: true });
      await writeCapsule(task.taskDir, options.candidate);
      await git("add", ".");
      await git("commit", "-m", "capsule");
    } else {
      task = await runTask("Clarification signal", { cwd: tmp, nonInteractive: true });
      await writeCapsule(task.taskDir, options.base);
      await git("add", ".");
      await git("commit", "-m", "base");
      base = await sha("HEAD");
      await writeCapsule(task.taskDir, options.candidate);
      if (mode === "commit") {
        await git("add", ".");
        await git("commit", "-m", "candidate");
      }
    }
    const scope =
      mode === "snapshot"
        ? (await captureJudgeSnapshot(tmp, task.taskId, base)).scope
        : await createJudgeScope(tmp, task.taskId, base, mode === "worktree" ? "WORKTREE" : "HEAD");
    const recordPath = await writeRecord(task, scope, "clarification-review.json");
    const result = await verifyJudgeRecord(tmp, recordPath);
    return { task, scope, base, recordPath, result, signal: result.notices.filter(isSignal) };
  }

  const changedContract = { contract: "The tool reports Y." };

  describe("normalization", () => {
    const same = (a: string, b: string) => expect(normalizeBlocks(a)).toEqual(normalizeBlocks(b));
    const differ = (a: string, b: string) => expect(normalizeBlocks(a)).not.toEqual(normalizeBlocks(b));

    it("ignores CRLF, and whitespace reflow inside paragraphs and list items", () => {
      same(
        "One  sentence\nwraps here.\n\n- item one\n  continues\n",
        "One sentence wraps\nhere.\r\n\r\n- item one continues\r\n",
      );
    });

    it("ignores exactly one terminal full stop on prose and list items", () => {
      same("The tool reports X.", "The tool reports X");
      same("- Item.", "- Item");
      differ("The tool reports X...", "The tool reports X");
      differ("Is it X?", "Is it X");
      differ("See (X).", "See (X");
    });

    it("keeps operators, paths, numbers, quoting and block order significant", () => {
      differ("a < b", "a <= b");
      differ("Edit src/a.ts", "Edit src/b.ts");
      differ("Allow 1.5 seconds", "Allow 15 seconds");
      differ('Say "x" now', "Say 'x' now");
      differ("**must** run", "must run");
      differ("First.\n\nSecond.", "Second.\n\nFirst.");
      differ("A\n\nB", "A B");
    });

    it("keeps inline code, fenced code and headings exact", () => {
      differ("Run `a  b` now", "Run `a b` now");
      differ("```\nfoo  bar\n```", "```\nfoo bar\n```");
      differ("```\nfoo.\n```", "```\nfoo\n```");
      differ("## Contract", "### Contract");
      same("Run `a b`.\n", "Run `a b`");
    });

    it("keeps proof-command:, proof-doc: and Retired: lines exact and separate", () => {
      differ("- AC-1: A.\n  proof-command: pnpm  test\n", "- AC-1: A.\n  proof-command: pnpm test\n");
      differ("Retired: AC-5", "Retired: AC-6");
      differ("proof-doc: docs/a.md.", "proof-doc: docs/a.md");
      expect(normalizeBlocks("- AC-1: A\n  proof-doc: docs/a.md\n  proof-command: pnpm test")).toHaveLength(3);
    });

    it("counts raw added and deleted lines", () => {
      expect(countLineChanges(["a", "b", "c"], ["a", "x", "c", "d"])).toEqual({ added: 2, deleted: 1 });
      expect(countLineChanges([], ["a"])).toEqual({ added: 1, deleted: 0 });
    });
  });

  describe("heuristic notice", () => {
    it("reports a changed Contract without new clarification content", async () => {
      const { signal, base, result } = await verifyBoundary({ base: {}, candidate: changedContract });

      expect(signal).toHaveLength(1);
      expect(signal[0]).toContain("task.md `## Contract`");
      expect(signal[0]).toContain("+1/-1 raw lines");
      expect(signal[0]).toContain(`base ${base.slice(0, 12)} to candidate`);
      expect(signal[0]).toMatch(/path \.wep\/tasks\/TASK-\d+-[^/]+\/task\.md/);
      expect(signal[0]).toContain("does not show that a consultation was skipped");
      expect(signal[0]).not.toContain("The tool reports Y");
      expect(signal[0].length).toBeLessThanOrEqual(1024);
      expect(result.reasons).toEqual([]);
    });

    it("reports a changed acceptance-criteria.md, and a Contract change as a second notice", async () => {
      const onlyCriteria = await verifyBoundary({ base: {}, candidate: { criteria: "- AC-1: It works well." } });
      expect(onlyCriteria.signal).toHaveLength(1);
      expect(onlyCriteria.signal[0]).toContain("acceptance-criteria.md changed");
      await reset();

      const both = await verifyBoundary({ base: {}, candidate: { ...changedContract, criteria: "- AC-1: Other." } });
      expect(both.signal).toHaveLength(2);
    });

    it("stays silent for reflow, CRLF and one terminal full stop", async () => {
      const { signal } = await verifyBoundary({
        base: { contract: "The tool reports\nX.\n\nIt never blocks." },
        candidate: { contract: "The tool   reports X\r\n\r\nIt never blocks", criteria: "- AC-1: It works" },
      });
      expect(signal).toEqual([]);
    });

    it("never changes valid or approved", async () => {
      const withNotice = await verifyBoundary({ base: {}, candidate: changedContract });
      expect(withNotice.signal).toHaveLength(1);
      await reset();
      const control = await verifyBoundary({
        base: {},
        candidate: {
          ...changedContract,
          clarifications: "### Session 2026-10-01\n- The human chose option A.\n- The human chose Y.",
        },
      });
      expect(control.signal).toEqual([]);
      expect(withNotice.result.valid).toBe(control.result.valid);
      expect(withNotice.result.approved).toBe(control.result.approved);
      expect(withNotice.result.valid).toBe(true);
      expect(withNotice.result.approved).toBe(true);
    });

    it("caps a notice at 1024 characters and keeps the boundary ID and section", () => {
      const longPath = `.wep/tasks/TASK-001-${"very-long-name-".repeat(100)}/task.md`;
      const pointer = "base abcdef123456 to candidate SNAPSHOT:0123456789abcdef0123";
      const notice = boundedNotice("task.md `## Contract`", 3, 4, pointer, longPath);
      expect(notice.length).toBeLessThanOrEqual(1024);
      expect(notice).toContain("SNAPSHOT:0123456789abcdef0123");
      expect(notice).toContain("task.md `## Contract`");
      expect(notice).toContain("…");
    });
  });

  describe("new clarification content", () => {
    const withBullets = (...bullets: string[]): Capsule => ({
      ...changedContract,
      clarifications: `### Session 2026-10-01\n- The human chose option A.\n${bullets.join("\n")}`,
    });
    const signalFor = async (candidate: Capsule) => {
      const { signal } = await verifyBoundary({ base: {}, candidate });
      await reset();
      return signal.length;
    };

    it("is suppressed by a new bullet, including a wrapped one", async () => {
      expect(await signalFor(withBullets("- The human chose Y.\n  The reason is cost."))).toBe(0);
    });

    it("is suppressed by No ambiguity: with an explanation", async () => {
      expect(await signalFor(withBullets("- No ambiguity: the change is a rename."))).toBe(0);
    });

    it("is not suppressed by an empty No ambiguity:", async () => {
      expect(await signalFor(withBullets("- No ambiguity:"))).toBe(1);
      expect(await signalFor(withBullets("- no ambiguity:   "))).toBe(1);
    });

    it("is not suppressed by a heading or date change, a duplicate bullet or a None placeholder", async () => {
      for (const clarifications of [
        "### Session 2026-10-09\n- The human chose option A.",
        "### Session 2026-10-01\n- The human chose option A.\n### Session 2026-10-09\n- The human chose option A",
        "### Session 2026-10-01\n- The human chose option A.\n- None.",
        "### Session 2026-10-01\n- The human chose option A.\n- None recorded yet.",
      ]) {
        expect(await signalFor({ ...changedContract, clarifications })).toBe(1);
      }
    });
  });

  describe("reviewed boundary", () => {
    it("compares a snapshot against its base and ignores the live workspace", async () => {
      const { signal, scope, task, recordPath } = await verifyBoundary({
        base: {},
        candidate: changedContract,
        mode: "snapshot",
      });

      expect(scope.candidate).toMatch(/^SNAPSHOT:/);
      expect(signal).toHaveLength(1);
      expect(signal[0]).toContain(`candidate ${scope.candidate}`);

      // A live edit after the snapshot must neither add nor hide a notice.
      await writeCapsule(task.taskDir, {
        ...changedContract,
        clarifications: "### Session 2026-10-01\n- The human chose option A.\n- Added only in the live tree.",
      });
      const again = await verifyJudgeRecord(tmp, recordPath);
      expect(again.notices.filter((notice) => notice.startsWith("Heuristic notice"))).toHaveLength(1);
    });

    it("reports comparison unavailable for WORKTREE without changing the verdict", async () => {
      const { signal, result } = await verifyBoundary({ base: {}, candidate: changedContract, mode: "worktree" });

      expect(signal).toHaveLength(1);
      expect(signal[0]).toContain("comparison unavailable");
      expect(signal[0]).not.toContain("Heuristic notice");
      expect(result.valid).toBe(true);
      expect(result.approved).toBe(true);
    });

    it("reports comparison unavailable when a compared file is missing in the base", async () => {
      await initRepo();
      const task = await runTask("Clarification signal", { cwd: tmp, nonInteractive: true });
      await writeCapsule(task.taskDir, {});
      await rm(path.join(tmp, task.taskDir, "acceptance-criteria.md"));
      await git("add", ".");
      await git("commit", "-m", "base");
      const base = await sha("HEAD");
      await writeCapsule(task.taskDir, {});
      await git("add", ".");
      await git("commit", "-m", "candidate");
      const scope = await createJudgeScope(tmp, task.taskId, base, "HEAD");
      const recordPath = await writeRecord(task, scope, "missing.json");

      const result = await verifyJudgeRecord(tmp, recordPath);

      expect(result.notices.some((notice) => /comparison unavailable.*acceptance-criteria\.md/.test(notice))).toBe(
        true,
      );
      expect(result.approved).toBe(true);
    });

    it("stays inconclusive, with no notice, for a new capsule and for a capsule without Clarifications", async () => {
      const added = await verifyBoundary({ base: {}, candidate: changedContract, capsuleInBase: false });
      expect(added.signal).toEqual([]);
      await reset();

      const predating = await verifyBoundary({ base: { clarifications: null }, candidate: changedContract });
      expect(predating.signal).toEqual([]);
      await reset();

      const later = await verifyBoundary({ base: {}, candidate: { ...changedContract, clarifications: null } });
      expect(later.signal).toEqual([]);
    });

    it("replays TASK-075's first-added capsule as inconclusive: Contract and Clarifications arrive together", async () => {
      const { signal } = await verifyBoundary({
        base: {},
        candidate: {
          contract: "### Statuses\n\nThe status enum is pass, fail or not-evaluated.",
          clarifications: "### Session 2026-09-20\n- Four earlier clarifications were recorded.",
        },
        capsuleInBase: false,
      });
      expect(signal).toEqual([]);
    });
  });

  describe("unexpected failure", () => {
    it("reports comparison unavailable with the reason and never aborts verify", async () => {
      const control = await verifyBoundary({ base: {}, candidate: changedContract });
      const failing = vi
        .spyOn(clarificationSignal, "clarificationSignalNotices")
        .mockRejectedValue(new Error("simulated failure\nsecond line"));
      try {
        const result = await verifyJudgeRecord(tmp, control.recordPath);
        const signal = result.notices.filter(isSignal);

        expect(signal).toEqual([
          "Clarification comparison unavailable: simulated failure. No conclusion about consultation is drawn.",
        ]);
        expect(result.valid).toBe(control.result.valid);
        expect(result.approved).toBe(control.result.approved);
        expect(result.reasons).toEqual(control.result.reasons);
      } finally {
        failing.mockRestore();
      }
    });
  });

  describe("documented detection limits", () => {
    const signalCount = async (base: Capsule, candidate: Capsule) => {
      const { signal } = await verifyBoundary({ base, candidate });
      await reset();
      return signal.length;
    };

    it("false positives: a clearer paraphrase, other punctuation edits and a reorder still notify", async () => {
      expect(await signalCount({}, { contract: "The tool tells you about X." })).toBe(1);
      expect(await signalCount({}, { contract: "The tool reports X!" })).toBe(1);
      expect(
        await signalCount({ contract: "First rule.\n\nSecond rule." }, { contract: "Second rule.\n\nFirst rule." }),
      ).toBe(1);
    });

    it("false negatives: normalization-covered edits, an unrelated bullet and No ambiguity stay silent", async () => {
      expect(await signalCount({ contract: "Is it fast." }, { contract: "Is it fast" })).toBe(0);
      const bullet = (text: string): Capsule => ({
        ...changedContract,
        clarifications: `### Session 2026-10-01\n- The human chose option A.\n- ${text}`,
      });
      expect(await signalCount({}, bullet("Unrelated note."))).toBe(0);
      expect(await signalCount({}, bullet("No ambiguity: self-reported."))).toBe(0);
    });

    it("does not end a section at a ## line inside a fenced code block for either readClarificationState or clarificationSignalNotices", async () => {
      const fencedContract = [
        "Before fence.",
        "```markdown",
        "## Fake Heading Inside Fence",
        "```",
        "After fence: original requirement.",
      ].join("\n");
      const changedAfterFence = [
        "Before fence.",
        "```markdown",
        "## Fake Heading Inside Fence",
        "```",
        "After fence: modified requirement.",
      ].join("\n");
      expect(await signalCount({ contract: fencedContract }, { contract: changedAfterFence })).toBe(1);

      const clarificationsWithFence = [
        "### Session 2026-10-01",
        "- First decision.",
        "  ```markdown",
        "  ## Heading Inside Clarification Fence",
        "  ```",
        "- Second decision after fenced heading.",
      ].join("\n");
      await reset();
      await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
      const task = await runTask("Clarification fence", { cwd: tmp, nonInteractive: true });
      await writeCapsule(task.taskDir, { clarifications: clarificationsWithFence });
      const state = await readClarificationState(tmp, task.taskId);
      expect(state.clarifications).toContain("Second decision after fenced heading.");
    });
  });
});
