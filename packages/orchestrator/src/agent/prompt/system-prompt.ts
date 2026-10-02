import type { ArtifactKind } from "@artfct-ai/contracts/types";
import { registeredConfig } from "../../config/register-config";
import { resolveStage, type ResolvedStage, type Stage } from "../../config/stage";
import type { ToolSet } from "ai";
import { taskQuiet, heldForReview, refinerInFlight } from "../../workflow/refiner/loop";
import { runningPolisherOf } from "../../workflow/refiner/stage-refiner";
import type { ArtifactRow, TaskRow } from "../../workflow/store/tasks";
import { workflowName } from "../../workflow/store/state";
import type { WorkflowRuntime } from "../../workflow/types";
import { stageAfterInput } from "../message/input-artifact";
import { RUNTIME_RULES, runtimeLines } from "./runtime";
import { REVIEW_RULES } from "../tools/artifact";
import { CHANNEL_RULES, NOBODY_WROTE_RULES, PERSON_WROTE_RULES } from "../tools/channel";
import { hasPageArtifact, HELD_COMMENT_RULES, SEND_HELD_COMMENTS } from "../tools/held-comments";
import { TRACKER_RULES } from "../tools/tracker";
import { PLAN_RULES } from "../tools/plan";
import { CONTEXT_RULES } from "../tools/read";
import { TASK_RULES } from "../tools/start/start";
import { HARNESS_RULES } from "../tools/task";
import type { WorkflowToolName } from "../tools/toolset";
import { WEB_RULES } from "../tools/web";

const ROLE = `You are the orchestrator of a software engineering workflow. You talk with the team in the tracker, the chat, and the docs. You plan the work, hand each stage to a coding harness that runs in a sandbox, watch the artifacts it produces, and report back. You never write code or documents yourself. The harness does the heavy lifting. You orchestrate. People also ask you questions and ask for help. Answer those yourself. An answer does not start a plan or a job.`;

/**
 * One rule block, the turns that carry it, and the tools that leave the request with it. A tool
 * stays when a carried block still names it.
 */
type RuleBlock = {
  rules: string;
  tools: WorkflowToolName[];
  needed: (workflow: WorkflowRuntime, turn: TurnFacts) => boolean;
};

/**
 * What a rule block reads about the turn itself: whether a person wrote since the last turn,
 * whether their message requests work, and the kind of input artifact it links or names. An
 * unprompted turn requests work.
 */
export type TurnFacts = {
  personWrote: boolean;
  requestsWork: boolean;
  inputArtifact: ArtifactKind | null;
};

const always = (): boolean => true;

/** True while an author or researcher task runs, so there is a harness to talk to. */
export function needsHarness(workflow: WorkflowRuntime): boolean {
  return workflow.store.activeAuthorAndResearcherTasks().length > 0;
}

/** True while a review holds an artifact back or a refiner runs on one, finished jobs included. */
export function needsReview(workflow: WorkflowRuntime): boolean {
  return workflow.store.jobs().some((job) => {
    const artifact = workflow.store.artifact(job.job_id);
    if (artifact && heldForReview(workflow, artifact)) return true;
    return refinerInFlight(workflow, job.job_id);
  });
}

/** True while the plan is unset or no job runs: the turns that find context and start work. */
export function needsContext(workflow: WorkflowRuntime): boolean {
  return workflow.state.stages.length === 0 || !needsHarness(workflow);
}

/** True on a turn that may start work: the message requests it, and the plan is unset or no job runs. */
function mayStartWork(workflow: WorkflowRuntime, turn: TurnFacts): boolean {
  return turn.requestsWork && needsContext(workflow);
}

/** The rule blocks, one per concern, each exported by the tool module it governs, in workflow order. */
const BLOCKS: RuleBlock[] = [
  { rules: PLAN_RULES, tools: [], needed: (_workflow, turn) => turn.requestsWork },
  { rules: TASK_RULES, tools: [], needed: always },
  { rules: RUNTIME_RULES, tools: [], needed: mayStartWork },
  {
    rules: HARNESS_RULES,
    tools: ["prompt_task", "pause_task", "resume_task", "cancel_task"],
    needed: needsHarness,
  },
  {
    rules: REVIEW_RULES,
    tools: ["request_review", "finish_review", "read_artifact"],
    needed: needsReview,
  },
  { rules: HELD_COMMENT_RULES, tools: [SEND_HELD_COMMENTS], needed: hasPageArtifact },
  { rules: TRACKER_RULES, tools: [], needed: always },
  { rules: WEB_RULES, tools: [], needed: always },
  { rules: CHANNEL_RULES, tools: [], needed: always },
  {
    rules: PERSON_WROTE_RULES,
    tools: ["acknowledge"],
    needed: (_workflow, turn) => turn.personWrote,
  },
  {
    rules: NOBODY_WROTE_RULES,
    tools: ["stay_silent", "tell"],
    needed: (_workflow, turn) => !turn.personWrote,
  },
  { rules: CONTEXT_RULES, tools: [], needed: mayStartWork },
];

/** The prompt lines that name the start stage for a message with an input artifact. */
function startLines(stages: readonly Stage[], inputArtifact: ArtifactKind | null): string[] {
  if (!inputArtifact) return [];
  const start = stageAfterInput(stages, inputArtifact);
  if (!start) return [];
  return [
    "## Where the plan starts",
    `The message links or names an existing ${inputArtifact} artifact. Start the plan at stage ${start} unless the message names an earlier stage.`,
    "",
  ];
}

/** Where the author of a stage runs, and on which model it produces and revises. */
function authorLine({ produce, revise }: ResolvedStage["author"]): string {
  if (produce.execution === "harness") return `Harness ${produce.harness}, model ${produce.model}.`;
  const revises = revise.model === produce.model ? "" : ` It revises on model ${revise.model}.`;
  return `The author runs as model calls on model ${produce.model}.${revises}`;
}

/** The system prompt: role, stages, the rule blocks this turn needs, and the live state. */
export function systemPrompt(workflow: WorkflowRuntime, turn: TurnFacts): string {
  const config = workflow.config();
  const definition = workflow.workflowDefinition();
  const stages = definition.stages.map((stage) => {
    const resolved = resolveStage(config, stage);
    const needsRepo = stage.branch ? ", needs a repository" : "";
    const when = stage.when ? ` Only when ${stage.when}.` : "";
    const research = resolved.research
      ? ` A researcher runs first on harness ${resolved.research.harness}, model ${resolved.research.model}.`
      : "";
    const choice =
      stage.ending === "choice"
        ? " Ends on a choice: its job completes only when a person's message selects one option listed on its page. Pass that option to complete_job."
        : "";
    return `- ${stage.name}: produces ${stage.artifact}${needsRepo}. ${authorLine(resolved.author)}${research}${choice}${when}`;
  });
  const rules = BLOCKS.filter((block) => block.needed(workflow, turn)).map((block) => block.rules);
  return [
    ROLE,
    "",
    `## Workflow definition ${definition.name}`,
    definition.description,
    "",
    "## Stages (in order)",
    ...stages,
    "",
    ...(mayStartWork(workflow, turn) ? [...runtimeLines(config), ""] : []),
    ...(mayStartWork(workflow, turn) ? startLines(definition.stages, turn.inputArtifact) : []),
    ...rules.flatMap((block) => [block, ""]),
    registeredConfig().writingRules,
    "",
    ...stateLines(workflow),
  ].join("\n");
}

/** True when a rule text names the tool in backticks, bare or as a call. */
function namesTool(rules: string, tool: string): boolean {
  return rules.includes(`\`${tool}\``) || rules.includes(`\`${tool}(`);
}

/**
 * The tools the model may call this turn. A tool is withheld when its rule block is left out and
 * no carried block names it, so the rules never name a tool the model cannot call.
 */
export function activeToolNames(
  workflow: WorkflowRuntime,
  tools: ToolSet,
  turn: TurnFacts,
): string[] {
  const carried = BLOCKS.filter((block) => block.needed(workflow, turn))
    .map((block) => block.rules)
    .join("\n");
  const withheld = new Set<string>(
    BLOCKS.filter((block) => !block.needed(workflow, turn))
      .flatMap((block) => block.tools)
      .filter((tool) => !namesTool(carried, tool)),
  );
  return Object.keys(tools).filter((name) => !withheld.has(name));
}

function stateLines(workflow: WorkflowRuntime): string[] {
  const { state } = workflow;
  const active = workflow.store.activeAuthorAndResearcherTasks();
  return [
    "## Current state",
    `Workflow: ${state.workflow_id} status=${state.status}`,
    `Name: ${workflowName(state)}`,
    `Plan: ${state.stages.length ? state.stages.join(" -> ") : "not set"}`,
    `Repository: ${state.repo?.full ?? "none"}`,
    `Page parent: ${state.page_parent ?? "none"}`,
    `Active jobs: ${active.length} of ${state.concurrency} slots`,
    ...active.map((task) => jobLine(workflow, task)),
    `Cost so far: $${workflow.store.workflowCost().toFixed(2)}`,
    `Reply channels: ${state.reply_targets.map((target) => target.source).join(", ") || "none"}`,
  ];
}

function reviewLine(workflow: WorkflowRuntime, author: TaskRow, artifact: ArtifactRow): string {
  if (runningPolisherOf(workflow, author.job_id)) return " review=polishing";
  if (refinerInFlight(workflow, author.job_id)) return " review=running";
  if (!heldForReview(workflow, artifact)) return "";
  return taskQuiet(workflow, author) ? " review=yours to route" : " review=with the author";
}

function jobLine(workflow: WorkflowRuntime, task: TaskRow): string {
  const job = workflow.store.requireJob(task.job_id);
  const artifact = workflow.store.artifact(job.job_id);
  const item = job.issue_key ? ` issue=${job.issue_key}` : "";
  const target = artifact
    ? ` artifact=${artifact.kind} ${artifact.external_url} status=${artifact.status}${reviewLine(workflow, task, artifact)}`
    : " artifact=none";
  const sandbox = workflow.store.sandbox(task.task_id);
  const runsOn = sandbox ? `harness=${sandbox.harness}` : "execution=model";
  return `- job ${job.job_id} stage=${job.stage}${item} ${task.role}=${task.task_id} status=${task.status} ${runsOn} model=${task.model}${target}`;
}
