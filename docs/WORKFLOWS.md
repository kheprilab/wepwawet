# Workflows

wep supports explicit workflows without forcing every task into the same process.

## Supported Workflows

- `fast-patch`
- `research-first`
- `SDD`
- `TDD`
- `EDD`
- `SDD+TDD`
- `SDD+EDD`
- `TDD+EDD`
- `UI review` (auto-assigned via `workflowRules.ui`, not user-selectable as a default)

## Recommended Use

Use `fast-patch` for small, low-risk changes with obvious behavior.

Use `research-first` when the code area is unknown or the architecture is unclear.

Use `SDD` for APIs, contracts, schemas, permissions, and externally visible behavior.

Use `TDD` for bugs, regressions, and logic changes with clear expected outcomes.

Use `EDD` when examples and edge cases are the main source of clarity.

Use `SDD+TDD` for new or changed contracts that need executable tests.

Use `SDD+EDD` for rule-heavy domains where examples and boundaries matter.

Use `TDD+EDD` for bug fixes where examples clarify edge cases.

When using the optional implementer with a TDD workflow, its implementation log must preserve one ordered red→green pair in the
same round. The red validation records `phase: "red"`, `status: "failed"`, and an
`expectedFailure` whose text appears in its verbatim output; the green validation records
`phase: "green"`, `status: "passed"`, and follows with the same command after whitespace
normalization. A
missing or mismatched pair blocks the implementer handoff. Older logs remain readable but do
not receive invented evidence.

`UI review` is a task-level automatic recommendation, not a valid `--workflow` argument or configurable default. Use it for tasks that require reviewing or validating UI quality. The agent discovers available tools (stylelint, eslint, storybook, playwright, chromatic, etc.) and runs them without modifying code. If the project defines its own UI review conventions, those take precedence.

## Agent-First Flow

After `wep init`, the selected coding agent should own task preparation:

```txt
Run wep task workflow for invoice API examples. Use SDD+EDD.
```

The CLI task command is a deterministic fallback:

```bash
wep task "Define invoice API examples" --workflow SDD+EDD
```

Every task capsule should record:

```md
## Recommended Workflow

SDD+EDD

## Workflow Notes

- Workflow source: explicit user request.
- Why this workflow: invoice behavior needs a contract plus edge-case examples.
```

## Selection rules and limits

The coding agent reads `defaults.workflow`, `defaults.allowedWorkflows`, and
`workflowRules` from the project config. These are instructions for a cooperative agent.
The CLI fallback uses a narrower deterministic algorithm:

1. An explicit `--workflow` wins, provided it is in `allowedWorkflows`.
2. Otherwise, a concrete `defaults.workflow` wins and must be allowed.
3. With `task-fit`, hard-coded English keywords recommend a workflow. The CLI does not
   execute the `workflowRules` object as a rule engine. UI terms can recommend
   `UI review`; other disallowed recommendations fall back to the first allowed workflow.

`UI review` is not filtered by `allowedWorkflows`. For example,
`wep task "Review settings screen"` can recommend it, but
`wep task "Review settings screen" --workflow "UI review"` is rejected.
A UI review capsule is for inspection; ask for a suitable implementation workflow when
building or changing a UI.

The CLI creates a skeleton with placeholder context and criteria. It does not inspect
the codebase, resolve ambiguity, generate tests, or enforce the agent's execution of
SDD, TDD, or EDD. Complete the capsule before using it for implementation or review.
