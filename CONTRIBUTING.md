# Contributing

## Set up

You need:

- bun at the version `packageManager` names in `package.json`.
- Node.js 22 or later.
- A harness CLI on your `PATH` for `bun run dev`, such as Claude Code or opencode. The bridge starts it for each sandbox.
- Docker for `bun run local-run`.

```sh
bun install
cp packages/ingress/.dev.vars.example packages/ingress/.dev.vars
cp packages/orchestrator/.dev.vars.example packages/orchestrator/.dev.vars
bun run db:migrate:local
bun run dev:sandbox          # terminal 1: the mock sandbox host
bun run dev                  # terminal 2: both Workers under wrangler dev
```

## Before you open a pull request

CI does not run on a pull request from a fork until a maintainer approves it. Test the change fully on your machine first. Run these from the repository root. Each must pass with zero errors and zero warnings.

```sh
bun run check   # the tests, the lint, the build, and the format check that CI runs
bun run smoke   # must print SMOKE PASSED
```

While you work, `scripts/test-near <file-or-dir>...` runs the tests next to a file in seconds, and `bun run fmt` formats. To run one stage of a workflow in a local container, see [Local run](docs/local-run.md).

## Pull requests

1. Fork the repository and create a branch in your fork.
2. Keep each pull request to one change. Add or update the tests that cover it.
3. Open the pull request against `main`. State the reason for each part of the change in the description.

## Security

See `SECURITY.md`
