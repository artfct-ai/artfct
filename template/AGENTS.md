# Agent guide

This repository configures and deploys one artfct install on the user's Cloudflare account. Use this guide to help the user set up the install, deploy it, and change its configuration.

## Sources

- `README.md` lists what each file and directory in this repository holds.
- The [install guide](https://github.com/artfct-ai/artfct/blob/main/docs/index.md) covers the prerequisites, the settings, and Claude Code auth.
- The [deploy guide](https://github.com/artfct-ai/artfct/blob/main/docs/deploy.md) lists the deploy commands in order, the published sandbox image, and a GitHub Actions workflow that runs the deploy.
- Each vendor has its own setup page: [GitHub](https://github.com/artfct-ai/artfct/blob/main/docs/vendors/github.md), [Linear](https://github.com/artfct-ai/artfct/blob/main/docs/vendors/linear.md), [Slack](https://github.com/artfct-ai/artfct/blob/main/docs/vendors/slack.md), [Notion](https://github.com/artfct-ai/artfct/blob/main/docs/vendors/notion.md). Read the page before you walk the user through that vendor.

The commands in this guide are written for npm. When the repository holds the lockfile of another package manager, use that package manager's install, run, and exec commands.

## Rules

- Never print, log, or commit a secret. The `.dev.vars` files hold the secrets, and git ignores them. To check whether a value is set, test it without printing it, for example `grep -q '^OPEN_ROUTER_API_KEY=.' orchestrator/.dev.vars`.
- Let the user paste each secret into its file or prompt. Do not ask for a secret in the chat.
- Ask before a command that changes the user's accounts: `wrangler deploy`, `wrangler d1 migrations apply --remote`, `wrangler secret bulk`, `gh secret set`, and `git push`.
- Run `npx artfct check` after each change under `orchestrator/`. Fix what it reports before a deploy.
- Do not edit `orchestrator/dist`. The orchestrator deploy builds it.
- Do not edit `node_modules`. The code of both Workers comes from `@artfct-ai/core`. `orchestrator/index.ts` and `ingress/index.ts` only re-export it.

## Find where the setup stands

Check each step in order. The first one that is not done is the next step.

| Step | Done when | Next action |
|---|---|---|
| Prerequisites | `node --version` is 22 or later and `docker info` passes | Install what is missing. Docker is not needed with the published sandbox image in the deploy guide. |
| Scaffold | `orchestrator/artfct.yaml` exists | Run `npx artfct init` in the clone of the deployment repo. |
| Database | `database_id` in `orchestrator/wrangler.jsonc` is not `<your D1 database id>` | Run `npx wrangler d1 create artfct --binding DB --update-config --config orchestrator/wrangler.jsonc`. |
| Dependencies | `node_modules/@artfct-ai/core` exists and git tracks a lockfile | Install with the user's package manager, then have the user commit the files and the lockfile. `init` does not install or commit. |
| Settings files | `orchestrator/.dev.vars` and `ingress/.dev.vars` exist | Copy each `.dev.vars.example` to `.dev.vars`. |
| Required settings | `PUBLIC_URL` and `OPEN_ROUTER_API_KEY` in `orchestrator/.dev.vars` and `ADMIN_TOKEN` in `ingress/.dev.vars` are set | Have the user fill them in. `PUBLIC_URL` is `https://artfct-ingress.<subdomain>.workers.dev`. The user finds the subdomain in the Cloudflare dashboard under Workers & Pages. |
| Access | `access` in `orchestrator/artfct.yaml` does not hold a `<team ...>` placeholder | Ask the user which Linear team or Slack workspace may use the deployment. Set `tracker_team`, `chat_team`, or both, and delete a line the user does not want. Delete the whole block only when the user asks for everyone to be let in. See Set who may use the deployment in the install guide. |
| Claude Code auth | `ANTHROPIC_API_KEY` is set, or `providers.gateway` in `orchestrator/artfct.yaml` is `cloudflare` and `CF_ACCOUNT_ID`, `AI_GATEWAY_ID`, and `AI_GATEWAY_TOKEN` are set | Follow Claude Code auth in the install guide. |
| GitHub | `GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID`, and `GITHUB_PRIVATE_KEY` are set in `orchestrator/.dev.vars`, and `GITHUB_APP_LOGIN` in `ingress/wrangler.jsonc` is not `<your GitHub App slug>` | Run `npx artfct connect code`. Add `--org <org>` when an organization should own the app. |
| Linear app | `LINEAR_CLIENT_ID` and `LINEAR_CLIENT_SECRET` in `orchestrator/.dev.vars` and `LINEAR_WEBHOOK_SECRET` in `ingress/.dev.vars` are set | Follow the Linear page to create the OAuth application. |
| Preflight | `npx artfct check` passes | Fix each failed check. |
| Deploy | `npx wrangler deployments list -c orchestrator/wrangler.jsonc` and the same for `ingress/wrangler.jsonc` list a deployment | Run the commands in the deploy guide. |
| Secrets | `npx wrangler secret list -c <worker>/wrangler.jsonc` names every value set in that Worker's `.dev.vars` | Run the upload command in the header of each `.dev.vars` file. |
| Linear install | The user has opened the install link and approved it | Follow Install into the workspace on the Linear page. It needs the deploy and the secrets first. |
| Slack and Notion | Optional. Set up only the ones the user wants. | Follow the vendor page. Each needs ingress deployed first. |

## Change the configuration

- `orchestrator/artfct.yaml` holds the default harness and model, one vendor per capability under `providers`, the teams that may use the deployment under `access`, the orchestrator model, and the user's MCP servers.
- `orchestrator/workflows/development.yaml` is the workflow definition. It names the stages, and for each stage its artifact, its research step, its author, its reviewers, and its polishers. A deployment holds one workflow definition today.
- `orchestrator/skills/<name>/SKILL.md` holds the instructions a stage names by `skill`. Its frontmatter uses only the keys of the [Agent Skills standard](https://agentskills.io/specification), and its `name` matches its directory.
- `orchestrator/writing-rules.md` holds the writing rules every agent reads.

A change takes effect on the next deploy. `npx artfct check` names each key the config schema rejects.

## Upgrade

Run `npm install @artfct-ai/core@latest artfct@latest`, commit the lockfile, then run `npx artfct check` and the deploy. When the orchestrator uses the published sandbox image, first set its `image` to the reference in `node_modules/@artfct-ai/core/dist/sandbox/published-image`. The check fails until the two match.

## Troubleshoot

- Read a Worker's live logs with `npx wrangler tail -c orchestrator/wrangler.jsonc` or `npx wrangler tail -c ingress/wrangler.jsonc`.
- A webhook that answers 401 means its signing secret is not uploaded to ingress.
- `claude-code needs ANTHROPIC_API_KEY or a gateway with an Anthropic endpoint` means Claude Code auth is not set up.
- An orchestrator deploy that fails while it builds the image needs Docker running, or the published sandbox image.
- Notion sends its verification token once, when the user creates the webhook subscription. Ingress writes it to its log, so tail the ingress log while the user creates it. Ingress refuses that request with 409 once `NOTION_VERIFICATION_TOKEN` is set. Delete the secret before the user creates a new subscription.
