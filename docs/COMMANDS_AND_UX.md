# Commands and UX

## `wep init`

Installs the wep harness into the current repository.

```bash
wep init
wep init --target codex
wep init --target all
wep init --target copilot --dry-run
wep init --target copilot --profile regulated
wep init --target copilot --template test-template
wep init --target copilot --template-pack ./company-template
wep init --force          # update wep-owned files that already exist
```

Flow:

```
1. scan current directory
2. detect existing agent setup (Codex, Claude, Copilot, Pi)
3. ask which target if ambiguous (skipped with --target)
4. create .wep/ — neutral source of truth
5. install target-specific harness files
6. apply the selected profile and template pack when provided
7. preserve existing instruction files (AGENTS.md, CLAUDE.md, etc.)
8. report what was created, updated, or suggested
```

If a protected file already exists, init writes a suggested variant instead:

```
AGENTS.md → AGENTS.wep.suggested.md
CLAUDE.md → CLAUDE.wep.suggested.md
```

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

Lists bundled enterprise template packs shipped with the CLI package.

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
wep templates status
wep templates status --json
```

`templates apply` requires an installed harness and valid manifest. It never reruns `init` and rejects `--force`. With one installed target it selects it automatically; projects with multiple targets must pass one explicit `--target` and apply once per target.

Several packs are composed by applying them sequentially. Existing non-root content that differs is preserved and receives a versioned candidate under `.wep/template-candidates/<name>/<version>/`. These conflicts block the pack transaction, so config, policy, and missing files remain unchanged until the candidate is resolved and the command is rerun. Root instructions are nonblocking: they use `.wep.suggested.md` and the human-approved Doctor merge workflow.

---

## `wep status`

Quick install summary.

```bash
wep status
wep status --json
```

Shows installed targets, task count, recent task IDs, default workflow, and context budget.

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
wep task "Create settings screen" --workflow "UI review"

wep task list
wep task show TASK-001
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

Workflow is chosen automatically from the task description unless overridden with `--workflow`.

`wep task list` prints all task capsules with their descriptions. `wep task show TASK-001` prints every file in the capsule and the declared workflow. It reads the workflow from `## Workflow` in `plan.md` first, then from `## Recommended Workflow` in `task.md`. `wep task rm TASK-001` removes the capsule directory.

`wep task migrate-criteria [TASK-ID]` adds an `AC-<n>` identifier to each criterion that has none, in one capsule or in all of them. It never changes a valid identifier, and it never reuses a number that a `Retired: AC-<n>` footer line retires. It writes nothing to a capsule with a duplicate or malformed identifier. It reports that capsule and exits with code 1 after it processes the others. `--dry-run` reports the plan.

---

## `wep compile`

Compiles a task capsule into a single agent-ready brief.

```bash
wep compile TASK-001
wep compile TASK-001 --target codex
wep compile TASK-001 --target claude
wep compile TASK-001 --target all
```

Concatenates task.md + context.md + plan.md + acceptance-criteria.md into:

```
.wep/tasks/TASK-001/exports/<target>.md
```

`--target all` compiles one brief for every target listed in `.wep/config.json`.

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

Installs and manages the optional independent developer-understanding agent. The primary agent asks before invoking it; when the judge is enabled, comprehension begins only after an APPROVED review for the same change boundary.

```bash
wep comprehension enable
wep comprehension disable
wep comprehension status
```

Personal sessions are stored under `.wep/local/comprehension/` and ignored by Git. Read-only Git inspection is allowed; Git mutations and merge control are forbidden.

Supported native agents: Codex, Claude Code, and GitHub Copilot. Pi is skipped because it has no native independent-agent surface.

---

## `wep judge`

Manages the optional judge subagent. The judge independently reviews whether an implementation matches the task capsule. Disabled by default.

```bash
wep judge enable           # enable + install agent files for installed targets
wep judge enable --dry-run # preview files that would be created
wep judge disable          # disable (files are kept, remove manually if needed)
wep judge status           # show enabled state and which agent files exist
wep judge snapshot TASK-001 --base main --json
wep judge scope TASK-001 --base main --candidate WORKTREE --json
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
`scope` hashes the task capsule and exact code boundary. `verify --run-tests` re-executes
declared passing validation in a disposable workspace. `current` separates historical
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

Pi is not supported — it has no native subagent API.

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

## `wep remove`

Removes wep harness files for a target.

```bash
wep remove --target codex              # dry-run: list what would be removed
wep remove --target codex --force      # remove codex skill files
wep remove --all --force               # remove .wep/ and all target files
```

Protected root instruction files (AGENTS.md, CLAUDE.md, copilot-instructions.md, and .pi/README.md) are always skipped — remove them manually if needed.

---

## Common flags

| Flag | Effect |
|---|---|
| `--target <target>` | `codex` \| `claude` \| `copilot` \| `pi` \| `all` |
| `--dry-run` | Show planned writes without creating files |
| `--force` | Update wep-owned files that already exist |
| `--json` | Emit JSON output for scripting |
