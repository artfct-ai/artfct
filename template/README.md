# artfct deployment

This repository configures and deploys one artfct install on your Cloudflare account.

- `orchestrator/` holds the orchestrator Worker and the configuration it runs on.
  - `artfct.yaml` holds the deployment-wide settings: the default models, one provider per capability, the teams that may use the deployment, and your own MCP servers.
  - `workflows/development.yaml` is the workflow definition. It names the stages, their models, and their reviewers. A deployment holds one workflow definition today.
  - `skills/` holds the instructions each stage follows.
  - `writing-rules.md` holds the writing rules every agent reads.
  - `wrangler.jsonc` and `.dev.vars.example` hold the Worker's settings and secrets.
- `ingress/` holds the ingress Worker, which receives the vendors' webhooks, and its settings and secrets.
- `AGENTS.md` gives a coding agent the context to help you set up, deploy, and change this install. `CLAUDE.md` imports it for Claude Code.

The [deploy guide](https://github.com/artfct-ai/artfct/blob/main/docs/deploy.md) lists the deploy commands. The [install guide](https://github.com/artfct-ai/artfct/blob/main/docs/index.md) covers the install, each vendor's setup, and Claude Code auth.
