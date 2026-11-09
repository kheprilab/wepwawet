# Product design choices

## Files installed in the repository

Wepwawet installs workflow instructions, task templates and shared project context. The CLI
performs deterministic operations; the coding agent does the reasoning and implementation.
It does not call a model provider or run the agent itself.

## Preserve existing root instructions

Initialization writes suggested candidates for existing root instruction files, including
when `--force` is used. Other generated files can be overwritten with `--force`.
Doctor reports setup gaps and supplies the agent workflow for reviewing instruction merges.
See [Security and merge rules](SECURITY_AND_MERGE_RULES.md).

## Shared context, target-specific adapters

`.wep/` contains shared configuration, project wiki and task records. Target adapters expose
that context in the files each supported host reads. This keeps task context independent of
the current agent, while leaving host-specific discovery and permissions to the host.

## Codex instructions and agents use different paths

Codex root instructions use `AGENTS.md` and workflow skills use `.agents/skills/`.
Optional Codex agents use `.codex/agents/`; it is not the root instruction location.
See [Targets](TARGETS.md).

## Checks have explicit boundaries

Doctor checks setup; the independent judge checks a task and code boundary; comprehension
checks the developer's understanding. Those are separate operations. None substitutes for the
others, and a prompt-level instruction is not a sandbox or an authenticated reviewer identity.
See [Judge](JUDGE.md) and [Comprehension](COMPREHENSION.md).
