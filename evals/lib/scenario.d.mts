import type { Scenario } from "./types.mjs";

export function isFixtureRelative(value: unknown): value is string;
export function validateScenario(value: unknown): Scenario;
export function loadScenarioFiles(root: string, filters?: { suite?: string; scenario?: string }): Promise<Scenario[]>;
export function scenarioDigest(scenarios: readonly unknown[]): string;
