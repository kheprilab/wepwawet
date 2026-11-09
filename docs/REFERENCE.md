# Operational Reference

Detailed commands, generated files, configuration examples, and safety boundaries for wep.
For installation and your first task, start with the [README](../README.md#quickstart).

- [Commands](#commands)
- [Primary flow](#primary-flow)
- [Project defaults](#project-defaults)
- [What init creates](#what-init-creates)
- [Target adapters](TARGETS.md)
- [Task walkthrough](../TUTORIAL.md)
- [Harness specification](HARNESS_SPEC.md)
- [Context budget](#context-budget)
- [Merge safety](#merge-safety)
- [Applying templates](#applying-templates-after-init)
- [Security model](#security-model)
- [Quality gates](#quality-gates)
- [Evaluating changes](#evaluating-changes)

## Commands

Use `wep --help` for the command list and `wep <command> --help` for exact options.
The [command guide](COMMANDS_AND_UX.md) explains routine usage and maintenance.

| Command | Purpose | Details |
| --- | --- | --- |
| `init` | Install adapters, profiles, and selected modules; optionally apply a pack | [Installation](INSTALLATION.md), [modules](CONFIGURATION.md#modules) |
| `enable <modules>` | Add modules and their dependencies to an initialized project | [Command guide](COMMANDS_AND_UX.md#wep-enable) |
| `templates list/apply/update/status` | Discover, apply, update, and inspect reusable packs | [Template packs](TEMPLATE_PACKS.md) |
| `doctor` | Check setup and wiki integrity; write reports; repair missing files with `--fix`; use `--ci` for nonzero gap status | [Command guide](COMMANDS_AND_UX.md#wep-doctor) |
| `status` | Show targets, tasks, defaults, agents, and active validation runs | [Command guide](COMMANDS_AND_UX.md#wep-status) |
| `config show/set` | Read defaults or change supported defaults and agent settings | [Configuration](CONFIGURATION.md) |
| `task create/list/show/rm` | Create a skeleton, inspect capsules, or remove one | [Command guide](COMMANDS_AND_UX.md#wep-task) |
| `task search` | Search literal text in canonical capsule files | [Search](#search-task-capsules) |
| `task continuation` | Read portable declared execution state | [Continuation](CONTINUATION.md) |
| `task migrate-criteria` | Add stable `AC-<n>` identifiers to old criteria | [Command guide](COMMANDS_AND_UX.md#wep-task) |
| `task approve-commands` | Pre-approve the exact ordered validation commands without executing them | [Judge](JUDGE.md) |
| `compile` | Regenerate a single target brief from all five capsule files | [Command guide](COMMANDS_AND_UX.md#wep-compile) |
| `judge enable/disable/status` | Manage independent review agents | [Judge](JUDGE.md) |
| `judge snapshot/scope` | Capture immutable content and calculate the review boundary | [Judge](JUDGE.md) |
| `judge run/verify/current` | Execute approved validation, check review records, and classify live applicability | [Judge](JUDGE.md) |
| `judge reproduce` | Reproduce a declared mechanical migration against a snapshot | [Judge](JUDGE.md) |
| `judge rounds/prune` | Inspect review rounds and preview or apply snapshot retention | [Judge](JUDGE.md) |
| `impl enable/disable/start/log/status` | Manage the implementer and its local attempt log | [Implementer contract](HARNESS_SPEC.md#implementer-agent), [command guide](COMMANDS_AND_UX.md#wep-impl) |
| `comprehension enable/disable/status` | Manage independent developer understanding checkpoints | [Comprehension](COMPREHENSION.md) |
| `trace enable/disable/status/report` | Opt into local tracing and inspect session reports | [Tracing](TRACING.md) |
| `upgrade` | Update unchanged generated files; preserve edits as merge candidates | [Command guide](COMMANDS_AND_UX.md#wep-upgrade) |
| `migrate` | Move a legacy namespace to `.wep/` without overwriting destinations | [Command guide](COMMANDS_AND_UX.md#wep-migrate) |
| `remove` | Preview or remove adapters and optional shared state | [Command guide](COMMANDS_AND_UX.md#wep-remove) |

`--dry-run`, `--force`, `--target`, and `--json` have command-specific meanings; they
are not universal execution or permission switches. For example, removal requires
`--force`, task deletion does not, and upgrade/template operations reject it.

Normal init enables the judge for supported hosts. Comprehension, the implementer,
and tracing are opt-in. Module installation and agent enablement are separate settings.

## Primary Flow

The chosen agent owns the wep workflow after init.

```txt
1. Run: wep init --target codex
2. Open Codex in the repo.
3. Ask: "Run wep task workflow for invoice API examples. Use SDD+EDD."
4. Codex creates or updates .wep/tasks/TASK-XXX/.
5. Use compile only when you want a deterministic target brief.
```

The CLI task command remains available for headless or scripted use:

```bash
wep task "Define invoice API examples" --workflow SDD+EDD
```

### Search task capsules

Use `wep task search <query>` to locate literal, case-insensitive text in the five canonical files of existing task capsules. Results cite the task, repository-relative file, line, and text; `--json` returns the same records as an array. Search is read-only: it does not scan exports or logs, follow symbolic links, build an index, infer whether a result remains current, or use a network service, regex, embeddings, or an LLM.

### Portable execution continuation

`wep task continuation TASK-001` reads the optional `.wep/tasks/TASK-001-<slug>/continuation.json` sidecar. It is a bounded, read-only query: a missing sidecar reports `unknown`, a valid sidecar reports only its declared execution state, and malformed or unsupported JSON exits with status 1. The reader preserves portable attempt counts and returns a SHA-256 digest of the original sidecar bytes. Permissions and verification are always reported as `not-evaluated`; the reader does not authorize execution, validate snapshots, migrate legacy capsules, or create the sidecar. Use `--json` for the complete structured result. See [the continuation contract](CONTINUATION.md) for the v1 schema and declared-state limits. The judge excludes a valid `continuation.json` sidecar from its reviewable content identity and reports sidecar changes on the separate `executionMetadata` axis.

## Project Defaults

Workflow defaults live in `.wep/config.json` so the agent and CLI share the same policy.

```bash
wep config show
wep config set defaultWorkflow task-fit
wep config set defaultWorkflow SDD+TDD
wep config set allowedWorkflows SDD,TDD,fast-patch
wep config set requireWorkflowReason true
wep config set contextBudget proportional
```

Use `task-fit` when the agent should choose the smallest workflow that fits the task. Use a concrete workflow when the whole project should default to that method unless a task says otherwise.

More detail:

- [Configuration](CONFIGURATION.md)
- [Workflows](WORKFLOWS.md)
- [Template pack format](TEMPLATE_PACKS.md)
- [Release checklist](RELEASE_CHECKLIST.md)

## What Init Creates

A full init creates the following shared structure. Smaller module selections create only the files they need:

```txt
.wep/
  config.json
  manifest.json
  policy.json
  comprehension/
    README.md
    schemas/
  judge/
    README.md
    schemas/review.schema.json
  local/
    .gitignore
  upgrades/                  # preserved-file merge candidates
  wiki/
    overview.md
    index.md
    architecture.md
    conventions.md
    testing.md
    workflows.md
    decisions.md
    agent-setup.md
    gaps.md
    recommendations.md
    instruction-audit.md
    write-policy.md
    log.md
  tasks/_template/
  targets/
```

Codex target:

```txt
AGENTS.md or AGENTS.wep.suggested.md
.agents/skills/wep-init/SKILL.md
.agents/skills/wep-doctor/SKILL.md
.agents/skills/wep-task/SKILL.md
.agents/skills/wep-review/SKILL.md
.agents/skills/wep-workflow/SKILL.md
.agents/skills/wep-write-policy/SKILL.md
.codex/agents/wep-judge.toml         # enabled by normal init
.codex/agents/wep-comprehension.toml # opt-in: comprehension enable
.codex/agents/wep-implementer.toml   # opt-in: impl enable
```

Claude, Copilot, and Pi Code receive their own target adapters under `CLAUDE.md`, `.claude/`, `.github/`, or `.pi/`. Claude and Pi Code get `SKILL.md` workflow packages; Copilot gets repository instructions, skills, and reusable prompt files.

### Agent discovery

Judge, implementer, and comprehension commands write native files under each host's
agent directory. Wepwawet does not launch them or control when the host reloads them.
If Claude Code cannot find an agent after the first creation of `.claude/agents/`,
restart the session. Enable commands print a discovery notice when creating that
directory. See [target adapters](TARGETS.md) for all generated paths.

## Context Budget

wep keeps root instruction files small. Detailed workflows live in target skills or prompts and should be loaded only when the current task calls for them.

Durable notes go in explicit homes:

```txt
CLI Doctor reports -> .wep/wiki/agent-setup.md
                     .wep/wiki/gaps.md
                     .wep/wiki/recommendations.md
agent instruction audit -> .wep/wiki/instruction-audit.md
wiki catalog      -> .wep/wiki/index.md
task capsules     -> .wep/tasks/TASK-XXX/
personal comprehension records -> .wep/local/comprehension/ (Git-ignored)
implementation attempt logs -> .wep/local/impl/TASK-XXX/log.md (Git-ignored)
judge records and snapshots -> .wep/local/judge/ (Git-ignored)
compiled briefs   -> .wep/tasks/TASK-XXX/exports/
decisions         -> .wep/wiki/decisions.md
architecture      -> .wep/wiki/architecture.md
conventions       -> .wep/wiki/conventions.md
testing commands  -> .wep/wiki/testing.md
```

## Merge Safety

wep preserves existing agent instructions. If `AGENTS.md`, `CLAUDE.md`, or `.github/copilot-instructions.md` already exists, init writes a `.wep.suggested.md` file instead of replacing it.

`wep doctor` performs deterministic setup checks: required files, configuration, policy, merge conflicts, and wiki integrity. The installed `wep-doctor` skill is the semantic layer: an agent uses it to judge whether instructions are useful, duplicated, stale, or loaded at the wrong scope, and records that durable review in `.wep/wiki/instruction-audit.md`.

Semantic Doctor may also document verified project knowledge in `.wep/wiki/architecture.md`, `conventions.md`, `testing.md`, and `decisions.md`. Upgrade adds these paths when the Doctor write policy retains all previous default destinations, preserving custom entries and wiki content. More restrictive policies are left unchanged and require a manual update if those destinations are wanted.

For a protected-file suggestion, the Doctor agent compares the protected file with its candidate and shows an exact minimal diff. It may edit the protected file only after you explicitly approve that diff in the current conversation; changed proposals require fresh approval.

## Applying templates after init

`--template` remains available on `wep init` for bootstrap. For an initialized project, apply packs independently without rerunning the harness:

```bash
wep templates apply company-base
wep templates apply security-rules
wep templates apply ./company-template --local --target copilot
wep templates status
```

Packs are applied sequentially, so a project may compose several. Blocking file conflicts produce versioned candidates under `.wep/template-candidates/` and do not partially apply config, policy, or missing files. Root instructions use the normal `.wep.suggested.md` + human-approved Doctor merge. Applied pack name, version, source, targets, and target-file hashes are stored in `.wep/config.json`.

## Security Model

`policy.json` (`blockedReadPatterns`, `protectedFiles`, `protectedFileMerge`, `enforcement.*`) and the write-policy skill are **prompt-level / convention-level controls, not technical enforcement**. They give a cooperative coding agent clear instructions about what not to read or overwrite — including the exact human-approval exception for protected instruction merges — but they do not sandbox the agent or resist a malicious or compromised agent, prompt injection, or a template pack designed to weaken them.

`wep judge scope` enforces `blockedReadPatterns` mechanically rather than by instruction: matching paths are removed from the diff at the Git level, so their contents are never read, hashed, or shown to the judge, and an unusable `policy.json` stops the command instead of degrading to a default pattern set. Only their paths appear, in `scope.excludedPaths`. Task search, continuation reads, and legacy migration also screen paths mechanically within their own operations. These command-specific checks do not restrict what the coding agent can read through its host tools; the paragraph above still governs those tools. See [Judge](JUDGE.md).

Snapshot capture also removes blocked tracked paths from the reviewable worktree, but it
is not secret-history rewriting or encryption: its private shallow Git repository still
contains candidate/base objects. Remove committed secrets from Git history separately.

Treat wep's policy as documentation the agent is expected to follow, not a security boundary. To actually restrict what an agent can read or write, complement it with:

- Your coding agent's own permission system (e.g. Claude Code deny rules, sandboxed tool execution).
- Secret scanning and exclusion of credentials from version control. `.gitignore` can prevent accidental staging of untracked files, but it does not remove existing files or stop an agent from reading them.
- Branch protection / code review for any change touching `.wep/policy.json` or a template pack, since both can relax enforcement (see `wep init`'s policy-weakening warning).

## Quality Gates

```bash
pnpm build
pnpm test
pnpm lint
pnpm wep init --target codex --dry-run
pnpm wep doctor --json
```

## Evaluating Changes

The repository includes deterministic black-box evaluations for features and fixes. They run the compiled CLI against disposable fixtures rather than your working project.

```bash
corepack pnpm eval
corepack pnpm eval:compare -- --base origin/main --candidate HEAD
```

`eval` proves only that the candidate satisfies the scenario assertions, so its outcome remains inconclusive. `eval:compare` materializes immutable Git refs and can establish a regression or improvement. Before merging a feature or fix, add or update a scenario under `evals/scenarios/`, run both commands, and review the generated Markdown report. See [`evals/README.md`](../evals/README.md) for the scenario contract and verdict rules.
