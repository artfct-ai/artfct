import type { ArtifactAction, ArtifactInstructions } from "../artifact/types";

const HEADINGS: Record<ArtifactAction, string> = {
  create: "## Output",
  read: "## How to read the artifact",
  change: "## How to change the artifact",
  report: "## How to report",
};

/** The sections that tell a role how to take its actions on the artifact, in the order given. */
export function artifactActionSections(
  instructions: ArtifactInstructions,
  actions: readonly ArtifactAction[],
): string[] {
  return actions.flatMap((action) => ["", HEADINGS[action], instructions[action]]);
}
