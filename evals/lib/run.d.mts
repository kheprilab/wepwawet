import type { RunOptions, ScenarioResult } from "./types.mjs";

/** Validates the raw scenario before executing it. */
export function runScenario(rawScenario: unknown, options: RunOptions): Promise<ScenarioResult>;
