# Operational Reference

Detailed commands, generated files, configuration examples, and safety boundaries for wep.
For installation and your first task, start with the [README](../README.md#quickstart).

- [Commands](#commands)
- [Primary flow](#primary-flow)
- [Project defaults](#project-defaults)
- [What init creates](#what-init-creates)
- [Context budget](#context-budget)
- [Merge safety](#merge-safety)
- [Applying templates](#applying-templates-after-init)
- [Security model](#security-model)
- [Quality gates](#quality-gates)
- [Evaluating changes](#evaluating-changes)

## Commands

```bash
wep init                             # detect agent and install harness
wep init --target codex             # install for specific target
wep init --target all               # install for all targets
wep init --target copilot --profile regulated
wep init --target copilot --template test-template
wep doctor                          # audit setup, lint wiki, write readiness reports
wep doctor --ci                     # fail CI when setup has actionable gaps
wep doctor --fix                    # recreate missing files and repair config/policy gaps
wep status                          # quick summary of installed targets and tasks
wep upgrade                         # update harness files to current CLI version
wep config show
wep config set defaultWorkflow SDD+TDD
wep task "Define invoice API examples" --workflow SDD+EDD
wep task continuation TASK-001 --json
wep task search "exact literal text"
wep compile TASK-001 --target codex
wep judge enable                    # install optional judge subagent
wep judge status
wep judge snapshot TASK-001 --base main --json
wep judge scope TASK-001 --base main --candidate SNAPSHOT:<id> --json
wep judge verify .wep/local/judge/TASK-001/review.json --run-tests
wep judge current .wep/local/judge/TASK-001/review.json
wep judge prune --keep 5            # preview; add --force to remove
wep comprehension enable            # enable developer understanding checkpoints
wep comprehension status
wep trace enable                    # opt in to observational session tracing
wep trace status
wep trace report                    # human summary; unknown ordering is shown explicitly
wep trace report --json             # per-session and aggregate contract-conformance metrics
wep trace disable                   # remove only wep-owned hook entries
wep remove --target codex --force   # remove harness for a target
wep templates list                  # list bundled enterprise templates
wep templates apply NAME            # apply bundled template after init
wep templates apply ./pack --local  # apply local template after init
wep templates status                # list applied templates and targets
```

Common flags:

```bash
--target codex|claude|copilot|pi|all
--dry-run
--force
--json
```

Task-only workflow override:

```bash
--workflow fast-patch|research-first|SDD|TDD|EDD|SDD+TDD|SDD+EDD|TDD+EDD
```

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

Every target gets the neutral source of truth:

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
.codex/agents/wep-comprehension.toml  # optional; created by comprehension enable
```

Claude, Copilot, and Pi Code receive their own target adapters under `CLAUDE.md`, `.claude/`, `.github/`, or `.pi/`. Claude and Pi Code get `SKILL.md` workflow packages; Copilot gets repository instructions, skills, and reusable prompt files.

### Agent Discovery in Claude Code

`wep judge enable`, `wep impl enable`, and `wep comprehension enable` write a
subagent file to `.claude/agents/`. Claude Code watches that directory and picks up a new
or edited file within a few seconds, with no restart.

One case is different. Claude Code does not watch a directory that did not exist when the
session started. On a first install, `enable` creates `.claude/agents/` for the first time.
The agent is then not spawnable in that session, and `Agent({ subagent_type:
"wep-judge" })` reports that the agent type is not found.

Restart Claude Code to fix it. Every session you start after the first `enable` finds the
agent. `enable` prints this notice only when it creates the directory, so a notice you do
not see means the watcher already has the file.

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

**One narrow exception.** `wep judge scope` enforces `blockedReadPatterns` mechanically rather than by instruction: matching paths are removed from the diff at the Git level, so their contents are never read, hashed, or shown to the judge, and an unusable `policy.json` stops the command instead of degrading to a default pattern set. Only their paths appear, in `scope.excludedPaths`. This applies to the judge boundary alone — everywhere else in wep the patterns remain advisory, and the paragraph above still governs. See [Judge](JUDGE.md).

Snapshot capture also removes blocked tracked paths from the reviewable worktree, but it
is not secret-history rewriting or encryption: its private shallow Git repository still
contains candidate/base objects. Remove committed secrets from Git history separately.

Treat wep's policy as documentation the agent is expected to follow, not a security boundary. To actually restrict what an agent can read or write, complement it with:

- Your coding agent's own permission system (e.g. Claude Code deny rules, sandboxed tool execution).
- `.gitignore` / secret-scanning for anything under `blockedReadPatterns` (`.env`, `*.pem`, `credentials/`, etc.) so secrets are not present in the working tree at all.
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
