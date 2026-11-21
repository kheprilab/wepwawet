import type { Command } from "commander";
import { DoctorMergeError, type DoctorMergeResult, runDoctorMerge } from "../doctor-merge.js";
import { runDoctor } from "../doctor.js";
import { addCommon, doctorCiFailed, log, normalizeOptions, printDoctor, printDoctorCi } from "./shared.js";

const collect = (value: string, previous: string[]): string[] => [...previous, value];

export function registerDoctor(program: Command): void {
  const doctor = addCommon(
    program
      .command("doctor")
      .description("Mechanically audit wep readiness and write generated reports to .wep/wiki/.")
      .option("--ci", "fail with exit code 1 when the harness is incomplete or has actionable issues", false)
      .option("--fix", "automatically recreate missing files and repair config/policy gaps", false)
      .addHelpText(
        "after",
        [
          "",
          "Doctor checks:",
          "  - The CLI performs deterministic setup checks; the installed Doctor skill performs semantic instruction review.",
          "  - Whether wep is installed.",
          "  - Which target adapters are present.",
          "  - Which required files are missing.",
          "  - Whether protected files have pending merge suggestions.",
          "  - Config completeness.",
          "",
          "Use --fix to recreate missing files and repair config/policy gaps automatically.",
          "Protected instructions remain read-only until the agent shows an exact diff and receives explicit human approval in the current conversation.",
          "Use `wep doctor merge` to review a pending suggestion block by block.",
          "",
          "It writes the report to .wep/wiki/agent-setup.md",
          "and prints a suggested agent prompt to finish the audit intelligently.",
        ].join("\n"),
      ),
  ).action(async (raw) => {
    const options = normalizeOptions(raw);
    const result = await runDoctor(options);
    if (options.ci) {
      printDoctorCi(result, options);
      if (doctorCiFailed(result)) process.exitCode = 1;
      return;
    }
    printDoctor(result, options);
  });

  doctor
    .command("merge [file]")
    .description("Review a pending suggested merge block by block, then accept or reject each block.")
    .option("--accept <block>", "write this block into the protected file (repeatable)", collect, [])
    .option("--reject <block>", "decline this block until its content changes (repeatable)", collect, [])
    .option("--dry-run", "show the result without writing files", false)
    .option("--json", "emit JSON output (for scripting)", false)
    .addHelpText(
      "after",
      [
        "",
        "Each `##` section of the suggestion is one block, named by its heading.",
        "Without --accept or --reject it lists the pending blocks and their diff.",
        "Run --accept or --reject only after the human approved those exact blocks in the current conversation.",
        "The suggestion file is removed once no block is pending.",
        "",
        "Examples:",
        "  wep doctor merge",
        "  wep doctor merge AGENTS.md --accept workflow-selection --reject safety",
      ].join("\n"),
    )
    .action(async (file: string | undefined, _local: Record<string, unknown>, command: Command) => {
      // `doctor` defines --json and --dry-run too, and commander hands them to the parent.
      const raw = command.optsWithGlobals();
      try {
        const result = await runDoctorMerge({
          file,
          accept: raw.accept as string[],
          reject: raw.reject as string[],
          dryRun: Boolean(raw.dryRun),
        });
        if (raw.json) log(JSON.stringify(result, null, 2));
        else printDoctorMerge(result);
      } catch (error) {
        if (!(error instanceof DoctorMergeError)) throw error;
        if (raw.json) log(JSON.stringify({ error: error.message }, null, 2));
        console.error(`wep doctor merge: ${error.message}`);
        console.error("Nothing was changed.");
        process.exitCode = 1;
      }
    });
}

function printDoctorMerge(result: DoctorMergeResult): void {
  if (result.files.length === 0) {
    log("No suggested merge is pending.");
    return;
  }
  const prefix = result.dryRun ? "[dry run] " : "";
  for (const file of result.files) {
    for (const id of file.accepted) log(`${prefix}Accepted ${id} into ${file.file}.`);
    for (const id of file.rejected) log(`${prefix}Rejected ${id}; it returns only if its content changes.`);
    if (file.pending.length === 0) {
      log(`${prefix}${file.file}: nothing pending.${file.removedSuggestion ? ` Removed ${file.suggestion}.` : ""}`);
      continue;
    }
    log(`${file.file} ← ${file.suggestion}: ${file.pending.length} pending block(s)`);
    for (const block of file.pending) {
      log("");
      log(`  ${block.id} (${block.status})`);
      for (const line of block.diff) log(`    ${line}`);
    }
    log("");
    log(
      `Accept: wep doctor merge ${file.file} --accept <block>   Reject: wep doctor merge ${file.file} --reject <block>`,
    );
  }
}
