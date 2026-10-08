# GitHub

GitHub is the code host. The orchestrator acts through a private GitHub App. The coding agent pushes branches and opens pull requests as that app. Reviews, comments, and CI results on those pull requests reach the workflow that opened them.

Set `adapters.code.provider: github` in `orchestrator/artfct.yaml`. It is the only code host today.

## Create and install the app

Run `connect code` from the root of the deployment repo, after `npm install`.

```sh
npx artfct connect code
```

Pass `--org <name>` when an organization owns the repositories. The organization then owns the app.

```sh
npx artfct connect code --org <organization>
```

Before you run it:

- Set `PUBLIC_URL` in `orchestrator/.dev.vars` to the ingress origin. The command stops when it is missing or is not a URL.
- Run it in a deployment repo. The command stops when `ingress/wrangler.jsonc` is missing.
- Log in to GitHub in your default browser as a person who can create apps for the owner.

The command does this:

1. It starts a local server on `127.0.0.1` and opens it in the browser. Open the printed address yourself if no browser appears.
2. The page posts an app manifest to GitHub. Confirm the app on GitHub. The app is named `artfct-<repo directory name>`, and you can rename it on that page.
3. GitHub returns to the local server. The command trades the code for the app's credentials and writes them into the repo.
4. The browser moves on to the install page of the new app. Pick the repositories the agents work in. Leave the deployment repo out. The coding agents hold a token of this app, and the deployment repo holds the workflow that deploys with your Cloudflare token.
5. GitHub returns the installation id. The command writes it, and the page says `artfct is connected`.

The command writes these values. Each `.dev.vars` file is written readable by its owner only. A missing `.dev.vars` file starts from its `.example`.

| File | Name | Value |
|---|---|---|
| `orchestrator/.dev.vars` | `GITHUB_APP_ID` | The app id |
| `orchestrator/.dev.vars` | `GITHUB_PRIVATE_KEY` | The app's private key |
| `orchestrator/.dev.vars` | `GITHUB_INSTALLATION_ID` | The installation id |
| `ingress/.dev.vars` | `GITHUB_WEBHOOK_SECRET` | The webhook secret |
| `ingress/wrangler.jsonc` | `vars.GITHUB_APP_LOGIN` | The app slug |

Ingress reads `GITHUB_APP_LOGIN` to tell the app's own reviews and comments apart from those of people.

When an organization owner must approve the install, GitHub returns no installation id and the command fails with that reason. The other values are already written. After the approval, copy the installation id from the app's installation page into `GITHUB_INSTALLATION_ID` in `orchestrator/.dev.vars`.

Upload the secrets afterwards with the command in the header of each `.dev.vars` file.

`ingress/wrangler.jsonc` is tracked in git, and the template ships it with a placeholder slug. Commit and push the updated file before the next deploy. A CI deploy otherwise ships the placeholder, and ingress then treats the app's own reviews and comments as those of people.

```sh
git add ingress/wrangler.jsonc
git commit -m "Set the GitHub App slug"
git push
```

## What the app gets

The manifest creates a private app with its webhook pointed at `<PUBLIC_URL>/webhooks/github`.

Permissions:

| Permission | Access |
|---|---|
| Contents | Write |
| Pull requests | Write |
| Issues | Write |
| Checks | Read |
| Commit statuses | Read |
| Actions | Read |
| Metadata | Read |

The app does not get the Workflows permission. GitHub rejects a push from the app that adds or changes a file under `.github/workflows/`. A coding agent cannot change your CI workflows, so a person makes those changes.

Webhook events: Pull request, Pull request review, Pull request review comment, Issue comment, Check suite, Check run, and Push.

## What a sandbox can reach

Each task's sandbox gets an installation token limited to the workflow's repository. A coding agent pushes and opens pull requests with it. By default the agent cannot read any other repository, even one the app is installed on.

To let the agents read the other repositories, such as an infrastructure repo that names the owner of a DNS record, set this in `orchestrator/artfct.yaml`:

```yaml
orchestrator:
  sandbox:
    read_all_repos: true
```

Each sandbox then gets a second token. It reads every repository the installation can reach, with Contents Read and Metadata Read alone. GitHub gives one token one set of permissions for all its repositories, so the sandbox holds two tokens:

| Tool | Repository | Token |
|---|---|---|
| git | The workflow's repository | The task token, which may push |
| git | Any other repository on github.com | The read token |
| gh | Any | The task token |

Git picks the token by the repository path in the URL. The agent reads another repository with git, for example `git clone https://github.com/<owner>/<repo>.git /tmp/<repo>`. The `gh` CLI stays logged in with the task token, so `gh` commands against another private repository fail. Both tokens are refreshed together, before the first of them expires.

Turn this on with care. A prompt-injected agent can read every repository the installation reaches, and the agent can send what it reads out of the sandbox. Install the app on only the repositories the agents need to read. The setting does not give write access to any other repository.

## Whose reviews count

The deployment ignores a review or a comment on one of its pull requests unless the author may push to the repository. On each review and comment it asks GitHub for the author's permission on the repository. GitHub answers with the highest role the person holds from any grant: their own, a team's, a parent team's, the organization's, or the enterprise's. The Write, Maintain, and Admin roles may push. The Read and Triage roles may not.

A review from another GitHub App installed on the repository always counts. The `access` block of `orchestrator/artfct.yaml` does not apply to GitHub.

## Webhook

Ingress receives the app's webhooks at `/webhooks/github`. It verifies each request against `GITHUB_WEBHOOK_SECRET` and rejects every request with 401 until the secret is set. It answers the `ping` GitHub sends when the hook is created.
