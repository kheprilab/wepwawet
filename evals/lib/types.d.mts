/** Contracts shared by the JavaScript evaluation helpers and their TypeScript callers. */
export type ChangeType = "fix" | "feature" | "observability" | "refactor" | "docs";
export type Mechanism = "pass" | "fail";
export type Outcome = "improved" | "preserved" | "worsened" | "inconclusive" | "not-applicable";

export interface Step {
  command: string[];
  cwd?: string;
  stdin?: string;
  timeoutMs?: number;
}

export interface StepResult {
  command: string[];
  exitCode: number;
  signal?: NodeJS.Signals;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  durationMs: number;
}

export type Assertion =
  | { type: "exitCode"; step?: number; equals: number }
  | { type: "stdoutContains" | "stdoutExcludes" | "stderrContains" | "stderrExcludes"; step?: number; value: string }
  | { type: "stdoutJsonPathEquals"; step?: number; jsonPath: string; equals: unknown }
  | { type: "durationUnder"; step?: number; milliseconds: number }
  | { type: "fileExists" | "fileNotExists"; path: string }
  | { type: "jsonPathEquals"; path: string; jsonPath: string; equals: unknown }
  | { type: "fileHashEquals"; path: string; equals: string }
  | { type: "gitClean"; equals: boolean };

export interface Digest {
  bytes: number;
  sha256: string;
}

export type ReportValue = null | boolean | number | (Digest & { type: "string" | "json" });

export interface AssertionResult {
  type: string;
  passed: boolean;
  expected: ReportValue;
  actual: ReportValue;
}

export interface Scenario {
  id: string;
  title: string;
  changeType: ChangeType;
  hypothesis: string;
  fixture: string;
  steps: Step[];
  assertions: Assertion[];
  comparison: { baseExpected: Mechanism; candidateExpected: Mechanism };
  outcome: { metric: string; direction: "increase" | "decrease" | "preserve"; verdict?: Outcome; threshold?: number };
  tags?: string[];
  suite?: string;
}

export interface FixtureRecipe {
  files?: Record<string, string>;
  git?: boolean;
}

export interface RunOptions {
  repoRoot: string;
  cliEntry: string;
  fixtureRecipe?: FixtureRecipe;
  tempRoot?: string;
  keepWorkdir?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface StepSummary {
  executable: string;
  argumentCount: number;
  exitCode: number;
  signal?: NodeJS.Signals;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  durationMs: number;
  stdout: Digest;
  stderr: Digest;
}

export interface ScenarioResult {
  id: string;
  title: string;
  changeType: ChangeType;
  hypothesis: string;
  mechanism: Mechanism;
  outcome: "inconclusive";
  outcomeMetric: string;
  assertions: AssertionResult[];
  steps: StepSummary[];
  error?: ReportValue;
  workdir?: string;
}

export interface ResultSummary {
  scenarios: number;
  passed: number;
  failed: number;
  improved: number;
  preserved: number;
  worsened: number;
  inconclusive: number;
  notApplicable: number;
}
