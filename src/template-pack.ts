import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { emitTemplateAgent, hasAgentFormat, templateAgentPiWarning } from "./agents.js";
import { isDirectory, pathExists, toPosix } from "./fs-utils.js";
import type { Target } from "./types.js";

export interface TemplatePack {
  name: string;
  version: string;
  config?: unknown;
  policy?: unknown;
  wikiFiles: Record<string, string>;
  rootInstructions?: string;
  targetFiles: Record<string, string>;
  warnings?: string[];
}

export interface TemplatePackSummary {
  name: string;
  version: string;
}

interface PackManifest {
  name?: unknown;
  version?: unknown;
  wepPackVersion?: unknown;
}

export async function loadTemplatePack(cwd: string, templatePackPath: string, target: Target): Promise<TemplatePack> {
  const packRoot = path.resolve(cwd, templatePackPath);
  return loadTemplatePackRoot(packRoot, templatePackPath, target);
}

export async function loadBundledTemplatePack(templateName: string, target: Target): Promise<TemplatePack> {
  if (!/^[a-zA-Z0-9._-]+$/.test(templateName)) {
    throw new Error(`Invalid template name: ${templateName}`);
  }

  const packRoot = path.join(bundledTemplatesRoot(), templateName);
  return loadTemplatePackRoot(packRoot, templateName, target);
}

export async function listBundledTemplatePacks(): Promise<TemplatePackSummary[]> {
  const templatesRoot = bundledTemplatesRoot();
  if (!(await isDirectory(templatesRoot))) return [];

  const entries = await readdir(templatesRoot, { withFileTypes: true });
  const summaries: TemplatePackSummary[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      summaries.push(await readManifest(path.join(templatesRoot, entry.name)));
    } catch {
      // Ignore directories that are not valid template packs.
    }
  }

  return summaries.sort((a, b) => a.name.localeCompare(b.name));
}

async function loadTemplatePackRoot(packRoot: string, label: string, target: Target): Promise<TemplatePack> {
  if (!(await isDirectory(packRoot))) {
    throw new Error(`Template pack not found or not a directory: ${label}`);
  }

  const manifest = await readManifest(packRoot);
  await assertNoUnsupportedRootDirs(packRoot);
  const { targetFiles, warnings } = await readTargetFiles(path.join(packRoot, "target"), target);

  return {
    name: manifest.name,
    version: manifest.version,
    config: await readJsonIfExists(path.join(packRoot, "config.json"), "config.json"),
    policy: await readJsonIfExists(path.join(packRoot, "policy.json"), "policy.json"),
    wikiFiles: await readMarkdownFiles(path.join(packRoot, "wiki")),
    ...(await readRootInstructions(packRoot)),
    targetFiles,
    warnings,
  };
}

function bundledTemplatesRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "templates");
}

export function mergeTemplateJson<T>(base: T, override: unknown): T {
  if (!override || typeof override !== "object" || Array.isArray(override)) return base;
  return deepMerge(base, override) as T;
}

async function readManifest(packRoot: string): Promise<{ name: string; version: string }> {
  const manifestPath = path.join(packRoot, "wep-pack.json");
  if (!(await pathExists(manifestPath))) {
    throw new Error("Invalid template pack: missing wep-pack.json.");
  }

  const manifest = (await readJsonIfExists(manifestPath, "wep-pack.json")) as PackManifest | undefined;
  if (!manifest || manifest.wepPackVersion !== 1) {
    throw new Error("Invalid template pack: wep-pack.json must set wepPackVersion to 1.");
  }
  if (typeof manifest.name !== "string" || !manifest.name.trim()) {
    throw new Error("Invalid template pack: wep-pack.json must include a non-empty name.");
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(manifest.name.trim())) {
    throw new Error("Invalid template pack: name may contain only letters, numbers, dots, underscores, and hyphens.");
  }
  if (typeof manifest.version !== "string" || !manifest.version.trim()) {
    throw new Error("Invalid template pack: wep-pack.json must include a non-empty version.");
  }

  return { name: manifest.name.trim(), version: manifest.version.trim() };
}

async function readJsonIfExists(filePath: string, label: string): Promise<unknown | undefined> {
  if (!(await pathExists(filePath))) return undefined;
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    throw new Error(`Invalid template pack: ${label} is not valid JSON.`);
  }
}

async function assertNoUnsupportedRootDirs(packRoot: string): Promise<void> {
  for (const dirname of ["skills", "prompts", "instructions", "targets", "agents"]) {
    if (await pathExists(path.join(packRoot, dirname))) {
      throw new Error(
        `Invalid template pack: root-level ${dirname}/ is not supported. Move target files under target/.`,
      );
    }
  }
}

async function readMarkdownFiles(directoryPath: string): Promise<Record<string, string>> {
  if (!(await isDirectory(directoryPath))) return {};
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const files: Record<string, string> = {};

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    files[entry.name] = await readFile(path.join(directoryPath, entry.name), "utf8");
  }

  return files;
}

async function readRootInstructions(packRoot: string): Promise<Pick<TemplatePack, "rootInstructions">> {
  const rootInstructionsPath = path.join(packRoot, "target", "root-instructions.md");
  if (!(await pathExists(rootInstructionsPath))) return {};
  return { rootInstructions: await readFile(rootInstructionsPath, "utf8") };
}

async function readTargetFiles(
  targetRoot: string,
  target: Target,
): Promise<{ targetFiles: Record<string, string>; warnings: string[] }> {
  if (!(await isDirectory(targetRoot))) return { targetFiles: {}, warnings: [] };

  const targetFiles: Record<string, string> = {};
  const warnings: string[] = [];

  Object.assign(targetFiles, await readSkillFiles(path.join(targetRoot, "skills"), skillDestinationRoot(target)));
  Object.assign(
    targetFiles,
    await readPromptFiles(path.join(targetRoot, "prompts"), promptDestinationRoot(target), target, warnings),
  );
  Object.assign(
    targetFiles,
    await readInstructionFiles(
      path.join(targetRoot, "instructions"),
      instructionDestinationRoot(target),
      target,
      warnings,
    ),
  );
  Object.assign(targetFiles, await readAgentFiles(path.join(targetRoot, "agents"), target, warnings));

  return { targetFiles, warnings };
}

async function readSkillFiles(sourceRoot: string, destinationRoot: string): Promise<Record<string, string>> {
  if (!(await isDirectory(sourceRoot))) return {};
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  const files: Record<string, string> = {};

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillDir = path.join(sourceRoot, entry.name);
    const skillPath = path.join(skillDir, "SKILL.md");
    if (!(await pathExists(skillPath))) {
      throw new Error(`Invalid template pack: target/skills/${entry.name}/SKILL.md is required.`);
    }
    const skillFiles = await readDirectoryFilesRecursive(skillDir);
    for (const [relativePath, content] of Object.entries(skillFiles)) {
      files[path.posix.join(destinationRoot, entry.name, relativePath)] = content;
    }
  }

  return files;
}

async function readDirectoryFilesRecursive(rootDir: string, currentDir = rootDir): Promise<Record<string, string>> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const files: Record<string, string> = {};
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      Object.assign(files, await readDirectoryFilesRecursive(rootDir, fullPath));
    } else if (entry.isFile()) {
      const relativePath = toPosix(path.relative(rootDir, fullPath));
      files[relativePath] = await readFile(fullPath, "utf8");
    }
  }
  return files;
}

async function readAgentFiles(sourceRoot: string, target: Target, warnings: string[]): Promise<Record<string, string>> {
  if (!(await isDirectory(sourceRoot))) return {};
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  const files: Record<string, string> = {};

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const agentName = entry.name.slice(0, -3);
    if (!hasAgentFormat(target)) {
      warnings.push(templateAgentPiWarning(agentName));
      continue;
    }
    const rawMarkdown = await readFile(path.join(sourceRoot, entry.name), "utf8");
    Object.assign(files, emitTemplateAgent(agentName, rawMarkdown, target));
  }

  return files;
}

async function readPromptFiles(
  sourceRoot: string,
  destinationRoot: string | undefined,
  target: Target,
  warnings: string[],
): Promise<Record<string, string>> {
  if (!(await isDirectory(sourceRoot))) return {};
  const markdownFiles = await readMarkdownFiles(sourceRoot);
  if (Object.keys(markdownFiles).length === 0) return {};
  if (!destinationRoot) {
    warnings.push(`${target} has no prompt directory format, so template prompts are skipped for ${target}.`);
    return {};
  }

  return Object.fromEntries(
    Object.entries(markdownFiles).map(([name, content]) => [path.posix.join(destinationRoot, name), content]),
  );
}

async function readInstructionFiles(
  sourceRoot: string,
  destinationRoot: string | undefined,
  target: Target,
  warnings: string[],
): Promise<Record<string, string>> {
  if (!(await isDirectory(sourceRoot))) return {};
  const markdownFiles = await readMarkdownFiles(sourceRoot);
  if (Object.keys(markdownFiles).length === 0) return {};
  if (!destinationRoot) {
    warnings.push(
      `${target} has no scoped instruction directory format, so template instructions are skipped for ${target}.`,
    );
    return {};
  }

  return Object.fromEntries(
    Object.entries(markdownFiles).map(([name, content]) => [path.posix.join(destinationRoot, name), content]),
  );
}

function skillDestinationRoot(target: Target): string {
  const roots: Record<Target, string> = {
    codex: ".agents/skills",
    claude: ".claude/skills",
    copilot: ".github/skills",
    pi: ".pi/skills",
  };
  return roots[target];
}

function promptDestinationRoot(target: Target): string | undefined {
  const roots: Partial<Record<Target, string>> = {
    claude: ".claude/commands",
    copilot: ".github/prompts",
    pi: ".pi/prompts",
  };
  return roots[target];
}

function instructionDestinationRoot(target: Target): string | undefined {
  const roots: Partial<Record<Target, string>> = {
    copilot: ".github/instructions",
  };
  return roots[target];
}

function deepMerge(base: unknown, override: unknown): unknown {
  if (Array.isArray(base) && Array.isArray(override)) {
    if (base.every((item) => typeof item === "string") && override.every((item) => typeof item === "string")) {
      return Array.from(new Set([...base, ...override]));
    }
    return override;
  }

  if (isPlainObject(base) && isPlainObject(override)) {
    const merged: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(override)) {
      merged[key] = key in merged ? deepMerge(merged[key], value) : value;
    }
    return merged;
  }

  return override;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
