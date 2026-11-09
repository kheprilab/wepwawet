# Installation

Wepwawet is in private preview. Build and link the CLI from an authorized checkout.
The public release is not available from npm yet; an existing package name is not a
usable release of this CLI.

## Requirements

- Node.js 20 or later
- pnpm to build from source
- Git for cloning and for snapshot-based judge reviews
- A supported coding agent: Codex, Claude Code, GitHub Copilot, or Pi

Wepwawet does not provide an agent or model subscription.

## Build and link

```bash
git clone https://github.com/kheprilab/wepwawet.git
cd wepwawet
pnpm install
pnpm build
pnpm link --global
wep --version
wep --help
```

The clone requires access while the repository is private. If pnpm reports that its
global executable directory is missing, run `pnpm setup`, restart your shell, and retry
the link.

You can also run the built CLI without linking:

```bash
node /absolute/path/to/wepwawet/dist/index.js --help
```

## Initialize another project

```bash
cd /path/to/your-project
wep init --target codex --dry-run
wep init --target codex
wep doctor
```

Use `claude`, `copilot`, `pi`, a comma-separated list such as `codex,claude`, or `all`
for the other adapters. With one detected agent setup, `wep init` selects it directly.
With none or several, it prompts in an interactive terminal; headless use requires
`--target` in those cases.

Normal initialization installs every module and enables the judge for supported hosts.
Comprehension, the implementer, and tracing remain disabled. To install just shared
workflow files and task capsules, use `wep init --target codex --modules tasks`.
See [modules and configuration](CONFIGURATION.md#modules).

Existing root instructions receive a suggested merge file. Review that merge before
expecting the agent to follow the harness. Then ask your agent to run the installed
`wep-doctor` workflow to fill in verified project context. The CLI doctor performs file
and configuration checks; it does not inspect your application architecture for you.

## Development

From the Wepwawet checkout:

```bash
pnpm wep --help
pnpm test
pnpm lint
pnpm typecheck
```

The package's `prepare` script builds `dist/` during dependency installation. There is
no `prepack` script; do not assume a source archive is already a built npm package.
For installation options after public release, use the release instructions available
at that time.
