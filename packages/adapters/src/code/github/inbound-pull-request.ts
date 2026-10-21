import { z } from "zod";
import type { PullAction } from "@artfct-ai/contracts/inbound";
import {
  githubCodeUser,
  githubPullRequestSchema,
  githubUserSchema,
  malformedWebhook,
  pullRequestBindings,
  pullRequestDetail,
  pullRequestRejection,
  type GithubContext,
} from "./inbound-shared";
import type { CodeInbound } from "../types";

const HANDLED_ACTIONS: PullAction[] = ["opened", "ready_for_review", "closed", "reopened"];

const pullRequestWebhookSchema = z.object({
  action: z.string(),
  pull_request: githubPullRequestSchema,
  sender: githubUserSchema.nullish(),
});

/** `pull_request` events on pull requests of this repository become `pr_event`. */
export async function githubPullRequestEvent(context: GithubContext): Promise<CodeInbound> {
  const parsed = pullRequestWebhookSchema.safeParse(context.payload);
  if (!parsed.success) return malformedWebhook("pull_request");
  const { action: raw, pull_request: pr, sender } = parsed.data;
  const rejected = pullRequestRejection(context.repo, pr);
  if (rejected) return rejected;
  const action = HANDLED_ACTIONS.find((handled) => handled === raw);
  if (!action) return { ignore: `pull_request ${raw}` };

  return {
    event: {
      id: context.eventId,
      kind: "pr_event",
      actor: sender ? await context.resolveActor(githubCodeUser(context, sender)) : null,
      bindings: pullRequestBindings(context.repo, pr),
      links: [pr.html_url],
      text: pr.title ?? "",
      pull: pullRequestDetail(context.repo, pr, action, { merged: !!pr.merged }),
    },
  };
}
