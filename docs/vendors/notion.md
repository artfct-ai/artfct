# Notion

Notion can be the documents capability. Model-call authors write their pages, such as the design and the plan, as Notion pages. Comments on those pages reach the workflow as feedback.

Set `adapters.documents.provider: notion` in `orchestrator/artfct.yaml`. The template sets it. Without it, documents go to Linear. Notion is optional. Leave its values empty to turn it off.

## Where pages go

The page parent is the page or database that holds a workflow's documents. A database must have exactly one table. Each document becomes a row of that table, with its title in the table's title column.

The stage that `documents.root_page` names in the workflow definition makes the root page. In the template that is `design`. The root page is the page people read first, and it holds every other page of the workflow:

- When the plan includes that stage, the orchestrator creates the root page under the page parent as an empty container. The stage fills it in. Every other page of the workflow is created as its subpage.
- A request that starts from an existing page, such as architectural directions, keeps that page where it is. The root page links to it, and the agent asks once whether to move it in instead.
- When the plan skips that stage but still writes pages, the agent asks which existing page is the root page. With none, the page the request starts from becomes the root page.

The root page ends with a `## Resources` section that lists its subpages and links. A revision of the root page replaces only the text above it.

A root page stage must write its page as a model call, without polishers. A harness rewrites the whole page and would drop the resources section.

## How comments reach the author

A comment a person leaves on a page artifact is held. It does not reach the author or the agent yet, and the orchestrator does not reply to it. When a comment on the page mentions the connection, such as `@artfct`, the author gets every held comment on that page and the mentioning comment as one piece of feedback. The orchestrator then replies 👀 to each of those comments. A person can also ask for the held comments in the workflow's thread. The handover message names the connection as a mention shows it.

A mention counts only when it is a real Notion user mention, picked from the mention menu. Typed text that looks like one does not count.

The orchestrator does not store held comments. Notion is the record. On a mention, it lists the page's own comments, then every block on the page and the comments on each one, because Notion returns an inline comment only under its block. A page of N blocks takes about N + 3 requests, eight at a time. A comment is held when a person wrote it and the connection has not replied 👀 after it in the same discussion. A reply that comes after the 👀 is held again. Notion does not list resolved discussions, so their comments are not held. The connection's own comments are never held. To send a comment again, delete the 👀 reply after it.

## Harness tasks

Harness tasks in the sandbox, such as the template's page reviewers, work on Notion pages through the Notion CLI, `ntn`. The sandbox image carries it. A task on a page stage gets the connection token in its sandbox environment. It reads the page as Markdown, edits the page in place, and posts its review as one comment on the page. The connection's bot user posts that comment, which is how the orchestrator finds the review.

## Create the connection

1. Open the [developer portal](https://app.notion.com/developers/connections). If it is not in your sidebar, turn on Settings → Developer → Enable developer features. Only a workspace owner can create a connection.
2. Create an internal connection for the workspace, named `artfct`. Do not use a personal access token. It acts as you, so the agent's own pages and comments would read as your feedback.
3. Give it the capabilities Read content, Update content, Insert content, Read comments, Insert comments, and User information with email addresses. The orchestrator matches Notion users to people by email. A comment reaches the workflow only when its author's email belongs to a user of the installed Linear workspace. See `access.tracker_team` on the [Linear page](linear.md).
4. Copy the token from the connection's Configuration tab into both `.dev.vars` files as `NOTION_TOKEN`. Ingress uses it to fetch comment bodies. The orchestrator uses it to write pages and reply, and hands it to harness tasks on page stages.
5. Share the page or database that holds your documents with the connection. Open its ••• menu, choose Add connections, and pick `artfct`. The connection sees only the pages shared with it and their children.
6. Set `documents.page_parent` in the workflow definition, `orchestrator/workflows/development.yaml` in the template, to its link. Each workflow definition has its own default, so different kinds of work can keep their documents in different places. A request can name another page or database by its link, and that one wins. Without either, the agent asks.

| File | Name | Value |
|---|---|---|
| `orchestrator/.dev.vars` | `NOTION_TOKEN` | The connection token |
| `ingress/.dev.vars` | `NOTION_TOKEN` | The same secret |
| `ingress/.dev.vars` | `NOTION_VERIFICATION_TOKEN` | The token from the handshake below |

Upload the secrets and deploy ingress before you add the webhook.

## Add the webhook

Notion signs its webhooks with a verification token that it sends only once, in the subscription handshake. Ingress accepts that one request unsigned and writes the token to its log. That is how you obtain it. Ingress accepts the handshake only while `NOTION_VERIFICATION_TOKEN` is not set.

1. Stream the ingress log in a terminal and leave it running. You can also read the log under Workers Logs in the Cloudflare dashboard.

   ```sh
   npx wrangler tail -c ingress/wrangler.jsonc
   ```

2. On the connection's Webhooks tab, choose Create a subscription with the URL `https://<ingress host>/webhooks/notion`. Subscribe it to the Comment created event.
3. Notion posts a body that holds only `verification_token`. Ingress answers 200 with `{"ok":true}` and logs this line:

   ```
   notion verification token received. Set NOTION_VERIFICATION_TOKEN to: <token>
   ```

4. Paste the token into Notion's verify dialog to finish the subscription.
5. Set `NOTION_VERIFICATION_TOKEN` in `ingress/.dev.vars` to the same token and upload the ingress secrets.

Every other Notion request must carry a valid signature. Ingress rejects them with 401 until `NOTION_VERIFICATION_TOKEN` is set. It accepts only `comment.created` events and ignores the other types.

Once the secret is set, ingress answers a handshake with 409 and does not log its token. To create a new subscription, delete the secret first, then repeat the steps above.

```sh
npx wrangler secret delete NOTION_VERIFICATION_TOKEN -c ingress/wrangler.jsonc
```

Ingress needs `NOTION_TOKEN` to read a comment. Without it, ingress answers a signed comment with `{"ignored":"NOTION_TOKEN not configured"}` and the comment does not reach the workflow.
