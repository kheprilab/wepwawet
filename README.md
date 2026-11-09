<div align="center">

# Wepwawet

**Project context, task plans, and independent review for coding agents.**

[![Release](https://img.shields.io/github/v/release/kheprilab/wepwawet?style=flat-square&color=2563eb)](https://github.com/kheprilab/wepwawet/releases)
[![CI](https://github.com/kheprilab/wepwawet/actions/workflows/ci.yml/badge.svg)](https://github.com/kheprilab/wepwawet/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-64748b?style=flat-square)](LICENSE)

Codex · Claude Code · GitHub Copilot · Pi Code

[Quickstart](#quickstart) · [How it works](#how-it-works) · [Documentation](#documentation)

</div>

---

Wepwawet (`wep`) installs instructions, a project wiki, and task templates in your
repository. Your coding agent uses them to record what it will change, choose a
workflow, and check the result against acceptance criteria. Tasks and context remain
in files that you can read, version, and use in another session.

## A first task

Once Wepwawet is installed, initialize it in your project:

```bash
wep init --target codex
```

Open Codex in that repository and ask:

> Run wep task workflow for invoice API examples. Use SDD+EDD.

The agent creates or updates a task capsule under `.wep/tasks/TASK-XXX/` with
the goal, relevant context, workflow, acceptance criteria, and validation commands.
The task stays in the repository for the next session or another supported agent.

## Why Wepwawet?

- **Keep context between sessions.** Store project decisions, conventions, and task
  context in files you can read and version.
- **Match the process to the task.** Choose specification-driven development (SDD),
  test-driven development (TDD), example-driven development (EDD), research-first,
  fast-patch, or a combination.
- **Share a foundation across agents.** Keep neutral project context in `.wep/`
  and install the adapters your coding tools use.
- **Make review explicit.** Define acceptance criteria before implementation and
  use a separate judge to review the result against a fixed snapshot. Normal init
  enables the judge; you can disable it.

## Quickstart

Requires **Node.js 20+**, **npm**, **Git**, and a supported coding agent.

**1. Install the CLI.**

```bash
npm install -g wepwawet
wep --version
wep --help
```

**2. Initialize your project.**

```bash
cd /path/to/your-project
wep init --target codex
wep doctor
```

Replace `codex` with `claude`, `copilot`, or `pi`, or use `all` for every adapter.
Init also accepts a comma-separated list such as `--target codex,claude`.
Use `--dry-run` to preview an install. Existing root instructions are preserved and
receive a suggested merge file; review that merge before expecting the agent to
follow the harness.

**3. Open your coding agent and describe a task.**

Ask it to use the wep task workflow, as in the [example above](#a-first-task).
The agent owns the workflow after initialization; CLI task commands are also
available for scripts and headless use.

See [installation details](docs/INSTALLATION.md) for updates and building from source,
or follow the [task walkthrough](TUTORIAL.md) through implementation and review.

## How it works

1. **Install the harness.** `init` creates shared context, task templates, and agent
   instructions. Existing root instruction files receive a suggested merge file.
2. **Define the task.** The agent records the goal, resolves material ambiguity,
   selects a workflow, and writes acceptance criteria and validation commands. It presents
   those in a short Approval Brief for your approval before implementation.
3. **Implement and validate.** The agent follows the selected workflow, updates the
   task checklist, and runs the agreed checks. For independent review, capture a snapshot,
   run approved validation, and verify the separate judge's structured record.

The judge is enabled by normal full init for Codex, Claude Code, and Copilot, and
the installed workflow invokes it automatically after the approved implementation.
Comprehension checkpoints, the implementer agent, and local tracing are disabled until
enabled. Pi supports workflow prompts and skills, but has no Wepwawet subagent adapter. See [configuration](docs/CONFIGURATION.md) for
module selection and resolved agent settings. The initial Approval Brief asks you to
approve the workflow, acceptance criteria, and exact validation commands. Comprehension
checkpoints are requested by the developer, rather than interrupting task completion.

Root instructions stay small; detailed workflows load when relevant. The CLI generates
files that your coding agent reads. It does not call an LLM or execute an agent itself.

## Everyday commands

| Command | Use it to |
| --- | --- |
| `wep init --target codex` | Install the harness for your agent |
| `wep doctor` | Check setup and report gaps |
| `wep status` | See installed targets and task status |
| `wep config show` | Inspect project defaults |
| `wep upgrade` | Update installed harness files |
| `wep templates list` | Explore bundled templates |

See the [operational reference](docs/REFERENCE.md) for the full command overview,
generated file layout, task search, continuation, templates, and maintenance.

## Documentation

| Start here | Explore further |
| --- | --- |
| [Installation](docs/INSTALLATION.md) | Requirements, building, and linking |
| [Workflows](docs/WORKFLOWS.md) | Choosing and combining working methods |
| [Configuration](docs/CONFIGURATION.md) | Defaults, profiles, and optional agents |
| [Operational reference](docs/REFERENCE.md) | Commands, generated files, and context storage |
| [Judge](docs/JUDGE.md) | Independent review, snapshots, and verification |
| [Comprehension](docs/COMPREHENSION.md) | Developer understanding checkpoints |
| [Tracing](docs/TRACING.md) | Optional session tracing and reports |
| [Command guide](docs/COMMANDS_AND_UX.md) | Every command group, task tools, migration, and removal |
| [Targets](docs/TARGETS.md) | Generated files and platform differences |
| [Continuation](docs/CONTINUATION.md) | Portable declared execution state |
| [Harness specification](docs/HARNESS_SPEC.md) | Task capsules, evidence, review, and [implementer](docs/HARNESS_SPEC.md#implementer-agent) contracts |
| [Security and merge rules](docs/SECURITY_AND_MERGE_RULES.md) | Preservation and permission boundaries |
| [Template pack format](docs/TEMPLATE_PACKS.md) | Team conventions and reusable templates |

## Safety and limits

Wepwawet preserves existing root agent instructions and writes suggested merge files
for human review. Its policy files guide a cooperative agent; they are not a sandbox.
Use your coding agent's own permissions to restrict access and execution.

The judge has a separate, mechanically checked review boundary, with specific limits.
Read the [security model](docs/REFERENCE.md#security-model) and
[judge guarantees](docs/JUDGE.md#what-this-does-and-does-not-prove) before relying on it.

## Development and project policy

Run the repository checks before handing off a change:

```bash
pnpm build
pnpm test
pnpm lint
pnpm typecheck
pnpm wep init --target codex --dry-run
pnpm wep doctor --json
```

Feature and fix evaluation guidance lives in [evals/README.md](evals/README.md).

Wepwawet is the open-source core published by [Kheprilab](https://kheprilab.com).
See [Contributing](CONTRIBUTING.md) for the pull request and release workflow.

Licensed under [MIT](LICENSE).
