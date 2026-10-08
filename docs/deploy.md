# Deploy

A deploy runs the same commands in any CI system or on a laptop. Run them from the root of the deployment repo in this order. They are written for npm. With another package manager, use its own install, run, and exec commands.

```sh
npm ci
npx artfct check
npx wrangler d1 migrations apply DB --remote -c orchestrator/wrangler.jsonc
npx wrangler deploy -c orchestrator/wrangler.jsonc
npx wrangler deploy -c ingress/wrangler.jsonc
```

1. `npm ci` installs `@artfct-ai/core`, its command line, wrangler, and esbuild at the versions `package-lock.json` pins. It fails when the lockfile is missing, so commit that file.
2. `npx artfct check` is the preflight. It checks that wrangler holds a working Cloudflare credential, that `orchestrator/artfct.yaml` and the workflow definitions under `orchestrator/workflows/` pass the config schema of the installed `@artfct-ai/core`, that each `access` team is set or deleted, that every skill passes the rules of the config build step, and that a published sandbox image is the one the installed `@artfct-ai/core` pins by digest. It prints one line per check and exits 1 when any check fails, which stops the deploy before it changes anything. It also warns when the orchestrator's `.dev.vars` leaves the document host's token empty, and names each stage that writes a page, because the orchestrator refuses to start those stages without it. A warning does not fail the check. The check reads that one token only to see whether it is empty, and it reads no other token. Run it on its own at any time. `npx artfct check --offline` skips the Cloudflare credential, so a pull request job can run the other checks as tests without the Cloudflare secrets.
3. The migrations command applies the D1 migrations that ship in `@artfct-ai/core`. Run it before the orchestrator deploy so the new Worker never reads an old schema.
4. The two deploy commands upload both Workers. The orchestrator deploy first runs `npm run build`, which compiles `orchestrator/artfct.yaml`, `orchestrator/workflows/`, `orchestrator/writing-rules.md`, and `orchestrator/skills/` and inlines them into the Worker entrypoint with esbuild. It also applies its Durable Object class migrations. It builds the sandbox image from the Dockerfile in `@artfct-ai/core` and pushes it to the account's container registry, so Docker must be running. To skip the build, use the published sandbox image.

Each deploy needs two environment variables:

- `CLOUDFLARE_API_TOKEN` is an API token that can edit Workers, D1, and Containers on the account.
- `CLOUDFLARE_ACCOUNT_ID` is the account id.

Upload the Worker secrets once and again when they change. The header of each `.dev.vars.example` file gives the command. A deploy does not upload them.

## Use the published sandbox image

CI publishes the sandbox image on Docker Hub with each build of `@artfct-ai/core`, so you can deploy without Docker. The installed `@artfct-ai/core` names that image by tag and digest in `node_modules/@artfct-ai/core/dist/sandbox/published-image`. The reference has the form `docker.io/artfct/sandbox:<version>-<commit>@sha256:<digest>`, where `<commit>` is the short hash of the commit the build came from. In `orchestrator/wrangler.jsonc`, set the `image` of both containers to that reference. Copy it again each time you upgrade `@artfct-ai/core`.

To add tools to the sandbox, write your own Dockerfile that starts `FROM` that reference, and set the `image` of both containers to its path. The image runs as the `node` user, so switch to `root` to install a package and back to `node` after.

`npx artfct check` fails on any other reference to the published image. That includes the tag without the digest, because a tag can be moved to another image and a digest cannot.

Cloudflare does not cache images it pulls from Docker Hub, so Docker Hub's pull limits apply to each new sandbox.

## GitHub Actions

The Cloudflare token can change everything the deployment runs on, so keep it behind a GitHub environment that only `main` can use.

1. Open the repository's Settings, then Environments, and create an environment named `production`.
2. Under Deployment branches and tags, choose Selected branches and tags and add `main`. A workflow run from any other branch then cannot read the environment's secrets.
3. Store both values as secrets of that environment. Paste each value at the prompt.

   ```sh
   gh secret set CLOUDFLARE_API_TOKEN --env production
   gh secret set CLOUDFLARE_ACCOUNT_ID --env production
   ```

4. Protect `main` with a ruleset that requires a pull request. A change to the workflow or the configuration then gets a review before it can reach the token.
5. Keep the deployment repo out of the GitHub App's installation. The coding agents hold a token of that app, and the app does not need this repository.

Environments in a private repository need a paid GitHub plan. Without one, store both values as repository secrets and delete the `environment` line.

Copy this file to `.github/workflows/deploy.yml`. Only the steps that call Cloudflare receive the token. The install does not.

```yaml
name: Deploy

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    concurrency:
      group: deploy
      cancel-in-progress: false
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: 24
      - run: npm ci
      - run: npx artfct check
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
      - run: npx wrangler d1 migrations apply DB --remote -c orchestrator/wrangler.jsonc
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
      - run: npx wrangler deploy -c orchestrator/wrangler.jsonc
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
      - run: npx wrangler deploy -c ingress/wrangler.jsonc
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

Another CI system runs the same five commands with the same two environment variables. Serialize deploys so two runs never apply migrations at once.

## Run the latest main

CI publishes a preview build of both packages from every commit on `main` through [pkg.pr.new](https://pkg.pr.new). To run the latest `main` before a release, install the previews in your deployment repo:

```sh
npm install https://pkg.pr.new/artfct-ai/artfct/@artfct-ai/core@main https://pkg.pr.new/artfct-ai/artfct/artfct@main
```
