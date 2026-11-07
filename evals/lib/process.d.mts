import type { Step, StepResult } from "./types.mjs";

export function evaluationEnvironment(home: string, overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function executeStep(
  step: Step,
  options: { fixtureRoot: string; cliEntry?: string; env?: NodeJS.ProcessEnv },
): Promise<StepResult>;
