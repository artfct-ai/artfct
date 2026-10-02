import type { ArtifactInstructions } from "../artifact/types";
import { artifactActionSections } from "./artifact-sections";
import { repositoryLines, type TaskContext } from "./task-prompt";

const ROLE =
  "You are changing an artifact someone else produced. Make the change the instructions below ask for and nothing else. You file no review. You leave no comment on the artifact.";

/** What the polisher holds to while it changes the artifact, and how it hands it back. */
const CLOSING = [
  "Leave the artifact working. Where the instructions would break it or change what it does, leave that part alone.",
  "Where the artifact is code, run the repository's lint after you finish your edits. Do not run any tests.",
  "Nothing reviews your work after you, so the artifact goes to the humans as you leave it.",
  "Close your turn with one line saying what you changed.",
].join(" ");

/** The first prompt of a polisher run. */
export function polishPrompt(options: {
  url: string;
  title: string;
  request: string;
  brief: string;
  instructions: string;
  repo: TaskContext["repo"];
  branch: string | null;
  artifact: ArtifactInstructions;
}): string {
  const { url, title, request, brief, instructions, repo, branch, artifact } = options;
  const lines = [
    ROLE,
    "",
    "## What to change",
    instructions,
    "",
    "## The artifact",
    url,
    "",
    "## What the artifact is supposed to do",
    `Title: ${title}`,
  ];
  if (request.trim()) lines.push("", request.trim());
  if (brief.trim()) {
    lines.push("", "Acceptance criteria and context given to the author:", brief.trim());
  }
  if (repo) lines.push("", ...repositoryLines(repo, branch));
  lines.push(...artifactActionSections(artifact, ["read", "change"]), "", CLOSING);
  return lines.join("\n");
}
