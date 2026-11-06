# Quickstart

Get wep running in a project in under five minutes.

## 1. Install

wep is not on npm yet. Build and link it from source:

```bash
git clone <repo-url>
cd wep
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

wep detects your existing agent setup (Codex, Claude Code, Copilot, Pi) and asks you to confirm. If nothing is detected, it asks which agent you use.

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

The agent reads the installed harness, audits the setup, and populates `.wep/wiki/` with project context. This is the step that turns a skeleton into a working harness.

You can also run the CLI doctor to get a readiness score and suggested next prompt:

```bash
wep doctor
```

## 4. Create your first task

Ask your agent directly — no CLI needed:

```
Fix the login bug where the session expires too early.
```

The agent reads `AGENTS.md` (or equivalent), creates a task capsule in `.wep/tasks/`, chooses the right workflow (TDD for bugs), and implements.

Or create a skeleton capsule via CLI (useful for CI or scripting):

```bash
wep task "Fix login session expiry bug"
```

## 5. Check status

```bash
wep status
```

Shows installed targets, task count, and current workflow default.

## Optional: enable the judge

The judge is an independent subagent that reviews implementation against the task capsule. It is disabled by default.

```bash
wep judge enable
```

See [JUDGE.md](JUDGE.md) for the full flow.

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
