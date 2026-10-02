/**
 * Builders that post signed mock webhooks to the ingress Worker and return the parsed
 * JSON reply. Signatures use the same secrets `wrangler dev` is started with.
 */
import {
  GITHUB_WEBHOOK_SECRET,
  INGRESS_URL,
  LINEAR_WEBHOOK_SECRET,
  RUN_ID,
  SLACK_SIGNING_SECRET,
} from "./config";
import { SLACK_APP_ID, SLACK_BOT_USER_ID, SLACK_TEAM_ID } from "./fixtures";
import { hmacSha256Hex } from "./sign";

/** Parsed JSON reply from an ingress webhook route. */
export type WebhookReply = Record<string, unknown>;

/** Posts a JSON body with the given headers to an ingress webhook path. */
async function postWebhook(
  path: string,
  body: string,
  headers: Record<string, string>,
): Promise<WebhookReply> {
  const response = await fetch(`${INGRESS_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
  const text = await response.text();
  try {
    return JSON.parse(text) as WebhookReply;
  } catch {
    throw new Error(
      `${path} answered ${response.status} with non-JSON body: ${text.slice(0, 500)}`,
    );
  }
}

/** Posts a Linear webhook signed with `linear-signature`. Each delivery has its own id. */
export async function postLinearWebhook(
  payload: unknown,
  eventName = "AgentSessionEvent",
): Promise<WebhookReply> {
  const body = JSON.stringify(payload);
  const signature = await hmacSha256Hex(LINEAR_WEBHOOK_SECRET, body);
  return postWebhook("/webhooks/linear", body, {
    "linear-signature": signature,
    "linear-delivery": crypto.randomUUID(),
    "linear-event": eventName,
    "user-agent": "Linear-Webhook",
  });
}

/**
 * Posts a GitHub webhook of type `eventName` signed with `x-hub-signature-256`. Pass the same
 * `deliveryId` twice to redeliver one.
 */
export async function postGithubWebhook(
  eventName: string,
  payload: unknown,
  deliveryId = crypto.randomUUID(),
): Promise<WebhookReply> {
  const body = JSON.stringify(payload);
  const signature = `sha256=${await hmacSha256Hex(GITHUB_WEBHOOK_SECRET, body)}`;
  return postWebhook("/webhooks/github", body, {
    "x-hub-signature-256": signature,
    "x-github-event": eventName,
    "x-github-delivery": deliveryId,
    "x-github-hook-installation-target-type": "integration",
    "user-agent": "GitHub-Hookshot/smoke",
  });
}

/** Posts a Slack `event_callback` envelope around `event`, signed like Slack signs it. */
export async function postSlackEvent(event: unknown): Promise<WebhookReply> {
  const body = JSON.stringify({
    token: "verification-token-unused",
    team_id: SLACK_TEAM_ID,
    api_app_id: SLACK_APP_ID,
    event,
    type: "event_callback",
    event_id: `Ev${RUN_ID}${Math.random().toString(36).slice(2, 8)}`.toUpperCase(),
    event_time: Math.floor(Date.now() / 1000),
    authorizations: [
      {
        enterprise_id: null,
        team_id: SLACK_TEAM_ID,
        user_id: SLACK_BOT_USER_ID,
        is_bot: true,
        is_enterprise_install: false,
      },
    ],
    is_ext_shared_channel: false,
    event_context: `1-app_mention-${SLACK_TEAM_ID}-C1`,
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${await hmacSha256Hex(SLACK_SIGNING_SECRET, `v0:${timestamp}:${body}`)}`;
  return postWebhook("/webhooks/slack", body, {
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": signature,
  });
}
