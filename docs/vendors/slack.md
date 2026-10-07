# Slack

Slack is the chat capability. People start work by mentioning the app, and the orchestrator reports on a board in the thread.

Set `adapters.chat.provider: slack` in `orchestrator/artfct.yaml`. It is the only chat vendor today. Slack is optional. Leave its values empty to turn it off.

## Create the app

Create the app from the [artfct Slack manifest](https://github.com/artfct-ai/artfct/blob/main/packages/ingress/slack-manifest.yaml).

1. Deploy ingress first.
2. Open [api.slack.com/apps](https://api.slack.com/apps), choose **Create New App**, then **From a manifest**.
3. Paste the manifest. Replace `REPLACE_ME` in `request_url` with your ingress host, so the URL reads `https://<ingress host>/webhooks/slack`. Rename the app if you like.
4. Install the app in the workspace.
5. Copy the values below into the `.dev.vars` files and upload the secrets with the command in the header of each file.
6. Open **App Manifest** in the app's settings and verify the Request URL.

| File | Name | Where Slack shows it |
|---|---|---|
| `ingress/.dev.vars` | `SLACK_SIGNING_SECRET` | Basic Information, Signing Secret |
| `ingress/.dev.vars` | `SLACK_BOT_TOKEN` | OAuth & Permissions, Bot User OAuth Token |
| `orchestrator/.dev.vars` | `SLACK_BOT_TOKEN` | The same token |

Verify the Request URL only after you upload `SLACK_SIGNING_SECRET`. Slack signs its `url_verification` handshake, and ingress rejects every Slack request with 401 until the secret is set.

A change to the scopes requires you to install the app again. Slack grants new scopes only at install.

## Scopes and events

Bot token scopes:

- `app_mentions:read`
- `assistant:write`
- `channels:history`
- `channels:read`
- `groups:history`
- `groups:read`
- `im:history`
- `chat:write`
- `reactions:read`
- `reactions:write`
- `users:read`
- `users:read.email`

Bot events:

- `app_mention`
- `member_joined_channel`
- `message.channels`
- `message.groups`
- `reaction_added`
- `message.im`
- `app_home_opened`

## Use

- Invite the app to a channel. It posts a greeting when it joins.
- Mention the app to start a workflow. The thread of the mention belongs to that workflow.
- Reply in the thread to give feedback. A reply that opens by tagging somebody else is not for the app.
- React with :white_check_mark: to any message in the thread as a short reply.
- Ingress ignores direct messages and App Home opens today.
- Ingress ignores every message in a Slack Connect channel, which is a channel shared with another organization.

People are matched across Slack and the tracker by the email on their Slack profile.

## Who may use it

`access.chat_team` in `orchestrator/artfct.yaml` limits Slack to the full members of one workspace. Set it to the workspace id, which starts with `T`. Open Slack in a browser and read it from the URL, as in `app.slack.com/client/T0123ABCD`. Guests and bots are then ignored.

Without `chat_team`, `access.tracker_team` decides. A Slack user is let in when their profile email belongs to a member of that Linear team. Without either, every Slack user who reaches the app is let in, guests included. See [Set who may use the deployment](../index.md#3-set-who-may-use-the-deployment).
