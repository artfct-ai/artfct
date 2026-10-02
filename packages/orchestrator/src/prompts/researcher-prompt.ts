import { RESEARCH_PAYLOAD_PATH } from "../workflow/task/sandbox/research-payload";
import { repositoryLines, requestLines, TODO_INSTRUCTIONS, type TaskContext } from "./task-prompt";

/**
 * The prompt of a researcher task: the research skill, the request, and where the research
 * payload goes. A researcher produces no artifact and commits nothing, so it gets no artifact
 * instructions and no branch.
 */
export function researcherTaskPrompt(options: {
  instructions: string;
  context: TaskContext;
}): string {
  const { instructions, context } = options;
  const lines = [instructions.trim(), ...requestLines(context)];
  if (context.repo) lines.push("", ...repositoryLines(context.repo, null));
  lines.push("", "## Progress", TODO_INSTRUCTIONS);
  lines.push("", "## Research payload", PAYLOAD_INSTRUCTIONS);
  return lines.join("\n");
}

const PAYLOAD_INSTRUCTIONS = [
  `Write the research payload to \`${RESEARCH_PAYLOAD_PATH}\` before you end your turn. The author of this job reads it, and nothing else you say reaches the author.`,
  "Do not commit, push, or open anything. Do not create or change the artifact of the job.",
].join("\n");
