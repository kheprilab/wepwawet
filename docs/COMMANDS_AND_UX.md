# Commands and UX

## `wep init`

Installs the wep harness into the current repository.

```bash
wep init
wep init --target codex
wep init --target codex,claude
wep init --target all
wep init --target copilot --dry-run
wep init --target copilot --profile regulated
wep init --target copilot --template test-template
wep init --target copilot --template-pack ./company-template
wep init --modules tasks --target codex
wep init --force          # overwrite existing non-protected generated files
```

Flow:

```
1. scan current directory
2. detect existing agent setup (Codex, Claude, Copilot, Pi)
3. select a single detected target, or prompt if none/several (headless use needs --target)
4. create .wep/ — neutral source of truth
5. install target-specific harness files
6. apply the selected profile and template pack when provided
7. preserve existing instruction files (AGENTS.md, CLAUDE.md, etc.)
8. report what was created, updated, or suggested
```

A normal init installs all modules and enables the judge on supported hosts.
Comprehension, implementer, and tracing are disabled until enabled separately.
Use `--modules` to install a smaller set. `--template` and `--template-pack` are
mutually exclusive and require one target. Profiles initialize a new project; a rerun
preserves its existing config values. Init is not a safe config-recovery command:
repair invalid configuration before rerunning it. See [configuration](CONFIGURATION.md).

If a protected file already exists, init writes a suggested variant instead:

```
AGENTS.md → AGENTS.wep.suggested.md
CLAUDE.md → CLAUDE.wep.suggested.md
```

---

## `wep enable`

Adds modules to an initialized harness, including their dependencies:

```bash
wep enable tasks --dry-run
wep enable judge,comprehension
```

Valid names are `templates`, `tasks`, `judge`, `comprehension`, `impl`, and `trace`.
This installs module files; it does not switch the optional agents or tracing on. Use
`wep judge enable`, `wep comprehension enable`, `wep impl enable`, or `wep trace enable`
for those settings. There is no general module-disable command. See
[the dependency table](CONFIGURATION.md#modules).

---

## `wep doctor`

Mechanically audits the wep setup and writes generated readiness reports.

```bash
wep doctor
wep doctor --json
wep doctor --ci
wep doctor --ci --json
wep doctor --fix              # recreate missing files and repair config/policy gaps
wep doctor --fix --dry-run    # preview what --fix would do
```

Reports:

- installed targets
- missing harness files
- pending suggested merges
- config gaps
- policy gaps
- judge misconfiguration (enabled but files missing)
- version drift between installed harness and current CLI
- wiki lint: broken links, orphan pages, and missing or invalid frontmatter timestamps
- task capsules that hold a `log.md` inside the reviewed boundary (warning only; Doctor never moves the file and readiness does not change)
- readiness score (0–100)
- suggested agent prompt to continue the audit intelligently

The command and the installed skill have separate responsibilities:

- **Doctor CLI (`wep doctor`)** performs deterministic checks over files, configuration, policy, hashes, conflicts, and wiki structure. It regenerates `agent-setup.md`, `gaps.md`, and `recommendations.md`.
- **Doctor skill (`wep-doctor`)** asks an agent to interpret instruction meaning and placement. It records durable keep/move/delete/verify findings in `instruction-audit.md`, which the CLI does not overwrite.

`--ci` exits with `0` when the harness is healthy and `1` when there are actionable gaps. Use it in protected branches or CI pipelines.

`--fix` automatically recreates missing harness files and merges missing keys into `.wep/config.json` and `.wep/policy.json`. It does not create new protected-file suggestions merely because a protected file already exists.

For a pending instruction merge, the Doctor agent compares the protected file with its `.wep.suggested.md` candidate and presents the exact minimal diff. The protected file remains read-only until the human explicitly approves that exact diff in the current conversation. After approval, the agent applies only the shown changes, displays the result, reruns Doctor, and removes the candidate only after verification. A changed proposal requires a new approval.

---

## `wep templates`

Lists reusable template packs shipped with the CLI package.

```bash
wep templates list
wep templates list --json
```

Bundled templates live under `templates/<name>/` in the source package and can be applied with:

```bash
wep init --target copilot --template <name>
```

Path-based template packs can be applied with:

```bash
wep init --target copilot --template-pack ./company-template
```

See [TEMPLATE_PACKS.md](TEMPLATE_PACKS.md) for the template pack format.

### Apply after initialization

```bash
wep templates apply company-base
wep templates apply ./company-template --local
wep templates apply security-rules --target copilot --dry-run
wep templates update ./company-template --local --target copilot --dry-run
wep templates status
wep templates status --json
```

`templates apply` requires an installed harness and valid manifest. It never reruns `init` and rejects `--force`. Without `--target`, it applies to all configured targets. `--target all` also selects all installed targets; a comma-separated list selects a subset.

Several packs are composed by applying them sequentially. Existing non-root content that differs is preserved and receives a versioned candidate under `.wep/template-candidates/<name>/<version>/`. These conflicts block the pack transaction, so config, policy, and missing files remain unchanged until the candidate is resolved and the command is rerun. Root instructions are nonblocking: they use `.wep.suggested.md` and the human-approved Doctor merge workflow. `templates update` uses recorded hashes to replace unchanged pack-owned files and offers candidates for user edits. Unlike apply, update can write clean files and config/policy while reporting unresolved conflicts; it is not transactional. See [TEMPLATE_PACKS.md](TEMPLATE_PACKS.md) for multi-target behavior, custom agents, and update constraints.

---

## `wep status`

Quick install summary.

```bash
wep status
wep status --json
```

Shows installed targets, detected but uninstalled setups, task count, recent task IDs, default workflow, context budget, resolved agent state, pending comprehension sessions, and any active judge-run lock.

---

## `wep upgrade`

Safely migrates an installed harness after the wep npm package is updated.

```bash
wep upgrade
wep upgrade --target codex
wep upgrade --dry-run
```

The upgrade uses `.wep/manifest.json` hashes to update only verified, unchanged generated files. The files in `.wep/tasks/_template/` are generated files too: an unchanged template follows the shipped version, and an edited one is kept and offered as a candidate. Wiki pages, task capsules, local records, and root instructions are never overwritten. Existing legacy or modified generated files receive candidates under `.wep/upgrades/<version>/`; resolve them and rerun the command before `installedVersion` advances. Obsolete generated files are reported but never deleted.

`config.json` and `policy.json` are migrated field by field while retaining project values. Invalid JSON is preserved as a blocking conflict. `--force` is intentionally rejected for upgrades.

Typical published-package flow:

```bash
npm install -g wepwawet@latest
cd my-project
wep upgrade --dry-run
wep upgrade
wep doctor
```

Run `wep doctor` after upgrading to verify the result.

---

## `wep task`

Creates, lists, shows, or removes task capsules. Intended as a headless fallback for scripts and CI. During normal agent-assisted work the agent creates the capsule itself.

```bash
wep task "Fix regression in invoice calculation"
wep task "Define invoice API examples" --workflow SDD+EDD
wep task "Review settings screen"  # may auto-select UI review

wep task list
wep task show TASK-001
wep task search "session expiry" --json
wep task continuation TASK-001 --json
wep task approve-commands TASK-001 --dry-run
wep task migrate-criteria
wep task migrate-criteria TASK-001 --dry-run
wep task rm TASK-001
wep task rm TASK-001 --dry-run
```

`wep task <description>` is a backwards-compatible shortcut for `wep task create <description>`.

Creates under `.wep/tasks/TASK-XXX-<slug>/`:

```
task.md
context.md
plan.md
acceptance-criteria.md
review-checklist.md
```

A concrete project default wins unless overridden with `--workflow`. With `task-fit`, the CLI recommends a workflow from hard-coded English keywords; it does not execute `workflowRules`. `UI review` can be recommended but is not accepted by `--workflow`. See [WORKFLOWS.md](WORKFLOWS.md#selection-rules-and-limits).

`wep task list` prints all task capsules with their descriptions. `wep task show TASK-001` prints the five canonical Markdown files in the capsule and the declared workflow. It reads the workflow from `## Workflow` in `plan.md` first, then from `## Recommended Workflow` in `task.md`. `wep task rm TASK-001` removes the capsule directory immediately, including exports and sidecars; no `--force` is needed. Preview with `--dry-run`.

`wep task migrate-criteria [TASK-ID]` adds an `AC-<n>` identifier to each criterion that has none, in one capsule or in all of them. It never changes a valid identifier, and it never reuses a number that a `Retired: AC-<n>` footer line retires. It writes nothing to a capsule with a duplicate or malformed identifier. It reports that capsule and exits with code 1 after it processes the others. `--dry-run` reports the plan.

### Search, continuation, and validation approval

`task search <query>` performs a literal, case-insensitive search of the five canonical
capsule files. It ignores exports, logs, and symbolic links and applies blocked-read
patterns. `--json` returns task, file, line, and text records.

`task continuation <taskId>` reads an optional `continuation.json`. It does not resume
work or authorize commands. See [CONTINUATION.md](CONTINUATION.md).

`task approve-commands <taskId>` displays the commands declared under `## Validation`
in `task.md` and stores approval of their ordered SHA-256 digest locally. It does not
run them. Interactive approval asks after showing the list. In headless use, pass
`--approve-commands '<exact command>'` once per command, in declared order. Inspect
commands before approving them. Changing that list invalidates the stored approval.
See [JUDGE.md](JUDGE.md) for execution modes and receipts.

---

## `wep compile`

Compiles a task capsule into a single agent-ready brief.

```bash
wep compile TASK-001
wep compile TASK-001 --target codex
wep compile TASK-001 --target claude
wep compile TASK-001 --target all
```

Concatenates task.md + context.md + plan.md + acceptance-criteria.md + review-checklist.md into:

```
.wep/tasks/TASK-001/exports/<target>.md
```

`--target all` compiles one brief per configured target, or all four if no config exists. Without `--target`, compile uses `codex`; it does not read `defaults.target`. The real capsule directory includes its slug. Exports are derived files and are regenerated on every run; use `--dry-run` to preview.

Paste or reference this file in your agent session when you need a deterministic brief.

---

## `wep config`

Shows or updates project defaults stored in `.wep/config.json`.

```bash
wep config show

wep config set defaultWorkflow task-fit
wep config set defaultWorkflow SDD+TDD
wep config set defaultTarget codex
wep config set allowedWorkflows SDD,TDD,fast-patch
wep config set requireTaskCapsule true
wep config set requireWorkflowReason true
wep config set contextBudget proportional
```

Valid `contextBudget` values: `minimal` | `proportional` | `thorough`.

`allowedWorkflows` accepts a comma- or space-separated list of workflows (e.g. `SDD,TDD,fast-patch`). The list is normalized and deduplicated; invalid workflows are rejected.

---

## `wep comprehension`

Installs and manages the optional independent developer-understanding agent. The developer requests a checkpoint after it is surfaced through `wep status`; when the judge is enabled, comprehension begins only after an APPROVED, current review for the same change boundary.

```bash
wep comprehension enable
wep comprehension disable
wep comprehension status
```

Personal sessions are stored under `.wep/local/comprehension/` and ignored by Git. Read-only Git inspection is allowed; Git mutations and merge control are forbidden.

Supported native agents: Codex, Claude Code, and GitHub Copilot. Wepwawet does not generate native independent-agent files for Pi.

---

## `wep judge`

Manages the optional judge subagent. The judge independently reviews whether an implementation matches the task capsule. Enabled by normal full init for supported hosts.

```bash
wep judge enable           # enable + install agent files for installed targets
wep judge enable --dry-run # preview files that would be created
wep judge disable          # disable (files are kept, remove manually if needed)
wep judge status           # show enabled state and which agent files exist
wep judge snapshot TASK-001 --base main --json
wep judge scope TASK-001 --base main --candidate SNAPSHOT:<id> --json
wep judge run TASK-001 --candidate SNAPSHOT:<id> --json
wep judge verify .wep/local/judge/TASK-001/review.json --run-tests
wep judge current .wep/local/judge/TASK-001/review.json
wep judge snapshot TASK-001 --from-review .wep/local/judge/TASK-001/review.json
wep judge prune --keep 5       # preview
wep judge prune --keep 5 --force
wep judge rounds               # review rounds per task, read-only
wep judge rounds TASK-001 --json
wep judge reproduce TASK-001 --base main --candidate SNAPSHOT:<id>
```

`snapshot` captures a shallow immutable local boundary without changing live Git state.
`scope` hashes the task capsule and exact code boundary. `run` executes declared validation once and writes a receipt; it uses the live working tree by default or a disposable copy with `--isolated`. `verify --receipt-digest <digest>` checks the receipt observed by the trusted caller; `verify --run-tests` re-executes validation in a disposable copy. Both execution paths require approval of the declared commands. `current` separates historical
approval validity from live applicability, catch-up reviews only the newer delta, and
`prune` is dry-run-first local retention.

`verify` prints `APPROVED for the reviewed boundary` for an approved record. It prints the
`reviewBoundary` (`CURRENT`, `NEWER_CHANGES`, `DIVERGED`, or `not classified for this boundary
type`) on its own line. It also reports non-blocking notices, such as an unmet proof declaration
or a clarification signal. See [JUDGE.md](JUDGE.md).

### `wep judge rounds`

```bash
wep judge rounds [task-id] [--json]
```

Reports review rounds per task from the records under `.wep/local/judge`. The command is
read-only. It writes, renames and deletes nothing.

| Argument or flag | Meaning |
| --- | --- |
| `[task-id]` | Report one task, for example `TASK-001`. A value that is not `TASK-<n>` is an error. |
| `--json` | Emit the report as JSON: `tasks[]`, `closed{}`, `open{}`, `unknown[]`, `skipped[]`. |

### `wep judge reproduce`

```bash
wep judge reproduce <task-id> --base <ref> --candidate SNAPSHOT:<id> \
  [--include-task <task-id>]... [--approve-commands <cmd>]... [--json]
```

Runs the generator that the `## Migration` block of `task.md` declares, in a disposable copy of
the base. It then compares the declared paths to the snapshot. The command exits with code 1
when the change is not reproduced.

| Flag | Meaning |
| --- | --- |
| `--base <ref>` | Required. The Git commit or ref the snapshot was captured against. |
| `--candidate SNAPSHOT:<id>` | Required. The immutable snapshot to compare. |
| `--include-task <task-id>` | The foreign task capsules the snapshot was captured with. Repeat for each task. |
| `--approve-commands <cmd>` | Approve one command. Repeat once per command, in the printed order. Needed when no terminal is attached. |
| `--json` | Emit JSON on stdout. The approval text goes to stderr. |

The native judge agent is not supported for Pi; workflow prompts and skills remain available.

See [JUDGE.md](JUDGE.md) for the full flow including how to set a model.

---

## `wep impl`

Manages the optional implementer agent and its append-only implementation log. Disabled by
default.

```bash
wep impl enable            # enable + install agent files for installed targets
wep impl disable           # disable (files are kept)
wep impl start TASK-001    # open or resume the log, report the round you may begin
wep impl log TASK-001 \
  --criteria "AC-1,AC-2" \
  --files "src/a.ts" \
  --validation "pnpm test::passed::647 passed" \
  --blocker "..." --decision "..."
wep impl log TASK-001 --record round.json
wep impl status TASK-001 --json
```

Each command accepts the short ID `TASK-001` or the capsule directory name
`TASK-001-<slug>`. Both resolve to `TASK-001` and to one log with one attempt budget. An
argument that matches no capsule is an error.

The log is `.wep/local/impl/TASK-NNN/log.md` — local, Git-ignored, and outside every
review boundary, so recording a round never moves `taskDigest`. Every command verifies that
`.wep/local/.gitignore` still keeps it there, and refuses rather than writing a log the
review would pick up.

Records are append-only and the round number is derived from the persisted records at
append time, so two `start` calls with no `log` between them cannot disagree. The attempt
budget (`agents.implementer.maxAttempts`, default 3) is enforced by `impl log` as well as
by `impl start`: the limit belongs to the store, not to the opening command. An unparseable
log is reported as unreadable and does not present as zero attempts used.

`--record` takes a JSON object with the same fields as the flags. It is validated before it
reaches the store — an unknown field, a malformed `validation` entry, or a `timestamp` that
is not an ISO-8601 instant is rejected by name. A `round` in the file is ignored, because
the round is derived at append time.

`wep impl` never invokes an agent. wep generates the definition and owns the log; the
lead agent decides when to delegate.

---

## `wep trace`

Opt into local session observations and inspect the resulting reports:

```bash
wep trace enable --dry-run
wep trace enable
wep trace status --json
wep trace report --json
wep trace disable
```

Tracing starts off. Enable wires hooks for installed targets and pins them to the
current built CLI. The trace is observational and fail-open; it does not approve or
block tools. Records remain local under `.wep/local/traces/`. Disable removes owned
hook entries and retains previous records. Host event coverage varies; unsupported or
unverified observations must not be treated as proof of conformance. See
[TRACING.md](TRACING.md) for recorded fields, hook files, report predicates, and limits.

---

## `wep remove`

Removes wep harness files for a target.

```bash
wep remove --target codex              # dry-run: list what would be removed
wep remove --target codex --force      # remove codex skill files
wep remove --target all --force        # target files only; keep shared .wep/
wep remove --all --force               # remove harness; keep task/local records
wep remove --all --purge-tasks --purge-local --force  # also delete those records
```

Protected root instruction files (`AGENTS.md`, `CLAUDE.md`, `copilot-instructions.md`, and `.pi/README.md`) are always skipped; remove them manually if needed. Target removal includes generated agent files and removes owned trace hooks. `--all` retains task capsules and local personal records by default; purge flags explicitly opt into deleting those records. It also removes the local review guard. Preview before applying.

---

## Flags and scripting

Use `wep <command> --help` for the flags accepted by that command. Shared option names
have command-specific semantics:

| Flag | Behavior |
| --- | --- |
| `--target <target>` | Select a target where supported. Init and template operations support comma-separated targets; `all` selects all relevant targets. |
| `--dry-run` | Preview supported writes. Read-only commands do not become different checks when this is present. |
| `--force` | Init can overwrite non-protected generated files; remove/prune use it to apply deletion. Upgrade and template apply/update reject it. It is not a general approval flag. |
| `--json` | Structured output on commands that implement it. Init/maintenance commands can still write files; JSON is not a read-only mode. |
| `--help` | Display command-specific arguments and options. |

Doctor `--ci`, incomplete upgrades, blocked template transactions, invalid continuation
records, and failed judge verification can return nonzero status. Check exit status as
well as JSON. `config show` prints JSON without needing `--json`; configuration writes
accept `--dry-run`.
