import type { HostInstructions } from "@artfct-ai/adapters/instructions";
import type { McpServer } from "@artfct-ai/adapters/mcp";
import { firstClaimedLink } from "./detect";
import type { Artifact, ArtifactTarget, Review } from "./types";
import { parseTurnTextReview, reviewInstructions } from "./review-text";

/** What the issues kind needs from the configured tracker provider. */
export type IssuesClients = {
  /** True when the link is an issue on this tracker. */
  ownsUrl: (url: string) => boolean;
  mcp: (credential: string | null) => McpServer | null;
  instructions: HostInstructions;
  /** What the author may do with other repositories in its checkout. */
  notes: string;
};

/** Where the reviewer of a set of issues writes its review. */
const REVIEW_PLACE = "End the text of your turn with this block:";

/**
 * The artifact kind that is a set of issues on the configured tracker. The artifact points at
 * the first issue and no further.
 */
export function issuesArtifact(clients: IssuesClients): Artifact {
  return {
    detect: (text) => detect(clients, text),
    binding: () => null,
    instructions: { ...clients.instructions, report: reviewInstructions(REVIEW_PLACE) },
    repositoryInstructions: () => clients.notes,
    mcp: (credential) => clients.mcp(credential),
    readyMessage: async (url) => `The issues are ready for you, starting at ${url}`,
    readyInstructions: () => "",
    review: {
      revision: async () => null,
      postedReview: async (_ref, input) => turnTextReview(input.turnText),
      reviewerCredential: null,
      replyInstructions: "Say so in the text of your turn.",
      postRejection: null,
    },
    change: async () => null,
    acknowledge: async () => {},
    describe: async (target) => `The issues are on the tracker, starting at ${target.url}.`,
  };
}

/** The review the turn text of the reviewer carries. Null when it carries none. */
function turnTextReview(turnText: string): Review | null {
  const parsed = parseTurnTextReview(turnText);
  return parsed ? { kind: "review", revision: null, ...parsed } : null;
}

async function detect(clients: IssuesClients, text: string): Promise<ArtifactTarget | null> {
  return firstClaimedLink(text, async (url) =>
    clients.ownsUrl(url) ? { url, ref: { kind: "issues" } } : null,
  );
}
