# Configuration

wep stores project defaults in:

```txt
.wep/config.json
```

The config is shared by the CLI and the installed agent harness.

## Modules

A normal `wep init --target codex` installs every module. Select a smaller installation
with `--modules`, then add modules later with `wep enable`:

```bash
wep init --target codex --modules templates
wep enable tasks
wep enable judge,comprehension --dry-run
```

| Module | Includes | Dependencies |
| --- | --- | --- |
| `templates` | Config, manifest, template application support | None |
| `tasks` | Wiki, task templates, target workflow instructions and skills | `templates` |
| `judge` | Policy, review contract, and enabled judge agent files | `tasks`, `templates` |
| `comprehension` | Comprehension contract and schemas | `judge`, `tasks`, `templates` |
| `impl` | Availability of the implementer module | `tasks`, `templates` |
| `trace` | Availability of tracing | `templates` |

Dependencies are included automatically. Omitting `modules` from the config means all
modules, for compatibility with older full installations. `wep enable` adds modules;
there is no general module-disable command. Module availability does not turn on
comprehension, the implementer, or tracing. Use their specific `enable` commands.
Normal init enables the judge; a new installation without the judge module disables it.
Pi receives workflow files but has no native agent definitions.

## Default state

A new full installation uses `task-fit`, every selectable workflow, required task
capsules and workflow reasons, and proportional context loading. Judge is enabled;
comprehension, the implementer, and tracing are disabled. Existing project settings or
a template pack can change these values. `agents.<name>` overrides the older agent
settings when both exist; inspect resolved state with `wep judge status`,
`wep comprehension status`, or `wep impl status TASK-001`.

## Reading and repairing configuration

Most commands reject invalid JSON, a non-object config, or a config with no recognized
target. `init` and `doctor --fix` validate existing configuration before writing files,
including when `--force` or `--dry-run` is supplied. Repair or restore an unusable config
manually before retrying; force does not bypass validation. Plain `doctor` remains
available to diagnose the problem and write its reports. A missing config is distinct
from an invalid one: `init` can create a new configuration. `config show` normalizes recognized fields and fills
missing defaults in its output; it is not a byte-for-byte dump of the file.

## Show Config

```bash
wep config show
```

## Set Defaults

```bash
wep config set defaultWorkflow task-fit
wep config set defaultWorkflow SDD+TDD
wep config set defaultTarget codex
wep config set allowedWorkflows SDD,TDD,fast-patch
wep config set requireTaskCapsule true
wep config set requireWorkflowReason true
wep config set contextBudget proportional
```

## Workflow Default

With `task-fit`, the agent is instructed to choose the smallest suitable workflow for each task. The CLI fallback uses keyword recommendations; see [selection rules](WORKFLOWS.md#selection-rules-and-limits).

Use a concrete workflow when the whole project should bias toward that process unless a task overrides it.

```json
{
  "defaults": {
    "workflow": "task-fit",
    "requireTaskCapsule": true,
    "requireWorkflowReason": true,
    "contextBudget": "proportional"
  }
}
```

## Allowed Workflows

`defaults.allowedWorkflows` restricts which workflows the agent (and the CLI `wep task`) may use. By default it includes every selectable workflow. `UI review` is a task-level recommendation outside that list; the CLI does not filter it with `allowedWorkflows`.

```bash
wep config set allowedWorkflows SDD,TDD
wep config set allowedWorkflows "SDD+TDD, SDD+EDD, fast-patch"
```

Values are comma- or space-separated and normalized automatically. Invalid values are rejected.

Behavior:

- An explicit `--workflow` that is not allowed is rejected.
- A configured `defaultWorkflow` that is not allowed is rejected as a misconfiguration.
- When `task-fit` recommends a disallowed workflow, the CLI falls back to the first allowed workflow and records the reason in the task capsule.

```json
{
  "defaults": {
    "allowedWorkflows": ["SDD", "TDD", "fast-patch"]
  }
}
```

## Context Budget

- `minimal`: load only policy and current task capsule.
- `proportional`: load policy, current task capsule, and relevant wiki pages.
- `thorough`: allow broader wiki review for high-risk tasks.

Do not read all of `.wep/` by default.

---

## Comprehension Gate

The optional comprehension gate installs a separate learning evaluator that asks the developer code-specific questions after a significant completed change. It runs outside the implementing agent's context, may inspect Git with read-only commands, but never stages, commits, pushes, merges, resets, or otherwise changes Git state. It does not block merges or replace correctness review.

Enable it once for the project:

```bash
wep comprehension enable
wep comprehension status
wep comprehension disable
```

When enabled, checkpoints are surfaced asynchronously through `wep status`; the primary agent invokes `wep-comprehension` when the developer requests a checkpoint. If the judge is enabled, the primary agent first obtains the automatic independent review, saves its structured record locally, and verifies it with the digest observed from `wep judge run`. Comprehension independently checks the record with plain verification and current-boundary classification; it does not re-execute validation or authenticate the receipt digest. It starts only for an independent APPROVED record bound to the current task and code. It then reconstructs the change, skips surface-only work, renders a change map and test matrix, and conducts a short interactive checkpoint for meaningful logic, architecture, security, persistence, infrastructure, or other material risks.

The handoff is deliberately narrow: task ID, exact base/candidate boundary, and verified judge-record path. The implementing agent must not provide its explanations, proposed questions, expected answers, or conclusions. See [COMPREHENSION.md](COMPREHENSION.md) for the full protocol and platform differences.

Personal answers, hints, and results belong in `.wep/local/comprehension/TASK-XXX/<session-id>/`. The installed `.wep/local/.gitignore` keeps new records out of version control by default. Before persistence, the agent verifies the path with read-only Git commands; if it cannot verify this, it keeps the interaction in chat. Git ignore rules are not encryption and do not protect files from other local software or backups.

```json
{
  "comprehensionGate": {
    "enabled": false,
    "trigger": "agent-assessed-significance",
    "evaluationMode": "prefer-independent"
  }
}
```

---

## Profiles

Profiles are installation presets stored in `.wep/config.json` and `.wep/policy.json`.

```bash
wep init --target codex --profile default
wep init --target copilot --profile strict
wep init --target copilot --profile regulated
```

- `default`: standard wep behavior.
- `strict`: uses `contextBudget: thorough` and adds stricter blocked-read patterns.
- `regulated`: inherits strict policy, adds regulated-material blocked reads, and routes small safe patches to `TDD` instead of `fast-patch`.

Example config fields:

```json
{
  "profile": "regulated",
  "defaults": {
    "contextBudget": "thorough"
  },
  "workflowRules": {
    "smallSafePatch": "TDD",
    "default": "research-first"
  }
}
```

`wep doctor` validates profile-specific policy requirements.

### Applied template packs

Successful post-init template applications are recorded in `templatePacks`:

```json
{
  "templatePacks": [
    {
      "name": "company-base",
      "version": "1.0.0",
      "source": "bundled",
      "targets": ["copilot"],
      "fileHashes": {
        ".github/skills/company-review/SKILL.md": "sha256:..."
      }
    }
  ]
}
```

The hashes keep template-owned target files distinct from obsolete core harness files during upgrades. Use `wep templates status` instead of editing this registry manually.

### Protected instruction merges

`policy.json` keeps root instruction files protected by default and defines one narrow Doctor exception:

```json
{
  "protectedFileMerge": {
    "agentMayEdit": "after-explicit-human-approval",
    "approvalScope": "current-conversation",
    "requireDiffPreview": true
  }
}
```

The agent must show the exact minimal diff first. Only explicit approval of that diff in the current conversation permits the edit; a changed proposal requires new approval. This is an agent policy, not an operating-system permission boundary.

---

## Upgrade provenance

`.wep/manifest.json` stores SHA-256 hashes only for generated files that wep actually wrote. `wep upgrade` compares each current file with its recorded hash:

- matching hash: safe automatic update;
- current template already present: preserve and register it;
- missing or mismatched provenance: preserve and write `.wep/upgrades/<version>/<path>`;
- obsolete generated path: report and preserve.

Wiki pages, tasks, local records, and root agent instructions are project-owned and excluded from automatic replacement. `installedVersion` advances only after every installed target has been upgraded without blocking conflicts.

## Judge

The judge independently reviews implementation against the task capsule. Normal full init enables it for Codex, Claude Code, and Copilot. It can be disabled. The installed workflow invokes it automatically after implementation within the approved task contract; the initial Approval Brief covers the workflow, acceptance criteria, and exact validation commands.

```bash
wep judge enable   # install judge files and set enabled: true
wep judge disable  # set enabled: false (files are kept)
wep judge status   # show state
wep judge snapshot TASK-001 --base main --json
wep judge scope TASK-001 --base main --candidate SNAPSHOT:<id> --json
wep judge verify .wep/local/judge/TASK-001/review.json --run-tests
wep judge current .wep/local/judge/TASK-001/review.json
```

The normal workflow captures `wep judge snapshot TASK-001 --base <ref>`, runs approved
validation once with `wep judge run TASK-001 --candidate SNAPSHOT:<id>`, and gives the
receipt to the independent judge. The trusted caller verifies with
`wep judge verify <review.json> --receipt-digest <digest-observed-from-run>`, then uses
`wep judge current <review.json>` to classify live applicability. `verify --run-tests`
is a separate fresh-run option. Catch-up uses `judge snapshot --from-review <review.json>
--receipt-digest <digest>`. Local snapshots are ignored and can be
preview-pruned with `wep judge prune --keep <n>`; add `--force` to apply deletion.

A disabled legacy judge setting looks like this (a new full init uses `true`):

```json
{
  "judge": {
    "enabled": false,
    "trigger": "post-implementation"
  }
}
```

**Do not set `enabled: true` manually in `config.json`** without running `wep judge enable` first. If the judge is enabled but no agent files exist, `wep doctor` will detect the gap and prompt you to run `judge enable`.

Each platform's judge agent file is installed in the native subagent location for that target. The model comes from `agents.judge.model.<target>` and is regenerated by `wep upgrade`. See [JUDGE.md](JUDGE.md) for per-platform identifiers.

---

## Agents

`agents` is the canonical configuration for wep agents: which are enabled, when they
trigger, which hosts they are emitted for, and which model each host runs them with.

```json
{
  "agents": {
    "judge": {
      "enabled": true,
      "trigger": "post-implementation",
      "targets": ["claude", "codex"],
      "model": { "claude": "opus", "codex": "gpt-5-codex" }
    },
    "comprehension": { "enabled": true },
    "implementer": { "enabled": false, "maxAttempts": 3 }
  }
}
```

The CLI recognizes three built-in entries: `judge`, `comprehension`, and `implementer`.
Unknown entries are preserved as JSON values and reported as warnings, but are not
generated or invoked. Template-pack custom agents use a separate format; see
[TEMPLATE_PACKS.md](TEMPLATE_PACKS.md).

Every field is optional. Resolution uses the canonical field first, then its legacy
setting when present, then the built-in fallback.

| Field | Meaning |
| --- | --- |
| `enabled` | Whether the agent is enabled for its installed workflow. Fallback `false` when neither canonical nor legacy state exists; normal init supplies legacy judge `true`. |
| `trigger` | A scheduling hint for the lead agent / host. Recognized values and behavior depend on the agent; see the implementer semantics below. Unknown values remain warnings. |
| `targets` | Narrows emission to a subset of the installed targets. |
| `model` | Per target: `{ "claude": …, "codex": …, "copilot": … }`. |
| `maxAttempts` | `implementer` only. Positive integer, default `3`. |

Set any of them from the CLI:

```bash
wep config set agents.judge.enabled true
wep config set agents.judge.trigger post-implementation
wep config set agents.judge.targets "claude, codex"
wep config set agents.judge.model.claude opus
wep config set agents.implementer.maxAttempts 3
```

### Implementer trigger semantics

The lead agent reads the resolved implementer state from `wep impl status TASK-XXX --json`;
it must not duplicate canonical/legacy precedence by reading a raw config key. When the
resolved implementer is disabled, it is neither offered nor started. With `on-request`, the
handoff is offered only after the user asks to use the implementer. With
`post-clarification`, approval of the initial Approval Brief is the explicit confirmation
to start implementation and delegate; the agent should not ask a second time. An
`on-request` handoff requires the explicit request and confirmation. The CLI does not
schedule or fire an agent; these are instructions for the lead agent.

Unknown trigger values remain warnings. They never invent an automatic invocation; the lead
agent waits for an explicit user request and confirmation.

### Warnings, not errors

An unrecognized trigger and an unfamiliar model identifier are **warnings**. Both are
propagated exactly as configured, and reported by `enable`, `doctor`, `upgrade`, and
`status`. wep cannot enumerate every point in a workflow at which a project might want
an agent invoked, and it does not have any provider's model catalogue, so refusing an
unfamiliar value would block legitimate work to catch a typo.

Unlike unfamiliar model or trigger strings, an invalid `agents.implementer.maxAttempts` is an error. Its domain is fully known, and an
unparseable budget must not silently grant a fresh allowance.

An entry wep does not recognize is also a warning. It is ignored for resolution and
preserved as an unknown JSON value, so a configuration written by a newer wep that
knows a fourth agent neither disables an older CLI nor loses its settings the next time
that CLI writes the file.

### Targets and Pi

`targets` narrows the installed targets; it never widens them. A target listed for an agent
but not installed is skipped with a warning rather than failing the command.

Pi has no agent format. It is a supported wep target for prompts and skills, and
configuring it under any agent's `targets` produces a warning and is skipped. Claude Code,
Codex, and Copilot are the three supported agent hosts.

### Compatibility with `judge`, `comprehensionGate`, and `impl`

The older keys keep working. Agent resolution reads them when a canonical field is absent;
reading a legacy config does not rewrite it, and `wep upgrade` neither migrates nor deletes
them. When a command changes an agent setting it writes `agents.<name>` and keeps an
existing legacy key in step, so an older wep reading the same file still behaves the same.

When both forms are present and disagree — because they were hand-edited apart — `agents`
wins and `wep doctor` reports the divergence naming both paths and the value in effect.

---

## Implementer

The implementer is an optional agent that implements one task capsule against its
acceptance criteria and records every round in an append-only log.

```bash
wep impl enable                 # install the agent files, set agents.implementer.enabled
wep impl start TASK-001         # open or resume the log, get the round number
wep impl log TASK-001 ...       # append one round record
wep impl status TASK-001        # resolved enabled/trigger, attempts, remaining, last blocker
```

The log lives at `.wep/local/impl/TASK-NNN/log.md`, which `.wep/local/.gitignore`
already excludes. That placement is load-bearing: a log inside the capsule would be a
tracked file in the review diff, which would let the judge read the implementing agent's
own account of its work as evidence. Writing a round never moves `taskDigest`.

Because that guarantee rests on a file the store does not own, every `impl` command checks
it. If `.wep/local/.gitignore` is missing or no longer ignores local storage, `impl
enable` refuses and `start`, `log`, and `status` report the task as stopped with no attempt
count, until `wep doctor --fix` restores it.

The attempt count is derived from the persisted records, never supplied by the caller, so a
fresh agent instance reads the true count instead of assuming it is the first. `impl log`
enforces the budget itself: a caller that skips `impl start` does not thereby escape the
limit. A log that cannot be parsed is reported as unreadable rather than as zero attempts
used — an untrustworthy log must not grant a fresh budget.

---

## Example config.json

This example includes optional canonical agent entries. It is not the exact output
of every init; installedVersion is managed by the CLI.

```json
{
  "version": 1,
  "installedVersion": "0.8.0",
  "profile": "default",
  "targets": ["codex"],
  "judge": {
    "enabled": true,
    "trigger": "post-implementation"
  },
  "comprehensionGate": {
    "enabled": false,
    "trigger": "agent-assessed-significance",
    "evaluationMode": "prefer-independent"
  },
  "agents": {
    "judge": { "enabled": true, "model": { "claude": "opus" } },
    "comprehension": { "enabled": false },
    "implementer": { "enabled": false, "maxAttempts": 3 }
  },
  "defaults": {
    "workflow": "task-fit",
    "allowedWorkflows": ["fast-patch", "research-first", "SDD", "TDD", "EDD", "SDD+TDD", "SDD+EDD", "TDD+EDD"],
    "requireTaskCapsule": true,
    "requireWorkflowReason": true,
    "contextBudget": "proportional"
  },
  "workflowRules": {
    "default": "task-fit",
    "bugfix": "TDD",
    "apiOrContract": "SDD+TDD",
    "edgeCases": "SDD+EDD",
    "ui": "UI review",
    "smallSafePatch": "fast-patch",
    "unknownArea": "research-first"
  }
}
```


`config set` accepts the six short default keys shown above and their dotted aliases
(`defaults.workflow`, `defaults.target`, `defaults.allowedWorkflows`,
`defaults.requireTaskCapsule`, `defaults.requireWorkflowReason`, `defaults.contextBudget`).
For built-in agents it accepts `enabled`, `trigger`, `targets`, and
`model.<codex|claude|copilot>`; only the implementer accepts `maxAttempts`.
Other fields such as `workflowRules` and profile policy require deliberate file edits.
Changing an agent model or enabled setting with `config set` does not itself install
or regenerate native agent files; run the corresponding enable command or `wep upgrade`.
