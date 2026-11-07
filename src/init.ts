import { readFile } from "node:fs/promises";
import path from "node:path";
import select from "@inquirer/select";
import { agentFiles, hasAgentFormat, resolveAgent } from "./agents.js";
import { normalizeConfig, readConfig } from "./config.js";
import { detectTargets } from "./detect.js";
import { pathExists, writePlannedFile } from "./fs-utils.js";
import { expandModules, hasModule, parseModules, upgradesIgnorePath } from "./harness-files.js";
import { installGuard } from "./hook/guard.js";
import { createManifestFromWrites, templateHash } from "./manifest.js";
import { type TemplatePack, loadBundledTemplatePack, loadTemplatePack, mergeTemplateJson } from "./template-pack.js";
import {
  claudeCommands,
  claudeSkills,
  codexSkills,
  comprehensionFiles,
  copilotFiles,
  copilotSkills,
  defaultConfig,
  defaultPolicy,
  judgeContractFiles,
  localComprehensionIgnoreTemplate,
  mainInstructionTemplate,
  overviewTemplate,
  piFiles,
  piSkills,
  targetReferenceTemplates,
  taskTemplateFiles,
  upgradesIgnoreTemplate,
  wikiTemplates,
} from "./templates.js";
import type { CommandOptions, InitResult, ModuleName, Target, TargetOption, WepConfig, WriteResult } from "./types.js";
import { agentNames, targets } from "./types.js";
import { CLI_VERSION } from "./version.js";

export async function runInit(options: CommandOptions): Promise<InitResult> {
  const cwd = options.cwd ?? process.cwd();
  const profile = options.profile ?? "default";
  const detection = await detectTargets(cwd);
  const { target, selectedTargets } = await resolveTarget(options, detection.detected);
  if (options.template && options.templatePack) {
    throw new Error("Use either --template or --template-pack, not both.");
  }
  if ((options.template || options.templatePack) && selectedTargets.length !== 1) {
    throw new Error("Templates require a single --target. They cannot be used with --target all.");
  }
  const requestedModules = options.modules !== undefined ? parseModules(options.modules) : undefined;
  const templatePack = options.templatePack
    ? await loadTemplatePack(cwd, options.templatePack, selectedTargets[0])
    : options.template
      ? await loadBundledTemplatePack(options.template, selectedTargets[0])
      : undefined;
  const writes: WriteResult[] = [];

  const writeFile = (relativePath: string, content: string, protectedFile = false, reason?: string) =>
    writePlannedFile(cwd, relativePath, String(content), {
      dryRun: options.dryRun,
      force: options.force,
      protected: protectedFile,
      reason,
    });

  const existing = await readExistingConfig(cwd);
  const effectiveModules: ModuleName[] | undefined =
    requestedModules !== undefined
      ? existing?.modules
        ? expandModules([...existing.modules, ...requestedModules])
        : requestedModules
      : existing?.modules;

  const tasksActive = hasModule(effectiveModules, "tasks");
  const judgeActive = hasModule(effectiveModules, "judge");
  const comprehensionActive = hasModule(effectiveModules, "comprehension");

  const config = existing
    ? { ...existing, targets: mergeTargets(existing.targets, selectedTargets) }
    : normalizeConfig(
        mergeTemplateJson(defaultConfig(selectedTargets, profile), tasksActive ? templatePack?.config : undefined),
      );
  config.installedVersion = CLI_VERSION;
  if (effectiveModules !== undefined) {
    config.modules = effectiveModules;
  }
  if (!existing && !judgeActive && config.judge) {
    config.judge.enabled = false;
  }
  if (!existing) config.defaults.target = selectedTargets[0];
  if (templatePack) {
    const templateWikiHashes = Object.fromEntries(
      Object.entries(templatePack.wikiFiles).map(([name, content]) => [
        path.posix.join(".wep/wiki", templatePack.name, name),
        templateHash(content),
      ]),
    );
    const templateTargetHashes = Object.fromEntries(
      Object.entries(templatePack.targetFiles).map(([relativePath, content]) => [relativePath, templateHash(content)]),
    );
    config.templatePacks = [
      {
        name: templatePack.name,
        version: templatePack.version,
        source: options.templatePack ? "local" : "bundled",
        targets: selectedTargets,
        fileHashes: { ...templateWikiHashes, ...templateTargetHashes },
      },
    ];
  }
  writes.push(
    await writePlannedFile(cwd, ".wep/config.json", JSON.stringify(config, null, 2), {
      dryRun: options.dryRun,
      force: options.force || Boolean(existing),
      reason: "wep config.",
    }),
  );

  let policyWarnings: string[] = [];
  if (judgeActive) {
    const policy = mergeTemplateJson(defaultPolicy(profile), templatePack?.policy);
    policy.profile = profile;
    writes.push(
      await writeFile(".wep/policy.json", JSON.stringify(policy, null, 2), false, "wep security and merge policy."),
    );
    policyWarnings = describePolicyWeakening(defaultPolicy(profile), policy);
  } else if (templatePack?.policy !== undefined) {
    policyWarnings.push(
      `Template "${templatePack.name}" includes policy.json, which is ignored because module "judge" is not installed.`,
    );
  }
  if (!tasksActive && templatePack?.config !== undefined) {
    policyWarnings.push(
      `Template "${templatePack.name}" includes config.json, which is ignored because module "tasks" is not installed.`,
    );
  }

  if (tasksActive) {
    writes.push(
      await writeFile(
        ".wep/local/.gitignore",
        localComprehensionIgnoreTemplate,
        false,
        "Keep personal wep comprehension records local.",
      ),
    );
    writes.push(
      await writeFile(
        upgradesIgnorePath,
        upgradesIgnoreTemplate,
        false,
        "Keep unaccepted upgrade candidates out of version control.",
      ),
    );
  }

  const previouslyInstalled = existing?.targets ?? [];
  const agentTargetWarnings = existing ? agentNarrowingWarnings(config, selectedTargets, previouslyInstalled) : [];
  if (templatePack?.warnings?.length) {
    policyWarnings.push(...templatePack.warnings);
  }

  if (tasksActive) {
    const projectName = await readProjectName(cwd);
    const [overviewResult, wikiResults, taskResults, targetResults] = await Promise.all([
      writeFile(
        ".wep/wiki/overview.md",
        overviewTemplate(projectName, selectedTargets, CLI_VERSION),
        false,
        "wep wiki file.",
      ),
      Promise.all(
        Object.entries(wikiTemplates).map(([relativePath, content]) =>
          writeFile(path.posix.join(".wep", relativePath), content, false, "wep wiki file."),
        ),
      ),
      Promise.all(
        Object.entries(taskTemplateFiles).map(([relativePath, content]) =>
          writeFile(path.posix.join(".wep", relativePath), content, false, "wep task template."),
        ),
      ),
      Promise.all(
        selectedTargets.map((targetName) =>
          writeFile(
            `.wep/targets/${targetName}.md`,
            targetReferenceTemplates[targetName],
            false,
            "wep target reference.",
          ),
        ),
      ),
    ]);
    writes.push(overviewResult, ...wikiResults, ...taskResults, ...targetResults);
  }

  if (templatePack) {
    for (const [name, content] of Object.entries(templatePack.wikiFiles)) {
      writes.push(
        await writeFile(
          path.posix.join(".wep/wiki", templatePack.name, name),
          content,
          false,
          `${templatePack.name} template wiki file.`,
        ),
      );
    }
  }

  if (comprehensionActive) {
    const comprehensionResults = await Promise.all(
      Object.entries(comprehensionFiles).map(([relativePath, content]) =>
        writeFile(relativePath, content, false, "wep comprehension contract."),
      ),
    );
    writes.push(...comprehensionResults);
  }

  if (judgeActive) {
    const judgeContractResults = await Promise.all(
      Object.entries(judgeContractFiles).map(([relativePath, content]) =>
        writeFile(relativePath, content, false, "wep judge enforcement contract."),
      ),
    );
    writes.push(...judgeContractResults);
    const resolvedJudge = resolveAgent(config, "judge");
    if (resolvedJudge.enabled) {
      for (const targetName of selectedTargets) {
        if (!hasAgentFormat(targetName) || !resolvedJudge.targets.includes(targetName)) continue;
        for (const [relativePath, content] of Object.entries(
          agentFiles("judge", targetName, resolvedJudge.model[targetName]),
        )) {
          writes.push(await writeFile(relativePath, content, false, `wep judge agent file for ${targetName}.`));
        }
      }
      // Local settings, outside the manifest: the command pins this machine's paths.
      // A settings file wep cannot parse is left alone: the guard is then absent, and the
      // after-run check of `judge run` still catches an edit.
      if (selectedTargets.includes("claude"))
        await installGuard(cwd, { dryRun: options.dryRun }).catch(() => undefined);
    }
  }

  if (tasksActive) {
    for (const targetName of selectedTargets) {
      const targetWrites = await installTarget(cwd, targetName, options, templatePack);
      writes.push(...targetWrites);
    }
  } else if (templatePack?.rootInstructions !== undefined) {
    const rootPath = rootInstructionPathForTarget(selectedTargets[0]);
    writes.push(
      await writeFile(
        rootPath,
        templatePack.rootInstructions,
        true,
        `Existing ${rootPath} preserved; wrote suggested ${templatePack.name} instructions.`,
      ),
    );
  }

  for (const [relativePath, content] of Object.entries(templatePack?.targetFiles ?? {})) {
    writes.push(await writeFile(relativePath, content, false, "wep template pack target file."));
  }

  writes.push(await createManifestFromWrites(cwd, writes, CLI_VERSION, Boolean(options.dryRun)));

  return {
    target,
    selectedTargets,
    detection,
    writes,
    conflicts: writes.filter((write) => write.kind === "suggest").map((write) => write.path),
    policyWarnings,
    agentTargetWarnings,
  };
}

function rootInstructionPathForTarget(target: Target): string {
  if (target === "codex") return "AGENTS.md";
  if (target === "claude") return "CLAUDE.md";
  if (target === "copilot") return ".github/copilot-instructions.md";
  return ".pi/README.md";
}

function describePolicyWeakening(
  defaults: import("./types.js").WepPolicy,
  merged: import("./types.js").WepPolicy,
): string[] {
  const warnings: string[] = [];

  if (merged.mergeStrategy !== defaults.mergeStrategy) {
    warnings.push(
      `Template pack changed mergeStrategy to "${merged.mergeStrategy}" (default: "${defaults.mergeStrategy}").`,
    );
  }

  if (
    merged.protectedFileMerge?.agentMayEdit !== defaults.protectedFileMerge.agentMayEdit ||
    merged.protectedFileMerge?.approvalScope !== defaults.protectedFileMerge.approvalScope ||
    merged.protectedFileMerge?.requireDiffPreview !== defaults.protectedFileMerge.requireDiffPreview
  ) {
    warnings.push("Template pack weakened the protected-file human-approval contract.");
  }

  for (const key of Object.keys(defaults.enforcement) as Array<keyof typeof defaults.enforcement>) {
    if (defaults.enforcement[key] === true && merged.enforcement[key] === false) {
      warnings.push(`Template pack disabled enforcement.${key} (default: true).`);
    }
  }

  return warnings;
}

async function resolveTarget(
  options: CommandOptions,
  detected: Target[],
): Promise<{ target: TargetOption; selectedTargets: Target[] }> {
  if (options.target) {
    if (options.target === "all") {
      return { target: "all", selectedTargets: [...targets] };
    }
    const parts = String(options.target)
      .split(/[,\s]+/)
      .map((item) => item.trim())
      .filter(Boolean);
    if (parts.includes("all")) {
      return { target: "all", selectedTargets: [...targets] };
    }
    const validated: Target[] = [];
    for (const part of parts) {
      if (!targets.includes(part as Target)) {
        throw new Error(`Unsupported target: "${part}". Valid targets: ${targets.join(", ")}, all.`);
      }
      validated.push(part as Target);
    }
    const deduped = Array.from(new Set(validated));
    return {
      target: deduped.length === 1 ? deduped[0] : (deduped.join(",") as TargetOption),
      selectedTargets: deduped,
    };
  }

  if (detected.length === 1) {
    return { target: detected[0], selectedTargets: [detected[0]] };
  }

  const canPrompt = !options.nonInteractive && process.stdin.isTTY && process.stdout.isTTY;
  if (canPrompt) {
    const answer = await select<TargetOption>({
      message:
        detected.length > 1
          ? `Multiple agent setups detected (${detected.join(", ")}). Which target should wep install?`
          : "No agentic structure detected. Which agent will this project use?",
      choices: [
        { name: "Codex", value: "codex" },
        { name: "Claude Code", value: "claude" },
        { name: "GitHub Copilot", value: "copilot" },
        { name: "Pi", value: "pi" },
        { name: "All", value: "all" },
      ],
    });
    return { target: answer, selectedTargets: answer === "all" ? [...targets] : [answer as Target] };
  }

  if (detected.length > 1) {
    throw new Error(
      `Multiple agent setups detected (${detected.join(", ")}) and no --target given. Pass --target <codex|claude|copilot|pi|all>.`,
    );
  }

  throw new Error("No agent setup detected and no --target given. Pass --target <codex|claude|copilot|pi|all>.");
}

async function installTarget(
  cwd: string,
  target: Target,
  options: CommandOptions,
  templatePack?: TemplatePack,
): Promise<WriteResult[]> {
  const writes: WriteResult[] = [];
  const writeFile = async (relativePath: string, content: string, protectedFile = false, reason?: string) => {
    if (protectedFile && options.repair && (await pathExists(path.join(cwd, relativePath)))) {
      return {
        kind: "preserve" as const,
        path: relativePath,
        reason: "Existing protected instruction preserved during Doctor repair.",
      };
    }
    return writePlannedFile(cwd, relativePath, String(content), {
      dryRun: options.dryRun,
      force: options.force,
      protected: protectedFile,
      reason,
    });
  };

  if (target === "codex") {
    const [main, ...skills] = await Promise.all([
      writeFile(
        "AGENTS.md",
        templatePack?.rootInstructions ?? mainInstructionTemplate("codex"),
        true,
        "Existing AGENTS.md preserved; wrote suggested Codex harness.",
      ),
      ...Object.entries(codexSkills).map(([relativePath, content]) =>
        writeFile(relativePath, content, false, "Codex wep skill."),
      ),
    ]);
    writes.push(main, ...skills);
    return writes;
  }

  if (target === "claude") {
    const [main, ...rest] = await Promise.all([
      writeFile(
        "CLAUDE.md",
        templatePack?.rootInstructions ?? mainInstructionTemplate("claude"),
        true,
        "Existing CLAUDE.md preserved; wrote suggested Claude harness.",
      ),
      ...Object.entries(claudeCommands).map(([relativePath, content]) =>
        writeFile(relativePath, content, false, "Claude wep command."),
      ),
      ...Object.entries(claudeSkills).map(([relativePath, content]) =>
        writeFile(relativePath, content, false, "Claude wep skill."),
      ),
    ]);
    writes.push(main, ...rest);
    return writes;
  }

  if (target === "copilot") {
    const [main, ...rest] = await Promise.all([
      writeFile(
        ".github/copilot-instructions.md",
        templatePack?.rootInstructions ?? mainInstructionTemplate("copilot"),
        true,
        "Existing Copilot instructions preserved; wrote suggested harness.",
      ),
      ...Object.entries(copilotFiles).map(([relativePath, content]) =>
        writeFile(relativePath, content, false, "Copilot wep prompt or instruction."),
      ),
      ...Object.entries(copilotSkills).map(([relativePath, content]) =>
        writeFile(relativePath, content, false, "Copilot wep skill."),
      ),
    ]);
    writes.push(main, ...rest);
    return writes;
  }

  // pi
  if (templatePack?.rootInstructions) {
    writes.push(
      await writeFile(
        ".pi/README.md",
        templatePack.rootInstructions,
        true,
        "Existing Pi README preserved; wrote suggested template instructions.",
      ),
    );
  }

  const piResults = await Promise.all([
    ...Object.entries(piFiles).map(([relativePath, content]) =>
      writeFile(relativePath, content, false, "Pi wep prompt."),
    ),
    ...Object.entries(piSkills).map(([relativePath, content]) =>
      writeFile(relativePath, content, false, "Pi wep skill."),
    ),
  ]);
  writes.push(...piResults);

  if (!(await pathExists(path.join(cwd, ".pi")))) {
    writes.push(
      await writeFile(".pi/README.md", "# Pi wep Harness\n\nThis directory contains wep prompts and skills for Pi.\n"),
    );
  }

  return writes;
}

async function readProjectName(cwd: string): Promise<string> {
  try {
    const pkg = JSON.parse(await readFile(path.join(cwd, "package.json"), "utf8"));
    if (typeof pkg.name === "string" && pkg.name.trim()) return pkg.name.trim();
  } catch {
    // no package.json or invalid JSON — fall through
  }
  return path.basename(cwd);
}

async function readExistingConfig(cwd: string) {
  return readConfig(cwd).catch(() => undefined);
}

function mergeTargets(existing: Target[], selected: Target[]): Target[] {
  return [...new Set([...existing, ...selected])];
}

function agentNarrowingWarnings(config: WepConfig, selectedTargets: Target[], previousTargets: Target[]): string[] {
  const warnings: string[] = [];
  const newlyAdded = selectedTargets.filter((target) => !previousTargets.includes(target));
  if (newlyAdded.length === 0) return warnings;
  for (const name of agentNames) {
    const resolved = resolveAgent(config, name);
    if (!resolved.enabled || !resolved.configuredTargets) continue;
    for (const target of newlyAdded) {
      if (!hasAgentFormat(target)) continue;
      if (resolved.configuredTargets.includes(target)) continue;
      warnings.push(
        `agents.${name} has an explicit targets list (${resolved.configuredTargets.join(", ")}) that does not cover the newly added target "${target}". The agent will not be emitted for it; widen agents.${name}.targets if that was intended.`,
      );
    }
  }
  return warnings;
}

export async function runEnable(moduleInput: string | readonly string[], options: CommandOptions): Promise<InitResult> {
  const cwd = options.cwd ?? process.cwd();
  const config = await readConfig(cwd);
  if (!config) {
    throw new Error("wep is not installed. Run `wep init` first.");
  }
  const requested = parseModules(moduleInput);
  const current = expandModules(config.modules);
  const nextModules = expandModules([...current, ...requested]);
  return runInit({
    ...options,
    cwd,
    target: config.targets.join(","),
    modules: nextModules,
    profile: config.profile,
  });
}
