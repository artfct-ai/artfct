import { z } from "zod";
import { malformedWebhook, type GithubContext } from "./inbound-shared";
import type { CodeInbound } from "../types";

const pushWebhookSchema = z.object({ ref: z.string() });

/** A push to the default branch means the base moved. It carries no bindings, so the router fans it out. */
export function githubPushEvent(context: GithubContext): CodeInbound {
  const parsed = pushWebhookSchema.safeParse(context.payload);
  if (!parsed.success) return malformedWebhook("push");
  const branch = parsed.data.ref.replace(/^refs\/heads\//, "");
  if (branch !== (context.repo.default_branch ?? "main")) return { ignore: `push to ${branch}` };

  return {
    event: {
      id: context.eventId,
      kind: "pr_event",
      actor: null,
      bindings: [],
      links: [],
      text: "",
      pull: {
        action: "base_moved",
        repo: context.repo.full_name,
        base: branch,
      },
    },
  };
}
