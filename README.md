# artfct

An agent orchestrator. It takes software engineering requests from a chat channel or an issue tracker. A coding agent in a sandbox does each stage of the work over the Agent Client Protocol. The work ends in an artifact a human approves.

## Deploy

To run artfct on your own Cloudflare account, follow the install guide in [`docs/index.md`](docs/index.md). `docs/vendors/` has one setup page per vendor. You do not need to clone this repository. `npx artfct init` scaffolds a deployment repo from `template`.

CI publishes a preview build of both packages from every commit on `main` through [pkg.pr.new](https://pkg.pr.new). To run the latest `main` before a release, install the previews in your deployment repo:

```sh
npm install https://pkg.pr.new/artfct-ai/artfct/@artfct-ai/core@main https://pkg.pr.new/artfct-ai/artfct/artfct@main
```

## Repository

- `packages` holds the engine. `packages/orchestrator` and `packages/ingress` are the two Workers. `packages/sandbox-bridge` is the bridge that runs in each sandbox.
- `packages/core` is the publishable `@artfct-ai/core` package. `packages/cli` is the publishable `artfct` command line.
- `template` is the deployment repo that `artfct init` copies.
- `docs` holds the install guide and the vendor setup pages.
- `spec` holds the domain glossary.

## Develop

You need:

- bun at the version `packageManager` names in `package.json`.
- Node.js 22 or later.
- A harness CLI on your `PATH` for `bun run dev`, such as Claude Code or opencode. The bridge starts it for each sandbox.
- Docker for `bun run local-run`.

```
bun install
cp packages/ingress/.dev.vars.example packages/ingress/.dev.vars
cp packages/orchestrator/.dev.vars.example packages/orchestrator/.dev.vars
bun run db:migrate:local
bun run dev:sandbox          # terminal 1: the mock sandbox host
bun run dev                  # terminal 2: both Workers under wrangler dev
```

Each `.dev.vars.example` lists every setting and secret with a comment. Local wrangler state lives in `.wrangler/state` at the root. `CONTRIBUTING.md` lists the checks a pull request must pass.

- The default skills live in `template/orchestrator/skills/<name>/`. Each must contain a `SKILL.md` file alongside any reference files or scripts. `template/orchestrator/workflows/development.yaml` maps skills to specific stages, reviewers, and polishers.
- `template/orchestrator/writing-rules.md` holds the writing rules. The orchestrator agent and every model-call author read them in their system prompt. Each harness session reads them from its home-level instructions file.
- A deployment repo holds `orchestrator/artfct.yaml` for its deployment-wide settings: `providers`, `access`, `orchestrator`, and `mcp_servers`. Each file under `orchestrator/workflows/` is one workflow definition. Its file name without `.yaml` is its name. It holds a `description` of the kind of work it is for and its `stages`. A deployment holds exactly one workflow definition today. The orchestrator agent reads its name and description above the stage list.
- The config build step compiles a deployment repo's `orchestrator/artfct.yaml`, `orchestrator/workflows/`, `orchestrator/writing-rules.md`, and `orchestrator/skills/` into one value. It skips hidden files and runs no git command. The orchestrator entrypoint passes that value to `registerConfig` before any request, and the config, writing rules, and skills loaders read only what it registered. A deployment repo runs it in `orchestrator/build.js`, which calls `compileConfig` from `@artfct-ai/core/config` and inlines the result into the entrypoint with esbuild. Wrangler runs that build before each orchestrator deploy.
- `bun run --cwd packages/orchestrator template-config` compiles `template/orchestrator` into `packages/orchestrator/test/template-config.json` from source. `dev` and `local-run` register it as it is. The tests and the smoke run register it with their own settings and workflow definition in place of the template's. `dev`, `smoke`, `local-run`, `scripts/test-near`, and turbo run it first.
- `bun install` does not run lifecycle scripts, because the root `bunfig.toml` sets `ignoreScripts`. A pull request can change that file, so install a pull request you do not trust with `bun install --ignore-scripts`.
- All bundled skill files must be UTF-8 text. Binary assets such as images or PDFs fail the deployment build. Bundled scripts lose their executable bit, so invoke them through their interpreter, for example `python scripts/fill_form.py`.
- `scripts/test-near <path>...` runs the tests next to a file or under a directory.
- The medium tests, the smoke run, `bun run dev`, local migrations, and `wrangler types` use `wrangler.test.jsonc` in each Worker app. It names no account resource. The deploy configs are the pair in `template`. A binding added to one goes in both.
- The orchestrator's test Worker entries live in `packages/orchestrator/test/`. `dev-worker.ts` runs real models and starts sandboxes on the mock sandbox host, for `bun run dev`. `worker.ts` adds the scripted model and scripted decisions, for the medium tests. `smoke-worker.ts` adds the scripted harness adapter, for the smoke run. Each entry registers its own deployment.
- `bun run smoke` runs the end-to-end flow against mock events and must print `SMOKE PASSED`. Its `directions` stage has a researcher, a model-call author with one revision, and a choice ending. The mock sandbox host keeps a temporary directory per sandbox that stands for its container. The smoke run starts it with `--scripted-harness`, so each bridge runs the in-process mock harness. The mock Notion host keeps the pages that the model-call author creates and updates.
- `bun run check` runs what CI runs. `bun run fmt` formats.
- To change a schema, edit `packages/orchestrator/src/db/schema.ts` for D1 or `packages/orchestrator/src/workflow/store/schema.ts` for the Workflow DO. Then run `bun run db:generate`. `bun run db:migrate:local` applies the D1 migration locally. The DO applies its own migrations at start.

### Local run

`bun run local-run <stage> <role> [artifact-link] --title "..."` runs one author, reviewer, or polisher of the template's workflow definition in a local Docker container, without a workflow.

- The role is `author` or the name of a reviewer or a polisher of the stage.
- It uses the production skills, prompts, and harness setup with the secrets of `packages/orchestrator/.dev.vars`.
- The run changes the real artifact. `--dry-run` prints the first prompt and stops.
- The author of a stage whose `author.produce` has `execution: model` runs its produce call on its gateway. The call writes the whole page. The skill says how to work through its sections. With `--dry-run` it prints the system message instead, writes the document to `document.md` in the output directory, and creates no page.
- `--repo owner/name --branch name` give a stage its checkout. `--request` and `--brief` give the request text and the brief of the author.
- Each run writes its first prompt, its session updates, and its closing text under `.local-runs/`.
- A Linear page is changed as the owner of `LINEAR_API_KEY`, because the install token of the deployment lives only in its database.

Build the image first:

```
bun run sandbox:build
```

### Packages

- `packages/core` is the `@artfct-ai/core` package. `bun run --cwd packages/core build` bundles the orchestrator, ingress, and the workspace packages they import into `dist`. npm dependencies stay external. It exports `@artfct-ai/core/orchestrator`, `@artfct-ai/core/ingress`, `@artfct-ai/core/durable-objects`, and `@artfct-ai/core/config`, and ships the D1 migrations in `dist/migrations/d1` and the sandbox image's Dockerfile and build context in `dist/sandbox`. When `SANDBOX_IMAGE_DIGEST` is set, the build also writes the published image's reference, with its tag and that digest, to `dist/sandbox/published-image`. Its `dependencies` must equal the npm dependencies of the workspace packages it bundles. The build fails and prints the expected list when they differ.
- `packages/cli` is the `artfct` package with the `artfct` binary. `bun run --cwd packages/cli build` bundles it into `dist`. It resolves `@artfct-ai/core` as a peer dependency, so it checks against the engine version the repo deploys.

The CLI has three commands:

- `artfct init` copies the template that the CLI build packs into `dist/template`. It creates the D1 database with `wrangler d1 create`, which writes its id into `orchestrator/wrangler.jsonc`. It does not install, commit, push, or deploy.
- `artfct connect code` creates the GitHub App in the browser and installs it. It writes the app id, private key, webhook secret, and installation id into the two `.dev.vars` files, and the app slug into the ingress wrangler config. It needs `PUBLIC_URL` in `orchestrator/.dev.vars`. Pass `--org <name>` when an organization owns the repositories.
- `artfct check` is the deploy preflight. It runs `wrangler whoami` to check the Cloudflare credential. It validates `orchestrator/artfct.yaml` and the workflow definitions together with the config loader of `@artfct-ai/core/config`. It fails while an `access` team is still a template placeholder. It compiles every entry under `skills` with the build step's own skill rules. It fails when the orchestrator config names the published sandbox image by anything other than the reference in the installed `@artfct-ai/core`. It stores no token.

The template ships no CI workflow. `docs/deploy.md` lists the deploy commands in order, with a GitHub Actions example to copy.

## MCP servers

Every harness session connects to the MCP server of the provider its stage works on. Add your own MCP servers under `mcp_servers` at the top level of `orchestrator/artfct.yaml`. Every harness session then connects to them too. Model calls and the orchestrator agent do not.

```yaml
mcp_servers:
  - name: datadog
    url: https://mcp.datadoghq.com/api/unstable/mcp-server/mcp
    headers:
      DD-API-KEY: ${DATADOG_API_KEY}
  - name: sentry
    command: npx
    args: ["-y", "@sentry/mcp-server"]
    env:
      SENTRY_ACCESS_TOKEN: ${SENTRY_TOKEN}
```

- Give a remote server a `url` and optional `headers`. It speaks HTTP unless you set `type: sse`.
- Give a command server a `command` with optional `args` and `env`. The harness starts it inside the sandbox.
- Use a unique `name` for each server. A provider's name, such as `linear`, is taken.
- Reference a secret as `${NAME}` in any value. Put the secret in the orchestrator's `.dev.vars` and upload it with the command in that file's header. A server that references an unset secret is skipped, and the task log names the server and the secret.
- Use read-only keys with the least privilege the server needs. The coding agent can read every value its MCP servers receive.

`bun run local-run` connects to the same servers, with the secrets of `.dev.vars`.

The shipped `orchestrator/artfct.yaml` connects every harness session to the Cloudflare API MCP server with `CF_READ_API_TOKEN`. Create that token as an account API token with two permissions: the Workers role Metadata Read-Only at the Workers product scope, and Account Analytics Read. The agent can then read the logs, traces, and metrics of the deployment. It cannot read script source or secrets, and it cannot change anything.

## License

Copyright 2026 Matthew A. Kuritz. The source is licensed under the Apache License, Version 2.0. The text is in `LICENSE`, and `NOTICE` holds the attribution that copies must keep. `NOTICES.md` lists each direct open source dependency of the orchestrator and ingress Workers, with its license text. Update it when a direct dependency of either Worker changes.
