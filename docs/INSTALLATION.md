# Installation

## Requirements

- Node.js 20 or later, with npm
- Git for snapshot-based judge reviews
- A supported coding agent: Codex, Claude Code, GitHub Copilot, or Pi

Wepwawet does not provide an agent or model subscription. pnpm is only required when
building Wepwawet from source.

## Install with npm

```bash
npm install -g wepwawet
wep --version
wep --help
```

The package is named `wepwawet`; the installed command is `wep`. Run that command in
the project where you want the harness, rather than in the package's installation directory.

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

## Update the CLI and harness

```bash
npm install -g wepwawet@latest
cd /path/to/your-project
wep upgrade --dry-run
wep upgrade
wep doctor
```

Updating the global CLI does not update files already installed in your projects.
Run `wep upgrade` in each project and review any merge candidates it creates. See
[the upgrade command](COMMANDS_AND_UX.md#wep-upgrade).

## Build from source

For development or a local build, use Git and pnpm:

```bash
git clone https://github.com/kheprilab/wepwawet.git
cd wepwawet
pnpm install
pnpm build
pnpm link --global
wep --version
wep --help
```

If pnpm reports that its global executable directory is missing, run `pnpm setup`,
restart your shell, and retry the link. You can also run the built CLI without linking:

```bash
node /absolute/path/to/wepwawet/dist/index.js --help
```

## Development

From the Wepwawet checkout:

```bash
pnpm wep --help
pnpm test
pnpm lint
pnpm typecheck
```

The package's `prepare` script builds `dist/` during dependency installation. There is
no `prepack` script; build before packaging a source checkout.
