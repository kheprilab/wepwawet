# Working on a task with Wepwawet

This walkthrough installs the harness, prepares project context, and takes a change
through implementation and independent review. Wepwawet writes files and runs its
own CLI operations; your coding agent performs the coding and review work.

## 1. Install the CLI

The public release is not available from npm yet. With access to the source repository:

```bash
git clone https://github.com/kheprilab/wepwawet.git
cd wepwawet
pnpm install
pnpm build
pnpm link --global
wep --help
```

You need Node.js 20+, pnpm, Git, and a supported coding agent. See
[installation](docs/INSTALLATION.md) for linking and direct execution.

## 2. Initialize your project

```bash
cd /path/to/your-project
wep init --target codex --dry-run
wep init --target codex
```

Replace `codex` with `claude`, `copilot`, or `pi`. Init also supports
`--target codex,claude` or `--target all`. With one detected setup, `wep init` selects
it directly; with none or several it prompts in a terminal. In headless use, supply
`--target` instead of relying on a prompt.

A normal init creates shared config, policy, wiki pages, task templates, review
contracts, and target-specific instructions and skills. It enables the judge on
Codex, Claude Code, and Copilot. Comprehension, the implementer, and tracing stay off.
For a smaller installation, use `--modules tasks`; see [modules](docs/CONFIGURATION.md#modules).

If a root instruction file already exists, init preserves it and writes a candidate
such as `AGENTS.wep.suggested.md`. Review and merge the needed instructions before
expecting the agent to use the harness. The installed Doctor workflow can propose a
minimal diff, but must receive your approval of that exact diff before editing a
protected instruction file.

## 3. Prepare project context

Run the deterministic checks:

```bash
wep doctor
wep status
```

Doctor reports missing files, configuration gaps, pending instruction merges, version
drift, and wiki issues. It writes setup reports; the score describes harness readiness,
not application correctness. `wep doctor --fix --dry-run` previews file/config repairs.
Repair invalid JSON manually before applying repairs or rerunning init.

Then ask your coding agent:

> Use the wep-doctor workflow to audit this setup and document the verified project architecture, conventions, and test commands.

The agent inspects relevant files and records project knowledge in `.wep/wiki/`.
The CLI does not infer this knowledge itself. Check what the agent wrote, especially
commands it proposes to run.

## 4. Define a task before implementation

Ask the agent:

> Fix the login bug where sessions expire before the configured timeout. Use TDD.

The harness instructs it to clarify material ambiguity, inspect relevant code, and
create `.wep/tasks/TASK-001-<slug>/` with five canonical files:

| File | Contents |
| --- | --- |
| `task.md` | Goal, workflow reason, validation commands, clarifications, open questions |
| `context.md` | Relevant files and task context |
| `plan.md` | Selected workflow and implementation steps |
| `acceptance-criteria.md` | Numbered `AC-<n>` criteria and optional evidence declarations |
| `review-checklist.md` | Evidence references and process attestations |

Before implementation, the agent presents an Approval Brief with the workflow and
reason, resolved clarifications, numbered acceptance criteria, and exact validation
commands. Approve it when it matches the intended change. The agent records command
approval with `wep task approve-commands TASK-001`, bound to the command-list digest. The
agent should not fill gaps by guessing. For scripts or headless setup you can create
a skeleton instead:

```bash
wep task "Fix login session expiry bug" --workflow TDD
wep task list
wep task show TASK-001
```

The CLI creates placeholders, not a researched plan. With no explicit workflow, a
concrete project default wins; `task-fit` uses hard-coded English keyword matching
in the CLI. Its rules are not the same as the agent's configurable `workflowRules`.
`UI review` can be automatically recommended for inspection tasks, but cannot be
passed to `--workflow`. See [workflows](docs/WORKFLOWS.md).

## 5. Implement and validate

The agent follows the selected method and runs the validation declared in `task.md`.
For TDD, retain evidence of the failing regression and the passing fix. Complete the
capsule and checklist before snapshot capture.

Optionally enable `wep-implementer` for delegation. With its `post-clarification` trigger,
approving the initial Approval Brief also confirms that delegation; `on-request` waits
for an explicit request and confirmation. Its bounded attempt log lives under `.wep/local/impl/`, outside the
reviewed task capsule. `wep impl` manages definitions and records; it does not launch
an agent. See [implementer configuration](docs/CONFIGURATION.md#implementer).

To pass the capsule to another session, compile its five files into a brief:

```bash
wep compile TASK-001 --target codex
```

The output is under the actual capsule directory at `exports/codex.md`. It is a derived
file, regenerated on each run. It does not include the entire repository or personal logs.

## 6. Review an immutable change

After the approved implementation, the installed workflow automatically invokes the
independent judge. A normal init enables it on supported hosts; `wep judge status` reports state and files, and `wep judge disable`
turns it off. Pi has no native judge, implementer, or comprehension agent format.

The lead agent captures the completed task against the intended Git base:

```bash
wep judge snapshot TASK-001 --base main --json
```

Replace the placeholder below with the returned snapshot ID:

```bash
wep judge run TASK-001 --candidate SNAPSHOT:<id> --json
```

If the exact ordered command list was pre-approved with
`wep task approve-commands TASK-001`, this runs it without asking again. Otherwise it
displays the commands and requests approval. Headless
approval requires `--approve-commands '<exact command>'` once per command, in order.
Read the list before approving. By default commands run in your working tree;
`--isolated` uses a disposable copy and is not an operating-system sandbox. Do not edit
project files while the run is active.

Keep the receipt path and digest printed by your own run. Give the independent judge
the task, snapshot boundary, and receipt. It reviews the change and returns structured
JSON; it does not execute tests or implement its feedback. Save its exact record locally,
then verify it using the digest you observed:

```bash
wep judge verify .wep/local/judge/TASK-001/review.json --receipt-digest <observed-digest>
wep judge current .wep/local/judge/TASK-001/review.json
```

The placeholders and example record path must match your run. An older approval can
remain valid for its reviewed boundary while newer edits require another review. Use
a catch-up snapshot for that delta. See [Judge](docs/JUDGE.md) for the full protocol,
exit statuses, mechanical migrations, record schemas, and retention.

## 7. Check understanding when useful

```bash
wep comprehension enable
```

This installs a separate agent that reconstructs the approved change, presents a change
map and test matrix, and asks code-specific questions. Pending checkpoints are surfaced
through `wep status`; ask the agent for one when ready. The separate evaluator owns
the questions and grading. It does not control Git or block merges. Personal answers stay under Git-ignored `.wep/local/comprehension/` when privacy
checks pass. See [Comprehension](docs/COMPREHENSION.md).

## 8. Maintain the harness

After updating the CLI, preview the installed-file upgrade:

```bash
wep upgrade --dry-run
wep upgrade
wep doctor
```

Unchanged generated files can update automatically; edited files receive candidates
under `.wep/upgrades/`. Project wiki content, task capsules, local records, and root
instructions are preserved. Resolve candidates and rerun before considering an
incomplete upgrade finished.

Other capabilities have separate guides:

- [Command guide](docs/COMMANDS_AND_UX.md): all command groups, task search, command approval, migration, and removal.
- [Template packs](docs/TEMPLATE_PACKS.md): applying and updating team conventions and custom target agents.
- [Tracing](docs/TRACING.md): opt-in local observations and session reports.
- [Continuation](docs/CONTINUATION.md): portable declared state; the reader does not resume execution.
- [Harness specification](docs/HARNESS_SPEC.md): task and evidence contracts.
- [Security and merge rules](docs/SECURITY_AND_MERGE_RULES.md): preservation, permissions, and limits.

To remove the harness, preview `wep remove --all`, then use `--force` to apply it.
Task capsules and local records are retained unless you also request `--purge-tasks`
or `--purge-local`. Root instruction files are always retained for manual cleanup.
