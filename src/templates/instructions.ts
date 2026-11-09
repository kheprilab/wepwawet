import type { Target } from "../types.js";

export const targetReferenceTemplates: Record<Target, string> = {
  codex: "# Codex Target\n\nUse `AGENTS.md` and `.agents/skills/wep-*` as the primary wep harness.\n",
  claude:
    "# Claude Code Target\n\nUse `CLAUDE.md`, `.claude/skills/wep-*`, and `.claude/commands/` as the target adapter.\n\nFor the clarification step in `wep-task`, this host has a native question UI (`AskUserQuestion`); prefer it over enumerating options in prose. This is a rendering detail only — what gets written to the capsule is identical on every target.\n",
  copilot:
    "# GitHub Copilot Target\n\nUse `.github/copilot-instructions.md`, `.github/instructions/`, `.github/prompts/`, and `.github/skills/wep-*` as the target adapter. Skills are the reusable workflow surface; prompts are for one-shot invocation.\n",
  pi: "# Pi Code Target\n\nUse `.pi/prompts/` and `.pi/skills/wep-*` as the target adapter.\n",
};

export function mainInstructionTemplate(target: Target): string {
  const heading =
    target === "claude" ? "CLAUDE.md" : target === "copilot" ? "GitHub Copilot Instructions" : "AGENTS.md";
  const comprehensionInvocation =
    target === "claude"
      ? "For a multi-turn checkpoint, have the developer select this agent directly or start `claude --agent wep-comprehension`; Claude subagents cannot ask UI questions."
      : target === "copilot"
        ? "Use the agent picker or explicitly invoke the repository `wep Comprehension` custom agent for the interactive checkpoint."
        : target === "codex"
          ? "Spawn the project `wep-comprehension` agent, keep it in a separate thread, and direct the developer to continue the checkpoint in that thread."
          : "Pi has no native independent comprehension agent; do not run the checkpoint in the primary context.";
  return `# ${heading} - wep

This repository uses wep as a local agentic workflow harness. Treat .wep/ as the workflow source of truth.

## Mandatory Behavior

When the user asks to implement a feature, fix, refactor, or meaningful code change:

1. Read .wep/config.json and .wep/policy.json.
2. Create or update a task capsule under .wep/tasks/TASK-XXX-.../ before implementation.
3. Record the chosen workflow and the reason in the capsule.
4. Resolve ambiguity before implementing. See the clarification step below.
5. Follow the workflow from config unless the user explicitly overrides it.
6. Load only relevant context. Do not read all of .wep/ by default.
7. After implementation by you or wep-implementer, update the task review checklist and run relevant validation.
8. After implementation, follow the independent review and comprehension handoff below.

Create the task capsule yourself — do not ask the user to run \`wep task\`. The CLI task command is a headless fallback for scripts and CI. During normal agent use, YOU are responsible for creating and filling the task capsule with real context from the codebase.

## Clarification and Approval Brief

Ask the user before implementing when two plausible answers would produce different implementation, validation, or scope. If every plausible answer leads to the same code, it is not a question — do not ask it. There is no cap on the number of questions and no budget; the count follows from that test. There is no "assume and proceed" option, because the test already excludes trivia.

Record each answer under \`## Clarifications\` in the capsule's task.md, beneath a \`### Session YYYY-MM-DD\` heading, and propagate any answer that changes a criterion into acceptance-criteria.md. Ambiguity you did not resolve goes under \`## Open Questions\` as a question. Running headless with nobody to answer, recording it is the correct outcome; never close the gap by prediction.

In both sections one entry is one top-level \`- \` bullet, wrapped with indented continuation lines. \`wep judge verify\` reads only top-level bullets, so an entry written as a bare paragraph is invisible to it. The \`wep-task\` skill holds the full procedure.

Once clarifications are resolved, do not ask the human to read all five capsule files — those files are the machine contract. Present a concise **Approval Brief** (~20 seconds to read) containing:

1. **Workflow**: chosen workflow and a 1-line reason.
2. **Clarifications**: decisions resolved in this session (if any).
3. **Acceptance Criteria (\`AC-1\`, \`AC-2\`, ...)**: the numbered criteria from \`acceptance-criteria.md\`. Frame these as the standalone **Goldfish contract** — \`wep-implementer\` and \`wep-judge\` run in isolated, zero-memory contexts without chat history and judge strictly against these \`AC-<n>\` entries.
4. **Validation Commands**: the exact commands declared under \`## Validation\` in \`task.md\`.

Ask once whether the Approval Brief matches what the human wants. When approved, record command approval with \`wep task approve-commands TASK-XXX\` (bound to the SHA-256 digest of \`## Validation\`) so \`wep judge run\` can execute them without prompting again unless the command list changes.

## Implementation Delegation

Before considering delegation, run \`wep impl status TASK-XXX --json\` and use its resolved \`enabled\` and \`trigger\` fields as the single source of truth; this includes legacy \`impl.enabled\` fallback. If \`enabled\` is false, do not offer or start the implementer. Never delegate automatically: every handoff to \`wep-implementer\` requires explicit human confirmation.

Honor the resolved trigger as follows:

- \`on-request\`: offer the handoff only when the user asks to use the implementer.
- \`post-clarification\`: when the capsule is ready, clarifications are resolved, and the human approves the Approval Brief, that single approval is the explicit human confirmation to start implementation and delegate to \`wep-implementer\` — do not ask a second confirmation question.
- Any other trigger: preserve the warning and do not invent an automatic invocation; wait for an explicit user request and confirmation.

Before its first approved round, direct the implementer to run \`wep impl start TASK-XXX\`; use \`wep impl status TASK-XXX --json\` to check the remaining attempt budget.

You remain the owner of the capsule, validation, and handoff to \`wep-judge\`. The implementer writes code and records its round; it does not take over those responsibilities.

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

- Complete the checklist and all capsule changes before snapshot capture. The final checklist state must say the capsule is ready for independent review; do not add a completion item that can only be checked after APPROVED.
- If judge.enabled (or agents.judge.enabled) is true, do not ask for confirmation before invoking wep-judge after implementation: automatically capture an immutable local boundary with wep judge snapshot, run wep judge run TASK-XXX --candidate SNAPSHOT:<id> once, and invoke wep-judge on that SNAPSHOT:<id> candidate with the receipt path it printed. judge run validates in this working tree by default and blocks: do not edit project files until it finishes, because a change to a reviewed file invalidates the run (exit code 5); use --isolated only when work must continue meanwhile; snapshot capture never changes Git state or live files. Keep the receipt digest judge run printed: it is the only proof that the receipt is the one this run wrote. Only interrupt the human if a verified review reports NEEDS_CHANGES or BLOCKED that cannot be resolved within the approved contract.
- A lone no-runtime-validation: <reason> declaration is not a shell command. For that explicit case, judge run returns exit 0 with outcome no-runtime-validation, passed: false, and a documentation receipt with zero commands/results. Continue with independent criteria review and pinned-receipt verification; the reviewer records tests: [] and nobody claims runtime validation passed. The reason and snapshot remain bound to the receipt.
- Whenever a judge review comes back, save its exact JSON record under .wep/local/judge/ and run wep judge verify <record> --receipt-digest <digest> with the digest judge run printed, before acting on the verdict. Validation runs once, in this working tree by default (or in a disposable copy with --isolated); it never writes the immutable snapshot, and newer live edits do not invalidate an approval for older reviewed content. For Claude Code, enabling the judge installs a guard hook in .claude/settings.local.json that refuses file-writing tools while a run holds the lock; other hosts rely on the after-run check, so do not edit project files while judge run is running.
- Do not edit the task capsule or checklist after the judge snapshot to record that review completed. The verified APPROVED record and judge current reports CURRENT are the evidence that the review completed; there is no post-judge administrative write.
- Use wep judge current <record> to distinguish CURRENT, NEWER_CHANGES, and DIVERGED. For newer changes, create a catch-up snapshot from the verified record and review only that delta; never stretch an old approval over new code.
- Substantive changes still require catch-up review, even when the change is limited to a capsule file.
- Always verify with --receipt-digest, or with --run-tests for a fresh run. Without one of them, verification accepts the judge's claim that validation passed. The judge executes no validation; it reads the receipt. Pin the digest from your own observation of judge run, never from the record or the judge's report: a local receipt cannot authenticate its writer, so the trust comes from the digest you saw. The comprehension evaluator checks the record without executing validation. judge run and --run-tests require a snapshot candidate and never run anything unapproved: if the commands match the digest pre-approved with wep task approve-commands TASK-XXX, they run without prompting again; otherwise the CLI prints the declared commands and asks, or headless requires --approve-commands once per command in declared order. Read that list before approving — an in-place judge run writes into this working tree, and the disposable copy of --isolated and --run-tests only isolates ordinary relative writes; neither is an OS sandbox for malicious commands.
- When verification reports APPROVED, close the task with an evidence-based closure summary (task header, each \`AC-<n> ✓\` with its evidence, respected decisions from \`## Clarifications\`, and any pending comprehension count) rather than raw JSON output.
- Do not interrupt the human at the end of a task to ask whether to launch wep-comprehension. Comprehension checkpoints are asynchronous and surfaced via \`wep status\`; invoke \`wep-comprehension\` only when the developer requests a checkpoint and only when the verification above reports APPROVED and current.
- Give the comprehension agent only the task ID, exact base/candidate boundary, and verified judge-record path. Do not pass implementation explanations, suggested questions, expected answers, or the main conversation history as evidence.
- The comprehension agent owns the interactive teaching session and personal learning artifacts. The primary agent must not ask or grade comprehension questions itself.
- ${comprehensionInvocation}

## Safety

- Protected instructions are deny-by-default. Preserve them and use suggested files for conflicts.
- During Doctor only, you may edit a protected instruction file after you show the exact minimal diff and the human explicitly approves that exact change in the current conversation. Silence, old approvals, and general requests to "fix everything" are not approval. If the proposal or target changes, show the new diff and ask again.
- Do not read secrets or credentials (.env, *.pem, *.key, *.p12, *.pfx, secrets/, credentials/).
- Keep root instructions minimal. Load detailed workflows from target skills/prompts only when relevant.
`;
}

function skillTemplate(name: string, description: string, body: string): string {
  return `---
name: ${name}
description: ${description}
---

# ${name}

${body}
`;
}

const initBody =
  "Detect existing Codex, Claude, Copilot, and Pi Code setup. Preserve all user-authored instruction files. Add missing wep structure and create suggested files for conflicts.";
const doctorBody = `You are the semantic Doctor workflow. The \`wep doctor\` CLI performs deterministic setup checks; your role is to interpret agent instructions, project docs, task templates, harness policy, and quality gates. Update .wep/wiki/ and propose instruction merges. Treat the wiki as a living artifact: add architecture patterns, conventions, testing commands, and decisions as you discover them. Do not implement product features during doctor.

## Instruction placement rubric

Classify each instruction or coherent block by load tier and discoverability. Use the narrowest tier that still loads the instruction before it is needed.

### Tiers

- **Always loaded** — \`CLAUDE.md\`, \`AGENTS.md\`, \`.github/copilot-instructions.md\`, and skill \`description\` fields. Keep only rules that are not quickly discoverable or must be known before search or action.
- **Loaded on match** — skill bodies, subagent definitions, and scoped \`.github/instructions/*.instructions.md\`. Put specific workflows and path rules here.
- **Loaded on invocation** — \`.github/prompts/*.prompt.md\` and \`.claude/commands/*.md\`. Check these for staleness and duplication, not length.

Treat nested \`CLAUDE.md\` and \`AGENTS.md\` as always loaded within their subtree.

### Verdicts

Assign exactly one verdict:

- **keep** — useful, not quickly discoverable, and already at the right tier.
- **move** — useful but at the wrong tier. Prefer this verdict for misplaced content.
- **delete** — already stated by code, configuration, or standard tooling.
- **verify** — stale, unsupported, or maintainer-owned. Record the uncertainty; do not guess.

Move down by default. Move up only when evidence shows the instruction must govern every applicable task or be known before discovery, especially safety, approval, and global workflow rules.

### Always-loaded content

Keep global safety and approval rules, exact commands with required flags and working directory, limits, environment-variable effects, intentional constraints, non-obvious structure, behavior outside the repository, and the shortest commands that validate common changes.

Move or delete project summaries, tech-stack lists, obvious folder maps, endpoint schemas, generic advice, formatter or linter rules, and copied README content.

### Routing metadata

- Flag a missing or empty \`applyTo\` as unreliable routing.
- Treat \`applyTo: "**"\` as repository-wide. Move its content to the root instruction surface or narrow the glob.
- Test every glob against the current tree.
- Require every skill or agent \`description\` to state what it does and when to use it.
- Remove the same rule from multiple tiers.

Apply this rubric before proposing a merge. Record verdicts, evidence, and destinations in \`.wep/wiki/instruction-audit.md\`; the CLI Doctor does not overwrite it. Route protected-file changes through the merge protocol below.

## Protected instruction merge

Protected files remain deny-by-default. When a matching \`.wep.suggested.md\` file exists:

1. Compare it with the protected instruction file and derive the smallest semantic merge; never replace project-specific instructions with the whole suggestion.
2. Show the exact proposed diff and explain each change briefly. Do not edit the protected file yet.
3. Ask for explicit human approval of that exact diff. Approval is valid only in the current conversation. Silence, approval from another session, or a broad request such as "fix everything" is not approval.
4. If approved, apply only the shown changes directly to the protected file. If either file changed or the patch must change, stop, show a fresh diff, and ask again.
5. Show the resulting diff, verify the intended instructions are present, rerun \`wep doctor\`, and remove the matching suggested file only after the merge is verified.

This is the only Doctor exception to \`protectedFiles\` and \`writePolicy.doctor\`. Never use \`--force\` to bypass it.`;
const taskBody = `Turn the request into a task capsule with goal, scope, context, explicit workflow choice, acceptance criteria, validation commands, and an implementation brief.

## Clarify before implementing

Resolve ambiguity with the human before writing code, and leave the resolution in the capsule where the judge can read it.

**When a question exists.** Ask only when two plausible answers would produce different implementation, validation, or scope. If every plausible answer leads to the same code, it is not a question — do not ask it.

**How many.** There is no cap and no budget; the count falls out of the test above. A well-specified patch yields zero questions. An undefined contract yields as many as it takes. Never pad the list to look thorough, and never stop while a real ambiguity is left.

There is no "assume and proceed" option. The test above already excludes trivia, so assuming would only ever mean guessing about something that mattered.

**How to ask.** Plain text in a normal turn: one question, its alternatives enumerated, and what each would change. Ask one at a time so a later question can use an earlier answer. Decide matters of style yourself, and do not ask the human to design the implementation for you.

**Where the answer goes.** After each answer, before asking the next, append it under \`## Clarifications\` in task.md beneath a \`### Session YYYY-MM-DD\` heading carrying today's date. If the answer changes a criterion, propagate it into acceptance-criteria.md. The capsule is the artifact; the conversation is not.

**What stays open.** Ambiguity you did not resolve goes under \`## Open Questions\`, written as a question. Running headless with nobody to answer, that is the correct outcome: record it and treat the capsule as not ready. Never close the gap by prediction.

**Criterion identifiers.** Every criterion in acceptance-criteria.md is one top-level \`- \` bullet that starts with \`AC-<n>: \`. Number them from 1 in declared order and keep each identifier stable; the judge reports one typed result per identifier. For an older capsule with unnumbered criteria, run \`wep task migrate-criteria TASK-XXX\`.

**Criterion proof.** A criterion can declare expected evidence on indented lines under its bullet: \`proof-command: <command>\` names a command already listed under \`## Validation\`, and \`proof-doc: <path>[#Heading]\` points the judge at a repository file. Both are optional, with one reference per line. Declare a proof only where it fits. A criterion that needs judgment carries none. A passing command never replaces the judge's assessment, and a proof adds no command to run.

**Format, in both sections.** One entry is one top-level \`- \` bullet; wrap long entries with indented continuation lines. \`wep judge verify\` reads only top-level bullets, because both sections also carry explanatory prose that must not be mistaken for content. An entry written as a bare paragraph is invisible to it — the section reads as empty and no notice is emitted.

## Approval Brief (Goldfish boundary)

The five capsule files are the machine contract for subagents; do not ask the human to read all five files. Once clarifications are resolved, present a concise **Approval Brief** (~20 seconds to read):

1. **Workflow**: chosen workflow and a 1-line reason.
2. **Clarifications**: decisions resolved in this session (if any).
3. **Acceptance Criteria (\`AC-1\`, \`AC-2\`, ...)**: the numbered criteria from \`acceptance-criteria.md\`. These form the standalone **Goldfish contract** that stateless subagents (\`wep-implementer\` and \`wep-judge\`) read without conversation history.
4. **Validation Commands**: the exact commands declared under \`## Validation\` in \`task.md\`.

Approving the Approval Brief is the single up-front gate: it confirms the contract, pre-approves the declared validation commands via \`wep task approve-commands TASK-XXX\` (bound to their SHA-256 digest), and authorizes implementation (including delegation to \`wep-implementer\` when \`post-clarification\` is active).`;
const reviewBody =
  "Check whether the task capsule is ready: goal clarity, testability, relevant context, blocked secrets, scope control, validation commands, and human-approved merge strategy.";
const workflowBody = `Use the workflow named in the task capsule.

## fast-patch

1. Load only the files directly touched by the change.
2. Make the smallest safe edit that satisfies the goal.
3. Verify the change does not break adjacent behavior.
4. No spec or new tests unless they already exist.

## research-first

1. Read .wep/config.json, policy.json, and relevant wiki pages without modifying code.
2. Inspect relevant files, git log, and .wep/wiki/decisions.md.
3. List open questions and areas of uncertainty in the task capsule.
4. Propose an approach and wait for user confirmation before implementing.
5. Switch to a concrete workflow (TDD, SDD, etc.) for implementation.

## SDD

1. Write or update the behavior contract: inputs, outputs, preconditions, postconditions, and explicit out-of-scope boundaries.
2. Record the contract in the task capsule before touching implementation files.
3. Implement only what the contract specifies.

## TDD

1. Write failing tests that encode the expected behavior. Confirm they fail for the right reason.
2. Implement the minimum code to make the tests pass.
3. Refactor if needed, keeping tests green.

## EDD

1. Define concrete examples and edge cases: happy paths, empty inputs, boundary values, unexpected combinations.
2. Record examples in the task capsule.
3. Implement against those examples.

## SDD+TDD

1. Write the behavior contract (SDD).
2. Encode the contract as failing tests (TDD).
3. Implement until tests pass.

## SDD+EDD

1. Write the behavior contract (SDD).
2. Define examples and edge cases that illustrate the contract (EDD).
3. Implement against contract and examples.

## TDD+EDD

1. Define examples and edge cases (EDD).
2. Encode each example as a failing test (TDD).
3. Implement until tests pass.

## UI review

1. Check for existing UI conventions in project instructions or .wep/wiki/conventions.md. If the project defines its own UI review process, follow it instead.
2. Discover which tools are present: stylelint, eslint with style or a11y rules, storybook, playwright, cypress, chromatic, percy, or any browser preview command in package.json scripts.
3. Run the tools that are available. Do not skip tools without noting why.
4. Report findings ordered by severity. Reference file and line where possible.
5. Do not modify code unless the user explicitly asks for fixes after the review.

Do not expand into a heavyweight process unless the task capsule or user explicitly asks for it.

## Judge

If \`judge.enabled\` (or \`agents.judge.enabled\`) is \`true\` in \`.wep/config.json\` (enabled by default), automatically capture the live boundary with \`wep judge snapshot TASK-XXX --base <ref>\` as soon as implementation and checklist updates are complete, run \`wep judge run TASK-XXX --candidate SNAPSHOT:<id>\` once, and invoke the \`wep-judge\` subagent on that \`SNAPSHOT:<id>\` candidate with the receipt path, without asking for confirmation first. Keep the receipt digest that \`judge run\` printed. \`judge run\` validates in this working tree by default, with the project's own environment, and holds a run lock until it finishes. Tell the human it is running and that project files must not be edited meanwhile: a change to a tracked or untracked-not-ignored file invalidates the run, while Git-ignored build output may change. Declare check-mode commands in \`## Validation\` (for example \`--check\`, not \`--write\`). Use \`--isolated\` to run in a disposable copy when work must continue. Exit codes: 0 passed, 1 a required command failed, 3 approval missing, 4 another run holds the lock (retry later), 5 the tree changed during the run (retry), 6 the tree no longer matches the snapshot (capture a new one). The judge reads the task capsule and changed code in an isolated Goldfish context and reports APPROVED / NEEDS_CHANGES / BLOCKED. Capture writes ignored local artifacts only: it never commits, stages, stashes, checks out, creates a branch or ref, or changes live files. Its reviewable worktree omits policy-blocked paths and holds source only, with no dependency directory. The user and other agents can keep working while the immutable snapshot is reviewed.

For a capsule that explicitly declares \`no-runtime-validation: <reason>\`, \`judge run\` writes a \`documentation\` receipt without executing commands or provisioning dependencies. It returns exit 0 with \`outcome: "no-runtime-validation"\` and \`passed: false\`, not a failed run and not a claim that runtime tests passed. Give that receipt to the independent judge, which evaluates the criteria and records \`tests: []\`. Verify using the printed receipt digest as usual. A blank validation block is still unfinished and cannot use this path.

When a review comes back, save the judge's exact JSON record under \`.wep/local/judge/\` and run \`wep judge verify <review.json> --receipt-digest <digest>\` with the digest \`judge run\` printed, before acting on the verdict. It executes nothing: it checks that the receipt is unchanged, still bound to the snapshot, its commands and lockfiles, and backs every command the record claims passed. Use \`--run-tests\` instead only for a fresh run. \`judge run\` executes declared commands in this working tree by default; \`judge run --isolated\` and \`--run-tests\` execute them in a disposable copy outside the live project, with dependencies materialised from the lockfile rather than inherited from the snapshot. None of them mutates the immutable source snapshot. For Claude Code, enabling the judge installs a guard hook in \`.claude/settings.local.json\` that refuses file-writing tools while a run holds the lock; other hosts rely on the after-run check. An in-place run writes into this working tree; the disposable copy of \`--isolated\` and \`--run-tests\` only isolates ordinary relative writes, and none of them is an OS sandbox for malicious commands with absolute paths. All of them only accept a snapshot candidate, and never execute without approval: if the commands match the digest pre-approved with \`wep task approve-commands TASK-XXX\`, they run automatically; otherwise the CLI shows the declared commands and asks, or headless requires \`--approve-commands\` once per command in declared order. Do this whenever the judge runs, not only when comprehension is enabled — an unverified verdict is an unchecked claim, and without \`--receipt-digest\` or \`--run-tests\` the CLI takes the judge's word that validation passed. Read the list before approving it on work you did not supervise.

New live edits do not invalidate a snapshot approval. Use \`wep judge current <review.json>\` to validate the approved record and distinguish \`CURRENT\`, \`NEWER_CHANGES\`, and \`DIVERGED\`. For newer changes, capture \`wep judge snapshot TASK-XXX --from-review <review.json> --receipt-digest <digest>\`; catch-up verifies the parent from its pinned receipt (without \`--receipt-digest\` it re-runs the parent's declared passing validation) and preserves its intact ancestry. Ask the judge to review only that delta; never extend the old approval silently. Use \`wep judge prune --keep <n>\` to preview local retention and add \`--force\` only after reviewing the count.

When verification reports \`APPROVED\`, present the evidence-based closure summary (task header, each \`AC-<n> ✓\` with its evidence, respected clarifications, and any pending comprehension count). Do not ask the user at the end of the task whether to run \`wep-comprehension\`; comprehension sessions are asynchronous and tracked in \`wep status\`. When the developer requests a comprehension checkpoint, hand off only when verification says the approval is current. If the judge is disabled, disclose that no independent correctness review exists before running comprehension. Pass only the task ID, exact base/candidate boundary, and verified judge-record path to the comprehension agent. Never pass your implementation narrative, explanations, suggested questions, or expected answers. The comprehension agent owns all teaching, questions, answers, and learning artifacts in its separate context.`;
const writePolicyBody =
  "Write durable context only to the paths in .wep/wiki/write-policy.md. Keep the wiki alive: update architecture.md, conventions.md, testing.md, and decisions.md as the project evolves. Protected instructions remain read-only except for the narrow Doctor merge defined by policy.protectedFileMerge: show the exact diff, receive explicit approval in the current conversation, then apply only that diff. Do not read all of .wep/ by default. Prefer the active task capsule, policy.json, and only relevant wiki pages.";

const sharedSkills = {
  "wep-init": ["Use when installing or reviewing the wep harness in a repository.", initBody],
  "wep-doctor": ["Use when auditing whether a repo is ready for AI coding agents.", doctorBody],
  "wep-task": ["Use when turning a development request into a wep task capsule.", taskBody],
  "wep-review": [
    "Use before or after implementation to verify task readiness, quality gates, tests, and scope.",
    reviewBody,
  ],
  "wep-workflow": [
    "Use when selecting or applying SDD, TDD, EDD, research-first, fast-patch, UI review, or combined workflows.",
    workflowBody,
  ],
  "wep-write-policy": [
    "Use when deciding where wep should persist wiki notes, task notes, decisions, or compiled briefs.",
    writePolicyBody,
  ],
} as const;

function skillFiles(prefix: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(sharedSkills).map(([name, [description, body]]) => [
      `${prefix}/${name}/SKILL.md`,
      skillTemplate(name, description, body),
    ]),
  );
}

export const codexSkills: Record<string, string> = skillFiles(".agents/skills");

export const claudeSkills: Record<string, string> = skillFiles(".claude/skills");

export const copilotSkills: Record<string, string> = skillFiles(".github/skills");

export const claudeCommands: Record<string, string> = {
  ".claude/commands/wep-doctor.md":
    "# wep Doctor\n\nUse the `wep-doctor` skill. Preserve protected instructions by default. Edit one only after showing the exact diff and receiving explicit human approval in the current conversation.\n",
  ".claude/commands/wep-task.md":
    "# wep Task\n\nUse the `wep-task` skill. Create or refine a wep task capsule before implementation.\n",
};

export const copilotFiles: Record<string, string> = {
  ".github/instructions/wep.instructions.md": `---
applyTo: ".wep/**"
---

# wep Instructions

When editing the wep harness, preserve existing instruction files and avoid secrets. Treat \`.wep/\` as the neutral source of truth, but open only the current task capsule, policy, and relevant wiki pages.
`,
  ".github/prompts/wep-doctor.prompt.md":
    "# wep Doctor\n\nUse the `wep-doctor` skill. Audit agent setup, wiki coverage, task templates, and quality gates. Protected instructions are deny-by-default: show the exact minimal diff and obtain explicit human approval in the current conversation before editing one. Do not implement product features during doctor.\n",
  ".github/prompts/wep-task.prompt.md":
    "# wep Task\n\nPrepare a task capsule with scope, context, acceptance criteria, and validation commands.\n",
  ".github/prompts/wep-workflow.prompt.md":
    "# wep Workflow\n\nApply the task capsule workflow: fast-patch, research-first, SDD, TDD, EDD, SDD+TDD, SDD+EDD, TDD+EDD, or UI review. Keep the process proportional to task risk.\n",
  ".github/prompts/wep-write-policy.prompt.md":
    "# wep Write Policy\n\nWrite durable notes only to the wep write-policy paths. Do not overwrite existing instructions without human approval.\n",
};

export const piSkills: Record<string, string> = skillFiles(".pi/skills");

export const piFiles: Record<string, string> = {
  ".pi/prompts/wep-doctor.md":
    "# wep Doctor\n\nUse the `wep-doctor` skill. Audit this repository's wep setup and propose safe normalization. Protected instructions may be edited only after showing the exact diff and receiving explicit human approval in the current conversation.\n",
  ".pi/prompts/wep-task.md": "# wep Task\n\nPrepare a wep task capsule before implementation.\n",
  ".pi/prompts/wep-workflow.md":
    "# wep Workflow\n\nUse the task capsule workflow. Supported modes: fast-patch, research-first, SDD, TDD, EDD, SDD+TDD, SDD+EDD, TDD+EDD, UI review.\n",
  ".pi/prompts/wep-write-policy.md":
    "# wep Write Policy\n\nPersist notes only in approved wep paths. Do not read all of `.wep/` by default.\n",
};
