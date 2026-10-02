# Linear

Linear is the tracker. The orchestrator installs into one Linear workspace as an agent. People delegate an issue to the agent or mention it in a comment to start work. The breakdown stage files its issues in Linear. The template also keeps design and plan pages as Linear documents.

Set `providers.tracker: linear` in `orchestrator/artfct.yaml`. It is the only tracker today. Set `providers.docs: linear` to keep pages as Linear documents, which is the template default.

## Comments on Linear documents

A comment a person leaves on a document that is a page artifact is held. It does not reach the author or the agent yet, and the orchestrator does not react to it. When a comment on the document mentions the agent's app user, such as `@artfct`, the author gets every held comment on that document and the mentioning comment as one piece of feedback. The orchestrator then puts 👀 on each of those comments. A person can also ask for the held comments in the workflow's thread. The handover message names the app user by its display name.

A mention counts only when it is a real Linear user mention, picked from the mention menu. The orchestrator reads it from the comment's rich text, not from the Markdown body.

The orchestrator does not store held comments. Linear is the record. On a mention, it lists every comment on the document, inline ones included, with their reactions. A comment is held when a person wrote it, its thread is not resolved, and it does not carry the app user's 👀 reaction. The app user's own comments are never held. To send a comment again, remove the 👀 reaction from it.

## Create the OAuth application

In Linear, open Settings, then API, then OAuth applications, and create an application.

- Add the callback URL `https://<ingress host>/linear/oauth/callback`.
- Turn on webhooks. Set the webhook URL to `https://<ingress host>/webhooks/linear`.
- Subscribe the webhook to Agent session events, Comments, and Issues.

Copy its values into the `.dev.vars` files:

| File | Name | Value |
|---|---|---|
| `orchestrator/.dev.vars` | `LINEAR_CLIENT_ID` | The client id |
| `orchestrator/.dev.vars` | `LINEAR_CLIENT_SECRET` | The client secret |
| `ingress/.dev.vars` | `LINEAR_WEBHOOK_SECRET` | The webhook signing secret |

Ingress rejects every Linear webhook with 401 until `LINEAR_WEBHOOK_SECRET` is set.

`access.tracker_team` in `orchestrator/artfct.yaml` limits the deployment to the members of one Linear team. Set it to a team key, such as `ENG`, or a team id. A Linear user outside that team is then ignored. So is a Notion commenter, and a Slack user when `access.chat_team` is not set, unless their email belongs to a member of the team. Without `tracker_team`, every user of the Linear workspace is let in. See [Set who may use the deployment](../index.md#3-set-who-may-use-the-deployment).

Upload the secrets and deploy before you install.

## Install into the workspace

The install link comes from an admin route on ingress. The route is live on every deployment and requires `ADMIN_TOKEN` from `ingress/.dev.vars` as a bearer token.

```sh
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://<ingress host>/admin/linear/install
```

The route answers with the link:

```json
{ "url": "https://linear.app/oauth/authorize?..." }
```

It answers 401 without a valid token. It answers 503 with an `error` when `LINEAR_CLIENT_ID` or `LINEAR_CLIENT_SECRET` is not set on the orchestrator.

Open the link as a workspace admin and approve the install. The link works once, within 15 minutes. Request a new one if it expires. Linear then returns to `/linear/oauth/callback`, and the page names the workspace and the agent's app user.

The link asks Linear for an install that acts as the app. Its parameters:

| Parameter | Value |
|---|---|
| `client_id` | `LINEAR_CLIENT_ID` |
| `redirect_uri` | `https://<ingress host>/linear/oauth/callback` |
| `response_type` | `code` |
| `scope` | `read,write,app:assignable,app:mentionable` |
| `actor` | `app` |
| `prompt` | `consent` |
| `state` | A one-time value the callback checks |

The `app:assignable` and `app:mentionable` scopes let people delegate issues to the agent and mention it.

One deployment serves one workspace. An install from a second workspace fails and names the workspace already installed. Ingress ignores every Linear webhook that does not come from the installed workspace, and every webhook before the install. Installing again from the same workspace replaces the stored tokens.

## Token storage

The orchestrator stores the Linear access token and refresh token in its D1 database and refreshes the access token when it nears expiry. The tokens are stored as plain text today. Anyone who can read the D1 database can read them.

## Admin routes

Ingress has other routes under `/admin` that dump workflow state. They answer 404 unless the ingress var `ADMIN_DEBUG` is `true`. Only local development sets it. `/admin/linear/install` is the only admin route a deployment serves.
