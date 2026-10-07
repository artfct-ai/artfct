import { OPTIONS_HEADING } from "../artifact/options";
import type { ArtifactInstructions } from "../artifact/types";
import type { Stage } from "../config/stage";
import { artifactActionSections } from "./artifact-sections";

/** What the harness needs to know about the request and the repository. */
export type TaskContext = {
  /** What the orchestrator agent wrote for this task. Empty when it wrote nothing. */
  brief: string;
  title: string;
  text: string;
  links: string[];
  repo: { full: string; notes: string } | null;
  branch: string | null;
  previous_artifacts: Array<{ stage: string; kind: string; url: string }>;
  /** The artifact the job works from when its input is one that no job of this workflow produced. */
  input_artifact: { kind: string; url: string; continued: boolean } | null;
  /** What the job's researcher found. Null when the job ran no researcher. */
  research_payload: string | null;
  /** What the researcher of the job that produced the input artifact found. Null without one. */
  preceding_research_payload: string | null;
  /** The option a person chose on the job that produced the input artifact. Null without one. */
  preceding_selection: string | null;
  /** How the job's stage completes. */
  ending: Stage["ending"];
  /** Where the page of the job goes. Null when its stage produces no page or nothing names a place. */
  page_parent: string | null;
};

/** The first prompt of a task: the skill to run, the request, and how the artifact is worked with. */
export function taskPrompt(options: {
  instructions: string;
  context: TaskContext;
  artifact: ArtifactInstructions;
}): string {
  const { instructions, context, artifact } = options;
  const lines = [
    instructions.trim(),
    ...requestLines(context),
    ...researchPayloadLines(context),
    ...optionsLines(context),
  ];
  if (context.repo) lines.push("", ...repositoryLines(context.repo, context.branch));
  if (context.page_parent) lines.push("", "## Page parent", context.page_parent);
  lines.push("", "## Progress", TODO_INSTRUCTIONS);
  lines.push(...artifactActionSections(artifact, AUTHOR_ACTIONS));
  return lines.join("\n");
}

const RESEARCH_PAYLOAD_INTRO =
  "A researcher read the code for this job before you started. This is what it found, with file and line references:";

/** The section that holds what the job's own researcher found. Empty when it ran no researcher. */
export function researchPayloadLines(context: TaskContext): string[] {
  if (context.research_payload === null) return [];
  return ["", "## Research payload", RESEARCH_PAYLOAD_INTRO, context.research_payload];
}

/** The section that tells the author of a stage with a choice ending how to list its options. */
export function optionsLines(context: TaskContext): string[] {
  if (context.ending !== "choice") return [];
  return ["", "## Options", OPTIONS_INSTRUCTIONS];
}

const OPTIONS_INSTRUCTIONS = [
  "This stage ends on a choice. A person selects one of the options your document proposes.",
  `Give the document a section headed \`## ${OPTIONS_HEADING}\`. List each option there as a numbered item, \`1. <short option name>\`, with the name alone on the item line. Describe the option in indented lines below it. Put no other numbered list under that heading.`,
].join("\n");

/** Compile the prompt lines that make up the 'request' sections*/
export function requestLines(context: TaskContext): string[] {
  const lines: string[] = [];
  if (context.brief.trim()) lines.push("", "## Brief from the orchestrator", context.brief.trim());
  lines.push("", "## Request", `Title: ${context.title}`, "", context.text.trim());
  if (context.links.length) {
    lines.push("", "## Links", ...context.links.map((link) => `- ${link}`));
  }
  if (context.previous_artifacts.length) {
    lines.push("", "## Artifacts from earlier stages");
    for (const previous of context.previous_artifacts) {
      lines.push(`- ${previous.stage} (${previous.kind}): ${previous.url}`);
    }
  }
  if (context.input_artifact !== null) {
    const { kind, url, continued } = context.input_artifact;
    if (continued) lines.push("", "## Artifact to continue", CONTINUED_ARTIFACT_INTRO);
    else lines.push("", "## Input artifact", INPUT_ARTIFACT_INTRO);
    lines.push(`- ${kind}: ${url}`);
  }
  if (context.preceding_research_payload !== null) {
    lines.push(
      "",
      "## Research behind the input artifact",
      PRECEDING_RESEARCH_PAYLOAD_INTRO,
      context.preceding_research_payload,
    );
  }
  if (context.preceding_selection !== null) {
    lines.push(
      "",
      "## Selection behind the input artifact",
      PRECEDING_SELECTION_INTRO,
      context.preceding_selection,
    );
  }
  return lines;
}

const INPUT_ARTIFACT_INTRO =
  "Your job works from this artifact. The person who asked gave it in place of the artifact of an earlier stage. Read it before you start:";

const CONTINUED_ARTIFACT_INTRO =
  "Your job continues this artifact. It is open on the host, and your branch is its branch with the earlier work on it. Read the artifact, its reviews, and its comments before you start. Change it in place. Do not open another one:";

const PRECEDING_RESEARCH_PAYLOAD_INTRO =
  "A researcher read the code for the job that produced your input artifact. This is what it found, with file and line references:";

const PRECEDING_SELECTION_INTRO =
  "The stage that produced your input artifact ended on a choice. A person chose this option from it. Work from this option and set the others aside:";

const AUTHOR_ACTIONS = ["create", "read", "change"] as const;

/** Prompt for a task that resumes in a fresh sandbox after sleep or restart. */
export function resumePrompt(options: {
  instructions: string;
  context: TaskContext;
  artifact: ArtifactInstructions;
  artifactUrl: string | null;
  lastTurnTail: string | null;
  wake: string;
}): string {
  const { instructions, context, artifact, artifactUrl, lastTurnTail, wake } = options;
  return [
    "You are resuming a task in a fresh workspace. Previous local state is gone.",
    artifactUrl
      ? `The artifact under review: ${artifactUrl}`
      : "No artifact has been recorded yet.",
    lastTurnTail ? `The end of your last turn text:\n${lastTurnTail}` : "",
    "",
    "## What woke you",
    wake,
    "",
    taskPrompt({ instructions, context, artifact }),
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** The section that tells a harness which repository its checkout is and which branch it commits to. */
export function repositoryLines(
  repo: NonNullable<TaskContext["repo"]>,
  branch: string | null,
): string[] {
  const lines = ["## Repository", `Repo: ${repo.full}, cloned at the current directory.`];
  if (branch) {
    lines.push(
      `You are on branch \`${branch}\`. Commit to this branch only. Never push to the default branch.`,
    );
  }
  lines.push(repo.notes);
  return lines;
}

/** What the harness is told about the todo list, which is the only progress the requester sees. */
export const TODO_INSTRUCTIONS = [
  "Keep a todo list for this task and keep it current. Your first action is to write the list, before you read a file, run a command, or fetch a page, even when the task looks short. Start with the steps you know, such as `Read the code the change touches`, and rewrite the list when you learn more. Mark a step in progress when you begin it. Mark it completed when it is done.",
  "The people who asked for this work read this list and see nothing else while you work. Write each item as one short imperative phrase for them, such as `Add the migration`, and never put a link or a secret in one.",
].join("\n");
