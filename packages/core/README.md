# @artfct-ai/core

The engine of [artfct](https://github.com/artfct-ai/artfct): the orchestrator and ingress Workers, their Durable Objects, the D1 migrations, and the deployment config schema.

A deployment repo depends on this package and deploys it to Cloudflare. Create one with `npx artfct init` and follow the [install guide](https://github.com/artfct-ai/artfct/blob/main/docs/index.md).

| Export | What it holds |
|---|---|
| `@artfct-ai/core/orchestrator` | The orchestrator Worker entrypoint |
| `@artfct-ai/core/ingress` | The ingress Worker entrypoint |
| `@artfct-ai/core/durable-objects` | The Durable Object classes the orchestrator binds |
| `@artfct-ai/core/config` | The config build step and the loaders of `artfct.yaml` and the workflow definitions, for Node |

The D1 migrations ship in `dist/migrations/d1`. The sandbox image's Dockerfile and build context ship in `dist/sandbox`. `wrangler deploy` builds the image from them and pushes it to the deploying account's Cloudflare registry.

Licensed under the Apache License, Version 2.0. The text ships in `dist/LICENSE`, and the attribution in `dist/NOTICE`.
