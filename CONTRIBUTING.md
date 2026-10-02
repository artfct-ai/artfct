# Contributing

## Set up

You need bun at the version the root `package.json` names under `packageManager`, and Node.js 22 or later.

```sh
bun install
cp packages/ingress/.dev.vars.example packages/ingress/.dev.vars
cp packages/orchestrator/.dev.vars.example packages/orchestrator/.dev.vars
```

The README describes the local dev loop and the layout of the repository. `CLAUDE.md` holds the rules for code in this repository. Read both before you change code.

## Before you open a pull request

Run these from the repository root. Each must pass with zero errors and zero warnings.

```sh
scripts/test-near <file-or-dir>...   # the tests next to each file you changed
bun run lint
bun run fmt
bun run smoke                        # must print SMOKE PASSED
```

CI runs the full test suite, the build, and the format check on every pull request.

## Pull requests

1. Fork the repository and create a branch in your fork.
2. Keep each pull request to one change. Add or update the tests that cover it.
3. Open the pull request against `main`. State the reason for each part of the change in the description.

## Security

See `SECURITY.md`
