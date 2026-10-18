This is Ultimate's own repository, and this setup is the one it is built with: Ultimate plans, delegates, checks its
work, and changes its own code while you talk to it.

## What it adds

Every built-in is already on; this setup adds how the repository is landed and reviewed:

- `settings.json`: each worktree isolate installs its dependencies, and the lander runs `pnpm check`, then
  `pnpm test`, `pnpm test:e2e` and `pnpm eval` in parallel, and pushes to `origin`.
- `agents/lander.md`: the lander fixes a submission that fails to land, then lands it once every check passes again.
- `agents/reviewer.md`: the review lead starts every `reviewer-*` definition (`reviewer-astra`, `reviewer-sol`) in
  parallel and returns one merged verdict.

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

These project settings apply only when the user has chosen this project's setup. Then new workspaces run
`install --frozen-lockfile --prefer-offline`, and the lander runs `check` first, then `test`, `test:e2e`, and `eval`
in parallel before pushing to `origin` (`Whamp/ultimate`). Otherwise, the coordinator must run all four suites on
the final candidate and make a normal push after verification if the lander did not push. Never change the user's
trust selection to activate these settings. The npm launcher needs network access if its pinned pnpm package is
not cached; `--prefer-offline` applies to dependency installation, not to the launcher.

For fork remotes, independent and dependent PRs, and requested upstream contributions, see
[the fork and PR workflow](../AGENTS.md#fork-and-pr-workflow). Workflow instructions do not grant standing GitHub
issue or PR mutation permission.

## Read more

`README.md` to start, `AGENTS.md` for the reload layers and the rules, `extensions/README.md` to write extensions.
