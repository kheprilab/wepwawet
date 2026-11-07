import type { AssertionResult, Mechanism, Outcome, ReportValue, ResultSummary } from "./types.mjs";

export interface ReportResult {
  id: string;
  title: string;
  hypothesis?: string;
  mechanism: Mechanism;
  outcome: Outcome;
  assertions?: AssertionResult[];
  error?: ReportValue;
}

export function summarizeResults(results: readonly Pick<ReportResult, "mechanism" | "outcome">[]): ResultSummary;
export function overallOutcome(
  summary: Pick<ResultSummary, "worsened" | "improved" | "inconclusive" | "preserved"> &
    Partial<Pick<ResultSummary, "notApplicable">>,
): "WORSENED" | "PARTIAL" | "IMPROVED" | "INCONCLUSIVE" | "NOT_APPLICABLE" | "PRESERVED";
export function writeReport<T extends { mode: string; results: ReportResult[] }>(
  input: T,
  options: { outputRoot: string; runId: string; repoRoot: string },
): Promise<{
  directory: string;
  jsonPath: string;
  markdownPath: string;
  report: T & { schemaVersion: number; runId: string; generatedAt: string; summary: ResultSummary };
}>;
