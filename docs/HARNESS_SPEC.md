# Harness specification

Wepwawet installs project context, task templates, and instructions that a coding agent can read.
The CLI handles files and deterministic checks. The selected coding agent supplies project
understanding, implementation, review judgment, and teaching. Wepwawet does not call an LLM or
launch agents.

## Installed surfaces

Shared files live under `.wep/`; target adapters use each host's instruction and skill format.
The active modules determine which files are installed. `wep init` without `--modules` installs
all modules. A templates-only install does not install the task workflows described below.
See [Configuration](CONFIGURATION.md) for module dependencies and defaults, and
[Targets](TARGETS.md) for the complete file lists.

| Target | Main adapter surfaces | Agent profiles when enabled |
| --- | --- | --- |
| Codex | `AGENTS.md`, `.agents/skills/wep-*/SKILL.md` | `.codex/agents/wep-*.toml` |
| Claude Code | `CLAUDE.md`, `.claude/commands/`, `.claude/skills/` | `.claude/agents/wep-*.md` |
| GitHub Copilot | `.github/copilot-instructions.md`, `.github/instructions/`, `.github/prompts/`, `.github/skills/` | `.github/agents/wep-*.agent.md` |
| Pi | `.pi/prompts/`, `.pi/skills/`, `.pi/README.md` | None |

The three built-in agent profiles are `judge`, `comprehension`, and `implementer`. Fresh full
initialization enables the judge; comprehension and implementer start disabled. Omitting the
judge module disables its default. The canonical `agents` block can override legacy settings and
narrow an agent to a subset of supported installed targets. A configured trigger describes when
the primary agent should offer or delegate work; it is not a scheduler.

Existing protected root instructions receive suggested merge files rather than being replaced.
Generated adapters are maintained through `wep upgrade` and the relevant enable command; edit
source templates or configuration instead of installed copies.

## Doctor

Doctor has two layers:

- The CLI checks required harness files, configuration, policy, conflicts, and wiki integrity. It
  can report or repair supported structural issues with `wep doctor --fix`.
- The installed Doctor workflow asks the coding agent to inspect project evidence and instruction
  meaning, duplication, contradictions, and placement. It records semantic findings in
  `.wep/wiki/instruction-audit.md` and updates relevant project wiki pages.

The CLI cannot determine whether a natural-language rule is useful or correct. The agent is
instructed to classify coherent blocks as keep, move, delete, or verify; keep always-loaded
instructions small; and load detailed guidance only when relevant.

Protected instructions stay read-only by default. During Doctor, the agent must show the exact
minimal diff, obtain explicit human approval of that diff in the current conversation, apply only
that change, verify the resulting diff, and clear the merged suggestion. This is a behavioral
contract for the agent, not an operating-system write restriction.

## Task capsules and workflows

The task workflow asks the primary agent to resolve material ambiguity, select an appropriate
workflow, and create these five files before implementation:

```text
.wep/tasks/TASK-XXX-<slug>/
  task.md
  context.md
  plan.md
  acceptance-criteria.md
  review-checklist.md
```

`task.md` holds the goal, scope, clarifications, open questions, and declared validation commands.
`context.md` identifies relevant evidence and blocked reads. `plan.md` records the workflow and
steps. Acceptance criteria use stable `AC-<n>` identifiers, and the review checklist tracks the
checks to perform. A criterion can declare `proof-command:` and `proof-doc:` references; see
[Judge](JUDGE.md#declared-proof).

The supported selectable workflows are `fast-patch`, `research-first`, `SDD`, `TDD`, `EDD`,
`SDD+TDD`, `SDD+EDD`, and `TDD+EDD`. `UI review` is selected through the UI workflow rule, not
as a selectable default. The agent follows the configured workflow or chooses the smallest
suitable one when `task-fit` is configured. Research-first gathers local evidence and prepares
external research questions where relevant before implementation. See [Workflows](WORKFLOWS.md).

The review skill checks capsule readiness, scope, criteria, and validation strategy before
implementation. It is separate from the post-implementation judge.

Before implementation, the agent presents an Approval Brief containing the workflow and reason,
resolved clarifications, numbered acceptance criteria, and exact validation commands. Approval
confirms the contract and records the command list through `wep task approve-commands`. The
stored digest permits matching commands to run without another prompt. The workflow instructs the
primary agent to run the enabled judge after implementation without separate confirmation, keep
the capsule finalized before capture, and use the returned approval record for closure rather
than edit the capsule after review.

The `wep task` CLI is a headless skeleton generator. It uses deterministic workflow heuristics;
it does not inspect the repository deeply or invent project-specific acceptance criteria.
`wep compile` exports a task brief for an installed target. Neither command runs implementation.

## Implementer agent

The optional implementer profile works against an existing capsule and records each attempt in
an append-only local log. It starts disabled. Enable it before delegating:

```bash
wep impl enable --dry-run
wep impl enable
wep impl start TASK-001
wep impl status TASK-001 --json
wep impl disable
```

Enable, disable, start, log, and status accept `--json`, `--dry-run`, and `--force`. Enabling
regenerates profiles for supported installed targets selected by `agents.implementer.targets`;
disabling keeps the files. Safe local ignore is required. A templates-only installation must
first add the module with `wep enable impl`.

Configuration uses `agents.implementer.enabled`, `.trigger`, `.targets`, `.model.<target>`, and
`.maxAttempts`. The default trigger is `post-clarification`, and the default maximum is three
recorded rounds. With `post-clarification`, approving the Approval Brief also confirms delegation
to the enabled implementer. With `on-request`, the primary agent offers the handoff only when the
user requests it. Unknown triggers produce warnings and require explicit request and confirmation
rather than an invented automatic invocation. The legacy `impl.enabled` is a fallback. Supported profile paths are
`.claude/agents/wep-implementer.md`, `.github/agents/wep-implementer.agent.md`, and
`.codex/agents/wep-implementer.toml`; Pi has no profile.

The primary agent owns clarifications and capsule changes. The implementer reads all five capsule
files and any `.wep/review-policy.md`, follows the declared workflow, and returns ambiguity to the
caller. It is instructed not to modify capsule files, review policy, or protected instructions.
These write boundaries are instructions rather than a host-enforced sandbox.

### Record an attempt

The log is `.wep/local/impl/TASK-XXX/log.md`, outside the capsule and review boundary. Both the
short task ID and its full capsule directory name resolve to the same log. A nonexistent capsule,
unsafe ignore, duplicate legacy logs, or unreadable log causes refusal rather than a fresh
attempt budget. `impl status --json` reports `attemptsUsed: null` when it cannot trust the log.

`impl start` reports the next round; it does not reserve it or launch an agent. `impl log` appends
the record and derives its round number from the stored log. Skipping `start` cannot bypass the
budget. Once the budget is exhausted, the CLI refuses further appends; it cannot prevent an agent
from editing code outside this process or a user from manually changing local files.

For a non-TDD task, append a round using flags:

```bash
wep impl log TASK-001 --criteria AC-1,AC-2 --files src/example.ts \
  --validation 'pnpm test::passed::verbatim command output' \
  --blocker 'Remaining issue, if any' --decision 'Decision needed, if any'
```

`--criteria` and `--files` are comma-separated lists. Repeat `--validation` for each
`command::passed|failed|not-run::output` entry. Alternatively, use
`wep impl log TASK-001 --record /path/to/round.json`. JSON replaces the flag-based record and
accepts `criteria`, `files`, `validation`, optional `blocker`, `decisionNeeded`, and `timestamp`.
`round` is accepted but ignored because the store derives it. Unknown top-level fields fail.
The CLI stores reported validation; it does not execute it or authenticate the supplied output.

TDD, SDD+TDD, and TDD+EDD rounds require `--record` with exactly one ordered red/green pair:

```json
{
  "criteria": ["AC-1"],
  "files": ["src/example.ts", "tests/example.test.ts"],
  "validation": [
    {
      "command": "pnpm test",
      "status": "failed",
      "output": "Expected regression: rejects empty input",
      "phase": "red",
      "expectedFailure": "rejects empty input"
    },
    {
      "command": "pnpm test",
      "status": "passed",
      "output": "All tests passed",
      "phase": "green"
    }
  ]
}
```

Replace example output with the actual result. Red must fail and precede green; green must pass.
The commands must match after whitespace normalization, the red output must contain
`expectedFailure`, and green must preserve non-empty output. Missing or invalid phase evidence
refuses the append. These checks validate the reported structure and sequence, not whether the
commands were really run. Independent validation comes from the judge receipt process.

## Judge

The independent judge reads the capsule, exact changed boundary, relevant tests, and the trusted
caller's validation receipt. It emits `APPROVED`, `NEEDS_CHANGES`, or `BLOCKED` with a result for
every criterion and non-blocking observations. It does not implement feedback or execute
validation.

After the initial Approval Brief, the normal review sequence is `judge snapshot`, `judge run`,
external agent review, and `judge verify --receipt-digest` using the digest the trusted caller
observed. The installed workflow does not ask for another confirmation to invoke the enabled
judge. A fresh
`verify --run-tests` is an alternative strong check; plain `verify` accepts validation claims
on trust. `judge current` separately classifies live applicability as `CURRENT`,
`NEWER_CHANGES`, or `DIVERGED`. Catch-up snapshots require a strongly verified parent and a new
review for the delta. Read [Judge](JUDGE.md) for commands, receipts, optional validation,
mechanical reproduction, retention, and the limits of these checks.

An approval applies to declared capsule criteria. Project review policy may add observations but
cannot widen scope or independently block approval. A verified record is local bookkeeping; it
does not authenticate which model or person wrote the verdict.

## Comprehension

The optional comprehension agent assesses change significance, freezes a private code-grounded
rubric, shows a change map and test matrix, and asks one question at a time. When the judge is
enabled, it requires a verified, independent approval for a `CURRENT` snapshot. The trusted caller
performs the strong execution check before handoff; the evaluator performs only read-only
verification. It receives task ID, exact boundary, and judge-record path rather than the
implementer's explanations.

The primary agent does not ask to launch comprehension at task completion. Checkpoints are
requested separately by the developer, with pending tasks surfaced through `wep status`.
Personal answers stay in the evaluator conversation or verified ignored local storage, never in
the capsule or wiki. It does not control merges. See [Comprehension](COMPREHENSION.md) for setup,
platform profiles, local artifacts, statuses, and direct interactive invocation.

## Limits and maintenance

Policy guides cooperative agents. Selected CLI operations enforce file preservation, schema,
boundary, and storage checks; policy is not a sandbox for arbitrary source or shell access.
Snapshots preserve a review boundary and do not change the live branch, index, or stash. Validation
runs may execute shell commands and require matching stored command approval or approval for that
invocation. See
[Security and merge rules](SECURITY_AND_MERGE_RULES.md).

A harness provides instructions and recorded context. It does not guarantee that a coding agent
will follow them, that a review is correct, or that a task resumes automatically in a later
session. See [Continuation](CONTINUATION.md) for the read-only portable execution-state record.
