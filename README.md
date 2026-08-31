# Hive

**An AI agent orchestrator you can watch.** You describe what you want; it
runs the Claude Code CLI already installed in your terminal as several agents
working the same repository at once, each in its own isolated copy. The whole
run plays out in an isometric 3D office, where you can see who is doing what,
who got stuck, and what each one has cost you.

[Português](./README.pt-BR.md) · [Architecture](./CLAUDE.md) · [Contributing](./CONTRIBUTING.md)

![The office during a run](./assets/demo.gif)

> [!IMPORTANT]
> **This runs on Linux today.** That is where it was built and the only place it
> has been tested. The code is not hostile to other platforms — dependency
> replication already falls back to a full install when hardlinking is
> unavailable — but nobody has run it elsewhere. If you have a Mac or a Windows
> box and twenty minutes, [open an issue telling us what happened](../../issues/new).
> It is the single most useful contribution right now.

## What it is, and who it is for

The target user does not read code. They describe a task in plain language, the
system coordinates agents until delivery, and it **stops and asks in plain
language** when it gets stuck. Escalation is the main experience, not an error
path.

That is why the 3D is not decoration. A progress bar cannot tell you where
things got stuck. A character sitting still at a desk with a question floating
over their head can.

## The bet: quality, performance and cost at once

**Quality — no agent approves its own work.** Every subtask passes through a
real command from your project (`typecheck`, `build`, `test`, `lint`), run from
the outside, in that agent's copy, with the exit code as the only criterion.
"I'm done" without a green gate is not an accepted delivery. There is a second
gate after integration, on the already-merged repository, for the case nobody
predicts: two steps that pass alone and fail together, because each copy
started from the same point and never saw the other's work.

**Cost — measured, with the bill open.** The first version was **57% more
expensive than running the CLI by hand**, just to plan, before touching
anything. The breakdown said why: 74% of the cost was the manager *deciding*
what to do. The agent doing the work cost $0.084 against the $0.19 the CLI
charged for the same change. Execution was already cheap; coordination was the
expensive part.

| path | cost | time | vs. CLI |
| --- | ---: | ---: | --- |
| `claude -p` directly | $0.1921 | 9.2 s | — |
| **Hive, manual queue, economy tier** | **$0.0599** | 33.9 s | **3.2x cheaper** |
| Hive, planned, manager on sonnet | $0.1637 | 44.9 s | 1.2x cheaper |
| Hive, planned, manager on opus | $0.3337 | 78.0 s | 1.7x more expensive |

Every row delivered the same change. Only the Hive rows ran automated
verification before integrating. Full method and raw numbers:
[`tools/planner-lab/BASELINE.md`](./tools/planner-lab/BASELINE.md).

**Performance — instrument in place, number still open.** Two specialists run at
once when the plan proves their areas do not overlap — and only then, because
parallelising over the same folder is a predictable conflict, not bad luck.
System overhead has already dropped hard: preparing an agent's copy went from
16s to **0.12s**, replicating 600 MB of dependencies by hardlink instead of
reinstalling, and a full gate runs in 0.95s on a warm cache.

What does not exist yet is the end-to-end measurement of a real parallel run.
`plan.measured` computes it — the sum of what each step occupied against
wall-clock time — and fires on every executed plan, **including runs that stop
halfway**, because a measurement is only worth something if it also exists on
the day things went wrong. No two-front run has been recorded in the baseline
yet. [That's an open issue](../../issues), and a good one.

## Requirements

- **Linux** (see the note above)
- **Node.js 20+** and **pnpm**
- **[Claude Code](https://claude.com/claude-code) CLI, installed and
  authenticated.** The orchestrator runs it as a child process — there is no
  agent runtime of its own and no direct model API calls. Check with
  `claude --version`. It is the only CLI supported today — `AgentAdapter` is the
  extension point if you want to add another.
Running agents costs money on your own account, at your provider's rates. The
table above is what a one-line change cost here.

## Running it

```sh
pnpm install
pnpm app
```

Pick a project folder, write a task, and the run goes through the whole flow:
plan, approval, contract, work in parallel, verification, and a question that
stops everything until you answer.

To see the flow **without spending a single model call**, drive the same
database from the simulator with the app open on that folder:

```sh
pnpm --filter @hive/simulator start -- \
  --db ~/.config/hive/hive.sqlite \
  --project /path/to/project
```

### Linux note

Electron 44 has no `postinstall` of its own; the binary is downloaded by
`apps/shell`'s `install-electron` script. On distros that restrict user
namespaces, `chrome-sandbox` must be `root:root` with mode 4755:

```sh
sudo chown root:root node_modules/.pnpm/electron@*/node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/.pnpm/electron@*/node_modules/electron/dist/chrome-sandbox
```

Without it the app aborts at startup. `pnpm app:nosandbox` works around it for
development — it disables the Chromium sandbox, so it is for your own machine,
not the default path.

## Security — read this before pointing it at real work

This app spawns agent CLIs as child processes on your machine, and they edit
files. The permission policy ([`packages/agents/src/permission.ts`](./packages/agents/src/permission.ts),
one policy for every CLI) draws the line like this:

- **Allowed without asking:** reading, searching, and writing files **inside the
  project folder you selected**. Stopping on every file would make the product
  unusable.
- **Escalated to you as a question:** anything outside that folder, running
  shell commands, and network access. The CLI suspends the agent and waits for
  your answer — that is where the `blocked` state comes from.
- **Planning is read-only.** The manager runs with write access denied even
  inside the project, because planning is looking.

Agents never work in your repository directly. Each one gets a git worktree
under `<userData>/worktrees/<runId>/<agentId>`, **outside** your repo, and the
supervisor — not the agent — is what commits and merges. Conflicts are never
resolved silently: the system stops, reports, and asks.

None of that makes it safe to point at a repository you cannot afford to have
edited. Use a project with a clean git state and a remote you can reset to.

## Architecture

[`CLAUDE.md`](./CLAUDE.md) is the real design document: package boundaries,
why each rule exists, and the discoveries the code depends on. Short version:

```
packages/protocol      depends on nothing. Everything else depends on it.
packages/store         protocol                 -- the only package touching SQLite
packages/agents        protocol                 -- one AgentAdapter per CLI
packages/coordination  protocol, agents         -- never apps/*
apps/shell             protocol, store, agents, coordination, simulator
apps/hub               protocol                 -- and only that
tools/simulator        protocol, store
tools/planner-lab      protocol, agents, coordination
```

Every event goes to SQLite append-only with a sequence number, and the 3D world
replays an entire run from the log without running an agent.

## Commands

```sh
pnpm build          # all packages
pnpm typecheck
pnpm test
pnpm dev            # vite + electron with reload
pnpm app            # build and open the app
pnpm app:nosandbox  # same, without the Chromium sandbox (see the Linux note)
pnpm plan-lab -- --task all --project .   # the manager only, executing nothing
```

`plan-lab` is the cheapest feedback loop in the repository: it runs only the
manager over ten sample tasks and prints cost per task and per round, so tuning
the planning prompt costs ten plans instead of ten real executions.

## What does not exist yet

Stated plainly, because it is where the work is:

- **Other platforms.** macOS is probably close — BSD `cp` accepts `-a` and `-l`,
  so hardlink replication may already work — but nobody has run it. Windows
  needs a real process-group kill (`taskkill /T` or a job object) so a timed-out
  gate does not leave compilers running.
- **Real pathfinding in the 3D world.** Paths are still a two-leg L. New
  furniture in the middle of the room needs a hand-written route.
- **Automatic replanning** after a failed subtask. `Planner.revise` exists and
  nothing calls it.
- **A project brief injected into each subtask** — the largest remaining token
  cut, and item 1 of the cost roadmap in the baseline.
- **Escalating the model when a gate fails**, instead of retrying the same tier.
- **More than two agents at once**, if `plan.measured` shows the merge is not
  the bottleneck first.
- Authentication, and packaging for distribution.

## Contributing

Yes, please — including "I cloned it, ran it, and here is where it broke."
[`CONTRIBUTING.md`](./CONTRIBUTING.md) sorts the open work by how much context
it needs, starting with tasks that need almost none.

## License

[MIT](./LICENSE) © Andre Schons
