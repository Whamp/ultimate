This is Ultimate's own repository, and this setup is the one it is built with: Ultimate plans, delegates, checks its
work, and changes its own code while you talk to it.

## What it turns on

- `plan`: a durable ledger of epics and tasks, so long work survives restarts.
- `subagents`: hands bounded work to workers, each in its own git worktree.
- `tasks`: the live task graph in the right panel: what runs, and for whom.
- `self`: knowledge of its own code, and `restart` to swap in a core change.
- `instance`: a second Ultimate on a working tree, to try a change before it goes live.
- `surfaces`: tells the agent which screen you are looking at.
- `documents`: the Documents tab, where extension state such as the plan shows.
- `info`: machine, process, code, and extensions in the right panel.
- `exclusive-commands`: one `pnpm test` at a time across conversations.
- `automations`: prompts that run on a schedule; every run is a conversation you can open.
- `clock`: the time in the status line.

## How to work with it

Talk to it. For bigger work it writes a plan, starts workers in worktrees, checks their commits, and lands them on
your branch. Apps are surfaces beside the conversation: switch with the ULTIMATE menu or ⌘K (Ctrl+K). Edits to
`extensions/` and `web/` hot-reload in front of you.

## How it runs

`pnpm start` runs a small supervisor that owns the port, with the core as its child. A change to `server/` or
`shared/` goes live through `restart`: a new core type-checks and boots beside the old one and takes over, or the old
one keeps serving. Conversations, tool calls, and subagents reach SQLite before they show, so a restart or a crash
resumes the run where it was.

## Workspace setup and checks

`.ultimate/settings.json` installs workspace dependencies and runs lander checks through
`npm exec --yes --package=pnpm@11.8.0 -- pnpm`. The version matches `package.json`'s `packageManager`.
This avoids the machine's plain `pnpm` shim, which can fail in the server environment. It does not install or
change global tools. Keep both version pins in sync when updating pnpm.

New workspaces run `install --frozen-lockfile --prefer-offline`. The lander runs `check` first, then `test`,
`test:e2e`, and `eval` in parallel. The npm launcher needs network access if its pinned pnpm package is not cached;
`--prefer-offline` applies to dependency installation, not to the launcher.

## Read more

`README.md` to start, `AGENTS.md` for the reload layers and the rules, `extensions/README.md` to write extensions.
