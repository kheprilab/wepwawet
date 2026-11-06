import { type ModuleName, type Target, type WepConfig, moduleNames } from "./types.js";

/**
 * The files that make up a task capsule, in the order they are meant to be read.
 *
 * This list is the single source of truth. `createJudgeScope` refuses to compute a
 * boundary when any of them is missing, so a shipped `_template` that omitted one made
 * `wep judge scope` fail on a capsule the harness itself had produced. Derive from
 * this constant rather than repeating the names.
 */
export const capsuleFiles = [
  "task.md",
  "context.md",
  "plan.md",
  "acceptance-criteria.md",
  "review-checklist.md",
] as const;

export type CapsuleFile = (typeof capsuleFiles)[number];

/**
 * Content for every capsule file, keyed by name.
 *
 * Producers are typed with this rather than listing names inline, so adding an entry to
 * `capsuleFiles` fails the build everywhere the content has to be supplied — the shipped
 * `_template` and `wep task` alike. Consumers that only check for presence can iterate
 * `capsuleFiles` directly.
 */
export type CapsuleContent = Record<CapsuleFile, string>;

export const upgradesDir = ".wep/upgrades";

export const upgradesIgnorePath = `${upgradesDir}/.gitignore`;

/** Direct and transitive module dependencies. */
export const moduleRequires: Record<ModuleName, readonly ModuleName[]> = {
  templates: [],
  tasks: ["templates"],
  judge: ["tasks", "templates"],
  comprehension: ["judge", "tasks", "templates"],
  impl: ["tasks", "templates"],
  trace: ["templates"],
};

/**
 * Resolve the active modules, expanding required dependencies in canonical order.
 * A config without `modules` means every module (0.7.0 compatibility).
 */
export function expandModules(configured?: readonly ModuleName[]): ModuleName[] {
  if (configured === undefined) return [...moduleNames];
  const active = new Set<ModuleName>();
  for (const mod of configured) {
    if (!moduleNames.includes(mod)) continue;
    active.add(mod);
    for (const req of moduleRequires[mod]) active.add(req);
  }
  if (active.size === 0) active.add("templates");
  return moduleNames.filter((mod) => active.has(mod));
}

export function parseModules(raw: string | readonly string[]): ModuleName[] {
  const tokens = (typeof raw === "string" ? raw.split(/[,\s]+/) : raw).map((item) => item.trim()).filter(Boolean);
  if (tokens.length === 0) {
    throw new Error(`--modules requires at least one module. Valid modules: ${moduleNames.join(", ")}.`);
  }
  const validated: ModuleName[] = [];
  for (const token of tokens) {
    if (!moduleNames.includes(token as ModuleName)) {
      throw new Error(`Unknown module "${token}". Valid modules: ${moduleNames.join(", ")}.`);
    }
    validated.push(token as ModuleName);
  }
  return expandModules(validated);
}

export function hasModule(
  source: Pick<WepConfig, "modules"> | readonly ModuleName[] | undefined,
  mod: ModuleName,
): boolean {
  const list = Array.isArray(source) ? source : (source as Pick<WepConfig, "modules"> | undefined)?.modules;
  return expandModules(list).includes(mod);
}

const templatesNeutralFiles = [".wep/config.json", ".wep/manifest.json"] as const;

const tasksNeutralFiles = [
  ".wep/local/.gitignore",
  upgradesIgnorePath,
  ".wep/wiki/overview.md",
  ".wep/wiki/architecture.md",
  ".wep/wiki/conventions.md",
  ".wep/wiki/testing.md",
  ".wep/wiki/workflows.md",
  ".wep/wiki/decisions.md",
  ".wep/wiki/agent-setup.md",
  ".wep/wiki/gaps.md",
  ".wep/wiki/recommendations.md",
  ".wep/wiki/instruction-audit.md",
  ".wep/wiki/write-policy.md",
  ".wep/wiki/log.md",
  ".wep/wiki/index.md",
  ...capsuleFiles.map((file) => `.wep/tasks/_template/${file}`),
] as const;

const judgeNeutralFiles = [
  ".wep/policy.json",
  ".wep/judge/README.md",
  ".wep/judge/schemas/review.schema.json",
] as const;

const comprehensionNeutralFiles = [
  ".wep/comprehension/README.md",
  ".wep/comprehension/schemas/scope.schema.json",
  ".wep/comprehension/schemas/rubric.schema.json",
  ".wep/comprehension/schemas/result.schema.json",
] as const;

/** Given an installed target, the target reference file doctor should require when `tasks` is installed. */
export function targetReferenceFile(target: Target): string {
  return `.wep/targets/${target}.md`;
}

const tasksTargetFiles: Record<Target, readonly string[]> = {
  codex: [
    "AGENTS.md",
    ".agents/skills/wep-init/SKILL.md",
    ".agents/skills/wep-doctor/SKILL.md",
    ".agents/skills/wep-task/SKILL.md",
    ".agents/skills/wep-review/SKILL.md",
    ".agents/skills/wep-workflow/SKILL.md",
    ".agents/skills/wep-write-policy/SKILL.md",
  ],
  claude: [
    "CLAUDE.md",
    ".claude/commands/wep-doctor.md",
    ".claude/commands/wep-task.md",
    ".claude/skills/wep-init/SKILL.md",
    ".claude/skills/wep-doctor/SKILL.md",
    ".claude/skills/wep-task/SKILL.md",
    ".claude/skills/wep-review/SKILL.md",
    ".claude/skills/wep-workflow/SKILL.md",
    ".claude/skills/wep-write-policy/SKILL.md",
  ],
  copilot: [
    ".github/copilot-instructions.md",
    ".github/instructions/wep.instructions.md",
    ".github/prompts/wep-doctor.prompt.md",
    ".github/prompts/wep-task.prompt.md",
    ".github/prompts/wep-workflow.prompt.md",
    ".github/prompts/wep-write-policy.prompt.md",
    ".github/skills/wep-init/SKILL.md",
    ".github/skills/wep-doctor/SKILL.md",
    ".github/skills/wep-task/SKILL.md",
    ".github/skills/wep-review/SKILL.md",
    ".github/skills/wep-workflow/SKILL.md",
    ".github/skills/wep-write-policy/SKILL.md",
  ],
  pi: [
    ".pi/prompts/wep-doctor.md",
    ".pi/prompts/wep-task.md",
    ".pi/prompts/wep-workflow.md",
    ".pi/prompts/wep-write-policy.md",
    ".pi/skills/wep-init/SKILL.md",
    ".pi/skills/wep-doctor/SKILL.md",
    ".pi/skills/wep-task/SKILL.md",
    ".pi/skills/wep-review/SKILL.md",
    ".pi/skills/wep-workflow/SKILL.md",
    ".pi/skills/wep-write-policy/SKILL.md",
  ],
};

export function neutralFilesForModules(modules?: readonly ModuleName[]): string[] {
  const active = new Set(expandModules(modules));
  const files: string[] = [];
  if (active.has("templates")) files.push(...templatesNeutralFiles);
  if (active.has("judge")) files.push(...judgeNeutralFiles);
  if (active.has("tasks")) files.push(...tasksNeutralFiles.slice(0, 2));
  if (active.has("judge")) files.push(...judgeNeutralFiles.slice(1));
  if (active.has("comprehension")) files.push(...comprehensionNeutralFiles);
  if (active.has("tasks")) files.push(...tasksNeutralFiles.slice(2));
  return Array.from(new Set(files));
}

export function targetFilesForModules(modules: readonly ModuleName[] | undefined, target: Target): string[] {
  const active = new Set(expandModules(modules));
  if (!active.has("tasks")) return [];
  return [...tasksTargetFiles[target]];
}

export function requiredFiles(modules: readonly ModuleName[] | undefined, targets: readonly Target[]): string[] {
  const active = new Set(expandModules(modules));
  const files = [...neutralFilesForModules(modules)];
  if (active.has("tasks")) {
    for (const target of targets) {
      files.push(...tasksTargetFiles[target]);
    }
    for (const target of targets) {
      files.push(targetReferenceFile(target));
    }
  }
  return Array.from(new Set(files));
}

/** Files that may be user-authored and must never be silently deleted. */
export const protectedFiles = ["AGENTS.md", "CLAUDE.md", ".github/copilot-instructions.md", ".pi/README.md"];
