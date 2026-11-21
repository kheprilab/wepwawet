import { describe, expect, it } from "vitest";
import { applyBlock, blockHash, lineDiff, parseBlocks, pendingBlocks } from "../src/merge-blocks.js";

const suggestion = `# AGENTS.md - wep

Intro paragraph.

## Mandatory Behavior

1. Read config.
2. Create a capsule.

## Workflow Selection

Pick the smallest workflow.

\`\`\`md
## Not a heading inside a fence
\`\`\`

## Safety

Keep secrets out.
`;

describe("parseBlocks", () => {
  it("splits on ## headings, ignores fenced headings and keeps the preamble out", () => {
    const { preamble, blocks } = parseBlocks(suggestion);
    expect(preamble).toBe("# AGENTS.md - wep\n\nIntro paragraph.\n\n");
    expect(blocks.map((block) => block.id)).toEqual(["mandatory-behavior", "workflow-selection", "safety"]);
    expect(blocks[1].title).toBe("Workflow Selection");
    expect(blocks[1].content).toContain("## Not a heading inside a fence");
    expect(blocks[2].content).toBe("## Safety\n\nKeep secrets out.");
  });

  it("makes repeated ids unique", () => {
    const { blocks } = parseBlocks("## Notes\n\na\n\n## Notes\n\nb\n");
    expect(blocks.map((block) => block.id)).toEqual(["notes", "notes-2"]);
  });

  it("ends a block at a level-1 heading", () => {
    const { blocks } = parseBlocks("## One\n\nbody\n\n# Top\n\nrest\n");
    expect(blocks[0].content).toBe("## One\n\nbody");
  });

  it("hashes content independently of trailing whitespace", () => {
    expect(blockHash("## A\n\ntext  \n\n\n")).toBe(blockHash("## A\n\ntext"));
    expect(blockHash("## A\n\ntext")).not.toBe(blockHash("## A\n\nother"));
  });
});

const current = `# Repository rules

- Custom rule.

# AGENTS.md

## Mandatory behavior

1. Read config.
2. Create a capsule.

## Workflow selection

Old workflow text.

## Before handoff

Run the tests.
`;

describe("pendingBlocks", () => {
  it("reports new and changed blocks and skips identical ones (case-insensitive headings)", () => {
    const pending = pendingBlocks(current, suggestion, {});
    expect(pending.map((block) => [block.id, block.status])).toEqual([
      ["workflow-selection", "changed"],
      ["safety", "new"],
    ]);
    expect(pending[0].currentSection).toBe("## Workflow selection\n\nOld workflow text.");
  });

  it("skips a block rejected with the same hash and shows it again when it changes", () => {
    const safety = parseBlocks(suggestion).blocks[2];
    expect(pendingBlocks(current, suggestion, { safety: safety.hash }).map((block) => block.id)).toEqual([
      "workflow-selection",
    ]);
    const changed = suggestion.replace("Keep secrets out.", "Keep all secrets out.");
    expect(pendingBlocks(current, changed, { safety: safety.hash }).map((block) => block.id)).toEqual([
      "workflow-selection",
      "safety",
    ]);
  });
});

describe("applyBlock", () => {
  it("replaces only the matching section and keeps every other byte", () => {
    const block = parseBlocks(suggestion).blocks[1];
    const next = applyBlock(current, block);
    expect(next).toBe(
      current.replace(
        "## Workflow selection\n\nOld workflow text.",
        "## Workflow Selection\n\nPick the smallest workflow.\n\n```md\n## Not a heading inside a fence\n```",
      ),
    );
  });

  it("appends a new block at the end with one blank line", () => {
    const block = parseBlocks(suggestion).blocks[2];
    expect(applyBlock(current, block)).toBe(`${current}\n## Safety\n\nKeep secrets out.\n`);
    expect(applyBlock("No trailing newline", block)).toBe("No trailing newline\n\n## Safety\n\nKeep secrets out.\n");
  });

  it("replaces the last section of a file", () => {
    const block = { ...parseBlocks("## Before handoff\n\nRun lint too.\n").blocks[0] };
    expect(applyBlock(current, block)).toBe(current.replace("Run the tests.", "Run lint too."));
  });

  it("leaves the block no longer pending", () => {
    let next = current;
    for (const block of pendingBlocks(current, suggestion, {})) next = applyBlock(next, block.block);
    expect(pendingBlocks(next, suggestion, {})).toEqual([]);
  });
});

describe("lineDiff", () => {
  it("marks removed, added and kept lines", () => {
    expect(lineDiff("a\nb\nc", "a\nx\nc")).toEqual(["  a", "- b", "+ x", "  c"]);
    expect(lineDiff("", "## New\n\nbody")).toEqual(["+ ## New", "+ ", "+ body"]);
  });
});

describe("edge cases from review", () => {
  it("matches repeated headings by occurrence", () => {
    const file = "## Notes\n\nfirst\n\n## Notes\n\nsecond old\n";
    const proposal = "## Notes\n\nfirst\n\n## Notes\n\nsecond new\n";
    const pending = pendingBlocks(file, proposal, {});
    expect(pending.map((block) => [block.id, block.status])).toEqual([["notes-2", "changed"]]);
    expect(applyBlock(file, pending[0].block)).toBe("## Notes\n\nfirst\n\n## Notes\n\nsecond new\n");
  });

  it("keeps a four-backtick fence open across an inner three-backtick line", () => {
    const text = "## One\n\n````md\n```\n## Inside\n```\n````\n\n## Two\n\nbody\n";
    expect(parseBlocks(text).blocks.map((block) => block.id)).toEqual(["one", "two"]);
  });

  it("closes a fence only with the same character", () => {
    const text = "## One\n\n~~~\n```\n## Inside\n~~~\n\n## Two\n";
    expect(parseBlocks(text).blocks.map((block) => block.id)).toEqual(["one", "two"]);
  });
});
