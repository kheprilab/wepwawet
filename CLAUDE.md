# CLAUDE.md - wep

This repository uses wep as a local agentic workflow harness. Treat .wep/ as the workflow source of truth.

## Mandatory Behavior

When the user asks to implement a feature, fix, refactor, or meaningful code change:

1. Read .wep/config.json and .wep/policy.json.
2. Create or update a task capsule under .wep/tasks/TASK-XXX-.../ before implementation.
3. Record the chosen workflow and the reason in the capsule.
4. Resolve ambiguity before implementing. See the clarification step below.
5. Follow the workflow from config unless the user explicitly overrides it.
6. Load only relevant context. Do not read all of .wep/ by default.
7. After implementation, update the task review checklist and run relevant validation.
8. After implementation, follow the independent review and comprehension handoff below.

Create the task capsule yourself — do not ask the user to run `wep task`. The CLI task command is a headless fallback for scripts and CI. During normal agent use, YOU are responsible for creating and filling the task capsule with real context from the codebase.

## Clarification

Ask the user before implementing when two plausible answers would produce different implementation, validation, or scope. If every plausible answer leads to the same code, it is not a question — do not ask it. There is no cap on the number of questions and no budget; the count follows from that test. There is no "assume and proceed" option, because the test already excludes trivia.

Record each answer under `## Clarifications` in the capsule's task.md, beneath a `### Session YYYY-MM-DD` heading, and propagate any answer that changes a criterion into acceptance-criteria.md. Ambiguity you did not resolve goes under `## Open Questions` as a question. Running headless with nobody to answer, recording it is the correct outcome; never close the gap by prediction.

In both sections one entry is one top-level `- ` bullet, wrapped with indented continuation lines. `wep judge verify` reads only top-level bullets, so an entry written as a bare paragraph is invisible to it. The `wep-task` skill holds the full procedure.

## Workflow Selection

Read the live values from .wep/config.json:

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

- If judge.enabled is true, ask for confirmation before invoking wep-judge after implementation. Once approved, capture an immutable local boundary with wep judge snapshot, then run wep judge run TASK-XXX --candidate SNAPSHOT:<id> once and give the judge the receipt path it prints; snapshot capture never changes Git state or live files.
- Whenever a judge review comes back, save its exact JSON record under .wep/local/judge/ and run wep judge verify <record> --receipt-digest <digest> before acting on the verdict, with the digest judge run printed. Validation runs once, in this working tree by default (in a disposable copy with --isolated); it never writes the immutable snapshot, and newer live edits do not invalidate an approval for older reviewed content. While judge run is running, do not edit project files: a change to a reviewed file invalidates the run (exit code 5).
- Use wep judge current <record> to distinguish CURRENT, NEWER_CHANGES, and DIVERGED. For newer changes, create a catch-up snapshot with --from-review <record> --receipt-digest <digest> and review only that delta; never stretch an old approval over new code.
- Always verify with --receipt-digest, or with --run-tests for a fresh run. Without one of them, verification accepts the judge's claim that validation passed. You are the trusted caller and you can execute; the judge executes nothing and reads the receipt, and the comprehension agent passes neither flag. Pin the digest from your own observation of judge run, never from the record or the judge's report: a local receipt cannot authenticate its writer. judge run and --run-tests require a snapshot candidate and never run anything unapproved: commands pre-approved with wep task approve-commands run without asking; otherwise the CLI prints the declared commands and asks, or headless requires --approve-commands once per command in declared order. Read that list before approving — an in-place judge run writes into this working tree, and the disposable copy of --isolated and --run-tests only isolates ordinary relative writes; neither is an OS sandbox for malicious commands.
- If comprehensionGate.enabled is true, ask separately before invoking wep-comprehension, and hand off only when the verification above reports APPROVED and current.
- Give the comprehension agent only the task ID, exact base/candidate boundary, and verified judge-record path. Do not pass implementation explanations, suggested questions, expected answers, or the main conversation history as evidence.
- The comprehension agent owns the interactive teaching session and personal learning artifacts. The primary agent must not ask or grade comprehension questions itself.
- For a multi-turn checkpoint, have the developer select this agent directly or start `claude --agent wep-comprehension`; Claude subagents cannot ask UI questions.

## Safety

- Protected instructions are deny-by-default. Preserve them and use suggested files for conflicts.
- During Doctor only, you may edit a protected instruction file after you show the exact minimal diff and the human explicitly approves that exact change in the current conversation. Silence, old approvals, and general requests to "fix everything" are not approval. If the proposal or target changes, show the new diff and ask again.
- Do not read secrets or credentials (.env, *.pem, *.key, *.p12, *.pfx, secrets/, credentials/).
- Keep root instructions minimal. Load detailed workflows from target skills/prompts only when relevant.
