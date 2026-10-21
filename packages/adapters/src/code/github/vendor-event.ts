import { z } from "zod";
import type { JsonValue } from "@artfct-ai/contracts/types";
import { isGithubConversationalEvent } from "./conversational-events";
import { githubUserSchema, isGithubApp } from "./inbound-shared";
import { githubVendorEventName, isGithubPullRequestEventName } from "./vendor-event-name";
import type { CodeVendorEvent } from "../types";

const vendorEventPayloadSchema = z.object({
  repository: z.object({ full_name: z.string() }).nullish(),
  sender: githubUserSchema.nullish(),
  pull_request: z
    .object({
      number: z.number(),
      head: z.object({ repo: z.object({ full_name: z.string() }).nullish() }),
    })
    .nullish(),
});

/** What the GitHub pass-through needs besides the delivery. */
export type GithubVendorEventContext = {
  /** The `X-GitHub-Delivery` id. A redelivery carries the same id. */
  deliveryId: string;
  /** Logins the orchestrator itself acts under. Its own events never fire a trigger. */
  ownLogins: string[];
};

/**
 * Turn a verified GitHub delivery into a vendor event, or drop it with its reason. It drops a
 * conversational event, an event the app caused, a fork's pull request, and an event without a
 * causer or a repository. Another App's event passes. A pull request event names its pull request.
 */
export function githubVendorEvent(
  githubEvent: string,
  payload: JsonValue,
  context: GithubVendorEventContext,
): CodeVendorEvent {
  const name = githubVendorEventName(githubEvent, payload);
  if (isGithubConversationalEvent(name)) return { drop: "conversational" };
  const parsed = vendorEventPayloadSchema.safeParse(payload);
  if (!parsed.success) return { drop: `malformed ${name}` };
  const { repository, sender, pull_request: pull } = parsed.data;
  if (!sender) return { drop: "no causer" };
  if (context.ownLogins.includes(sender.login)) return { drop: "caused by the app" };
  if (!repository) return { drop: "no repository" };
  if (pull && pull.head.repo?.full_name !== repository.full_name) {
    return { drop: "pull request from a fork" };
  }
  const repo = repository.full_name;
  return {
    event: {
      delivery_id: context.deliveryId,
      name,
      payload,
      causer: { source: "code", user: { login: sender.login, repo, app: isGithubApp(sender) } },
      about_app: false,
      ...(pull && isGithubPullRequestEventName(name)
        ? { enrichment: { kind: "pull_request", repo, number: pull.number } }
        : {}),
    },
  };
}
