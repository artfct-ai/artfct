import { extractLinks } from "@artfct-ai/adapters/links";
import type { ArtifactTarget } from "./types";

/**
 * The first link in author output that `claim` recognises as the kind's own. Null when no link
 * is one.
 */
export async function firstClaimedLink(
  text: string,
  claim: (url: string) => Promise<ArtifactTarget | null>,
): Promise<ArtifactTarget | null> {
  for (const url of extractLinks(text)) {
    const claimed = await claim(url);
    if (claimed) return claimed;
  }
  return null;
}
