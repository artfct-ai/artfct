import type { PullAction } from "@artfct-ai/contracts/inbound";
import {
  githubCodeUser,
  pullRequestBindings,
  pullRequestDetail,
  pullRequestRejection,
  type GithubContext,
  type GithubPullRequest,
  type GithubUser,
} from "./inbound-shared";
import type { CodeInbound } from "../types";

const HANDLED_ACTIONS: PullAction[] = ["opened", "ready_for_review", "closed", "reopened"];

/** `pull_request` events on orchestrator branches of this repository become `pr_event`. */
export async function githubPullRequestEvent(context: GithubContext): Promise<CodeInbound> {
  const pr = context.payload.pull_request as GithubPullRequest;
  const rejected = pullRequestRejection(context.repo, pr);
  if (rejected) return rejected;
  const raw = String(context.payload.action);
  const action = HANDLED_ACTIONS.find((handled) => handled === raw);
  if (!action) return { ignore: `pull_request ${raw}` };

  const sender = context.payload.sender as GithubUser | undefined;
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
