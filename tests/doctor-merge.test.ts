import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { DoctorMergeError, readMergeDecisions, runDoctorMerge } from "../src/doctor-merge.js";
import { runDoctor } from "../src/doctor.js";
import { writePlannedFile } from "../src/fs-utils.js";
import { blockHash } from "../src/merge-blocks.js";

const agents = `# Project rules

- Keep this.

## Workflow selection

Old text.
`;

const suggestion = `# AGENTS.md - wep

Intro.

## Workflow Selection

New text.

## Safety

Keep secrets out.
`;

let cwd: string;

async function read(relative: string): Promise<string | undefined> {
  return readFile(path.join(cwd, relative), "utf8").catch(() => undefined);
}

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "wep-merge-"));
  await writeFile(path.join(cwd, "AGENTS.md"), agents);
  await writeFile(path.join(cwd, "AGENTS.wep.suggested.md"), suggestion);
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe("runDoctorMerge", () => {
  it("lists pending blocks with status and diff", async () => {
    const result = await runDoctorMerge({ cwd });
    expect(result.files).toHaveLength(1);
    const [file] = result.files;
    expect(file.file).toBe("AGENTS.md");
    expect(file.suggestion).toBe("AGENTS.wep.suggested.md");
    expect(file.pending.map((block) => [block.id, block.status])).toEqual([
      ["workflow-selection", "changed"],
      ["safety", "new"],
    ]);
    expect(file.pending[0].diff).toEqual([
      "- ## Workflow selection",
      "+ ## Workflow Selection",
      "  ",
      "- Old text.",
      "+ New text.",
    ]);
    expect(await read("AGENTS.md")).toBe(agents);
  });

  it("accepts a block into the protected file and keeps the rest", async () => {
    const result = await runDoctorMerge({ cwd, file: "AGENTS.md", accept: ["workflow-selection"] });
    expect(result.files[0].accepted).toEqual(["workflow-selection"]);
    expect(await read("AGENTS.md")).toBe(
      agents.replace("## Workflow selection\n\nOld text.", "## Workflow Selection\n\nNew text."),
    );
    expect(result.files[0].pending.map((block) => block.id)).toEqual(["safety"]);
    expect(await read("AGENTS.wep.suggested.md")).toBe(suggestion);
  });

  it("rejects a block without touching the protected file and records its hash", async () => {
    await runDoctorMerge({ cwd, file: "AGENTS.md", reject: ["safety"] });
    expect(await read("AGENTS.md")).toBe(agents);
    const decisions = await readMergeDecisions(cwd);
    expect(decisions.files["AGENTS.md"].rejected.safety).toBe(blockHash("## Safety\n\nKeep secrets out."));
    const listed = await runDoctorMerge({ cwd });
    expect(listed.files[0].pending.map((block) => block.id)).toEqual(["workflow-selection"]);
  });

  it("proposes a rejected block again when its content changes", async () => {
    await runDoctorMerge({ cwd, file: "AGENTS.md", reject: ["safety"] });
    await writeFile(
      path.join(cwd, "AGENTS.wep.suggested.md"),
      suggestion.replace("Keep secrets out.", "Never print secrets."),
    );
    const listed = await runDoctorMerge({ cwd });
    expect(listed.files[0].pending.map((block) => block.id)).toEqual(["workflow-selection", "safety"]);
  });

  it("removes the suggestion once nothing is pending", async () => {
    const result = await runDoctorMerge({ cwd, file: "AGENTS.md", accept: ["workflow-selection"], reject: ["safety"] });
    expect(result.files[0].pending).toEqual([]);
    expect(result.files[0].removedSuggestion).toBe(true);
    expect(await read("AGENTS.wep.suggested.md")).toBeUndefined();
  });

  it("removes a suggestion with nothing pending when listing", async () => {
    await writeFile(path.join(cwd, "AGENTS.wep.suggested.md"), "# Title\n\n## Workflow selection\n\nOld text.\n");
    const result = await runDoctorMerge({ cwd });
    expect(result.files[0].removedSuggestion).toBe(true);
    expect(await read("AGENTS.wep.suggested.md")).toBeUndefined();
  });

  it("writes nothing with dryRun", async () => {
    const result = await runDoctorMerge({
      cwd,
      file: "AGENTS.md",
      accept: ["workflow-selection"],
      reject: ["safety"],
      dryRun: true,
    });
    expect(result.files[0].accepted).toEqual(["workflow-selection"]);
    expect(await read("AGENTS.md")).toBe(agents);
    expect(await read("AGENTS.wep.suggested.md")).toBe(suggestion);
    expect(await read(".wep/doctor/merge-decisions.json")).toBeUndefined();
  });

  it.each([
    ["an unknown id", { accept: ["nope"] }],
    ["an id in both lists", { accept: ["safety"], reject: ["safety"] }],
  ])("fails on %s and changes nothing", async (_label, actions) => {
    await expect(runDoctorMerge({ cwd, file: "AGENTS.md", ...actions })).rejects.toBeInstanceOf(DoctorMergeError);
    expect(await read("AGENTS.md")).toBe(agents);
    expect(await read(".wep/doctor/merge-decisions.json")).toBeUndefined();
  });

  it("fails on an id that is not pending", async () => {
    await runDoctorMerge({ cwd, file: "AGENTS.md", reject: ["safety"] });
    await expect(runDoctorMerge({ cwd, file: "AGENTS.md", accept: ["safety"] })).rejects.toThrow("not pending");
  });

  it("requires a file for actions when several suggestions exist", async () => {
    await writeFile(path.join(cwd, "CLAUDE.md"), "# Claude\n");
    await writeFile(path.join(cwd, "CLAUDE.wep.suggested.md"), "# Claude\n\n## Safety\n\nKeep secrets out.\n");
    await expect(runDoctorMerge({ cwd, accept: ["safety"] })).rejects.toThrow("AGENTS.md, CLAUDE.md");
    const listed = await runDoctorMerge({ cwd });
    expect(listed.files.map((file) => file.file)).toEqual(["AGENTS.md", "CLAUDE.md"]);
  });

  it("fails for a file without a suggestion", async () => {
    await expect(runDoctorMerge({ cwd, file: "CLAUDE.md" })).rejects.toThrow("no suggested merge");
  });
});

describe("writePlannedFile for protected markdown", () => {
  it("does not write a suggestion when no block would be pending", async () => {
    await rm(path.join(cwd, "AGENTS.wep.suggested.md"));
    const result = await writePlannedFile(cwd, "AGENTS.md", "# Other title\n\n## Workflow selection\n\nOld text.\n", {
      protected: true,
    });
    expect(result.kind).toBe("preserve");
    expect(await read("AGENTS.wep.suggested.md")).toBeUndefined();
  });

  it("does not write a suggestion whose only differences were rejected", async () => {
    await runDoctorMerge({ cwd, file: "AGENTS.md", accept: ["workflow-selection"], reject: ["safety"] });
    const result = await writePlannedFile(cwd, "AGENTS.md", suggestion, { protected: true });
    expect(result.kind).toBe("preserve");
    expect(await read("AGENTS.wep.suggested.md")).toBeUndefined();
  });

  it("still writes a suggestion with pending blocks", async () => {
    await rm(path.join(cwd, "AGENTS.wep.suggested.md"));
    const result = await writePlannedFile(cwd, "AGENTS.md", suggestion, { protected: true });
    expect(result.kind).toBe("suggest");
    expect(await read("AGENTS.wep.suggested.md")).toBe(suggestion);
  });
});

describe("wep doctor merge (CLI)", () => {
  let previousCwd: string;
  beforeEach(() => {
    previousCwd = process.cwd();
    process.chdir(cwd);
  });
  afterEach(() => {
    process.chdir(previousCwd);
  });

  function capture() {
    const logs: string[] = [];
    const errors: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...args) => void logs.push(args.join(" ")));
    const error = vi.spyOn(console, "error").mockImplementation((...args) => void errors.push(args.join(" ")));
    const restore = () => {
      log.mockRestore();
      error.mockRestore();
    };
    return { logs, errors, restore };
  }

  it("prints pending blocks as JSON", async () => {
    const out = capture();
    try {
      await main(["node", "wep", "doctor", "merge", "--json"]);
    } finally {
      out.restore();
    }
    const parsed = JSON.parse(out.logs.join("\n"));
    expect(parsed.files[0].pending.map((block: { id: string }) => block.id)).toEqual(["workflow-selection", "safety"]);
  });

  it("accepts repeated ids and exits 1 on an unknown id", async () => {
    const previousExitCode = process.exitCode;
    const out = capture();
    try {
      await main([
        "node",
        "wep",
        "doctor",
        "merge",
        "AGENTS.md",
        "--accept",
        "workflow-selection",
        "--accept",
        "safety",
      ]);
      expect(await read("AGENTS.wep.suggested.md")).toBeUndefined();
      process.exitCode = undefined;
      await main(["node", "wep", "doctor", "merge", "AGENTS.md", "--accept", "nope"]);
      expect(process.exitCode).toBe(1);
    } finally {
      out.restore();
      process.exitCode = previousExitCode;
    }
    expect(out.errors.join("\n")).toContain("no suggested merge");
  });
});

describe("wep doctor conflicts", () => {
  it("reports the number of pending blocks and the merge command", async () => {
    const result = await runDoctor({ cwd });
    expect(result.conflicts).toContain(
      "AGENTS.md has a pending suggested merge: AGENTS.wep.suggested.md (2 pending blocks; review with wep doctor merge AGENTS.md)",
    );
    await runDoctorMerge({ cwd, file: "AGENTS.md", reject: ["safety"] });
    expect((await runDoctor({ cwd })).conflicts).toContain(
      "AGENTS.md has a pending suggested merge: AGENTS.wep.suggested.md (1 pending block; review with wep doctor merge AGENTS.md)",
    );
  });
});
