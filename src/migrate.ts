import { link, lstat, mkdir, readFile, readdir, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { guardCommand } from "./hook/guard.js";
import { hookCommand, resolveCliEntry } from "./hook/install.js";
import { matchesBlockedPattern } from "./judge-enforcement.js";
import { contentHash, isManifestManagedPath } from "./manifest.js";
import { type CommandOptions, type Target, targets } from "./types.js";

// Legacy names are confined to this explicit migration boundary; no binary alias is installed.
const LEGACY_ROOT = ".akrctx";
const CURRENT_ROOT = ".wep";
const PRESERVED_TREES = [`${LEGACY_ROOT}/local/judge`, `${LEGACY_ROOT}/local/comprehension`];
const BASE_BLOCKED = [
  ".git/",
  "node_modules/",
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "*.crt",
  "*.p12",
  "*.pfx",
  "secrets/",
  "credentials/",
  "private/",
];

export interface MigrateResult {
  status: "migrated" | "would-migrate" | "already-migrated" | "not-found";
  dryRun: boolean;
  from: string;
  to: string;
  renamed: string[];
  updated: string[];
  preserved: string[];
  notices: string[];
}

interface Change {
  from: string;
  to: string;
  before: Buffer;
  after: Buffer;
  mode: number;
}

/** Move the namespace without rebuilding or rewriting historical review evidence. */
export async function runMigrate(options: Pick<CommandOptions, "cwd" | "dryRun"> = {}): Promise<MigrateResult> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const result: MigrateResult = {
    status: "not-found",
    dryRun: Boolean(options.dryRun),
    from: LEGACY_ROOT,
    to: CURRENT_ROOT,
    renamed: [],
    updated: [],
    preserved: [],
    notices: [],
  };
  const legacy = await info(cwd, LEGACY_ROOT);
  const current = await info(cwd, CURRENT_ROOT);
  if (!legacy) {
    if (current) {
      if (!current.isDirectory() || current.isSymbolicLink()) throw new Error(".wep must be a real directory.");
      result.status = "already-migrated";
    }
    return result;
  }
  if (current)
    throw new Error(`Both ${LEGACY_ROOT} and ${CURRENT_ROOT} exist; migration will not merge or overwrite them.`);
  if (!legacy.isDirectory() || legacy.isSymbolicLink()) throw new Error(`${LEGACY_ROOT} must be a real directory.`);

  const config = await objectFile(cwd, `${LEGACY_ROOT}/config.json`);
  if (!Array.isArray(config.targets) || !config.targets.some((value) => targets.includes(value as Target))) {
    throw new Error("The legacy config must list a recognized target; nothing was migrated.");
  }
  const policyPath = `${LEGACY_ROOT}/policy.json`;
  const policy = (await info(cwd, policyPath)) ? await objectFile(cwd, policyPath) : undefined;
  const extraPatterns = policy?.blockedReadPatterns;
  if (
    extraPatterns !== undefined &&
    (!Array.isArray(extraPatterns) || !extraPatterns.every((s) => typeof s === "string" && s.length > 0))
  ) {
    throw new Error("The legacy policy has invalid blockedReadPatterns; nothing was migrated.");
  }
  const blocked = [...BASE_BLOCKED, ...((extraPatterns ?? []) as string[])];
  const changes = new Map<string, Change>();
  const directories = new Map<string, string>();

  async function addFile(relative: string, transform = renameReferences): Promise<void> {
    if (changes.has(relative)) return;
    await safePath(cwd, relative, blocked);
    const metadata = await lstat(path.join(cwd, relative));
    if (!metadata.isFile()) throw new Error(`Cannot migrate non-regular file: ${relative}`);
    const before = await readFile(path.join(cwd, relative));
    let text: string | undefined;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(before);
    } catch {
      /* Binary assets keep their bytes. */
    }
    if (transform !== renameReferences && (text === undefined || text.includes("\0"))) {
      throw new Error(`Migration requires UTF-8 text for ${relative}; nothing was migrated.`);
    }
    const after = text !== undefined && !text.includes("\0") ? Buffer.from(transform(text)) : before;
    changes.set(relative, { from: relative, to: renamePath(relative), before, after, mode: metadata.mode });
  }

  async function walk(relative: string): Promise<void> {
    if (PRESERVED_TREES.includes(relative) || isBlocked(relative, blocked)) {
      result.preserved.push(relocated(relative));
      return;
    }
    await safePath(cwd, relative, blocked);
    const metadata = await lstat(path.join(cwd, relative));
    if (metadata.isDirectory()) {
      directories.set(relative, renamePath(relative));
      for (const entry of (await readdir(path.join(cwd, relative))).sort()) await walk(`${relative}/${entry}`);
    } else {
      await addFile(relative);
    }
  }
  await walk(LEGACY_ROOT);

  // Only product-namespaced integration files are traversed; unrelated integrations stay untouched.
  for (const parent of [
    ".agents/skills",
    ".claude/skills",
    ".github/skills",
    ".pi/skills",
    ".claude/commands",
    ".github/prompts",
    ".pi/prompts",
    ".github/instructions",
    ".claude/agents",
    ".github/agents",
    ".codex/agents",
  ]) {
    if (!(await info(cwd, parent))) continue;
    await safePath(cwd, parent, blocked);
    for (const entry of await readdir(path.join(cwd, parent))) {
      if (!/^akrctx(?:[-.]|$)/.test(entry)) continue;
      const relative = `${parent}/${entry}`;
      if (await info(cwd, renamePath(relative)))
        throw new Error(`Migration destination already exists: ${renamePath(relative)}`);
      await walk(relative);
    }
  }
  for (const relative of ["AGENTS.md", "CLAUDE.md", ".github/copilot-instructions.md", ".pi/README.md"]) {
    if (await info(cwd, relative)) await addFile(relative);
    const candidate = relative.replace(/(\.[^/.]+)$/, ".akrctx.suggested$1");
    if (await info(cwd, candidate)) await addFile(candidate);
  }
  for (const [relative, host] of [
    [".claude/settings.json", "claude"],
    [".claude/settings.local.json", "claude"],
    [".codex/hooks.json", "codex"],
    [".github/hooks/akrctx-trace.json", "copilot"],
  ] as const) {
    if (!(await info(cwd, relative))) continue;
    await addFile(relative, (text) => {
      const next = migrateHooks(text, host);
      if (relative.endsWith("akrctx-trace.json") && next === text)
        throw new Error("The legacy trace file has no owned hooks; nothing was migrated.");
      return next;
    });
  }
  const extension = ".pi/extensions/akrctx-trace.ts";
  if (await info(cwd, extension)) {
    await addFile(extension, (text) => {
      if (!text.includes("--akrctx-trace"))
        throw new Error("The legacy trace extension lacks its ownership marker; nothing was migrated.");
      const pin = /spawn\("(?:[^"\\]|\\.)*", \["(?:[^"\\]|\\.)*", "hook"/;
      if (!pin.test(text))
        throw new Error("The legacy trace extension has an unrecognized entry point; nothing was migrated.");
      return renameReferences(
        text.replace(
          pin,
          () => `spawn(${JSON.stringify(process.execPath)}, [${JSON.stringify(resolveCliEntry())}, "hook"`,
        ),
      );
    });
  }

  // Rebind only provenance that matched the original bytes. Modified files stay modified.
  const manifestChange = changes.get(`${LEGACY_ROOT}/manifest.json`);
  if (manifestChange) {
    const manifest = parseObject(manifestChange.before.toString("utf8"), "legacy manifest");
    if (manifest.schemaVersion !== 1 || typeof manifest.cliVersion !== "string")
      throw new Error("Unsupported legacy manifest schema or CLI version; nothing was migrated.");
    for (const key of ["files", "candidates"]) {
      const records = manifest[key];
      if (records === undefined && key === "candidates") continue;
      if (!records || typeof records !== "object" || Array.isArray(records))
        throw new Error(`Invalid legacy manifest ${key}.`);
      const next: Record<string, unknown> = {};
      for (const [relative, value] of Object.entries(records)) {
        const destination = renamePath(relative);
        if (
          !isSafeRelative(relative) ||
          (key === "files" ? !isManifestManagedPath(destination) : !destination.startsWith(`${CURRENT_ROOT}/upgrades/`))
        )
          throw new Error("The legacy manifest contains an unsupported managed path.");
        if (
          !value ||
          typeof value !== "object" ||
          !/^sha256:[0-9a-f]{64}$/.test(String((value as { hash?: unknown }).hash))
        )
          throw new Error("The legacy manifest contains invalid provenance.");
        if (destination in next) throw new Error(`Colliding legacy manifest path: ${destination}`);
        if (key === "files" && !changes.has(relative) && (await info(cwd, relative))) await addFile(relative);
        const fileChange = changes.get(relative);
        const record = { ...value } as { hash: string };
        if (fileChange && record.hash === contentHash(fileChange.before)) record.hash = contentHash(fileChange.after);
        next[destination] = record;
      }
      manifest[key] = next;
    }
    manifestChange.after = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  }

  const configChange = changes.get(`${LEGACY_ROOT}/config.json`);
  if (configChange && Array.isArray(config.templatePacks)) {
    const nextConfig = parseObject(configChange.after.toString("utf8"), "migrated config");
    const packs = config.templatePacks as Array<Record<string, unknown>>;
    for (const [index, pack] of packs.entries()) {
      if (
        !pack ||
        typeof pack !== "object" ||
        !pack.fileHashes ||
        typeof pack.fileHashes !== "object" ||
        Array.isArray(pack.fileHashes)
      )
        throw new Error("Invalid template-pack provenance; nothing was migrated.");
      const hashes: Record<string, string> = {};
      for (const [relative, hash] of Object.entries(pack.fileHashes)) {
        const destination = renamePath(relative);
        if (
          !isSafeRelative(relative) ||
          !isManifestManagedPath(destination) ||
          !/^sha256:[0-9a-f]{64}$/.test(String(hash))
        )
          throw new Error("Invalid template-pack provenance path or hash; nothing was migrated.");
        if (destination in hashes) throw new Error(`Template-pack paths collide: ${destination}`);
        if (!changes.has(relative) && (await info(cwd, relative))) await addFile(relative);
        const change = changes.get(relative);
        hashes[destination] = change && hash === contentHash(change.before) ? contentHash(change.after) : String(hash);
      }
      (nextConfig.templatePacks as Array<Record<string, unknown>>)[index].fileHashes = hashes;
    }
    configChange.after = Buffer.from(`${JSON.stringify(nextConfig, null, 2)}\n`);
  }
  const ledgerChange = changes.get(`${LEGACY_ROOT}/local/upgrade-candidates.json`);
  if (ledgerChange) {
    const ledger = parseObject(ledgerChange.before.toString("utf8"), "upgrade-candidate ledger");
    if (
      ledger.version !== 1 ||
      !ledger.candidates ||
      typeof ledger.candidates !== "object" ||
      Array.isArray(ledger.candidates)
    )
      throw new Error("Invalid upgrade-candidate ledger; nothing was migrated.");
    const records: Record<string, { hash: string }> = {};
    for (const [relative, value] of Object.entries(ledger.candidates)) {
      if (
        !isSafeRelative(relative) ||
        !relative.startsWith(`${LEGACY_ROOT}/upgrades/`) ||
        !value ||
        typeof value !== "object" ||
        !/^sha256:[0-9a-f]{64}$/.test(String((value as { hash?: unknown }).hash))
      )
        throw new Error("Invalid upgrade-candidate provenance; nothing was migrated.");
      const record = { ...value } as { hash: string };
      const change = changes.get(relative);
      if (change && record.hash === contentHash(change.before)) record.hash = contentHash(change.after);
      records[renamePath(relative)] = record;
    }
    ledgerChange.after = Buffer.from(`${JSON.stringify({ ...ledger, candidates: records }, null, 2)}\n`);
  }

  const destinations = new Set<string>();
  for (const change of changes.values()) {
    if (destinations.has(change.to)) throw new Error(`Migration paths collide: ${change.to}`);
    destinations.add(change.to);
    if (change.from !== change.to && !change.from.startsWith(`${LEGACY_ROOT}/`) && (await info(cwd, change.to)))
      throw new Error(`Migration destination already exists: ${change.to}`);
    await safePath(cwd, change.to, blocked, true);
    if (change.from !== change.to) result.renamed.push(`${change.from} -> ${change.to}`);
    if (!change.before.equals(change.after)) result.updated.push(change.to);
  }
  const directoryDestinations = new Set<string>();
  for (const destination of directories.values()) {
    if (directoryDestinations.has(destination)) throw new Error(`Migration directories collide: ${destination}`);
    directoryDestinations.add(destination);
  }
  result.renamed.unshift(`${LEGACY_ROOT} -> ${CURRENT_ROOT}`);
  result.notices.push(
    "Local review records, snapshots and personal comprehension records are preserved byte-for-byte. They may retain legacy names; migration does not renew their approvals.",
  );
  if (options.dryRun) {
    result.status = "would-migrate";
    return result;
  }

  // Recheck every planned input before the first mutation.
  for (const change of changes.values()) {
    await safePath(cwd, change.from, blocked);
    if (!(await readFile(path.join(cwd, change.from))).equals(change.before))
      throw new Error("Files changed while migration was being planned; retry. Nothing was migrated.");
  }
  if (await info(cwd, CURRENT_ROOT))
    throw new Error(".wep appeared while migration was being planned; nothing was migrated.");
  await rename(path.join(cwd, LEGACY_ROOT), path.join(cwd, CURRENT_ROOT));
  const applied: Change[] = [];
  try {
    for (const destination of directories.values()) await mkdir(path.join(cwd, destination), { recursive: true });
    for (const change of changes.values()) {
      const source = relocated(change.from);
      if (source === change.to && change.before.equals(change.after)) continue;
      await mkdir(path.dirname(path.join(cwd, change.to)), { recursive: true });
      if (source !== change.to) {
        await link(path.join(cwd, source), path.join(cwd, change.to));
        try {
          await unlink(path.join(cwd, source));
        } catch (error) {
          await unlink(path.join(cwd, change.to));
          throw error;
        }
      }
      applied.push(change);
      if (!change.before.equals(change.after))
        await writeFile(path.join(cwd, change.to), change.after, { mode: change.mode });
    }
  } catch (error) {
    for (const change of applied.reverse()) {
      const source = relocated(change.from);
      if (source !== change.to && (await info(cwd, change.to))) {
        await mkdir(path.dirname(path.join(cwd, source)), { recursive: true });
        await rename(path.join(cwd, change.to), path.join(cwd, source));
      }
      await writeFile(path.join(cwd, source), change.before, { mode: change.mode });
    }
    await rename(path.join(cwd, CURRENT_ROOT), path.join(cwd, LEGACY_ROOT));
    throw error;
  }
  for (const [source, destination] of [...directories].sort(([a], [b]) => b.length - a.length)) {
    const old = relocated(source);
    if (old !== destination) await rmdir(path.join(cwd, old)).catch(() => {});
  }
  result.status = "migrated";
  return result;
}

function renamePath(relative: string): string {
  return relative
    .replaceAll("akr-context", "wepwawet")
    .replaceAll("akrcontext", "wepwawet")
    .replaceAll("akrctx", "wep");
}

function renameReferences(text: string): string {
  return text
    .replaceAll("akrctxConfig", "WepConfig")
    .replaceAll("akrctxPolicy", "WepPolicy")
    .replaceAll("akrctxManifest", "WepManifest")
    .replaceAll("akrctxPackVersion", "wepPackVersion")
    .replaceAll("AKRCTX_", "WEP_")
    .replaceAll("$AKRCTX", "$WEP_CLI")
    .replaceAll("akr-context", "wepwawet")
    .replaceAll("akrcontext", "Wepwawet")
    .replaceAll("akrctx", "wep");
}

function migrateHooks(text: string, host: Target): string {
  const settings = parseObject(text, "hook settings");
  let changed = false;
  function visit(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        if (key === "command" && typeof item === "string") {
          if (/(?:^|\s)--akrctx-guard(?:\s|$)/.test(item)) {
            changed = true;
            return [key, guardCommand()];
          }
          if (/(?:^|\s)--akrctx-trace(?:\s|$)/.test(item) || /(?:^|[\s"/\\])akrctx hook \w+$/.test(item)) {
            const event = /\bhook\s+(SessionStart|PreToolUse|PostToolUse|PostToolUseFailure|Stop|SessionEnd)\b/.exec(
              item,
            )?.[1];
            if (!event) throw new Error("An owned legacy hook has an unrecognized event; nothing was migrated.");
            changed = true;
            return [key, hookCommand(event, host)];
          }
        }
        return [key, visit(item)];
      }),
    );
  }
  const next = { ...settings, ...(settings.hooks === undefined ? {} : { hooks: visit(settings.hooks) }) };
  return changed ? `${JSON.stringify(next, null, 2)}\n` : text;
}

function relocated(relative: string): string {
  return relative === LEGACY_ROOT
    ? CURRENT_ROOT
    : relative.startsWith(`${LEGACY_ROOT}/`)
      ? CURRENT_ROOT + relative.slice(LEGACY_ROOT.length)
      : relative;
}

function isSafeRelative(relative: string): boolean {
  return (
    relative.length > 0 &&
    !path.posix.isAbsolute(relative) &&
    !relative.includes("\\") &&
    !relative.split("/").some((part) => part === ".." || part === "." || part === "")
  );
}

function isBlocked(relative: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesBlockedPattern(relative, pattern));
}

async function safePath(cwd: string, relative: string, patterns: string[], missing = false): Promise<void> {
  if (!isSafeRelative(relative) || isBlocked(relative, patterns))
    throw new Error(`Migration cannot access blocked or unsafe path: ${relative}`);
  let current = cwd;
  for (const component of relative.split("/")) {
    current = path.join(current, component);
    const metadata = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (missing && error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!metadata) return;
    if (metadata.isSymbolicLink()) throw new Error(`Migration will not follow symbolic links: ${relative}`);
  }
}

async function info(cwd: string, relative: string) {
  try {
    return await lstat(path.join(cwd, relative));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function parseObject(text: string, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} is invalid JSON; nothing was migrated.`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be a JSON object; nothing was migrated.`);
  return value as Record<string, unknown>;
}

async function objectFile(cwd: string, relative: string): Promise<Record<string, unknown>> {
  await safePath(cwd, relative, BASE_BLOCKED);
  return parseObject(await readFile(path.join(cwd, relative), "utf8"), relative);
}
