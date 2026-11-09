# Quickstart

Install the harness, prepare project context, and give your agent its first task.

## 1. Install

The public release is not available from npm yet. With repository access, build and link from source:

```bash
git clone https://github.com/kheprilab/wepwawet.git
cd wepwawet
pnpm install
pnpm build
pnpm link --global
```

Verify:

```bash
wep --version
wep --help
```

## 2. Init in your project

Go to any repository where you use a coding agent and run:

```bash
cd /path/to/your-project
wep init
```

wep detects existing agent setup (Codex, Claude Code, Copilot, Pi). One detected target is selected directly. With none or several, it asks which target to install in an interactive terminal; pass `--target` for headless use.

To skip the prompt:

```bash
wep init --target codex      # OpenAI Codex
wep init --target claude     # Claude Code
wep init --target copilot    # GitHub Copilot
wep init --target pi         # Pi
wep init --target all        # all at once
```

Preview what would be created without writing anything:

```bash
wep init --target codex --dry-run
```

## 3. Open your agent and run doctor

After init, open your coding agent in the project and ask:

```
Run wep doctor.
```

Ask it to use the installed `wep-doctor` workflow. The agent inspects relevant project files and records verified architecture, conventions, testing commands, and decisions in `.wep/wiki/`. If init wrote a root-instruction suggestion, review and merge it first.

You can also run the CLI doctor to get a readiness score and suggested next prompt:

```bash
wep doctor
```

## 4. Create your first task

Ask your agent directly — no CLI needed:

```
Fix the login bug where the session expires too early.
```

The harness instructs the agent to read `AGENTS.md` (or its target equivalent), clarify material ambiguity, create a task capsule in `.wep/tasks/`, select a workflow, and implement. The built-in bug-fix recommendation is TDD; a concrete project default or explicit request can change it.

Or create a skeleton capsule via CLI (useful for CI or scripting):

```bash
wep task "Fix login session expiry bug"
```

## 5. Check status

```bash
wep status
```

Shows installed targets, task count, and current workflow default.

## Independent review

Normal init enables the judge for Codex, Claude Code, and Copilot. After you approve the initial task brief, the installed workflow invokes it automatically after implementation. The brief covers the selected workflow, acceptance criteria, and exact validation commands. If your installation disabled it or omitted its module, enable it with:

```bash
wep judge enable
```

Use `wep judge status` to inspect the resolved state or `wep judge disable` to turn it off. Comprehension, the implementer, and tracing are separate opt-ins. See [JUDGE.md](JUDGE.md) for snapshot capture, command approval, validation receipts, and verified review records.

## Reference

| Goal | Command |
|---|---|
| Install harness | `wep init` |
| Audit setup | `wep doctor` |
| Check status | `wep status` |
| Create task capsule | `wep task "<description>"` |
| Compile agent brief | `wep compile TASK-001` |
| Show config | `wep config show` |
| Change workflow default | `wep config set defaultWorkflow SDD+TDD` |
| Enable judge | `wep judge enable` |
| Update harness to latest | `wep upgrade` |
| Remove harness | `wep remove --target codex --force` |

See the [command guide](COMMANDS_AND_UX.md) for modules, command approval, task search, templates, tracing, continuation, migration, and removal options.
