import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadJudgeSnapshot } from "../src/judge-snapshot.js";

import { RUN, SLOW, mechanicalFixture, reproduce, treeDigest } from "./helpers/mechanical-fixtures.js";
import { tmp, useTempDir } from "./helpers/wep.js";

useTempDir();

describe("TASK-080 mechanical change lane", () => {
  describe("declaration", () => {
    async function read(value: unknown, raw?: string) {
      const { readMigrationDeclaration } = await import("../src/mechanical-reproduction.js");
      const dir = path.join(tmp, "capsule");
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, "task.md"),
        `# T\n\n## Migration\n\n\`\`\`json\n${raw ?? JSON.stringify(value)}\n\`\`\`\n`,
      );
      return readMigrationDeclaration(dir, [".env", "secrets/"]);
    }
    type Declaration = { generator: Record<string, unknown>; paths: unknown };
    const valid = (): Declaration => ({
      generator: {
        command: "node tool.mjs",
        commit: "a".repeat(40),
        review: ".wep/local/judge/r.json",
        inputs: ["tools/gen.mjs"],
        prepare: [],
      },
      paths: ["data/a.txt"],
    });

    it("accepts the documented shape, including an empty prepare list", async () => {
      const result = await read(valid());
      expect(result.problems).toEqual([]);
      expect(result.declaration?.paths).toEqual(["data/a.txt"]);
    });

    it.each([
      ["an unknown top-level key", (d: Declaration) => ({ ...d, extra: 1 }), "Unknown key in migration: extra"],
      [
        "an unknown generator key",
        (d: Declaration) => ({ ...d, generator: { ...d.generator, shell: "sh" } }),
        "Unknown key in generator: shell",
      ],
      [
        "an empty command",
        (d: Declaration) => ({ ...d, generator: { ...d.generator, command: " " } }),
        "generator.command must be a non-empty string",
      ],
      [
        "a short commit",
        (d: Declaration) => ({ ...d, generator: { ...d.generator, commit: "abc123" } }),
        "full Git SHA",
      ],
      [
        "an empty review",
        (d: Declaration) => ({ ...d, generator: { ...d.generator, review: "" } }),
        "generator.review must be a non-empty string",
      ],
      [
        "empty inputs",
        (d: Declaration) => ({ ...d, generator: { ...d.generator, inputs: [] } }),
        "generator.inputs must be a non-empty array",
      ],
      [
        "duplicate inputs",
        (d: Declaration) => ({ ...d, generator: { ...d.generator, inputs: ["a.mjs", "a.mjs"] } }),
        "generator.inputs lists a.mjs more than once",
      ],
      [
        "a missing prepare list",
        (d: Declaration) => ({ ...d, generator: { ...d.generator, prepare: undefined } }),
        "generator.prepare must be an array",
      ],
      [
        "a malformed prepare entry",
        (d: Declaration) => ({ ...d, generator: { ...d.generator, prepare: ["ok", 3] } }),
        "generator.prepare[1]",
      ],
      ["empty paths", (d: Declaration) => ({ ...d, paths: [] }), "paths must be a non-empty array"],
      [
        "duplicate paths",
        (d: Declaration) => ({ ...d, paths: ["a.txt", "a.txt"] }),
        "paths lists a.txt more than once",
      ],
      ["an absolute path", (d: Declaration) => ({ ...d, paths: ["/etc/passwd"] }), "must not be absolute"],
      ["a traversal path", (d: Declaration) => ({ ...d, paths: ["../x.txt"] }), "must not traverse upward"],
      ["a glob", (d: Declaration) => ({ ...d, paths: ["data/*.txt"] }), "exact path, not a glob"],
      ["a directory path", (d: Declaration) => ({ ...d, paths: ["data/"] }), "normalized file path"],
      ["an unnormalized path", (d: Declaration) => ({ ...d, paths: ["data//a.txt"] }), "normalized file path"],
      ["a .git path", (d: Declaration) => ({ ...d, paths: [".git/config"] }), "must not touch .git"],
      ["a blocked path", (d: Declaration) => ({ ...d, paths: [".env"] }), "blocked by blockedReadPatterns"],
    ])("refuses %s with a named reason", async (_label, mutate, reason) => {
      const result = await read(mutate(valid()));
      expect(result.declaration).toBeNull();
      expect(result.problems.join("\n")).toContain(reason);
    });

    it("refuses text that is not one JSON object", async () => {
      expect((await read(null, "{ nope")).problems[0]).toContain("not valid JSON");
      expect((await read(null, "[]")).problems[0]).toContain("must be a JSON object");
    });

    it("reports a capsule without a Migration section", async () => {
      const { readMigrationDeclaration } = await import("../src/mechanical-reproduction.js");
      await mkdir(path.join(tmp, "plain"), { recursive: true });
      await writeFile(path.join(tmp, "plain/task.md"), "# T\n\n## Validation\n");
      const result = await readMigrationDeclaration(path.join(tmp, "plain"), []);
      expect(result.sectionPresent).toBe(false);
      expect(result.declaration).toBeNull();
    });
  });

  describe("reproduction", () => {
    it(
      "reproduces the generated paths exactly and leaves the project and snapshot untouched",
      async () => {
        const fixture = await mechanicalFixture({ prepare: ['node -e "process.exit(0)"'] });
        const before = await treeDigest(tmp);
        const seen: string[][] = [];

        const result = await reproduce(fixture, async (commands) => {
          seen.push(commands);
          return true;
        });

        expect(result.reasons).toEqual([]);
        expect(result.ok).toBe(true);
        expect(result.reproduced).toEqual(["data/a.txt", "data/b.txt"]);
        expect(seen).toEqual([['node -e "process.exit(0)"', RUN]]);
        expect(result.nonGeneratedChanges).toContain(`${fixture.task.taskDir}/task.md`);
        expect(await treeDigest(tmp)).toBe(before);
        await expect(loadJudgeSnapshot(tmp, fixture.candidate)).resolves.toBeDefined();
      },
      SLOW,
    );

    it(
      "names a generated path that differs from the candidate",
      async () => {
        const fixture = await mechanicalFixture({
          editCandidate: async () => writeFile(path.join(tmp, "data/b.txt"), "BETA edited by hand\n"),
        });

        const result = await reproduce(fixture);

        expect(result.ok).toBe(false);
        expect(result.differing).toEqual(["data/b.txt"]);
        expect(result.reproduced).toEqual(["data/a.txt"]);
        expect(result.reasons.join("\n")).toContain("data/b.txt does not match the candidate (bytes)");
      },
      SLOW,
    );

    it(
      "does not accept idempotency: a candidate that equals the base is an error",
      async () => {
        const fixture = await mechanicalFixture({
          baseFiles: { "data/a.txt": "ALPHA\n", "data/b.txt": "BETA\n", "data/c.txt": "g\n", "data/old.txt": "o\n" },
          skipGeneration: true,
        });

        const result = await reproduce(fixture);

        expect(result.ok).toBe(false);
        expect(result.reasons.join("\n")).toContain("Declared path data/a.txt has no change");
        expect(result.reasons.join("\n")).toContain("Declared path data/b.txt has no change");
      },
      SLOW,
    );

    it(
      "compares the executable bit",
      async () => {
        const exec = await mechanicalFixture({
          command: `${RUN} --exec`,
          editCandidate: async () => undefined,
        });
        const execResult = await reproduce(exec);
        expect(execResult.differing).toContain("data/a.txt");
        expect(execResult.reasons.join("\n")).toContain("data/a.txt does not match the candidate (executable bit)");
      },
      SLOW,
    );

    it(
      "detects a changed symlink target without following it",
      async () => {
        const fixture = await mechanicalFixture({
          command: `${RUN} --relink`,
          paths: ["data/a.txt", "data/b.txt", "data/link.txt"],
          editCandidate: async () => {
            await rm(path.join(tmp, "data/link.txt"));
            await symlink("target-c", path.join(tmp, "data/link.txt"));
          },
        });

        const result = await reproduce(fixture);

        expect(result.differing).toEqual(["data/link.txt"]);
        expect(result.reasons.join("\n")).toContain("data/link.txt does not match the candidate (symlink target)");
      },
      SLOW,
    );

    it(
      "reproduces a symlink retarget when the candidate matches",
      async () => {
        const fixture = await mechanicalFixture({
          command: `${RUN} --relink`,
          paths: ["data/a.txt", "data/b.txt", "data/link.txt"],
          editCandidate: async () => {
            await rm(path.join(tmp, "data/link.txt"));
            await symlink("target-b", path.join(tmp, "data/link.txt"));
          },
        });

        const result = await reproduce(fixture);

        expect(result.reasons).toEqual([]);
        expect(result.reproduced).toContain("data/link.txt");
      },
      SLOW,
    );

    it(
      "detects a file replaced by a symlink in the candidate",
      async () => {
        const fixture = await mechanicalFixture({
          editCandidate: async () => {
            await rm(path.join(tmp, "data/a.txt"));
            await symlink("elsewhere", path.join(tmp, "data/a.txt"));
          },
        });

        const result = await reproduce(fixture);

        expect(result.reasons.join("\n")).toContain("data/a.txt does not match the candidate (file type)");
      },
      SLOW,
    );

    it(
      "covers deletions and additions",
      async () => {
        const deleted = await mechanicalFixture({
          command: `${RUN} --delete`,
          paths: ["data/a.txt", "data/b.txt", "data/old.txt"],
          editCandidate: async () => rm(path.join(tmp, "data/old.txt")),
        });
        expect((await reproduce(deleted)).reasons).toEqual([]);
      },
      SLOW,
    );

    it(
      "names a deletion the candidate did not make",
      async () => {
        const kept = await mechanicalFixture({
          command: `${RUN} --delete`,
          paths: ["data/a.txt", "data/b.txt", "data/old.txt"],
        });
        const result = await reproduce(kept);
        expect(result.reasons.join("\n")).toContain("data/old.txt does not match the candidate (existence)");
      },
      SLOW,
    );

    it(
      "names an addition the candidate lacks",
      async () => {
        const fixture = await mechanicalFixture({
          command: `${RUN} --add`,
          paths: ["data/a.txt", "data/b.txt", "data/new.txt"],
        });
        const result = await reproduce(fixture);
        expect(result.reasons.join("\n")).toContain("data/new.txt does not match the candidate (existence)");
      },
      SLOW,
    );

    it(
      "fails on a write outside the declared paths, including an ignored output",
      async () => {
        const fixture = await mechanicalFixture({
          command: `${RUN} --stray`,
          editCandidate: async () => undefined,
        });

        const result = await reproduce(fixture);

        expect(result.ok).toBe(false);
        expect(result.unexpectedWrites).toContain("ignored/out.txt");
        expect(result.reasons.join("\n")).toContain("wrote outside the declared paths");
      },
      SLOW,
    );

    it(
      "fails on a write-then-restore of an undeclared file",
      async () => {
        const fixture = await mechanicalFixture({ command: `${RUN} --touch` });

        const result = await reproduce(fixture);

        expect(result.unexpectedWrites).toEqual(["data/c.txt"]);
        expect(result.ok).toBe(false);
      },
      SLOW,
    );

    it(
      "fails on a file created and deleted in the worktree root",
      async () => {
        const fixture = await mechanicalFixture({ command: `${RUN} --rootblip` });

        const result = await reproduce(fixture);

        expect(result.ok).toBe(false);
        expect(result.unexpectedWrites).toContain(".");
      },
      SLOW,
    );

    it(
      "refuses a declared path behind a symlinked directory",
      async () => {
        const fixture = await mechanicalFixture({
          paths: ["data/a.txt", "linked/x.txt"],
          editCandidate: async () => {
            await symlink("data", path.join(tmp, "linked"));
          },
        });

        const result = await reproduce(fixture);

        expect(result.reasons.join("\n")).toContain("paths entry linked/x.txt has a symlink ancestor: linked");
      },
      SLOW,
    );
  });
});
