# Security and merge rules

## What the CLI enforces

Wepwawet installs local files and performs deterministic checks. It does not call an LLM or
launch a coding agent. Some commands inspect Git, and judge validation commands execute
approved shell commands. The generated instructions guide the coding agent that you run.

Policy is guidance for a cooperative agent, not an operating-system sandbox. It does not stop
a malicious agent, prompt injection or an untrusted template pack. Use the host agent's own
permissions and an appropriate execution environment to restrict file access and commands.

## Initialization and existing files

By default, `wep init` adds missing generated files and preserves existing ones. These root
instruction files are protected even with `--force`:

| Existing file | Suggested candidate |
| --- | --- |
| `AGENTS.md` | `AGENTS.wep.suggested.md` |
| `CLAUDE.md` | `CLAUDE.wep.suggested.md` |
| `.github/copilot-instructions.md` | `.github/copilot-instructions.wep.suggested.md` |
| `.pi/README.md` | `.pi/README.wep.suggested.md` |

An existing suggestion is preserved rather than overwritten. The CLI does not automatically
append or merge root instructions, and it has no `--merge` option. Review suggested content
before accepting it.

`--force` can overwrite non-protected generated paths, including locally edited files; it is
not a general preservation guarantee. Init also updates installation configuration and
provenance as needed when adding targets or modules. Use `--dry-run` and inspect the plan
before changing an existing installation. For routine version updates use `wep upgrade`, which
tracks recorded hashes and produces candidates for modified or unrecognized files. See
[Reference](REFERENCE.md).

A default task-enabled install creates `.wep/wiki/agent-setup.md`, gaps and recommendation
files as placeholders. `wep doctor` fills deterministic setup findings; the agent's Doctor
workflow supplies semantic instruction and project analysis.

## Human-approved instruction merge

The generated Doctor workflow permits a surgical edit to protected instructions only when:

1. A matching `.wep.suggested.md` candidate exists.
2. The agent shows the exact minimal diff before editing.
3. The human explicitly approves that diff in the current conversation.
4. The proposal and target remain unchanged while applying it.
5. The agent shows the resulting diff and reruns Doctor.

Silence, approval from another conversation or a broad request such as “fix everything” does
not satisfy that workflow. If the diff changes, approval must be requested again. The agent
removes a suggestion only after verifying the merge. These are prompt-level controls; the CLI
does not record or authenticate the conversation's approval.

## Policy checks

The `judge` module installs `.wep/policy.json`. Default policy includes:

- `mergeStrategy: "preserve-and-suggest"` and the four protected root files above.
- The current-conversation approval and diff-preview contract.
- Blocked-read patterns for `.env`, `.env.*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`,
  `secrets/`, `credentials/` and `private/`.
- Minimal root instructions and on-demand context loading.
- Required task capsules, workflow reasons, acceptance criteria and review checklists.
- Write locations for Doctor findings, capsules, compiled briefs, decisions and local
  implementation notes.

Strict and regulated profiles add blocked-read patterns; see
[Configuration](CONFIGURATION.md). Policy does not disable normal source-code implementation.
The installed skills distinguish durable project notes from private implementation and
comprehension records.

```bash
wep doctor --ci
```

CI mode exits nonzero for a missing install or target, missing required files, pending
instruction merges or error-level findings. When the judge module is installed it also
checks policy fields against the expected profile: protected files and blocked-read patterns,
merge approvals, context loading, enforcement flags and write-policy entries. Passing Doctor
checks these conditions; it does not prove instructions are safe or a code change is correct.

## Review execution and hooks

Judge records bind the reviewed task and code boundary. A trusted caller must use receipt
verification or a fresh approved validation run; a JSON verdict alone does not prove tests ran.
Read [Judge](JUDGE.md) for the exact procedure, currentness checks and limits.

`judge run` executes declared validation in the working tree by default. `--isolated` uses a
disposable copy for ordinary relative writes; it is not a sandbox against absolute writes,
network access or malicious commands. Inspect every declared command before approving it.

When the judge is enabled for Claude Code, a separate run guard is installed in
`.claude/settings.local.json`. During an active judge validation run it refuses `Edit`,
`Write`, `MultiEdit` and `NotebookEdit` tools. Shell writes are not intercepted, and missing,
stale or unreadable guard state fails open. The after-run digest checks for reviewed-file
changes the guard missed. This guard is independent of the observational
[session tracing](TRACING.md) hooks.

The comprehension agent may inspect in-scope Git history and diffs read-only, after applying
blocked-read patterns. Its instructions forbid Git mutations. Personal responses belong under
`.wep/local/`, with ignored and untracked status verified before persistence. Ignore rules do
not encrypt records or prevent accidental sharing outside Git.

## Template packs, migration and removal

Packs can add agent instructions and merge configuration or policy. A weakening warning is
not a rejection or a trust guarantee. Pack apply/update conflict handling differs from init;
see [Template packs](TEMPLATE_PACKS.md).

`wep migrate --dry-run` previews a legacy `.akrctx/` installation's move to `.wep/`. Migration
rejects a pre-existing destination rather than combining both trees. It checks blocked paths,
symlinks, collisions and provenance before writing. Local judge and comprehension trees keep
their original bytes; migration does not renew an old review approval. Inspect the migration
diff, then run Doctor.

`wep remove` previews by default; deletion requires `--force`. It preserves protected root
instructions. `--all` preserves task capsules and local records unless `--purge-tasks` and
`--purge-local` are explicitly requested. Removal works from known generated paths, not a
proof that every file at those paths is still unmodified; review the plan. It removes wep-owned
trace wiring from shared settings and the separate Claude guard, keeping unrelated hooks.
