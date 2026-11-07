import type { Mechanism, Outcome, RunOptions, Scenario, ScenarioResult } from "./types.mjs";

export interface RefBuild {
  ref: string;
  sha: string;
  directory: string;
  cliEntry: string;
  cacheHit: boolean;
}

export interface ComparisonClassification {
  mechanism: Mechanism;
  verdict: "regression" | "invalidated" | "validated" | "inconclusive" | "mechanism-added" | "preserved";
  outcome: Outcome;
}

export function resolveRef(repoRoot: string, ref: string): Promise<string>;
export function buildCacheKey(sha: string, nodeVersion?: string): string;
export function isBuildCacheValid(directory: string, sha: string): Promise<boolean>;
export function claimStaleOwnerlessBuildLock(lockDirectory: string, token: string): Promise<boolean>;
export function releaseBuildLock(lockDirectory: string, token: string | undefined): Promise<boolean>;
export function acquireBuildLock(
  lockDirectory: string,
  cacheDirectory: string,
  sha: string,
): Promise<string | undefined>;
export function prepareRefBuild(repoRoot: string, ref: string, cacheRoot: string): Promise<RefBuild>;
export function classifyComparison(
  scenario: {
    changeType: string;
    comparison?: { baseExpected: string; candidateExpected: string };
    outcome: { verdict?: string };
  },
  baseMechanism: Mechanism,
  candidateMechanism: Mechanism,
): ComparisonClassification;
export function compareScenarios(
  scenarios: readonly Scenario[],
  options: RunOptions & { baseRef: string; candidateRef: string; cacheRoot: string },
): Promise<{
  base: RefBuild;
  candidate: RefBuild;
  results: Array<
    ComparisonClassification &
      Pick<Scenario, "id" | "title" | "changeType" | "hypothesis"> & {
        base: ScenarioResult;
        candidate: ScenarioResult;
      }
  >;
}>;
