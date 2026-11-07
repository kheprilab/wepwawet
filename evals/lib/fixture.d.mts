import type { FixtureRecipe } from "./types.mjs";

export function loadFixture(repoRoot: string, name: string): Promise<FixtureRecipe>;
export function materializeFixture(
  recipe: FixtureRecipe,
  options?: { tempRoot?: string; keepWorkdir?: boolean },
): Promise<{ root: string; cleanup(): Promise<void> }>;
