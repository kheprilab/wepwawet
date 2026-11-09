# Session tracing

Session tracing is opt-in (`wep trace enable`), observational, and fail-open. Hooks never
approve, block, or alter a host tool call. `wep trace report` derives its metrics from the
recorded lifecycle events; `--json` includes the per-session records.

## Setup and commands

Run these commands in an initialized project:

```bash
wep trace enable --dry-run
wep trace enable
wep trace status
wep trace report
wep trace report --json
wep trace disable
```

`enable` wires every installed target and sets `trace.enabled` to true. `disable` removes
wep-owned trace entries, sets the flag to false, and keeps existing records. `--dry-run`
previews either operation without changing settings. `status` reports the configuration flag,
actual wiring, recorded session count, and hosts that have not been exercised in a conformance
run. `report` derives metrics from local records; it does not contact a service. All four
commands accept `--json`.

Records are JSONL files under `.wep/local/traces/`. Normal task-enabled initialization creates
an ignore rule for `.wep/local/`. If using a minimal module installation, check the directory is
ignored before recording. Disabling tracing does not delete these files. Review any local
records before sharing them.

| Target | Wiring file |
| --- | --- |
| Claude Code | `.claude/settings.json` |
| Codex | `.codex/hooks.json` |
| GitHub Copilot | `.github/hooks/wep-trace.json` |
| Pi | `.pi/extensions/wep-trace.ts` |

JSON settings retain unrelated entries; the Pi extension occupies a wep-specific file.
Hook commands pin the Node executable and CLI build used by `enable`. Rerun `enable` after
moving the checkout or changing the CLI installation. `status` checks the expected pinned
commands rather than treating any similarly named hook as current. It currently labels Codex,
Copilot and Pi wiring as unverified: those adapters follow host documentation, while Claude
has been exercised by an observed run. Wiring alone does not prove that a host is delivering
all expected events.

Trace hooks are separate from the Claude Code judge run guard. When installed, that guard can
refuse file-writing tools during validation. Disabling tracing leaves it in place. See
[Judge](JUDGE.md).

## Privacy

Trace observations omit raw shell commands, arguments, file paths and tool results. A shell observation contains
only a safe executable label, a command digest used to correlate a declared validation command,
and lifecycle metadata. Blocked-path matching remains a boolean flag. Records also contain
host/session identifiers, timestamps, tool names, capsule IDs and, when available, the starting
Git commit. The digest is not encryption; someone who knows a possible command can hash it to
check whether it matches. Host-provided metadata is not a safe place for sensitive labels.

Shell effects are intentionally unclassified. `ls`, `find`, `cat`, and `git` are not treated as
read-only because redirections, flags, aliases, subcommands, and shell syntax can alter the tree.

## Per-session fields

`mutatedProject` is true only after a completed known write outside `.wep/`.

`capsuleBeforeFirstMutation` is trivalent:

- `true`: the first known project mutation followed a bound capsule and no possible earlier
  mutation obscures that order.
- `false`: the first known project mutation preceded the capsule binding.
- `null`: there is no known project mutation, or a possible mutation before binding makes the
  order unprovable. It is `unknown`, not a failure.

`unclassifiedShellBeforeBinding` counts distinct shell calls observed before binding. A matching
`PreToolUse` and `PostToolUse` with the same call id count once. Without an id, each `PreToolUse`
counts as one call and `PostToolUse` does not increment it; this avoids falsely pairing or double
counting concurrent anonymous calls. A post without its pre still makes the session uncertain,
but contributes zero to this count because no call was observed to start.

`capsuleComplete`, `validationDeclared`, and `validationObserved` are independent facts. An
unknown ordering never clears them. Validation still requires a successful post event with the
same call id and command digest as a declared validation command.

## Aggregate denominators

A complete trace has a valid session header, parseable records, and a final session-end event.
A running, interrupted or truncated session is incomplete and excluded from aggregate metrics;
it remains visible in JSON output. A resumed lifecycle needs its own end event.

Complete sessions partition into three buckets:

| Bucket | Meaning |
| --- | --- |
| `mutating` | A known mutation outside `.wep/` occurred, including sessions with unknown ordering. |
| `uncertain` | No known mutation occurred, but an unclassified shell or unresolved write may have changed the tree. |
| `readOnly` | No known mutation occurred and no unobserved mutation is possible. |

`orderingKnown` and `orderingUnknown` partition `mutating` by whether
`capsuleBeforeFirstMutation` is boolean or `null`.

`capsuleBound`, `capsuleComplete`, `validationDeclared`, and `validationObserved` use every
known-mutating session as their denominator. `capsuleBeforeFirstMutation` uses only
`orderingKnown`; the human report renders an all-unknown ordering denominator as `unknown`,
never as `false` or `0%`.


## Interpretation limits

The report measures recorded tool lifecycle evidence, not the correctness of the change or
whether every instruction was followed. An attempted or failed edit does not establish a
mutation. Unknown tool schemas, absent paths, missing call IDs and shell commands can leave
ordering uncertain. Capsule completeness and declared validation are checked against the
current capsule files when generating the report; the trace is not an immutable copy of those
files. `blockedPathTouched` counts a match observed by the hooks, not a prevented read. Hooks
do not read the blocked file's contents or enforce access permissions.
