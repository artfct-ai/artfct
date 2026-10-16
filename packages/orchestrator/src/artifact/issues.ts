import type { HostInstructions } from "@artfct-ai/adapters/instructions";
import type { McpServer } from "@artfct-ai/adapters/mcp";
import { lastClaimedLink } from "./detect";
import type { Artifact, ArtifactTarget, Review, TrackerRef } from "./types";
import { parseTurnTextReview, reviewInstructions } from "./review-text";

/** What the issues kind needs from the configured tracker provider. */
export type IssuesClients = {
  /** The issue or project the link names on this tracker. Null for any other link. */
  readUrl: (url: string) => Promise<TrackerRef | null>;
  mcp: (credential: string | null) => McpServer | null;
  instructions: HostInstructions;
  /** What the author may do with other repositories in its checkout. */
  notes: string;
};

/** Where the reviewer of the issues writes its review. */
const REVIEW_PLACE = "End the text of your turn with this block:";

/**
 * The artifact kind that is the issues of a breakdown on the configured tracker: one issue, or
 * one tracker project that holds them.
 */
export function issuesArtifact(clients: IssuesClients): Artifact {
  return {
    detect: (text) => detect(clients, text),
    endsTurn: true,
    binding: () => null,
    instructions: { ...clients.instructions, report: reviewInstructions(REVIEW_PLACE) },
    repositoryInstructions: () => clients.notes,
    mcp: (credential) => clients.mcp(credential),
    readyMessage: async (url) => `The issues are ready for you at ${url}`,
    readyInstructions: () => "",
    review: {
      revision: async () => null,
      postedReview: async (_ref, input) => turnTextReview(input.turnText),
      reviewerPosts: false,
      reviewerCredential: null,
      replyInstructions: "Say so in the text of your turn.",
      postRejection: null,
    },
    change: async () => null,
    acknowledge: async () => [],
    describe: async (target) => `The issues are on the tracker at ${target.url}.`,
  };
}

/** The review the turn text of the reviewer carries. Null when it carries none. */
function turnTextReview(turnText: string): Review | null {
  const parsed = parseTurnTextReview(turnText);
  return parsed ? { kind: "review", revision: null, ...parsed } : null;
}

async function detect(clients: IssuesClients, text: string): Promise<ArtifactTarget | null> {
  return lastClaimedLink(text, async (url) => {
    const ref = await clients.readUrl(url);
    return ref ? { url, ref } : null;
  });
}
