# Repository rules

- Work on a branch, never directly on main. Every change goes through a pull request and is squash-merged.
- Commit messages and PR titles follow Conventional Commits: feat, fix, docs, refactor, test, chore, ci, build, perf, style, revert. Breaking changes use `!` after the type (or optional scope).
- Never edit the version in package.json or CHANGELOG.md by hand. release-please owns both and synchronizes src/version.ts.
- Never run `npm publish` or `npm stage publish`. Releases only happen through the release workflow.
- Never add attribution to any AI tool in commits, PRs, code, or docs.
- This is the open-source core. Enterprise or paid features never go in this repository.
- Before opening a PR, run `pnpm lint`, `pnpm test`, and `pnpm build` locally.

# AGENTS.md

This repository is the source for **Wepwawet** — a CLI that installs agentic workflow harnesses into other projects. You are working on the tool itself, not on a project that uses it. Shipped harness content lives in `src/templates/`. Root instructions and `.claude/settings.json` also carry repository-specific rules. A local dogfooded harness, when installed, lives under `.wep/` and target directories; treat its configuration and policy as the workflow source of truth.

Harness contracts are documented in `docs/HARNESS_SPEC.md`. Load local `.wep/wiki/` guidance when present and relevant.

## Key constraints

- `Workflow` in `types.ts` is the set of user-selectable workflows. `TaskWorkflow` extends it with `"UI review"`, which is auto-assigned via `workflowRules.ui` but not a user-selectable default.
- `src/templates/instructions.ts` is generated content — it is what agents in other projects will read. Keep it concise and instructional.
- `src/version.ts` exports `CLI_VERSION`; `cli.ts`, `templates/defaults.ts`, and `doctor.ts` import it. release-please updates its version alongside package.json; do not bump either by hand.
- `src/harness-files.ts` is the single source of which files each target requires. A new generated file that is not listed there is invisible to `doctor`, `upgrade`, and `remove`.
- `policy.json` must not restrict what the programming agent can do (no `allowSourceCodeWrites`, no `network`, no `llmProvider` keys).
- Never hand-edit installed harness copies under `.claude/skills/`, `.claude/commands/`, `.claude/agents/`, `.agents/`, `.github/skills/`, or `.pi/`. Repository-owned `.claude/settings.json` is maintained directly. Edit `src/templates/*` and re-run the CLI; `.wep/manifest.json` tracks a sha256 per file.

## Mandatory behavior

For features, fixes, refactors, or other meaningful code changes:

1. Read `.wep/config.json` and `.wep/policy.json` when present. If absent, report that the harness is not configured; choose the smallest suitable workflow and create a capsule without inventing configuration or enabled review gates.
2. Create or update a task capsule under `.wep/tasks/TASK-XXX-.../` before implementation.
3. Record the selected workflow and its reason in the capsule.
4. Resolve material ambiguity before implementation.
5. Follow the configured workflow unless the user explicitly overrides it.
6. Load only relevant context.
7. Update the capsule review checklist and run relevant validation.
8. Follow the independent-review process below.

Create the capsule yourself; `wep task` is only a headless fallback.

## Clarification

Ask the user before implementing when two plausible answers would produce different implementation, validation, or scope. If every plausible answer leads to the same code, it is not a question — do not ask it. There is no cap on the number of questions and no budget; the count follows from that test. There is no "assume and proceed" option, because the test already excludes trivia.

Record each answer under `## Clarifications` in the capsule's task.md, beneath a `### Session YYYY-MM-DD` heading, and propagate any answer that changes a criterion into acceptance-criteria.md. Ambiguity you did not resolve goes under `## Open Questions` as a question. Running headless with nobody to answer, recording it is the correct outcome; never close the gap by prediction.

In both sections one entry is one top-level `- ` bullet, wrapped with indented continuation lines. `wep judge verify` reads only top-level bullets, so an entry written as a bare paragraph is invisible to it. The `wep-task` skill holds the full procedure.

## Workflow selection

When installed, read the live values from .wep/config.json:

- defaults.workflow
- defaults.requireTaskCapsule
- defaults.requireWorkflowReason
- defaults.contextBudget
- workflowRules
- comprehensionGate

If defaults.workflow is task-fit, choose the smallest workflow that fits the task. If it is concrete, use it unless the user explicitly asks otherwise.

## Write Policy

- Task capsules: .wep/tasks/TASK-XXX-.../
- Doctor findings: .wep/wiki/
- Compiled briefs: .wep/tasks/TASK-XXX-.../exports/
- Decisions: .wep/wiki/decisions.md
- Task implementation notes: .wep/local/impl/TASK-XXX/log.md (local only; never inside the capsule)
- Personal comprehension records: .wep/local/comprehension/TASK-XXX/ (local only; never stage them)

## Independent review and comprehension

- If the installed config has judge.enabled true, ask for confirmation before invoking wep-judge after implementation. Once approved, capture an immutable local boundary with wep judge snapshot, then run wep judge run TASK-XXX --candidate SNAPSHOT:<id> once and give the judge the receipt path it prints; snapshot capture never changes Git state or live files.
- Whenever a judge review comes back, save its exact JSON record under .wep/local/judge/ and run wep judge verify <record> --receipt-digest <digest> before acting on the verdict, with the digest judge run printed. Validation runs once, in this working tree by default (in a disposable copy with --isolated); it never writes the immutable snapshot, and newer live edits do not invalidate an approval for older reviewed content. While judge run is running, do not edit project files: a change to a reviewed file invalidates the run (exit code 5).
- Use wep judge current <record> to distinguish CURRENT, NEWER_CHANGES, and DIVERGED. For newer changes, create a catch-up snapshot with --from-review <record> --receipt-digest <digest> and review only that delta; never stretch an old approval over new code.
- Always verify with --receipt-digest, or with --run-tests for a fresh run. Without one of them, verification accepts the judge's claim that validation passed. You are the trusted caller and you can execute; the judge executes nothing and reads the receipt, and the comprehension agent passes neither flag. Pin the digest from your own observation of judge run, never from the record or the judge's report: a local receipt cannot authenticate its writer. judge run and --run-tests require a snapshot candidate and never run anything unapproved: commands pre-approved with wep task approve-commands run without asking; otherwise the CLI prints the declared commands and asks, or headless requires --approve-commands once per command in declared order. Read that list before approving — an in-place judge run writes into this working tree, and the disposable copy of --isolated and --run-tests only isolates ordinary relative writes; neither is an OS sandbox for malicious commands.
- If the installed config has comprehensionGate.enabled true, ask separately before invoking wep-comprehension, and hand off only when the verification above reports APPROVED and current.
- Give the comprehension agent only the task ID, exact base/candidate boundary, and verified judge-record path. Do not pass implementation explanations, suggested questions, expected answers, or the main conversation history as evidence.
- The comprehension agent owns the interactive teaching session and personal learning artifacts. The primary agent must not ask or grade comprehension questions itself.
- For a multi-turn checkpoint, have the developer select this agent directly or start `claude --agent wep-comprehension`; Claude subagents cannot ask UI questions.

## Safety

- Protected instructions are deny-by-default. Preserve them and use suggested files for conflicts.
- During Doctor only, you may edit a protected instruction file after you show the exact minimal diff and the human explicitly approves that exact change in the current conversation. Silence, old approvals, and general requests to "fix everything" are not approval. If the proposal or target changes, show the new diff and ask again.
- Do not read secrets or credentials (.env, *.pem, *.key, *.p12, *.pfx, secrets/, credentials/).
- Keep root instructions minimal. Load detailed workflows from target skills/prompts only when relevant.

## Before handoff

```bash
pnpm build
pnpm test
pnpm lint
pnpm wep init --target codex --dry-run
pnpm wep doctor --json
```
