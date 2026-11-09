import type { Command } from "commander";
import { Option } from "commander";
import { runEnable, runInit } from "../init.js";
import { addCommon, normalizeOptions, printInit } from "./shared.js";

export function registerInit(program: Command): void {
  addCommon(
    program
      .command("init")
      .description("Install a wep harness into the current repository.")
      .addOption(new Option("--profile <profile>", "installation profile").choices(["default", "strict", "regulated"]))
      .option(
        "--modules <modules>",
        "comma-separated modules to install (templates, tasks, judge, comprehension, impl, trace)",
      )
      .option("--template <name>", "apply a bundled template pack")
      .option("--template-pack <path>", "apply a target-relative template pack")
      .addHelpText(
        "after",
        [
          "",
          "What init does:",
          "  1. Detects existing agent setup (Codex, Claude, Copilot, Pi).",
          "  2. Asks which agent to target if none is detected.",
          "  3. Creates .wep/ — the neutral source of truth.",
          "  4. Installs target-specific harness files (skills, prompts, instructions).",
          "  5. Applies the selected profile (default, strict, or regulated).",
          "  6. Applies a template pack when --template-pack is provided.",
          "  7. Preserves any existing AGENTS.md / CLAUDE.md (writes .suggested instead).",
          "",
          "Run wep doctor after init to finish setup with your agent.",
        ].join("\n"),
      ),
  ).action(async (raw) => {
    const options = normalizeOptions(raw);
    if (options.force) {
      console.warn(
        "Warning: --force is set. wep-owned files will be overwritten.\n" +
          "         Protected root instructions (including .pi/README.md) are never overwritten.",
      );
    }
    const result = await runInit(options);
    printInit(result, options);
  });
}

export function registerEnable(program: Command): void {
  addCommon(
    program
      .command("enable")
      .description("Enable one or more wep modules in an initialized repository.")
      .argument(
        "<module>",
        "module name or comma-separated list (templates, tasks, judge, comprehension, impl, trace)",
      ),
    false,
  ).action(async (moduleName: string, raw) => {
    const options = normalizeOptions(raw);
    const result = await runEnable(moduleName, options);
    printInit(result, options);
  });
}
