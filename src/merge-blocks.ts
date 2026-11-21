import { createHash } from "node:crypto";

/**
 * Block model for Doctor suggested merges.
 *
 * A suggestion is split into one block per `##` section. A block runs from its heading to the next
 * heading of level 1 or 2 outside a code fence. Text before the first `##` (title, intro) is the
 * preamble and is never a block: replacing a project's own title is not something to propose.
 */
export interface MergeBlock {
  /** Stable id slugged from the heading text, unique within the suggestion. */
  id: string;
  /** Heading text without the `## ` marker. */
  title: string;
  /** Heading line and body, without trailing blank lines. */
  content: string;
  /** Hash of the normalized content; a rejection holds until this changes. */
  hash: string;
  /** How many earlier blocks share this heading; matched against the same occurrence in the file. */
  occurrence: number;
}

export interface PendingBlock {
  id: string;
  title: string;
  status: "new" | "changed";
  block: MergeBlock;
  /** The protected file's current section for a changed block, without trailing blank lines. */
  currentSection?: string;
}

interface Section {
  title: string;
  level: number;
  /** Offset of the heading line. */
  start: number;
  /** Offset of the next heading of level <= 2, or the end of the text. */
  end: number;
}

const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
// A fence closes only with the same character, at least as long as the opener (CommonMark).
const FENCE_OPEN = /^[ \t]*(`{3,}|~{3,})/;
const FENCE_CLOSE = /^[ \t]*(`{3,}|~{3,})[ \t]*$/;

/** Headings of level 1 and 2 outside code fences, with their extent. */
function sections(text: string): Section[] {
  const found: Section[] = [];
  let offset = 0;
  let fence: string | undefined;
  for (const line of text.split("\n")) {
    if (fence) {
      const close = FENCE_CLOSE.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = undefined;
    } else if (FENCE_OPEN.test(line)) {
      fence = (FENCE_OPEN.exec(line) as RegExpExecArray)[1];
    } else {
      const heading = HEADING.exec(line);
      if (heading && heading[1].length <= 2) {
        found.push({ title: heading[2], level: heading[1].length, start: offset, end: text.length });
      }
    }
    offset += line.length + 1;
  }
  for (let index = 0; index < found.length - 1; index += 1) found[index].end = found[index + 1].start;
  return found;
}

function trimTrailing(text: string): string {
  return text.replace(/\s+$/, "");
}

function normalize(text: string): string {
  return trimTrailing(
    text
      .split("\n")
      .map((line) => line.replace(/[ \t]+$/, ""))
      .join("\n"),
  );
}

function bodyOf(section: string): string {
  const newline = section.indexOf("\n");
  return newline === -1 ? "" : section.slice(newline + 1);
}

function titleKey(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export function blockId(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "section";
}

export function blockHash(content: string): string {
  return `sha256:${createHash("sha256").update(normalize(content)).digest("hex")}`;
}

export function parseBlocks(markdown: string): { preamble: string; blocks: MergeBlock[] } {
  const all = sections(markdown);
  const firstBlock = all.find((section) => section.level === 2);
  const preamble = markdown.slice(0, firstBlock ? firstBlock.start : markdown.length);
  const used = new Map<string, number>();
  const seenTitles = new Map<string, number>();
  const blocks = all
    .filter((section) => section.level === 2)
    .map((section) => {
      const base = blockId(section.title);
      const count = (used.get(base) ?? 0) + 1;
      used.set(base, count);
      const occurrence = seenTitles.get(titleKey(section.title)) ?? 0;
      seenTitles.set(titleKey(section.title), occurrence + 1);
      const content = trimTrailing(markdown.slice(section.start, section.end));
      const id = count === 1 ? base : `${base}-${count}`;
      return { id, title: section.title, content, hash: blockHash(content), occurrence };
    });
  return { preamble, blocks };
}

/** The `occurrence`-th `##` section whose heading matches `title` case-insensitively. */
function findSection(markdown: string, title: string, occurrence: number): Section | undefined {
  const key = titleKey(title);
  return sections(markdown).filter((section) => section.level === 2 && titleKey(section.title) === key)[occurrence];
}

/** Blocks of `suggestion` that differ from `current` and are not rejected with the same hash. */
export function pendingBlocks(current: string, suggestion: string, rejected: Record<string, string>): PendingBlock[] {
  const pending: PendingBlock[] = [];
  for (const block of parseBlocks(suggestion).blocks) {
    if (rejected[block.id] === block.hash) continue;
    const section = findSection(current, block.title, block.occurrence);
    if (!section) {
      pending.push({ id: block.id, title: block.title, status: "new", block });
      continue;
    }
    const currentSection = trimTrailing(current.slice(section.start, section.end));
    // Headings already matched case-insensitively, so only the bodies decide whether it changed.
    if (normalize(bodyOf(currentSection)) === normalize(bodyOf(block.content))) continue;
    pending.push({ id: block.id, title: block.title, status: "changed", block, currentSection });
  }
  return pending;
}

/**
 * Write `block` into `current`: replace the section with the same heading, keeping the whitespace that
 * separated it from what follows, or append it at the end after one blank line. Nothing else changes.
 */
export function applyBlock(current: string, block: MergeBlock): string {
  const section = findSection(current, block.title, block.occurrence);
  if (section) {
    const original = current.slice(section.start, section.end);
    const separator = original.slice(trimTrailing(original).length);
    return `${current.slice(0, section.start)}${block.content}${separator}${current.slice(section.end)}`;
  }
  const base = current.endsWith("\n") ? current : `${current}\n`;
  return `${base}\n${block.content}\n`;
}

/** Line diff from `before` to `after`: "  " kept, "- " removed, "+ " added. */
export function lineDiff(before: string, after: string): string[] {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push(`  ${a[i]}`);
      i += 1;
      j += 1;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push(`- ${a[i]}`);
      i += 1;
    } else {
      out.push(`+ ${b[j]}`);
      j += 1;
    }
  }
  while (i < a.length) out.push(`- ${a[i++]}`);
  while (j < b.length) out.push(`+ ${b[j++]}`);
  return out;
}
