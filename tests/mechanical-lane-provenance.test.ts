import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { pathExists } from "../src/fs-utils.js";
import { runInit } from "../src/init.js";
import { captureJudgeSnapshot } from "../src/judge-snapshot.js";
import { migrateAcceptanceCriteriaIdentifiers, runTask } from "../src/task.js";

import { GENERATOR, RUN, SLOW, mechanicalFixture, reproduce, sh, treeDigest } from "./helpers/mechanical-fixtures.js";
import { tmp, useTempDir } from "./helpers/wep.js";

useTempDir();

describe("TASK-080 mechanical change lane", () => {
  describe("provenance", () => {
    it.each([
      ["a missing review record", "missing", "generator.review"],
      ["a record that is not APPROVED", "needs-changes", "not a verified APPROVED record"],
      ["a record for a commit candidate", "commit-candidate", "immutable SNAPSHOT candidate"],
    ] as const)(
      "refuses %s",
      async (_label, review, reason) => {
        const fixture = await mechanicalFixture({ review });
        const result = await reproduce(fixture);
        expect(result.ok).toBe(false);
        expect(result.commands).toEqual([]);
        expect(result.reasons.join("\n")).toContain(reason);
      },
      SLOW,
    );

    it(
      "refuses a generator whose reviewed content differs from the landed commit",
      async () => {
        const fixture = await mechanicalFixture({ reviewedSource: `${GENERATOR}// reviewed variant\n` });
        const result = await reproduce(fixture);
        expect(result.reasons.join("\n")).toContain("differs between the reviewed content and the landed commit");
      },
      SLOW,
    );

    it(
      "refuses a generator modified after it landed",
      async () => {
        const fixture = await mechanicalFixture({
          afterLanding: async () => {
            await writeFile(path.join(tmp, "tools/gen.mjs"), `${GENERATOR}// tampered\n`);
            await sh("add", "-A");
            await sh("commit", "-m", "tamper with the generator");
          },
        });
        const result = await reproduce(fixture);
        expect(result.reasons.join("\n")).toContain("tools/gen.mjs was modified after the landed commit");
      },
      SLOW,
    );

    it(
      "refuses a generator that exists only in the candidate",
      async () => {
        const fixture = await mechanicalFixture({
          inputs: ["tools/gen.mjs", "tools/bootstrap.mjs"],
          editCandidate: async () => writeFile(path.join(tmp, "tools/bootstrap.mjs"), "export {};\n"),
        });
        const result = await reproduce(fixture);
        expect(result.commands).toEqual([]);
        expect(result.reasons.join("\n")).toContain("tools/bootstrap.mjs is not a regular file in the landed commit");
      },
      SLOW,
    );

    it(
      "refuses a landed commit that is not an ancestor of the base",
      async () => {
        const fixture = await mechanicalFixture();
        const sidelined = await sh("commit-tree", "HEAD^{tree}", "-m", "unrelated");
        await fixture.declare({
          generator: {
            command: RUN,
            commit: sidelined,
            review: ".wep/local/judge/generator-approved.json",
            inputs: ["tools/gen.mjs"],
            prepare: [],
          },
          paths: ["data/a.txt", "data/b.txt"],
        });
        const snapshot = await captureJudgeSnapshot(tmp, fixture.task.taskId, "HEAD");
        const result = await reproduce({ ...fixture, candidate: snapshot.candidate });
        expect(result.reasons.join("\n")).toContain("is not an ancestor of the mechanical base");
      },
      SLOW,
    );
  });

  describe("approval and scope", () => {
    it(
      "runs nothing when the operator denies the ordered command list",
      async () => {
        const sentinel = path.join(tmp, "..", `wep-sentinel-${process.pid}.txt`);
        const fixture = await mechanicalFixture({
          prepare: [`node -e "require('fs').writeFileSync(${JSON.stringify(sentinel)}, 'ran')"`],
        });
        let shown: string[] = [];

        const result = await reproduce(fixture, async (commands) => {
          shown = commands;
          return false;
        });

        expect(result.ok).toBe(false);
        expect(shown).toHaveLength(2);
        expect(shown[1]).toBe(RUN);
        expect(await pathExists(sentinel)).toBe(false);
        expect(result.reasons.join("\n")).toContain("Operator approval was not given");
      },
      SLOW,
    );

    it(
      "never runs without an approval callback",
      async () => {
        const fixture = await mechanicalFixture();
        const { reproduceMechanicalChange } = await import("../src/mechanical-reproduction.js");
        const result = await reproduceMechanicalChange(tmp, fixture.task.taskId, {
          base: "HEAD",
          candidate: fixture.candidate,
        });
        expect(result.ok).toBe(false);
        expect(result.reproduced).toEqual([]);
      },
      SLOW,
    );

    it(
      "keeps the foreign-capsule rule: capture needs --include-task and the declaration grants nothing",
      async () => {
        const fixture = await mechanicalFixture();
        const foreign = await runTask("A foreign capsule", { cwd: tmp, nonInteractive: true });
        await writeFile(
          path.join(tmp, foreign.taskDir, "acceptance-criteria.md"),
          "# Acceptance Criteria\n\n- AC-1: Changed.\n",
        );
        await sh("add", "-A");
        await sh("commit", "-m", "foreign capsule");
        const foreignSecond = await runTask("Another foreign capsule", { cwd: tmp, nonInteractive: true });
        await sh("add", "-A");
        await sh("commit", "-m", "second foreign capsule");
        await writeFile(
          path.join(tmp, foreign.taskDir, "acceptance-criteria.md"),
          "# Acceptance Criteria\n\n- AC-1: Edited.\n",
        );
        await writeFile(
          path.join(tmp, foreignSecond.taskDir, "acceptance-criteria.md"),
          "# Acceptance Criteria\n\n- AC-1: Edited.\n",
        );

        await expect(captureJudgeSnapshot(tmp, fixture.task.taskId, "HEAD")).rejects.toThrow(/foreign task capsule/);
        const authorized = await captureJudgeSnapshot(tmp, fixture.task.taskId, "HEAD", [
          foreign.taskId,
          foreignSecond.taskId,
        ]);

        const withoutInclude = await reproduce({ ...fixture, candidate: authorized.candidate });
        expect(withoutInclude.ok).toBe(false);
        expect(withoutInclude.reasons.join("\n")).toContain("different --include-task scope");
      },
      SLOW,
    );

    it(
      "rejects a base that is not the snapshot base",
      async () => {
        const fixture = await mechanicalFixture();
        const { reproduceMechanicalChange } = await import("../src/mechanical-reproduction.js");
        const result = await reproduceMechanicalChange(tmp, fixture.task.taskId, {
          base: "HEAD~1",
          candidate: fixture.candidate,
          approve: async () => true,
        });
        expect(result.reasons.join("\n")).toContain("does not resolve to the snapshot base");
      },
      SLOW,
    );

    it(
      "rejects a candidate that is not a snapshot",
      async () => {
        const fixture = await mechanicalFixture();
        const { reproduceMechanicalChange } = await import("../src/mechanical-reproduction.js");
        const result = await reproduceMechanicalChange(tmp, fixture.task.taskId, {
          base: "HEAD",
          candidate: "WORKTREE",
          approve: async () => true,
        });
        expect(result.reasons.join("\n")).toContain("immutable SNAPSHOT candidate");
      },
      SLOW,
    );
  });

  describe("CLI judge reproduce", () => {
    const runCli = async (args: string[]) => {
      const previousCwd = process.cwd();
      const originalLog = console.log;
      const originalExitCode = process.exitCode;
      const writes: string[] = [];
      console.log = (message?: unknown) => {
        writes.push(String(message));
      };
      try {
        process.chdir(tmp);
        await main(["node", "wep", ...args]);
      } finally {
        process.chdir(previousCwd);
        console.log = originalLog;
      }
      const exitCode = process.exitCode;
      process.exitCode = originalExitCode;
      return { output: writes.join("\n"), exitCode };
    };

    it(
      "refuses headless without --approve-commands, then reproduces with the exact list",
      async () => {
        const fixture = await mechanicalFixture();
        const base = ["judge", "reproduce", fixture.task.taskId, "--base", "HEAD", "--candidate", fixture.candidate];

        const refused = await runCli(base);
        expect(refused.exitCode).toBe(1);
        expect(refused.output).toContain("NOT REPRODUCED");
        expect(refused.output).toContain("WEP_GENERATOR_ROOT");

        const wrong = await runCli([...base, "--approve-commands", "echo hi"]);
        expect(wrong.exitCode).toBe(1);

        const approved = await runCli([...base, "--approve-commands", RUN]);
        expect(approved.exitCode).toBeUndefined();
        expect(approved.output).toContain("REPRODUCED");
        expect(approved.output).toContain("process isolation, not an OS sandbox");
      },
      SLOW,
    );

    it(
      "keeps JSON parseable on stdout when headless approval is missing",
      async () => {
        const fixture = await mechanicalFixture();
        const { output, exitCode } = await runCli([
          "judge",
          "reproduce",
          fixture.task.taskId,
          "--base",
          "HEAD",
          "--candidate",
          fixture.candidate,
          "--json",
        ]);
        const report = JSON.parse(output);
        expect(exitCode).toBe(1);
        expect(report.ok).toBe(false);
        expect(report.commands).toEqual([RUN]);
        expect(report.generatorRoot).toEqual(expect.stringContaining("wep-generator-tool-"));
      },
      SLOW,
    );

    it(
      "emits JSON and writes no result file",
      async () => {
        const fixture = await mechanicalFixture();
        const before = await treeDigest(tmp);
        const { output, exitCode } = await runCli([
          "judge",
          "reproduce",
          fixture.task.taskId,
          "--base",
          "HEAD",
          "--candidate",
          fixture.candidate,
          "--approve-commands",
          RUN,
          "--json",
        ]);
        expect(exitCode).toBeUndefined();
        expect(JSON.parse(output)).toMatchObject({ ok: true, reproduced: ["data/a.txt", "data/b.txt"] });
        expect(await treeDigest(tmp)).toBe(before);
      },
      SLOW,
    );
  });

  describe("shipped contract", () => {
    it("states what reproduction proves and what it does not", async () => {
      await runInit({ cwd: tmp, target: "codex", nonInteractive: true });
      const readme = await readFile(path.join(tmp, ".wep/judge/README.md"), "utf8");
      const section = readme.slice(readme.indexOf("## Mechanical change reproduction"));

      expect(section).toContain("wep judge reproduce");
      expect(section).toContain("It does not approve the generator");
      expect(section).toContain("process isolation, not an OS sandbox");
      expect(section).toContain("--include-task");
      expect(section).toContain("only idempotency");
    });
  });

  describe("TASK-075 adapted two-step fixture", () => {
    // Adapted reproduction: the criterion migration generator is placed in the base and reviewed
    // first, then the migration is reproduced. It is not the original command in its historical base.
    it(
      "reproduces the criterion migration of several capsules from a previously reviewed generator",
      async () => {
        const { build } = await import("esbuild");
        const repoRoot = path.resolve(import.meta.dirname, "..");
        const bundle = await build({
          stdin: {
            contents: `import { migrateAcceptanceCriteriaIdentifiers } from "./src/task.ts";\nawait migrateAcceptanceCriteriaIdentifiers(process.cwd());\n`,
            resolveDir: repoRoot,
            loader: "ts",
          },
          bundle: true,
          platform: "node",
          format: "esm",
          write: false,
          banner: {
            js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
          },
        });
        const legacy: Array<{ taskId: string; taskDir: string }> = [];
        const fixture = await mechanicalFixture({
          generatorSource: bundle.outputFiles[0].text,
          baseFiles: { "data/a.txt": "a\n" },
          setupBase: async () => {
            for (const name of ["First legacy capsule", "Second legacy capsule", "Third legacy capsule"]) {
              const created = await runTask(name, { cwd: tmp, nonInteractive: true });
              await writeFile(
                path.join(tmp, created.taskDir, "acceptance-criteria.md"),
                "# Acceptance Criteria\n\n- First behavior.\n- Second behavior.\n",
              );
              legacy.push(created);
            }
          },
          paths: () => legacy.map((capsule) => `${capsule.taskDir}/acceptance-criteria.md`),
          generateCandidate: async () => {
            await migrateAcceptanceCriteriaIdentifiers(tmp);
          },
          includeTaskIds: () => legacy.map((capsule) => capsule.taskId),
        });

        await expect(captureJudgeSnapshot(tmp, fixture.task.taskId, "HEAD")).rejects.toThrow(/foreign task capsule/);
        const before = await treeDigest(tmp);
        const result = await reproduce(fixture);

        expect(result.reasons).toEqual([]);
        expect(result.ok).toBe(true);
        expect(result.reproduced).toHaveLength(3);
        expect(await treeDigest(tmp)).toBe(before);
      },
      SLOW,
    );
  });
});
