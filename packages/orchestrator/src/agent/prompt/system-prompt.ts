import type { ArtifactKind } from "@artfct-ai/contracts/types";
import { registeredConfig } from "../../config/register-config";
import type { Config } from "../../config/config";
import type { Stage } from "../../config/stage";
import type { WorkflowDefinition } from "../../config/workflow-definition";
import type { ToolSet } from "ai";
import { taskQuiet, heldForReview, refinerInFlight } from "../../workflow/refiner/loop";
import { runningPolisherOf } from "../../workflow/refiner/stage-refiner";
import { taskAtWork } from "../../workflow/task/at-work";
import type { ArtifactRow, PromptCounts, TaskRow } from "../../workflow/store/tasks";
import { jobSlotsOf } from "../../workflow/store/state";
import type { WorkflowRuntime } from "../../workflow/types";
import { stageAfterInput } from "../message/input-artifact";
import { RUNTIME_RULES, runtimeLines } from "./runtime";
import { stageLines } from "./stage-lines";
import { REVIEW_RULES } from "../tools/artifact";
import { CHANNEL_RULES, NOBODY_WROTE_RULES, PERSON_WROTE_RULES } from "../tools/channel";
import { hasPageArtifact, HELD_COMMENT_RULES } from "../tools/held-comments";
import { hasRootPage, MOVE_INTO_ROOT_PAGE, ROOT_PAGE_RULES } from "../tools/root-page";
import { TRACKER_RULES } from "../tools/tracker";
import { END_RULES, FAIL_WORKFLOW, FINISH_WORKFLOW, PLAN_RULES } from "../tools/plan";
import { CONTEXT_RULES } from "../tools/read";
import { TASK_RULES } from "../tools/start/start";
import { HARNESS_RULES } from "../tools/task";
import type { WorkflowToolName } from "../tools/toolset";
import { WEB_RULES } from "../tools/web";

const ROLE = `You are the orchestrator of a software engineering workflow. You talk with the team in the tracker, the chat, and the documents. You plan the work, hand each stage to a coding harness that runs in a sandbox, watch the artifacts it produces, and report back. You never write code or documents yourself. The harness does the heavy lifting. You orchestrate. People also ask you questions and ask for help. Answer those yourself. An answer does not start a plan or a job.`;

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
 * unprompted turn requests work. `heldComments` counts the comments held on the page of each
 * running author by job id, read from the host as the turn starts. Null when the host could not
 * be read.
 */
export type TurnFacts = {
  personWrote: boolean;
  requestsWork: boolean;
  inputArtifact: ArtifactKind | null;
  heldComments: ReadonlyMap<string, number | null>;
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
  return workflow.store.stagePlan() === null || !needsHarness(workflow);
}

/** True on a turn that may start work: the message requests it, and the plan is unset or no job runs. */
function mayStartWork(workflow: WorkflowRuntime, turn: TurnFacts): boolean {
  return turn.requestsWork && needsContext(workflow);
}

/** The rule blocks, one per concern, each exported by the tool module it governs, in workflow order. */
const BLOCKS: RuleBlock[] = [
  { rules: PLAN_RULES, tools: [], needed: (_workflow, turn) => turn.requestsWork },
  {
    rules: END_RULES,
    tools: [FINISH_WORKFLOW, FAIL_WORKFLOW],
    needed: (workflow) => workflow.store.plan() !== null,
  },
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
  { rules: HELD_COMMENT_RULES, tools: [], needed: hasPageArtifact },
  { rules: ROOT_PAGE_RULES, tools: [MOVE_INTO_ROOT_PAGE], needed: hasRootPage },
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

/** The start stage in each workflow definition, before the workflow starts, for a message with an input artifact. */
function definitionStartLines(
  definitions: readonly WorkflowDefinition[],
  inputArtifact: ArtifactKind | null,
): string[] {
  if (!inputArtifact) return [];
  const starts = definitions.flatMap((definition) => {
    const start = stageAfterInput(definition.stages, inputArtifact);
    return start ? [`- ${definition.name}: stage ${start}`] : [];
  });
  if (starts.length === 0) return [];
  return [
    "## Where the plan starts",
    `The message links or names an existing ${inputArtifact} artifact. Start the plan at this stage of the workflow definition you pick, unless the message names an earlier stage.`,
    ...starts,
    "",
  ];
}

/** The workflow definitions a plan may name, by name and description, without their stages. */
function definitionLines(definitions: readonly WorkflowDefinition[]): string[] {
  return [
    "## Workflow definitions",
    ...definitions.map((definition) => `- ${definition.name}: ${definition.description}`),
    "",
  ];
}

/**
 * What the prompt says about the work before the stage rules. A started workflow shows its
 * workflow definition and stages. Before the start, a turn that requests work lists the
 * workflow definitions.
 */
function workLines(workflow: WorkflowRuntime, config: Config, turn: TurnFacts): string[] {
  const mayStart = mayStartWork(workflow, turn);
  const runtime = mayStart ? [...runtimeLines(config), ""] : [];
  if (workflow.store.plan() === null) {
    if (!turn.requestsWork) return [];
    const definitions = workflow.workflowDefinitions();
    return [
      ...definitionLines(definitions),
      ...runtime,
      ...(mayStart ? definitionStartLines(definitions, turn.inputArtifact) : []),
    ];
  }
  const definition = workflow.workflowDefinition();
  return [
    `## Workflow definition ${definition.name}`,
    definition.description,
    "",
    ...stageLines(config, definition),
    "",
    ...runtime,
    ...(mayStart ? startLines(definition.stages, turn.inputArtifact) : []),
  ];
}

/** The system prompt: role, the work, the rule blocks this turn needs, and the live state. */
export function systemPrompt(workflow: WorkflowRuntime, turn: TurnFacts): string {
  const rules = BLOCKS.filter((block) => block.needed(workflow, turn)).map((block) => block.rules);
  return [
    ROLE,
    "",
    ...workLines(workflow, workflow.config(), turn),
    ...rules.flatMap((block) => [block, ""]),
    registeredConfig().writingRules,
    "",
    ...stateLines(workflow, turn),
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

function stateLines(workflow: WorkflowRuntime, turn: TurnFacts): string[] {
  const { store } = workflow;
  const created = store.requireWorkflowRow();
  const plan = store.plan();
  const stagePlan = store.stagePlan();
  const active = store.activeAuthorAndResearcherTasks();
  return [
    "## Current state",
    "Read from the store and the hosts for this request. Say whether a task runs, and where page comments are, only from these lines, never from earlier messages. `activity=running` means a turn of the task runs now. `activity=idle` means it runs nothing and nothing is queued for it. `queued_prompts` counts the prompts that wait for the task's next turn. `taken_instructions` counts the person instructions its running turn took, so its author has read them. `steered_instructions` counts the ones sent into its running turn that its harness has not answered yet. A count of zero is left out. `held_comments` counts the comments on the page that its author has not received.",
    `Workflow: ${created.workflow_id} status=${created.status}`,
    plan
      ? `Workflow definition: ${plan.definition}`
      : "Workflow definition: not set. The workflow starts when set_plan names one.",
    `Name: ${store.workflowName()}`,
    `Plan: ${stagePlan ? stagePlan.stages.join(" -> ") : "not set"}`,
    `Repository: ${plan?.repo ?? "none"}`,
    `Page parent: ${stagePlan?.page_parent ?? "none"}`,
    `Root page: ${stagePlan?.root_page?.url ?? "none"}`,
    `Active jobs: ${active.length} of ${jobSlotsOf(stagePlan)} slots`,
    ...active.map((task) => jobLine(workflow, task, turn.heldComments)),
    `Cost so far: $${store.workflowCost().toFixed(2)}`,
    `Reply channels: ${
      store
        .replyTargets()
        .map((target) => target.source)
        .join(", ") || "none"
    }`,
  ];
}

function reviewLine(workflow: WorkflowRuntime, author: TaskRow, artifact: ArtifactRow): string {
  if (runningPolisherOf(workflow, author.job_id)) return " review=polishing";
  if (refinerInFlight(workflow, author.job_id)) return " review=running";
  if (!heldForReview(workflow, artifact)) return "";
  return taskQuiet(workflow, author) ? " review=yours to route" : " review=with the author";
}

/** Whether a task runs a turn right now, as the store holds it. */
type TaskActivity = "starting" | "running" | "prompt_queued" | "paused" | "idle";

function taskActivity(
  workflow: WorkflowRuntime,
  task: TaskRow,
  prompts: PromptCounts,
): TaskActivity {
  if (task.paused_at !== null) return "paused";
  if (task.status === "queued" || task.status === "provisioning") return "starting";
  if (taskAtWork(workflow, task)) return "running";
  return prompts.waiting > 0 ? "prompt_queued" : "idle";
}

function promptsPart(prompts: PromptCounts): string {
  const counts: [string, number][] = [
    ["queued_prompts", prompts.waiting],
    ["taken_instructions", prompts.taken],
    ["steered_instructions", prompts.steered],
  ];
  return counts
    .filter(([, count]) => count > 0)
    .map(([field, count]) => ` ${field}=${count}`)
    .join("");
}

function heldCommentsPart(heldComments: ReadonlyMap<string, number | null>, jobId: string) {
  if (!heldComments.has(jobId)) return "";
  return ` held_comments=${heldComments.get(jobId) ?? "unreadable"}`;
}

function jobLine(
  workflow: WorkflowRuntime,
  task: TaskRow,
  heldComments: ReadonlyMap<string, number | null>,
): string {
  const job = workflow.store.requireJob(task.job_id);
  const artifact = workflow.store.artifact(job.job_id);
  const item = job.issue_key ? ` issue=${job.issue_key}` : "";
  const target = artifact
    ? ` artifact=${artifact.kind} ${artifact.external_url} status=${artifact.status}${reviewLine(workflow, task, artifact)}${heldCommentsPart(heldComments, job.job_id)}`
    : " artifact=none";
  const sandbox = workflow.store.sandbox(task.task_id);
  const runsOn = sandbox ? `harness=${sandbox.harness}` : "execution=model";
  const prompts = workflow.store.promptCounts(task.task_id);
  return `- job ${job.job_id} stage=${job.stage}${item} ${task.role}=${task.task_id} status=${task.status} activity=${taskActivity(workflow, task, prompts)}${promptsPart(prompts)} ${runsOn} model=${task.model}${target}`;
}
