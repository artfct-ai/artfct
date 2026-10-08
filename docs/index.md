# artfct

artfct runs software engineering requests through coding agents on your Cloudflare account. A person asks for work in Slack or Linear. The orchestrator agent splits the request into stages, and a coding agent in a sandbox does each stage. Each stage ends in an artifact the humans review, such as a design page, a set of issues, or a pull request.

- [Architecture](#architecture)
- [Install](#install)
- [Deploy](deploy.md)
- [Claude Code auth](#claude-code-auth)
- [OpenRouter region](#openrouter-region)
- [Skills](skills.md)
- [MCP servers](mcp-servers.md)
- [Local run](local-run.md), for work on artfct itself
- Vendors: [GitHub](vendors/github.md), [Slack](vendors/slack.md), [Linear](vendors/linear.md), [Notion](vendors/notion.md)

## Architecture

A deployment is two Workers, one D1 database, and sandbox containers, all on your Cloudflare account.

- **Ingress** is the public Worker. It receives the webhooks of GitHub, Slack, Linear, and Notion at `/webhooks/<vendor>`. It verifies each request with the vendor's signing secret, maps the payload into one inbound event, and hands it to the orchestrator over a service binding. It stores nothing.
- **Orchestrator** is the Worker behind ingress. The orchestrator agent reads each inbound event, plans the work, and reports back in the channel the request came from. Each workflow runs in its own Durable Object. The D1 database holds what outlives one workflow, such as the Linear install.
- **Sandboxes** are Cloudflare Containers started from the sandbox image. The orchestrator deploy builds that image from the Dockerfile in `@artfct-ai/core` and pushes it to your account's container registry. CI also publishes the image on Docker Hub for a deploy without Docker. Each task runs a coding agent harness in its own sandbox, either Claude Code or opencode. Everything in a sandbox runs as an unprivileged user, so a coding agent cannot install system packages. A bridge in the sandbox dials back to ingress at `wss://<ingress host>/bridge/...` and speaks the Agent Client Protocol to the harness.
- **Model gateways** carry every model call. `gateway: openrouter` sends calls to OpenRouter, on its global host or in one [region](#openrouter-region). `gateway: cloudflare` sends them through a Cloudflare AI Gateway. Each gateway carries a decisions model. OpenRouter defaults to TypeSafe's `typesafe/jev-1.13`. The Cloudflare gateway defaults to Cloudflare's `@cf/cloudflare/clef` on Workers AI, with the same API token. Set `orchestrator.decisions_model` to name another model on the gateway, or a list of them. A call tries each in order and moves to the next when one fails.
- **The screen** checks text that reaches an agent from outside the deployment. It covers two kinds of text. The first is the result of a tool the orchestrator agent calls: a web page read, an MCP tool, a channel history read, an artifact read, and the ready-issue list. The second is feedback that `access` did not check: the review of a GitHub App, and the held comments on a page. The decisions model answers four yes-or-no questions about the text. Does it try to take control of the agent away from the people it works for? Does a passage pose as a system, developer, operator, or tool message? Does it ask the agent to disclose a secret? Does it ask the agent to hide an action from the team? A request to change earlier work and a page whose subject is AI agents or their prompts count as no. A text that draws a yes is quarantined. The agent reads a fixed line in its place and tells the person, and quarantined feedback does not reach the author. The screen does not read what an authorized person writes. When the decisions model does not answer, the text is quarantined as unchecked, the same way.

Your deployment repo holds the configuration. `orchestrator/artfct.yaml` holds the deployment-wide settings: the default harness and model, one vendor per capability under `providers`, the teams that may use the deployment under `access`, the orchestrator model, and your own MCP servers. Each file under `orchestrator/workflows/` is a workflow definition. It describes the kind of work it is for and names the stages, the harness and model of each author, and the reviewers. A deployment holds one workflow definition today. The template ships `orchestrator/workflows/development.yaml` with the stages `architectural directions`, `design`, `plan`, `breakdown`, and `implement`. `orchestrator/skills/` holds the instructions each stage follows. `orchestrator/writing-rules.md` holds the writing rules every agent reads.

Each capability has one entry under `adapters` in `orchestrator/artfct.yaml`. The entry names the vendor as `provider` and holds that capability's settings.

| Capability | `adapters` key | Vendors | Default |
|---|---|---|---|
| Code host | `code` | `github` | `github` |
| Tracker | `tracker` | `linear` | `linear` |
| Chat | `chat` | `slack` | `slack` |
| Documents | `documents` | `linear`, `notion` | `linear` |
| Model gateway | `gateway` | `cloudflare`, `openrouter` | `cloudflare` |

## Install

You need these before you start:

- A Cloudflare account with Workers, D1, and Containers. Wrangler logs in through the browser, or reads `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from the environment.
- Node.js 22 or later with `npx`. Wrangler needs Node.js 22.
- git.
- Docker, running on the machine that deploys. The orchestrator deploy builds the sandbox image. GitHub's hosted runners have it. A deploy that uses the published sandbox image does not need Docker.
- An empty GitHub repository for the deployment.

This guide writes its commands for npm. Any package manager works. Use its own install, run, and exec commands, and commit its lockfile.

### 1. Scaffold the deployment repo

Clone the empty repository and run `init` inside the clone. It takes no flags.

```sh
git clone <deployment-repo-url>
cd <deployment-repo>
npx artfct init
```

`init` prints each step before it runs it and stops at the first failure.

1. It copies the template that ships inside the `artfct` package into the directory. It refuses to run when a template file or directory already exists, and it names each one.
2. It runs `wrangler d1 create artfct --binding DB --update-config --config orchestrator/wrangler.jsonc` through `npx`. Wrangler creates the database and writes its id into the config. Wrangler starts its login flow when it has no credential.

`init` does not install the dependencies, and it does not commit, push, or deploy. A failure prints the step, its cause, and how to recover.

- A failed template copy changed nothing. Remove the entries it names, or run `init` in an empty directory.
- A failed database step left the copied template in place. Fix the cause, then run the wrangler command above by hand.

Then install the dependencies and commit everything, the lockfile included. Each deploy installs the versions the lockfile pins.

```sh
npm install
git add --all
git commit -m "Scaffold the artfct deployment"
git push
```

### 2. Fill in the settings

Each Worker reads its settings and secrets from a `.dev.vars` file that git ignores. Copy both examples. Each line of the examples carries a comment.

```sh
cp orchestrator/.dev.vars.example orchestrator/.dev.vars
cp ingress/.dev.vars.example ingress/.dev.vars
```

Set these first:

- `PUBLIC_URL` in `orchestrator/.dev.vars` is the public origin of the ingress Worker, such as `https://artfct-ingress.<your-subdomain>.workers.dev`.
- `ADMIN_TOKEN` in `ingress/.dev.vars` is any long random string. It guards the admin routes of ingress.
- `OPEN_ROUTER_API_KEY` in `orchestrator/.dev.vars` is your OpenRouter key. The template runs the orchestrator agent and the model-call authors on OpenRouter models.
- The Claude Code credential. See [Claude Code auth](#claude-code-auth).

### 3. Set who may use the deployment

The `access` block of `orchestrator/artfct.yaml` names the teams whose members may give the deployment work. The template ships it with two placeholders, and `npx artfct check` fails until you replace or delete each one.

```yaml
access:
  tracker_team: ENG
  chat_team: T0123ABCD
```

| Key | Value | Who it lets in |
|---|---|---|
| `tracker_team` | A Linear team key, such as `ENG`, or a team id. The key is the prefix of the team's issue ids. | Linear users who are members of that team |
| `chat_team` | A Slack workspace id. It starts with `T` and is part of the URL when you open Slack in a browser, as in `app.slack.com/client/T0123ABCD`. | Full members of that workspace. Guests and bots are kept out. |

Each line limits its own app. Choose one of these three setups:

- Set both lines to limit Slack and Linear separately.
- Set one line and delete the other. With only `tracker_team`, a Slack user is let in when the email on their Slack profile belongs to a member of that Linear team. With only `chat_team`, every user of the Linear workspace is let in.
- Delete the whole `access` block to let in everyone who reaches the bot. That includes Slack guests.

The deployment ignores every message in a Slack Connect channel, whatever `access` says. Another organization controls the profiles of its people in such a channel.

A Notion commenter always needs a Linear account with the same email, and `tracker_team` applies to that account. The deployment ignores what a person who is not let in writes in Slack, Linear, or Notion. They cannot start a workflow, reply to one, or approve anything. Team membership is read on every message, so a person who leaves the team is out at once. A change to `access` takes effect on the next deploy.

`access` does not cover GitHub. There the repository decides. The deployment ignores a review or a comment on a pull request unless its author may push to the repository. GitHub counts every grant: the person's own, a team's, and the organization's. It is asked on every review and comment. A review from a GitHub App installed on the repository always counts.

### 4. Connect the vendors

Connect GitHub first, then Linear. The template needs both. Linear is its tracker and keeps its pages. People start requests from Slack or Linear, so Slack is optional. Notion is needed only when `adapters.documents.provider` is `notion`. Leave a vendor's values empty to turn it off.

- [GitHub](vendors/github.md): `npx artfct connect code` creates and installs the GitHub App. It writes the app slug into `ingress/wrangler.jsonc`. Commit and push that file before you deploy.
- [Linear](vendors/linear.md): an OAuth application, installed once from an admin link after the first deploy.
- [Slack](vendors/slack.md): a Slack app created from the artfct manifest.
- [Notion](vendors/notion.md): an internal integration and a webhook subscription.

Every webhook route rejects requests with 401 until its signing secret is set. The one exception is the Notion subscription handshake, which is how you obtain the Notion secret. Ingress accepts it only until that secret is set.

### 5. Deploy

Follow the [deploy guide](deploy.md). It lists the six deploy commands in order, including the `npx artfct check` preflight. It also has a GitHub Actions workflow to copy into `.github/workflows/deploy.yml`, and the steps that keep its Cloudflare token behind a protected environment.

Upload the Worker secrets after the first deploy, and again whenever they change. A deploy does not upload them.

```sh
npx wrangler secret bulk orchestrator/.dev.vars -c orchestrator/wrangler.jsonc
npx wrangler secret bulk ingress/.dev.vars -c ingress/wrangler.jsonc
```

## Claude Code auth

The `claude-code` harness needs an Anthropic API key. The template runs every harness author on `claude-code`. Give the key to the sandboxes directly, or store it in a Cloudflare AI Gateway. When both are set, the direct key wins.

### An API key

Create a key in the Claude Console. Paste it into `orchestrator/.dev.vars`:

```sh
ANTHROPIC_API_KEY=<your API key>
```

Each sandbox receives the key as `ANTHROPIC_API_KEY`, and its usage bills the key's organization. It works with either gateway.

### The Cloudflare AI Gateway

Leave `ANTHROPIC_API_KEY` empty and route Claude Code through the Anthropic endpoint of a Cloudflare AI Gateway. The gateway holds the Anthropic credential.

1. Create an AI Gateway and store your Anthropic key in it.
2. Create a Cloudflare API token with the permissions AI Gateway Run and Workers AI Read.
3. Set these in `orchestrator/.dev.vars`:

   ```sh
   CF_ACCOUNT_ID=<your account id>
   AI_GATEWAY_ID=<your gateway id>
   AI_GATEWAY_TOKEN=<the API token>
   ```

4. Set the gateway in `orchestrator/artfct.yaml`:

   ```yaml
   adapters:
     gateway:
       provider: cloudflare
   ```

The sandbox gateway comes from `adapters.gateway.provider`. The OpenRouter gateway has no Anthropic endpoint, so a task on `claude-code` fails with `claude-code needs ANTHROPIC_API_KEY or a gateway with an Anthropic endpoint` when neither route is set up.

## OpenRouter region

OpenRouter can keep a request inside the EU or the US, from decryption to the model provider. It needs an OpenRouter Business or Enterprise plan. The same key works in every region. Set the region in `orchestrator/artfct.yaml`:

```yaml
adapters:
  gateway:
    provider: openrouter
    region: eu
```

The values are `eu` and `us`. Without the key, calls go to OpenRouter's global host. `npx artfct check` refuses any other value.

The region covers every call the OpenRouter gateway makes: the orchestrator agent, its summaries, the decisions model, the model-call authors, and a sandbox that runs opencode. The model list the agent offers comes from the same region.

- Replace each model the region does not serve. A region serves fewer models than the global host, and OpenRouter fails a request for a model with no provider in the region. `https://eu.openrouter.ai/api/v1/models` lists the models of the EU, and `https://us.openrouter.ai/api/v1/models` lists the models of the US. Check every `openrouter/` model in `orchestrator/artfct.yaml` and in each workflow definition, the template's included.
- Use the `openrouter` gateway for every `openrouter/` model. The Cloudflare gateway passes such a model through to OpenRouter's global host, so it refuses the model while a region is set.
- The region does not cover Claude Code on `ANTHROPIC_API_KEY`. Those calls go to Anthropic.
