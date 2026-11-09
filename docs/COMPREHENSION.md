# Comprehension checkpoints

The comprehension agent helps a developer understand a completed change. It reads the code in a
separate context, prepares questions, and evaluates the answers. The CLI installs its profile and
schemas; it does not conduct the session, call a model, or grade answers itself.

Comprehension starts disabled. It is an optional learning checkpoint, not a correctness review or
a merge restriction.

## Enable and inspect

```bash
wep comprehension enable --dry-run
wep comprehension enable
wep comprehension status
wep comprehension status --json
wep comprehension disable
```

All three subcommands accept `--json`, `--dry-run`, and `--force`. Enable regenerates the agent
files from configuration; disabling keeps them. Enabling requires:

- an initialized harness at the current CLI version;
- the scope, rubric, and result schemas under `.wep/comprehension/schemas/`;
- a safe `.wep/local/.gitignore` containing exactly `*` and `!.gitignore` as active rules;
- at least one supported installed target allowed by `agents.comprehension.targets`.

The CLI reports the failing prerequisite. Use `wep upgrade` for an older harness or
`wep doctor --fix` for missing contract files and unsafe local storage. If the comprehension
module was omitted from a modular installation, add it with `wep enable comprehension` first.
That also adds its required judge, tasks, and templates modules.

The canonical settings are `agents.comprehension.enabled`, `.trigger`, `.targets`, and
`.model.<target>`. They take precedence over the legacy `comprehensionGate` settings when both
exist. The default trigger is `agent-assessed-significance`; it is an instruction for the coding
agent to assess the change, not an automatic background process. The only supported
`comprehensionGate.evaluationMode` configuration value is `prefer-independent`.

Choose a model available in the relevant host, then regenerate its profile:

```bash
wep config set agents.comprehension.model.codex <model-id>
wep comprehension enable
```

The CLI warns about unfamiliar model shapes but cannot check availability in your account.
Omitting a model leaves selection to the host. A host may need a new session to discover a newly
created agent profile; `enable` reports a discovery notice when applicable.

## Workflow

1. The primary agent finishes implementation and validation.
2. When the judge is enabled, a trusted caller runs validation for a snapshot, obtains the
   independent review, and verifies it using the digest observed from `judge run` (or a fresh
   `verify --run-tests`). See [Judge](JUDGE.md#where-the-strong-check-runs).
3. The primary agent closes the task without a comprehension prompt. The developer can request a
   checkpoint separately; `wep status` lists pending comprehension tasks.
4. On request, the comprehension agent receives only the task ID, exact base/candidate boundary, and the
   judge-record path when required. It independently reads the capsule, diff, code, and tests.
5. It assesses significance from code evidence: `surface`, `logic`, `architectural`, or `critical`.
   Surface-only changes are skipped. Other changes receive a checkpoint.

The handoff must not include implementation explanations, suggested questions, expected answers,
or the implementer's conclusions.

When the judge is enabled, the evaluator itself runs plain `wep judge verify <record> --json`
and `wep judge current <record> --json`. It requires `approved: true`, an independent record
(`independent` absent or `true`), and a `CURRENT` result. The generated evaluator instructions
reject `NEWER_CHANGES` and `DIVERGED`; they do not define a metadata-only exception. Note that
`judge current` reports both full-workspace `status` and the code-only `reviewBoundary`: a valid
continuation-sidecar advance can move the former while leaving the latter current. See
[Judge](JUDGE.md#current-state-and-catch-up-review) before interpreting those fields. With the judge disabled, the handoff can omit its record; disclose that no independent correctness
review exists, and give the evaluator an explicit, reviewable change boundary.

The evaluator passes neither `--run-tests` nor `--receipt-digest`: it executes no validation and
cannot authenticate a digest supplied by the implementer. Plain verification checks boundary
integrity and accepts validation claims on trust. The stronger execution check belongs to the
trusted caller before handoff.

If the evaluator finds evidence that contradicts the task or approved premise, it stops with
`INVALID_GATE` and returns the contradiction for code review.

## Learning experience

Before questions, the agent prepares a compact Mermaid change map when supported and a Markdown
test matrix connecting behavior, evidence, and risk. It freezes a private rubric containing two
to six code-specific questions before the first answer, then asks one question at a time.

The questions cover factual flow, design reasoning, tests, and risks. The agent evaluates ideas
rather than exact wording. Hints are progressive; meaningful assistance is recorded. Progress
shows the question number and dimension without revealing expected answers early.

The final status is one of `VERIFIED`, `ASSISTED`, `UNVERIFIED`, `INVALID_GATE`, `SKIPPED`, or
`DEFERRED`, with a learning report. These are evaluator outputs defined by the prompt and schemas,
not a deterministic CLI certification of the developer's competence.

## Local artifacts

The installed contract defines:

```text
.wep/comprehension/schemas/
  scope.schema.json
  rubric.schema.json
  result.schema.json
```

A trusted orchestrator may persist a session under:

```text
.wep/local/comprehension/TASK-XXX/<session-id>/
  scope.json
  rubric.json
  transcript.md
  result.json
  learning-report.md
```

Personal answers stay in the evaluator conversation unless such an orchestrator persists them.
They must never enter task capsules, wiki pages, implementation logs, tracked files, telemetry, or
the return handoff to the implementing agent. Wepwawet supplies the schemas and checks the local
ignore; it has no CLI command that runs the teaching session or automatically validates and saves
its artifacts. Git ignore is a storage convention and does not prevent a user from force-adding a
file.

The result sent back to the implementer contains only the status, non-personal gaps, and
code-review contradictions. Keep rubric answers private until the session ends.

`wep status` derives pending tasks from locally stored review rounds: a task whose latest
historical round is `APPROVED` remains pending until a readable local comprehension result has a
status other than `DEFERRED`. This is a reminder list, not proof that the review is still current,
that a result passed schema validation, or that understanding was verified. An `ASSISTED`,
`UNVERIFIED`, or `SKIPPED` session also clears that reminder. Check the actual result and current
review boundary before interpreting the list.

## Platform adapters

| Platform | Agent file | Emitted controls |
| --- | --- | --- |
| Codex | `.codex/agents/wep-comprehension.toml` | High reasoning and `sandbox_mode = "read-only"` |
| Claude Code | `.claude/agents/wep-comprehension.md` | Read/search/Bash tools, plan permission mode, foreground, 24-turn limit |
| GitHub Copilot | `.github/agents/wep-comprehension.agent.md` | Read, search, and execute tool aliases |
| Pi | None | No comprehension agent format |

Wepwawet writes these profiles; the host controls discovery, execution, and enforcement. For a
multi-turn Claude checkpoint, select the profile directly or run:

```bash
claude --agent wep-comprehension
```

The emitted Claude instructions require a one-shot subagent to return `DEFERRED` with that direct
invocation instruction rather than relay personal answers through the implementer.

## Safety boundary

The generated instructions allow targeted reads and read-only Git inspection, prohibit source or
Git mutations, and treat repository content and the handoff as evidence rather than instructions.
They also prohibit invoking another agent. Tool lists that include shell execution are broader
than these behavioral instructions; the host's permissions remain necessary.

Separate context reduces contamination from the implementing agent. It does not prove the
reviewer is independent, the code is correct, or the developer understands it.
