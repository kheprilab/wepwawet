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

Optional `config.json` and `policy.json` files are deep-merged with the installation defaults. Arrays of strings are merged as a union without duplicates; other arrays replace the default array.

Markdown files directly under `wiki/` are installed under `.wep/wiki/<pack-name>/`.

## Target Files

Target files are relative to `target/`. The selected target determines their destination.

| Source | Codex | Claude Code | GitHub Copilot | Pi |
|---|---|---|---|---|
| `root-instructions.md` | `AGENTS.md` | `CLAUDE.md` | `.github/copilot-instructions.md` | `.pi/README.md` |
| `skills/<name>/` | `.agents/skills/<name>/` | `.claude/skills/<name>/` | `.github/skills/<name>/` | `.pi/skills/<name>/` |
| `prompts/<name>.md` | Unsupported | `.claude/commands/<name>.md` | `.github/prompts/<name>.md` | `.pi/prompts/<name>.md` |
| `instructions/<name>.md` | Unsupported | Unsupported | `.github/instructions/<name>.md` | Unsupported |

Each skill directory requires `SKILL.md`; additional files beneath it retain their relative paths. Symbolic links are skipped. Prompt and instruction files are Markdown files directly under their respective directories. Unsupported prompt or instruction formats produce warnings.

Root-level `skills/`, `prompts/`, `instructions/`, `targets/` and `agents/` directories are rejected. Place target content under `target/`.

Bundled packs use the same format under `templates/<pack-name>/`.
