import type { Command } from "commander";
import { runMigrate } from "../migrate.js";
import { normalizeOptions } from "./shared.js";

export function registerMigrate(program: Command): void {
  program
    .command("migrate")
    .description("Move a legacy installation to the .wep namespace.")
    .option("--dry-run", "show planned changes without writing files", false)
    .option("--json", "emit the migration result as JSON", false)
    .addHelpText(
      "after",
      "\nExisting destinations are never merged or overwritten.\nLocal review records and snapshots retain their original bytes and may retain legacy names.",
    )
    .action(async (raw) => {
      const result = await runMigrate(normalizeOptions(raw));
      if (raw.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      if (result.status === "not-found") {
        console.log("No legacy configuration folder found. Nothing changed.");
      } else if (result.status === "already-migrated") {
        console.log("The .wep configuration folder already exists. Nothing changed.");
      } else {
        console.log(`${result.dryRun ? "Would migrate" : "Migrated"} ${result.from} -> ${result.to}`);
        for (const file of result.updated) console.log(`  ${result.dryRun ? "Would update" : "Updated"}: ${file}`);
        for (const file of result.preserved) console.log(`  Preserved: ${file}`);
      }
      for (const notice of result.notices) console.log(notice);
    });
}
