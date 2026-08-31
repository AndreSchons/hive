# Contributing

This project has exactly one user and has run on exactly one machine. That is
the main thing worth knowing before you start: almost anything you try will be
the first time someone other than the author tried it, and saying what happened
is a real contribution.

The codebase, comments and design docs are in **Portuguese**. Issues and pull
requests in either Portuguese or English are equally welcome.

## Read this first

[`CLAUDE.md`](./CLAUDE.md) is the design document, and it is unusually complete:
it records not just what the rules are but *why*, and which of them were paid
for with a bug. Skim it before opening a PR. The boundary rules in particular
are enforced on purpose and a PR that crosses one will be sent back:

- `packages/protocol` imports nothing from the workspace. It is the system boundary.
- `apps/hub` imports **only** `@office/protocol` — no SQLite, no Electron, no
  subprocess. If the UI needs new data, it enters the protocol as an event or a
  command, never as a sideways import.
- `packages/coordination` imports nothing from `apps/`.
- `apps/hub/src/world/` (the 3D) knows nothing about agents, CLIs or models. If a
  3D component needs to know which CLI ran, the design is wrong.
- Only `packages/store` touches SQLite, and nothing writes to `events` outside
  `EventStore` — database triggers refuse `UPDATE` and `DELETE` on that table.

Types are **generated from Zod schemas**, never hand-written alongside them.
`strict` is on with extras; no `any`, and no `as` to silence an error.

## Where to start

Sorted by how much context you need, not by importance.

### Needs almost no context

**Run it and report what broke.** Especially on macOS or Windows, but another
Linux distro counts too. This is the highest-value thing available right now.

**Pathfinding in the 3D office.** Paths are currently a two-leg L, and the only
detour that exists is leaving a cubicle through the aisle (`aisleRoute`). New
furniture in the middle of the room needs a hand-written route. It is
self-contained, it is visual, and by the boundary rules above it requires
understanding nothing about agents, CLIs or models — the 3D world consumes
state derived from events and maps it to animation.

### Needs some context

**An adapter for another agent CLI.** Hive supports Claude Code only today, by
choice — but `AgentAdapter` is the extension point and `createAdapterRegistry`
takes as many adapters as exist. A second one plugs in there without touching
`coordination` or `apps/hub`. Candidates: Codex, Gemini CLI, Aider; the right
person is someone who uses one of them daily.

Read `packages/agents/src/claude/` first — its header comments record what the
stream actually does versus what the docs claim, which is most of the work. A
second adapter did live here once (Kimi, over Agent Client Protocol); it was
removed to keep one surface, and it is in the git history if you want a
reference for how a non-Claude CLI fits.

**Close the parallelism measurement.** Run a task with two independent fronts and
record `plan.measured` in [`tools/planner-lab/BASELINE.md`](./tools/planner-lab/BASELINE.md).
The instrument is built; the round is missing. This is the one leg of the
quality/performance/cost argument without a number behind it.

### Systems work

**Windows: process groups and hardlinks.** `gate-runner.ts` kills the process
group (`process.kill(-pid)` with `detached`) because `pnpm build` becomes turbo,
which becomes one `tsc` per package — killing only the shell would leave
compilers running on the user's machine. Windows has no equivalent group;
it needs `taskkill /T` or a job object. Separately, `worktree-prep.ts` detects
Windows and falls back to a full install instead of `cp -al`, so Windows works
but pays the install cost on every copy.

**macOS.** Probably closer than it looks: BSD `cp` accepts `-a` and `-l`, so
hardlink replication may already work unchanged. Someone with a Mac can find out
in twenty minutes.

### Coordination and cost

**A project brief injected into each subtask.** The largest remaining token cut,
and item 1 of the roadmap in the baseline: nearly all input is cache, and the
cache dies with the session, so every fresh subtask re-explores the same
repository. A structure-and-conventions summary produced once by the manager and
passed through a new `AgentRunRequest.context` avoids that. It carries its own
risk — a wrong brief contaminates every subtask at once — which is what makes it
interesting.

**Escalate the model when a gate fails**, instead of retrying the same tier.
Fits directly into `EscalationDecision.retry`.

**Automatic replanning after a failed subtask.** `Planner.revise` exists and
nothing calls it.

## Working on it

```sh
pnpm install
pnpm build && pnpm typecheck && pnpm test
pnpm dev            # vite + electron with reload
```

You do **not** need an agent CLI installed to work on most of this. The
simulator replays a full scripted run — plan, contract, parallel work, a
question that blocks everything, delivery — straight into the same database,
without spending a model call:

```sh
pnpm --filter @office/simulator start -- \
  --db ~/.config/hive/hive.sqlite \
  --project /path/to/project
```

That is the right loop for anything in `apps/hub`, including all the 3D work.

For changes to how the manager plans, use the harness instead of running real
executions:

```sh
pnpm plan-lab -- --task all --project .
```

It runs only the manager over ten sample tasks and prints cost per task. Tasks
with a binary outcome declare `expectStatus`, and the process exits non-zero if
one regresses — in particular, pushing the manager to plan more has broken its
ability to *refuse* before, so that check is not optional.

## Pull requests

- One change per PR, with the reasoning in the description. This repository
  documents *why* heavily; a PR that explains its own tradeoff fits right in.
- `pnpm build && pnpm typecheck && pnpm test` green before you open it.
- New behaviour comes with a test. The NDJSON fixtures in `packages/agents/test/`
  are recorded from the real CLIs — that is what the parsers are tested against,
  so add a recording rather than a hand-written approximation.
- Never make a check pass by deleting or disabling the check. The whole system
  is built on gates meaning something.
- Commit messages and comments in Portuguese or English, your call.

## Reporting a problem

Include your OS and distro, `node --version`, `pnpm --version`, and
`claude --version` if the failure involves a real run. If the app fails to start
on Linux, try `pnpm app:nosandbox` first and say whether that changed anything —
that one detail separates a sandbox problem from everything else.

For anything security-related, open a normal issue: the project has no users to
put at risk yet, and a public discussion is more useful than a private one.
