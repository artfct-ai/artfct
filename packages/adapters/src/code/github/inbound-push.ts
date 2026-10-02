import { payloadString, type GithubContext } from "./inbound-shared";
import type { CodeInbound } from "../types";

/** A push to the default branch means the base moved. It carries no bindings, so the router fans it out. */
export function githubPushEvent(context: GithubContext): CodeInbound {
  const ref = payloadString(context.payload, "ref");
  const branch = ref.replace(/^refs\/heads\//, "");
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
