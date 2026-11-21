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

## Clarification and Approval Brief

Ask the user before implementing when two plausible answers would produce different implementation, validation, or scope. If every plausible answer leads to the same code, it is not a question — do not ask it. There is no cap on the number of questions and no budget; the count follows from that test. There is no "assume and proceed" option, because the test already excludes trivia.

Record each answer under `## Clarifications` in the capsule's task.md, beneath a `### Session YYYY-MM-DD` heading, and propagate any answer that changes a criterion into acceptance-criteria.md. Ambiguity you did not resolve goes under `## Open Questions` as a question. Running headless with nobody to answer, recording it is the correct outcome; never close the gap by prediction.

In both sections one entry is one top-level `- ` bullet, wrapped with indented continuation lines. `wep judge verify` reads only top-level bullets, so an entry written as a bare paragraph is invisible to it. The `wep-task` skill holds the full procedure.

Once clarifications are resolved, do not ask the human to read all five capsule files — those files are the machine contract. Present a concise **Approval Brief** (~20 seconds to read) containing:

1. **Workflow**: chosen workflow and a 1-line reason.
2. **Clarifications**: decisions resolved in this session (if any).
3. **Acceptance Criteria (`AC-1`, `AC-2`, ...)**: the numbered criteria from `acceptance-criteria.md`. Frame these as the standalone **Goldfish contract** — `wep-implementer` and `wep-judge` run in isolated, zero-memory contexts without chat history and judge strictly against these `AC-<n>` entries.
4. **Validation Commands**: the exact commands declared under `## Validation` in `task.md`.

Ask once whether the Approval Brief matches what the human wants. When approved, record command approval with `wep task approve-commands TASK-XXX` (bound to the SHA-256 digest of `## Validation`) so `wep judge run` can execute them without prompting again unless the command list changes.

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

## Independent Review and Comprehension

- Complete the checklist and all capsule changes before snapshot capture. The final checklist state must say the capsule is ready for independent review; do not add a completion item that can only be checked after APPROVED.
- If judge.enabled (or agents.judge.enabled) is true, do not ask for confirmation before invoking wep-judge after implementation: automatically capture an immutable local boundary with wep judge snapshot, run wep judge run TASK-XXX --candidate SNAPSHOT:<id> once, and invoke wep-judge on that SNAPSHOT:<id> candidate with the receipt path it printed. judge run validates in this working tree by default and blocks: do not edit project files until it finishes, because a change to a reviewed file invalidates the run (exit code 5); use --isolated only when work must continue meanwhile; snapshot capture never changes Git state or live files. Keep the receipt digest judge run printed: it is the only proof that the receipt is the one this run wrote. Only interrupt the human if a verified review reports NEEDS_CHANGES or BLOCKED that cannot be resolved within the approved contract.
- A lone no-runtime-validation: <reason> declaration is not a shell command. For that explicit case, judge run returns exit 0 with outcome no-runtime-validation, passed: false, and a documentation receipt with zero commands/results. Continue with independent criteria review and pinned-receipt verification; the reviewer records tests: [] and nobody claims runtime validation passed. The reason and snapshot remain bound to the receipt.
- Whenever a judge review comes back, save its exact JSON record under .wep/local/judge/ and run wep judge verify <record> --receipt-digest <digest> with the digest judge run printed, before acting on the verdict. Validation runs once, in this working tree by default (or in a disposable copy with --isolated); it never writes the immutable snapshot, and newer live edits do not invalidate an approval for older reviewed content. For Claude Code, enabling the judge installs a guard hook in .claude/settings.local.json that refuses file-writing tools while a run holds the lock; other hosts rely on the after-run check, so do not edit project files while judge run is running.
- Do not edit the task capsule or checklist after the judge snapshot to record that review completed. The verified APPROVED record and judge current reports CURRENT are the evidence that the review completed; there is no post-judge administrative write.
- Use wep judge current <record> to distinguish CURRENT, NEWER_CHANGES, and DIVERGED. For newer changes, create a catch-up snapshot from the verified record and review only that delta; never stretch an old approval over new code.
- Substantive changes still require catch-up review, even when the change is limited to a capsule file.
- Always verify with --receipt-digest, or with --run-tests for a fresh run. Without one of them, verification accepts the judge's claim that validation passed. The judge executes no validation; it reads the receipt. Pin the digest from your own observation of judge run, never from the record or the judge's report: a local receipt cannot authenticate its writer, so the trust comes from the digest you saw. The comprehension evaluator checks the record without executing validation. judge run and --run-tests require a snapshot candidate and never run anything unapproved: if the commands match the digest pre-approved with wep task approve-commands TASK-XXX, they run without prompting again; otherwise the CLI prints the declared commands and asks, or headless requires --approve-commands once per command in declared order. Read that list before approving — an in-place judge run writes into this working tree, and the disposable copy of --isolated and --run-tests only isolates ordinary relative writes; neither is an OS sandbox for malicious commands.
- When verification reports APPROVED, close the task with an evidence-based closure summary (task header, each `AC-<n> ✓` with its evidence, respected decisions from `## Clarifications`, and any pending comprehension count) rather than raw JSON output.
- Do not interrupt the human at the end of a task to ask whether to launch wep-comprehension. Comprehension checkpoints are asynchronous and surfaced via `wep status`; invoke `wep-comprehension` only when the developer requests a checkpoint and only when the verification above reports APPROVED and current.
- Give the comprehension agent only the task ID, exact base/candidate boundary, and verified judge-record path. Do not pass implementation explanations, suggested questions, expected answers, or the main conversation history as evidence.
- The comprehension agent owns the interactive teaching session and personal learning artifacts. The primary agent must not ask or grade comprehension questions itself.
- Spawn the project `wep-comprehension` agent, keep it in a separate thread, and direct the developer to continue the checkpoint in that thread.

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
