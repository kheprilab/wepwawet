import type { Command } from "commander";
import { bold, dim, file, gray, warn, yellow } from "../format.js";
import { type TemplateApplyResult, runTemplateApply, runTemplateStatus, runTemplateUpdate } from "../template-apply.js";
import { listBundledTemplatePacks } from "../template-pack.js";
import type { CommandOptions } from "../types.js";
import { addCommon, log, normalizeOptions, printTemplateApply } from "./shared.js";

export function registerTemplates(program: Command): void {
  const templates = program.command("templates").description("List and apply wep template packs.");

  addCommon(templates.command("list").description("List bundled template packs."), false).action(async (raw) => {
    const options = normalizeOptions(raw);
    const result = await listBundledTemplatePacks();
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (result.length === 0) {
      log(gray("No bundled template packs found."));
      return;
    }

    log(bold("Available templates:"));
    for (const template of result) {
      log(`  ${template.name} ${dim(`v${template.version}`)}`);
    }
  });

  addCommon(
    templates
      .command("apply")
      .description("Safely apply a template pack to an initialized project.")
      .argument("<template>", "bundled template name or local path with --local")
      .option("--local", "load <template> as a local template-pack path", false)
      .addHelpText(
        "after",
        [
          "",
          "Examples:",
          "  wep templates apply company-base",
          "  wep templates apply ./company-template --local --target copilot",
          "  wep templates apply security-rules --dry-run",
          "",
          "Existing project files are preserved. Blocking conflicts produce versioned",
          "candidates under .wep/template-candidates/. Root instructions use the",
          "normal .wep.suggested.md + human-approved Doctor merge workflow.",
        ].join("\n"),
      ),
  ).action(async (templateRef: string, raw) => {
    const options = normalizeOptions(raw);
    const result = await runTemplateApply({ ...options, templateRef, local: Boolean(raw.local) });
    printTemplateApply(result as TemplateApplyResult, options as CommandOptions);
    if (!result.completed) process.exitCode = 1;
  });

  addCommon(
    templates
      .command("update")
      .description("Update an applied template pack, turning user-modified files into suggestions.")
      .argument("<template>", "bundled template name or local path with --local")
      .option("--local", "load <template> as a local template-pack path", false),
  ).action(async (templateRef: string, raw) => {
    const options = normalizeOptions(raw);
    const result = await runTemplateUpdate({ ...options, templateRef, local: Boolean(raw.local) });
    printTemplateApply(result as TemplateApplyResult, options as CommandOptions);
    if (!result.completed) process.exitCode = 1;
  });

  addCommon(templates.command("status").description("List template packs applied to this project."), false).action(
    async (raw) => {
      const options = normalizeOptions(raw);
      const result = await runTemplateStatus(options);
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      if (!result.installed) {
        log(gray("wep is not installed. Run `wep init` first."));
        return;
      }
      if (result.templates.length === 0) {
        log(gray("No template packs have been recorded."));
        return;
      }
      log(bold("Applied templates:"));
      for (const template of result.templates) {
        log(`  ${template.name} ${dim(`v${template.version}`)} ${gray(`[${template.source}]`)}`);
        log(`    targets: ${template.targets.join(", ")}`);
        if (template.changedFiles.length > 0) {
          log(`    ${yellow("changed:")}`);
          for (const changed of template.changedFiles) {
            log(`      ${warn()} ${file(changed)}`);
          }
        }
      }
    },
  );
}
