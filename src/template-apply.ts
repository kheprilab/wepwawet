import { readFile } from "node:fs/promises";
import path from "node:path";
import { normalizeConfig, readConfig, writeConfig } from "./config.js";
import { ensureTrailingNewline, pathExists, suggestedPathFor, writePlannedFile } from "./fs-utils.js";
import { hasModule } from "./harness-files.js";
import { contentHash, readManifest, templateHash, writeManifest } from "./manifest.js";
import { type TemplatePack, loadBundledTemplatePack, loadTemplatePack, mergeTemplateJson } from "./template-pack.js";
import { defaultPolicy } from "./templates.js";
import {
  type AppliedTemplatePack,
  type CommandOptions,
  type Target,
  type WepConfig,
  type WepPolicy,
  type WriteResult,
  targets,
} from "./types.js";
import { CLI_VERSION } from "./version.js";

export interface TemplateApplyOptions extends CommandOptions {
  templateRef: string;
  local?: boolean;
}

export interface TemplateApplyResult {
  name: string;
  version: string;
  source: AppliedTemplatePack["source"];
  target: Target;
  targets: Target[];
  dryRun: boolean;
  completed: boolean;
  writes: WriteResult[];
  conflicts: string[];
  pendingMerges: string[];
  policyWarnings: string[];
}

export interface TemplateStatusEntry extends AppliedTemplatePack {
  changedFiles: string[];
}

export interface TemplateStatusResult {
  installed: boolean;
  templates: TemplateStatusEntry[];
}

interface PlannedPackFile {
  path: string;
  content: string;
  kind: "root" | "wiki" | "target";
}

export async function runTemplateApply(options: TemplateApplyOptions): Promise<TemplateApplyResult> {
  const cwd = options.cwd ?? process.cwd();
  if (options.force)
    throw new Error("templates apply does not support --force; resolve generated candidates explicitly.");
  const config = await readConfig(cwd);
  if (!config) throw new Error("wep is not installed. Run `wep init` first.");
  const manifest = await readManifest(cwd);
  if (!manifest) throw new Error("A valid .wep/manifest.json is required. Run `wep upgrade` first.");
  const selectedTargets = resolveTemplateTargets(config, options.target);
  const source: AppliedTemplatePack["source"] = options.local ? "local" : "bundled";

  const packsByTarget = await Promise.all(
    selectedTargets.map(async (target) => ({
      target,
      pack: options.local
        ? await loadTemplatePack(cwd, options.templateRef, target)
        : await loadBundledTemplatePack(options.templateRef, target),
    })),
  );
  const pack = packsByTarget[0].pack;
  const targetWarnings = Array.from(new Set(packsByTarget.flatMap((entry) => entry.pack.warnings ?? [])));

  const existingPolicy = await readPolicyIfPresent(cwd);
  const plannedFiles = packFilesForTargets(packsByTarget);

  assertNoCrossTemplateCollisions(config.templatePacks, pack.name, plannedFiles);

  const preflight = await preflightFiles(cwd, pack, plannedFiles, options);

  if (preflight.conflicts.length > 0) {
    return resultFor(
      pack,
      source,
      selectedTargets,
      options,
      preflight.writes,
      preflight.conflicts,
      preflight.pendingMerges,
      targetWarnings,
    );
  }

  const writes = [...preflight.writes];
  for (const planned of plannedFiles) {
    if (await pathExists(path.join(cwd, planned.path))) continue;
    writes.push(
      await writePlannedFile(cwd, planned.path, planned.content, {
        dryRun: options.dryRun,
        reason: `${pack.name} template ${planned.kind} file.`,
      }),
    );
  }

  const warnings = [...targetWarnings];
  const judgeInstalled = hasModule(config, "judge");
  const tasksInstalled = hasModule(config, "tasks");

  if (pack.policy !== undefined && !judgeInstalled) {
    warnings.push(
      `Template "${pack.name}" includes policy.json, which is ignored because module "judge" is not installed.`,
    );
  } else if (judgeInstalled && (pack.policy !== undefined || existingPolicy !== undefined)) {
    const basePolicy = existingPolicy ?? defaultPolicy(config.profile ?? "default");
    const nextPolicy = mergeTemplateJson(basePolicy, pack.policy);
    warnings.push(...describePolicyWeakening(defaultPolicy(config.profile ?? "default"), nextPolicy));
    writes.push(
      await writeJsonIfChanged(cwd, ".wep/policy.json", nextPolicy, options, `${pack.name} template policy.`),
    );
  }

  if (pack.config !== undefined && !tasksInstalled) {
    warnings.push(
      `Template "${pack.name}" includes config.json, which is ignored because module "tasks" is not installed.`,
    );
  }

  const mergedConfig =
    tasksInstalled && pack.config !== undefined
      ? normalizeConfig(mergeTemplateJson(config, pack.config))
      : structuredClone(config);
  mergedConfig.targets = config.targets;
  mergedConfig.installedVersion = config.installedVersion;
  if (config.modules) mergedConfig.modules = config.modules;
  mergedConfig.sourceOfTruth = ".wep";
  mergedConfig.createdBy = "wep";
  mergedConfig.templatePacks = upsertAppliedTemplate(config.templatePacks, {
    name: pack.name,
    version: pack.version,
    source,
    targets: selectedTargets,
    fileHashes: Object.fromEntries(
      plannedFiles
        .filter((planned) => planned.kind === "target" || planned.kind === "wiki")
        .map((planned) => [planned.path, templateHash(planned.content)]),
    ),
  });
  writes.push(
    await writeJsonIfChanged(cwd, ".wep/config.json", mergedConfig, options, `${pack.name} template config.`),
  );
  const nextManifest = { ...manifest, cliVersion: CLI_VERSION, files: { ...manifest.files } };
  for (const planned of plannedFiles.filter((file) => file.kind === "target" || file.kind === "wiki")) {
    nextManifest.files[planned.path] = { hash: templateHash(planned.content) };
  }
  writes.push(await writeManifest(cwd, nextManifest, Boolean(options.dryRun)));

  return resultFor(pack, source, selectedTargets, options, writes, [], preflight.pendingMerges, warnings);
}

export async function runTemplateUpdate(options: TemplateApplyOptions): Promise<TemplateApplyResult> {
  const cwd = options.cwd ?? process.cwd();
  if (options.force) throw new Error("templates update does not support --force; changed files become suggestions.");
  const config = await readConfig(cwd);
  if (!config) throw new Error("wep is not installed. Run `wep init` first.");
  const manifest = await readManifest(cwd);
  if (!manifest) throw new Error("A valid .wep/manifest.json is required. Run `wep upgrade` first.");

  const probeTarget = config.targets[0];
  const probePack = options.local
    ? await loadTemplatePack(cwd, options.templateRef, probeTarget)
    : await loadBundledTemplatePack(options.templateRef, probeTarget);

  const existingEntry = config.templatePacks.find((entry) => entry.name === probePack.name);
  if (!existingEntry) {
    throw new Error(
      `Template "${probePack.name}" is not applied. Run \`wep templates apply ${options.templateRef}\` first.`,
    );
  }

  const defaultTargets = existingEntry.targets.filter((t) => config.targets.includes(t));
  const selectedTargets = options.target
    ? resolveTemplateTargets(config, options.target)
    : defaultTargets.length > 0
      ? defaultTargets
      : [...config.targets];
  const source: AppliedTemplatePack["source"] = options.local ? "local" : existingEntry.source;

  const packsByTarget = await Promise.all(
    selectedTargets.map(async (target) => ({
      target,
      pack: options.local
        ? await loadTemplatePack(cwd, options.templateRef, target)
        : await loadBundledTemplatePack(options.templateRef, target),
    })),
  );
  const pack = packsByTarget[0].pack;
  const targetWarnings = Array.from(new Set(packsByTarget.flatMap((entry) => entry.pack.warnings ?? [])));
  const existingPolicy = await readPolicyIfPresent(cwd);
  const plannedFiles = packFilesForTargets(packsByTarget);

  assertNoCrossTemplateCollisions(config.templatePacks, pack.name, plannedFiles);

  const writes: WriteResult[] = [];
  const conflicts: string[] = [];
  const pendingMerges: string[] = [];
  const updatedHashes: Record<string, string> = { ...existingEntry.fileHashes };
  const nextManifest = { ...manifest, cliVersion: CLI_VERSION, files: { ...manifest.files } };

  for (const planned of plannedFiles) {
    const absolute = path.join(cwd, planned.path);
    const desiredHash = templateHash(planned.content);

    if (planned.kind === "root") {
      if (!(await pathExists(absolute))) {
        writes.push(
          await writePlannedFile(cwd, planned.path, planned.content, {
            dryRun: options.dryRun,
            reason: `${pack.name} template root file.`,
          }),
        );
        continue;
      }
      const current = await readFile(absolute, "utf8");
      if (ensureTrailingNewline(current) === ensureTrailingNewline(planned.content)) {
        writes.push({ kind: "preserve", path: planned.path, reason: `${pack.name} template content is current.` });
        continue;
      }
      writes.push({ kind: "preserve", path: planned.path, reason: "Existing project content preserved." });
      const suggestedPath = suggestedPathFor(planned.path);
      const existingSuggestion = await readFile(path.join(cwd, suggestedPath), "utf8").catch(() => undefined);
      if (
        existingSuggestion !== undefined &&
        ensureTrailingNewline(existingSuggestion) !== ensureTrailingNewline(planned.content)
      ) {
        conflicts.push(planned.path);
        const candidatePath = path.posix.join(".wep/template-candidates", pack.name, pack.version, planned.path);
        const candidateWrite = await writePlannedFile(cwd, candidatePath, planned.content, {
          dryRun: options.dryRun,
          reason: `Resolve the existing ${suggestedPath}, then rerun to prepare this root merge.`,
        });
        writes.push({
          kind: candidateWrite.kind === "create" ? "suggest" : "preserve",
          path: candidatePath,
          reason: `A different root suggestion already exists at ${suggestedPath}.`,
        });
        continue;
      }
      pendingMerges.push(planned.path);
      writes.push(
        await writePlannedFile(cwd, planned.path, planned.content, {
          dryRun: options.dryRun,
          protected: true,
          reason: `Review and merge the ${pack.name} root instruction candidate.`,
        }),
      );
      continue;
    }

    if (!(await pathExists(absolute))) {
      writes.push(
        await writePlannedFile(cwd, planned.path, planned.content, {
          dryRun: options.dryRun,
          reason: `${pack.name} template ${planned.kind} file.`,
        }),
      );
      updatedHashes[planned.path] = desiredHash;
      nextManifest.files[planned.path] = { hash: desiredHash };
      continue;
    }

    const currentBuffer = await readFile(absolute);
    const currentHash = contentHash(currentBuffer);
    if (currentHash === desiredHash) {
      writes.push({ kind: "preserve", path: planned.path, reason: `${pack.name} template content is current.` });
      updatedHashes[planned.path] = desiredHash;
      nextManifest.files[planned.path] = { hash: desiredHash };
      continue;
    }

    const recordedHash = existingEntry.fileHashes[planned.path] ?? manifest.files[planned.path]?.hash;
    if (recordedHash && currentHash === recordedHash) {
      writes.push(
        await writePlannedFile(cwd, planned.path, planned.content, {
          dryRun: options.dryRun,
          force: true,
          reason: `Updated unmodified ${pack.name} template file.`,
        }),
      );
      updatedHashes[planned.path] = desiredHash;
      nextManifest.files[planned.path] = { hash: desiredHash };
      continue;
    }

    // User modified the file: preserve it and write a candidate suggestion (D2).
    writes.push({ kind: "preserve", path: planned.path, reason: "User-modified file preserved." });
    conflicts.push(planned.path);
    const candidatePath = path.posix.join(".wep/template-candidates", pack.name, pack.version, planned.path);
    const candidateWrite = await writePlannedFile(cwd, candidatePath, planned.content, {
      dryRun: options.dryRun,
      reason: `Review and merge into ${planned.path}.`,
    });
    writes.push({
      kind: candidateWrite.kind === "create" ? "suggest" : "preserve",
      path: candidatePath,
      reason:
        candidateWrite.kind === "create"
          ? `Review and merge into ${planned.path}.`
          : `Candidate already exists; preserved for review before merging into ${planned.path}.`,
    });
  }

  const warnings = [...targetWarnings];
  const judgeInstalled = hasModule(config, "judge");
  const tasksInstalled = hasModule(config, "tasks");

  if (pack.policy !== undefined && !judgeInstalled) {
    warnings.push(
      `Template "${pack.name}" includes policy.json, which is ignored because module "judge" is not installed.`,
    );
  } else if (judgeInstalled && (pack.policy !== undefined || existingPolicy !== undefined)) {
    const basePolicy = existingPolicy ?? defaultPolicy(config.profile ?? "default");
    const nextPolicy = mergeTemplateJson(basePolicy, pack.policy);
    warnings.push(...describePolicyWeakening(defaultPolicy(config.profile ?? "default"), nextPolicy));
    writes.push(
      await writeJsonIfChanged(cwd, ".wep/policy.json", nextPolicy, options, `${pack.name} template policy.`),
    );
  }

  if (pack.config !== undefined && !tasksInstalled) {
    warnings.push(
      `Template "${pack.name}" includes config.json, which is ignored because module "tasks" is not installed.`,
    );
  }

  const mergedConfig =
    tasksInstalled && pack.config !== undefined
      ? normalizeConfig(mergeTemplateJson(config, pack.config))
      : structuredClone(config);
  mergedConfig.targets = config.targets;
  mergedConfig.installedVersion = config.installedVersion;
  if (config.modules) mergedConfig.modules = config.modules;
  mergedConfig.sourceOfTruth = ".wep";
  mergedConfig.createdBy = "wep";
  mergedConfig.templatePacks = [
    ...config.templatePacks.filter((entry) => entry.name !== pack.name),
    {
      name: pack.name,
      version: pack.version,
      source,
      targets: Array.from(new Set([...existingEntry.targets, ...selectedTargets])),
      fileHashes: updatedHashes,
    },
  ].sort((a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source));

  writes.push(
    await writeJsonIfChanged(cwd, ".wep/config.json", mergedConfig, options, `${pack.name} template config.`),
  );
  writes.push(await writeManifest(cwd, nextManifest, Boolean(options.dryRun)));

  return resultFor(pack, source, selectedTargets, options, writes, conflicts, pendingMerges, warnings);
}

export async function runTemplateStatus(options: CommandOptions): Promise<TemplateStatusResult> {
  const cwd = options.cwd ?? process.cwd();
  const config = await readConfig(cwd);
  if (!config) return { installed: false, templates: [] };

  const templates: TemplateStatusEntry[] = [];
  for (const entry of config.templatePacks) {
    const changedFiles: string[] = [];
    for (const [relativePath, expectedHash] of Object.entries(entry.fileHashes)) {
      const absolute = path.join(cwd, relativePath);
      if (!(await pathExists(absolute))) {
        changedFiles.push(relativePath);
        continue;
      }
      const actualHash = contentHash(await readFile(absolute));
      if (actualHash !== expectedHash) {
        changedFiles.push(relativePath);
      }
    }
    templates.push({ ...entry, changedFiles: changedFiles.sort() });
  }

  return { installed: true, templates };
}

function resolveTemplateTargets(config: WepConfig, requested: CommandOptions["target"]): Target[] {
  if (!requested || requested === "all") {
    return [...config.targets];
  }
  const items = String(requested)
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (items.includes("all")) {
    return [...config.targets];
  }
  const resolved: Target[] = [];
  for (const item of items) {
    if (!targets.includes(item as Target)) {
      throw new Error(`Unsupported target: "${item}". Valid targets: ${targets.join(", ")}.`);
    }
    if (!config.targets.includes(item as Target)) {
      throw new Error(`Target ${item} is not installed. Installed targets: ${config.targets.join(", ")}.`);
    }
    resolved.push(item as Target);
  }
  return Array.from(new Set(resolved));
}

function packFilesForTargets(packsByTarget: Array<{ target: Target; pack: TemplatePack }>): PlannedPackFile[] {
  const files: PlannedPackFile[] = [];
  const seen = new Set<string>();

  for (const { target, pack } of packsByTarget) {
    if (pack.rootInstructions !== undefined) {
      const rootPath = rootInstructionPath(target);
      if (!seen.has(rootPath)) {
        seen.add(rootPath);
        files.push({ path: rootPath, content: pack.rootInstructions, kind: "root" });
      }
    }
    for (const [name, content] of Object.entries(pack.wikiFiles)) {
      const wikiPath = path.posix.join(".wep/wiki", pack.name, name);
      if (!seen.has(wikiPath)) {
        seen.add(wikiPath);
        files.push({ path: wikiPath, content, kind: "wiki" });
      }
    }
    for (const [relativePath, content] of Object.entries(pack.targetFiles)) {
      if (!seen.has(relativePath)) {
        seen.add(relativePath);
        files.push({ path: relativePath, content, kind: "target" });
      }
    }
  }

  return files;
}

function assertNoCrossTemplateCollisions(
  appliedPacks: AppliedTemplatePack[],
  currentPackName: string,
  plannedFiles: PlannedPackFile[],
): void {
  for (const other of appliedPacks) {
    if (other.name === currentPackName) continue;
    for (const planned of plannedFiles) {
      if (planned.kind === "root") continue;
      if (planned.path in other.fileHashes) {
        throw new Error(
          `Template "${currentPackName}" cannot claim "${planned.path}" because it is already claimed by template "${other.name}".`,
        );
      }
    }
  }
}

async function preflightFiles(
  cwd: string,
  pack: TemplatePack,
  files: PlannedPackFile[],
  options: CommandOptions,
): Promise<{ writes: WriteResult[]; conflicts: string[]; pendingMerges: string[] }> {
  const writes: WriteResult[] = [];
  const conflicts: string[] = [];
  const pendingMerges: string[] = [];
  for (const planned of files) {
    const absolute = path.join(cwd, planned.path);
    if (!(await pathExists(absolute))) continue;
    const current = await readFile(absolute, "utf8");
    if (ensureTrailingNewline(current) === ensureTrailingNewline(planned.content)) {
      writes.push({ kind: "preserve", path: planned.path, reason: `${pack.name} template content is current.` });
      continue;
    }

    writes.push({ kind: "preserve", path: planned.path, reason: "Existing project content preserved." });
    if (planned.kind === "root") {
      const suggestedPath = suggestedPathFor(planned.path);
      const existingSuggestion = await readFile(path.join(cwd, suggestedPath), "utf8").catch(() => undefined);
      if (
        existingSuggestion !== undefined &&
        ensureTrailingNewline(existingSuggestion) !== ensureTrailingNewline(planned.content)
      ) {
        conflicts.push(planned.path);
        const candidatePath = path.posix.join(".wep/template-candidates", pack.name, pack.version, planned.path);
        const candidateWrite = await writePlannedFile(cwd, candidatePath, planned.content, {
          dryRun: options.dryRun,
          reason: `Resolve the existing ${suggestedPath}, then rerun to prepare this root merge.`,
        });
        writes.push({
          kind: candidateWrite.kind === "create" ? "suggest" : "preserve",
          path: candidatePath,
          reason: `A different root suggestion already exists at ${suggestedPath}.`,
        });
        continue;
      }
      pendingMerges.push(planned.path);
      writes.push(
        await writePlannedFile(cwd, planned.path, planned.content, {
          dryRun: options.dryRun,
          protected: true,
          reason: `Review and merge the ${pack.name} root instruction candidate.`,
        }),
      );
      continue;
    }

    conflicts.push(planned.path);

    const candidatePath = path.posix.join(".wep/template-candidates", pack.name, pack.version, planned.path);
    const candidateWrite = await writePlannedFile(cwd, candidatePath, planned.content, {
      dryRun: options.dryRun,
      reason: `Review and merge into ${planned.path}.`,
    });
    writes.push({
      kind: candidateWrite.kind === "create" ? "suggest" : "preserve",
      path: candidatePath,
      reason:
        candidateWrite.kind === "create"
          ? `Review and merge into ${planned.path}.`
          : `Candidate already exists; preserved for review before merging into ${planned.path}.`,
    });
  }
  return { writes, conflicts, pendingMerges };
}

function rootInstructionPath(target: Target): string {
  if (target === "codex") return "AGENTS.md";
  if (target === "claude") return "CLAUDE.md";
  if (target === "copilot") return ".github/copilot-instructions.md";
  return ".pi/README.md";
}

function upsertAppliedTemplate(current: AppliedTemplatePack[], applied: AppliedTemplatePack): AppliedTemplatePack[] {
  const existing = current.find((entry) => entry.name === applied.name);
  const mergedTargets = Array.from(new Set([...(existing?.targets ?? []), ...applied.targets]));
  const fileHashes = { ...(existing?.fileHashes ?? {}), ...applied.fileHashes };
  return [
    ...current.filter((entry) => entry.name !== applied.name),
    { ...applied, targets: mergedTargets, fileHashes },
  ].sort((a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source));
}

async function readPolicyIfPresent(cwd: string): Promise<WepPolicy | undefined> {
  const absolute = path.join(cwd, ".wep/policy.json");
  if (!(await pathExists(absolute))) return undefined;
  try {
    const value = JSON.parse(await readFile(absolute, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid policy shape");
    return value as WepPolicy;
  } catch {
    throw new Error(".wep/policy.json is invalid JSON. Repair it before applying a template.");
  }
}

async function writeJsonIfChanged(
  cwd: string,
  relativePath: string,
  value: unknown,
  options: CommandOptions,
  reason: string,
): Promise<WriteResult> {
  const absolute = path.join(cwd, relativePath);
  const next = `${JSON.stringify(value, null, 2)}\n`;
  const current = await readFile(absolute, "utf8").catch(() => undefined);
  if (current === next) return { kind: "preserve", path: relativePath, reason: "Template values already present." };
  if (!options.dryRun) {
    if (relativePath === ".wep/config.json") await writeConfig(cwd, value as WepConfig);
    else await writePlannedFile(cwd, relativePath, next, { force: true, reason });
  }
  return { kind: current === undefined ? "create" : "update", path: relativePath, reason };
}

function describePolicyWeakening(defaults: WepPolicy, merged: WepPolicy): string[] {
  const warnings: string[] = [];
  if (merged.mergeStrategy !== defaults.mergeStrategy) {
    warnings.push(`Template changed mergeStrategy to ${String(merged.mergeStrategy)}.`);
  }
  for (const key of Object.keys(defaults.enforcement) as Array<keyof WepPolicy["enforcement"]>) {
    if (defaults.enforcement[key] && merged.enforcement?.[key] === false) {
      warnings.push(`Template disabled enforcement.${key}.`);
    }
  }
  if (
    merged.protectedFileMerge?.agentMayEdit !== defaults.protectedFileMerge.agentMayEdit ||
    merged.protectedFileMerge?.approvalScope !== defaults.protectedFileMerge.approvalScope ||
    merged.protectedFileMerge?.requireDiffPreview !== true
  ) {
    warnings.push("Template weakened the protected-file human-approval contract.");
  }
  return warnings;
}

function resultFor(
  pack: TemplatePack,
  source: AppliedTemplatePack["source"],
  selectedTargets: Target[],
  options: CommandOptions,
  writes: WriteResult[],
  conflicts: string[],
  pendingMerges: string[],
  policyWarnings: string[],
): TemplateApplyResult {
  return {
    name: pack.name,
    version: pack.version,
    source,
    target: selectedTargets[0],
    targets: selectedTargets,
    dryRun: Boolean(options.dryRun),
    completed: conflicts.length === 0,
    writes,
    conflicts,
    pendingMerges,
    policyWarnings,
  };
}
