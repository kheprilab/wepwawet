# Template Pack Format

A template pack contains a manifest and optional configuration, policy, wiki pages and target files.

## Directory Layout

```text
example-pack/
  wep-pack.json
  config.json
  policy.json
  wiki/
    testing.md
  target/
    root-instructions.md
    skills/
      example-review/
        SKILL.md
    prompts/
      example-review.md
    instructions/
      example.instructions.md
    agents/
      example-reviewer.md
```

Only `wep-pack.json` is required. Its v1 shape is:

```json
{
  "name": "example-pack",
  "version": "1.0.0",
  "wepPackVersion": 1
}
```

`name` and `version` must be non-empty strings. The name may contain letters, numbers, dots, underscores and hyphens. `wepPackVersion` must be the number `1`.

## Configuration and Wiki Files

Optional `config.json` and `policy.json` files are deep-merged. For a new initialization the
base is the installation defaults; `templates apply` and `templates update` use the current
project values (or the default policy if no policy exists). Arrays of strings are merged as a
union without duplicates; other arrays replace the base array. Scalar values replace the base
value. Non-object top-level overrides are ignored.

Pack configuration applies only when the `tasks` module is installed. Pack policy applies only
when the `judge` module is installed. Otherwise the CLI warns and ignores that file. Template
application preserves the installed target list, installed version, module list and ownership
metadata. Applying a pack does not install a missing module. Re-running `init` with an existing
config preserves that config rather than reapplying pack configuration defaults.

Markdown files directly under `wiki/` are installed under `.wep/wiki/<pack-name>/`.

## Target Files

Target files are relative to `target/`. The selected target determines their destination.

| Source | Codex | Claude Code | GitHub Copilot | Pi |
|---|---|---|---|---|
| `root-instructions.md` | `AGENTS.md` | `CLAUDE.md` | `.github/copilot-instructions.md` | `.pi/README.md` |
| `skills/<name>/` | `.agents/skills/<name>/` | `.claude/skills/<name>/` | `.github/skills/<name>/` | `.pi/skills/<name>/` |
| `prompts/<name>.md` | Unsupported | `.claude/commands/<name>.md` | `.github/prompts/<name>.md` | `.pi/prompts/<name>.md` |
| `instructions/<name>.md` | Unsupported | Unsupported | `.github/instructions/<name>.md` | Unsupported |
| `agents/<name>.md` | `.codex/agents/<name>.toml` | `.claude/agents/<name>.md` | `.github/agents/<name>.agent.md` | Unsupported |

Each skill directory requires `SKILL.md`; additional files beneath it retain their relative paths. Symbolic-link entries inside skill directories are skipped. Prompt, instruction and agent files
are Markdown files directly under their respective directories; nested files are not loaded.
Unsupported target formats produce warnings. The loader is not a general security validator
for untrusted directories; review a local pack before reading or applying it.

Root-level `skills/`, `prompts/`, `instructions/`, `targets/` and `agents/` directories are rejected. Place target content under `target/`.

Bundled packs use the same format under `templates/<pack-name>/`.


## Applying a pack

```bash
wep templates list
wep init --target codex --template test-template --dry-run
wep init --target codex --template-pack ./team-pack --dry-run

# In an initialized project:
wep templates apply ./team-pack --local --dry-run
wep templates apply ./team-pack --local
wep templates status
wep templates update ./team-pack --local
```

`test-template` is a bundled example, not a recommended team policy. `templates list` lists
bundled packs only; there is no remote registry or download command. Omit `--local` to resolve
an apply/update argument as a bundled name. A version is a label in the manifest, not a version
range or dependency constraint.

`init` accepts a pack only with a single target. `templates apply` defaults to all installed
targets and accepts `--target codex`, a comma-separated installed subset, or `all`. `templates
update` defaults to the targets previously recorded for that pack that are still installed.
Both require a valid `.wep/manifest.json`; run `wep upgrade` if it is missing. `--json` returns the
write plan, conflicts, pending instruction merges and warnings. `--force` is rejected by
`templates apply` and `templates update`.

For only pack-managed files, start with `wep init --target codex --modules templates`, then
apply the pack. Without a pack this minimal install creates just config and manifest files;
it does not install the task workflow, wiki or policy. See [Configuration](CONFIGURATION.md).

## Existing files and updates

`templates apply` preflights target and wiki files. Identical content is preserved; differing
project content is preserved and a candidate is placed under
`.wep/template-candidates/<pack-name>/<version>/<destination>`. Blocking conflicts return exit
code 1 and prevent the remaining pack files, config and manifest from being applied. Candidate
files can still be written so you can compare them. Resolve the conflicts and rerun the same
command. A candidate that already exists is preserved, so inspect it if a pack changes without
a version change.

Root instructions use the normal `.wep.suggested.md` workflow. A pending root merge alone does
not block the rest of the pack; a different existing suggestion creates a blocking candidate
instead. A second pack cannot claim another pack's target or wiki destination, even when the
bytes would match.

`templates update` replaces a previously recorded target/wiki file only if its bytes still
match the recorded hash, or if it already equals the new content. It creates missing files,
preserves user-modified files, and writes candidates for those conflicts. Updates can therefore
partially apply before returning exit code 1; inspect the result. Files removed from a newer
pack are not automatically deleted. Root instructions are always preserved and suggested.
Config and policy are merged during updates even if target-file conflicts remain.

`templates status` reports recorded packs and target/wiki files whose current bytes differ
from their recorded hashes or are missing. It does not audit pack quality or root instructions.
There is no pack-specific uninstall command. Review and remove pack files and config changes
manually when retiring one. General harness removal is covered in [Reference](REFERENCE.md).

## Custom agents

A source agent is a Markdown file under `target/agents/`. Optional simple, single-line
frontmatter fields are `name`, `description`, `tools` and `model`; the remaining body supplies
the instructions. This is a small parser, not a general YAML frontmatter engine. Without a
description, the first non-heading prose line is used, falling back to the agent name.

Claude output uses the source `tools` value, or defaults to
`Read, Glob, Grep, Edit, Write, Bash`. Copilot output is user-invocable with
`read`, `search`, `edit` and `execute` tools; it does not copy the source tools list. Codex output
stores the body as `developer_instructions` in TOML, replacing backticks with single quotes.
All three carry the optional model value. Pi has no custom-agent format and receives a warning.
These files define host agents; applying a pack never launches one, and custom agents do not
acquire the built-in judge, comprehension or implementer verification contracts automatically.

## Trust

Packs contain agent instructions and can change workflow and policy settings. Read their
contents before applying them. Warnings about weakened policy do not reject every unsafe
configuration or prove a pack is safe. Run `wep doctor --ci` after application and inspect the
actual diff. Pack installation does not execute the instructions or contact a model provider,
but the coding agent may later act on installed prompts, skills and agents.
