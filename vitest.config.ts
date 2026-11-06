import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The heavy tests take about twice as long under the full parallel run as alone (TASK-091).
    testTimeout: 30_000,
    exclude: [
      "**/node_modules/**",
      "**/.wep/local/**",
      "**/evals/.cache/**",
      "**/evals/experiments/*/validation/runs/**",
      "**/evals/experiments/*/validation/hono-4961/**",
      "**/evals/experiments/*/validation/flask-5917/**",
    ],
  },
});
