import type { Assertion, AssertionResult, StepResult } from "./types.mjs";

export function evaluateAssertions(
  assertions: readonly Assertion[],
  context: {
    fixtureRoot: string;
    stepResults: readonly Pick<StepResult, "exitCode" | "stdout" | "stderr" | "durationMs">[];
  },
): Promise<AssertionResult[]>;
