import { readdir } from "node:fs/promises";
import path from "node:path";
import { agentWarningTexts, resolveAgent, resolveAgents } from "./agents.js";
import { readConfig } from "./config.js";
import { detectTargets } from "./detect.js";
import { listDirs, pathExists, readTextIfExists } from "./fs-utils.js";
import { collectJudgeRounds } from "./judge-rounds.js";
import { type RunLock, readActiveRun } from "./judge-run-lock.js";
import { taskNumber } from "./task.js";
import type { AgentName, CommandOptions, Target } from "./types.js";

export interface StatusResult {
  installed: boolean;
  targets: Target[];
  detectedTargets: Target[];
  taskCount: number;
  recentTaskIds: string[];
  defaultWorkflow: string;
  contextBudget: string;
  comprehensionGate: "enabled" | "disabled";
  pendingComprehension: string[];
  /** A `judge run` in progress in this tree, during which project files must not be edited. */
  activeRun: RunLock | null;
  agents: Array<{ name: AgentName; enabled: boolean; trigger: string; targets: Target[] }>;
  warnings: string[];
}

export async function listPendingComprehensionTasks(cwd: string): Promise<string[]> {
  const report = await collectJudgeRounds(cwd).catch(() => undefined);
  if (!report) return [];
  const closedTaskIds = report.tasks.filter((task) => task.state === "closed").map((task) => task.taskId);
  const pending: string[] = [];
  for (const taskId of closedTaskIds) {
    if (!(await hasCompletedComprehensionSession(cwd, taskId))) {
      pending.push(taskId);
    }
  }
  return pending.sort((a, b) => taskNumber(a) - taskNumber(b));
}

async function hasCompletedComprehensionSession(cwd: string, taskId: string): Promise<boolean> {
  const taskCompDir = path.join(cwd, ".wep/local/comprehension", taskId);
  if (!(await pathExists(taskCompDir))) return false;
  const directResult = await readTextIfExists(path.join(taskCompDir, "result.json"));
  if (directResult && isCompletedResultJson(directResult)) return true;
  const entries = await readdir(taskCompDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sessionResult = await readTextIfExists(path.join(taskCompDir, entry.name, "result.json"));
    if (sessionResult && isCompletedResultJson(sessionResult)) return true;
  }
  return false;
}

function isCompletedResultJson(rawText: string): boolean {
  try {
    const parsed = JSON.parse(rawText) as { status?: string };
    return parsed.status !== "DEFERRED";
  } catch {
    return false;
  }
}

export async function runStatus(options: CommandOptions): Promise<StatusResult> {
  const cwd = options.cwd ?? process.cwd();
  const [config, detection, installed] = await Promise.all([
    readConfig(cwd),
    detectTargets(cwd),
    pathExists(path.join(cwd, ".wep/config.json")),
  ]);

  let taskCount = 0;
  let recentTaskIds: string[] = [];
  let pendingComprehension: string[] = [];

  if (installed) {
    const tasksRoot = path.join(cwd, ".wep/tasks");
    const dirs = await listDirs(tasksRoot);
    const taskDirs = dirs.filter((d) => /^TASK-\d+/.test(d));
    taskCount = taskDirs.length;
    // Return the 5 most recent task IDs (e.g. "TASK-003") without the slug,
    // sorted numerically (descending) rather than relying on readdir order.
    recentTaskIds = taskDirs
      .slice()
      .sort((a, b) => taskNumber(b) - taskNumber(a))
      .slice(0, 5)
      .map((d) => {
        const match = /^(TASK-\d+)/.exec(d);
        return match ? match[1] : d;
      });
    pendingComprehension = await listPendingComprehensionTasks(cwd);
  }

  return {
    installed,
    targets: config?.targets ?? [],
    detectedTargets: detection.detected,
    taskCount,
    recentTaskIds,
    defaultWorkflow: config?.defaults.workflow ?? "not configured",
    contextBudget: config?.defaults.contextBudget ?? "not configured",
    comprehensionGate: config && resolveAgent(config, "comprehension").enabled ? "enabled" : "disabled",
    pendingComprehension,
    activeRun: await readActiveRun(cwd),
    agents: config
      ? Object.values(resolveAgents(config)).map((agent) => ({
          name: agent.name,
          enabled: agent.enabled,
          trigger: agent.trigger,
          targets: agent.targets,
        }))
      : [],
    warnings: config ? agentWarningTexts(config) : [],
  };
}
