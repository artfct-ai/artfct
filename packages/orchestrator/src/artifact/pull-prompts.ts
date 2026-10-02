import type { CheckFailure } from "@artfct-ai/adapters/code/types";
import type { PullRef } from "./types";

/** The prompt a task gets when the checks failed on the commit it pushed to a pull request. */
export function checksFailurePrompt(options: {
  pull: PullRef;
  failures: CheckFailure[];
  inspectNote: string;
}): string {
  const { pull, failures, inspectNote } = options;
  return [
    `The checks failed on pull request #${pull.number} (${pull.repo}).`,
    ...failures.map(failureText),
    inspectNote,
    "Fix the failure, commit, and push. Then end your turn. The system reads the checks of the new commit.",
  ].join("\n");
}

function failureText(failure: CheckFailure): string {
  const heading = [`- ${failure.name}: ${failure.conclusion}`, failure.url]
    .filter(Boolean)
    .join(" ");
  return failure.detail ? `${heading}\n${failure.detail}` : heading;
}

/** The prompt a task gets when the commit it pushed to a pull request conflicts with the base branch. */
export function conflictPrompt(pull: PullRef, base: string): string {
  return [
    `Pull request #${pull.number} (${pull.repo}) conflicts with its base branch ${base}.`,
    `Fetch ${base} and merge it into your branch. Do not rebase and do not force push.`,
    "Resolve the conflicts, run the local checks, commit the merge, and push. Then end your turn. The system reads the checks of the new commit.",
  ].join("\n");
}
